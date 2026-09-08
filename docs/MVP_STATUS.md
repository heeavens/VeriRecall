# VeriRecall — состояние блока B

Дата: 2026-09-08. **Этап 7 завершён в `herman_dev`: Review/Investigation UI соединён с versioned Case, общая база мигрируется, сквозной domain flow проверен.** Этап 8 не начат. Герман продолжает блок самостоятельно; друг подключается позже по `docs/HANDOFF_TO_FRIEND.md`.

## Что работает

- Один browser-safe Zod/TypeScript контракт в `src/lib/contracts/recall.ts`: InvestigationOutcome, CaseSnapshot, TraceabilityRecord, DynamicTask, HumanDecision, команды и типизированные ошибки. UNKNOWN отличается от нуля, а knowledge/task/decision statuses разделены.
- SQLite хранит актуальный versioned Case, append-only revisions, command ledger и traceability records. Reservation, ingestion, snapshot GET и все мутации проходят через реальные server routes. Snapshot/history переживают новое подключение и перезапуск.
- Exposure детерминированно считает received, warehouse, inTransit, retailer, sold, unaccounted и contained из persisted sources с provenance/as-of. Чужие партии не попадают в текущий scope; дубли и конфликтующие sourceRef отклоняются.
- Dynamic Task Engine создаёт HOLD_STOCK, INTERCEPT_SHIPMENT, REQUEST_RETAILER_CONFIRMATION, INVESTIGATE_TRACEABILITY_GAP и PREPARE_COMMUNICATION. Повторный расчёт не дублирует задачи и не сбрасывает completed work; изменившийся coverage создаёт новую работу, а старую помечает SUPERSEDED.
- Approval действия, запись demo request и подтверждение результата разделены. APPROVED/REQUESTED не равны COMPLETED; результат требует отдельного evidence. Drafts ссылаются на основания и явно сообщают, что внешнее действие не выполнено.
- Identity/scope/action/closure decisions сохраняют subject, coverage, версии основания, evidence, известные issues, consequence, result, rationale и server actor/role/time. Клиент не задаёт actor или время. Подтверждение человека не меняет factual UNKNOWN/CONFLICTED/UNRESOLVED.
- Readiness блокируют неактуальные reviews, неизвестные критические количества, active transit, gaps/conflicts, недоказанное containment и незавершённые blocking tasks. Полностью зелёный список задач сам по себе не разрешает закрытие.
- `REQUEST_CLOSURE` повторно проверяет readiness и caseVersion внутри SQLite immediate-транзакции, валидирует evidence и одновременно пишет CLOSE_CASE decision, snapshot/history/audit/ledger и legacy closed-проекцию.
- Новая materialRevision или materially изменившийся exposure после CLOSED открывают дело. Старые решения/results/history сохраняются; утратившие применимость approvals становятся STALE. Evidence-only update с теми же фактами сохраняет CLOSED и completed work.
- UI case detail показывает настоящий stage, exposure, blockers, tasks, pending reviews, recorded decisions и отдельную closure form. Реестр Cases показывает versioned stage и актуальные task counts.
- Review confirm теперь строит InvestigationOutcome из сохранённых alert/catalogue/match и атомарно создаёт или обновляет versioned CaseSnapshot. Чистый producer вынесен в `src/lib/server/investigation/outcome-producer.ts`, валидирует результат общей `investigationOutcomeSchema` и не обращается к БД, LLM, exposure или task engine. Identity становится KNOWN/MATCH только при совпадении двух непустых persisted EAN после общей нормализации; missing EAN остаётся UNKNOWN/UNRESOLVED даже после human Review decision, а hard conflict остаётся CONFLICTED. Повтор не дублирует effect; уже подтверждённое legacy-дело из общей базы подключается один раз. Неизвестный scope также не исчезает.
- Для versioned cases единственный источник scope — `InvestigationOutcome` в `CaseSnapshot`. Versioned Review не создаёт compatibility `case_items`, а `getCaseDetail` не вычисляет legacy affected customers из `case_items`, даже если upgraded case уже содержит историческую строку с batch `Unknown`. Исторические строки не удаляются; sentinel и его wildcard-поведение сохранены только для genuinely legacy cases.
- Публичный Review route требует явный локальный demo mode и использует фиксированного server-side `demo_operator`. Отключённый режим отклоняет операцию без legacy fallback.
- Локальный demo catalogue содержит 15 синтетических товаров Costa Coffee и три явно демонстрационных кофейных предупреждения. Названия, категории, поставщики и изображения согласованы; это не реальные отзывы бренда.
- Versioned case UI ведёт пользователя по четырём шагам: product match, human review, affected stock, actions/closure. Главная карточка показывает следующее действие; review содержит чек-лист и пример комментария, а версии, machine fields и audit history убраны в раскрываемый технический блок.
- После подтверждения identity/scope case UI может явно загрузить однопартийный synthetic demo-набор на 100 единиц через настоящий `CALCULATE_EXPOSURE`. После завершения `HOLD_STOCK` отдельная кнопка записывает demo containment evidence и повторно считает snapshot; завершение задачи само по себе containment не доказывает. Это локальный demo-путь, а не production-импорт ERP/POS.

