# VeriRecall — состояние блока B

Дата: 2026-09-09. **Этап 7 Германа объединён с текущей веткой `mykyta_dev`; Mykyta Investigation Engine Commit 1–9 реализованы.** Persistent batch claims остаются untrusted assertions; append-only assessments записывают только анализ, read-only effective-analysis projection сохраняет несколько одновременно применимых суждений без выбора истины, а demo-only establishment сохраняет лишь исторический успех именованной политики. Применение established finding к InvestigationOutcome ещё не реализовано. Актуальная точка продолжения описана в `docs/HANDOFF_TO_FRIEND.md`.

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
- Review confirm теперь строит InvestigationOutcome из сохранённых alert/catalogue/match и атомарно создаёт или обновляет versioned CaseSnapshot. Чистый producer вынесен в `src/lib/server/investigation/outcome-producer.ts`, валидирует результат общей `investigationOutcomeSchema` и не обращается к БД, LLM, exposure или task engine. Identity становится KNOWN/MATCH только при совпадении двух непустых persisted EAN после общей нормализации; missing EAN остаётся UNKNOWN/UNRESOLVED даже после human Review decision, а hard conflict остаётся CONFLICTED. Повтор не дублирует effect; уже подтверждённое legacy-дело из общей базы подключается один раз. Неизвестный scope также не исчезает.
- Для versioned cases единственный источник scope — `InvestigationOutcome` в `CaseSnapshot`. Versioned Review не создаёт compatibility `case_items`, а `getCaseDetail` не вычисляет legacy affected customers из `case_items`, даже если upgraded case уже содержит историческую строку с batch `Unknown`. Исторические строки не удаляются; sentinel и его wildcard-поведение сохранены только для genuinely legacy cases.
- Публичный Review route требует явный локальный demo mode и использует фиксированного server-side `demo_operator`. Отключённый режим отклоняет операцию без legacy fallback.
- Локальный demo catalogue содержит 15 синтетических товаров Costa Coffee и три явно демонстрационных кофейных предупреждения. Названия, категории, поставщики и изображения согласованы; это не реальные отзывы бренда.
- Versioned case UI ведёт пользователя по четырём шагам: product match, human review, affected stock, actions/closure. Главная карточка показывает следующее действие; review содержит чек-лист и пример комментария, а версии, machine fields и audit history убраны в раскрываемый технический блок.
- После подтверждения identity/scope case UI может явно загрузить однопартийный synthetic demo-набор на 100 единиц через настоящий `CALCULATE_EXPOSURE`. После завершения `HOLD_STOCK` отдельная кнопка записывает demo containment evidence и повторно считает snapshot; завершение задачи само по себе containment не доказывает. Это локальный demo-путь, а не production-импорт ERP/POS.

## Архитектура и БД

Проект остаётся SvelteKit 2 / Svelte 5 / TypeScript / SQLite / Drizzle / Zod / Vitest монолитом. Нового транспорта, workflow framework или микросервиса нет.

Миграции этапов блока B:

- `0002_case_lifecycle.sql`: case lifecycle, revisions и command ledger.
- `0003_traceability_exposure.sql`: append-only traceability records и несколько case revisions на materialRevision.
- Этапы 5–6 используют существующий versioned aggregate; новых миграций им не требуется. Persisted stage-5 JSON дополняется новыми decision fields только на storage read boundary, публичный контракт остаётся strict.

Значимые решения: `docs/adr/0001-dynamic-task-engine-in-case-snapshot.md`, `docs/adr/0002-human-decisions-and-closure.md` и `docs/adr/0003-review-to-versioned-case-bridge.md`.

## Проверки этапа 7

- Focused Review → lifecycle suite: 11/11, PASS.
- Общая база создана и seeded кодом `origin/main@b5f9c89`, затем текущие `0002`/`0003` применены без изменения старых миграций; legacy case сохранён.
- Реальный SvelteKit form POST создал versioned snapshot v2/materialRevision 1 на этой базе; snapshot GET и server-rendered case page прочитали то же состояние.
- Сквозной test проходит Review → CaseSnapshot → exposure → action approval/request/result → запрет раннего close → scope expansion и новый task coverage.
- `npm test`: 111/111 в 21 test file, PASS; `npm run check`: 0 ошибок/предупреждений; `npm run build`: PASS с обычным сообщением adapter-auto об отсутствии production target. Точные результаты находятся в `docs/INTEGRATION_CHECK.md`.
- После Mykyta identity-semantics correction: focused producer/matching/Review/lifecycle suite — 34/34 PASS; `npm.cmd test` — 127/127 в 22 test files; `npm.cmd run check` — 0 ошибок/предупреждений; `npm.cmd run build` и `git diff --check` — PASS. Adapter-auto по-прежнему сообщает об отсутствии выбранного production target.
- После Mykyta legacy-scope isolation: versioned Review не пишет `case_items`, upgraded lifecycle cases игнорируют retained legacy `Unknown` при customer projection, а pure legacy wildcard regression остаётся зафиксированным тестом. Focused Review/lifecycle/legacy case suite — 20/20 PASS; `npm.cmd test` — 130/130 в 22 test files; `npm.cmd run check`, `npm.cmd run build` и `git diff --check` — PASS. Adapter-auto по-прежнему сообщает об отсутствии выбранного production target.

