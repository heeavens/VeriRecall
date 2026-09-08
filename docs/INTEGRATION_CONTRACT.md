# Интеграционный контракт VeriRecall, v1

Обновлено после этапа 5, 2026-09-08. Герман реализует свой блок последовательно, друг подключится позже. Контракт v1 имеет реальный persisted demo-сервис для reservation, ACCEPT_INVESTIGATION, CALCULATE_EXPOSURE, DECIDE_ACTION, REQUEST_ACTION, ATTACH_RESULT и чтения snapshot; closure/reopen ещё не реализованы. Рабочий запуск, HTTP/server примеры и ограничения: `docs/HANDOFF_TO_FRIEND.md`.

## Один источник типов

Обе стороны импортируют **один** browser-safe модуль `src/lib/contracts/recall.ts`. В нём Zod runtime-схемы и выведенные через `z.infer` типы; отдельные копии интерфейсов не нужны. Модуль не импортирует БД, секреты или серверный код.

```ts
import {
  investigationOutcomeSchema,
  caseSnapshotSchema,
  recallCommandSchema,
  type InvestigationOutcome,
  type CaseSnapshot,
  type RecallService
} from '$lib/contracts/recall';

// Producer validates its output; the receiving server validates again.
const outcome: InvestigationOutcome = investigationOutcomeSchema.parse(payload);
const snapshot: CaseSnapshot = caseSnapshotSchema.parse(serverPayload);
```

Здесь payload/serverPayload обозначают реальные данные интеграции. Сервис `RecallService` содержит `execute(command)` и `getSnapshot(query)` с Promise-результатами. Реализация этапа 3 — `createRecallService` в `src/lib/server/workflow/case-lifecycle.ts`; входные unknown повторно валидируются. Fixtures сервером не возвращаются как fallback. Сервис в дальнейшем создаётся в доверенном серверном контексте с авторизованным оператором; actor не берётся из клиентского payload. UI может импортировать типы, но вызывает серверные actions, а не БД.

Старые `src/lib/types/domain.ts`, `src/lib/server/db/schema.ts` и `CaseDetailView` в `src/lib/server/cases/queries.ts` сохраняются. Автоматического преобразования старых данных в подтверждённый snapshot нет: `stockQuantity=0`, `Unknown`, `simulated_sent` и старый `closed` не доказывают новый контракт.

## InvestigationOutcome

| Поле | Значение |
| --- | --- |
| schemaVersion | Только literal `1`; версия формата |
| caseId / productId | UUID существующего приложения; P-17 — название синтетического товара, а не формат первичного ключа |
| materialRevision | Положительное целое, версия результата расследования данного case |
| updatedAt | ISO UTC timestamp источника результата, не доверенное время записи сервера |
| knowledgeStatus | Сводное состояние знания; KNOWN нельзя ставить при неизвестных identity/scope, gaps или conflicts |
| identity | conclusion MATCH/NO_MATCH/UNRESOLVED, собственный knowledgeStatus, evidenceRefs, decisionRefs |
| scope | BATCH_LOT с непустым уникальным lots либо UNRESOLVED с reason; собственные knowledgeStatus/evidenceRefs/decisionRefs |
| evidenceRefs / decisionRefs | Общий перечень ссылок результата; ссылки identity/scope должны входить в него |
| gaps / conflicts | Массивы Issue: id, code, message, critical, subjectRefs, evidenceRefs |
| demo | Явная маркировка синтетического/учебного результата |

KnowledgeStatus: `KNOWN`, `UNKNOWN`, `PENDING`, `CONFLICTED`, `UNRESOLVED`. `KNOWN` — качество факта, а не человеческое разрешение действовать. `decisionRefs` могут быть пустыми даже при известном факте: сервер отдельно требует действующее APPROVED решение нужного типа и охвата. Наличие строки-ссылки не доказывает существование или подлинность решения. Неизвестная identity может сосуществовать с известной партией и наоборот. BATCH_LOT с неизвестным knowledgeStatus — кандидатный охват, не подтверждённая граница.