## Архитектура и БД

Проект остаётся SvelteKit 2 / Svelte 5 / TypeScript / SQLite / Drizzle / Zod / Vitest монолитом. Нового транспорта, workflow framework или микросервиса нет.

Миграции этапов блока B:

- `0002_case_lifecycle.sql`: case lifecycle, revisions и command ledger.
- `0003_traceability_exposure.sql`: append-only traceability records и несколько case revisions на materialRevision.
- Этапы 5–6 используют существующий versioned aggregate; новых миграций им не требуется. Persisted stage-5 JSON дополняется новыми decision fields только на storage read boundary, публичный контракт остаётся strict.

Значимые решения: `docs/adr/0001-dynamic-task-engine-in-case-snapshot.md`, `docs/adr/0002-human-decisions-and-closure.md` и `docs/adr/0003-review-to-versioned-case-bridge.md`.

## Проверки этапа 7

- Focused Review → lifecycle suite: 11/11, PASS.
- Общая база создана и seeded кодом `origin/main@b5f9c89`, затем текущие `0002`/`0003` применены без изменения старых миграций; legacy case сохранён.
- Реальный SvelteKit form POST создал versioned snapshot v2/materialRevision 1 на этой базе; snapshot GET и server-rendered case page прочитали то же состояние.
- Сквозной test проходит Review → CaseSnapshot → exposure → action approval/request/result → запрет раннего close → scope expansion и новый task coverage.
- `npm test`: 111/111 в 21 test file, PASS; `npm run check`: 0 ошибок/предупреждений; `npm run build`: PASS с обычным сообщением adapter-auto об отсутствии production target. Точные результаты находятся в `docs/INTEGRATION_CHECK.md`.
- После Mykyta identity-semantics correction: focused producer/matching/Review/lifecycle suite — 34/34 PASS; `npm.cmd test` — 127/127 в 22 test files; `npm.cmd run check` — 0 ошибок/предупреждений; `npm.cmd run build` и `git diff --check` — PASS. Adapter-auto по-прежнему сообщает об отсутствии выбранного production target.
- После Mykyta legacy-scope isolation: versioned Review не пишет `case_items`, upgraded lifecycle cases игнорируют retained legacy `Unknown` при customer projection, а pure legacy wildcard regression остаётся зафиксированным тестом. Focused Review/lifecycle/legacy case suite — 20/20 PASS; `npm.cmd test` — 130/130 в 22 test files; `npm.cmd run check`, `npm.cmd run build` и `git diff --check` — PASS. Adapter-auto по-прежнему сообщает об отсутствии выбранного production target.

Тесты не доказывают отсутствие дефектов. Стратегия, review findings и пробелы: `docs/STAGE_7_QUALITY.md`; Git refs и сквозная проверка: `docs/INTEGRATION_CHECK.md`.

## Как проверить руками

```bash
stage7_dir="$(mktemp -d /tmp/verirecall-stage7-XXXXXX)"
export DATABASE_URL="$stage7_dir/demo.db"
export VERIRECALL_DEMO_MODE=true
npm run db:migrate
npm run db:seed
npm run dev -- --host 127.0.0.1 --port 5187
```

Открой `/review`, подтверди candidate и перейди по **Open case**. Подтверди product и batch, нажми **Load demo stock records**, проведи появившийся `HOLD_STOCK` через approval → demo request → result evidence, затем нажми **Record 100 contained items** и выполни отдельное закрытие. Полный автоматический сценарий запускается командой `npm test -- src/lib/server/integration/review-lifecycle.test.ts`.

