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
import {
  createRecallService,
  getCaseHistory,
  internalInvestigationAcceptanceContext,
  reserveInvestigationCase
} from '../workflow/case-lifecycle';
import { normalExposureRecords, withProduct } from './fixtures';

let directory: string;
let connection: ReturnType<typeof createDatabaseConnection>;
const context = internalInvestigationAcceptanceContext();
const fixtures = loadDemoFixtures();
const candidate = fixtures.matches.find((match) => !match.hasHardConflict)!;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-exposure-service-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

async function initialized() {
  const reserved = reserveInvestigationCase(connection.db, {
    alertId: candidate.alertId,
    productId: candidate.productId
  }, context, new Date('2026-09-07T08:00:00Z'));
  if (!reserved.ok) throw new Error(reserved.error.message);
  const service = createRecallService(connection.db, context, () => new Date('2026-09-07T11:00:00Z'));
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
  return { service, snapshot: accepted.snapshot };
}

function exposureCommand(
  caseId: string,
  expectedCaseVersion: number,
  records: TraceabilityRecord[],
  commandId = randomUUID()
) {
  return {
    type: 'CALCULATE_EXPOSURE' as const,
    schemaVersion: 1 as const,
    caseId,
    commandId,
    expectedCaseVersion,
    records: withProduct(records, candidate.productId)
  };
}