UNRESOLVED не имеет lots и не может быть KNOWN. WHOLE_PRODUCT, DATE_RANGE и любые другие виды в v1 **не поддерживаются**: вернуть UNSUPPORTED_SCOPE, не подменять ими неизвестный scope. WHOLE_PRODUCT можно добавить только новой согласованной версией с обоснованием или отдельным предосторожным human decision. Решение человека не удаляет gaps/conflicts и не меняет factual knowledgeStatus само по себе.

Все объекты strict: неизвестные поля, пустые/дублированные ссылки и некорректные UUID/даты отклоняются. Ссылки — непрозрачные непустые строки; для fixtures используется `demo:`. На сервере необходимо проверить их существование, принадлежность case/product, тип, охват, актуальность, demo-mode и отсутствие отозванного решения. Zod не выполняет запросы к хранилищу.

## CaseSnapshot

| Поле | Содержание |
| --- | --- |
| schemaVersion, caseId, productId | Версия формата и идентичность агрегата |
| caseVersion | Положительная версия всего дела |
| materialRevision, investigation | Последний результат расследования и его версия; оба null до первого результата |
| stage | INVESTIGATING / RESPONDING / CONTAINED / CLOSURE_REVIEW / CLOSED |
| updatedAt | Серверное время последнего изменения |
| exposure | status, basisMaterialRevision, calculatedAt; received/warehouse/inTransit/retailer/sold/unaccounted/contained; gaps/conflicts |
| tasks | Идентификатор, type, rule, status/statusReason, targetRef, coverage, quantity, basisMaterialRevision, reasonRefs/sourceRefs, blocking/blockedBy, priority и причина, approvalRequired/approvalStatus, decisionRefs, resultEvidenceRefs, requestStatus, проверяемый draft, demo |
| uncertainties / conflicts | Текущие проблемы дела, включая investigation и exposure; не только задачи |
| attentionItems | Ссылки на проблемы, которые UI должен показать оператору, с кодами и объяснениями |
| pendingDecisions | Только PENDING решения с subjectRef, coverage, basisCaseVersion/basisMaterialRevision, evidenceRefs, rationale и demo |
| closure | NOT_READY + непустые blockers; READY_FOR_HUMAN_CLOSURE + пустые blockers; CLOSED + ссылка на отдельное human decision |
| demo | Маркировка учебного дела |

В v1 один case-контракт относится к одному productId. Уже существующая БД допускает несколько case_items/products на alert: многопродуктовую проекцию необходимо отдельно сверить с другом, не терять items при адаптации и не выбирать молча первый продукт. Новый stage хранится в case_lifecycle.snapshot_json; старый `cases.status=open` сохраняется как совместимая проекция INVESTIGATING. `open` сам по себе не различает INVESTIGATING/RESPONDING/CLOSURE_REVIEW, поэтому однозначного автоматического mapping нет.

Количество: `{ value: number | null, unit: 'ITEM', knowledgeStatus, sources, asOf }`. В v1 только целые неотрицательные штуки, без coercion строк и единиц массы. KNOWN требует число (включая настоящий 0), источник и время; при другом состоянии value строго null. Каждая source содержит sourceRef, sourceType, asOf, demo. Типы источников: RECEIPT, INVENTORY, SHIPMENT, RETAILER_RESPONSE, SALE, CONTAINMENT, DERIVED. DERIVED должен ссылаться на доступные исходные записи; формула и исходные факты сохраняются сервером. Конфликтующие наблюдения остаются в исходных evidence/conflicts, не превращаются в одно произвольное число.

`unaccounted=10` может быть KNOWN как размер доказанного пробела, хотя положение этих единиц неизвестно. `contained` — отдельное свойство, его нельзя прибавлять к группам местонахождения. NOT_CALCULATED требует null значений, basisMaterialRevision и calculatedAt; пустой массив задач при этом не означает отсутствие необходимой работы. CALCULATED указывает основание и время, но может содержать неизвестные количества и конфликты. Арифметика, freshness источников и отсутствие двойного учёта проверяются будущим расчётным сервисом, а не заявляются по наличию чисел в JSON.

