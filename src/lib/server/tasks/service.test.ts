import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InvestigationOutcome, TraceabilityRecord } from '../../contracts/recall';
import { confirmedLotOutcome, expandedLotOutcome } from '../../contracts/recall.fixtures';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { getCasesView } from '../cases/queries';
import { normalExposureRecords, withProduct } from '../exposure/fixtures';
import { createRecallService, getCaseHistory, reserveInvestigationCase } from '../workflow/case-lifecycle';

let directory: string;
let connection: ReturnType<typeof createDatabaseConnection>;
const context = { mode: 'demo' as const };
const fixtures = loadDemoFixtures();
const candidate = fixtures.matches.find((match) => !match.hasHardConflict)!;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-task-service-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

async function initialized(records: TraceabilityRecord[] = normalExposureRecords) {
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

describe('versioned dynamic task service', () => {
  it('generates tasks once and keeps them stable on an equivalent recalculation', async () => {
    const { service, snapshot } = await initialized();
    expect(snapshot.tasks.map((task) => task.type).sort()).toEqual([
      'HOLD_STOCK',
      'INTERCEPT_SHIPMENT',
      'INVESTIGATE_TRACEABILITY_GAP',
      'PREPARE_COMMUNICATION'
    ]);
    expect(snapshot.pendingDecisions).toHaveLength(5);
    expect(getCasesView(connection.db)).toEqual(expect.arrayContaining([expect.objectContaining({
      versioned: true,
      completedTasks: 0,
      actionableTasks: 4,
      pendingTasks: 4,
      pendingApprovals: 3,
      nextTaskLabel: 'Hold affected stock at warehouse:DUB'
    })]));
    const ids = snapshot.tasks.map((task) => task.id);
    const repeated = await service.execute({
      type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
      records: withProduct(normalExposureRecords, candidate.productId)
    });
    expect(repeated).toMatchObject({ ok: true, replayed: true, appliedCaseVersion: 3 });
    if (!repeated.ok) return;
    expect(repeated.snapshot.tasks.map((task) => task.id)).toEqual(ids);
    expect(getCaseHistory(connection.db, snapshot.caseId)).toHaveLength(3);
  });

  it('keeps approval, request and evidenced completion as separate transitions', async () => {
    const { service, snapshot } = await initialized();
    const hold = snapshot.tasks.find((task) => task.type === 'HOLD_STOCK')!;
    expect(hold).toMatchObject({ status: 'BLOCKED', approvalStatus: 'PENDING', requestStatus: 'NOT_REQUESTED' });

    const premature = await service.execute({
      type: 'REQUEST_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 3, taskId: hold.id, demo: true
    });
    expect(premature).toMatchObject({ ok: false, error: { code: 'INVALID_STATE', currentCaseVersion: 3 } });

    const unsupportedEvidence = await service.execute({
      type: 'DECIDE_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 3, taskId: hold.id,
      decision: 'APPROVED', rationale: 'Evidence belongs elsewhere.',
      evidenceRefs: ['demo:not-task-basis'], demo: true
    });
    expect(unsupportedEvidence).toMatchObject({ ok: false, error: { code: 'EVIDENCE_REQUIRED', currentCaseVersion: 3 } });

    const approved = await service.execute({
      type: 'DECIDE_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 3, taskId: hold.id,
      decision: 'APPROVED', rationale: 'Warehouse team may receive the reviewed hold instruction.',
      evidenceRefs: hold.sourceRefs, demo: true
    });
    expect(approved).toMatchObject({ ok: true, snapshot: { caseVersion: 4 } });
    if (!approved.ok) return;
    expect(approved.snapshot.tasks.find((task) => task.id === hold.id)).toMatchObject({
      status: 'OPEN', approvalStatus: 'APPROVED', requestStatus: 'NOT_REQUESTED', resultEvidenceRefs: []
    });

    const requestCommand = {
      type: 'REQUEST_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 4, taskId: hold.id, demo: true
    } as const;
    const requested = await service.execute(requestCommand);
    expect(requested).toMatchObject({ ok: true, snapshot: { caseVersion: 5 } });
    if (!requested.ok) return;
    expect(requested.snapshot.tasks.find((task) => task.id === hold.id)).toMatchObject({
      status: 'IN_PROGRESS', requestStatus: 'REQUESTED', resultEvidenceRefs: []
    });
    expect(await service.execute(requestCommand)).toMatchObject({
      ok: true, replayed: true, appliedCaseVersion: 5, snapshot: { caseVersion: 5 }
    });
    expect(getCaseHistory(connection.db, snapshot.caseId)).toHaveLength(5);

    const completed = await service.execute({
      type: 'ATTACH_RESULT', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 5, taskId: hold.id,
      evidenceRefs: ['demo:warehouse:hold-confirmation'], summary: 'Warehouse confirmed the affected lot is physically held.', demo: true
    });
    expect(completed).toMatchObject({ ok: true, snapshot: { caseVersion: 6 } });
    if (!completed.ok) return;
    expect(completed.snapshot.tasks.find((task) => task.id === hold.id)).toMatchObject({
      status: 'COMPLETED', requestStatus: 'REQUESTED', resultEvidenceRefs: ['demo:warehouse:hold-confirmation']
    });
    expect(completed.snapshot.exposure.gaps).toHaveLength(1);
    expect(completed.snapshot.closure.status).toBe('NOT_READY');

    const communication = completed.snapshot.tasks.find((task) => task.type === 'PREPARE_COMMUNICATION')!;
    const rejected = await service.execute({
      type: 'DECIDE_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 6, taskId: communication.id,
      decision: 'REJECTED', rationale: 'Recipient coverage must be corrected before preparing this draft.',
      evidenceRefs: communication.sourceRefs, demo: true
    });
    expect(rejected).toMatchObject({ ok: true, snapshot: { caseVersion: 7 } });
    if (!rejected.ok) return;
    expect(rejected.snapshot.tasks.find((task) => task.id === communication.id)).toMatchObject({
      status: 'CANCELLED', approvalStatus: 'REJECTED',
      statusReason: 'Recipient coverage must be corrected before preparing this draft.'
    });
  });

  it('supersedes a retailer request after current evidence removes the trigger and retains history', async () => {
    const missing = normalExposureRecords.filter((record) => record.type !== 'RETAILER_RESPONSE');
    const { service, snapshot } = await initialized(missing);
    const retailer = snapshot.tasks.find((task) => task.type === 'REQUEST_RETAILER_CONFIRMATION')!;
    expect(retailer).toBeDefined();

    const resolved = await service.execute({
      type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 3,
      records: withProduct(normalExposureRecords.filter((record) => record.type === 'RETAILER_RESPONSE'), candidate.productId)
    });
    expect(resolved).toMatchObject({ ok: true, snapshot: { caseVersion: 4 } });
    if (!resolved.ok) return;
    expect(resolved.snapshot.tasks.find((task) => task.id === retailer.id)).toMatchObject({
      status: 'SUPERSEDED', statusReason: 'The rule trigger is no longer present in the current exposure.'
    });
    const history = getCaseHistory(connection.db, snapshot.caseId);
    expect(history[2].snapshot.tasks.find((task) => task.id === retailer.id)?.status).toBe('BLOCKED');
    expect(history[3].snapshot.tasks.find((task) => task.id === retailer.id)?.status).toBe('SUPERSEDED');
  });

  it('does not reuse completed work or approval after scope expands', async () => {
    const { service, snapshot } = await initialized();
    const oldHold = snapshot.tasks.find((task) => task.type === 'HOLD_STOCK')!;
    const approved = await service.execute({ type: 'DECIDE_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 3, taskId: oldHold.id, decision: 'APPROVED', rationale: 'Approved for L-2403.',
      evidenceRefs: oldHold.sourceRefs, demo: true });
    if (!approved.ok) throw new Error('Approval failed');
    const requested = await service.execute({ type: 'REQUEST_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 4, taskId: oldHold.id, demo: true });
    if (!requested.ok) throw new Error('Request failed');
    const completed = await service.execute({ type: 'ATTACH_RESULT', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 5, taskId: oldHold.id,
      evidenceRefs: ['demo:hold:L-2403'], summary: 'L-2403 held.', demo: true });
    if (!completed.ok) throw new Error('Completion failed');

    const expanded: InvestigationOutcome = {
      ...structuredClone(expandedLotOutcome), caseId: snapshot.caseId, productId: candidate.productId
    };
    const accepted = await service.execute({ type: 'ACCEPT_INVESTIGATION', schemaVersion: 1,
      caseId: snapshot.caseId, commandId: randomUUID(), expectedCaseVersion: 6, outcome: expanded });
    expect(accepted).toMatchObject({ ok: true, snapshot: { caseVersion: 7, exposure: { status: 'NOT_CALCULATED' } } });
    if (!accepted.ok) return;
    expect(accepted.snapshot.tasks.find((task) => task.id === oldHold.id)).toMatchObject({ status: 'SUPERSEDED', approvalStatus: 'STALE' });

    const secondLot: TraceabilityRecord[] = [
      { type: 'RECEIPT', sourceRef: 'demo:receipt:L-2404', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T09:00:00.000Z', demo: true, receiptRef: 'RCV-2404', quantity: 20 },
      { type: 'INVENTORY', sourceRef: 'demo:inventory:L-2404', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T10:00:00.000Z', demo: true, locationRef: 'warehouse:DUB', quantity: 20 },
      { type: 'SHIPMENT', sourceRef: 'demo:shipment:L-2404:none', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T10:00:00.000Z', demo: true, shipmentRef: 'SHIP-2404-NONE', destinationRef: 'retailer:NONE', quantity: 0, status: 'RETURNED' },
      { type: 'RETAILER_RESPONSE', sourceRef: 'demo:retailer:L-2404:none', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T10:00:00.000Z', demo: true, retailerRef: 'retailer:NONE', quantity: 0 },
      { type: 'SALE', sourceRef: 'demo:sale:L-2404:none', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T10:00:00.000Z', demo: true, saleRef: 'SALE-2404-NONE', quantity: 0 }
    ];
    const recalculated = await service.execute({ type: 'CALCULATE_EXPOSURE', schemaVersion: 1,
      caseId: snapshot.caseId, commandId: randomUUID(), expectedCaseVersion: 7, records: secondLot });
    expect(recalculated).toMatchObject({ ok: true, snapshot: { caseVersion: 8 } });
    if (!recalculated.ok) return;
    const newHold = recalculated.snapshot.tasks.find((task) => task.type === 'HOLD_STOCK' && task.status !== 'SUPERSEDED')!;
    expect(newHold.id).not.toBe(oldHold.id);
    expect(newHold).toMatchObject({
      quantity: { value: 60 }, coverage: { kind: 'BATCH_LOT', lots: ['L-2403', 'L-2404'] },
      status: 'BLOCKED', approvalStatus: 'PENDING', resultEvidenceRefs: []
    });
  });

  it('preserves an applicable approval across a new investigation revision with identical coverage', async () => {
    const { service, snapshot } = await initialized();
    const hold = snapshot.tasks.find((task) => task.type === 'HOLD_STOCK')!;
    const approved = await service.execute({ type: 'DECIDE_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 3, taskId: hold.id, decision: 'APPROVED',
      rationale: 'Approved for the unchanged L-2403 coverage.', evidenceRefs: hold.sourceRefs, demo: true });
    if (!approved.ok) throw new Error('Approval failed');
    const revised: InvestigationOutcome = {
      ...structuredClone(confirmedLotOutcome), caseId: snapshot.caseId, productId: candidate.productId,
      materialRevision: 2, updatedAt: '2026-09-07T12:30:00.000Z'
    };
    const accepted = await service.execute({ type: 'ACCEPT_INVESTIGATION', schemaVersion: 1,
      caseId: snapshot.caseId, commandId: randomUUID(), expectedCaseVersion: 4, outcome: revised });
    expect(accepted).toMatchObject({ ok: true, snapshot: { caseVersion: 5, exposure: { status: 'NOT_CALCULATED' } } });
    if (!accepted.ok) return;
    expect(accepted.snapshot.tasks.find((task) => task.id === hold.id)).toMatchObject({
      status: 'OPEN', approvalStatus: 'APPROVED'
    });
    expect(await service.execute({ type: 'REQUEST_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 5, taskId: hold.id, demo: true }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });

    const recalculated = await service.execute({ type: 'CALCULATE_EXPOSURE', schemaVersion: 1,
      caseId: snapshot.caseId, commandId: randomUUID(), expectedCaseVersion: 5,
      records: withProduct(normalExposureRecords, candidate.productId) });
    expect(recalculated).toMatchObject({ ok: true, snapshot: { caseVersion: 6 } });
    if (!recalculated.ok) return;
    expect(recalculated.snapshot.tasks.find((task) => task.id === hold.id)).toMatchObject({
      status: 'OPEN', approvalStatus: 'APPROVED', basisMaterialRevision: 2
    });
  });

  it('rejects stale, foreign and invalid task transitions without mutation', async () => {
    const { service, snapshot } = await initialized();
    const hold = snapshot.tasks.find((task) => task.type === 'HOLD_STOCK')!;
    const before = connection.db.select().from(schema.caseLifecycle).get()!;
    expect(await service.execute({ type: 'DECIDE_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 2, taskId: hold.id, decision: 'APPROVED', rationale: 'Stale.',
      evidenceRefs: hold.sourceRefs, demo: true }))
      .toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await service.execute({ type: 'ATTACH_RESULT', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 3, taskId: randomUUID(), evidenceRefs: ['demo:x'], summary: 'Wrong task.', demo: true }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await service.execute({ type: 'ATTACH_RESULT', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 3, taskId: hold.id, evidenceRefs: ['demo:x'], summary: 'Too early.', demo: true }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    expect(connection.db.select().from(schema.caseLifecycle).get()).toEqual(before);
  });
});
