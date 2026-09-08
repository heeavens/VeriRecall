# Этап 7 — testing strategy, architecture и code review

Дата: 2026-09-08. Область проверки: объединение Investigation/Review UI с versioned Case, миграция общей базы и сквозной domain flow. Этап 8 не оценивался.

## Testing strategy

Проверки построены вокруг границ между ранее раздельными частями, а не вокруг отдельных helper-функций.

| Риск | Наблюдаемая проверка |
| --- | --- |
| Review создаёт только legacy case | После `confirmReviewMatch(..., {mode:'demo'})` настоящий `readCaseSnapshot` возвращает v2/materialRevision 1 |
| Повтор создаёт второй effect | Повтор того же match оставляет 2 history revisions и 1 command ledger row |
| Подтверждение прячет конфликт | Hard EAN conflict остаётся CONFLICTED/UNRESOLVED; missing batch остаётся UNKNOWN с BATCH_MISSING |
| Unknown превращается в zero | До exposure calculation все quantities имеют `value:null` |
| Отключённый demo падает в legacy | `{mode:'disabled'}` отклоняется до case/match writes |
| Общая база не обновляется | База создана/seeded кодом `origin/main`, затем обновлена текущими неизменёнными миграциями |
| REQUESTED ошибочно завершает действие | HOLD после approval/request имеет REQUESTED + IN_PROGRESS |
| UI разрешает раннее закрытие | REQUEST_CLOSURE при transit/gap возвращает CLOSURE_BLOCKED |
| Старое выполнение покрывает новый scope | MFT24 HOLD становится SUPERSEDED/STALE; MFT24+MFT25 создаёт новый pending HOLD 35 ITEM |
| Уже подтверждённый legacy case не подключается | Отдельный regression test обновляет тот же case один раз и различает lifecycleChanged/replay |

Тесты интеграционного bridge были запущены до реализации и дали 3/3 ожидаемых падения. После исправления focused suite даёт 11/11 PASS; полный suite — 111/111 в 21 файле; check и build проходят. Полные команды и результаты зафиксированы в `docs/INTEGRATION_CHECK.md`.

## Architecture

Новый сервис и транспорт не добавлялись. Adapter работает внутри существующего Review transaction и вызывает узкий lifecycle helper, который рассчитан на транзакцию вызывающей стороны. Текущий snapshot/history/ledger остаются одним versioned aggregate; общий browser-safe контракт не менялся.

Публичный Review route обязан явно выбрать lifecycle context. Legacy mode также стал обязательным явным аргументом внутренних вызовов. Это предотвращает случайный fallback. Решение, варианты и последствия записаны в `docs/adr/0003-review-to-versioned-case-bridge.md`.

## Code review

Проверены transaction boundary, повторная доставка, stale/conflicting revision, принадлежность case/alert/product, UNKNOWN/conflict preservation, server actor, UI promises, миграции и legacy boundary.

Исправлено во время review:

- browser Review action переведён с legacy case/tasks на versioned InvestigationOutcome/CaseSnapshot;
- disabled mode больше не выполняет legacy writes;
- выбор legacy/demo mode сделан обязательным в каждом вызове;
- обновление уже подтверждённого legacy case получило отдельный `lifecycleChanged`, поэтому UI не сообщает «already integrated» при первом фактическом подключении;
- versioned review использует фиксированного server-side `demo_operator`, а не доверяет hidden actor field;
- UI больше не обещает готовые containment tasks до расчёта exposure.

Critical/high замечаний после исправлений не осталось. Остаточные риски: нет production identity/evidence provider; bridge mapping предназначен для demo; legacy rows остаются рядом с versioned snapshot; визуальный browser click-through заблокирован locked macOS и заменён реальным HTTP/SSR smoke.
