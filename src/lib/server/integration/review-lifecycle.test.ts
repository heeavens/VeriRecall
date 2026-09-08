import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InvestigationOutcome, TraceabilityRecord } from '../../contracts/recall';
import { getCaseDetail } from '../cases/queries';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { confirmReviewMatch, legacyReviewCaseMode } from '../workflow/review';
import { createRecallService, getCaseHistory, readCaseSnapshot } from '../workflow/case-lifecycle';

let directory: string;
let connection: ReturnType<typeof createDatabaseConnection>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-review-lifecycle-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, loadDemoFixtures());
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('review to versioned case integration', () => {
  it('upgrades an already-confirmed legacy case and reports the lifecycle change once', () => {
    const input = { matchId: '50000000-0000-4000-8000-000000000001', actorName: 'Herman' };
    const legacy = confirmReviewMatch(
      connection.db,
      input,
      new Date('2026-09-08T11:00:00Z'),
      legacyReviewCaseMode
    );
    const upgraded = confirmReviewMatch(
      connection.db,
      input,
      new Date('2026-09-08T11:01:00Z'),
      { mode: 'demo' }
    );
    const repeated = confirmReviewMatch(
      connection.db,
      input,
      new Date('2026-09-08T11:02:00Z'),
      { mode: 'demo' }
    );

    expect(legacy).toMatchObject({ changed: true, versioned: false, lifecycleChanged: false });
    expect(upgraded).toMatchObject({
      caseId: legacy.caseId,
      changed: false,
      versioned: true,
      lifecycleChanged: true
    });
    expect(repeated).toMatchObject({
      caseId: legacy.caseId,
      changed: false,
      versioned: true,
      lifecycleChanged: false
    });
    expect(readCaseSnapshot(connection.db, legacy.caseId)).toMatchObject({
      caseVersion: 2,
      materialRevision: 1,
      stage: 'INVESTIGATING'
    });
  });

  it('turns a confirmed real review match into a persisted InvestigationOutcome and snapshot once', () => {
    const input = { matchId: '50000000-0000-4000-8000-000000000001', actorName: 'Herman' };
    const first = confirmReviewMatch(
      connection.db,
      input,
      new Date('2026-09-08T12:00:00Z'),
      { mode: 'demo' }
    );
    const repeated = confirmReviewMatch(
      connection.db,
      input,
      new Date('2026-09-08T12:05:00Z'),
      { mode: 'demo' }
    );

    expect(first).toMatchObject({ changed: true, versioned: true, caseNumber: 'CASE-0001' });
    expect(repeated).toMatchObject({ changed: false, versioned: true, caseId: first.caseId });
    expect(readCaseSnapshot(connection.db, first.caseId)).toMatchObject({
      caseVersion: 2,
      materialRevision: 1,
      stage: 'INVESTIGATING',
      investigation: {
        knowledgeStatus: 'KNOWN',
        identity: { knowledgeStatus: 'KNOWN', conclusion: 'MATCH' },
        scope: { kind: 'BATCH_LOT', knowledgeStatus: 'KNOWN', lots: ['MFT24'] }
      },
      exposure: { status: 'NOT_CALCULATED', received: { value: null } }
    });
    expect(getCaseHistory(connection.db, first.caseId)).toHaveLength(2);
    expect(connection.db.select().from(schema.caseCommands)
      .where(eq(schema.caseCommands.caseId, first.caseId)).all()).toHaveLength(1);
    expect(connection.db.select().from(schema.caseTasks)
      .where(eq(schema.caseTasks.caseId, first.caseId)).all()).toHaveLength(0);
    expect(connection.db.select().from(schema.caseItems)
      .where(eq(schema.caseItems.caseId, first.caseId)).all()).toHaveLength(0);
  });

  it('keeps missing versioned scope isolated from legacy case items and exposure', async () => {
    const matchId = '50000000-0000-4000-8000-000000000001';
    const match = connection.db.select().from(schema.matches)
      .where(eq(schema.matches.id, matchId)).get()!;
    connection.db.update(schema.alerts).set({ batch: null })
      .where(eq(schema.alerts.id, match.alertId)).run();
    connection.db.update(schema.products).set({ batch: null })
      .where(eq(schema.products.id, match.productId)).run();

    const result = confirmReviewMatch(
      connection.db,
      { matchId, actorName: 'Herman' },
      new Date('2026-09-08T12:00:00Z'),
      { mode: 'demo' }
    );
    const snapshot = readCaseSnapshot(connection.db, result.caseId)!;

    expect(snapshot).toMatchObject({
      investigation: {
        knowledgeStatus: 'UNRESOLVED',
        identity: { knowledgeStatus: 'KNOWN', conclusion: 'MATCH' },
        scope: { kind: 'UNRESOLVED', knowledgeStatus: 'UNKNOWN' }
      },
      exposure: { status: 'NOT_CALCULATED' },
      tasks: []
    });
    expect(connection.db.select().from(schema.caseItems)
      .where(eq(schema.caseItems.caseId, result.caseId)).all()).toHaveLength(0);
    expect(getCaseDetail(connection.db, result.caseId)?.customers).toEqual([]);

    const service = createRecallService(
      connection.db,
      { mode: 'demo' },
      () => new Date('2026-09-08T12:30:00Z')
    );
    expect(await service.execute({
      type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: result.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
      records: [{
        type: 'RECEIPT', sourceRef: 'demo:scope-isolation:receipt',
        productId: match.productId, lot: 'MFT24', occurredAt: '2026-09-08T10:00:00.000Z',
        demo: true, receiptRef: 'SCOPE-ISOLATION-RECEIPT', quantity: 1
      }]
    })).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    expect(readCaseSnapshot(connection.db, result.caseId)).toEqual(snapshot);
    expect(connection.db.select().from(schema.traceabilityRecords)
      .where(eq(schema.traceabilityRecords.caseId, result.caseId)).all()).toHaveLength(0);
  });

  it('ignores a retained legacy Unknown item after upgrading the case', () => {
    const matchId = '50000000-0000-4000-8000-000000000001';
    const match = connection.db.select().from(schema.matches)
      .where(eq(schema.matches.id, matchId)).get()!;
    connection.db.update(schema.alerts).set({ batch: null })
      .where(eq(schema.alerts.id, match.alertId)).run();
    connection.db.update(schema.products).set({ batch: null })
      .where(eq(schema.products.id, match.productId)).run();

    const legacy = confirmReviewMatch(
      connection.db,
      { matchId, actorName: 'Herman' },
      new Date('2026-09-08T12:00:00Z'),
      legacyReviewCaseMode
    );
    const legacyItems = connection.db.select().from(schema.caseItems)
      .where(eq(schema.caseItems.caseId, legacy.caseId)).all();
    expect(legacyItems).toEqual([expect.objectContaining({ batch: 'Unknown' })]);
    expect(getCaseDetail(connection.db, legacy.caseId)?.customers).toHaveLength(3);

    confirmReviewMatch(
      connection.db,
      { matchId, actorName: 'Herman' },
      new Date('2026-09-08T12:01:00Z'),
      { mode: 'demo' }
    );
    const snapshotBeforeRead = readCaseSnapshot(connection.db, legacy.caseId);

    expect(snapshotBeforeRead).toMatchObject({
      investigation: {
        identity: { knowledgeStatus: 'KNOWN', conclusion: 'MATCH' },
        scope: { kind: 'UNRESOLVED', knowledgeStatus: 'UNKNOWN' }
      }
    });
    expect(getCaseDetail(connection.db, legacy.caseId)?.customers).toEqual([]);
    expect(connection.db.select().from(schema.caseItems)
      .where(eq(schema.caseItems.caseId, legacy.caseId)).all()).toEqual(legacyItems);
    expect(readCaseSnapshot(connection.db, legacy.caseId)).toEqual(snapshotBeforeRead);
  });

  it('retains the Unknown wildcard projection for a purely legacy case', () => {
    const matchId = '50000000-0000-4000-8000-000000000001';
    const match = connection.db.select().from(schema.matches)
      .where(eq(schema.matches.id, matchId)).get()!;
    connection.db.update(schema.alerts).set({ batch: null })
      .where(eq(schema.alerts.id, match.alertId)).run();
    connection.db.update(schema.products).set({ batch: null })
      .where(eq(schema.products.id, match.productId)).run();

    const legacy = confirmReviewMatch(
      connection.db,
      { matchId, actorName: 'Herman' },
      new Date('2026-09-08T12:00:00Z'),
      legacyReviewCaseMode
    );

    expect(connection.db.select().from(schema.caseItems)
      .where(eq(schema.caseItems.caseId, legacy.caseId)).all())
      .toEqual([expect.objectContaining({ batch: 'Unknown' })]);
    expect(getCaseDetail(connection.db, legacy.caseId)?.customers)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ batch: 'MFT24', productId: match.productId })
      ]));
    expect(getCaseDetail(connection.db, legacy.caseId)?.customers).toHaveLength(3);
  });

  it('records a strong heuristic Review confirmation without claiming known identity', () => {
    const matchId = '50000000-0000-4000-8000-000000000001';
    const match = connection.db.select().from(schema.matches)
      .where(eq(schema.matches.id, matchId)).get()!;
    connection.db.update(schema.alerts).set({ ean: null })
      .where(eq(schema.alerts.id, match.alertId)).run();
    connection.db.update(schema.products).set({ ean: null })
      .where(eq(schema.products.id, match.productId)).run();
    connection.db.update(schema.matches).set({
      totalScore: 55,
      nameScore: 25,
      brandScore: 20,
      eanScore: 0,
      batchScore: 10,
      hasHardConflict: false
    }).where(eq(schema.matches.id, matchId)).run();

    const result = confirmReviewMatch(
      connection.db,
      { matchId, actorName: 'Herman' },
      new Date('2026-09-08T12:00:00Z'),
      { mode: 'demo' }
    );
    const snapshot = readCaseSnapshot(connection.db, result.caseId);

    expect(result).toMatchObject({ changed: true, versioned: true, lifecycleChanged: true });
    expect(snapshot).toMatchObject({
      stage: 'INVESTIGATING',
      investigation: {
        knowledgeStatus: 'UNRESOLVED',
        identity: {
          knowledgeStatus: 'UNKNOWN',
          conclusion: 'UNRESOLVED',
          decisionRefs: [`demo:review-decision:${matchId}`]
        },
        scope: { kind: 'BATCH_LOT', knowledgeStatus: 'KNOWN', lots: ['MFT24'] }
      },
      exposure: { status: 'NOT_CALCULATED' },
      closure: {
        status: 'NOT_READY',
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: 'INVESTIGATION_UNRESOLVED' })
        ])
      }
    });
    expect(connection.db.select().from(schema.matches).where(eq(schema.matches.id, matchId)).get())
      .toMatchObject({ status: 'confirmed' });
  });

  it('keeps source conflicts and unknown scope visible after the review confirmation', () => {
    const result = confirmReviewMatch(
      connection.db,
      { matchId: '50000000-0000-4000-8000-000000000002', actorName: 'Herman' },
      new Date('2026-09-08T12:00:00Z'),
      { mode: 'demo' }
    );
    const snapshot = readCaseSnapshot(connection.db, result.caseId);

    expect(snapshot).toMatchObject({
      investigation: {
        knowledgeStatus: 'CONFLICTED',
        identity: { knowledgeStatus: 'CONFLICTED', conclusion: 'UNRESOLVED' },
        scope: { kind: 'UNRESOLVED', knowledgeStatus: 'UNKNOWN' },
        gaps: [expect.objectContaining({ code: 'BATCH_MISSING', critical: true })],
        conflicts: [expect.objectContaining({ code: 'EAN_CONFLICT', critical: true })]
      },
      stage: 'INVESTIGATING',
      closure: { status: 'NOT_READY' }
    });
    expect(snapshot?.exposure.received.value).toBeNull();
  });

  it('carries the real review snapshot through actions, blocked closure and expanded scope', async () => {
    const confirmed = confirmReviewMatch(
      connection.db,
      { matchId: '50000000-0000-4000-8000-000000000001', actorName: 'Herman' },
      new Date('2026-09-08T12:00:00Z'),
      { mode: 'demo' }
    );
    const service = createRecallService(connection.db, { mode: 'demo' }, () => new Date('2026-09-08T12:30:00Z'));
    const productId = readCaseSnapshot(connection.db, confirmed.caseId)!.productId;
    const records: TraceabilityRecord[] = [
      { type: 'RECEIPT', sourceRef: 'demo:integration:receipt', productId, lot: 'MFT24', occurredAt: '2026-09-08T10:00:00.000Z', demo: true, receiptRef: 'INT-RECEIPT', quantity: 50 },
      { type: 'INVENTORY', sourceRef: 'demo:integration:inventory', productId, lot: 'MFT24', occurredAt: '2026-09-08T10:10:00.000Z', demo: true, locationRef: 'warehouse:demo', quantity: 30 },
      { type: 'SHIPMENT', sourceRef: 'demo:integration:shipment', productId, lot: 'MFT24', occurredAt: '2026-09-08T10:20:00.000Z', demo: true, shipmentRef: 'INT-SHIP', destinationRef: 'retailer:demo', quantity: 10, status: 'IN_TRANSIT' },
      { type: 'SALE', sourceRef: 'demo:integration:sale', productId, lot: 'MFT24', occurredAt: '2026-09-08T10:30:00.000Z', demo: true, saleRef: 'INT-SALE', quantity: 0 },
      { type: 'CONTAINMENT', sourceRef: 'demo:integration:containment', productId, lot: 'MFT24', occurredAt: '2026-09-08T10:40:00.000Z', demo: true, locationRef: 'warehouse:demo', quantity: 30 }
    ];
    let result = await service.execute({
      type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: confirmed.caseId,
      commandId: randomUUID(), expectedCaseVersion: 2, records
    });
    if (!result.ok) throw new Error(result.error.message);
    let snapshot = result.snapshot;
    for (const type of ['CONFIRM_IDENTITY', 'CONFIRM_SCOPE'] as const) {
      const decision = snapshot.pendingDecisions.find((item) => item.type === type)!;
      result = await service.execute({
        type: 'DECIDE_INVESTIGATION', schemaVersion: 1, caseId: snapshot.caseId,
        commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
        decisionId: decision.id, decision: 'APPROVED', rationale: `Reviewed ${type}.`,
        evidenceRefs: decision.evidenceRefs, demo: true
      });
      if (!result.ok) throw new Error(result.error.message);
      snapshot = result.snapshot;
    }
    const oldHold = snapshot.tasks.find((task) => task.type === 'HOLD_STOCK')!;
    result = await service.execute({
      type: 'DECIDE_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
      taskId: oldHold.id, decision: 'APPROVED', rationale: 'Approve current demo stock hold.',
      evidenceRefs: oldHold.sourceRefs, demo: true
    });
    if (!result.ok) throw new Error(result.error.message);
    snapshot = result.snapshot;
    result = await service.execute({
      type: 'REQUEST_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
      taskId: oldHold.id, demo: true
    });
    if (!result.ok) throw new Error(result.error.message);
    snapshot = result.snapshot;
    expect(snapshot.tasks.find((task) => task.id === oldHold.id)).toMatchObject({
      requestStatus: 'REQUESTED', status: 'IN_PROGRESS'
    });
    expect(await service.execute({
      type: 'REQUEST_CLOSURE', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
      rationale: 'Attempt closure while transit and traceability remain unresolved.',
      evidenceRefs: ['demo:integration:containment'], demo: true
    })).toMatchObject({ ok: false, error: { code: 'CLOSURE_BLOCKED' } });
    result = await service.execute({
      type: 'ATTACH_RESULT', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
      taskId: oldHold.id, evidenceRefs: ['demo:integration:hold-result'],
      summary: 'Demo warehouse confirmed the hold.', demo: true
    });
    if (!result.ok) throw new Error(result.error.message);
    snapshot = result.snapshot;
    expect(snapshot.closure).toMatchObject({
      status: 'NOT_READY',
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'ACTIVE_TRANSIT' }),
        expect.objectContaining({ code: 'TRACEABILITY_GAP' })
      ])
    });

    const currentOutcome = snapshot.investigation!;
    const expanded: InvestigationOutcome = {
      ...structuredClone(currentOutcome),
      materialRevision: 2,
      updatedAt: '2026-09-08T13:00:00.000Z',
      scope: {
        kind: 'BATCH_LOT', knowledgeStatus: 'KNOWN', lots: ['MFT24', 'MFT25'],
        evidenceRefs: ['demo:integration:scope-expanded'], decisionRefs: []
      },
      evidenceRefs: [
        ...currentOutcome.identity.evidenceRefs,
        'demo:integration:scope-expanded'
      ]
    };
    result = await service.execute({
      type: 'ACCEPT_INVESTIGATION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion, outcome: expanded
    });
    if (!result.ok) throw new Error(result.error.message);
    snapshot = result.snapshot;
    expect(snapshot.tasks.find((task) => task.id === oldHold.id)).toMatchObject({
      status: 'SUPERSEDED', approvalStatus: 'STALE'
    });
    const secondLot: TraceabilityRecord[] = [
      { type: 'RECEIPT', sourceRef: 'demo:integration:receipt-2', productId, lot: 'MFT25', occurredAt: '2026-09-08T13:10:00.000Z', demo: true, receiptRef: 'INT-RECEIPT-2', quantity: 5 },
      { type: 'INVENTORY', sourceRef: 'demo:integration:inventory-2', productId, lot: 'MFT25', occurredAt: '2026-09-08T13:20:00.000Z', demo: true, locationRef: 'warehouse:demo', quantity: 5 },
      { type: 'SHIPMENT', sourceRef: 'demo:integration:shipment-2', productId, lot: 'MFT25', occurredAt: '2026-09-08T13:30:00.000Z', demo: true, shipmentRef: 'INT-SHIP-2', destinationRef: 'retailer:demo', quantity: 0, status: 'RETURNED' },
      { type: 'RETAILER_RESPONSE', sourceRef: 'demo:integration:retailer-2', productId, lot: 'MFT25', occurredAt: '2026-09-08T13:40:00.000Z', demo: true, retailerRef: 'retailer:demo', quantity: 0 },
      { type: 'SALE', sourceRef: 'demo:integration:sale-2', productId, lot: 'MFT25', occurredAt: '2026-09-08T13:50:00.000Z', demo: true, saleRef: 'INT-SALE-2', quantity: 0 },
      { type: 'CONTAINMENT', sourceRef: 'demo:integration:containment-2', productId, lot: 'MFT25', occurredAt: '2026-09-08T14:00:00.000Z', demo: true, locationRef: 'warehouse:demo', quantity: 0 }
    ];
    result = await service.execute({
      type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion, records: secondLot
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.snapshot.exposure.received.value).toBe(55);
    expect(result.snapshot.tasks.filter((task) =>
      task.type === 'HOLD_STOCK' && task.status !== 'SUPERSEDED'
    )).toEqual([expect.objectContaining({
      quantity: expect.objectContaining({ value: 35 }),
      coverage: expect.objectContaining({ lots: ['MFT24', 'MFT25'] }),
      approvalStatus: 'PENDING'
    })]);
  });

  it('rejects the explicit disabled integration context without falling back to legacy writes', () => {
    expect(() => confirmReviewMatch(
      connection.db,
      { matchId: '50000000-0000-4000-8000-000000000001', actorName: 'Herman' },
      new Date('2026-09-08T12:00:00Z'),
      { mode: 'disabled' }
    )).toThrow('Versioned review integration requires explicit local demo mode.');

    expect(connection.db.select().from(schema.cases).all()).toHaveLength(0);
    expect(connection.db.select().from(schema.matches)
      .where(eq(schema.matches.id, '50000000-0000-4000-8000-000000000001')).get())
      .toMatchObject({ status: 'candidate', decidedAt: null });
  });
});
