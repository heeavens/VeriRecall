import { describe, expect, it } from 'vitest';

import type { CaseSnapshot, TraceabilityRecord } from '../../contracts/recall';
import { confirmedLotOutcome, demoProductId, makeUncalculatedSnapshot } from '../../contracts/recall.fixtures';
import { calculateExposure } from '../exposure/calculate';
import { normalExposureRecords } from '../exposure/fixtures';
import { reconcileDynamicTasks } from './engine';

const now = '2026-09-07T11:00:00.000Z';

function ids() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

function snapshot(records: TraceabilityRecord[]): CaseSnapshot {
  const base = makeUncalculatedSnapshot(confirmedLotOutcome, 3);
  return {
    ...base,
    exposure: calculateExposure({
      caseId: base.caseId,
      productId: demoProductId,
      materialRevision: 1,
      lots: ['L-2403'],
      records,
      calculatedAt: now
    })
  };
}

describe('dynamic task rules', () => {
  it('derives the expected actions, targets, coverage and reviewable drafts', () => {
    const result = reconcileDynamicTasks(snapshot(normalExposureRecords), normalExposureRecords, now, ids());
    const active = result.tasks.filter((task) => task.status !== 'SUPERSEDED');

    expect(active.map((task) => task.type).sort()).toEqual([
      'HOLD_STOCK',
      'INTERCEPT_SHIPMENT',
      'INVESTIGATE_TRACEABILITY_GAP',
      'PREPARE_COMMUNICATION'
    ]);
    expect(active).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'HOLD_STOCK', rule: 'AFFECTED_AVAILABLE_STOCK', targetRef: 'warehouse:DUB', quantity: expect.objectContaining({ value: 40 }), priority: 'CRITICAL', blocking: true }),
      expect.objectContaining({ type: 'INTERCEPT_SHIPMENT', rule: 'ACTIVE_SHIPMENT', targetRef: 'SHIP-TRANSIT', quantity: expect.objectContaining({ value: 20 }), priority: 'CRITICAL', blocking: true }),
      expect.objectContaining({ type: 'INVESTIGATE_TRACEABILITY_GAP', rule: 'DISTRIBUTION_GAP', quantity: expect.objectContaining({ value: 10 }) }),
      expect.objectContaining({ type: 'PREPARE_COMMUNICATION', rule: 'SOLD_UNITS', targetRef: `customers:${demoProductId}`, quantity: expect.objectContaining({ value: 5 }) })
    ]));
    for (const task of active) {
      expect(task.coverage).toMatchObject({ kind: 'BATCH_LOT', lots: ['L-2403'] });
      expect(task.sourceRefs.length).toBeGreaterThan(0);
      expect(task.draft.body).toContain('Verify the scope and source records before use.');
      expect(task.sourceRefs.every((ref) => task.draft.body.includes(ref))).toBe(true);
      expect(task.draft.demo).toBe(true);
    }
  });

  it('creates a retailer confirmation task when the recipient position is unknown', () => {
    const records = normalExposureRecords.filter((record) => record.type !== 'RETAILER_RESPONSE');
    const result = reconcileDynamicTasks(snapshot(records), records, now, ids());

    expect(result.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'REQUEST_RETAILER_CONFIRMATION',
        rule: 'RECIPIENT_POSITION_UNKNOWN',
        targetRef: 'retailer:DUB',
        quantity: expect.objectContaining({ value: null, knowledgeStatus: 'PENDING' })
      })
    ]));
  });

  it('groups multiple unknown deliveries to the same retailer into one task', () => {
    const records: TraceabilityRecord[] = [
      ...normalExposureRecords.filter((record) => record.type !== 'RETAILER_RESPONSE'),
      {
        type: 'SHIPMENT', sourceRef: 'demo:shipment:delivered:second', productId: demoProductId,
        lot: 'L-2403', occurredAt: '2026-09-06T09:30:00.000Z', demo: true,
        shipmentRef: 'SHIP-DONE-2', destinationRef: 'retailer:DUB', quantity: 4, status: 'DELIVERED'
      }
    ];
    const result = reconcileDynamicTasks(snapshot(records), records, now, ids());
    const retailerTasks = result.tasks.filter((task) => task.type === 'REQUEST_RETAILER_CONFIRMATION');
    expect(retailerTasks).toHaveLength(1);
    expect(retailerTasks[0].sourceRefs).toEqual([
      'demo:shipment:delivered:1',
      'demo:shipment:delivered:second'
    ]);
  });

  it('preserves equivalent completed work and does not create duplicates', () => {
    const first = reconcileDynamicTasks(snapshot(normalExposureRecords), normalExposureRecords, now, ids());
    const hold = first.tasks.find((task) => task.type === 'HOLD_STOCK')!;
    const current = snapshot(normalExposureRecords);
    current.tasks = first.tasks.map((task) => task.id === hold.id
      ? { ...task, status: 'COMPLETED', approvalStatus: 'APPROVED', blockedBy: [],
          decisionRefs: ['demo:hold-decision'], resultEvidenceRefs: ['demo:hold-result'], requestStatus: 'REQUESTED' }
      : task);
    current.pendingDecisions = first.pendingDecisions.filter((decision) => decision.subjectRef !== hold.id);

    const repeated = reconcileDynamicTasks(current, normalExposureRecords, now, ids());
    expect(repeated.changed).toBe(false);
    expect(repeated.tasks).toHaveLength(first.tasks.length);
    expect(repeated.tasks.find((task) => task.id === hold.id)).toMatchObject({
      status: 'COMPLETED',
      resultEvidenceRefs: ['demo:hold-result']
    });
  });

  it('refreshes provenance and a pending decision without duplicating equivalent coverage', () => {
    const first = reconcileDynamicTasks(snapshot(normalExposureRecords), normalExposureRecords, now, ids());
    const oldHold = first.tasks.find((task) => task.type === 'HOLD_STOCK')!;
    const records = normalExposureRecords.map((record): TraceabilityRecord => record.type === 'INVENTORY'
      ? { ...record, sourceRef: 'demo:inventory:warehouse:newer', occurredAt: '2026-09-07T10:45:00.000Z' }
      : record);
    const current = { ...snapshot(records), caseVersion: 4, tasks: first.tasks, pendingDecisions: first.pendingDecisions };

    const refreshed = reconcileDynamicTasks(current, records, now, ids());
    const hold = refreshed.tasks.find((task) => task.type === 'HOLD_STOCK')!;
    const decision = refreshed.pendingDecisions.find((item) => item.subjectRef === hold.id)!;

    expect(hold.id).toBe(oldHold.id);
    expect(hold.sourceRefs).toEqual(['demo:inventory:warehouse:newer']);
    expect(hold.quantity.sources[0]?.sourceRef).toBe('demo:inventory:warehouse:newer');
    expect(decision).toMatchObject({
      id: oldHold.blockedBy[0],
      basisCaseVersion: 4,
      evidenceRefs: ['demo:inventory:warehouse:newer']
    });
  });

  it('supersedes a task with a reason when new evidence removes its trigger', () => {
    const missing = normalExposureRecords.filter((record) => record.type !== 'RETAILER_RESPONSE');
    const first = reconcileDynamicTasks(snapshot(missing), missing, now, ids());
    const retailer = first.tasks.find((task) => task.type === 'REQUEST_RETAILER_CONFIRMATION')!;
    const current = snapshot(normalExposureRecords);
    current.tasks = first.tasks;
    current.pendingDecisions = first.pendingDecisions;

    const resolved = reconcileDynamicTasks(current, normalExposureRecords, now, ids());
    expect(resolved.tasks.find((task) => task.id === retailer.id)).toMatchObject({
      status: 'SUPERSEDED',
      approvalStatus: 'STALE',
      statusReason: 'The rule trigger is no longer present in the current exposure.'
    });
    expect(resolved.pendingDecisions.some((decision) => decision.subjectRef === retailer.id)).toBe(false);
  });
});
