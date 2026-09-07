# VeriRecall — состояние блока B

Дата: 2026-09-07. **Этап 4 завершён: exposure/traceability рассчитывается из сохранённых исходных записей и входит в настоящий CaseSnapshot.** Этап 5 не начат. Герман продолжает свой блок самостоятельно; друг подключается позже по `docs/HANDOFF_TO_FRIEND.md`.

## Обновление после этапа 4

- Добавлен общий strict `TraceabilityRecord` и команда CALCULATE_EXPOSURE. Виды источников: receipt, inventory observation, shipment transition, retailer response, sale и containment. Неподдерживаемые/лишние поля, чужой productId, повтор sourceRef с иным payload и дубли внутри команды отклоняются.
- Миграция `0003_traceability_exposure.sql` добавляет append-only traceability_records с уникальным `(caseId, sourceRef)` и заменяет уникальность materialRevision в истории обычным индексом: расчёт exposure создаёт отдельную caseVersion на том же результате investigation. Старые миграции не переписаны.
- `src/lib/server/exposure/calculate.ts` считает только подтверждённые BATCH_LOT обычным кодом. Граница total — уникальные receipt records выбранных партий. Для inventory/retailer/containment берётся последнее наблюдение на location/lot; для shipment — последнее состояние shipmentRef. Доставка требует свежего retailer response (≤7 суток и после последнего движения). SALE обязателен даже для подтверждённого нуля.
- Нормальный fixture даёт `received 100; warehouse 40; in transit 20; retailer 25; sold 5; unaccounted 10`; contained=40 хранится отдельно и не прибавляется к распределению. Каждое известное количество содержит sourceRef/sourceType/asOf/demo.
- UNKNOWN total остаётся null. Shipment без batch даёт UNRESOLVED и gap. Неактуальный retailer response даёт PENDING. При 105/100 received остаётся 100, unaccounted становится CONFLICTED/null, сохраняется excess 5. Переходы shipment и возврат не суммируют историю; чужие партии не входят до расширения scope.
- Источники, snapshot, history, audit и command ledger обновляются атомарно. Точный/семантический повтор не увеличивает количество и не создаёт новую историю. После расширения L-2403 → L-2403+L-2404 старый exposure сбрасывается, сохранённые records обеих партий пересчитываются: интеграционный тест получает received 120 без дублей.
- Snapshot/UI показывают рассчитанные позиции, provenance/as-of, containment, gaps/conflicts и blockers ACTIVE_TRANSIT/TRACEABILITY_GAP/QUANTITY_CONFLICT. Stage остаётся INVESTIGATING и SCOPE_UNCONFIRMED до серверной проверки human decisions; задачи не создаются.
- Проверки: 87 тестов в 17 файлах, check 0 errors/warnings и production build PASS. Отдельно покрыты восемь вариантов чистого расчёта и пять сценариев persistence/service. Реальный HTTP demo прошёл на чистой БД; после перезапуска сохранились caseVersion 3, три записи истории и рассчитанные значения. UI проверен в браузере на desktop и 390 px без ошибок консоли и горизонтального переполнения.
- Изменение общего контракта для друга: импортировать `TraceabilityRecord` и CALCULATE_EXPOSURE из `$lib/contracts/recall`; правила и пример обновлены в INTEGRATION_CONTRACT.md и `scripts/demo-lifecycle.ts`. Package/lockfile не менялись.

## История: обновление после этапа 3

