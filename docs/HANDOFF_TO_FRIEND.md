# Передача блока B следующему разработчику

Актуально после этапа 5, 2026-09-08. По решению Германа он последовательно реализует свой блок сам; друг подключается после него. Этот файл обновляется по завершённым этапам, а не сообщает о планах как о готовом коде. Никому автоматически не отправлялся.

Отчёт о testing strategy/code review находится в `docs/STAGE_5_QUALITY.md`, решение о хранении задач — в `docs/adr/0001-dynamic-task-engine-in-case-snapshot.md`.

## Что сейчас работает

В `herman_dev` завершены аудит, общий контракт v1, persisted lifecycle, детерминированный exposure/traceability и минимальный Dynamic Task Engine для BATCH_LOT. Общие типы: `$lib/contracts/recall`; сервер: `$lib/server/workflow/case-lifecycle`; правила задач: `$lib/server/tasks/engine`. После `db:migrate` можно через реальные HTTP routes создать investigation case, принять результат, рассчитать exposure, получить задачи, отдельно записать human decision, учебный request и result evidence, прочитать snapshot и открыть карточку `/cases/{caseId}`. Данные сохраняются в SQLite после перезапуска.

Повтор commandId не меняет дело и историю. Другая команда с тем же outcome/revision тоже не создаёт новую версию. Устаревшая caseVersion, старая materialRevision и противоречащий повтор отвергаются. Изменение snapshot, история, audit и ledger записываются в одной immediate-транзакции. Наличие decisionRefs не считается серверным подтверждением.

Stage пока всегда INVESTIGATING, closure NOT_READY; даже у fixture с KNOWN identity/scope есть SCOPE_UNCONFIRMED, поскольку resolver решений investigation ещё не реализован. После CALCULATE_EXPOSURE настоящий exposure содержит числа или явные null/knowledgeStatus, provenance, gaps/conflicts, dynamic tasks и pending action decisions. REQUESTED означает только записанный учебный запрос, COMPLETED требует resultEvidenceRefs, а завершение задачи само по себе не удаляет exposure gap.

## Воспроизвести с нуля

Терминал 1, из корня репозитория:

```bash
stage5_dir=$(mktemp -d /tmp/verirecall-demo-XXXXXX)
export DATABASE_URL="$stage5_dir/demo.db"
export VERIRECALL_DEMO_MODE=true
export OPENAI_API_KEY=''
export OPENAI_MODEL=''
npm run db:migrate
npm run db:seed
npm run dev -- --host 127.0.0.1 --port 5183 --strictPort
```

Терминал 2, из того же репозитория:

```bash
VERIRECALL_BASE_URL=http://127.0.0.1:5183 node --import tsx scripts/demo-lifecycle.ts
```

Клиент выводит полный реальный ответ и caseUrl. Он создаёт case, передаёт demo L-2403, сохраняет traceability records, рассчитывает exposure, проверяет повторы обеих команд и GET snapshot. Только этот явно запускаемый demo-клиент импортирует синтетические fixtures; сервер их не подставляет. На свежей БД ожидаются caseVersion=3, три history record, `100 received / 40 warehouse / 20 in transit / 25 retailer / 5 sold / 10 unaccounted`, четыре active task, три pending action decision, contained=40 отдельно и NOT_READY.

Открой caseUrl, затем Cases. Карточка показывает L-2403, exposure, задачи, draft с sourceRefs и отдельные controls Approve/Reject → Record demo request → Attach result evidence. Эти действия обновляют versioned snapshot через тот же command route; реальные письма, POS, ERP, inventory и shipment systems не вызываются. Останови сервер и запусти снова с тем же DATABASE_URL: карточка, задачи и история сохраняются.

## Реальное подключение investigation и UI

До отправки outcome зарезервируй дело через существующую пару alert/product. Сервер проверяет catalogue match и выдаёт UUID. Нельзя передать чужой productId в уже зарезервированное дело.

