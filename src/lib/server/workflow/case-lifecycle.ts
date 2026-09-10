import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  caseSnapshotSchema, getSnapshotQuerySchema, investigationOutcomeSchema, recallCommandSchema,
  type CaseSnapshot, type CommandResult, type ContractError, type InvestigationOutcome,
  type RecallCommand, type RecallService, type SnapshotResult, traceabilityRecordSchema
} from '../../contracts/recall';
import { calculateExposure } from '../exposure/calculate';
import { reconcileDynamicTasks } from '../tasks/engine';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { nextCaseNumber, severityForRisk } from './case-record';

const reserveSchema = z.strictObject({ alertId: z.string().uuid(), productId: z.string().uuid() });
export interface LifecycleContext { mode: 'demo' | 'disabled' }
const internalInvestigationAcceptanceCapabilityKey: unique symbol = Symbol(
  'internal-investigation-acceptance-capability'
);
const internalInvestigationAcceptanceCapability = Object.freeze({});
type InternalInvestigationAcceptanceContext = LifecycleContext & {
  readonly [internalInvestigationAcceptanceCapabilityKey]:
    typeof internalInvestigationAcceptanceCapability;
};
const actorId = 'demo_operator';
const actorRole = 'CASE_MANAGER';

/**
 * Construct an explicitly trusted, server-only context for legacy lifecycle plumbing.
 * The opaque capability is deliberately non-enumerable and cannot survive JSON serialization.
 */