- Новые таблицы case_lifecycle, case_revisions, case_commands через новую миграцию `0002_case_lifecycle.sql`; старые миграции не изменены. Snapshot, история, audit и ledger записываются атомарно. Реализованы reservation по существующему alert/product, ACCEPT_INVESTIGATION и read snapshot; три версии остаются независимыми.
- `src/lib/server/workflow/case-lifecycle.ts`: валидация неизвестного входа, проверка принадлежности product/case, immediate-транзакции, idempotency, stale revision и optimistic concurrency. Новый case резервируется с caseVersion=1, затем первый outcome создаёт caseVersion=2. Существующие legacy/multi-product cases не конвертируются автоматически.
- Сохранённые identity/scope/gaps/conflicts остаются отдельными данными. Evidence/decision refs пока непроверены, поэтому даже KNOWN outcome не продвигает дело дальше INVESTIGATING; exposure NOT_CALCULATED, все количества null, closure NOT_READY. Расчёты, human decision resolver, задачи, approvals, closure/reopen пока отсутствуют; соответствующие команды возвращают NOT_IMPLEMENTED.
- Реальные API: POST `/api/cases/investigation`, POST `/api/cases/[id]/commands`, GET `/api/cases/[id]/snapshot`. Explicit local demo mode (`VERIRECALL_DEMO_MODE=true`), фиксированный серверный demo_operator, клиентский actor отвергается. Live outcome не принимается. Это не production auth.
- Case page load возвращает настоящий `snapshot` и `history`; `InvestigationSnapshot.svelte` показывает факты, неизвестный exposure, blockers и версии. Cases показывает новое дело без ложного stock=0 и без утверждения, что задачи уже выполнены. Старые операции review/task/close и старый export для lifecycle-case заблокированы на сервере; legacy дела продолжают работать.
- Проверки: 74 теста / 15 файлов PASS (13 новых lifecycle tests), check 0 errors/warnings, build PASS. Проверены новое соединение, повтор команды после более новой revision, ошибочные версии/принадлежность, два DB connection с одной expectedCaseVersion, откат при ошибке ledger, обновление заполненной 0001 БД и повтор миграции.
- Реальный запуск на отдельной `/tmp/verirecall-stage3-6CuJwZ/demo.db`: миграция/seed, HTTP demo client, snapshot GET, перезапуск сервера с точным сравнением snapshot и сохранённой историей; HTTP 409 stale version, 400 path mismatch/cross-origin. Браузер: карточка desktop и 390px, список Cases. Docker/live AI/production не проверялись.
- Рабочий пример для друга: `scripts/demo-lifecycle.ts`. Все команды воспроизведения, API, текущие ограничения и условия стадий — в `docs/HANDOFF_TO_FRIEND.md` и обновлённом INTEGRATION_CONTRACT.md. Сообщения другу не отправлялись; инструкция сохранена для последующей передачи.
- Общий контракт: уточнена фактическая reservation (expectedCaseVersion=1 при первой доставке), явно закреплён один product на новый case и запрет автоматической legacy-конвертации. Типы v1 не менялись. Следом нужны только работы этапа 4 после отдельного запроса.

## История: обновление после этапа 2

- Добавлен единый модуль `src/lib/contracts/recall.ts`: Zod-схемы и выведенные типы InvestigationOutcome/CaseSnapshot, quantity/provenance, независимые knowledge/task/decision статусы, команды, ошибки и интерфейс RecallService. Обе стороны должны импортировать `$lib/contracts/recall`; существующие domain.ts, schema и UI не менялись.
- `src/lib/contracts/recall.fixtures.ts`: подтверждённая L-2403, неизвестный scope и расширение L-2403 + L-2404. Во всех snapshot exposure NOT_CALCULATED, неизвестные количества null, closure NOT_READY. Fixtures не подключены к production workflow.
- `docs/INTEGRATION_CONTRACT.md`: поля, валидные/ошибочные примеры, правила трёх версий, idempotency/concurrency, операции UI и владельцы. Контракт подготовлен для сверки, согласие/подключение друга ещё не подтверждено.
- Ключевые вопросы сверки: один product на case против существующих multi-item cases; резервирование caseId до ingestion; revision при изменении только evidence; новые stage/task/rule относительно старых enums; доверенный demo actor и разрешение evidence/decision refs. WHOLE_PRODUCT в v1 явно не поддерживается.
- Проверено: `npm run check` — 0 errors/warnings; `npm test` — 61 тест в 14 файлах, включая 11 новых contract tests; `npm run build` — PASS с прежним сообщением adapter-auto об отсутствии production environment. CLI-проверка трёх fixtures из INTEGRATION_CONTRACT.md выдала три `true true`.
- Новые проверки покрывают UNKNOWN≠0, обязательные источники, неподдерживаемый scope/version, strict payload, согласованность snapshot, отсутствие evidence и разделение запроса/выполнения/решения. Они **не** доказывают транзакционную идемпотентность, права или closure policy: серверных обработчиков ещё нет.
- Для ручной проверки: выполнить команды из раздела «Fixtures и воспроизводимая проверка» в INTEGRATION_CONTRACT.md. Нового интерфейса на этом этапе нет; браузерный прогон и миграции повторно не запускались, поскольку UI/БД не менялись.
- Осталось после сверки: реализация ingestion/persistence/version ledger и реального snapshot, затем exposure/tasks/approvals/closure/reopen по отдельно разрешённым этапам. Старые проблемы бизнес-логики из аудита ниже остаются открытыми.
- Ветка `herman_dev`; пользовательский untracked `VERIRECALL_6_DAY_CODEX_PLAN.md` не менялся и не включается в коммит. Изменения схемы БД, зависимостей и lockfile отсутствуют.

