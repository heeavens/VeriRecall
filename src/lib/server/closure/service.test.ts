import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CaseSnapshot, InvestigationOutcome, TraceabilityRecord } from '../../contracts/recall';
import { confirmedLotOutcome, expandedLotOutcome, unresolvedScopeOutcome } from '../../contracts/recall.fixtures';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { getCasesView } from '../cases/queries';
import { normalExposureRecords, withProduct } from '../exposure/fixtures';
import {
  createRecallService,
  getCaseHistory,
  internalInvestigationAcceptanceContext,
  readCaseSnapshot,
  reserveInvestigationCase
} from '../workflow/case-lifecycle';

let directory: string;
let connection: ReturnType<typeof createDatabaseConnection>;
const context = internalInvestigationAcceptanceContext();
const fixtures = loadDemoFixtures();
const candidate = fixtures.matches.find((match) => !match.hasHardConflict)!;

const readyRecords: TraceabilityRecord[] = [
  { type: 'RECEIPT', sourceRef: 'demo:ready:receipt', productId: confirmedLotOutcome.productId, lot: 'L-2403', occurredAt: '2026-09-07T08:00:00.000Z', demo: true, receiptRef: 'READY-RECEIPT', quantity: 100 },
  { type: 'INVENTORY', sourceRef: 'demo:ready:inventory', productId: confirmedLotOutcome.productId, lot: 'L-2403', occurredAt: '2026-09-07T09:00:00.000Z', demo: true, locationRef: 'warehouse:DUB', quantity: 100 },
  { type: 'SHIPMENT', sourceRef: 'demo:ready:shipment', productId: confirmedLotOutcome.productId, lot: 'L-2403', occurredAt: '2026-09-07T09:10:00.000Z', demo: true, shipmentRef: 'READY-SHIPMENT', destinationRef: 'retailer:DUB', quantity: 0, status: 'RETURNED' },
  { type: 'RETAILER_RESPONSE', sourceRef: 'demo:ready:retailer', productId: confirmedLotOutcome.productId, lot: 'L-2403', occurredAt: '2026-09-07T09:20:00.000Z', demo: true, retailerRef: 'retailer:DUB', quantity: 0 },
  { type: 'SALE', sourceRef: 'demo:ready:sale', productId: confirmedLotOutcome.productId, lot: 'L-2403', occurredAt: '2026-09-07T09:30:00.000Z', demo: true, saleRef: 'READY-SALES', quantity: 0 },
  { type: 'CONTAINMENT', sourceRef: 'demo:ready:containment', productId: confirmedLotOutcome.productId, lot: 'L-2403', occurredAt: '2026-09-07T10:00:00.000Z', demo: true, locationRef: 'warehouse:DUB', quantity: 100 }
];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-closure-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

async function initialized(records: TraceabilityRecord[]) {
  const reserved = reserveInvestigationCase(connection.db, {
    alertId: candidate.alertId,
    productId: candidate.productId
  }, context, new Date('2026-09-07T08:00:00Z'));
  if (!reserved.ok) throw new Error(reserved.error.message);
  let tick = 0;
  const service = createRecallService(connection.db, context, () =>
    new Date(Date.parse('2026-09-07T11:00:00Z') + tick++ * 1000));
  const outcome: InvestigationOutcome = {
    ...structuredClone(confirmedLotOutcome),
    caseId: reserved.snapshot.caseId,
    productId: candidate.productId
  };
  const accepted = await service.execute({
    type: 'ACCEPT_INVESTIGATION', schemaVersion: 1, caseId: outcome.caseId,
    commandId: randomUUID(), expectedCaseVersion: 1, outcome
  });
  if (!accepted.ok) throw new Error(accepted.error.message);
  const calculated = await service.execute({
    type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: outcome.caseId,
    commandId: randomUUID(), expectedCaseVersion: 2, records: withProduct(records, candidate.productId)
  });
  if (!calculated.ok) throw new Error(calculated.error.message);
  return { service, snapshot: calculated.snapshot };
}