export function internalInvestigationAcceptanceContext(): LifecycleContext {
  const context: LifecycleContext = { mode: 'demo' };
  Object.defineProperty(context, internalInvestigationAcceptanceCapabilityKey, {
    value: internalInvestigationAcceptanceCapability,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return Object.freeze(context);
}

function canAcceptInvestigationOutcome(context: LifecycleContext): boolean {
  return (context as Partial<InternalInvestigationAcceptanceContext>)[
    internalInvestigationAcceptanceCapabilityKey
  ] === internalInvestigationAcceptanceCapability;
}

function failure(code: ContractError['code'], message: string, currentCaseVersion: number | null = null): { ok: false; error: ContractError } {
  return { ok: false, error: { code, message, currentCaseVersion, issueRefs: [] } };
}

// Sort object keys only; array order remains part of the v1 payload identity.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function lifecycleBlockers(snapshot: CaseSnapshot): Extract<CaseSnapshot['closure'], { status: 'NOT_READY' }>['blockers'] {
  const blockers: Extract<CaseSnapshot['closure'], { status: 'NOT_READY' }>['blockers'] = [];
  const approved = (type: 'CONFIRM_IDENTITY' | 'CONFIRM_SCOPE') => snapshot.decisions.some((decision) =>
    decision.type === type && decision.status === 'APPROVED' &&
    decision.basisMaterialRevision === snapshot.materialRevision &&
    sameTaskCoverage(decision.coverage, snapshot.investigation?.scope)
  );
  if (!approved('CONFIRM_IDENTITY') || !approved('CONFIRM_SCOPE')) {
    blockers.push({ id: `${snapshot.caseId}:scope-review`, code: 'SCOPE_UNCONFIRMED', message: 'Current identity and scope require trusted human decisions.', critical: true, subjectRefs: [snapshot.productId], evidenceRefs: [] });
  }
  if (snapshot.investigation?.knowledgeStatus !== 'KNOWN' || snapshot.investigation.identity.conclusion !== 'MATCH') {
    blockers.push({ id: `${snapshot.caseId}:investigation`, code: 'INVESTIGATION_UNRESOLVED', message: 'The investigation requires review; uncertainty and conflicts remain open.', critical: true, subjectRefs: [snapshot.caseId], evidenceRefs: snapshot.investigation?.evidenceRefs ?? [] });
  }
  if (snapshot.exposure.status === 'NOT_CALCULATED') {
    blockers.unshift({ id: `${snapshot.caseId}:exposure`, code: 'EXPOSURE_NOT_CALCULATED', message: 'Exposure has not been calculated; affected quantities are unknown.', critical: true, subjectRefs: [snapshot.caseId], evidenceRefs: [] });
  }
  if (snapshot.exposure.status === 'CALCULATED' && (
    snapshot.exposure.received.knowledgeStatus !== 'KNOWN' ||
    snapshot.exposure.inTransit.knowledgeStatus !== 'KNOWN' ||
    snapshot.exposure.unaccounted.knowledgeStatus !== 'KNOWN'
  )) {
    blockers.push({
      id: `${snapshot.caseId}:critical-quantities`, code: 'EVIDENCE_MISSING',
      message: 'Current evidence does not establish received, active-transit and unaccounted quantities.',
      critical: true, subjectRefs: [snapshot.caseId],
      evidenceRefs: [
        ...snapshot.exposure.received.sources,
        ...snapshot.exposure.inTransit.sources,
        ...snapshot.exposure.unaccounted.sources
      ].map((item) => item.sourceRef)
    });
  }
  if (snapshot.investigation?.gaps.some((issue) => issue.critical) || snapshot.investigation?.conflicts.length) {
    blockers.push({
      id: `${snapshot.caseId}:investigation-issues`, code: 'INVESTIGATION_UNRESOLVED',
      message: 'Critical investigation uncertainties or conflicts still require resolution.',
      critical: true,
      subjectRefs: [...(snapshot.investigation?.gaps ?? []), ...(snapshot.investigation?.conflicts ?? [])]
        .flatMap((item) => item.subjectRefs),
      evidenceRefs: [...(snapshot.investigation?.gaps ?? []), ...(snapshot.investigation?.conflicts ?? [])]
        .flatMap((item) => item.evidenceRefs)
    });
  }
  if (snapshot.exposure.inTransit.knowledgeStatus === 'KNOWN' && (snapshot.exposure.inTransit.value ?? 0) > 0) {
    blockers.push({ id: `${snapshot.caseId}:active-transit`, code: 'ACTIVE_TRANSIT', message: `${snapshot.exposure.inTransit.value} ITEM remain in active transit.`, critical: true, subjectRefs: [snapshot.caseId], evidenceRefs: snapshot.exposure.inTransit.sources.map((item) => item.sourceRef) });
  }
  if (snapshot.exposure.gaps.length) {
    blockers.push({ id: `${snapshot.caseId}:traceability`, code: 'TRACEABILITY_GAP', message: 'Exposure contains unresolved traceability gaps.', critical: true, subjectRefs: snapshot.exposure.gaps.flatMap((item) => item.subjectRefs), evidenceRefs: snapshot.exposure.gaps.flatMap((item) => item.evidenceRefs) });
  }
  if (snapshot.exposure.conflicts.length) {
    blockers.push({ id: `${snapshot.caseId}:quantity-conflict`, code: 'QUANTITY_CONFLICT', message: 'Exposure contains conflicting quantities.', critical: true, subjectRefs: [snapshot.caseId], evidenceRefs: snapshot.exposure.conflicts.flatMap((item) => item.evidenceRefs) });
  }
  if (snapshot.exposure.status === 'CALCULATED' && snapshot.exposure.received.knowledgeStatus === 'KNOWN' && (
    snapshot.exposure.contained.knowledgeStatus !== 'KNOWN' ||
    (snapshot.exposure.contained.value ?? 0) < (snapshot.exposure.received.value ?? 0)
  )) {
    blockers.push({
      id: `${snapshot.caseId}:containment-evidence`, code: 'EVIDENCE_MISSING',
      message: 'Current evidence does not demonstrate a result for every affected unit.',
      critical: true, subjectRefs: [snapshot.caseId],
      evidenceRefs: snapshot.exposure.contained.sources.map((item) => item.sourceRef)
    });
  }
  const pendingBlockingTasks = snapshot.tasks.filter((task) =>
    task.blocking && !['COMPLETED', 'SUPERSEDED'].includes(task.status)
  );
  if (pendingBlockingTasks.length) {
    blockers.push({
      id: `${snapshot.caseId}:critical-tasks`, code: 'CRITICAL_TASK_PENDING',
      message: `${pendingBlockingTasks.length} blocking task(s) still require a verified result.`,
      critical: true, subjectRefs: pendingBlockingTasks.map((task) => task.id),
      evidenceRefs: pendingBlockingTasks.flatMap((task) => task.resultEvidenceRefs)
    });
  }
  return blockers.map((blocker) => ({
    ...blocker,
    subjectRefs: [...new Set(blocker.subjectRefs)],
    evidenceRefs: [...new Set(blocker.evidenceRefs)]
  }));
}

function inputVersionError(input: unknown): ReturnType<typeof failure> | null {
  if (input && typeof input === 'object' && 'schemaVersion' in input && input.schemaVersion !== 1) {
    return failure('UNSUPPORTED_SCHEMA_VERSION', 'Only contract schemaVersion 1 is supported.');
  }
  return null;
}

export function readCaseSnapshot(database: RecallDatabase, caseId: string): CaseSnapshot | null {
  const row = database.select().from(schema.caseLifecycle).where(eq(schema.caseLifecycle.caseId, caseId)).get();
  if (!row) return null;
  const snapshot = caseSnapshotSchema.parse(upgradeStoredSnapshot(JSON.parse(row.snapshotJson)));
  if (snapshot.caseId !== row.caseId || snapshot.productId !== row.productId ||
      snapshot.caseVersion !== row.caseVersion || snapshot.materialRevision !== row.materialRevision) {
    throw new Error('Stored lifecycle identity or version is inconsistent.');
  }
  return snapshot;
}

export interface StoredCaseRevision {
  revisionId: string;
  caseId: string;
  caseVersion: number;
  materialRevision: number | null;
  actorId: string;
  createdAt: string;
  snapshot: CaseSnapshot;
}

function hydrateCaseRevision(
  row: typeof schema.caseRevisions.$inferSelect
): StoredCaseRevision {
  const snapshot = caseSnapshotSchema.parse(
    upgradeStoredSnapshot(JSON.parse(row.snapshotJson))
  );
  if (
    snapshot.caseId !== row.caseId ||
    snapshot.caseVersion !== row.caseVersion ||
    snapshot.materialRevision !== row.materialRevision
  ) {
    throw new Error('Stored case revision identity or version is inconsistent.');
  }
  return {
    revisionId: row.id,
    caseId: row.caseId,
    caseVersion: row.caseVersion,
    materialRevision: row.materialRevision,
    actorId: row.actorId,
    createdAt: row.createdAt,
    snapshot
  };
}

export function readCaseRevisionById(
  database: RecallDatabase,
  caseId: string,
  revisionId: string
): StoredCaseRevision | null {
  const rows = database.select().from(schema.caseRevisions).where(and(
    eq(schema.caseRevisions.caseId, caseId),
    eq(schema.caseRevisions.id, revisionId)
  )).all();
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('Stored case revision identity is ambiguous.');
  return hydrateCaseRevision(rows[0]);
}

export function readCaseRevisionByCaseVersion(
  database: RecallDatabase,
  caseId: string,
  caseVersion: number
): StoredCaseRevision | null {
  const rows = database.select().from(schema.caseRevisions).where(and(
    eq(schema.caseRevisions.caseId, caseId),
    eq(schema.caseRevisions.caseVersion, caseVersion)
  )).all();
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('Stored case revision version is ambiguous.');
  return hydrateCaseRevision(rows[0]);
}

export function getCaseHistory(database: RecallDatabase, caseId: string) {
  return database.select().from(schema.caseRevisions).where(eq(schema.caseRevisions.caseId, caseId))
    .orderBy(schema.caseRevisions.caseVersion).all().map((row) => ({
      caseVersion: row.caseVersion, materialRevision: row.materialRevision,
      actorId: row.actorId, createdAt: row.createdAt,
      snapshot: caseSnapshotSchema.parse(upgradeStoredSnapshot(JSON.parse(row.snapshotJson)))
    }));
}

function upgradeStoredSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = structuredClone(value) as Record<string, unknown>;
  const upgradeDecision = (item: unknown): unknown => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const decision = item as Record<string, unknown>;
    return {
      ...decision,
      uncertaintyRefs: decision.uncertaintyRefs ?? [],
      conflictRefs: decision.conflictRefs ?? [],
      consequence: decision.consequence ?? 'Legacy demo decision imported for compatibility; review its applicability.',
      actorRole: decision.actorRole ?? null
    };
  };
  snapshot.pendingDecisions = Array.isArray(snapshot.pendingDecisions)
    ? snapshot.pendingDecisions.map(upgradeDecision)
    : snapshot.pendingDecisions;
  snapshot.decisions = Array.isArray(snapshot.decisions)
    ? snapshot.decisions.map(upgradeDecision)
    : [];
  return snapshot;
}

function projectSnapshot(caseId: string, productId: string, caseVersion: number, updatedAt: string, outcome: InvestigationOutcome | null): CaseSnapshot {
  const quantity = (): CaseSnapshot['exposure']['received'] => ({ value: null, unit: 'ITEM', knowledgeStatus: 'UNKNOWN', sources: [], asOf: null });
  const projected: CaseSnapshot = {
    schemaVersion: 1, caseId, productId, caseVersion, materialRevision: outcome?.materialRevision ?? null,
    stage: 'INVESTIGATING', updatedAt, investigation: outcome,
    exposure: { status: 'NOT_CALCULATED', basisMaterialRevision: null, calculatedAt: null,
      received: quantity(), warehouse: quantity(), inTransit: quantity(), retailer: quantity(),
      sold: quantity(), unaccounted: quantity(), contained: quantity(), gaps: [], conflicts: [] },
    tasks: [], uncertainties: outcome?.gaps ?? [], conflicts: outcome?.conflicts ?? [],
    attentionItems: [], pendingDecisions: [], decisions: [],
    closure: { status: 'NOT_READY' as const, blockers: [], decisionRef: null }, demo: true
  };
  if (outcome) {
    const pending: CaseSnapshot['pendingDecisions'] = [
      {
        id: randomUUID(), type: 'CONFIRM_IDENTITY', status: 'PENDING', subjectRef: productId,
        basisCaseVersion: caseVersion, basisMaterialRevision: outcome.materialRevision,
        coverage: outcome.scope, evidenceRefs: outcome.identity.evidenceRefs,
        uncertaintyRefs: outcome.gaps.map((issue) => issue.id),
        conflictRefs: outcome.conflicts.map((issue) => issue.id),
        consequence: 'Approval confirms identity for response planning; it does not change factual knowledge.',
        rationale: 'Review the current identity evidence.', actorId: null, actorRole: null,
        decidedAt: null, demo: true
      },
      {
        id: randomUUID(), type: 'CONFIRM_SCOPE', status: 'PENDING', subjectRef: caseId,
        basisCaseVersion: caseVersion, basisMaterialRevision: outcome.materialRevision,
        coverage: outcome.scope, evidenceRefs: outcome.scope.evidenceRefs,
        uncertaintyRefs: outcome.gaps.map((issue) => issue.id),
        conflictRefs: outcome.conflicts.map((issue) => issue.id),
        consequence: 'Approval confirms the reviewed response boundary; it does not resolve gaps or conflicts.',
        rationale: 'Review the current scope evidence.', actorId: null, actorRole: null,
        decidedAt: null, demo: true
      }
    ];
    projected.pendingDecisions = pending.filter((decision) => decision.evidenceRefs.length > 0);
  }
  return finalizeSnapshot(projected);
}

