import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  caseSnapshotSchema, getSnapshotQuerySchema, recallCommandSchema,
  type CaseSnapshot, type CommandResult, type ContractError, type InvestigationOutcome,
  type RecallService, type SnapshotResult
} from '../../contracts/recall';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { nextCaseNumber, severityForRisk } from './case-record';

const reserveSchema = z.strictObject({ alertId: z.string().uuid(), productId: z.string().uuid() });
export interface LifecycleContext { mode: 'demo' | 'disabled' }
const actorId = 'demo_operator';

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

function inputVersionError(input: unknown): ReturnType<typeof failure> | null {
  if (input && typeof input === 'object' && 'schemaVersion' in input && input.schemaVersion !== 1) {
    return failure('UNSUPPORTED_SCHEMA_VERSION', 'Only contract schemaVersion 1 is supported.');
  }
  return null;
}

export function readCaseSnapshot(database: RecallDatabase, caseId: string): CaseSnapshot | null {
  const row = database.select().from(schema.caseLifecycle).where(eq(schema.caseLifecycle.caseId, caseId)).get();
  if (!row) return null;
  const snapshot = caseSnapshotSchema.parse(JSON.parse(row.snapshotJson));
  if (snapshot.caseId !== row.caseId || snapshot.productId !== row.productId ||
      snapshot.caseVersion !== row.caseVersion || snapshot.materialRevision !== row.materialRevision) {
    throw new Error('Stored lifecycle identity or version is inconsistent.');
  }
  return snapshot;
}

export function getCaseHistory(database: RecallDatabase, caseId: string) {
  return database.select().from(schema.caseRevisions).where(eq(schema.caseRevisions.caseId, caseId))
    .orderBy(schema.caseRevisions.caseVersion).all().map((row) => ({
      caseVersion: row.caseVersion, materialRevision: row.materialRevision,
      actorId: row.actorId, createdAt: row.createdAt,
      snapshot: caseSnapshotSchema.parse(JSON.parse(row.snapshotJson))
    }));
}

function projectSnapshot(caseId: string, productId: string, caseVersion: number, updatedAt: string, outcome: InvestigationOutcome | null): CaseSnapshot {
  const quantity = (): CaseSnapshot['exposure']['received'] => ({ value: null, unit: 'ITEM', knowledgeStatus: 'UNKNOWN', sources: [], asOf: null });
  const blockers: Extract<CaseSnapshot['closure'], { status: 'NOT_READY' }>['blockers'] = [
    { id: `${caseId}:exposure`, code: 'EXPOSURE_NOT_CALCULATED', message: 'Exposure has not been calculated; affected quantities are unknown.', critical: true, subjectRefs: [caseId], evidenceRefs: [] },
    { id: `${caseId}:scope-review`, code: 'SCOPE_UNCONFIRMED', message: 'Identity and scope decisions require server verification. Referenced decisions are not yet verified.', critical: true, subjectRefs: [productId], evidenceRefs: [] }
  ];
  if (!outcome || outcome.knowledgeStatus !== 'KNOWN' || outcome.identity.conclusion !== 'MATCH') {
    blockers.push({ id: `${caseId}:investigation`, code: 'INVESTIGATION_UNRESOLVED', message: 'The investigation requires review; uncertainty and conflicts remain open.', critical: true, subjectRefs: [caseId], evidenceRefs: outcome?.evidenceRefs ?? [] });
  }
  return caseSnapshotSchema.parse({
    schemaVersion: 1, caseId, productId, caseVersion, materialRevision: outcome?.materialRevision ?? null,
    stage: 'INVESTIGATING', updatedAt, investigation: outcome,
    exposure: { status: 'NOT_CALCULATED', basisMaterialRevision: null, calculatedAt: null,
      received: quantity(), warehouse: quantity(), inTransit: quantity(), retailer: quantity(),
      sold: quantity(), unaccounted: quantity(), contained: quantity(), gaps: [], conflicts: [] },
    tasks: [], uncertainties: outcome?.gaps ?? [], conflicts: outcome?.conflicts ?? [],
    attentionItems: [...blockers, ...(outcome?.gaps ?? []), ...(outcome?.conflicts ?? [])],
    pendingDecisions: [], closure: { status: 'NOT_READY', blockers, decisionRef: null }, demo: true
  });
}