TaskStatus: OPEN / IN_PROGRESS / BLOCKED / COMPLETED / CANCELLED / SUPERSEDED. HumanDecisionStatus: PENDING / APPROVED / REJECTED / STALE. Это отдельные enum от KnowledgeStatus и старого ActionStatus. `requestStatus=REQUESTED` переводит активную задачу в IN_PROGRESS, но не завершает её. COMPLETED требует resultEvidenceRefs; достаточность результата для устранения exposure gap проверяется новым расчётом, а не статусом задачи.

Task type и rule разделены. Согласованный каталог этапа 5:

| rule | type | Связь со старым action catalogue |
| --- | --- | --- |
| AFFECTED_AVAILABLE_STOCK | HOLD_STOCK | Соответствует намерению legacy `block_sale`, но использует versioned task и не меняет старую таблицу |
| ACTIVE_SHIPMENT | INTERCEPT_SHIPMENT | Новый versioned action; legacy-эквивалента нет |
| RECIPIENT_POSITION_UNKNOWN | REQUEST_RETAILER_CONFIRMATION | Новый versioned action; не смешивать с supplier evidence request |
| DISTRIBUTION_GAP | INVESTIGATE_TRACEABILITY_GAP | Новый внутренний action |
| SOLD_UNITS | PREPARE_COMMUNICATION | Соответствует намерению legacy `notify_customers`; это подготовка черновика, не отправка |

Legacy `notify_supplier` не переиспользуется: существующий supplier evidence request и операционное уведомление имеют разные цели. Dynamic tasks живут в versioned CaseSnapshot и его истории; legacy `case_tasks/action_drafts` продолжают обслуживать только старые дела. Draft всегда имеет `reviewRequired=true`, `demo=true`, ссылки на sourceRefs и явный текст, что внешнее действие не выполнено.

Closure blocker codes: INVESTIGATION_UNRESOLVED, SCOPE_UNCONFIRMED, EXPOSURE_NOT_CALCULATED, EXPOSURE_STALE, CRITICAL_TASK_PENDING, ACTIVE_TRANSIT, TRACEABILITY_GAP, QUANTITY_CONFLICT, EVIDENCE_MISSING, APPROVAL_STALE. Каждый blocker имеет id/message/critical/subjectRefs/evidenceRefs. Схема отклоняет очевидно противоречивую readiness (например, без расчёта или с активной перевозкой), но не заменяет closure policy. READY_FOR_HUMAN_CLOSURE не закрывает case. Проверка реальной readiness и запись CLOSED должны быть атомарны на сервере.

## Команды и concurrency

Общий envelope мутации: `schemaVersion`, `caseId`, `commandId` (UUID ключ идемпотентности), `expectedCaseVersion` (целое ≥0), `type`. Клиент не передаёт actorId/actorName, роли или серверное время. Strict schema отклоняет эти добавления.

| type / операция | Дополнительные поля | Семантика обработчика |
| --- | --- | --- |
| ACCEPT_INVESTIGATION | outcome | Валидировать case/product и результат; сохранить, увеличить caseVersion, пересчитать зависимые проекции |
| CALCULATE_EXPOSURE | records: непустой список TraceabilityRecord | Идемпотентно сохранить источники и пересчитать exposure для текущей BATCH_LOT; не использует LLM |
| getSnapshot(query) | query: schemaVersion, caseId | Только чтение snapshot; не создаёт дело, задачи и audit |
| DECIDE_ACTION | taskId, decision APPROVED/REJECTED, rationale, evidenceRefs | Записать human decision на актуальном основании/охвате; не заявлять выполненный результат |
| REQUEST_ACTION | taskId, demo | После применимого approval записать учебный REQUESTED и IN_PROGRESS; внешнюю систему не вызывать |
| ATTACH_RESULT | taskId, непустые evidenceRefs, summary, demo | Приложить результат; completion возможен лишь после проверки evidence, охвата и разрешений |
| REQUEST_CLOSURE | rationale, непустые evidenceRefs | Отдельное человеческое подтверждение закрытия; заново проверить readiness в транзакции, при успехе записать decision + CLOSED |

