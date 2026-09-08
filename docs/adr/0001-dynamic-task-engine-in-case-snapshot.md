# ADR-0001: Dynamic Task Engine внутри versioned Case lifecycle

**Status:** Accepted for stage 5

**Date:** 2026-09-08

**Deciders:** Герман (требования блока B), Codex (реализация и проверка)

## Context

За шесть дней нужен минимальный движок пяти правил поверх уже сохранённых CaseSnapshot и traceability records. Повторный расчёт обязан быть идемпотентным, история — переживать перезапуск, а scope revision — пересматривать coverage и approval. Проект уже является SvelteKit-монолитом с SQLite, transaction ledger и append-only case revisions. Требование этапа прямо исключает отдельный workflow-конструктор.

## Decision

Использовать чистый детерминированный модуль `src/lib/server/tasks/engine.ts`, вызываемый существующим Case lifecycle service. Текущее состояние задач хранится в CaseSnapshot, а все существенные версии — в существующей `case_revisions`. DECIDE_ACTION, REQUEST_ACTION и ATTACH_RESULT проходят через общий command ledger и одну SQLite-транзакцию со snapshot/history/audit.

## Options Considered

### A. Задачи в CaseSnapshot и case revisions

| Dimension | Assessment |
| --- | --- |
| Complexity | Low |
| Delivery cost | Low; новая миграция не нужна |
| Consistency | High внутри существующей aggregate transaction |
| Query flexibility | Достаточна для MVP, ограничена для аналитики |
| Team familiarity | High; повторяет этапы 3–4 |

Плюсы: один источник versioned state, атомарная история, минимум нового кода. Минусы: выборки по отдельным задачам требуют чтения snapshot; JSON будет неудобен при росте объёма.

### B. Нормализованные versioned task/decision tables

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium |
| Delivery cost | Medium; миграции и repository layer |
| Consistency | Требует согласования нескольких проекций |
| Query flexibility | High |
| Team familiarity | Medium |

Плюсы: удобны отчёты и индексы. Минусы: дублирует snapshot state и увеличивает риск рассинхронизации в срок хакатона.

### C. Workflow engine или отдельный service

| Dimension | Assessment |
| --- | --- |
| Complexity | High |
| Delivery cost | High |
| Consistency | Появляется распределённая граница |
| Query flexibility | High |
| Team familiarity | Low |

Плюсы: подходит для долгих сложных процессов. Минусы: новый стек, транспорт и operational burden без потребности текущих пяти правил.

## Trade-off Analysis

Вариант A лучше соответствует сроку, текущему aggregate и требованию не строить workflow-конструктор. Ограничения JSON-поиска приемлемы, пока UI получает задачи через один CaseSnapshot. При появлении большого реестра задач или независимых workers решение нужно пересмотреть.

## Consequences

- Reconciliation можно проверять быстрыми unit-тестами без БД.
- Snapshot, history, audit и command ledger сохраняются атомарно существующими средствами.
- Legacy `case_tasks/action_drafts` остаются только для старых дел и не становятся вторым источником versioned state.
- Аналитика по задачам и конкурентная обработка отдельных task rows пока ограничены.
- Contract task shape является общим изменением и должен быть синхронно принят следующим разработчиком через `$lib/contracts/recall`.

## Action Items

1. [x] Реализовать пять правил и reconciliation в монолите.
2. [x] Провести task-команды через существующий ledger/transaction path.
3. [x] Документировать общий contract и handoff.
4. [ ] Пересмотреть отдельные таблицы только при доказанной потребности аналитики, workers или роста snapshot.
