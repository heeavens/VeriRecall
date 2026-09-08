# Этап 6 — testing strategy, architecture и code review

Дата: 2026-09-08. Область проверки ограничена human decisions, closure readiness, CLOSED/reopen, совместимостью persisted CaseSnapshot и их UI-проекцией. Этап 7 не оценивался.

## Testing strategy

План составлен из acceptance criteria этапа до реализации проверок. Основные service tests сначала дали 4/4 ожидаемых падения: отсутствовали pending investigation decisions, REQUEST_CLOSURE возвращал INVALID_INPUT, а trusted decision records не создавались. После реализации проверки не ослаблялись до совпадения с текущим кодом.

| Требование | Уровень | Наблюдаемая проверка |
| --- | --- | --- |
| Trusted actor/role/time и запрет прямого вызова | Service integration | `mode=disabled` → FORBIDDEN; demo decision получает server `demo_operator`, `CASE_MANAGER` и clock time |
| Решение не превращает UNKNOWN в факт | Service integration | APPROVED identity при UNRESOLVED scope оставляет knowledge/scope и stage нерешёнными |
| Approval, request и result разделены | Existing task integration regression | APPROVED → OPEN, REQUESTED → IN_PROGRESS, только ATTACH_RESULT → COMPLETED |
| Консервативная readiness | Contract + service integration | active transit, gaps, conflicts, unknown quantities, containment evidence и blocking tasks запрещают READY/CLOSED |
| Зелёные задачи недостаточны | Service integration | все generated tasks COMPLETED, но ACTIVE_TRANSIT и TRACEABILITY_GAP остаются blockers; close возвращает CLOSURE_BLOCKED |
| Fresh atomic closure | Service integration + SQLite | чужое evidence → EVIDENCE_REQUIRED; stale caseVersion → VERSION_CONFLICT; текущая команда пишет CLOSE_CASE и legacy closed projection |
| Scope expansion и reopen | Service integration | CLOSED + L-2404 → INVESTIGATING, старые decisions STALE, task SUPERSEDED; received=120, один новый hold; repeat без history duplicate |
| Evidence-only update | Service integration | новое containment observation с тем же value оставляет CLOSED/completed и пишет `evidence_updated` |
| Persisted compatibility | Storage integration | stage-5 JSON без новых полей читается через storage upgrader, тогда как публичная schema остаётся strict |
| HTTP/UI/persistence | Manual smoke | настоящий route создаёт CLOSURE_REVIEW, UI закрывает до CLOSED, Cases показывает 0 open, restart сохраняет v9/history |

Фактические результаты после review fixes:

- `npm test`: 106/106 тестов в 20 файлах, PASS.
- Focused `closure + contract + task service`: 24/24, PASS.
- `npm run check`: 0 ошибок, 0 предупреждений.
- `npm run build`: PASS; только штатное сообщение adapter-auto об отсутствии выбранного production target.
- `git diff --check`: PASS.
- Временная БД `/tmp/verirecall-stage6-GPxLsd/demo.db`: migrate/seed PASS; `scripts/demo-closure-ready.ts` через HTTP создал CLOSURE_REVIEW v8; браузерная форма создала CLOSED v9; повторный запуск сервера прочитал CLOSED и 1/1 completed.

Пробелы: нет production auth/evidence resolver, browser automation в репозитории, multi-process race/load test, clean dependency install, Docker/deployment и отдельного mobile walkthrough новых controls. Unit/integration suite и ручной smoke снижают риск регрессий, но зелёный результат не доказывает отсутствие ошибок.

## Architecture

Реализация продолжает существующий SvelteKit-монолит и versioned Case aggregate. Новых сервисов, transport или workflow framework нет. Decisions живут в CaseSnapshot, revisions сохраняют историю, а command ledger обеспечивает повторную доставку. Closure и reopen используют существующую SQLite immediate-транзакцию вместе с legacy status projection.

Новая миграция не нужна: этап 3 уже создал durable snapshot/history/ledger. Чтобы не ослаблять общий контракт ради старых stage-5 строк, compatibility выполняется только в `readCaseSnapshot/getCaseHistory`, перед Zod parse. Значимое решение и альтернативы зафиксированы в `docs/adr/0002-human-decisions-and-closure.md`.

Принятые ограничения: fixed demo actor/role вместо отсутствующего identity provider; JSON decisions ограничивают cross-case analytics; `CONTAINED` не выделяется отдельной остановкой в минимальном пути; residual uncertainty acceptance отсутствует. Эти ограничения отражены в contract/handoff и не маскируются fallback-данными.

## Code review

Проверены production diff и tests по correctness, authorization, evidence ownership, optimistic concurrency, idempotency, transaction boundaries, persistence compatibility, UI error handling и fixture isolation.

Исправлено во время review:

- readiness получил явный blocker для неизвестных received/inTransit/unaccounted вместо возможного исключения на финальной schema parse;
- investigation gaps отделены от exposure gaps, поэтому UI сохраняет точные machine codes без дублирующего blocker;
- после новой material revision старые APPROVED identity/scope/closure decisions становятся STALE; action approval сохраняется только при том же coverage, при расширении scope также становится STALE;
- action commands проверяют записанный approval по coverage и полному sourceRefs, а не только поле `approvalStatus`;
- storage compatibility вынесена на read boundary, чтобы публичная схема не принимала неполный HumanDecision;
- Cases использует versioned stage, поэтому закрытое дело не выглядит открытым из-за legacy projection;
- ручной demo script создаёт проверяемый CLOSURE_REVIEW без автоматического закрытия, чтобы closure можно было проверить через UI.

Critical/high замечаний после исправлений не осталось. Осознанные ограничения для следующей интеграции: доверие к evidence ограничено принадлежностью уже сохранённому demo case; fixed actor/role не является production RBAC; аналитические запросы по decisions читают snapshot JSON; параллельные writers проверены существующим SQLite optimistic concurrency, но межпроцессный нагрузочный сценарий не запускался.
