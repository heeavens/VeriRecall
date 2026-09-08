# Этап 5 — testing strategy и code review

Дата проверки: 2026-09-08. Область проверки ограничена Dynamic Task Engine, task-командами, их проекцией в CaseSnapshot и UI. Следующий этап не оценивался.

## Testing strategy

Цель — проверять наблюдаемое бизнес-поведение на разных границах, а не повторять внутренние ветвления реализации.

| Область | Тип | Цель покрытия | Реальные сценарии |
| --- | --- | --- | --- |
| Пять правил и reconciliation | Unit | Каждое правило имеет положительный пример; idempotency и снятие trigger проверены отдельно | HOLD, INTERCEPT, retailer UNKNOWN, traceability gap, sold communication; группировка доставок; сохранение completed; SUPERSEDED; обновление provenance |
| Versioned service и SQLite | Integration | Все три task-перехода, optimistic concurrency, ledger и history | approval ≠ request ≠ result; replay; stale/foreign task; устранение причины; расширение scope; неизменный coverage |
| Общий Zod-контракт | Contract | Strict envelope и несовместимые состояния отклоняются | type/rule mapping, COMPLETED без evidence, approval/decision linkage, closure с blocking task |
| Cases projection | Integration | Versioned дела используют настоящие task counts | 0/4 после расчёта, три pending approval, ожидаемый next action |
| HTTP и Svelte UI | Ручной smoke | Клиент проходит настоящий серверный путь | HOLD_STOCK: BLOCKED → OPEN → IN_PROGRESS → COMPLETED; gap остаётся; данные читаются после перезапуска |

Полный результат: `npm test` — 99/99 в 19 файлах; `npm run check` — 0 ошибок и предупреждений; `npm run build` — PASS. Один новый regression test сначала упал, когда сортировка поставила INTERCEPT перед HOLD в Cases; исправлен порядок правил, ожидание теста не ослаблялось.

Пробелы: новые task-controls отдельно не проходились на мобильном viewport; нет browser automation в репозитории, межпроцессного load test, production auth, внешних интеграций и resolver-а подлинности evidence. Эти проверки не входят в завершённый demo-only этап 5.

## Code review

Проверены security, correctness, concurrency, производительность и сопровождаемость полного diff этапа.

Исправленные замечания:

- несколько неизвестных доставок одному retailer теперь создают одну задачу;
- новая investigation revision с тем же coverage сохраняет применимое approval, но блокирует действия до пересчёта exposure;
- pending decision и task проверяются как двусторонне связанные;
- порядок правил и sourceRefs стал детерминированным;
- при новом источнике того же количества обновляются quantity provenance и pending decision basis без дублирования задачи;
- Cases показывает настоящие versioned task counts и следующий blocking action;
- контракт отклоняет несовпадающие task type/rule и readiness при незавершённой blocking task.

Новых critical/high замечаний после исправлений не осталось. Для локального demo этап одобрен. Ограничения production-пути остаются явными: фиксированный demo actor, непроверенные evidence refs, отсутствие реальных внешних действий и недоступный closure/reopen.

Архитектурное решение: [ADR-0001](adr/0001-dynamic-task-engine-in-case-snapshot.md).