## Исторический аудит этапа 1

Разделы ниже фиксируют состояние **до этапа 2**. Указанное там отсутствие типов/контракта устранено обновлением выше; отсутствие нового persistence и бизнес-операций остаётся актуальным.

## Основание и Git

- Исходная ветка: `feat/catalogue-aware-ui-stages-2-4`, коммит `46e3ae92f4f3c47fbe966ede2a4bbadedd6db9dd`. Для результата создана `herman_dev` от этого коммита. Другие ветки не объединялись, remote не обновлялся, push не выполнялся.
- До работы единственное незакоммиченное изменение: `VERIRECALL_6_DAY_CODEX_PLAN.md` (untracked, предоставлен пользователем). Файл не изменён и не включён в коммит аудита.
- `AGENTS.md` в репозитории и родительских каталогах не найден; `docs/work-split.md` отсутствует. Отдельного исходного `message.txt` нет. Распределение ответственности взято из задания пользователя и шестидневного плана.
- Прочитаны `tech.md` (ТЗ 1.1), `README.md`, применимые положения `product-improvement-roadmap.md` и `VERIRECALL_6_DAY_CODEX_PLAN.md`. Старое ТЗ описывает более узкий локальный MVP: зелёные проверки этого MVP не означают готовность нового блока B.
- Значения секретов не открывались. Зависимости, конфигурация, рабочая БД и исходный код не менялись. Единственный новый файл результата — этот отчёт.

## Фактическая архитектура

SvelteKit 2 / Svelte 5 / TypeScript / Tailwind 4, SQLite через better-sqlite3 и Drizzle, Zod, Vitest; один монолит. В среде Node 22.13.1 и npm 10.9.2. Использованы существующие `node_modules`; чистая установка зависимостей не проверялась.

Схема: `src/lib/server/db/schema.ts`; соединение: `client.ts`, `connection.ts` в том же каталоге; helpers и seed: `repositories.ts`, `demo-fixtures.ts`. Миграции: `drizzle/0000_initial.sql` (заглушка), `0001_last_living_lightning.sql` (12 прикладных таблиц), журнал и snapshots в `drizzle/meta/`. Есть внешние ключи, CHECK и уникальность case на alert, item на case/product/batch, task на case/type. Нет таблиц движений, версий расследования, структурированных решений или revisions. Старые миграции следует сохранять.

## Карта блока B

Статусы относятся к требованиям шестидневного плана; в колонке проверки отдельно указано, что подтверждено для существующей реализации.