function finalizeSnapshot(snapshot: CaseSnapshot): CaseSnapshot {
  if (snapshot.stage === 'CLOSED' && snapshot.closure.status === 'CLOSED') {
    return caseSnapshotSchema.parse(snapshot);
  }
  const blockers = lifecycleBlockers(snapshot);
  const reviewsApproved = ['CONFIRM_IDENTITY', 'CONFIRM_SCOPE'].every((type) => snapshot.decisions.some((decision) =>
    decision.type === type && decision.status === 'APPROVED' &&
    decision.basisMaterialRevision === snapshot.materialRevision &&
    sameTaskCoverage(decision.coverage, snapshot.investigation?.scope)
  ));
  const ready = blockers.length === 0;
  return caseSnapshotSchema.parse({
    ...snapshot,
    stage: ready ? 'CLOSURE_REVIEW' : reviewsApproved ? 'RESPONDING' : 'INVESTIGATING',
    attentionItems: blockers,
    closure: ready
      ? { status: 'READY_FOR_HUMAN_CLOSURE', blockers: [], decisionRef: null }
      : { status: 'NOT_READY', blockers, decisionRef: null }
  });
}

function sameTaskCoverage(left: InvestigationOutcome['scope'] | undefined, right: InvestigationOutcome['scope'] | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === 'BATCH_LOT' && right.kind === 'BATCH_LOT') {
    return canonical([...left.lots].sort()) === canonical([...right.lots].sort());
  }
  return left.kind === 'UNRESOLVED' && right.kind === 'UNRESOLVED' &&
    left.knowledgeStatus === right.knowledgeStatus && left.reason === right.reason;
}

function sameRefs(left: string[], right: string[]): boolean {
  return canonical([...left].sort()) === canonical([...right].sort());
}

function applicableActionApproval(snapshot: CaseSnapshot, task: CaseSnapshot['tasks'][number]): boolean {
  return task.decisionRefs.some((decisionRef) => snapshot.decisions.some((decision) =>
    decision.id === decisionRef && decision.type === 'APPROVE_ACTION' && decision.status === 'APPROVED' &&
    sameTaskCoverage(decision.coverage, task.coverage) && sameRefs(decision.evidenceRefs, task.sourceRefs)
  ));
}

function carryOrInvalidateTasks(snapshot: CaseSnapshot, previous: CaseSnapshot): CaseSnapshot {
  const investigationDecisions = snapshot.pendingDecisions.filter((decision) => decision.type !== 'APPROVE_ACTION');
  const sameCoverage = sameTaskCoverage(snapshot.investigation?.scope, previous.investigation?.scope);
  const decisions = previous.decisions.map((decision) =>
    decision.status === 'APPROVED' && (decision.type !== 'APPROVE_ACTION' || !sameCoverage)
      ? {
          ...decision,
          status: 'STALE' as const,
          consequence: 'A newer material revision superseded this decision basis; the historical result remains in prior case revisions.'
        }
      : decision
  );
  if (!previous.tasks.length) return finalizeSnapshot({ ...snapshot, decisions });
  if (sameCoverage) {
    return finalizeSnapshot({
      ...snapshot,
      tasks: previous.tasks,
      pendingDecisions: [
        ...investigationDecisions,
        ...previous.pendingDecisions.filter((decision) => decision.type === 'APPROVE_ACTION')
      ],
      decisions
    });
  }
  return finalizeSnapshot({
    ...snapshot,
    tasks: previous.tasks.map((task) => ({
      ...task,
      status: 'SUPERSEDED',
      statusReason: 'Investigation scope changed; prior coverage must be reviewed.',
      approvalStatus: task.approvalStatus === null ? null : 'STALE',
      decisionRefs: [...new Set([...task.decisionRefs, ...task.blockedBy])],
      blockedBy: []
    })),
    pendingDecisions: investigationDecisions,
    decisions
  });
}

function materialFactKey(snapshot: CaseSnapshot): string {
  const quantity = (value: CaseSnapshot['exposure']['received']) => ({
    knowledgeStatus: value.knowledgeStatus,
    value: value.value,
    unit: value.unit
  });
  return canonical({
    scope: snapshot.investigation?.scope ?? null,
    exposure: {
      received: quantity(snapshot.exposure.received), warehouse: quantity(snapshot.exposure.warehouse),
      inTransit: quantity(snapshot.exposure.inTransit), retailer: quantity(snapshot.exposure.retailer),
      sold: quantity(snapshot.exposure.sold), unaccounted: quantity(snapshot.exposure.unaccounted),
      contained: quantity(snapshot.exposure.contained),
      gaps: snapshot.exposure.gaps.map((issue) => [issue.code, issue.subjectRefs]),
      conflicts: snapshot.exposure.conflicts.map((issue) => [issue.code, issue.subjectRefs])
    },
    tasks: snapshot.tasks.filter((task) => task.status !== 'SUPERSEDED').map((task) => ({
      rule: task.rule, targetRef: task.targetRef, coverage: task.coverage,
      quantity: quantity(task.quantity)
    }))
  });
}

function commandReplay(
  database: RecallDatabase,
  command: RecallCommand,
  current: CaseSnapshot,
  payloadJson: string
): CommandResult | null {
  const previous = database.select().from(schema.caseCommands).where(and(
    eq(schema.caseCommands.caseId, command.caseId),
    eq(schema.caseCommands.commandId, command.commandId)
  )).get();
  if (!previous) return null;
  return previous.payloadJson === payloadJson
    ? { ok: true, commandId: command.commandId, replayed: true, appliedCaseVersion: previous.appliedCaseVersion, snapshot: current }
    : failure('IDEMPOTENCY_CONFLICT', 'The command ID was already used with a different payload.', current.caseVersion);
}