Тесты не доказывают отсутствие дефектов. Стратегия, review findings и пробелы: `docs/STAGE_7_QUALITY.md`; Git refs и сквозная проверка: `docs/INTEGRATION_CHECK.md`.

## Как проверить руками

```bash
stage7_dir="$(mktemp -d /tmp/verirecall-stage7-XXXXXX)"
export DATABASE_URL="$stage7_dir/demo.db"
export VERIRECALL_DEMO_MODE=true
npm run db:migrate
npm run db:seed
npm run dev -- --host 127.0.0.1 --port 5187
```

Открой `/review`, подтверди candidate и перейди по **Open case**. Подтверди product и batch, нажми **Load demo stock records**, проведи появившийся `HOLD_STOCK` через approval → demo request → result evidence, затем нажми **Record 100 contained items** и выполни отдельное закрытие. Полный автоматический сценарий запускается командой `npm test -- src/lib/server/integration/review-lifecycle.test.ts`.

## Изменения общего формата для сверки с другом

- Импортировать только `$lib/contracts/recall`; не копировать интерфейсы.
- Review UI уже подключён: его confirm action создаёт versioned snapshot через `produceInvestigationOutcome`. Human decision ref сохраняется независимо от identity KnowledgeStatus; следующие investigation rules нужно добавлять в этот producer boundary, сохраняя форму `InvestigationOutcome` и не возвращая legacy tasks как текущее состояние.
- CaseSnapshot теперь обязательно содержит `decisions`, а HumanDecision — `uncertaintyRefs`, `conflictRefs`, `consequence` и `actorRole` вместе с прежним basis/evidence/rationale.
- DECIDE_INVESTIGATION добавлена; DECIDE_ACTION и REQUEST_CLOSURE требуют полный evidence basis и `demo:true`.
- UI должен различать PENDING и recorded decisions, RESPONDING/CLOSURE_REVIEW/CLOSED, stale approvals, null quantities и машинные closure blockers.
- Рабочие HTTP/TypeScript примеры находятся в `docs/HANDOFF_TO_FRIEND.md`; полный формат — в `docs/INTEGRATION_CONTRACT.md`.

## Ограничения и следующая работа

- Есть только fixed demo operator/role. Production identity, authorization policy и внешний evidence resolver отсутствуют; demo-path нельзя публиковать как защищённый многопользовательский API.
- Acceptance некритической residual uncertainty не реализован, поэтому обхода blockers нет.
- `CONTAINED` присутствует в контракте; текущий минимальный путь переходит сразу в CLOSURE_REVIEW, когда containment и остальные readiness conditions выполнены одновременно.
- Legacy cases/tasks/drafts/export продолжают работать отдельно. Уже подтверждённое однопродуктовое legacy case может быть дополнено versioned snapshot через Review bridge; его исторические `case_items` сохраняются, но больше не определяют versioned scope или affected customers. Несовпадающий product и multi-product conversion не допускаются молча.
- Реальные письма, POS/ERP/inventory/shipment actions не выполняются. Live AI, Docker, production deployment, clean dependency install, multi-process load и mobile walkthrough новых stage-6 controls не проверялись.
- Визуальный browser automation этапа 7 не выполнен из-за заблокированного macOS; реальные form POST, API GET и SSR HTML проверены на dev-server.
- Readiness/simulation остаётся после основного demo. Этап 8 можно начинать только по отдельному указанию Германа.

Ветка: `mykyta_dev`. Не сливать и не отправлять изменения в `main` без явного указания.

## Mykyta Investigation Engine — Commit 4 provenance foundation