```ts
// Server-side, inside this SvelteKit monolith; never ship db to the browser.
import { db } from '$lib/server/db/connection';
import { createRecallService, reserveInvestigationCase } from '$lib/server/workflow/case-lifecycle';
import { localLifecycleContext } from '$lib/server/workflow/lifecycle-http';
import {
  investigationOutcomeSchema,
  traceabilityRecordSchema
} from '$lib/contracts/recall';

const context = localLifecycleContext();
const reserved = reserveInvestigationCase(db, { alertId, productId }, context);
if (!reserved.ok) throw new Error(reserved.error.message);
const service = createRecallService(db, context);
const result = await service.execute({
  type: 'ACCEPT_INVESTIGATION', schemaVersion: 1,
  caseId: reserved.snapshot.caseId, commandId: crypto.randomUUID(),
  expectedCaseVersion: reserved.snapshot.caseVersion,
  outcome: investigationOutcomeSchema.parse(investigationPayload)
});
// investigationPayload must use the reserved caseId/productId and demo:true in local demo mode.

const exposure = await service.execute({
  type: 'CALCULATE_EXPOSURE', schemaVersion: 1,
  caseId: reserved.snapshot.caseId, commandId: crypto.randomUUID(),
  expectedCaseVersion: result.ok ? result.snapshot.caseVersion : 0,
  records: rawTraceabilityRecords.map((record) => traceabilityRecordSchema.parse(record))
});
// Keep rawTraceabilityRecords at the integration boundary; do not copy the shared shape.

if (!exposure.ok) throw new Error(exposure.error.message);
const hold = exposure.snapshot.tasks.find((task) => task.type === 'HOLD_STOCK');
if (!hold) throw new Error('No affected stock hold is required by this snapshot.');
const approved = await service.execute({
  type: 'DECIDE_ACTION', schemaVersion: 1, caseId: exposure.snapshot.caseId,
  commandId: crypto.randomUUID(), expectedCaseVersion: exposure.snapshot.caseVersion,
  taskId: hold.id, decision: 'APPROVED', rationale: 'Reviewed against current lot coverage.',
  evidenceRefs: []
});
if (!approved.ok) throw new Error(approved.error.message);
const requested = await service.execute({
  type: 'REQUEST_ACTION', schemaVersion: 1, caseId: approved.snapshot.caseId,
  commandId: crypto.randomUUID(), expectedCaseVersion: approved.snapshot.caseVersion,
  taskId: hold.id, demo: true
});
// requested.snapshot keeps HOLD_STOCK IN_PROGRESS; only ATTACH_RESULT with evidence can complete it.
```

Для UI уже есть:

| Route | Вход / выход |
| --- | --- |
| POST `/api/cases/investigation` | `{ alertId, productId }` → SnapshotResult; идемпотентная reservation по alert/product |
| POST `/api/cases/{id}/commands` | RecallCommand → CommandResult; ACCEPT_INVESTIGATION, CALCULATE_EXPOSURE, DECIDE_ACTION, REQUEST_ACTION и ATTACH_RESULT |
| GET `/api/cases/{id}/snapshot` | SnapshotResult, Cache-Control no-store |
| `/cases/{id}` server load | Существующий detail плюс `snapshot: CaseSnapshot \| null` и `history` |

POST требует JSON и Origin, совпадающий с origin URL; браузерный fetch same-origin делает это штатно. curl/скрипт должен передать `Origin: http://127.0.0.1:5183`. Без `VERIRECALL_DEMO_MODE=true` новые API отвечают FORBIDDEN (403). Это явный локальный demo-режим с фиксированным серверным `demo_operator`, не production-аутентификация. mode не принимается из HTTP payload. Live outcome (`demo:false`) отклоняется.

`getCaseHistory(db, caseId)` возвращает полные сохранённые snapshots по caseVersion. UI показывает exposure, dynamic tasks, pending approvals, drafts и список версий через `InvestigationSnapshot.svelte`. Собственные компоненты импортируют `CaseSnapshot`, `RecallCommand` и result schemas из общего модуля. Не копировать интерфейсы и не считать null количеством 0.

Ошибки: 400 INVALID_INPUT/UNSUPPORTED_SCHEMA_VERSION/UNSUPPORTED_SCOPE, 403 FORBIDDEN, 404 NOT_FOUND, 409 VERSION_CONFLICT/STALE_INVESTIGATION/IDEMPOTENCY_CONFLICT/INVALID_STATE, 501 NOT_IMPLEMENTED для будущих команд. После VERSION_CONFLICT обновить snapshot и подготовить новую команду с новым commandId; точный сетевой retry сохраняет исходные commandId и payload.