function recordRevision(database: RecallDatabase, snapshot: CaseSnapshot, alertId: string, eventType: string) {
  const snapshotJson = JSON.stringify(snapshot);
  database.insert(schema.caseRevisions).values({ id: randomUUID(), caseId: snapshot.caseId,
    caseVersion: snapshot.caseVersion, materialRevision: snapshot.materialRevision, snapshotJson,
    actorId, createdAt: snapshot.updatedAt }).run();
  database.insert(schema.auditEvents).values({ id: randomUUID(), caseId: snapshot.caseId, alertId,
    eventType, actorType: 'human', actorName: actorId,
    summary: eventType === 'lifecycle_initialized' ? 'Initialized a demo investigation case.' : 'Saved a demo investigation revision; human decisions remain unverified.',
    metadataJson: JSON.stringify({ caseVersion: snapshot.caseVersion, materialRevision: snapshot.materialRevision, demo: true }),
    createdAt: snapshot.updatedAt }).run();
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
      if (command.type !== 'ACCEPT_INVESTIGATION') return failure('NOT_IMPLEMENTED', 'This stage supports investigation ingestion only.');
      if (!command.outcome.demo) return failure('FORBIDDEN', 'The local demo service does not accept live investigation results.');
      return database.transaction((tx) => {
        const current = readCaseSnapshot(tx, command.caseId);
        if (!current) return failure('NOT_FOUND', 'Reserve the investigation case before sending an outcome.');
        const caseRecord = tx.select().from(schema.cases).where(eq(schema.cases.id, command.caseId)).get();
        if (!caseRecord || current.productId !== command.outcome.productId) return failure('INVALID_INPUT', 'The outcome product does not belong to this case.');
        if (caseRecord.status !== 'open' || current.stage !== 'INVESTIGATING') return failure('INVALID_STATE', 'This stage cannot update or reopen an advanced case.', current.caseVersion);
        const payloadJson = canonical(command);
        const previous = tx.select().from(schema.caseCommands).where(and(eq(schema.caseCommands.caseId, command.caseId), eq(schema.caseCommands.commandId, command.commandId))).get();
        if (previous) {
          return previous.payloadJson === payloadJson
            ? { ok: true as const, commandId: command.commandId, replayed: true, appliedCaseVersion: previous.appliedCaseVersion, snapshot: current }
            : failure('IDEMPOTENCY_CONFLICT', 'The command ID was already used with a different payload.', current.caseVersion);
        }
        if (command.expectedCaseVersion !== current.caseVersion) return failure('VERSION_CONFLICT', 'Refresh the case before retrying.', current.caseVersion);
        if (current.materialRevision !== null && command.outcome.materialRevision < current.materialRevision) return failure('STALE_INVESTIGATION', 'An older investigation cannot replace the current revision.', current.caseVersion);
        const sameRevision = command.outcome.materialRevision === current.materialRevision;
        if (sameRevision && canonical(command.outcome) !== canonical(current.investigation)) return failure('IDEMPOTENCY_CONFLICT', 'This investigation revision already has a different payload.', current.caseVersion);
        const updatedAt = clock().toISOString();
        const snapshot = sameRevision ? current : projectSnapshot(command.caseId, current.productId, current.caseVersion + 1, updatedAt, command.outcome);
        if (!sameRevision) {
          tx.update(schema.caseLifecycle).set({ caseVersion: snapshot.caseVersion, materialRevision: snapshot.materialRevision,
            snapshotJson: JSON.stringify(snapshot), updatedAt }).where(eq(schema.caseLifecycle.caseId, command.caseId)).run();
          recordRevision(tx, snapshot, caseRecord.alertId, 'investigation_received');
        }
        tx.insert(schema.caseCommands).values({ id: randomUUID(), caseId: command.caseId, commandId: command.commandId,
          payloadJson, appliedCaseVersion: snapshot.caseVersion, createdAt: updatedAt }).run();
        return { ok: true as const, commandId: command.commandId, replayed: sameRevision, appliedCaseVersion: snapshot.caseVersion, snapshot };
      }, { behavior: 'immediate' });
    }
  } satisfies RecallService;
}