- Migration `0004_last_thunderbolt.sql` adds `investigation_evidence`, the durable investigation-evidence provenance registry. It owns stable evidence refs, case/question linkage, optional legacy evidence-request linkage, source identity, receipt/as-of timing, immutable structured content or an external locator, a SHA-256 integrity hash, and the explicit demo marker.
- `recordInvestigationEvidence` is append-only at the service boundary. An exact immutable replay returns the existing record; reuse of an evidence ref with changed content or provenance is rejected. `getInvestigationEvidence` resolves only through the owning case.
- Evidence receipt does **not** establish a fact. Recording evidence does not change `InvestigationOutcome`, material revision, `CaseSnapshot`, gaps, decisions, tasks, exposure, or closure state.
- `InvestigationOutcome` and `HumanDecision` still reference evidence through opaque strings. The registry is not wired into Review, supplier requests/responses, ingestion, monitoring, or the UI yet.
- Claim extraction/assessment, KnowledgeGap resolution, supplier receipt handling, and AI integration remain unimplemented. AI output is intentionally not a raw-evidence `sourceKind`; later AI extraction must remain a derived/proposed claim.

## Mykyta Investigation Engine — Commit 5 gap/request bridge

- Migration `0005_majestic_centennial.sql` extends `evidence_requests` with an optional versioned owner pair: `case_id` and `question_ref`. A database check requires both fields to be null (legacy request) or both non-null (versioned request), and a non-unique `(case_id, question_ref, created_at)` index supports multiple attempts for one question.
- `requestInvestigationEvidence` persists a versioned request only for the exact, current `BATCH_MISSING` entry in `CaseSnapshot.investigation.gaps`. Its existing `Issue.id` is the `questionRef`; conflicts, identity UNKNOWN without an Issue, stale or invented references, and other Issue codes are not requestable through this bridge.
- The service derives the required legacy `match_id` from the authoritative case alert and lifecycle product, rejects absent or ambiguous matches, canonicalizes requested artifacts, and stores `pending` with `resolved_at = null`. Here `pending` means only that the request attempt exists; nothing has been sent.
- Request creation is transactionally idempotent by caller-supplied UUID and adds one audit event for a new request. It does not mutate `InvestigationOutcome`, `CaseSnapshot`, `caseVersion`, `materialRevision`, lifecycle history/commands, exposure, tasks, traceability, or closure.
- An `investigation_evidence` receipt linked to a versioned request must use the same `caseId` and `questionRef`; receipt still does not change request status or establish/resolve a fact. Legacy `requestMatchEvidence` remains a separate compatibility flow and writes null/null ownership fields.
- Verification: focused request/registry/database/Review/lifecycle suites pass 47/47; the full suite passes 156/156 in 24 files; `npm.cmd run check`, `npm.cmd run build`, clean and repeat migrations, populated-0001 and populated-0004 compatibility migrations, Drizzle metadata consistency, and `git diff --check` pass. The build retains the existing adapter-auto deployment-target notice.
- The retained required `evidence_requests.match_id` foreign key still has legacy cascade behavior. Versioned ownership is explicit, but a broad legacy relationship/deletion redesign is deferred together with dispatch/receipt workflow, claim assessment, question resolution, identity-question modeling, conflicts, and AI.

## Mykyta Investigation Engine — Commit 6 untrusted batch claims

- Migration `0006_cynical_rictor.sql` adds append-only `investigation_claims`. The only supported claim type is `AFFECTED_BATCH_LOT`, and a new claim may address only the exact current `BATCH_MISSING` gap. The product subject is derived from the authoritative current `CaseSnapshot`; it is never accepted from the caller.
- Claims reference one or more registered `investigation_evidence` rows owned by the same case and question. Evidence linked to a legacy null/null request is not accepted because that request cannot prove versioned question ownership. Evidence references and JSON payloads are canonicalized without normalizing the asserted lot text.
- `originKind` records derivation method only: `DETERMINISTIC_EXTRACTED`, `AI_PROPOSED`, or `HUMAN_OBSERVED`. It is not an evidence source or trust decision. Deterministic extraction is not automatically factual, `AI_PROPOSED` never establishes a fact, and `HUMAN_OBSERVED` is not a `HumanDecision`.
- Claim IDs are idempotency keys. Exact replay returns the immutable stored claim without another audit event, including after the question or case version advances; changed semantics conflict. Supersession creates a new same-case/question/subject/type claim and preserves the original. Multiple incompatible values such as MFT24 and MFT25 remain visible; no latest claim or winner is inferred.
- Claims still have no mutable assessment/trust/status fields and do not drive gap resolution or InvestigationOutcome revision. Request creation, evidence receipt, and claim recording do not mutate `CaseSnapshot`, `caseVersion`, `materialRevision`, lifecycle history/commands, decisions, exposure, tasks, closure, or readiness.
- Verification: focused claim/database suites pass 20/20; the full suite passes 172/172 in 25 files; `npm.cmd run check` reports 0 errors/warnings; `npm.cmd run build`, clean and repeat migrations, populated-0005 compatibility, `foreign_key_check`, Drizzle metadata consistency, and `git diff --check` pass. The build retains the existing adapter-auto deployment-target notice.

