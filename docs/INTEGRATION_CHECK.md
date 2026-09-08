# Проверка интеграции этапа 7

Дата проверки: 2026-09-08. Готовая ветка: `herman_dev`.

## Исходные refs и Git

- Общий предок рабочих линий: `96c2120`.
- Состояние Германа до интеграции: `origin/herman_dev` → `79f06e3` (`feat(case): add human decisions and closure`).
- Доступная ветка второго разработчика: `origin/mykyta_dev` → `b5f9c89`.
- На момент fetch `origin/main` также указывал на `b5f9c89`; дерево `origin/mykyta_dev` совпадало с ним.
- Merge в `herman_dev`: `0ce7452`, родители `79f06e3` и `b5f9c89`.

По прямому указанию Германа отдельная integration-ветка не создавалась: интеграционный merge и исправления выполняются в существующей `herman_dev`. `main`, remote development refs и их история не переписывались; force push не использовался.

## Что фактически соединено

Git merge не имел текстовых конфликтов, но функциональная проверка обнаружила разрыв: Review UI вызывал legacy `confirmReviewMatch`, а versioned state/exposure/tasks/closure оставались доступны только отдельными API и demo scripts.

Исправление добавляет реальный путь:

```text
Review UI/server action
  → persisted alert + catalogue match + human confirmation
  → InvestigationOutcome
  → versioned CaseSnapshot + revision + command ledger
  → /api/cases/{id}/snapshot and /cases/{id}
```

Запись выполняется одной SQLite-транзакцией. Повтор использует match id как стабильный event/command id и не дублирует effect. Уже подтверждённое legacy-дело из общей базы получает versioned snapshot один раз; старые строки не удаляются. Неизвестный batch и hard identifier conflict остаются видимыми, exposure до расчёта содержит `null`, а не ноль.

Один общий контракт по-прежнему импортируется из `$lib/contracts/recall`. Копий types, нового транспорта, миграций, зависимостей и изменений lockfile в этапе 7 нет. Архитектурная граница описана в `docs/adr/0003-review-to-versioned-case-bridge.md`.

## Реально выполненные проверки

| Проверка | Результат |
| --- | --- |
| `npm test` | 111/111, 21 test file, PASS |
| Focused Review → lifecycle suite | 11/11 PASS |
| `npm run check` | 0 ошибок, 0 предупреждений |
| `npm run build` | PASS; только штатное сообщение adapter-auto об отсутствии production target |
| Migration от `origin/main` | PASS: база создана и seeded кодом `b5f9c89`, затем `0002`/`0003` применены текущей веткой; legacy case сохранён |
| Реальный SvelteKit POST `review?/confirm` | PASS на обновлённой общей БД без client actorName; создан CaseSnapshot v2/materialRevision 1, audit actor=`demo_operator` |
| Реальный snapshot GET | PASS; `INVESTIGATING`, scope `MFT24`, exposure `NOT_CALCULATED`, quantities `null`, pending identity/scope decisions |
| Server-rendered `/cases/{id}` | PASS; HTML содержит `CASE-0001`, `INVESTIGATING`, `MFT24`, `UNKNOWN` и blocker exposure |
| Повтор реального Review POST | PASS; ответ `already integrated`, в БД по-прежнему 1 lifecycle row, 2 revisions и 1 command |
| Полный action/evidence/closure/scope сценарий | PASS в integration test: REQUESTED остаётся IN_PROGRESS, раннее закрытие получает CLOSURE_BLOCKED, result требует evidence, scope expansion supersedes старый HOLD/approval и создаёт HOLD для 35 ITEM по MFT24+MFT25 |

Интеграционный тест сначала был добавлен против старого поведения и дал 3/3 ожидаемых падения: versioned flag/snapshot отсутствовали, disabled mode молча выполнял legacy writes. Проверки не удалялись и не ослаблялись после реализации.

## Запуск

```bash
npm install
stage7_dir="$(mktemp -d /tmp/verirecall-stage7-XXXXXX)"
export DATABASE_URL="$stage7_dir/demo.db"
export VERIRECALL_DEMO_MODE=true
npm run db:migrate
npm run db:seed
npm run dev -- --host 127.0.0.1 --port 5187
```

Открой `/review`, выбери candidate и нажми **Confirm match** → **Confirm and open case**. По ссылке **Open case** настоящий snapshot должен показать `INVESTIGATING`; exposure остаётся неизвестным до `CALCULATE_EXPOSURE`.

Автоматизированная domain-проверка полного соединения:

```bash
npm test -- src/lib/server/integration/review-lifecycle.test.ts
npm test
npm run check
npm run build
git diff --check
```

## Оставшиеся ограничения

- macOS была заблокирована при попытке browser automation, поэтому визуальный click-through не выполнен. Реальные form action, snapshot API и server-rendered case page проверены по HTTP на одном dev-server и одной migrated DB.
- Review → InvestigationOutcome сейчас является явным demo mapping из persisted alert/catalogue/match. Live AI producer и production evidence verification отсутствуют.
- Фиксированный `demo_operator` — только локальная boundary, не production identity/RBAC.
- Legacy rows сохраняются для совместимости, но versioned Case UI не должен использовать их как источник task/closure state.
- Новая стадия после этапа 7 не начиналась.
