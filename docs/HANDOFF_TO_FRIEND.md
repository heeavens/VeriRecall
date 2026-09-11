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

Review form использует обычный form content type, но его versioned confirm также требует `VERIRECALL_DEMO_MODE=true`; actor для этой операции задаётся сервером. При disabled mode сервер возвращает 409 и не выполняет legacy fallback. Confirm делегирует чистому `produceInvestigationOutcome` в `src/lib/server/investigation/outcome-producer.ts`, который строит и валидирует начальный InvestigationOutcome только из явно переданных persisted alert/catalogue/match полей и ссылок. Два непустых EAN должны совпасть после общей нормализации, чтобы identity стала KNOWN/MATCH; missing EAN остаётся UNKNOWN/UNRESOLVED независимо от Review decision, а hard EAN conflict остаётся CONFLICTED. Scope оценивается отдельно: missing batch — UNKNOWN/UNRESOLVED, exposure — NOT_CALCULATED/null.

Versioned Review не создаёт legacy `case_items`: scope authority находится только в `InvestigationOutcome`/`CaseSnapshot`. `getCaseDetail` также не запускает legacy affected-customer projection для lifecycle case. Если case был upgraded и уже содержит исторический `case_items.batch = 'Unknown'`, строка сохраняется для совместимости и аудита, но не интерпретируется как whole-product scope и не добавляет customers в versioned server payload. Sentinel `Unknown` и прежняя wildcard-семантика остаются только в pure legacy path.

Публично поддерживаемые команды:

- `CALCULATE_EXPOSURE`
- `DECIDE_INVESTIGATION`
- `DECIDE_ACTION`
- `REQUEST_ACTION`
- `ATTACH_RESULT`
- `REQUEST_CLOSURE`

`ACCEPT_INVESTIGATION` остаётся parseable internal lifecycle plumbing, но `/api/cases/{id}/commands` не обладает opaque server capability и всегда возвращает `FORBIDDEN` для этой команды. Browser/client code не может передать authoritative `InvestigationOutcome`; `demo:true`, actor, headers и contents payload не дают authority. Initial Review применяет первичный outcome через отдельный server-side `applyConfirmedReviewOutcomeInTransaction(...)`, а будущая Challenge conflict application будет отдельной HUMAN-controlled server operation.

Каждая публичная мутация использует новый UUID `commandId` и текущий `expectedCaseVersion`. Точный повтор сохраняет исходный effect, тот же id с другим payload даёт `IDEMPOTENCY_CONFLICT`, устаревшая версия — `VERSION_CONFLICT`. `schemaVersion`, `materialRevision` и `caseVersion` независимы.

## UI boundary

UI не строит и не отправляет authoritative `InvestigationOutcome`. Initial Review вызывает выделенный server-side bridge, а UI получает сохранённый `CaseSnapshot` через Review result или snapshot route. Все последующие разрешённые команды должны перерисовывать UI из возвращённого snapshot. Значение `null` вместе с knowledgeStatus нельзя показывать как ноль. `pendingDecisions` содержит только ожидающие решения, `decisions` — сохранённые APPROVED/REJECTED/STALE. KnowledgeStatus, task status и decision status нельзя объединять.

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
  VERIRECALL_CASE_ID=<case-id-confirmed-through-review> \
  node --import tsx scripts/demo-closure-ready.ts