## Mykyta Investigation Engine — Commit 7 claim assessments

- Migration `0007_calm_captain_cross.sql` adds append-only `investigation_assessments`. Assessments are immutable analysis records for the exact current `BATCH_MISSING` question and existing `AFFECTED_BATCH_LOT` claims/evidence; they are not authoritative knowledge, `HumanDecision`, or an InvestigationOutcome revision.
- Supported verdicts are only `SUPPORTED`, `INSUFFICIENT`, `REJECTED`, and `CONTRADICTED`. `ESTABLISHED` is deliberately unsupported because source authenticity, trust policy, authorized epistemic assessors, and conflict-resolution policy do not yet exist. HUMAN/RULE/AI identify assessor provenance only and never create truth.
- Question-level `INSUFFICIENT` may record an unsuccessful evidence attempt without inventing a claim. Claim-level assessments must include the claim's evidence. `CONTRADICTED` preserves at least two incompatible claims, requires their complete evidence union, applies the server-owned `normalizeBatch` comparison rule, and never selects a winner.
- Assessment IDs are idempotency keys. Exact replay returns the stored record without another audit event even after lifecycle advancement; changed semantics conflict. Reassessment uses `supersedesAssessmentRef`, preserves the old row, and does not infer effective truth from timestamps.
- Recording any assessment leaves claims, requests, evidence, `InvestigationOutcome`, `CaseSnapshot`, `caseVersion`, `materialRevision`, revisions/commands/decisions, Exposure, Tasks, Closure, and Readiness unchanged. Explicit assessed-finding → InvestigationOutcome resolution remains a separate later commit.
- Verification: focused assessment/database suites pass 22/22; the full suite passes 190/190 in 26 files; `npm.cmd run check` reports 0 errors/warnings; `npm.cmd run build`, clean and repeat migrations, populated-0006 compatibility, `foreign_key_check`, Drizzle metadata consistency, and `git diff --check` pass. The build retains the existing adapter-auto deployment-target notice.

## Mykyta Investigation Engine — Commit 8 effective analysis projection

- `projectEffectiveInvestigationAnalysis` is a pure projection and `readEffectiveInvestigationAnalysis` is its read-only database loader for the exact current `BATCH_MISSING` question. Commit 8 adds no table, migration, audit event, or write operation.
- Claim and Assessment supersession are projected as graphs. Structural heads are not selected by timestamp; multiple branches remain visible. An Assessment head is applicable only while every Claim in its basis is still an active Claim head, and no analysis is transferred to a superseding Claim even when the asserted lot normalizes identically.
- Assessment material currentness resolves the persisted `basisCaseVersion` through `case_revisions` to a material revision. Operational case-version advancement with the same material revision does not stale analysis; a different material revision does, and an absent or ambiguous historical basis fails closed as unresolved.
- The projection returns collections of active/inactive Claims, structural/applicable/materially-current Assessment heads, stale reasons, targeted verdict refs, question-level insufficient attempts, active contradiction groups, and neutral ambiguity records. It deliberately returns no effective verdict, winner, trust result, establishment eligibility, or authoritative resolution.
- Commit 9 is expected to add an explicit demo-only establishment policy on top of this projection. Source authenticity, `ESTABLISHED`, InvestigationOutcome revision, scope resolution, and all Exposure/Tasks/Closure/Readiness effects remain unimplemented here.
- Verification: the focused projection suite passes 10/10 and the full suite passes 200/200 in 27 files; `npm.cmd run check` reports 0 errors/warnings; `npm.cmd run build` passes with the existing adapter-auto deployment-target notice; Drizzle reports no schema changes and no `0008` migration was generated; `git diff --check` passes.

## Mykyta Investigation Engine — Commit 9 demo batch establishments