async function decideInvestigation(
  service: ReturnType<typeof createRecallService>,
  snapshot: CaseSnapshot
): Promise<CaseSnapshot> {
  let current = snapshot;
  for (const type of ['CONFIRM_IDENTITY', 'CONFIRM_SCOPE'] as const) {
    const decision = current.pendingDecisions.find((item) => item.type === type);
    if (!decision) throw new Error(`Missing ${type}`);
    const result = await service.execute({
      type: 'DECIDE_INVESTIGATION', schemaVersion: 1, caseId: current.caseId,
      commandId: randomUUID(), expectedCaseVersion: current.caseVersion,
      decisionId: decision.id, decision: 'APPROVED', rationale: `Reviewed ${type}.`,
      evidenceRefs: decision.evidenceRefs, demo: true
    });
    if (!result.ok) throw new Error(result.error.message);
    current = result.snapshot;
  }
  return current;
}

async function completeTask(
  service: ReturnType<typeof createRecallService>,
  snapshot: CaseSnapshot,
  taskId: string
): Promise<CaseSnapshot> {
  let current = snapshot;
  let task = current.tasks.find((item) => item.id === taskId)!;
  if (task.approvalStatus === 'PENDING') {
    const approved = await service.execute({
      type: 'DECIDE_ACTION', schemaVersion: 1, caseId: current.caseId,
      commandId: randomUUID(), expectedCaseVersion: current.caseVersion,
      taskId, decision: 'APPROVED', rationale: `Reviewed ${task.type}.`,
      evidenceRefs: task.sourceRefs, demo: true
    });
    if (!approved.ok) throw new Error(approved.error.message);
    current = approved.snapshot;
  }
  const requested = await service.execute({
    type: 'REQUEST_ACTION', schemaVersion: 1, caseId: current.caseId,
    commandId: randomUUID(), expectedCaseVersion: current.caseVersion, taskId, demo: true
  });
  if (!requested.ok) throw new Error(requested.error.message);
  current = requested.snapshot;
  task = current.tasks.find((item) => item.id === taskId)!;
  expect(task).toMatchObject({ status: 'IN_PROGRESS', requestStatus: 'REQUESTED' });
  const result = await service.execute({
    type: 'ATTACH_RESULT', schemaVersion: 1, caseId: current.caseId,
    commandId: randomUUID(), expectedCaseVersion: current.caseVersion, taskId,
    evidenceRefs: [`demo:result:${task.type.toLowerCase()}`],
    summary: `Verified demo result for ${task.type}.`, demo: true
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.snapshot;
}

async function readyForClosure() {
  const initializedCase = await initialized(readyRecords);
  let snapshot = await decideInvestigation(initializedCase.service, initializedCase.snapshot);
  const hold = snapshot.tasks.find((task) => task.type === 'HOLD_STOCK')!;
  snapshot = await completeTask(initializedCase.service, snapshot, hold.id);
  return { service: initializedCase.service, snapshot, hold };
}

describe('human decisions and conservative closure', () => {
  it('records a trusted demo decision with its current basis without changing factual knowledge', async () => {
    const { service, snapshot } = await initialized(normalExposureRecords);
    const identity = snapshot.pendingDecisions.find((item) => item.type === 'CONFIRM_IDENTITY')!;
    expect(identity).toBeDefined();

    const denied = await createRecallService(connection.db, { mode: 'disabled' }).execute({
      type: 'DECIDE_INVESTIGATION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
      decisionId: identity.id, decision: 'APPROVED', rationale: 'Untrusted direct call.',
      evidenceRefs: identity.evidenceRefs, demo: true
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

    const decided = await service.execute({
      type: 'DECIDE_INVESTIGATION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
      decisionId: identity.id, decision: 'APPROVED', rationale: 'Identity evidence reviewed.',
      evidenceRefs: identity.evidenceRefs, demo: true
    });
    expect(decided).toMatchObject({ ok: true, snapshot: { investigation: { knowledgeStatus: 'KNOWN' } } });
    if (!decided.ok) return;
    expect(decided.snapshot.decisions.at(-1)).toMatchObject({
      id: identity.id, type: 'CONFIRM_IDENTITY', status: 'APPROVED',
      subjectRef: snapshot.productId, basisMaterialRevision: 1,
      evidenceRefs: identity.evidenceRefs, actorId: 'demo_operator', actorRole: 'CASE_MANAGER',
      rationale: 'Identity evidence reviewed.', demo: true
    });
    expect(decided.snapshot.decisions.at(-1)?.decidedAt).not.toBeNull();
    expect(decided.snapshot.investigation?.identity.knowledgeStatus).toBe('KNOWN');
  });

  it('does not turn unresolved factual scope into a known fact after human confirmation', async () => {
    const reserved = reserveInvestigationCase(connection.db, {
      alertId: candidate.alertId, productId: candidate.productId
    }, context, new Date('2026-09-07T08:00:00Z'));
    if (!reserved.ok) throw new Error(reserved.error.message);
    const service = createRecallService(connection.db, context, () => new Date('2026-09-07T11:00:00Z'));
    const outcome: InvestigationOutcome = {
      ...structuredClone(unresolvedScopeOutcome), caseId: reserved.snapshot.caseId, productId: candidate.productId
    };
    const accepted = await service.execute({
      type: 'ACCEPT_INVESTIGATION', schemaVersion: 1, caseId: outcome.caseId,
      commandId: randomUUID(), expectedCaseVersion: 1, outcome
    });
    if (!accepted.ok) throw new Error(accepted.error.message);
    const identity = accepted.snapshot.pendingDecisions.find((decision) => decision.type === 'CONFIRM_IDENTITY')!;
    const decided = await service.execute({
      type: 'DECIDE_INVESTIGATION', schemaVersion: 1, caseId: outcome.caseId,
      commandId: randomUUID(), expectedCaseVersion: accepted.snapshot.caseVersion,
      decisionId: identity.id, decision: 'APPROVED', rationale: 'Identity only was reviewed.',
      evidenceRefs: identity.evidenceRefs, demo: true
    });
    expect(decided).toMatchObject({
      ok: true,
      snapshot: {
        stage: 'INVESTIGATING',
        investigation: { knowledgeStatus: 'UNRESOLVED', scope: { knowledgeStatus: 'UNKNOWN' } },
        closure: { status: 'NOT_READY' }
      }
    });
  });

  it('requires current readiness and a fresh closure decision, then closes atomically', async () => {
    const early = await initialized(readyRecords);
    expect(await early.service.execute({
      type: 'REQUEST_CLOSURE', schemaVersion: 1, caseId: early.snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: early.snapshot.caseVersion,
      rationale: 'Attempt before review and verified containment.', evidenceRefs: ['demo:ready:containment'], demo: true
    })).toMatchObject({ ok: false, error: { code: 'CLOSURE_BLOCKED' } });

    let snapshot = await decideInvestigation(early.service, early.snapshot);
    const hold = snapshot.tasks.find((task) => task.type === 'HOLD_STOCK')!;
    snapshot = await completeTask(early.service, snapshot, hold.id);
    const service = early.service;
    expect(snapshot.tasks.find((task) => task.id === hold.id)?.status).toBe('COMPLETED');
    expect(snapshot).toMatchObject({ stage: 'CLOSURE_REVIEW', closure: { status: 'READY_FOR_HUMAN_CLOSURE' } });
    const resultEvidence = snapshot.tasks.find((task) => task.id === hold.id)!.resultEvidenceRefs;
    expect(await service.execute({
      type: 'REQUEST_CLOSURE', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
      rationale: 'Unknown evidence must not authorize closure.', evidenceRefs: ['demo:not-in-this-case'], demo: true
    })).toMatchObject({ ok: false, error: { code: 'EVIDENCE_REQUIRED', currentCaseVersion: snapshot.caseVersion } });
    expect(await service.execute({
      type: 'REQUEST_CLOSURE', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion - 1,
      rationale: 'Stale closure decision.', evidenceRefs: resultEvidence, demo: true
    })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT', currentCaseVersion: snapshot.caseVersion } });

    const closed = await service.execute({
      type: 'REQUEST_CLOSURE', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
      rationale: 'All affected units and current evidence were reviewed.', evidenceRefs: resultEvidence, demo: true
    });
    expect(closed).toMatchObject({ ok: true, snapshot: { stage: 'CLOSED', closure: { status: 'CLOSED' } } });
    if (!closed.ok) return;
    expect(closed.snapshot.decisions.at(-1)).toMatchObject({
      type: 'CLOSE_CASE', status: 'APPROVED', actorId: 'demo_operator', actorRole: 'CASE_MANAGER'
    });
    expect(connection.db.select().from(schema.cases).where(eq(schema.cases.id, snapshot.caseId)).get())
      .toMatchObject({ status: 'closed', closedAt: closed.snapshot.updatedAt });
    expect(getCasesView(connection.db)).toEqual(expect.arrayContaining([expect.objectContaining({
      versionedStage: 'CLOSED', pendingTasks: 0, nextTaskLabel: null
    })]));

    const beforeCase = connection.db.select().from(schema.cases)
      .where(eq(schema.cases.id, closed.snapshot.caseId)).get();
    const beforeHistory = getCaseHistory(connection.db, closed.snapshot.caseId);
    const beforeCommands = connection.db.select().from(schema.caseCommands)
      .where(eq(schema.caseCommands.caseId, closed.snapshot.caseId)).all();
    const beforeAudit = connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.caseId, closed.snapshot.caseId)).all();
    const beforeTraceability = connection.db.select().from(schema.traceabilityRecords)
      .where(eq(schema.traceabilityRecords.caseId, closed.snapshot.caseId)).all();
    const unauthorizedOutcome: InvestigationOutcome = {
      ...structuredClone(expandedLotOutcome),
      caseId: closed.snapshot.caseId,
      productId: candidate.productId
    };
    expect(await createRecallService(connection.db, { mode: 'demo' }).execute({
      type: 'ACCEPT_INVESTIGATION', schemaVersion: 1,
      caseId: closed.snapshot.caseId, commandId: randomUUID(),
      expectedCaseVersion: closed.snapshot.caseVersion,
      outcome: unauthorizedOutcome
    })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(readCaseSnapshot(connection.db, closed.snapshot.caseId)).toEqual(closed.snapshot);
    expect(connection.db.select().from(schema.cases)
      .where(eq(schema.cases.id, closed.snapshot.caseId)).get()).toEqual(beforeCase);
    expect(getCaseHistory(connection.db, closed.snapshot.caseId)).toEqual(beforeHistory);
    expect(connection.db.select().from(schema.caseCommands)
      .where(eq(schema.caseCommands.caseId, closed.snapshot.caseId)).all()).toEqual(beforeCommands);
    expect(connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.caseId, closed.snapshot.caseId)).all()).toEqual(beforeAudit);
    expect(connection.db.select().from(schema.traceabilityRecords)
      .where(eq(schema.traceabilityRecords.caseId, closed.snapshot.caseId)).all())
      .toEqual(beforeTraceability);
  });

  it('keeps factual critical blockers after every generated task is completed', async () => {
    const initializedCase = await initialized(normalExposureRecords);
    let snapshot = await decideInvestigation(initializedCase.service, initializedCase.snapshot);
    for (const task of snapshot.tasks.filter((item) => item.status !== 'SUPERSEDED')) {
      snapshot = await completeTask(initializedCase.service, snapshot, task.id);
    }
    expect(snapshot.tasks.filter((task) => task.status !== 'SUPERSEDED').every((task) => task.status === 'COMPLETED')).toBe(true);
    expect(snapshot.closure).toMatchObject({
      status: 'NOT_READY',
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'ACTIVE_TRANSIT' }),
        expect.objectContaining({ code: 'TRACEABILITY_GAP' })
      ])
    });
    expect(await initializedCase.service.execute({
      type: 'REQUEST_CLOSURE', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
      rationale: 'Tasks are green, but facts are not.', evidenceRefs: ['demo:result:hold_stock'], demo: true
    })).toMatchObject({ ok: false, error: { code: 'CLOSURE_BLOCKED' } });
  });

  it('reopens a closed case on expanded scope and preserves prior decisions and history', async () => {
    const ready = await readyForClosure();
    const resultEvidence = ready.snapshot.tasks.find((task) => task.id === ready.hold.id)!.resultEvidenceRefs;
    const closed = await ready.service.execute({
      type: 'REQUEST_CLOSURE', schemaVersion: 1, caseId: ready.snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: ready.snapshot.caseVersion,
      rationale: 'Close the fully reviewed L-2403 scope.', evidenceRefs: resultEvidence, demo: true
    });
    if (!closed.ok) throw new Error(closed.error.message);
    const oldDecisionIds = closed.snapshot.decisions.map((decision) => decision.id);
    const oldHold = closed.snapshot.tasks.find((task) => task.type === 'HOLD_STOCK')!;
    const expanded: InvestigationOutcome = {
      ...structuredClone(expandedLotOutcome),
      caseId: closed.snapshot.caseId,
      productId: candidate.productId
    };
    const reopened = await ready.service.execute({
      type: 'ACCEPT_INVESTIGATION', schemaVersion: 1, caseId: closed.snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: closed.snapshot.caseVersion, outcome: expanded
    });
    expect(reopened).toMatchObject({
      ok: true,
      snapshot: { stage: 'INVESTIGATING', closure: { status: 'NOT_READY' }, exposure: { status: 'NOT_CALCULATED' } }
    });
    if (!reopened.ok) return;
    expect(reopened.snapshot.decisions.map((decision) => decision.id)).toEqual(oldDecisionIds);
    expect(reopened.snapshot.decisions.every((decision) => decision.status === 'STALE')).toBe(true);
    expect(reopened.snapshot.tasks.find((task) => task.id === oldHold.id)).toMatchObject({
      status: 'SUPERSEDED', approvalStatus: 'STALE'
    });
    expect(reopened.snapshot.pendingDecisions.map((decision) => decision.type).sort()).toEqual([
      'CONFIRM_IDENTITY', 'CONFIRM_SCOPE'
    ]);
    expect(connection.db.select().from(schema.cases).where(eq(schema.cases.id, closed.snapshot.caseId)).get())
      .toMatchObject({ status: 'open', closedAt: null });
    expect(connection.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'case_reopened')).all()).toHaveLength(1);
    expect(getCaseHistory(connection.db, closed.snapshot.caseId).at(-1)?.snapshot.stage).toBe('INVESTIGATING');

    const secondLot: TraceabilityRecord[] = [
      { type: 'RECEIPT', sourceRef: 'demo:expanded:receipt', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T12:00:00.000Z', demo: true, receiptRef: 'EXPANDED-RECEIPT', quantity: 20 },
      { type: 'INVENTORY', sourceRef: 'demo:expanded:inventory', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T12:10:00.000Z', demo: true, locationRef: 'warehouse:DUB', quantity: 20 },
      { type: 'SHIPMENT', sourceRef: 'demo:expanded:shipment', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T12:20:00.000Z', demo: true, shipmentRef: 'EXPANDED-SHIPMENT', destinationRef: 'retailer:DUB', quantity: 0, status: 'RETURNED' },
      { type: 'RETAILER_RESPONSE', sourceRef: 'demo:expanded:retailer', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T12:30:00.000Z', demo: true, retailerRef: 'retailer:DUB', quantity: 0 },
      { type: 'SALE', sourceRef: 'demo:expanded:sale', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T12:40:00.000Z', demo: true, saleRef: 'EXPANDED-SALES', quantity: 0 },
      { type: 'CONTAINMENT', sourceRef: 'demo:expanded:containment', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T12:50:00.000Z', demo: true, locationRef: 'warehouse:DUB', quantity: 20 }
    ];
    const recalculated = await ready.service.execute({
      type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: reopened.snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: reopened.snapshot.caseVersion,
      records: secondLot
    });
    expect(recalculated).toMatchObject({ ok: true, snapshot: { exposure: { received: { value: 120 } } } });
    if (!recalculated.ok) return;
    const activeHolds = recalculated.snapshot.tasks.filter((task) => task.type === 'HOLD_STOCK' && task.status !== 'SUPERSEDED');
    expect(activeHolds).toHaveLength(1);
    expect(activeHolds[0]).toMatchObject({ quantity: { value: 120 }, approvalStatus: 'PENDING' });
    const historyCount = getCaseHistory(connection.db, closed.snapshot.caseId).length;
    const repeated = await ready.service.execute({
      type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: reopened.snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: recalculated.snapshot.caseVersion,
      records: secondLot
    });
    expect(repeated).toMatchObject({ ok: true, replayed: true, snapshot: { caseVersion: recalculated.snapshot.caseVersion } });
    expect(getCaseHistory(connection.db, closed.snapshot.caseId)).toHaveLength(historyCount);
  });

  it('records evidence-only updates after closure without reopening or resetting completed work', async () => {
    const ready = await readyForClosure();
    const resultEvidence = ready.snapshot.tasks.find((task) => task.id === ready.hold.id)!.resultEvidenceRefs;
    const closed = await ready.service.execute({
      type: 'REQUEST_CLOSURE', schemaVersion: 1, caseId: ready.snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: ready.snapshot.caseVersion,
      rationale: 'Close before a newer equivalent observation.', evidenceRefs: resultEvidence, demo: true
    });
    if (!closed.ok) throw new Error(closed.error.message);
    const evidence = {
      type: 'CONTAINMENT' as const, sourceRef: 'demo:ready:containment:newer', productId: candidate.productId,
      lot: 'L-2403', occurredAt: '2026-09-07T13:00:00.000Z', demo: true,
      locationRef: 'warehouse:DUB', quantity: 100
    };
    const updated = await ready.service.execute({
      type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: closed.snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: closed.snapshot.caseVersion, records: [evidence]
    });
    expect(updated).toMatchObject({ ok: true, snapshot: { stage: 'CLOSED', closure: { status: 'CLOSED' } } });
    if (!updated.ok) return;
    expect(updated.snapshot.tasks.find((task) => task.id === ready.hold.id)?.status).toBe('COMPLETED');
    expect(connection.db.select().from(schema.cases).where(eq(schema.cases.id, closed.snapshot.caseId)).get())
      .toMatchObject({ status: 'closed' });
    expect(connection.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'evidence_updated')).all()).toHaveLength(1);
  });

  it('upgrades persisted stage-5 decision JSON only at the storage boundary', async () => {
    const { snapshot } = await initialized(normalExposureRecords);
    const legacy = structuredClone(snapshot) as unknown as Record<string, unknown>;
    delete legacy.decisions;
    legacy.pendingDecisions = (legacy.pendingDecisions as Array<Record<string, unknown>>).map((decision) => {
      const old = { ...decision };
      delete old.uncertaintyRefs;
      delete old.conflictRefs;
      delete old.consequence;
      delete old.actorRole;
      return old;
    });
    connection.db.update(schema.caseLifecycle).set({ snapshotJson: JSON.stringify(legacy) })
      .where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).run();

    const upgraded = readCaseSnapshot(connection.db, snapshot.caseId)!;
    expect(upgraded.decisions).toEqual([]);
    expect(upgraded.pendingDecisions.every((decision) =>
      Array.isArray(decision.uncertaintyRefs) && Array.isArray(decision.conflictRefs) &&
      decision.consequence.length > 0 && decision.actorRole === null
    )).toBe(true);
  });
});