Схема допускает `expectedCaseVersion=0`, но текущий runtime сначала резервирует case доверенным серверным входом и создаёт version 1. Поэтому первый реальный ACCEPT_INVESTIGATION использует актуальную version 1; произвольный новый case от браузера и значение 0 для зарезервированного дела отвергаются. Владелец этого входа и связь alertId→caseId подлежат сверке.

Три версии независимы: schemaVersion меняется при несовместимом формате, materialRevision — при изменении результата investigation, caseVersion — при любой сохранённой мутации дела. task approval может увеличить caseVersion без изменения materialRevision. В v1 любое изменение payload InvestigationOutcome (включая evidence/updatedAt) требует следующего materialRevision; это не означает, что нужно сбрасывать всё выполнение — сервис позже сравнивает охват и факты. ATTACH_RESULT отдельно увеличивает caseVersion.

Правила серверной реализации (ingestion/ledger реализованы в этапе 3, exposure — в этапе 4, task operations — в этапе 5; closure ещё недоступен):

1. Проверить доступ к case и входную схему. В локальном demo использовать фиксированного серверного оператора, явно demo; LLM не получает право выполнять значимые команды.
2. В транзакции проверить ledger по `(caseId, commandId)`. Точная повторная команда возвращает `replayed=true` без повторного эффекта даже после изменения caseVersion. Тот же ключ с отличающимся payload → IDEMPOTENCY_CONFLICT. Сравнение по валидированному каноническому payload; массивы v1 сравниваются с учётом порядка.
3. Для нового commandId проверить expectedCaseVersion; несовпадение → VERSION_CONFLICT без записи. После обновления UI новая попытка с изменённым payload использует новый commandId.
4. Для ACCEPT_INVESTIGATION более низкая materialRevision → STALE_INVESTIGATION; та же revision с отличающимся outcome → IDEMPOTENCY_CONFLICT. Тот же outcome/revision с новым commandId и актуальной expectedCaseVersion — no-op с replayed=true, без увеличения версии. Более высокая revision принимается после проверки принадлежности; пропуски номеров допустимы.
5. Атомарно сохранить state, audit, ledger, решения и новую caseVersion; отказ не оставляет частичных бизнес-изменений. Ссылки на старые решения/результаты сохранять в истории, применимость пересматривать по coverage. ACCEPT_INVESTIGATION, CALCULATE_EXPOSURE, DECIDE_ACTION, REQUEST_ACTION и ATTACH_RESULT используют общий ledger и immediate-транзакцию.

CommandResult: `{ ok:true, commandId, replayed, appliedCaseVersion, snapshot }` либо `{ ok:false, error }`. appliedCaseVersion — версия первоначального эффекта; snapshot — актуальное доступное состояние, его caseVersion при replay может быть выше. SnapshotResult: `{ ok:true, snapshot }` либо тот же error envelope.

Примеры ошибок (структурно валидируются `contractErrorSchema`):

```json
{"code":"VERSION_CONFLICT","message":"Refresh the case before retrying.","currentCaseVersion":2,"issueRefs":[]}
```

```json
{"code":"UNSUPPORTED_SCOPE","message":"WHOLE_PRODUCT is not supported in schema v1.","currentCaseVersion":null,"issueRefs":[]}
```

```json
{"code":"CLOSURE_BLOCKED","message":"Exposure has not been calculated.","currentCaseVersion":1,"issueRefs":["demo:exposure-missing"]}
```

Остальные коды: INVALID_INPUT, UNSUPPORTED_SCHEMA_VERSION, NOT_FOUND, FORBIDDEN, STALE_INVESTIGATION, IDEMPOTENCY_CONFLICT, INVALID_STATE, EVIDENCE_REQUIRED, NOT_IMPLEMENTED. currentCaseVersion=null означает, что версия недоступна/не раскрывается, не ноль. Boundary этапа 3 сначала проверяет schemaVersion и kind scope для специализированных ошибок, затем Zod для INVALID_INPUT; schema.safeParse сейчас возвращает обычный ZodError, не выполняет этот mapping. При подключении ещё отсутствующей операции нужно явно вернуть NOT_IMPLEMENTED, не выдавать старый workflow за новый сервис.

## Fixtures и воспроизводимая проверка