## Изменения общего формата для сверки с другом

- Импортировать только `$lib/contracts/recall`; не копировать интерфейсы.
- Review UI уже подключён: его confirm action создаёт versioned snapshot через `produceInvestigationOutcome`. Human decision ref сохраняется независимо от identity KnowledgeStatus; следующие investigation rules нужно добавлять в этот producer boundary, сохраняя форму `InvestigationOutcome` и не возвращая legacy tasks как текущее состояние.
- CaseSnapshot теперь обязательно содержит `decisions`, а HumanDecision — `uncertaintyRefs`, `conflictRefs`, `consequence` и `actorRole` вместе с прежним basis/evidence/rationale.
- DECIDE_INVESTIGATION добавлена; DECIDE_ACTION и REQUEST_CLOSURE требуют полный evidence basis и `demo:true`.
- UI должен различать PENDING и recorded decisions, RESPONDING/CLOSURE_REVIEW/CLOSED, stale approvals, null quantities и машинные closure blockers.
- Рабочие HTTP/TypeScript примеры находятся в `docs/HANDOFF_TO_FRIEND.md`; полный формат — в `docs/INTEGRATION_CONTRACT.md`.

## Ограничения и следующая работа

- Есть только fixed demo operator/role. Production identity, authorization policy и внешний evidence resolver отсутствуют; demo-path нельзя публиковать как защищённый многопользовательский API.
- Acceptance некритической residual uncertainty не реализован, поэтому обхода blockers нет.
- `CONTAINED` присутствует в контракте; текущий минимальный путь переходит сразу в CLOSURE_REVIEW, когда containment и остальные readiness conditions выполнены одновременно.
- Legacy cases/tasks/drafts/export продолжают работать отдельно. Уже подтверждённое однопродуктовое legacy case может быть дополнено versioned snapshot через Review bridge; его исторические `case_items` сохраняются, но больше не определяют versioned scope или affected customers. Несовпадающий product и multi-product conversion не допускаются молча.
- Реальные письма, POS/ERP/inventory/shipment actions не выполняются. Live AI, Docker, production deployment, clean dependency install, multi-process load и mobile walkthrough новых stage-6 controls не проверялись.
- Визуальный browser automation этапа 7 не выполнен из-за заблокированного macOS; реальные form POST, API GET и SSR HTML проверены на dev-server.
- Readiness/simulation остаётся после основного demo. Этап 8 можно начинать только по отдельному указанию Германа.

Ветка: `herman_dev`. Пользовательский untracked `VERIRECALL_6_DAY_CODEX_PLAN.md` не изменяется и не включается в коммиты.

## Mykyta Investigation Engine — Commit 4 provenance foundation

- Migration `0004_last_thunderbolt.sql` adds `investigation_evidence`, the durable investigation-evidence provenance registry. It owns stable evidence refs, case/question linkage, optional legacy evidence-request linkage, source identity, receipt/as-of timing, immutable structured content or an external locator, a SHA-256 integrity hash, and the explicit demo marker.
- `recordInvestigationEvidence` is append-only at the service boundary. An exact immutable replay returns the existing record; reuse of an evidence ref with changed content or provenance is rejected. `getInvestigationEvidence` resolves only through the owning case.
- Evidence receipt does **not** establish a fact. Recording evidence does not change `InvestigationOutcome`, material revision, `CaseSnapshot`, gaps, decisions, tasks, exposure, or closure state.
- `InvestigationOutcome` and `HumanDecision` still reference evidence through opaque strings. The registry is not wired into Review, supplier requests/responses, ingestion, monitoring, or the UI yet.
- Claim extraction/assessment, KnowledgeGap resolution, supplier receipt handling, and AI integration remain unimplemented. AI output is intentionally not a raw-evidence `sourceKind`; later AI extraction must remain a derived/proposed claim.
- Verified with the focused registry/database/lifecycle suites (28 tests), the full suite (142 tests in 23 files), `npm.cmd run check` (0 errors/warnings), `npm.cmd run build`, clean and repeat `db:migrate` runs, the populated-`0001` migration compatibility test, and `git diff --check`. Green checks reduce known risk but do not prove the absence of defects.