- Migration `0008_warm_zarek.sql` additively introduces append-only `investigation_establishments`. A row records that one immutable `AFFECTED_BATCH_LOT` Claim passed `demo-dual-source-human-reviewed-batch` policy `v1` under the server-owned RULE evaluator `demo-batch-establishment-policy-engine`; it is historical policy success, not permanent validity, production authentication, a HumanDecision, or authoritative investigation knowledge.
- The policy is deliberately demo-only. It requires the exact current `BATCH_MISSING` question, KNOWN/MATCH identity, one unique active non-AI Claim with a nonempty normalized lot, and an entirely demo basis. At least two structured Claim Evidence records must provide the policy's source-identifier, integrity-hash, and INTERNAL plus EXTERNAL_PARTY/REGULATOR diversity signals. Those signals do not authenticate a source or prove independence.
- The complete Evidence corpus is every append-only `investigation_evidence` row for the exact case/question. A materially-current, applicable HUMAN SUPPORTED Assessment from the fixed demo operator must cover that exact corpus. Human review and SUPPORTED remain prerequisites rather than truth; AI cannot establish. Rejected/insufficient analysis, contradictions, ambiguity, or multiple active Claims fail closed.
- The server derives and persists all active Claim heads, all structural Assessment heads, all Evidence refs, and both basis versions in one immediate transaction. Callers cannot select the policy or omit inconvenient history. Recording is idempotent and adds only the establishment plus one chronology audit event.
- `evaluateCurrentInvestigationEstablishment` recomputes policy and complete bases without writes. Claim/Assessment supersession, contradictions, new Evidence, basis changes, or any material revision invalidate current eligibility without deleting history; an operational case-version change alone does not invalidate an otherwise identical material basis. No newest-establishment winner is inferred.
- Establishment does not mutate `InvestigationOutcome`, `CaseSnapshot`, case/material versions, lifecycle revisions/commands, decisions, Exposure, Tasks, Closure, or Readiness. The post-resolution challenge seam must be designed before any later authoritative batch-resolution commit, so evidence arriving after `BATCH_MISSING` disappears cannot become stranded.
- Verification: the focused establishment/database suites pass 27/27; the full suite passes 223/223 in 28 files; `npm.cmd run check` reports 0 errors/warnings; `npm.cmd run build` passes with the existing adapter-auto deployment-target notice; clean/repeat/populated-0007 migration and `foreign_key_check` coverage pass; a second Drizzle generation reports no schema changes; `git diff --check` passes.

## Mykyta Investigation Engine — Commit 10 permanent question lineage

- Migration `0009_glamorous_celestials.sql` additively introduces append-only `investigation_questions`. The registry preserves the existing opaque `Issue.id` as `questionRef` and records immutable case/product ownership, the current `AFFECTED_BATCH_LOT` question type, and the first authoritative case/material revision in which case history proves that exact reference appeared as `BATCH_MISSING`.
- Question and Gap are distinct. A Question is permanent factual-question lineage; a Gap is only a current epistemic state in `InvestigationOutcome`. The registry has no mutable status, answer, knowledge state, resolution, or challenge field, and resolved gaps must not be retained artificially.
- Fresh versioned Review registers `BATCH_MISSING` lineage in its existing transaction. Older current cases lazily ensure the same row through authoritative snapshot/history validation in request, Claim, and Assessment writes. The normal migration command also performs explicit candidate reconciliation after migrations; versioned Requests, Claims, Assessments, and Establishments may nominate candidate refs, but only `case_revisions` can prove and register them. Historical Evidence alone is intentionally never a backfill authority.
- New Evidence receipt now requires registered or safely reconcilable case/question/product/demo ownership. A registered question remains valid for direct late Evidence after the current Gap disappears; receipt still creates no Claim, Assessment, Challenge, InvestigationOutcome change, or case/material revision. Existing request ownership checks remain additive to Question ownership.
- `readInvestigationQuestionContext` conservatively returns only `OPEN_GAP` or `NOT_CURRENT`; it does not claim that a non-current question is answered because no explicit resolution linkage exists yet. New Requests, Claims, Assessments, Effective Analysis, and Establishment policy remain current-`BATCH_MISSING` only.
- Registration emits no extra audit event: immutable `case_revisions` already provide authoritative origin chronology. Commit 11 is expected to add an append-only resolved-question Challenge seam before post-resolution Claims/Assessments or authoritative scope resolution are enabled.
- Verification: the full suite passes 239/239 in 29 files; `npm.cmd run check` reports 0 errors/warnings; `npm.cmd run build` passes with the existing adapter-auto deployment-target notice. Clean migration coverage, immediate rerun, populated-0008 upgrade/reconciliation, SQLite constraints, `foreign_key_check`, generated metadata consistency, a second no-op Drizzle generation, and `git diff --check` pass.