| Участок | Статус | Реализация и проверенный результат | Недостающее |
| --- | --- | --- | --- |
| CaseSnapshot и persistence | Частично | SQLite хранит cases/items/tasks/drafts/audit; `getCaseDetail` в `src/lib/server/cases/queries.ts` читает `CaseDetailView`. `database.test.ts`, `review.test.ts`, `case-actions.test.ts`, `demo-flow.test.ts` проходят. Повторные CLI-подключения читают seed без потерь. | Нет CaseSnapshot, версии дела/расследования, независимых состояний identity/scope/knowledge, attentionItems и closure blockers. Сохранность полного изменённого case после перезапуска отдельным тестом не проверена. |
| Ingestion InvestigationOutcome | Отсутствует | Существующая точка входа — `confirmReviewMatch` в `src/lib/server/workflow/review.ts`: matchId + actorName → case/item/tasks, транзакционно и без дублей при повторном confirm. | Нет самого контракта и обработчика InvestigationOutcome, проверки schemaVersion/materialRevision, устаревшей доставки и противоречащего повторного payload. Confirm не эквивалентен ingestion расследования. |
| Exposure / traceability | Частично | `caseItems.stockQuantity` копируется из каталога; `queries.ts` суммирует stock и фильтрует purchases по продукту/партии; `case-setup.ts` использует аналогичный фильтр. В существующем demo-flow проверено 42 units. | Нет received total, распределения warehouse/transit/retailer/sold/unaccounted, источников/asOf, gaps/conflicts и защиты от двойного учёта движений. Строка `Unknown` и покупки с null batch включаются в выборку без отдельного состояния знания. |
| Task generation | Частично | `ensureCaseResponseRecords` в `src/lib/server/workflow/case-setup.ts` создаёт три задачи и черновики: block_sale, notify_supplier, notify_customers. Проверены создание и повтор confirm без дублей. | Нет правил по exposure, coverage, зависимостей, superseded/history и пересмотра при изменении данных. Уже существующие tasks/drafts не обновляются при новом охвате. |
| Approvals | Частично | `approveActionDraft` в `case-actions.ts`: проверяет состояние, имя, recipient, записывает audit и simulated_sent в транзакции; повтор идемпотентен. Проверки проходят. UI явно показывает имитацию. | actorName приходит из браузера; нет доверенного server actor/ролей, версии основания и применимости решения. Approve автоматически завершает задачу, подтверждение результата отдельно не требуется. |
| Closure | Частично | `closeRecallCase` в `case-actions.ts`: в транзакции требует ровно 3 задачи без pending, имя, note ≥20 символов и reference ≥3; сохраняет audit. Тест подтверждает запрет преждевременного закрытия по старому чеклисту и идемпотентность. | Нет readiness с кодами причин, проверки фактов/перевозок/неизвестности/конфликтов/evidence/scope и expectedVersion. contained также выводится только из трёх задач. |
| Scope revision / reopen | Отсутствует | `runMonitoringCycle` в `workflow/monitoring.ts` пропускает известные source/reference. Повторный импорт без дублей проверен. | Нет обновления scope, пересчётов, переоценки approvals и автоматического reopen с историей. Повтор alert не является revision. |
| Readiness / simulation №10 | Отсутствует | simulated_sent — только имитация отправки сообщения. | Нет расчёта гипотетической партии без побочных эффектов; отложить до основного демо. |

## Существенные расхождения, которые нельзя скрыть зелёными тестами

1. `src/lib/server/imports/importer.ts`, `productRowSchema.stock_quantity`: пустое значение превращается в `0`; схема products дополнительно требует non-null stock с default 0. Это не сохраняет UNKNOWN по новым требованиям.
2. `confirmReviewMatch` выбирает `product.batch ?? alert.batch ?? 'Unknown'`, не подтверждая scope отдельно. Hard conflict остаётся в поле matches, но не препятствует confirm и последующему закрытию. Получение evidence не требуется для confirm; нет реализованной цепочки загрузки и проверки ответа. Confirm нельзя трактовать как устранение factual conflict.
3. `approveActionDraft` сразу переводит связанную pending task в completed. `completeCaseTask` позволяет завершить её по имени оператора без approval/evidence. Старый тест закрытия специально проходит через этот прямой вызов.
4. `requestMatchEvidence` создаёт case ещё до confirm. Его supplier evidence draft имеет тот же тип `notify_supplier`, что и операционный draft; `ensureCaseResponseRecords` считает такой тип уже существующим. Поэтому запрос доказательства может подменить требуемую коммуникацию об отзыве. Существующий demo-flow проходит именно через этот путь.
5. `getCaseDetail` выбирает match с максимальным score, а не явно подтверждённый для конкретного item; `customers.length` — число строк покупок, не обязательно уникальных получателей. Это ограничения текущего UI-контракта.

