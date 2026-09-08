# Передача блока B следующему разработчику

Актуально после этапа 7, 2026-09-08. Герман реализовал versioned Case, exposure, Dynamic Task Engine, human decisions, closure/reopen и подключил существующий Review UI к этому пути. Друг подключается позже и должен использовать единый контракт и настоящий snapshot, не создавать копию типов или параллельное состояние дела.

Текущие demo fixtures приведены к единой кофейной теме: 15 синтетических товаров Costa Coffee и три synthetic alerts. Идентификаторы, количества и lifecycle-сценарии сохранены. Эти названия нужны для понятного локального показа и не описывают реальные отзывы Costa Coffee.

`InvestigationSnapshot.svelte` теперь является пошаговым пользовательским экраном. Новые UI-состояния должны продолжать браться только из `CaseSnapshot`: не добавляй отдельный client workflow state. Технические version/revision, полный decision log и raw JSON доступны в раскрываемом audit-блоке, но не являются основным пользовательским сценарием.

Для ручного локального показа после current identity/scope approvals экран явно предлагает однопартийный synthetic demo-набор на 100 единиц. Он отправляется существующей командой `CALCULATE_EXPOSURE`; отдельный containment record доступен только после `COMPLETED` demo `HOLD_STOCK`. Не переносить эти browser-generated demo records в production import и не считать task result заменой traceability evidence.

## Что импортировать

Browser-safe источник типов и runtime-валидации один:

```ts
import {
  caseSnapshotSchema,
  commandResultSchema,
  investigationOutcomeSchema,
  recallCommandSchema,
  snapshotResultSchema,
  type CaseSnapshot,
  type InvestigationOutcome,
  type RecallCommand
} from '$lib/contracts/recall';
```

Серверная реализация находится в `src/lib/server/workflow/case-lifecycle.ts`. UI вызывает HTTP routes, не импортирует серверный сервис и не пишет в БД. Fixtures из `src/lib/contracts/recall.fixtures.ts` разрешены только в тестах и явных demo-скриптах.

## Реальные routes

| Route | Вход / выход |
| --- | --- |
| POST `/api/cases/investigation` | `{ alertId, productId }` → `SnapshotResult`; идемпотентная reservation |
| POST `/api/cases/{id}/commands` | `RecallCommand` → `CommandResult` |
| GET `/api/cases/{id}/snapshot` | `SnapshotResult`, `Cache-Control: no-store` |
| `/cases/{id}` | Настоящий `CaseSnapshot` и сохранённая история |
| POST `/review?/confirm` | Существующая SvelteKit form action; в demo mode подтверждает match и атомарно создаёт/обновляет versioned snapshot |

POST требует JSON и same-origin `Origin`. Локальный путь включается только с `VERIRECALL_DEMO_MODE=true`; actor и роль берутся из доверенного server context: `demo_operator` / `CASE_MANAGER`. Клиент не передаёт actor/time. Все human/action/evidence команды содержат `demo:true`, а evidence refs имеют явный префикс `demo:`. Это фиксированный хакатонный режим, не production auth.

Review form использует обычный form content type, но его versioned confirm также требует `VERIRECALL_DEMO_MODE=true`; actor для этой операции задаётся сервером. При disabled mode сервер возвращает 409 и не выполняет legacy fallback. Confirm делегирует чистому `produceInvestigationOutcome` в `src/lib/server/investigation/outcome-producer.ts`, который строит и валидирует начальный InvestigationOutcome только из явно переданных persisted alert/catalogue/match полей и ссылок. Hard EAN conflict остаётся CONFLICTED, missing batch — UNKNOWN/UNRESOLVED, exposure — NOT_CALCULATED/null.

Поддерживаемые команды:

- `ACCEPT_INVESTIGATION`
- `CALCULATE_EXPOSURE`
- `DECIDE_INVESTIGATION`
- `DECIDE_ACTION`
- `REQUEST_ACTION`
- `ATTACH_RESULT`
- `REQUEST_CLOSURE`

Каждая мутация использует новый UUID `commandId` и текущий `expectedCaseVersion`. Точный повтор сохраняет исходный effect, тот же id с другим payload даёт `IDEMPOTENCY_CONFLICT`, устаревшая версия — `VERSION_CONFLICT`. `schemaVersion`, `materialRevision` и `caseVersion` независимы.

## Пример producer и UI

```ts
const outcome = investigationOutcomeSchema.parse(aiOrInvestigationPayload);
const accepted = commandResultSchema.parse(await post(`/api/cases/${outcome.caseId}/commands`, {
  type: 'ACCEPT_INVESTIGATION', schemaVersion: 1,
  caseId: outcome.caseId, commandId: crypto.randomUUID(),
  expectedCaseVersion: current.caseVersion, outcome
}));

if (!accepted.ok) throw new Error(accepted.error.message);
renderCase(caseSnapshotSchema.parse(accepted.snapshot));
```