## База и ограничения интеграции

- Миграция `0002_case_lifecycle.sql` добавляет lifecycle; `0003_traceability_exposure.sql` добавляет append-only traceability_records и разрешает несколько case revisions на одной materialRevision. Старые миграции не менялись. Перед новым кодом выполнить `npm run db:migrate` на собственной базе.
- `cases` остаётся общим реестром, `cases.status=open` — совместимая проекция стадии INVESTIGATING. Расследование, identity/scope и все состояния знания хранятся отдельно в валидированном JSON snapshot; старые stock/case_items не используются для расчёта.
- Один product на lifecycle case. Повтор reservation того же alert/product возвращает существующий snapshot. Уже существующий legacy-case или другой product на том же alert возвращает INVALID_STATE: автоматического слияния multi-item дела нет.
- После reservation старые confirm/reject/requestEvidence для этого alert, completeTask/close и legacy task setup блокируются сервером. Старые дела без case_lifecycle продолжают работать и покрыты прежними тестами. Не создавать старые tasks/drafts для новых дел обходным путём.
- Старый CSV/PDF exporter для lifecycle case явно недоступен: он иначе выводил бы фиктивный stock=0. Реальный snapshot JSON доступен; отдельная адаптация отчётов впереди.
- HTTP GET новых API gated demo-mode; существующий локальный server page load читает сохранённые данные без нового production auth. Новые API нельзя публиковать как защищённый многопользовательский сервис.
- Evidence/decision refs сохраняются как непроверенные ссылки. Их подлинность, принадлежность, актуальность и human approval ещё не подтверждаются resolver-ом; именно поэтому продвижение стадии запрещено. Ссылки fixture `demo:` не являются реальными evidence records.
- БД является хранилищем доверенного серверного кода; история не редактируется сервисом/UI. Это не криптографическая защита от администратора SQLite. Явный demo reset удаляет её каскадно вместе с делом.

## Что проверено

- `npm test`: 99 тестов в 19 файлах, PASS; task engine покрыт шестью unit и шестью service scenarios, дополненными contract и list projection assertions.
- Сохранение/чтение, новое соединение, replay после расширения, история старого scope, canonical key order, одинаковая revision с новым commandId, старые/противоречащие версии и принадлежность case/product.
- Два независимых DB connection с одинаковой expectedCaseVersion: один writer принят, второй получает конфликт. Это воспроизводимая проверка optimistic concurrency внутри одного процесса, не нагрузочный тест параллельных процессов.
- Искусственная ошибка последней записи ledger: snapshot/history/audit откатываются. Миграция заполненной 0001 БД и повтор миграции проходят без изменения продуктов.
- `npm run check`: 0 ошибок/предупреждений; `npm run build`: PASS, прежнее сообщение adapter-auto об отсутствии production target.
- Реальный HTTP demo-клиент на новой временной БД, повтор команды, GET, перезапуск сервера с точным сравнением snapshot, ошибки stale version/path mismatch/cross-origin.
- Карточка и полный переход HOLD_STOCK проверены в браузере на desktop; список Cases после completion показывает 1/4 и следующий blocking action. После перезапуска с той же временной БД сохранились caseVersion 6, task states и шесть revisions. Адаптивная основа этапа 4 проверялась на 390px, но новые controls этапа 5 отдельным мобильным walkthrough не проверялись. Docker, live AI и production deployment в этом этапе не проверялись.

## Что ещё не сделано

Resolver для investigation evidence/decisions, достаточность result evidence, реальные операционные интеграции, closure policy, reopen и simulation. Расширенный scope немедленно переводит прежние задачи в SUPERSEDED со STALE approval; следующая CALCULATE_EXPOSURE создаёт задачи для нового покрытия. Стадии RESPONDING/CONTAINED/CLOSURE_REVIEW/CLOSED пока недостижимы. REQUEST_CLOSURE возвращает NOT_IMPLEMENTED без побочных эффектов.

Герман продолжает эти этапы отдельно; при последующем подключении друга этот файл нужно читать вместе с актуальными `docs/MVP_STATUS.md` и `docs/INTEGRATION_CONTRACT.md`.