Пункты 1–5 установлены чтением кода; отдельные новые негативные тесты на них в аудите не добавлялись. Они оставлены как работа следующих отдельно разрешённых этапов.

## Реальные точки подключения UI и общие типы

- `src/lib/types/domain.ts`: общие enums и интерфейсы NormalizedAlert, ScoreBreakdown, AlertSource, FuzzyMatcher, LlmClient, ReportExporter. CaseSnapshot/InvestigationOutcome здесь нет.
- `src/lib/server/db/schema.ts`: общие Drizzle row types (`$inferSelect`/`$inferInsert`). UI-модели сейчас связаны со схемой БД.
- `src/lib/server/cases/queries.ts`: CaseListItem, CaseDetailView, AffectedCustomer, ActionDraftView; функции `getCasesView`, `getCaseDetail`, `getActionDraftsView`.
- `src/routes/cases/+page.server.ts` → `getCasesView`; `src/routes/cases/[id]/+page.server.ts` → `getCaseDetail`, форма `?/completeTask` (taskId, actorName), `?/close` (actorName, closureNote, evidenceReference).
- `src/routes/cases/[id]/+page.svelte` получает generated PageData: caseRecord, alert, match, items, customers, tasks, drafts, timeline, totalStock, completedTasks, actionableTasks, closureEvidence. Кнопка closure вычисляется из checklist, не из серверных причин readiness.
- `src/routes/actions/+page.server.ts` → `getActionDraftsView`, фильтр `?case=...`; формы `?/update` (actionId, actorName, subject, body), `?/approve` (actionId, actorName). Потребитель — `src/routes/actions/+page.svelte`.
- `src/routes/review/+page.server.ts` → `workflow/review.ts`: confirm/reject/requestEvidence с matchId и actorName; requestEvidence также принимает requestedEvidence. View types определены в этом workflow-модуле.
- `src/routes/api/monitor/+server.ts` вызывает мониторинг; `src/routes/api/cases/[id]/export.csv/+server.ts` и `export.pdf/+server.ts` используют существующий exporter. Отдельного HTTP API для нового блока B нет; внутренние функции достаточны.

**Общий контракт в этом этапе не менялся. Для сверки с другом:** владелец migration/schema — Герман; необходимо согласовать единый модуль типов и runtime validation, отдельные identity/scope/knowledge, три разных версии (schema/investigation/case), серверные команды и ошибки, отображение UNKNOWN и новые closure blockers. Текущие enum нельзя молча переименовать: UI, DB CHECK, экспорт и тесты зависят от них. Друг предоставляет фактический формат результата investigation и подключает UI; формат его отсутствующей части не выдуман. Владельца входного monitoring и общих package/lockfile также нужно подтвердить. Сообщения другу не отправлялись.

## Реально выполненные проверки

| Команда / проверка | Результат |
| --- | --- |
| `npm run check` | PASS: 0 errors, 0 warnings |
| `npm test` | PASS: 13 файлов, 50 тестов |
| `npm run build` | PASS; adapter-auto сообщает, что production environment не определён — deployment не проверен |
| `npm run db:migrate` на новой временной БД | PASS |
| `npm run db:seed` дважды, затем повторный `npm run db:migrate` | PASS: 15 products, 7 customers, 8 purchases, 3 alerts, 0 cases при обоих seed; идемпотентность дополнительно проверена database.test.ts |
| `npm run dev -- --host 127.0.0.1 --port 5179 --strictPort` | PASS на изолированной БД, без API key |
| HTTP GET `/dashboard`, `/catalogue`, `/review`, `/cases`, `/actions`, `/onboarding` | Все 200 |