function recordCommand(
  database: RecallDatabase,
  command: Pick<RecallCommand, 'caseId' | 'commandId'>,
  payloadJson: string,
  appliedCaseVersion: number,
  createdAt: string
): void {
  database.insert(schema.caseCommands).values({
    id: randomUUID(), caseId: command.caseId, commandId: command.commandId,
    payloadJson, appliedCaseVersion, createdAt
  }).run();
}

function recordRevision(
  database: RecallDatabase,
  snapshot: CaseSnapshot,
  alertId: string,
  eventType: string,
  eventSummary?: string,
  eventMetadata: Record<string, unknown> = {},
  revisionId = randomUUID()
): string {
  const snapshotJson = JSON.stringify(snapshot);
  database.insert(schema.caseRevisions).values({ id: revisionId, caseId: snapshot.caseId,
    caseVersion: snapshot.caseVersion, materialRevision: snapshot.materialRevision, snapshotJson,
    actorId, createdAt: snapshot.updatedAt }).run();
  database.insert(schema.auditEvents).values({ id: randomUUID(), caseId: snapshot.caseId, alertId,
    eventType, actorType: 'human', actorName: actorId,
    summary: eventSummary ?? (eventType === 'lifecycle_initialized'
      ? 'Initialized a demo investigation case.'
      : eventType === 'exposure_calculated'
        ? 'Calculated demo exposure from persisted traceability records.'
        : 'Saved a demo investigation revision; human decisions remain unverified.'),
    metadataJson: JSON.stringify({
      caseVersion: snapshot.caseVersion,
      materialRevision: snapshot.materialRevision,
      demo: true,
      ...eventMetadata
    }),
    createdAt: snapshot.updatedAt }).run();
  return revisionId;
}

export interface AuthoritativeInvestigationOutcomeTransitionInput {
  current: CaseSnapshot;
  outcome: InvestigationOutcome;
  alertId: string;
  commandId: string;
  commandPayloadJson: string;
  updatedAt: string;
  eventType: string;
  eventSummary?: string;
  eventMetadata?: Record<string, unknown>;
  includeTransitionAuditMetadata?: boolean;
}

export interface AuthoritativeInvestigationOutcomeTransitionResult {
  snapshot: CaseSnapshot;
  resultingRevisionId: string;
  reopened: boolean;
}

/**
 * Apply one material InvestigationOutcome transition inside the caller's transaction.
 * This helper owns the existing lifecycle projection and persistence path; it does not
 * open a transaction and must never be exposed as caller-authored HTTP authority.
 */
export function applyAuthoritativeInvestigationOutcomeInTransaction(
  database: RecallDatabase,
  input: AuthoritativeInvestigationOutcomeTransitionInput
): AuthoritativeInvestigationOutcomeTransitionResult {
  const outcome = investigationOutcomeSchema.parse(input.outcome);
  if (
    outcome.caseId !== input.current.caseId ||
    outcome.productId !== input.current.productId ||
    outcome.materialRevision === input.current.materialRevision
  ) {
    throw new Error('Authoritative investigation transition identity or revision is invalid.');
  }
  const persisted = readCaseSnapshot(database, input.current.caseId);
  if (!persisted || canonical(persisted) !== canonical(input.current)) {
    throw new Error('Authoritative investigation transition source is no longer current.');
  }

  const projected = projectSnapshot(
    input.current.caseId,
    input.current.productId,
    input.current.caseVersion + 1,
    input.updatedAt,
    outcome
  );
  const snapshot = carryOrInvalidateTasks(projected, input.current);
  const reopened = input.current.stage === 'CLOSED';
  if (reopened) {
    database.update(schema.cases).set({ status: 'open', closedAt: null })
      .where(eq(schema.cases.id, input.current.caseId)).run();
  }
  database.update(schema.caseLifecycle).set({
    caseVersion: snapshot.caseVersion,
    materialRevision: snapshot.materialRevision,
    snapshotJson: JSON.stringify(snapshot),
    updatedAt: input.updatedAt
  }).where(eq(schema.caseLifecycle.caseId, input.current.caseId)).run();

  const resultingRevisionId = randomUUID();
  const eventMetadata = input.includeTransitionAuditMetadata
    ? {
        ...(input.eventMetadata ?? {}),
        resultingRevisionId,
        resultingCaseVersion: snapshot.caseVersion,
        resultingMaterialRevision: snapshot.materialRevision,
        reopened
      }
    : (input.eventMetadata ?? {});
  recordRevision(
    database,
    snapshot,
    input.alertId,
    input.eventType,
    input.eventSummary,
    eventMetadata,
    resultingRevisionId
  );
  recordCommand(
    database,
    { caseId: input.current.caseId, commandId: input.commandId },
    input.commandPayloadJson,
    snapshot.caseVersion,
    input.updatedAt
  );
  return { snapshot, resultingRevisionId, reopened };
}

const confirmedReviewInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  productId: z.string().uuid(),
  eventId: z.string().uuid(),
  outcome: investigationOutcomeSchema
}).superRefine((value, validation) => {
  if (value.caseId !== value.outcome.caseId || value.productId !== value.outcome.productId) {
    validation.addIssue({ code: 'custom', message: 'Review integration identity must match its outcome' });
  }
});