describe('persisted exposure service', () => {
  it('persists the normal calculation in the real snapshot with provenance and blockers', async () => {
    const { service, snapshot } = await initialized();
    const result = await service.execute(exposureCommand(
      snapshot.caseId,
      snapshot.caseVersion,
      normalExposureRecords
    ));
    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      appliedCaseVersion: 3,
      snapshot: {
        stage: 'INVESTIGATING',
        exposure: {
          status: 'CALCULATED',
          basisMaterialRevision: 1,
          received: { value: 100, knowledgeStatus: 'KNOWN' },
          warehouse: { value: 40 },
          inTransit: { value: 20 },
          retailer: { value: 25 },
          sold: { value: 5 },
          unaccounted: { value: 10 },
          contained: { value: 40 }
        },
        closure: {
          status: 'NOT_READY',
          blockers: expect.arrayContaining([
            expect.objectContaining({ code: 'SCOPE_UNCONFIRMED' }),
            expect.objectContaining({ code: 'ACTIVE_TRANSIT' }),
            expect.objectContaining({ code: 'TRACEABILITY_GAP' })
          ])
        }
      }
    });
    if (!result.ok) return;
    expect(result.snapshot.attentionItems.map((item) => item.code)).toEqual([
      'SCOPE_UNCONFIRMED',
      'ACTIVE_TRANSIT',
      'TRACEABILITY_GAP',
      'EVIDENCE_MISSING',
      'CRITICAL_TASK_PENDING'
    ]);
    expect(result.snapshot.exposure.received.sources).toEqual([
      expect.objectContaining({ sourceRef: 'demo:receipt:L-2403', sourceType: 'RECEIPT' })
    ]);
    expect(connection.db.select().from(schema.traceabilityRecords).all()).toHaveLength(7);
    expect(getCaseHistory(connection.db, snapshot.caseId)).toHaveLength(3);
    expect(connection.db.select().from(schema.auditEvents).all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'exposure_calculated' })]));
  });

  it('does not duplicate source rows, quantities or history on exact and semantic retries', async () => {
    const { service, snapshot } = await initialized();
    const command = exposureCommand(snapshot.caseId, 2, normalExposureRecords);
    const first = await service.execute(command);
    expect(first).toMatchObject({ ok: true, appliedCaseVersion: 3 });
    const counts = () => ({
      sources: connection.db.select().from(schema.traceabilityRecords).all().length,
      history: connection.db.select().from(schema.caseRevisions).all().length,
      audit: connection.db.select().from(schema.auditEvents).all().length
    });
    const before = counts();
    expect(await service.execute(command)).toMatchObject({ ok: true, replayed: true, appliedCaseVersion: 3 });
    expect(counts()).toEqual(before);
    const semanticRetry = exposureCommand(snapshot.caseId, 3, normalExposureRecords);
    expect(await service.execute(semanticRetry)).toMatchObject({
      ok: true,
      replayed: true,
      appliedCaseVersion: 3,
      snapshot: { exposure: { received: { value: 100 } } }
    });
    expect(counts()).toEqual(before);
    expect(connection.db.select().from(schema.caseCommands).all()).toHaveLength(3);
  });

  it('rejects a conflicting sourceRef atomically even when another source is new', async () => {
    const { service, snapshot } = await initialized();
    await service.execute(exposureCommand(snapshot.caseId, 2, normalExposureRecords));
    const beforeSources = connection.db.select().from(schema.traceabilityRecords).all();
    const beforeHistory = getCaseHistory(connection.db, snapshot.caseId);
    const changedReceipt = {
      ...normalExposureRecords[0],
      quantity: 101
    } as TraceabilityRecord;
    const newSale = {
      type: 'SALE', sourceRef: 'demo:sale:new', productId: candidate.productId, lot: 'L-2403',
      occurredAt: '2026-09-07T10:40:00.000Z', demo: true, saleRef: 'SALE-NEW', quantity: 1
    } satisfies TraceabilityRecord;
    expect(await service.execute(exposureCommand(snapshot.caseId, 3, [newSale, changedReceipt])))
      .toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(connection.db.select().from(schema.traceabilityRecords).all()).toEqual(beforeSources);
    expect(getCaseHistory(connection.db, snapshot.caseId)).toEqual(beforeHistory);
  });

  it('keeps stored source records and recalculates them after scope expands', async () => {
    const { service, snapshot } = await initialized();
    const secondLot: TraceabilityRecord[] = [
      { type: 'RECEIPT', sourceRef: 'demo:receipt:L-2404', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T09:00:00.000Z', demo: true, receiptRef: 'RCV-2404', quantity: 20 },
      { type: 'INVENTORY', sourceRef: 'demo:inventory:L-2404', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T10:00:00.000Z', demo: true, locationRef: 'warehouse:DUB', quantity: 20 },
      { type: 'SHIPMENT', sourceRef: 'demo:shipment:L-2404:none', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T10:00:00.000Z', demo: true, shipmentRef: 'SHIP-2404-NONE', destinationRef: 'retailer:NONE', quantity: 0, status: 'RETURNED' },
      { type: 'RETAILER_RESPONSE', sourceRef: 'demo:retailer:L-2404:none', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T10:00:00.000Z', demo: true, retailerRef: 'retailer:NONE', quantity: 0 },
      { type: 'SALE', sourceRef: 'demo:sale:L-2404:none', productId: candidate.productId, lot: 'L-2404', occurredAt: '2026-09-07T10:00:00.000Z', demo: true, saleRef: 'SALE-2404-NONE', quantity: 0 }
    ];
    const first = await service.execute(exposureCommand(snapshot.caseId, 2, [
      ...normalExposureRecords,
      ...secondLot
    ]));
    expect(first).toMatchObject({ ok: true, snapshot: { exposure: { received: { value: 100 } } } });
    if (!first.ok) return;
    const expanded: InvestigationOutcome = {
      ...structuredClone(expandedLotOutcome),
      caseId: snapshot.caseId,
      productId: candidate.productId
    };
    const accepted = await service.execute({
      type: 'ACCEPT_INVESTIGATION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 3, outcome: expanded
    });
    expect(accepted).toMatchObject({ ok: true, snapshot: { caseVersion: 4, exposure: { status: 'NOT_CALCULATED' } } });
    if (!accepted.ok) return;
    const recalculated = await service.execute(exposureCommand(snapshot.caseId, 4, secondLot));
    expect(recalculated).toMatchObject({
      ok: true,
      snapshot: {
        caseVersion: 5,
        materialRevision: 2,
        exposure: {
          basisMaterialRevision: 2,
          received: { value: 120 },
          warehouse: { value: 60 },
          inTransit: { value: 20 },
          retailer: { value: 25 },
          sold: { value: 5 },
          unaccounted: { value: 10 }
        }
      }
    });
    expect(connection.db.select().from(schema.traceabilityRecords).all()).toHaveLength(12);
    expect(getCaseHistory(connection.db, snapshot.caseId).map((row) => row.caseVersion)).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects unresolved scope, foreign records and duplicate source refs before writes', async () => {
    const { service, snapshot } = await initialized();
    const unresolved: InvestigationOutcome = {
      ...structuredClone(confirmedLotOutcome),
      caseId: snapshot.caseId,
      productId: candidate.productId,
      materialRevision: 2,
      knowledgeStatus: 'UNRESOLVED',
      scope: { kind: 'UNRESOLVED', knowledgeStatus: 'UNKNOWN', reason: 'Missing label', evidenceRefs: [], decisionRefs: [] },
      evidenceRefs: ['demo:identity'],
      decisionRefs: ['demo:identity-decision'],
      gaps: [{ id: 'demo:scope', code: 'BATCH_MISSING', message: 'Missing label', critical: true, subjectRefs: [candidate.productId], evidenceRefs: [] }]
    };
    await service.execute({ type: 'ACCEPT_INVESTIGATION', schemaVersion: 1, caseId: snapshot.caseId,
      commandId: randomUUID(), expectedCaseVersion: 2, outcome: unresolved });
    const before = connection.db.select().from(schema.traceabilityRecords).all();
    expect(await service.execute(exposureCommand(snapshot.caseId, 3, normalExposureRecords)))
      .toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    const foreign = exposureCommand(snapshot.caseId, 3, normalExposureRecords);
    foreign.records[0] = { ...foreign.records[0], productId: randomUUID() };
    expect(await service.execute(foreign)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const duplicate = exposureCommand(snapshot.caseId, 3, [normalExposureRecords[0], normalExposureRecords[0]]);
    expect(await service.execute(duplicate)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(connection.db.select().from(schema.traceabilityRecords).all()).toEqual(before);
  });
});