```

Сначала создай authoritative initial outcome через Review confirmation и передай полученный case ID. Скрипт не создаёт и не принимает caller-authored `InvestigationOutcome`; он начинает с сохранённого Review snapshot и использует только публично разрешённые downstream-команды. Скрипт печатает `caseUrl`, caseVersion и допустимый `closureEvidenceRefs`. Открой URL: дело находится в `CLOSURE_REVIEW`. Заполни rationale, оставь напечатанный evidence ref и нажми **Confirm closure for this version**. Страница и `/cases` должны показать `CLOSED`, 0 open cases и сохранённое `CLOSE_CASE` decision. Перезапуск с тем же `DATABASE_URL` должен сохранить состояние и историю.

## Что пересчитать при новых данных

- Более высокая `materialRevision` после CLOSED открывает дело, сохраняет старые решения/history и требует новых identity/scope reviews.
- Расширение L-2403 до L-2403 + L-2404 делает старые tasks SUPERSEDED и approvals STALE. После `CALCULATE_EXPOSURE` создаётся задача с новым coverage/quantity; старая completion не покрывает добавленный объём.
- Новые traceability facts, изменившие exposure или required tasks, открывают CLOSED case.
- Более свежее evidence с теми же quantities, scope, issue codes и required work сохраняется новой revision и audit event `evidence_updated`, но не сбрасывает CLOSED/completed work.

## Хранилище и границы

Текущее состояние decisions/tasks/closure хранится в `case_lifecycle.snapshot_json`; все существенные версии — в `case_revisions`; idempotency — в `case_commands`; traceability — в отдельной append-only таблице. Изменения snapshot/history/audit/ledger и legacy status выполняются одной SQLite immediate-транзакцией. Этапу 6 новая миграция не нужна. Старый stage-5 JSON нормализуется только при чтении storage; публичная Zod-схема не принимает неполные объекты.

Legacy `case_items`, `case_tasks`, `action_drafts`, старый close и exporter не используются как источник versioned state. Один lifecycle case относится к одному productId. Review bridge умеет один раз дополнить уже подтверждённое однопродуктовое legacy case snapshot/history/ledger, не удаляя старые строки; versioned reads не выводят affected customers из этих retained rows. Несовпадающий product и multi-product conversion блокируются.

Mykyta Investigation Engine должен расширять единственный producer boundary, а не создавать параллельный InvestigationOutcome или Case state. Текущий producer отделяет Review decision от epistemic identity: KNOWN требует детерминированного совпадения persisted EAN, тогда как решение человека остаётся decision ref и не меняет UNKNOWN/CONFLICTED. Producer намеренно не реализует evidence resolution, AI investigation, новый provenance model или расширение RecallScope.

Остаточные ограничения: нет production identity/role provider и resolver внешней подлинности evidence; разрешён только фиксированный demo operator. Acceptance некритической residual uncertainty не реализован, поэтому такие проблемы не обходятся. `CONTAINED` есть в контракте, но текущий минимальный путь сразу показывает `CLOSURE_REVIEW`, когда containment и все остальные readiness conditions одновременно выполнены. Внешние действия остаются только явно demo-записями.

Полный формат и invariants: `docs/INTEGRATION_CONTRACT.md`. Git refs и сквозные проверки: `docs/INTEGRATION_CHECK.md`; quality gates: `docs/STAGE_7_QUALITY.md`. Следующая стадия не реализована.

## Investigation evidence registry boundary

Migration `0004_last_thunderbolt.sql` introduces the server-owned `investigation_evidence` table. Use `recordInvestigationEvidence` and `getInvestigationEvidence` from `src/lib/server/investigation/evidence-registry.ts`; do not write this table through Review, lifecycle commands, traceability, or browser code.

The record proves receipt and preserves provenance only. It does not prove an extracted claim, resolve an investigation question, or authorize an operational decision. Structured content is canonicalized and SHA-256 hashed by the server; locator evidence requires the caller to supply the SHA-256 hash for bytes the registry does not fetch. Evidence-request linkage is optional, but when supplied it must resolve through `evidence_requests.match_id → matches.alert_id → cases.alert_id` to the same case.

`InvestigationOutcome.evidenceRefs` remains an opaque-ref contract and is unchanged. Wiring those refs to this registry, receiving supplier responses, extracting/assessing claims, resolving KnowledgeGaps, and integrating AI are deliberately deferred. `AI_EXTRACTED` is not a raw evidence source kind; future AI output must be modeled as a derived/proposed claim from registered source evidence.

## Versioned gap evidence-request boundary

Migration `0005_majestic_centennial.sql` adds nullable `case_id` and `question_ref` to the existing `evidence_requests` table. The database permits only null/null legacy ownership or non-null/non-null versioned ownership; the indexed pair is deliberately non-unique because one current question may have multiple request attempts.

Use `requestInvestigationEvidence` from `src/lib/server/investigation/evidence-requests.ts` for the server-only versioned path. It accepts a UUID idempotency key, case ID, exact current gap ID, expected case version, and a non-empty subset of the three existing artifact names. It validates the current snapshot, currently permits only the producer's `BATCH_MISSING` Issue, derives exactly one legacy-compatible match from the authoritative alert/product, and records one `pending` request plus one audit event atomically. `pending` means the attempt exists; it does not mean sent, received, sufficient, or resolved.

Do not call legacy `requestMatchEvidence` for a versioned investigation. That flow remains unchanged for pure legacy Review and stores null `case_id`/`question_ref`; its match status and action drafts are not versioned truth. The required `match_id` relation and its legacy cascade behavior are intentionally retained, so this is not yet a complete ownership/deletion redesign.

When `investigation_evidence.evidence_request_id` points to a versioned request, the evidence registry now requires the same case and question as that request in addition to the authoritative match/product ownership check. Legacy requests cannot prove question identity. Receipt leaves the request `pending`, keeps `resolved_at` null, and does not mutate the snapshot or any knowledge state.

Identity UNKNOWN still has no requestable Issue, conflicts are not requestable, and no new question may be invented. Dispatch, supplier upload/receipt wiring, claim extraction or assessment, gap resolution, InvestigationOutcome revision, and AI remain deliberately unimplemented.

## Current Mykyta continuation checkpoint

Active branch: `mykyta_dev`. Herman's versioned lifecycle is already merged; keep the legacy Review flow separate and do not treat its match status, action drafts, `case_items`, or `Unknown` batch sentinel as authoritative versioned investigation state. Do not casually change the shared browser-safe contract in `src/lib/contracts/recall.ts`, and do not modify Herman-owned Exposure, Tasks, Closure, or Readiness in the next Mykyta commit.

Completed Mykyta boundaries:

1. `feat(investigation): extract outcome producer` — Review delegates pure `produceInvestigationOutcome(...)` construction to the investigation module.
2. `fix(investigation): require deterministic evidence for known identity` — a Review click remains an operational decision; only matching non-empty normalized persisted EAN values establish KNOWN/MATCH, while missing or conflicting identity remains visible.
3. `fix(cases): isolate versioned scope from legacy Unknown wildcard` — `InvestigationOutcome`/`CaseSnapshot` is versioned scope truth; versioned writes and reads do not project or interpret legacy `case_items.batch = 'Unknown'` as wildcard scope.
4. `feat(investigation): add evidence provenance registry` — append-only `investigation_evidence` records immutable receipt provenance. Evidence receipt is source material, not an established fact.
5. `feat(investigation): persist versioned gap evidence requests` — a request attempt binds `caseId + questionRef`; only an exact current `BATCH_MISSING` gap is requestable. A request is not evidence, `pending` does not mean sent, and receipt does not mean sufficient or resolved.
6. `feat(investigation): persist evidence-derived batch claims` — append-only `investigation_claims` stores immutable, untrusted `AFFECTED_BATCH_LOT` assertions derived from registered versioned evidence for the exact current `BATCH_MISSING` question.
7. `feat(investigation): persist claim assessments` — append-only `investigation_assessments` stores non-authoritative analysis of current `BATCH_MISSING` evidence and `AFFECTED_BATCH_LOT` claims without changing versioned case knowledge.
8. `feat(investigation): derive effective analysis state` — a pure/read-only projection derives active Claim heads, structural/applicable/materially-current Assessment heads, staleness, contradictions, and ambiguity without selecting an effective verdict or writing state.
9. `feat(investigation): persist demo batch establishments` — append-only `investigation_establishments` records historical success under one deterministic, explicitly demo-only policy while current eligibility remains a recomputed read projection.
10. `feat(investigation): persist investigation question lineage` — append-only `investigation_questions` makes the existing `BATCH_MISSING` Issue ID a permanent, authoritatively proven case/product question identity and permits safe direct late Evidence without changing knowledge.
11. `feat(investigation): persist resolved-question challenges` — append-only `investigation_challenges` records one explicit HUMAN/demo re-review authorization per registered Question and authoritative material answer, anchored by complete late Evidence and proven revision continuity without changing knowledge or lifecycle state.
12. `feat(investigation): persist challenge-scoped investigation writes` — immutable association rows authorize non-authoritative Request, Claim, and Assessment writes under one exact CURRENT Challenge without changing lifecycle state.
13. `feat(investigation): project challenge-scoped effective analysis` — a read-only first-cycle projection combines unassociated baseline plus one selected Challenge while preserving graph boundaries, staleness, ambiguity, and no-winner semantics.
14A. `feat(investigation): derive challenge conflict application basis` — a read-only canonical policy basis and SHA-256 digest cover the complete Challenge analysis plus every registered Question Evidence ref; this is a fingerprint, not approval or authoritative application.
14B1. `fix(workflow): internalize investigation outcome acceptance` — generic `ACCEPT_INVESTIGATION` execution now requires an opaque server-created capability; public HTTP/local lifecycle context is default-denied while the dedicated initial Review bridge remains functional.
14B2. `feat(investigation): apply challenge conflict outcome` — a dedicated server-only demo-HUMAN operation recomputes the exact reviewed Challenge basis inside one IMMEDIATE transaction, applies an authoritative unresolved conflict through the shared lifecycle path, and persists immutable source/result provenance.
15. `feat(investigation): apply established batch resolution` — a dedicated server-only demo-HUMAN operation recomputes the exact current Establishment application basis inside one IMMEDIATE transaction, derives the normalized lot from the persisted qualifying Claim, applies KNOWN/BATCH_LOT through the shared lifecycle path, and persists immutable Establishment/source/result provenance.
16A. `feat(investigation): establish challenge batch resolution` — a distinct non-authoritative RULE policy records an immutable Challenge-associated batch Establishment only after current complete-corpus HUMAN support, source diversity, and fail-closed resolution of divergent active Claims.
16B. `feat(investigation): apply challenge batch resolution` — a dedicated server-only HUMAN operation revalidates the exact canonical 16A basis inside one IMMEDIATE transaction, derives the target lot itself, writes one authoritative KNOWN/BATCH_LOT material revision through the shared lifecycle engine, and preserves explicit positive result-baseline provenance.
16C. `feat(investigation): support multi-cycle challenge inheritance` — one authoritative baseline resolver permits later Challenges to inherit only the exact result baseline of the validated positive Challenge application that created the challenged material state; first-cycle v1 behavior remains frozen and inherited cycles select v2 deterministically.

Migrations present are `0000_initial.sql`, `0001_last_living_lightning.sql`, `0002_case_lifecycle.sql`, `0003_traceability_exposure.sql`, `0004_last_thunderbolt.sql`, `0005_majestic_centennial.sql`, `0006_cynical_rictor.sql`, `0007_calm_captain_cross.sql`, additive `0008_warm_zarek.sql`, additive `0009_glamorous_celestials.sql`, additive `0010_lying_hellcat.sql`, additive `0011_confused_hannibal_king.sql`, additive `0012_stiff_squadron_supreme.sql`, additive `0013_tricky_amazoness.sql`, additive `0014_sour_firelord.sql`, and additive `0015_sloppy_warstar.sql`. Commit 16C adds no schema change or migration 0016. Re-run the complete verification gates after every future change because a green baseline is not proof that a later diff is correct.

Commit 6 supports only `AFFECTED_BATCH_LOT` for an exact current `BATCH_MISSING` gap. Claims reference registered evidence with matching case/question ownership; legacy-request-linked evidence is rejected because null/null legacy ownership cannot prove the versioned question. Evidence refs and JSON are canonicalized, while asserted lot text is preserved for later explicit comparison rules. Exact replay remains valid after the gap or case version advances. A correction creates a new claim with `supersedesClaimRef`; the original remains readable, and conflicting MFT24/MFT25 assertions coexist without an inferred winner.

Claim origins are `DETERMINISTIC_EXTRACTED`, `AI_PROPOSED`, and `HUMAN_OBSERVED`. Origin is derivation provenance, not source identity or trust: deterministic output is not automatically factual, AI output is only a proposal and no LLM is invoked, and a human-observed assertion is not a HumanDecision. Claims have no trusted/established state and do not drive InvestigationOutcome updates.

Commit 7 adds server-only `recordInvestigationAssessment`, case-scoped `getInvestigationAssessment`, and deterministic `listInvestigationAssessments`. The only verdicts are `SUPPORTED`, `INSUFFICIENT`, `REJECTED`, and `CONTRADICTED`; `ESTABLISHED` and unknown verdicts are rejected. Trust/authenticity/authorization/conflict policy is absent, so HUMAN, RULE, and AI assessor provenance does not make an assessment factual. No LLM is called.

Question-level `INSUFFICIENT` may have no target claim and records that evidence failed to yield a usable assertion while the gap remains. Targeted assessments must cover all target-claim evidence. A `CONTRADICTED` assessment references at least two same-case/question/product batch claims, covers their evidence union, and uses the server-owned `batch-normalization-comparison` `v1` rule backed by the existing `normalizeBatch`; equivalent values such as MFT-24/MFT24 cannot be declared contradictory. All claims remain visible and no winner is inferred.

Assessments are append-only and idempotent. `supersedesAssessmentRef` preserves reassessment history and requires the same case/question plus retained claim basis; list order does not imply effective truth. Request, receipt, claim, and assessment recording never mutate `InvestigationOutcome`, `CaseSnapshot`, case/material versions, lifecycle history/commands, HumanDecision, or Herman-owned Exposure, Tasks, Closure, and Readiness. The next layer is a separately authorized explicit assessed-finding → InvestigationOutcome resolution producer; it is not part of Commit 7.

Commit 8 adds `projectEffectiveInvestigationAnalysis` plus the thin `readEffectiveInvestigationAnalysis` loader and no persistence or migration. A Claim head is structurally unsuperseded; an Assessment structural head is applicable only when its complete Claim basis still consists of active Claim heads. Claim supersession never transfers an old Assessment, even to an equivalent lot. Material currentness maps `basisCaseVersion` through append-only `case_revisions` and compares material revision rather than raw case version, failing closed when that historical basis is missing or ambiguous.

The projection preserves every materially-current targeted judgment, question-level insufficient attempt, contradiction group, and supersession branch. It reports neutral ambiguity such as simultaneous SUPPORTED/REJECTED or SUPPORTED/INSUFFICIENT analysis and never emits an effective verdict or latest-row winner.

Commit 9 adds exactly one server-owned policy: `demo-dual-source-human-reviewed-batch` / `v1`, evaluated by RULE `demo-batch-establishment-policy-engine`. It requires KNOWN/MATCH identity, exactly one active non-AI batch Claim, two structured Claim Evidence records with distinct source identifiers and hashes spanning INTERNAL plus EXTERNAL_PARTY or REGULATOR, and a materially-current applicable HUMAN SUPPORTED review from `demo_operator` over the exact complete case/question Evidence corpus. These are demo diversity signals, not source authentication; neither the human review nor SUPPORTED establishes truth alone.

`recordInvestigationEstablishment` derives the full active-Claim, structural-Assessment, Evidence, case-version, and material-revision basis inside one immediate transaction. `getInvestigationEstablishment` and `listInvestigationEstablishments` expose immutable history; `evaluateCurrentInvestigationEstablishment` recomputes current eligibility per row. New Evidence, supersession, contradictions, ambiguity, or material change invalidates eligibility without deleting history, while a case-version-only operational change may remain eligible. No latest establishment wins, no establishment mutates `InvestigationOutcome`, and no AI or caller can select the policy/evaluator.

Commit 10 separates permanent Question lineage from the current Gap. `investigation_questions` preserves the exact existing `questionRef`, immutable case/product ownership, and the first authoritative `BATCH_MISSING` revision proven by `case_revisions`; it stores no answer or mutable state. Review registration is atomic. The migration command and current write paths can safely reconcile older versioned candidates, but child rows merely nominate references: authoritative revision history must prove them, and arbitrary historical Evidence is never blessed.

New Evidence must resolve through that registry as well as existing request ownership. Direct late Evidence remains recordable after `BATCH_MISSING` disappears, but remains source material only: it does not recreate a Gap, create a Claim/Assessment/Challenge, or increment case/material versions. `readInvestigationQuestionContext` says only `OPEN_GAP` or `NOT_CURRENT`; no direct question-to-resolution linkage exists yet. At the Commit 10 boundary, Requests, Claims, Assessments, Effective Analysis, and Establishment remained blocked after resolution; Commit 12 now permits the first three only under an exact current Challenge.

Commit 11 separates Challenge from Evidence and authoritative truth. A new Challenge is allowed only when immutable `case_revisions` prove that the immediately preceding material state contained the exact registered `BATCH_MISSING` Question and the current material state supplies its KNOWN/MATCH, KNOWN/BATCH_LOT answer. The Challenge stores the first revision carrying that answer, the current material revision, opening case version, trusted `demo_operator` HUMAN provenance, and the complete canonical set of Evidence received strictly after the answer revision. `validAsOf` does not control lateness.

Only one Challenge may exist per case/Question/material revision. Exact replay is historical and precedes freshness; a new ID for the same cycle is rejected. Currentness is derived rather than stored: an operational case-version advance may leave a Challenge current, while any material or answer-context change makes it historical without deleting it. Opening while the case is CLOSED is allowed but does not reopen it. Opening writes only the Challenge plus one chronology audit event.

Commit 12 adds Challenge-scoped Evidence Request, Claim, and Assessment writes using three additive immutable association tables. Existing `OPEN_GAP` writes remain unassociated and behavior-compatible. Evidence remains permanently owned by case + Question; request association supplies indirect Challenge provenance, while direct late Evidence remains Question-owned. Challenge Claims require at least one Challenge-relevant Evidence item, Challenge Assessments may reason over baseline plus same-Challenge Claims, and artifacts from another Challenge are rejected. Supersession cannot cross the unassociated/Challenge partitions. These writes remain non-authoritative and non-material, may run while a case is CLOSED without reopening it, and do not change Establishment.

Migration `0011_confused_hannibal_king.sql` adds only `investigation_challenge_requests`, `investigation_challenge_claims`, and `investigation_challenge_assessments`, each with the artifact reference as its primary/restrictive foreign key and one restrictive Challenge foreign key. No populated investigation table is altered or rebuilt.

Commit 13 adds `readChallengeEffectiveInvestigationAnalysis`, a read-only projection over unassociated baseline history plus one selected CURRENT Challenge. It reuses the Commit 8 graph core; the existing `projectEffectiveInvestigationAnalysis` and `readEffectiveInvestigationAnalysis` APIs remain current-`BATCH_MISSING`-only and behavior-compatible. The Challenge result includes observed context, the normal effective-analysis structure, and canonical included Claim, Assessment, and referenced-Evidence bases. Referenced Evidence is not represented as the complete Question Evidence corpus.

Challenge association and supersession boundaries are checked across the full same-question graph before filtering, including excluded-to-included edges. Included Challenge Assessments may reason over baseline and selected-Challenge Claims, while another Challenge's artifacts are excluded and cannot be referenced. Evidence ownership and request provenance are rechecked, and Challenge relevance continues to use `receivedAt`, never `validAsOf`.

Baseline Assessment staleness remains truthful across authoritative resolution: an old baseline SUPPORTED Assessment may stay structurally applicable but `MATERIAL_REVISION_STALE`, while a current Challenge CONTRADICTED Assessment can expose MFT24/MFT25 without choosing a winner. Commit 13 supports only a provable first post-resolution Challenge cycle; earlier Challenge history makes baseline inheritance fail closed because no authoritative application-basis record exists yet.

Commit 13 adds no schema, migration, write, or audit event. CLOSED cases remain closed, Establishment remains OPEN_GAP-only, and no analysis result changes `InvestigationOutcome`, versions, lifecycle, HumanDecision, or downstream state.

Commit 14A adds `readChallengeConflictApplicationBasis`. The public Commit 13 API remains compatible; its transaction body is exposed only as a transaction-compatible server helper so the new basis reader and future mutation can reuse exactly the same currentness, first-cycle, graph-boundary, partition, Evidence-integrity, and projection behavior. The basis uses explicit format `challenge-conflict-application-basis/v1` and demo policy `demo-challenge-conflict-application-policy` / `v1`.

The basis distinguishes graph-referenced Evidence from every registered case/Question Evidence ref. Its canonical SHA-256 digest covers the Challenge/current-answer context, complete projection basis, Claim and Assessment head/currentness state, staleness reasons, targeted judgments, contradiction groups, ambiguity, complete Evidence corpus, deterministic blockers, and exact qualifying conflict. Appending Evidence, Claims, or Assessments can therefore invalidate a reviewed digest without changing caseVersion or materialRevision. Eligibility requires one current selected-Challenge HUMAN or RULE contradiction over every active Claim, baseline plus selected-Challenge participation, distinct normalized lots, complete Evidence coverage, and no current negative or non-benign ambiguous analysis. It chooses no winner.

Commit 14A performs no write and adds no schema or migration. The digest is not an approval, authorization token, HumanDecision, application record, or authoritative fact. Commit 14B2 now recomputes it inside one immediate mutation transaction, compares the exact human-reviewed digest, persists durable application provenance, and reuses the authoritative lifecycle path for the CONFLICTED/UNRESOLVED revision. Commit 15 now implements established-batch application; Challenge closure and multi-cycle inheritance remain deferred. The monitoring provenance conflation described below also remains unresolved.

Commit 14B1 closes the generic authority bypass. `createRecallService(...).execute(...)` accepts `ACCEPT_INVESTIGATION` only when its server-side `LifecycleContext` was produced by the explicit internal acceptance factory. The capability uses a private Symbol plus private object identity, is non-enumerable, is absent from `localLifecycleContext()`, and cannot be serialized or supplied in command JSON. External `/api/cases/{id}/commands` calls therefore receive typed `FORBIDDEN` before lifecycle state, versions, commands, revisions, audit, decisions, tasks, exposure, closure, or CLOSED status are touched. Other command variants retain their existing public demo behavior.

The initial Review path does not use generic HTTP acceptance: `confirmReviewMatch(...)` continues calling `applyConfirmedReviewOutcomeInTransaction(...)` inside its server transaction and still registers current Questions. Explicit internal generic acceptance remains available only for trusted server/test lifecycle plumbing and retains its prior replay and material-revision semantics. Commit 14B1 adds no schema or migration and does not implement Challenge conflict application; that remains Commit 14B2.

Commit 14B2 adds `applyInvestigationChallengeConflict(...)` as a server-only authoritative operation with no HTTP/UI exposure. The demo HUMAN supplies only immutable operation identities, current version preconditions, the exact Commit 14A digest reviewed, rationale, and `demo:true`. The server owns `HUMAN` / `demo_operator`, recomputes the complete basis inside the same IMMEDIATE transaction, rejects any digest drift even when case/material versions are unchanged, and constructs the new `InvestigationOutcome` without accepting caller-authored outcome fragments.

The applied result preserves KNOWN/MATCH identity but records scope as `UNRESOLVED` / `CONFLICTED`, adds one critical permanent-Question `BATCH_CONFLICT`, preserves unrelated lineage, selects no batch winner, and increments case/material revisions exactly once. `applicationRef` enters decision lineage; Claim, Assessment, Challenge, and application identifiers never enter Evidence lineage. The shared lifecycle transition owns snapshot projection, revision/command/audit persistence, task carry/supersession, decision staleness, exposure/closure reset, and CLOSED-case reopening.

`investigation_challenge_conflict_applications` is append-only business authorization/provenance. It stores the exact source and result revision IDs, canonical reviewed Claims/Assessments and complete Evidence corpus, applied contradiction Claims/Assessment/Evidence, policy and format versions, digest, rationale, and trusted actor provenance. Exact replay returns the stored result revision rather than today's snapshot and creates no second effect. Migration `0012_stiff_squadron_supreme.sql` is additive only. This ledger is sufficient provenance for later multi-cycle work, but Commit 13 still intentionally blocks multi-cycle inheritance until Commit 16 implements that proof. Established-batch authoritative promotion is now implemented by Commit 15; monitoring/AI provenance hardening remains deferred.

Commit 15 keeps Establishment and HUMAN authority separate. `investigation_establishments` remains a historical RULE/demo policy result; `readEstablishedBatchApplicationBasis(...)` recomputes current eligibility and canonically fingerprints the exact BATCH_MISSING authoritative source, Establishment basis, complete current investigation artifacts, target Claim, and normalized lot. The HUMAN supplies only the exact digest plus current versions and rationale. `applyInvestigationEstablishedBatch(...)` recomputes everything in one IMMEDIATE transaction, derives the lot itself, and reuses the existing authoritative lifecycle transition.

The resulting InvestigationOutcome preserves KNOWN/MATCH identity, becomes KNOWN/BATCH_LOT, removes only the exact permanent Question's BATCH_MISSING gap, and advances caseVersion/materialRevision by exactly one. Any unrelated authoritative gap or conflict blocks promotion rather than being erased. The append-only `investigation_established_batch_applications` row links the exact Establishment and Claim, canonical reviewed/applied Evidence basis, applied lot, policy/digest, trusted HUMAN provenance, and exact source/result revisions. Replay returns that stored result revision without rerunning policy or lifecycle effects. Question and analysis history remains permanent, so later Evidence can open the existing first post-resolution Challenge. There is no public application route, no AI/RULE authority, and generic public `ACCEPT_INVESTIGATION` remains forbidden. Multi-cycle inheritance remains Commit 16; monitoring/AI provenance hardening remains deferred.

Normal readiness cannot produce a CLOSED case while the authoritative BATCH_MISSING gap remains. Commit 15 therefore treats an anomalous CLOSED/open-gap source as ineligible instead of adding special lifecycle behavior; valid applications continue through the single shared authoritative transition.

Commit 16A keeps positive Challenge policy separate from both OPEN_GAP Establishment and HUMAN application. `recordInvestigationChallengeBatchEstablishment(...)` derives a canonical immutable basis from the existing first-cycle Challenge projection and records RULE policy success only when a selected-Challenge non-AI batch Claim has current complete-corpus HUMAN support, Commit 9 source diversity, no current contradiction/insufficiency/ambiguity, and every divergent active alternative has a current trusted non-AI rejection. Equivalent normalized lots support reaffirmation; replacement never relies on latest-wins or caller-selected lots.

`investigation_challenge_establishments` associates one immutable base Establishment with one exact Challenge. The artifact reference is the primary restrictive FK, so an Establishment cannot be attached later or moved between cycles; the Challenge FK is also restrictive. Current eligibility is recomputed rather than stored, and any Challenge/material, Evidence, Claim, Assessment, supersession, support, rejection, or immutable-basis drift fails closed without mutating historical policy output.

Commit 16A writes only the Establishment, its Challenge association, and one chronology audit event. It does not call the lifecycle writer, create a HUMAN application digest, choose authoritative scope, increment any version, or expose a route/UI. Commit 16B must add the separate HUMAN positive Challenge application; Commit 16C must add provenance-safe multi-cycle inheritance; Commit 16D must address continued investigation after authoritative conflict.

Commit 16A verification: the focused policy/database suite passes 19/19 in 2 files, adjacent Commit 9/12–15 investigation regressions pass 108/108 in 7 files, downstream lifecycle/Review/Exposure/Task/Closure regressions pass 43/43 in 5 files, and the full suite passes 343/343 in 36 files. Check, build, and diff gates pass. Clean/repeat/populated-0013 migration, restrictive FKs, reset/reseed, reopen persistence, foreign-key check, exact 0013→0014 metadata comparison, and final Drizzle no-op generation pass.

Commit 16B keeps the 16A RULE Establishment non-authoritative and adds a separate HUMAN consequential application. `readChallengeBatchApplicationBasis(...)` fingerprints the full current authoritative answer, Challenge anchor, first-cycle projection, immutable Establishment, fresh 16A classification, complete Evidence, and application occupancy. `applyInvestigationChallengeBatch(...)` accepts no Claim, lot, Evidence, Assessment, actor, policy, baseline, outcome, or revision result from its caller; it derives all of them after recomputing that exact digest in the same IMMEDIATE transaction.

Both same-lot reaffirmation and replacement advance caseVersion/materialRevision exactly one because the authoritative evidentiary basis changes. Authoritative scope Evidence is the complete Question corpus reviewed by 16A. The append-only `investigation_challenge_batch_applications` row separately records reviewed refs, policy-relied SUPPORT/REJECT refs, and an explicit future-16C positive baseline containing only the target Claim, qualifying HUMAN SUPPORT refs, and complete Evidence. Rejected prior Claims and REJECT Assessments are intentionally not inherited. The row links the exact source/result revisions and is the HUMAN authorization record; no fake approved HumanDecision is created.

Positive and conflict Challenge applications are mutually exclusive under their serialized IMMEDIATE transactions. Exact replay on either path runs before present-day currentness and returns its exact historical result without another mutation. Generic public `ACCEPT_INVESTIGATION` remains forbidden, and Commit 16B adds no route or UI. Migration `0015_sloppy_warstar.sql` adds only the positive Challenge application ledger. Commit 16C must consume its explicit result baseline for CH2 inheritance; Commit 16D must separately restore investigation continuity after an authoritative conflict. Monitoring/AI alert provenance hardening remains deferred.

Commit 16B verification: focused 16A/16B, reciprocal conflict, Commit 15, effective-analysis, Challenge-write, and database suites pass 124/124 in 8 files; explicit lifecycle/Review/Closure/Exposure/Task regressions pass 57/57 in 7 files; the full suite passes 356/356 in 36 files. Check, build, and diff gates pass. Clean/repeat/populated-0014 migration, restrictive constraints, reset/reseed, reopen persistence, `foreign_key_check = []`, exact 0014→0015 metadata comparison, and final Drizzle no-op generation pass.

Commit 16C centralizes Challenge baseline authority in `resolveAuthoritativeChallengeBaselineInTransaction(...)`. The resolver recognizes only `INITIAL_UNASSOCIATED`, preserving the original BATCH_MISSING-to-known first-cycle proof, or `APPLIED_CHALLENGE_BATCH`, proven by the exact hydrated Commit 16B positive application whose `resultingRevisionId` is the Challenge answer anchor. It verifies a consecutive per-case operational revision range with unchanged material revision and authoritative InvestigationOutcome. Never infer ancestry from timestamps, latest rows, equal lots, or all artifacts belonging to a previous Challenge.

An inherited cycle receives exactly the preceding application's one-hop `resultBaseline` Claim, qualifying SUPPORT Assessment, and Evidence allowlists. Reviewed rejected Claims, REJECT justification, parallel/non-target Claims, and other historical Challenge artifacts stay excluded. Original associations never move. Current Assessments may reference an allowlisted inherited Claim, but Claim and Assessment supersession remains Challenge-partition-local. Evidence remains Question-owned: the inherited Evidence list proves the previous authoritative basis, while new direct and current-Request Evidence remains visible to the complete-corpus safety policy. Inherited SUPPORT remains historical/materially stale and cannot replace fresh current selected-Challenge HUMAN support or required current trusted rejection.

The first cycle remains frozen on Challenge Establishment v1, positive application basis v1, and conflict basis/policy v1. Applied-positive cycles select v2 deterministically from baseline kind and canonically include the prior positive application anchor and result baseline. Existing 16B HUMAN authority, server-derived lot, explicit result-baseline rules, replay-first semantics, and 14B2 conflict authority are unchanged. CH2 and CH3 positive cycles are supported, as is CH2 conflict application; post-conflict structured investigation is still Commit 16D. There is no schema change, no migration 0016, no shared-contract change, and no public route/UI. Monitoring/AI alert provenance hardening remains deferred.

Commit 16C verification: the focused multi-cycle/Challenge regression batch passes 110/110 in 6 files; adjacent Commit 9/10/12/15 and database regressions pass 118/118 in 8 files; lifecycle/Review/Exposure/Task/Closure regressions pass 57/57 in 7 files; and the full suite passes 368/368 in 36 files. Type-checking reports no diagnostics, the production build passes with only the existing adapter-auto notice, and whitespace checks pass. Drizzle generation is a no-op and no migration 0016 exists.

Important provenance risk to preserve visibly: the current monitoring/LLM alert-extraction path can persist AI-extracted alert EAN or batch values into the same alert fields later read by deterministic investigation rules. Persisted alert fields therefore do not yet prove raw-source or trusted-fact provenance. Commit 10 does not resolve that conflation, classify AI output as raw evidence, or allow AI claims/assessments/establishments to become factual automatically.
