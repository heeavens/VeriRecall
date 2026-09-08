# ADR-0003: Review подтверждение как вход в versioned Case

**Status:** Accepted for stage 7

**Date:** 2026-09-08

**Deciders:** Герман (интеграционный порядок и ветка), Codex (реализация и проверка)

## Context

После объединения веток Review UI подтверждал catalogue match через старый workflow. Он создавал legacy case, checklist tasks и action drafts, тогда как exposure, Dynamic Task Engine и closure читали отдельный versioned CaseSnapshot. Чистый Git merge не соединял эти две модели, поэтому экран расследования не мог открыть настоящий snapshot блока B.

Общая ветка уже содержит подтверждённое demo-дело. Обычная миграция должна сохранить его и позволить подключить versioned lifecycle без переписывания миграций и истории.

## Decision

Оставить один SvelteKit/SQLite процесс и добавить узкий adapter между `confirmReviewMatch` и существующим Case lifecycle service. Review workflow строит `InvestigationOutcome` из сохранённых alert, catalogue product, match и human review decision. Тот же SQLite transaction сохраняет match/case изменения, lifecycle snapshot, revision, audit и command ledger.

Публичный Review action всегда передаёт явный lifecycle context. При `VERIRECALL_DEMO_MODE=true` он использует versioned путь с фиксированным серверным `demo_operator`; при выключенном режиме операция отклоняется без legacy fallback. Старые внутренние тесты и старые server workflows обязаны явно передавать `{ mode: 'legacy' }`, поэтому случайный новый вызов не выбирает legacy поведение по умолчанию.

Уже подтверждённый однопродуктовый legacy case можно один раз дополнить versioned snapshot. Существующие строки и история сохраняются. Для versioned UI источником текущего состояния становится CaseSnapshot; legacy tasks/drafts не копируются в него и не считаются выполненной работой.

## Рассмотренные варианты

### A. Adapter внутри существующей транзакции

Минимальная новая поверхность, один commit boundary, существующие idempotency и history. Цена — временная совместимость с legacy rows и фиксированный mapping demo investigation.

### B. Отдельный HTTP-вызов после подтверждения Review

Проще разделяет модули, но создаёт частичное состояние: match может быть подтверждён, а CaseSnapshot не создан. Нужны retry/orchestration, которых в текущем монолите нет.

### C. Переписать Review на отдельный новый workflow

Убирает legacy путь сразу, но расширяет объём интеграции и рискует сломать уже работающие Catalogue/Review/exports перед демо.

## Consequences

- Confirm Review → GET snapshot работает через реальную БД без нового транспорта.
- Тот же match id служит idempotency key интеграционного события; повтор не создаёт revisions или case commands.
- Hard identity conflict и неизвестный batch остаются `CONFLICTED`/`UNKNOWN` после человеческого подтверждения.
- Exposure остаётся `NOT_CALCULATED` с `null`, пока не выполнен обычный детерминированный расчёт.
- Старый multi-product case и несовпадающий productId не конвертируются молча.
- Mapping использует только уже сохранённые поля текущего demo workflow. Для production нужен согласованный InvestigationOutcome producer, identity provider и проверяемый evidence registry.

## Action items

1. [x] Соединить Review confirm и versioned Case одной транзакцией.
2. [x] Проверить новый и уже подтверждённый legacy case, повтор, конфликт и disabled mode.
3. [x] Проверить action/evidence/closure/scope expansion от snapshot, полученного из Review.
4. [ ] Заменить demo mapping на согласованный production InvestigationOutcome producer отдельным этапом.
