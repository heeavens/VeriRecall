import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  caseSnapshotSchema, getSnapshotQuerySchema, recallCommandSchema,
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

function lifecycleBlockers(snapshot: CaseSnapshot): Extract<CaseSnapshot['closure'], { status: 'NOT_READY' }>['blockers'] {
  const blockers: Extract<CaseSnapshot['closure'], { status: 'NOT_READY' }>['blockers'] = [
    { id: `${snapshot.caseId}:scope-review`, code: 'SCOPE_UNCONFIRMED', message: 'Identity and scope decisions require server verification. Referenced decisions are not yet verified.', critical: true, subjectRefs: [snapshot.productId], evidenceRefs: [] }
  ];
  if (snapshot.investigation?.knowledgeStatus !== 'KNOWN' || snapshot.investigation.identity.conclusion !== 'MATCH') {
    blockers.push({ id: `${snapshot.caseId}:investigation`, code: 'INVESTIGATION_UNRESOLVED', message: 'The investigation requires review; uncertainty and conflicts remain open.', critical: true, subjectRefs: [snapshot.caseId], evidenceRefs: snapshot.investigation?.evidenceRefs ?? [] });
  }
  if (snapshot.exposure.status === 'NOT_CALCULATED') {
    blockers.unshift({ id: `${snapshot.caseId}:exposure`, code: 'EXPOSURE_NOT_CALCULATED', message: 'Exposure has not been calculated; affected quantities are unknown.', critical: true, subjectRefs: [snapshot.caseId], evidenceRefs: [] });
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
  const projected = {
    schemaVersion: 1, caseId, productId, caseVersion, materialRevision: outcome?.materialRevision ?? null,
    stage: 'INVESTIGATING', updatedAt, investigation: outcome,
    exposure: { status: 'NOT_CALCULATED', basisMaterialRevision: null, calculatedAt: null,
      received: quantity(), warehouse: quantity(), inTransit: quantity(), retailer: quantity(),
      sold: quantity(), unaccounted: quantity(), contained: quantity(), gaps: [], conflicts: [] },
    tasks: [], uncertainties: outcome?.gaps ?? [], conflicts: outcome?.conflicts ?? [],
    attentionItems: [], pendingDecisions: [],
    closure: { status: 'NOT_READY' as const, blockers: [], decisionRef: null }, demo: true
  } satisfies CaseSnapshot;
  const blockers = lifecycleBlockers(projected);
  return finalizeSnapshot(projected, blockers);
}

function finalizeSnapshot(snapshot: CaseSnapshot, blockers = lifecycleBlockers(snapshot)): CaseSnapshot {
  return caseSnapshotSchema.parse({
    ...snapshot,
    attentionItems: blockers,
    closure: { status: 'NOT_READY', blockers, decisionRef: null }
  });
}

function sameTaskCoverage(left: InvestigationOutcome['scope'] | undefined, right: InvestigationOutcome['scope'] | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind !== 'BATCH_LOT' || right.kind !== 'BATCH_LOT') return false;
  return canonical([...left.lots].sort()) === canonical([...right.lots].sort());
}