`src/lib/contracts/recall.fixtures.ts` — синтетические примеры, только для тестов и явного demo. Не импортируется production workflow. Экспорты:

- confirmedLotOutcome: P-17 (UUID), L-2403, независимые ссылки на identity/scope evidence и human decisions, materialRevision=1.
- unresolvedScopeOutcome: identity MATCH, scope UNRESOLVED/UNKNOWN и критический BATCH_MISSING gap. Это альтернативное начальное состояние, не последовательное событие с тем же revision.
- expandedLotOutcome: L-2403 + L-2404, materialRevision=2, новая scope evidence/decision; старое scope approval не переиспользуется.
- contractFixtures: три пары outcome/snapshot. Exposure намеренно NOT_CALCULATED, количества null, closure NOT_READY. Расчёт 100=40+20+25+5+10 ещё не реализован и не подставляется.
- acceptInvestigationExample: реальный валидируемый пример envelope первоначальной доставки.

Полные объекты импортируются из этого файла, не копируются в другой пакет. Ссылки demo: обозначают договорённые синтетические evidence/decisions; они не являются уже существующими DB records.

```bash
npm test -- src/lib/contracts/recall.test.ts
npm run check
npm test
npm run build
```

Для ручного просмотра без БД и без сервиса:

```bash
node --import tsx --input-type=module -e 'import { investigationOutcomeSchema, caseSnapshotSchema } from "./src/lib/contracts/recall.ts"; import { contractFixtures } from "./src/lib/contracts/recall.fixtures.ts"; for (const f of contractFixtures) { console.log(f.name, investigationOutcomeSchema.safeParse(f.outcome).success, caseSnapshotSchema.safeParse(f.snapshot).success); }'
```

Ожидается три строки с `true true`. Negative tests проверяют UNKNOWN≠0, provenance, unsupported scope/version, ссылки, разные identity/scope, несогласованные версии snapshot, strict command envelopes, отсутствие evidence и разделение task/decision/request статусов. Это проверки контракта; проверки runtime persistence/concurrency добавлены отдельно в case-lifecycle.test.ts.

## Владельцы и сверка перед подключением