/** Apply a confirmed review inside the caller's existing database transaction. */
export function applyConfirmedReviewOutcomeInTransaction(
  database: RecallDatabase,
  input: unknown,
  context: LifecycleContext,
  now = new Date()
): CommandResult {
  if (context.mode !== 'demo') {
    return failure('FORBIDDEN', 'Versioned review integration requires explicit local demo mode.');
  }
  const parsed = confirmedReviewInputSchema.safeParse(input);
  if (!parsed.success) return failure('INVALID_INPUT', 'Invalid confirmed review integration payload.');
  const { caseId, productId, eventId, outcome } = parsed.data;
  const caseRecord = database.select().from(schema.cases).where(eq(schema.cases.id, caseId)).get();
  if (!caseRecord) return failure('NOT_FOUND', 'The confirmed review case does not exist.');
  const confirmedMatch = database.select().from(schema.matches).where(and(
    eq(schema.matches.alertId, caseRecord.alertId),
    eq(schema.matches.productId, productId),
    eq(schema.matches.status, 'confirmed')
  )).get();
  if (!confirmedMatch) {
    return failure('FORBIDDEN', 'A current human-confirmed catalogue match is required.');
  }

  const updatedAt = now.toISOString();
  let current = readCaseSnapshot(database, caseId);
  if (!current) {
    current = projectSnapshot(caseId, productId, 1, updatedAt, null);
    database.insert(schema.caseLifecycle).values({
      caseId, productId, caseVersion: 1, materialRevision: null,
      snapshotJson: JSON.stringify(current), updatedAt
    }).run();
    recordRevision(database, current, caseRecord.alertId, 'lifecycle_initialized',
      'Initialized a versioned case from the confirmed demo review.');
  }
  if (current.productId !== productId) {
    return failure('INVALID_INPUT', 'The confirmed product does not belong to this versioned case.', current.caseVersion);
  }

  const command = {
    type: 'ACCEPT_INVESTIGATION' as const,
    schemaVersion: 1 as const,
    caseId,
    commandId: eventId,
    expectedCaseVersion: 1,
    outcome
  };
  const payloadJson = canonical(command);
  const replay = commandReplay(database, command, current, payloadJson);
  if (replay) return replay;
  if (current.materialRevision !== null) {
    if (outcome.materialRevision < current.materialRevision) {
      return failure('STALE_INVESTIGATION', 'An older review outcome cannot replace the current revision.', current.caseVersion);
    }
    if (outcome.materialRevision === current.materialRevision) {
      if (canonical(outcome) !== canonical(current.investigation)) {
        return failure('IDEMPOTENCY_CONFLICT', 'This review revision already has different content.', current.caseVersion);
      }
      recordCommand(database, command, payloadJson, current.caseVersion, updatedAt);
      return { ok: true, commandId: eventId, replayed: true,
        appliedCaseVersion: current.caseVersion, snapshot: current };
    }
  }
  if (current.caseVersion !== 1 || current.materialRevision !== null) {
    return failure('VERSION_CONFLICT', 'The review bridge only initializes an unversioned or reserved case.', current.caseVersion);
  }

  const snapshot = carryOrInvalidateTasks(
    projectSnapshot(caseId, productId, 2, updatedAt, outcome),
    current
  );
  database.update(schema.caseLifecycle).set({
    caseVersion: snapshot.caseVersion,
    materialRevision: snapshot.materialRevision,
    snapshotJson: JSON.stringify(snapshot),
    updatedAt
  }).where(eq(schema.caseLifecycle.caseId, caseId)).run();
  recordRevision(database, snapshot, caseRecord.alertId, 'investigation_received',
    'Accepted the confirmed review as a versioned demo InvestigationOutcome.',
    { matchId: confirmedMatch.id, integrationEventId: eventId });
  recordCommand(database, command, payloadJson, snapshot.caseVersion, updatedAt);
  return { ok: true, commandId: eventId, replayed: false,
    appliedCaseVersion: snapshot.caseVersion, snapshot };
}

export function reserveInvestigationCase(database: RecallDatabase, input: unknown, context: LifecycleContext, now = new Date()): SnapshotResult {
  if (context.mode !== 'demo') return failure('FORBIDDEN', 'Lifecycle writes require explicit local demo mode.');
  const parsed = reserveSchema.safeParse(input);
  if (!parsed.success) return failure('INVALID_INPUT', 'Expected alertId and productId UUIDs.');
  const { alertId, productId } = parsed.data;
  return database.transaction((tx) => {
    const alert = tx.select().from(schema.alerts).where(eq(schema.alerts.id, alertId)).get();
    const match = tx.select().from(schema.matches).where(and(eq(schema.matches.alertId, alertId), eq(schema.matches.productId, productId))).get();
    if (!alert || !match) return failure('NOT_FOUND', 'The product must be a catalogue candidate for this alert.');
    if (match.status === 'rejected') return failure('INVALID_STATE', 'A rejected candidate cannot initialize an investigation case.');
    const existing = tx.select().from(schema.cases).where(eq(schema.cases.alertId, alertId)).get();
    if (existing) {
      const snapshot = readCaseSnapshot(tx, existing.id);
      if (snapshot?.productId === productId) return { ok: true as const, snapshot };
      return failure('INVALID_STATE', 'This alert already has a legacy or different-product case; automatic conversion is not supported.');
    }
    const caseId = randomUUID();
    const updatedAt = now.toISOString();
    tx.insert(schema.cases).values({ id: caseId, caseNumber: nextCaseNumber(tx), alertId,
      status: 'open', severity: severityForRisk(alert.risk, alert.description), openedAt: updatedAt, closedAt: null }).run();
    const snapshot = projectSnapshot(caseId, productId, 1, updatedAt, null);
    tx.insert(schema.caseLifecycle).values({ caseId, productId, caseVersion: 1, materialRevision: null,
      snapshotJson: JSON.stringify(snapshot), updatedAt }).run();
    recordRevision(tx, snapshot, alertId, 'lifecycle_initialized');
    return { ok: true as const, snapshot };
  }, { behavior: 'immediate' });
}