UI должен всегда перерисовываться из возвращённого snapshot. Значение `null` вместе с knowledgeStatus нельзя показывать как ноль. `pendingDecisions` содержит только ожидающие решения, `decisions` — сохранённые APPROVED/REJECTED/STALE. KnowledgeStatus, task status и decision status нельзя объединять.

Для решения investigation UI отправляет полный evidence basis pending decision:

```ts
const pending = snapshot.pendingDecisions.find((item) => item.type === 'CONFIRM_SCOPE');
if (!pending) throw new Error('No scope decision is pending.');

const command: RecallCommand = {
  type: 'DECIDE_INVESTIGATION', schemaVersion: 1,
  caseId: snapshot.caseId, commandId: crypto.randomUUID(),
  expectedCaseVersion: snapshot.caseVersion,
  decisionId: pending.id, decision: 'APPROVED',
  rationale: 'Reviewed the listed scope evidence.',
  evidenceRefs: pending.evidenceRefs, demo: true
};
```

Approval действия, запись запроса и результат — три разных команды. `APPROVED` открывает действие, `REQUESTED` переводит его в `IN_PROGRESS`, `ATTACH_RESULT` с evidence завершает. Никакие письма, inventory/POS или shipment API не вызываются.

`closure.status=READY_FOR_HUMAN_CLOSURE` означает, что серверные проверки прошли для текущей версии. UI всё равно требует отдельный `REQUEST_CLOSURE` с rationale и evidence результата всех completed blocking tasks. Сервер повторяет readiness внутри транзакции. `CLOSED` связан с отдельным решением `CLOSE_CASE`.

## Воспроизвести готовый к закрытию сценарий

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

Скрипт печатает `caseUrl`, caseVersion и допустимый `closureEvidenceRefs`. Открой URL: дело находится в `CLOSURE_REVIEW`. Заполни rationale, оставь напечатанный evidence ref и нажми **Confirm closure for this version**. Страница и `/cases` должны показать `CLOSED`, 0 open cases и сохранённое `CLOSE_CASE` decision. Перезапуск с тем же `DATABASE_URL` должен сохранить состояние и историю.

## Что пересчитать при новых данных

- Более высокая `materialRevision` после CLOSED открывает дело, сохраняет старые решения/history и требует новых identity/scope reviews.
- Расширение L-2403 до L-2403 + L-2404 делает старые tasks SUPERSEDED и approvals STALE. После `CALCULATE_EXPOSURE` создаётся задача с новым coverage/quantity; старая completion не покрывает добавленный объём.
- Новые traceability facts, изменившие exposure или required tasks, открывают CLOSED case.
- Более свежее evidence с теми же quantities, scope, issue codes и required work сохраняется новой revision и audit event `evidence_updated`, но не сбрасывает CLOSED/completed work.

## Хранилище и границы

Текущее состояние decisions/tasks/closure хранится в `case_lifecycle.snapshot_json`; все существенные версии — в `case_revisions`; idempotency — в `case_commands`; traceability — в отдельной append-only таблице. Изменения snapshot/history/audit/ledger и legacy status выполняются одной SQLite immediate-транзакцией. Этапу 6 новая миграция не нужна. Старый stage-5 JSON нормализуется только при чтении storage; публичная Zod-схема не принимает неполные объекты.

Legacy `case_tasks`, `action_drafts`, старый close и exporter не используются как источник versioned state. Один lifecycle case относится к одному productId. Review bridge умеет один раз дополнить уже подтверждённое однопродуктовое legacy case snapshot/history/ledger, не удаляя старые строки; несовпадающий product и multi-product conversion блокируются.

Mykyta Investigation Engine должен расширять единственный producer boundary, а не создавать параллельный InvestigationOutcome или Case state. Текущий producer намеренно сохраняет v1 demo-семантику и не реализует evidence resolution, AI investigation, новый provenance model или расширение RecallScope.

Остаточные ограничения: нет production identity/role provider и resolver внешней подлинности evidence; разрешён только фиксированный demo operator. Acceptance некритической residual uncertainty не реализован, поэтому такие проблемы не обходятся. `CONTAINED` есть в контракте, но текущий минимальный путь сразу показывает `CLOSURE_REVIEW`, когда containment и все остальные readiness conditions одновременно выполнены. Внешние действия остаются только явно demo-записями.

Полный формат и invariants: `docs/INTEGRATION_CONTRACT.md`. Git refs и сквозные проверки: `docs/INTEGRATION_CHECK.md`; quality gates: `docs/STAGE_7_QUALITY.md`. Следующая стадия не реализована.
