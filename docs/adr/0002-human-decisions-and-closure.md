# ADR-0002: Human decisions и closure внутри versioned Case aggregate

**Status:** Accepted for stage 6

**Date:** 2026-09-08

**Deciders:** Герман (требования блока B), Codex (реализация и проверка)

## Context

Этап 6 должен хранить проверяемые решения человека, консервативно определять готовность к закрытию, закрывать дело отдельной актуальной командой и повторно открывать его при новых существенных фактах. Проект уже хранит актуальный `CaseSnapshot`, append-only `case_revisions`, command ledger и audit в одном SQLite aggregate. Production identity provider и внешний evidence registry в текущем приложении отсутствуют.

## Decision

Хранить pending и recorded human decisions внутри versioned `CaseSnapshot`; каждую версию сохранять в существующей `case_revisions`. Выполнять решения, task transitions, closure и reopen через существующий `RecallService` и одну SQLite immediate-транзакцию.

Closure readiness вычисляется обычной детерминированной функцией из текущего snapshot. `REQUEST_CLOSURE` повторяет вычисление внутри транзакции, проверяет `expectedCaseVersion` и evidence, затем одновременно сохраняет `CLOSE_CASE`, snapshot/history/audit/ledger и legacy-проекцию `cases.status=closed`. Универсального обхода blockers нет.

В локальном прототипе авторизация представлена явным server context `mode=demo` с фиксированными `demo_operator` и `CASE_MANAGER`. Клиент обязан маркировать действия `demo:true`, но не задаёт actor, роль или время. При отключённом demo context прямой вызов сервиса возвращает FORBIDDEN.

## Рассмотренные варианты

### A. Решения внутри versioned CaseSnapshot

| Критерий | Оценка |
| --- | --- |
| Согласованность | Один aggregate и одна транзакция |
| История | Уже обеспечена `case_revisions` |
| Стоимость | Низкая; новая миграция не нужна |
| Запросы по решениям | Ограничены чтением JSON snapshot/history |

### B. Отдельные нормализованные decision/closure tables

| Критерий | Оценка |
| --- | --- |
| Согласованность | Нужна синхронизация с snapshot |
| История | Потребуется дополнительная versioning-модель |
| Стоимость | Выше из-за миграций и repository mapping |
| Запросы по решениям | Лучше для будущей аналитики |

### C. Внешний workflow/approval service

| Критерий | Оценка |
| --- | --- |
| Согласованность | Появляется распределённая транзакция |
| Стоимость | Высокая для шестидневного MVP |
| Авторизация | Потенциально сильнее после интеграции identity provider |
| Соответствие текущему стеку | Низкое |

## Trade-offs

Вариант A сохраняет один источник правды и позволяет атомарно перепроверить readiness перед CLOSED. Цена — слабая аналитика по отдельным решениям и отсутствие production-grade identity/evidence verification. Эти ограничения видимы в контракте и handoff; demo mode нельзя считать production authorization.

Material change определяется по scope, quantity knowledge/value, issue codes/subjects и required task coverage. Изменение provenance при тех же фактах сохраняет новую history revision без reopen. Это консервативный компромисс: новые факты открывают дело, более свежее подтверждение того же факта сохраняет закрытие.

## Consequences

- HumanDecision сохраняет basis case/material version, coverage, evidence, известные issues, consequence, result, rationale и trusted actor/time.
- KnowledgeStatus не меняется от APPROVED/REJECTED.
- Старые решения и выполненные результаты остаются в истории; применимость проверяется заново по scope/sourceRefs.
- `CLOSURE_REVIEW` означает readiness для отдельного human close, а `CLOSED` всегда ссылается на `CLOSE_CASE` decision.
- Stage-5 JSON дополняется только при чтении storage; публичный контракт остаётся strict.
- Нормализованные decision tables стоит рассмотреть, если появятся cross-case analytics, независимые workers или production audit requirements.

## Action items

1. [x] Реализовать decision, readiness, close и reopen через общий command ledger.
2. [x] Проверить stale version, direct-call denial, blockers, scope expansion и evidence-only update.
3. [x] Передать общий формат и demo limitations следующему разработчику.
4. [ ] Подключить production identity/role provider и evidence registry только отдельным согласованным этапом.