| Общие файлы / участок | Владелец изменений |
| --- | --- |
| src/lib/contracts/recall.ts, recall.fixtures.ts, recall.test.ts; этот документ | Герман ведёт контракт B; друг сверяет требования investigation/UI и импортирует этот же модуль |
| src/lib/server/db/schema.ts, drizzle/*, будущий ingestion/snapshot/exposure/tasks/closure | Герман |
| Investigation, AI, основной UI, общий evaluation harness | Друг; свои тесты и подключение общего контракта |
| src/lib/types/domain.ts | Менять только после сверки обеих сторон, поскольку уже используется существующим workflow |
| package.json / package-lock.json | В этом этапе не менялись; при необходимости заранее выбрать одного редактора |

Отдельно сверить: один product на case против текущих multi-item cases; выделение caseId до ingestion и владелец monitoring; revision при evidence-only update; значения новых stage/task/rule и перевод старых action drafts; серверный demo actor и resolution evidence/decision refs. Этот документ не заявляет, что друг уже согласовал формат или подключил свой код. Этапы 3–5 выполнены в границах runtime-уточнений ниже.

Поля task были уточнены в v1 до подключения второй стороны: ранее schema принимала неполный объект, но runtime его не создавал. Строгому потребителю всё равно требуется атомарно обновить импорт общего модуля и UI mapping; вручную сохранять старую копию task shape нельзя. До совместной сверки это считается изменением общего контракта, даже без увеличения schemaVersion.


## Уточнения runtime этапа 3 (приоритет над проектными примерами этапа 2)

- Reservation для существующего alert/product создаёт case и snapshot **version 1**, investigation/materialRevision=null, без case_items и фиктивных количеств. Поэтому первый реальный ACCEPT_INVESTIGATION использует expectedCaseVersion=1, не 0. Схема v1 сохраняет допустимость 0 для совместимости формата, но текущий сервер не создаёт case через ingestion: без reservation → NOT_FOUND, после reservation при 0 → VERSION_CONFLICT. Старый acceptInvestigationExample остаётся schema-only примером; рабочий пример — scripts/demo-lifecycle.ts.
- Новый контекст пока только explicit demo: VERIRECALL_DEMO_MODE=true, actor demo_operator, demo:true; иначе FORBIDDEN. Решения/evidence остаются непроверенными ссылками, поэтому stage всегда INVESTIGATING и closure NOT_READY. Любое согласование из входного payload не устраняет конфликты и не повышает стадию.
- Стадии: INVESTIGATING — резервирование/непроверенное расследование; RESPONDING требует серверно подтверждённых identity/scope; CONTAINED — доказанного результата containment; CLOSURE_REVIEW — пройденной readiness; CLOSED — отдельного актуального human decision в транзакции. Последние четыре перехода на этапе 3 запрещены, пока условия не реализованы.
- Для изменения live состояния используются только новые команды. Старые команды для lifecycle case заблокированы; автоматическая конвертация legacy-case и несколько продуктов на один lifecycle-case отвергаются явно.
- Реальные routes и поля server load документированы в HANDOFF_TO_FRIEND.md. Существующие enums не переименованы, контрактный модуль не копировался.

## TraceabilityRecord и расчёт этапа 4

`TraceabilityRecord` находится в том же `$lib/contracts/recall` и является strict discriminated union. Общие поля: `sourceRef`, `productId`, `lot: string | null`, `occurredAt`, `demo`. Виды: RECEIPT (`receiptRef`, quantity), INVENTORY (`locationRef`, quantity), SHIPMENT (`shipmentRef`, destinationRef, quantity, status IN_TRANSIT/DELIVERED/RETURNED), RETAILER_RESPONSE (`retailerRef`, quantity), SALE (`saleRef`, quantity), CONTAINMENT (`locationRef`, quantity). Количество — целое неотрицательное число ITEM; нулевой факт допустим, неизвестность выражается отсутствием подходящего доказательства и null в результате.

`sourceRef` уникален внутри case. Точный повтор не увеличивает количество; иной payload с тем же sourceRef возвращает IDEMPOTENCY_CONFLICT. Переход перевозки записывается новым sourceRef с тем же shipmentRef; расчёт выбирает последнее состояние, поэтому история IN_TRANSIT→DELIVERED→RETURNED не суммируется. INVENTORY, RETAILER_RESPONSE и CONTAINMENT также выбираются по последнему наблюдению для location/retailer и партии. RECEIPT и SALE — аддитивные исходные записи.

Граница affected total — сумма RECEIPT только для `investigation.scope.lots`. Записи других партий сохраняются, но не входят в текущий результат; после расширения scope они участвуют в новом расчёте. Запись с `lot:null` не считается безопасно незатронутой: создаётся gap, соответствующее количество становится неизвестным. Продажи известны только при наличии SALE, включая явную запись quantity=0. Доставленная перевозка не доказывает остаток: нужен RETAILER_RESPONSE не старше 7 суток на момент расчёта и не предшествующий более новому движению к этому получателю.

Распределение — warehouse + inTransit + retailer + sold + unaccounted. Contained хранится отдельно и не входит в сумму местонахождений. Если все компоненты известны, unaccounted выводится из receipts минус распределённые единицы; положительная разница создаёт TRACEABILITY_GAP. Если распределение 105 при receipts=100, receipts остаётся 100, unaccounted становится CONFLICTED/null и создаётся DISTRIBUTION_EXCEEDS_RECEIPTS с excess 5; отрицательная разница не обрезается до нуля.

CALCULATE_EXPOSURE разрешён только для известного MATCH и известного BATCH_LOT. Команда проверяет expectedCaseVersion и productId всех records, сохраняет источники/snapshot/history/audit/ledger одной immediate-транзакцией. Exposure получает `basisMaterialRevision`, `calculatedAt`, sourceRef/sourceType/asOf/demo на каждом известном количестве. При новой materialRevision старый exposure сбрасывается в NOT_CALCULATED; сохранённые source records затем можно пересчитать новым commandId. Stage пока остаётся INVESTIGATING из-за непроверенных human decision refs. UI уже читает этот настоящий snapshot.