export function createRecallService(database: RecallDatabase, context: LifecycleContext, clock = () => new Date()) {
  return {
    async getSnapshot(input: unknown): Promise<SnapshotResult> {
      if (context.mode !== 'demo') return failure('FORBIDDEN', 'Explicit local demo mode is required.');
      const versionError = inputVersionError(input);
      if (versionError) return versionError;
      const parsed = getSnapshotQuerySchema.safeParse(input);
      if (!parsed.success) return failure('INVALID_INPUT', 'Invalid snapshot query.');
      const snapshot = readCaseSnapshot(database, parsed.data.caseId);
      return snapshot ? { ok: true, snapshot } : failure('NOT_FOUND', 'No versioned investigation case exists for this ID.');
    },
    async execute(input: unknown): Promise<CommandResult> {
      if (context.mode !== 'demo') return failure('FORBIDDEN', 'Lifecycle writes require explicit local demo mode.');
      const versionError = inputVersionError(input);
      if (versionError) return versionError;
      const header = z.object({ outcome: z.object({ schemaVersion: z.unknown(), scope: z.object({ kind: z.unknown() }) }) }).safeParse(input);
      if (header.success) {
        if (header.data.outcome.schemaVersion !== 1) return failure('UNSUPPORTED_SCHEMA_VERSION', 'Unsupported investigation schema version.');
        if (!['BATCH_LOT', 'UNRESOLVED'].includes(String(header.data.outcome.scope.kind))) return failure('UNSUPPORTED_SCOPE', 'Only BATCH_LOT and UNRESOLVED are supported.');
      }
      const parsed = recallCommandSchema.safeParse(input);
      if (!parsed.success) return failure('INVALID_INPUT', 'Invalid command or mismatched caseId.');
      const command = parsed.data;
      if (
        command.type === 'ACCEPT_INVESTIGATION' &&
        !canAcceptInvestigationOutcome(context)
      ) {
        return failure(
          'FORBIDDEN',
          'Authoritative investigation outcome acceptance is restricted to internal workflow operations.'
        );
      }
      if (!['ACCEPT_INVESTIGATION', 'CALCULATE_EXPOSURE', 'DECIDE_INVESTIGATION', 'DECIDE_ACTION', 'REQUEST_ACTION', 'ATTACH_RESULT', 'REQUEST_CLOSURE'].includes(command.type)) {
        return failure('NOT_IMPLEMENTED', 'This command is not implemented in the current lifecycle stage.');
      }
      if (command.type === 'ACCEPT_INVESTIGATION' && !command.outcome.demo) {
        return failure('FORBIDDEN', 'The local demo service does not accept live investigation results.');
      }
      if (command.type === 'CALCULATE_EXPOSURE' && command.records.some((record) => !record.demo)) {
        return failure('FORBIDDEN', 'The local demo service does not accept live traceability records.');
      }
      if ('demo' in command && !command.demo) {
        return failure('FORBIDDEN', 'Human decisions, task requests and results must be explicitly marked as demo in the local service.');
      }
      return database.transaction((tx) => {
        const current = readCaseSnapshot(tx, command.caseId);
        if (!current) return failure('NOT_FOUND', 'Reserve the investigation case before sending an outcome.');
        const caseRecord = tx.select().from(schema.cases).where(eq(schema.cases.id, command.caseId)).get();
        if (!caseRecord) return failure('NOT_FOUND', 'The case no longer exists.');
        if (command.type === 'ACCEPT_INVESTIGATION' && current.productId !== command.outcome.productId) {
          return failure('INVALID_INPUT', 'The outcome product does not belong to this case.');
        }
        if (command.type === 'CALCULATE_EXPOSURE' && command.records.some((record) => record.productId !== current.productId)) {
          return failure('INVALID_INPUT', 'Every traceability record must belong to the case product.');
        }
        const payloadJson = canonical(command);
        const replay = commandReplay(tx, command, current, payloadJson);
        if (replay) return replay;
        if (command.expectedCaseVersion !== current.caseVersion) return failure('VERSION_CONFLICT', 'Refresh the case before retrying.', current.caseVersion);
        const updatedAt = clock().toISOString();
        if (command.type === 'ACCEPT_INVESTIGATION') {
          if (current.materialRevision !== null && command.outcome.materialRevision < current.materialRevision) return failure('STALE_INVESTIGATION', 'An older investigation cannot replace the current revision.', current.caseVersion);
          const sameRevision = command.outcome.materialRevision === current.materialRevision;
          if (sameRevision && canonical(command.outcome) !== canonical(current.investigation)) return failure('IDEMPOTENCY_CONFLICT', 'This investigation revision already has a different payload.', current.caseVersion);
          if (sameRevision) {
            recordCommand(tx, command, payloadJson, current.caseVersion, updatedAt);
            return { ok: true as const, commandId: command.commandId, replayed: true,
              appliedCaseVersion: current.caseVersion, snapshot: current };
          }
          const transition = applyAuthoritativeInvestigationOutcomeInTransaction(tx, {
            current,
            outcome: command.outcome,
            alertId: caseRecord.alertId,
            commandId: command.commandId,
            commandPayloadJson: payloadJson,
            updatedAt,
            eventType: current.stage === 'CLOSED' ? 'case_reopened' : 'investigation_received',
            eventSummary: current.stage === 'CLOSED'
              ? 'Reopened the case after a new investigation revision; prior decisions and history were retained.'
              : undefined,
            eventMetadata: current.stage === 'CLOSED'
              ? { previousCaseVersion: current.caseVersion }
              : {}
          });
          return { ok: true as const, commandId: command.commandId, replayed: false,
            appliedCaseVersion: transition.snapshot.caseVersion, snapshot: transition.snapshot };
        }

        if (command.type === 'DECIDE_INVESTIGATION') {
          if (current.stage === 'CLOSED') {
            return failure('INVALID_STATE', 'A closed case needs new material data before another investigation decision.', current.caseVersion);
          }
          const decision = current.pendingDecisions.find((item) => item.id === command.decisionId &&
            ['CONFIRM_IDENTITY', 'CONFIRM_SCOPE'].includes(item.type));
          if (!decision) return failure('NOT_FOUND', 'The pending investigation decision does not belong to this case.', current.caseVersion);
          if (decision.basisMaterialRevision !== current.materialRevision ||
              !sameTaskCoverage(decision.coverage, current.investigation?.scope)) {
            return failure('INVALID_STATE', 'The investigation decision is stale for the current scope.', current.caseVersion);
          }
          if (!sameRefs(command.evidenceRefs, decision.evidenceRefs)) {
            return failure('EVIDENCE_REQUIRED', 'Decision evidence must cover the complete reviewed investigation basis.', current.caseVersion);
          }
          const recordedDecision = {
            ...decision,
            status: command.decision,
            evidenceRefs: command.evidenceRefs,
            uncertaintyRefs: current.uncertainties.map((issue) => issue.id),
            conflictRefs: current.conflicts.map((issue) => issue.id),
            consequence: command.decision === 'APPROVED'
              ? decision.consequence
              : 'The reviewed identity or scope is rejected; response progression remains blocked.',
            rationale: command.rationale,
            actorId,
            actorRole,
            decidedAt: updatedAt
          } as const;
          const snapshot = finalizeSnapshot({
            ...current,
            caseVersion: current.caseVersion + 1,
            updatedAt,
            pendingDecisions: current.pendingDecisions.filter((item) => item.id !== decision.id),
            decisions: [...current.decisions, recordedDecision],
            attentionItems: [],
            closure: { status: 'NOT_READY', blockers: [], decisionRef: null }
          });
          tx.update(schema.caseLifecycle).set({
            caseVersion: snapshot.caseVersion,
            snapshotJson: JSON.stringify(snapshot),
            updatedAt
          }).where(eq(schema.caseLifecycle.caseId, command.caseId)).run();
          recordRevision(tx, snapshot, caseRecord.alertId, 'investigation_decided',
            `${command.decision === 'APPROVED' ? 'Approved' : 'Rejected'} ${decision.type} for the current material revision.`,
            { decisionId: decision.id, decision: command.decision, evidenceRefs: command.evidenceRefs });
          recordCommand(tx, command, payloadJson, snapshot.caseVersion, updatedAt);
          return { ok: true as const, commandId: command.commandId, replayed: false,
            appliedCaseVersion: snapshot.caseVersion, snapshot };
        }

        if (command.type === 'REQUEST_CLOSURE') {
          if (current.stage === 'CLOSED') return failure('INVALID_STATE', 'The case is already closed.', current.caseVersion);
          const assessed = finalizeSnapshot(current);
          if (assessed.closure.status !== 'READY_FOR_HUMAN_CLOSURE') {
            return {
              ok: false as const,
              error: {
                code: 'CLOSURE_BLOCKED' as const,
                message: 'The case is not ready for human closure.',
                currentCaseVersion: current.caseVersion,
                issueRefs: assessed.closure.blockers.map((blocker) => blocker.id)
              }
            };
          }
          const knownEvidence = new Set([
            ...(current.investigation?.evidenceRefs ?? []),
            ...current.exposure.received.sources.map((source) => source.sourceRef),
            ...current.exposure.warehouse.sources.map((source) => source.sourceRef),
            ...current.exposure.inTransit.sources.map((source) => source.sourceRef),
            ...current.exposure.retailer.sources.map((source) => source.sourceRef),
            ...current.exposure.sold.sources.map((source) => source.sourceRef),
            ...current.exposure.contained.sources.map((source) => source.sourceRef),
            ...current.tasks.flatMap((task) => task.resultEvidenceRefs),
            ...current.decisions.flatMap((decision) => decision.evidenceRefs)
          ]);
          if (command.evidenceRefs.some((ref) => !knownEvidence.has(ref))) {
            return failure('EVIDENCE_REQUIRED', 'Closure evidence must already belong to this case.', current.caseVersion);
          }
          const requiredResultEvidence = current.tasks
            .filter((task) => task.blocking && task.status === 'COMPLETED')
            .flatMap((task) => task.resultEvidenceRefs);
          if (requiredResultEvidence.some((ref) => !command.evidenceRefs.includes(ref))) {
            return failure('EVIDENCE_REQUIRED', 'Closure evidence must cover every completed blocking result.', current.caseVersion);
          }
          const decisionId = randomUUID();
          const decision = {
            id: decisionId, type: 'CLOSE_CASE' as const, status: 'APPROVED' as const,
            subjectRef: current.caseId, basisCaseVersion: current.caseVersion,
            basisMaterialRevision: current.materialRevision!, coverage: current.investigation!.scope,
            evidenceRefs: command.evidenceRefs,
            uncertaintyRefs: current.uncertainties.map((issue) => issue.id),
            conflictRefs: current.conflicts.map((issue) => issue.id),
            consequence: 'The current reviewed case version is closed; later material facts may reopen it.',
            rationale: command.rationale, actorId, actorRole, decidedAt: updatedAt, demo: true
          };
          const snapshot = caseSnapshotSchema.parse({
            ...assessed,
            caseVersion: current.caseVersion + 1,
            stage: 'CLOSED',
            updatedAt,
            decisions: [...current.decisions, decision],
            closure: { status: 'CLOSED', blockers: [], decisionRef: decisionId }
          });
          tx.update(schema.cases).set({ status: 'closed', closedAt: updatedAt })
            .where(eq(schema.cases.id, command.caseId)).run();
          tx.update(schema.caseLifecycle).set({
            caseVersion: snapshot.caseVersion, snapshotJson: JSON.stringify(snapshot), updatedAt
          }).where(eq(schema.caseLifecycle.caseId, command.caseId)).run();
          recordRevision(tx, snapshot, caseRecord.alertId, 'case_closed',
            'Closed the versioned case after an atomic readiness check and trusted demo decision.',
            { decisionId, rationale: command.rationale, evidenceRefs: command.evidenceRefs });
          recordCommand(tx, command, payloadJson, snapshot.caseVersion, updatedAt);
          return { ok: true as const, commandId: command.commandId, replayed: false,
            appliedCaseVersion: snapshot.caseVersion, snapshot };
        }

        if (command.type === 'DECIDE_ACTION' || command.type === 'REQUEST_ACTION' || command.type === 'ATTACH_RESULT') {
          if (current.stage === 'CLOSED') return failure('INVALID_STATE', 'Closed tasks cannot be changed without a material reopen event.', current.caseVersion);
          const taskIndex = current.tasks.findIndex((task) => task.id === command.taskId);
          if (taskIndex < 0) return failure('NOT_FOUND', 'The task does not belong to this case.', current.caseVersion);
          const task = current.tasks[taskIndex];
          const inactive = ['COMPLETED', 'CANCELLED', 'SUPERSEDED'].includes(task.status);
          if (!inactive && (current.exposure.status !== 'CALCULATED' ||
              current.exposure.basisMaterialRevision !== current.materialRevision ||
              task.basisMaterialRevision !== current.materialRevision)) {
            return failure('INVALID_STATE', 'Recalculate exposure before acting on this task revision.', current.caseVersion);
          }
          let nextTask = task;
          let pendingDecisions = current.pendingDecisions;
          let decisions = current.decisions;
          let eventType: string;
          let eventSummary: string;
          let eventMetadata: Record<string, unknown>;

          if (command.type === 'DECIDE_ACTION') {
            if (!task.approvalRequired || task.approvalStatus !== 'PENDING' || inactive) {
              return failure('INVALID_STATE', 'This task is not awaiting an applicable action decision.', current.caseVersion);
            }
            const decision = current.pendingDecisions.find((item) =>
              item.type === 'APPROVE_ACTION' && item.subjectRef === task.id
            );
            if (!decision) return failure('INVALID_STATE', 'The pending decision is missing or stale.', current.caseVersion);
            if (decision.basisMaterialRevision !== task.basisMaterialRevision ||
                !sameTaskCoverage(decision.coverage, task.coverage)) {
              return failure('INVALID_STATE', 'The pending decision no longer covers this task.', current.caseVersion);
            }
            if (!sameRefs(command.evidenceRefs, task.sourceRefs)) {
              return failure('EVIDENCE_REQUIRED', 'Action decision evidence must cover the complete current task basis.', current.caseVersion);
            }
            const approved = command.decision === 'APPROVED';
            nextTask = {
              ...task,
              status: approved ? task.requestStatus === 'REQUESTED' ? 'IN_PROGRESS' : 'OPEN' : 'CANCELLED',
              statusReason: approved ? null : command.rationale,
              approvalStatus: command.decision,
              decisionRefs: [...new Set([...task.decisionRefs, decision.id])],
              blockedBy: []
            };
            pendingDecisions = current.pendingDecisions.filter((item) => item.id !== decision.id);
            const recordedDecision = {
              ...decision,
              status: command.decision,
              evidenceRefs: command.evidenceRefs,
              uncertaintyRefs: current.uncertainties.map((issue) => issue.id),
              conflictRefs: current.conflicts.map((issue) => issue.id),
              consequence: approved
                ? `A demo request for ${task.type} may now be recorded; the task remains incomplete until result evidence is attached.`
                : `${task.type} is cancelled for this basis; unresolved factual blockers remain visible.`,
              rationale: command.rationale,
              actorId,
              actorRole,
              decidedAt: updatedAt
            } as const;
            decisions = [...current.decisions, recordedDecision];
            eventType = 'dynamic_task_decided';
            eventSummary = `${command.decision === 'APPROVED' ? 'Approved' : 'Rejected'} ${task.type} for ${task.targetRef}; no request or external action was performed.`;
            eventMetadata = {
              taskId: task.id, decisionId: decision.id, decision: command.decision,
              rationale: command.rationale, evidenceRefs: command.evidenceRefs,
              externalSideEffect: false
            };
          } else if (command.type === 'REQUEST_ACTION') {
            if (inactive) return failure('INVALID_STATE', 'An inactive task cannot receive a request.', current.caseVersion);
            if (task.approvalRequired && task.approvalStatus !== 'APPROVED') {
              return failure('INVALID_STATE', 'Record an applicable approval before requesting this action.', current.caseVersion);
            }
            if (task.approvalRequired && !applicableActionApproval(current, task)) {
              return failure('INVALID_STATE', 'The recorded approval is not applicable to the current task basis.', current.caseVersion);
            }
            if (task.requestStatus === 'REQUESTED') {
              recordCommand(tx, command, payloadJson, current.caseVersion, updatedAt);
              return { ok: true as const, commandId: command.commandId, replayed: true, appliedCaseVersion: current.caseVersion, snapshot: current };
            }
            nextTask = { ...task, status: 'IN_PROGRESS', statusReason: null, requestStatus: 'REQUESTED' };
            eventType = 'dynamic_task_request_recorded';
            eventSummary = `Recorded a demo request for ${task.type} at ${task.targetRef}; no external system was contacted.`;
            eventMetadata = { taskId: task.id, externalSideEffect: false };
          } else {
            if (inactive) return failure('INVALID_STATE', 'An inactive task cannot accept another result.', current.caseVersion);
            if (task.requestStatus !== 'REQUESTED') {
              return failure('INVALID_STATE', 'Record the request separately before attaching its result.', current.caseVersion);
            }
            if (task.approvalRequired && task.approvalStatus !== 'APPROVED') {
              return failure('INVALID_STATE', 'The task result is not covered by an applicable approval.', current.caseVersion);
            }
            if (task.approvalRequired && !applicableActionApproval(current, task)) {
              return failure('INVALID_STATE', 'The task approval is stale for the current evidence basis.', current.caseVersion);
            }
            nextTask = {
              ...task,
              status: 'COMPLETED',
              statusReason: null,
              resultEvidenceRefs: [...new Set([...task.resultEvidenceRefs, ...command.evidenceRefs])]
            };
            eventType = 'dynamic_task_result_attached';
            eventSummary = `Attached demo result evidence for ${task.type} at ${task.targetRef}.`;
            eventMetadata = {
              taskId: task.id, evidenceRefs: command.evidenceRefs,
              resultSummary: command.summary, externalSideEffect: false
            };
          }

          const tasks = [...current.tasks];
          tasks[taskIndex] = nextTask;
          const snapshot = finalizeSnapshot({
            ...current,
            caseVersion: current.caseVersion + 1,
            updatedAt,
            tasks,
            pendingDecisions,
            decisions,
            attentionItems: [],
            closure: { status: 'NOT_READY', blockers: [], decisionRef: null }
          });
          tx.update(schema.caseLifecycle).set({
            caseVersion: snapshot.caseVersion,
            snapshotJson: JSON.stringify(snapshot),
            updatedAt
          }).where(eq(schema.caseLifecycle.caseId, command.caseId)).run();
          recordRevision(tx, snapshot, caseRecord.alertId, eventType, eventSummary, eventMetadata);
          recordCommand(tx, command, payloadJson, snapshot.caseVersion, updatedAt);
          return {
            ok: true as const,
            commandId: command.commandId,
            replayed: false,
            appliedCaseVersion: snapshot.caseVersion,
            snapshot
          };
        }

        if (command.type !== 'CALCULATE_EXPOSURE') {
          return failure('NOT_IMPLEMENTED', 'This command is not implemented.', current.caseVersion);
        }

        if (!current.investigation || current.investigation.identity.conclusion !== 'MATCH' ||
            current.investigation.identity.knowledgeStatus !== 'KNOWN' ||
            current.investigation.scope.kind !== 'BATCH_LOT' ||
            current.investigation.scope.knowledgeStatus !== 'KNOWN') {
          return failure('INVALID_STATE', 'Exposure requires a known MATCH identity and known BATCH_LOT scope.', current.caseVersion);
        }

        const prepared: Array<{ record: typeof command.records[number]; recordJson: string }> = [];
        for (const record of command.records) {
          const validated = traceabilityRecordSchema.parse(record);
          const existing = tx.select().from(schema.traceabilityRecords).where(and(
            eq(schema.traceabilityRecords.caseId, command.caseId),
            eq(schema.traceabilityRecords.sourceRef, validated.sourceRef)
          )).get();
          const recordJson = canonical(validated);
          if (existing) {
            if (existing.payloadJson !== recordJson) {
              return failure('IDEMPOTENCY_CONFLICT', `Source ${validated.sourceRef} already has different content.`, current.caseVersion);
            }
            continue;
          }
          prepared.push({ record: validated, recordJson });
        }

        for (const { record, recordJson } of prepared) {
          tx.insert(schema.traceabilityRecords).values({
            id: randomUUID(), caseId: command.caseId, sourceRef: record.sourceRef,
            recordType: record.type, payloadJson: recordJson,
            occurredAt: record.occurredAt, createdAt: updatedAt
          }).run();
        }

        const exposureIsCurrent = current.exposure.status === 'CALCULATED' &&
          current.exposure.basisMaterialRevision === current.materialRevision;
        const records = tx.select().from(schema.traceabilityRecords)
          .where(eq(schema.traceabilityRecords.caseId, command.caseId)).all()
          .map((row) => traceabilityRecordSchema.parse(JSON.parse(row.payloadJson)));
        const exposure = prepared.length === 0 && exposureIsCurrent
          ? current.exposure
          : calculateExposure({
              caseId: current.caseId,
              productId: current.productId,
              materialRevision: current.materialRevision!,
              lots: current.investigation.scope.lots,
              records,
              calculatedAt: updatedAt
            });
        const taskBase: CaseSnapshot = {
          ...current,
          caseVersion: current.caseVersion + 1,
          updatedAt,
          exposure,
          uncertainties: [...current.investigation.gaps, ...exposure.gaps],
          conflicts: [...current.investigation.conflicts, ...exposure.conflicts],
          attentionItems: [],
          closure: { status: 'NOT_READY', blockers: [], decisionRef: null }
        };
        const reconciliation = reconcileDynamicTasks(taskBase, records, updatedAt);
        if (prepared.length === 0 && exposureIsCurrent && !reconciliation.changed) {
          recordCommand(tx, command, payloadJson, current.caseVersion, updatedAt);
          return { ok: true as const, commandId: command.commandId, replayed: true, appliedCaseVersion: current.caseVersion, snapshot: current };
        }
        const assessed = finalizeSnapshot({
          ...taskBase,
          tasks: reconciliation.tasks,
          pendingDecisions: reconciliation.pendingDecisions
        });
        const materiallyChangedAfterClosure = current.stage === 'CLOSED' &&
          materialFactKey(current) !== materialFactKey(assessed);
        const snapshot = current.stage === 'CLOSED' && !materiallyChangedAfterClosure
          ? caseSnapshotSchema.parse({
              ...assessed,
              stage: 'CLOSED',
              closure: current.closure
            })
          : assessed;
        if (materiallyChangedAfterClosure) {
          tx.update(schema.cases).set({ status: 'open', closedAt: null })
            .where(eq(schema.cases.id, command.caseId)).run();
        }
        tx.update(schema.caseLifecycle).set({
          caseVersion: snapshot.caseVersion,
          snapshotJson: JSON.stringify(snapshot),
          updatedAt
        }).where(eq(schema.caseLifecycle.caseId, command.caseId)).run();
        recordRevision(
          tx,
          snapshot,
          caseRecord.alertId,
          materiallyChangedAfterClosure ? 'case_reopened' : current.stage === 'CLOSED' ? 'evidence_updated' : 'exposure_calculated',
          materiallyChangedAfterClosure
            ? 'Reopened the case after new traceability facts changed exposure or required work.'
            : current.stage === 'CLOSED'
              ? 'Recorded new demo evidence without changing material exposure or completed work.'
              : undefined,
          current.stage === 'CLOSED' ? { previousCaseVersion: current.caseVersion } : {}
        );
        recordCommand(tx, command, payloadJson, snapshot.caseVersion, updatedAt);
        return { ok: true as const, commandId: command.commandId, replayed: false, appliedCaseVersion: snapshot.caseVersion, snapshot };
      }, { behavior: 'immediate' });
    }
  } satisfies RecallService;
}
