# VeriRecall — состояние блока B

Дата: 2026-09-08. **Этап 6 завершён: human decisions, консервативная closure readiness, атомарное закрытие и повторное открытие работают через versioned Case.** Этап 7 не начат. Герман продолжает блок самостоятельно; друг подключается позже по `docs/HANDOFF_TO_FRIEND.md`.

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

## Архитектура и БД

Проект остаётся SvelteKit 2 / Svelte 5 / TypeScript / SQLite / Drizzle / Zod / Vitest монолитом. Нового транспорта, workflow framework или микросервиса нет.

Миграции этапов блока B:

- `0002_case_lifecycle.sql`: case lifecycle, revisions и command ledger.
- `0003_traceability_exposure.sql`: append-only traceability records и несколько case revisions на materialRevision.
- Этапы 5–6 используют существующий versioned aggregate; новых миграций им не требуется. Persisted stage-5 JSON дополняется новыми decision fields только на storage read boundary, публичный контракт остаётся strict.

Значимые решения: `docs/adr/0001-dynamic-task-engine-in-case-snapshot.md` и `docs/adr/0002-human-decisions-and-closure.md`.

## Проверки этапа 6

- `npm test`: 106/106, 20 файлов, PASS.
- `npm run check`: 0 ошибок и предупреждений.
- `npm run build`: PASS; adapter-auto сообщает, что production target не выбран.
- `git diff --check`: PASS.
- Focused decisions/closure/task/contract: 24/24, PASS.
- Новые service integration tests: direct-call denial, trusted server actor/time, UNKNOWN после human confirmation, REQUESTED ≠ COMPLETED, blockers при зелёных tasks, stale/current closure, scope expansion/reopen без дублей, evidence-only update и stage-5 JSON compatibility.
- Реальный HTTP/UI прогон на `/tmp/verirecall-stage6-GPxLsd/demo.db`: case дошёл до CLOSURE_REVIEW v8, через UI записан CLOSE_CASE и CLOSED v9; Cases показал 0 open и 1/1 completed. После restart на той же БД CLOSED сохранился.

Тесты не доказывают отсутствие дефектов. Полная стратегия, review findings и пробелы: `docs/STAGE_6_QUALITY.md`.

## Как проверить руками

```bash
stage6_dir="$(mktemp -d /tmp/verirecall-stage6-XXXXXX)"
export DATABASE_URL="$stage6_dir/demo.db"
export VERIRECALL_DEMO_MODE=true
npm run db:migrate
npm run db:seed
npm run dev -- --host 127.0.0.1 --port 5186
```

Во втором терминале:

```bash
VERIRECALL_BASE_URL=http://127.0.0.1:5186 \
  node --import tsx scripts/demo-closure-ready.ts
```

Открой напечатанный `caseUrl`, проверь CLOSURE_REVIEW, reviews, HOLD_STOCK COMPLETED и required result evidence. Заполни rationale и нажми **Confirm closure for this version**. Проверь CLOSED на detail и Cases, затем перезапусти сервер с тем же DATABASE_URL.

## Изменения общего формата для сверки с другом

- Импортировать только `$lib/contracts/recall`; не копировать интерфейсы.
- CaseSnapshot теперь обязательно содержит `decisions`, а HumanDecision — `uncertaintyRefs`, `conflictRefs`, `consequence` и `actorRole` вместе с прежним basis/evidence/rationale.
- DECIDE_INVESTIGATION добавлена; DECIDE_ACTION и REQUEST_CLOSURE требуют полный evidence basis и `demo:true`.
- UI должен различать PENDING и recorded decisions, RESPONDING/CLOSURE_REVIEW/CLOSED, stale approvals, null quantities и машинные closure blockers.
- Рабочие HTTP/TypeScript примеры находятся в `docs/HANDOFF_TO_FRIEND.md`; полный формат — в `docs/INTEGRATION_CONTRACT.md`.

## Ограничения и следующая работа

- Есть только fixed demo operator/role. Production identity, authorization policy и внешний evidence resolver отсутствуют; demo-path нельзя публиковать как защищённый многопользовательский API.
- Acceptance некритической residual uncertainty не реализован, поэтому обхода blockers нет.
- `CONTAINED` присутствует в контракте; текущий минимальный путь переходит сразу в CLOSURE_REVIEW, когда containment и остальные readiness conditions выполнены одновременно.
- Legacy cases/tasks/drafts/export продолжают работать отдельно. Versioned case относится к одному product; автоматической multi-product/legacy конвертации нет.
- Реальные письма, POS/ERP/inventory/shipment actions не выполняются. Live AI, Docker, production deployment, clean dependency install, multi-process load и mobile walkthrough новых stage-6 controls не проверялись.
- Readiness/simulation остаётся после основного demo. Этап 7 можно начинать только по отдельному указанию Германа.

Ветка: `herman_dev`. Пользовательский untracked `VERIRECALL_6_DAY_CODEX_PLAN.md` не изменяется и не включается в коммиты.