## Mykyta Investigation Engine — Commit 11 resolved-question Challenges

- Migration `0010_lying_hellcat.sql` additively introduces append-only `investigation_challenges`. One immutable row represents the HUMAN/demo authorization to re-review one registered `AFFECTED_BATCH_LOT` Question against one exact authoritative material revision; it is not a factual reversal, replacement batch, Claim, Assessment, Establishment, HumanDecision, or lifecycle mutation.
- Opening fails closed unless authoritative `case_revisions` prove continuity from the exact registered `BATCH_MISSING` Question in the immediately preceding material state to the current KNOWN/MATCH identity and KNOWN/BATCH_LOT answer. The first revision carrying the current material answer is persisted as `challengedRevisionId`; operational case-version-only revisions do not break continuity.
- Trigger Evidence is the complete registered case/question corpus whose server-owned `receivedAt` is strictly later than the challenged revision timestamp. The caller must supply that exact canonical set and cannot omit inconvenient late Evidence; `validAsOf` is not used as receipt chronology. Evidence arriving after opening remains append-only Evidence and does not rewrite the historical Challenge row.
- There is at most one Challenge per case/Question/material revision. Challenge identity is caller-supplied and idempotent; exact replay precedes freshness and context checks, while changed immutable input conflicts. `readInvestigationChallengeContext` derives `CURRENT` versus `HISTORICAL` without a mutable status: material revision or authoritative answer-context change makes the row historical, but case-version-only advancement does not.
- Challenge opening uses the fixed `demo_operator` HUMAN identity, appends one chronology audit event, and writes no other state. It is allowed while the case is CLOSED and does not reopen it. At the Commit 11 boundary, Requests, Claims, Assessments, Effective Analysis, and Establishment remained current-`BATCH_MISSING` only.

## Mykyta Investigation Engine — Commit 12 Challenge-scoped writes

- Migration `0011_confused_hannibal_king.sql` additively introduces `investigation_challenge_requests`, `investigation_challenge_claims`, and `investigation_challenge_assessments`. Each immutable join uses the artifact reference as its primary/restrictive foreign key and one restrictive Challenge foreign key; no populated investigation table is altered or rebuilt.
- Evidence Requests, Claims, and Assessments now accept strict, separate `OPEN_GAP` and `OPEN_CHALLENGE` server input shapes. Existing `OPEN_GAP` behavior remains unassociated. A new Challenge write requires the exact registered/current Challenge plus fresh expected case and material revisions inside the artifact's existing immediate transaction.
- Evidence remains permanently owned by case + Question rather than by a Challenge. Request-linked Evidence obtains indirect Challenge provenance through the request association. Direct or otherwise unassociated Evidence is Challenge-relevant only when its `receivedAt` is later than the challenged answer revision; `validAsOf` is not used for this chronology. Evidence exclusively tied to another Challenge request is rejected.
- A Challenge Claim requires at least one Challenge-relevant Evidence item, though baseline Evidence may remain in its complete basis. A Challenge Assessment may reference unassociated baseline Claims plus Claims from the same Challenge, enabling baseline MFT24 versus Challenge MFT25 analysis, but it rejects Claims belonging to another Challenge.
- Claim and Assessment supersession cannot cross association partitions: unassociated history supersedes only unassociated history, and Challenge artifacts supersede only artifacts from that exact Challenge. Replays validate the immutable association and cannot retroactively attach or move an existing artifact.
- Challenge writes remain non-authoritative and non-material. They leave `InvestigationOutcome`, snapshot, case/material versions, lifecycle commands/revisions, HumanDecision, Exposure, Traceability, Tasks, Closure, Readiness, and CLOSED stage unchanged. Establishment remains `OPEN_GAP`-only, and Effective Analysis remains unchanged/current-`BATCH_MISSING`-only until Commit 13 adds a baseline-plus-selected-Challenge read projection.
- Verification: the focused Challenge-write/Request/Claim/Assessment/Challenge/database suite passes 79/79 and the full suite passes 268/268 in 31 files. `npm.cmd run check` reports 0 errors/warnings; `npm.cmd run build` passes with the existing adapter-auto deployment-target notice. Clean/repeat and populated-0010 migration coverage, restrictive association FKs, reset/reseed, reopen persistence, `foreign_key_check`, exact 0010→0011 metadata comparison, a second no-op Drizzle generation, and `git diff --check` pass.