Изолированная БД аудита: `/tmp/verirecall-audit-IdrYTz/recallops.db`. Значения DATABASE_URL и пустые OPENAI_API_KEY/OPENAI_MODEL задавались только для запускаемых процессов. Sandbox первоначально запретил создание Git ref и локальный listener/HTTP-доступ; повтор с разрешённым расширением прав прошёл. Обычная БД не сбрасывалась. Docker, чистый npm install, реальный OpenAI, визуальный браузерный walkthrough и production deployment не проверялись. HTTP 200 не доказывает работу всех клиентских взаимодействий.

Полный существующий серверный demo-flow проходит: demo setup → uncertain review → evidence request → confirm → case (42 units, 3 задачи/черновика) → approve simulated sends → contained → close с note/reference → CSV/PDF. Это тест `src/lib/server/workflow/demo-flow.test.ts`, а не ручной браузерный прогон. LLM fallback/error, экспорт, review и действия проверены существующим набором. Новый сценарий 100=40+20+25+5+10 этим набором не покрыт.

## Как проверить руками

Из корня проекта, в отдельном терминале, создать собственную временную БД:

```bash
audit_dir=$(mktemp -d /tmp/verirecall-manual-XXXXXX)
export DATABASE_URL="$audit_dir/recallops.db"
export OPENAI_API_KEY=''
export OPENAI_MODEL=''
npm run db:migrate
npm run db:seed
npm run dev -- --host 127.0.0.1 --port 5179 --strictPort
```

1. Открыть `http://127.0.0.1:5179/onboarding`, выбрать Use demo data. На Overview доступны high-confidence, uncertain и not-relevant сценарии.
2. Review → uncertain → Request evidence → Confirm с именем. Открывается case; проверить 42 units, три задачи, три черновика и историю. Запрос evidence не является полученным доказательством.
3. Попытка серверного закрытия с pending задачами отклоняется (автоматически проверено тестом); в UI закрытие пока недоступно.
4. Action Drafts → одобрить три имитации; проверить SIMULATED SEND и отсутствие реальной отправки. Текущее автоматическое завершение задач — известное ограничение.
5. Закрыть с note не короче 20 символов и reference не короче 3. Проверить closed, audit, CSV/PDF. Перезапустить сервер с тем же DATABASE_URL и проверить сохранение case вручную.

Не использовать `db:reset` на обычной базе ради аудита. После ручного прогона остановить сервер Ctrl-C.

## Только недостающая работа и первый новый сквозной сценарий

1. После отдельного разрешения этапа 2 сверить с другом минимальный контракт и общие fixtures: BATCH_LOT, UNRESOLVED, расширение партии; явно сохранить неизвестные количества и конфликты.
2. Дополнить существующий persistence версиями, ingestion и историей; дать UI реальный snapshot и конфликт устаревшей записи. Сохранить текущие routes и работающие exports через согласованную адаптацию.
3. Добавить исходные поступления/движения/актуальные ответы и детерминированный exposure без двойного учёта; затем задачи по причинам и coverage без дублей.
4. Разделить approval, request и подтверждённый результат; добавить доверенный demo actor, evidence, актуальность решений, conservative closure и scope revision/reopen.
5. Передать свои fixtures/ожидания в общий evaluation framework друга, соединить с его investigation/UI; simulation №10 отложить.

Первый целевой сценарий: подтверждённые P-17/L-2403 от investigation → сохранённый snapshot → из исходных записей received 100, warehouse 40, transit 20, retailer 25, sold 5, unaccounted 10 → соответствующие задачи и явные причины запрета закрытия → настоящий экран друга. Пока 20 в пути и 10 неизвестны, закрытие запрещено. Дальнейшее расширение на L-2404 должно пересчитать охват и переоткрыть уже закрытое дело с историей; сейчас этот путь отсутствует.

Уже можно переиспользовать и соединять существующие SQLite/repository helpers, review → case, CaseDetailView → UI, audit, draft simulation и exports в границах старого демо. Нельзя выдавать их за готовый версионированный блок B. Выполнение следующих промптов не начато.