function carryOrInvalidateTasks(snapshot: CaseSnapshot, previous: CaseSnapshot): CaseSnapshot {
  if (!previous.tasks.length) return snapshot;
  if (sameTaskCoverage(snapshot.investigation?.scope, previous.investigation?.scope)) {
    return finalizeSnapshot({
      ...snapshot,
      tasks: previous.tasks,
      pendingDecisions: previous.pendingDecisions
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
    pendingDecisions: []
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
  command: RecallCommand,
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
  eventMetadata: Record<string, unknown> = {}
) {
  const snapshotJson = JSON.stringify(snapshot);
  database.insert(schema.caseRevisions).values({ id: randomUUID(), caseId: snapshot.caseId,
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
      if (!['ACCEPT_INVESTIGATION', 'CALCULATE_EXPOSURE', 'DECIDE_ACTION', 'REQUEST_ACTION', 'ATTACH_RESULT'].includes(command.type)) {
        return failure('NOT_IMPLEMENTED', 'This command is not implemented in the current lifecycle stage.');
      }
      if (command.type === 'ACCEPT_INVESTIGATION' && !command.outcome.demo) {
        return failure('FORBIDDEN', 'The local demo service does not accept live investigation results.');
      }
      if (command.type === 'CALCULATE_EXPOSURE' && command.records.some((record) => !record.demo)) {
        return failure('FORBIDDEN', 'The local demo service does not accept live traceability records.');
      }
      if ((command.type === 'REQUEST_ACTION' || command.type === 'ATTACH_RESULT') && !command.demo) {
        return failure('FORBIDDEN', 'Task requests and results must be explicitly marked as demo in the local service.');
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
        if (caseRecord.status !== 'open' || current.stage !== 'INVESTIGATING') return failure('INVALID_STATE', 'This stage cannot update or reopen an advanced case.', current.caseVersion);
        const payloadJson = canonical(command);
        const replay = commandReplay(tx, command, current, payloadJson);
        if (replay) return replay;
        if (command.expectedCaseVersion !== current.caseVersion) return failure('VERSION_CONFLICT', 'Refresh the case before retrying.', current.caseVersion);
        const updatedAt = clock().toISOString();
        if (command.type === 'ACCEPT_INVESTIGATION') {
          if (current.materialRevision !== null && command.outcome.materialRevision < current.materialRevision) return failure('STALE_INVESTIGATION', 'An older investigation cannot replace the current revision.', current.caseVersion);
          const sameRevision = command.outcome.materialRevision === current.materialRevision;
          if (sameRevision && canonical(command.outcome) !== canonical(current.investigation)) return failure('IDEMPOTENCY_CONFLICT', 'This investigation revision already has a different payload.', current.caseVersion);
          const projected = sameRevision
            ? current
            : projectSnapshot(command.caseId, current.productId, current.caseVersion + 1, updatedAt, command.outcome);
          const snapshot = sameRevision ? current : carryOrInvalidateTasks(projected, current);
          if (!sameRevision) {
            tx.update(schema.caseLifecycle).set({ caseVersion: snapshot.caseVersion, materialRevision: snapshot.materialRevision,
              snapshotJson: JSON.stringify(snapshot), updatedAt }).where(eq(schema.caseLifecycle.caseId, command.caseId)).run();
            recordRevision(tx, snapshot, caseRecord.alertId, 'investigation_received');
          }
          recordCommand(tx, command, payloadJson, snapshot.caseVersion, updatedAt);
          return { ok: true as const, commandId: command.commandId, replayed: sameRevision, appliedCaseVersion: snapshot.caseVersion, snapshot };
        }

        if (command.type === 'DECIDE_ACTION' || command.type === 'REQUEST_ACTION' || command.type === 'ATTACH_RESULT') {
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
            const approved = command.decision === 'APPROVED';
            nextTask = {
              ...task,
              status: approved ? 'OPEN' : 'CANCELLED',
              statusReason: approved ? null : command.rationale,
              approvalStatus: command.decision,
              decisionRefs: [...new Set([...task.decisionRefs, decision.id])],
              blockedBy: []
            };
            pendingDecisions = current.pendingDecisions.filter((item) => item.id !== decision.id);
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
        const snapshot = finalizeSnapshot({
          ...taskBase,
          tasks: reconciliation.tasks,
          pendingDecisions: reconciliation.pendingDecisions
        });
        tx.update(schema.caseLifecycle).set({
          caseVersion: snapshot.caseVersion,
          snapshotJson: JSON.stringify(snapshot),
          updatedAt
        }).where(eq(schema.caseLifecycle.caseId, command.caseId)).run();
        recordRevision(tx, snapshot, caseRecord.alertId, 'exposure_calculated');
        recordCommand(tx, command, payloadJson, snapshot.caseVersion, updatedAt);
        return { ok: true as const, commandId: command.commandId, replayed: false, appliedCaseVersion: snapshot.caseVersion, snapshot };
      }, { behavior: 'immediate' });
    }
  } satisfies RecallService;
}
