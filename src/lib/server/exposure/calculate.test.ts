import { describe, expect, it } from 'vitest';

import type { TraceabilityRecord } from '../../contracts/recall';
import { demoCaseId, demoProductId } from '../../contracts/recall.fixtures';
import { calculateExposure } from './calculate';
import { normalExposureRecords } from './fixtures';

const calculatedAt = '2026-09-07T11:00:00.000Z';
function calculate(records: TraceabilityRecord[]) {
  return calculateExposure({
    caseId: demoCaseId,
    productId: demoProductId,
    materialRevision: 1,
    lots: ['L-2403'],
    records,
    calculatedAt
  });
}

describe('deterministic exposure calculation', () => {
  it('derives 100 = 40 + 20 + 25 + 5 + 10 from source records', () => {
    const exposure = calculate(normalExposureRecords);
    expect({
      received: exposure.received.value,
      warehouse: exposure.warehouse.value,
      inTransit: exposure.inTransit.value,
      retailer: exposure.retailer.value,
      sold: exposure.sold.value,
      unaccounted: exposure.unaccounted.value,
      contained: exposure.contained.value
    }).toEqual({ received: 100, warehouse: 40, inTransit: 20, retailer: 25, sold: 5, unaccounted: 10, contained: 40 });
    expect(exposure.gaps).toEqual([expect.objectContaining({ code: 'TRACEABILITY_GAP' })]);
    expect(exposure.conflicts).toEqual([]);
    expect(exposure.contained.value).toBe(40);
    expect(
      (exposure.warehouse.value ?? 0) + (exposure.inTransit.value ?? 0) +
      (exposure.retailer.value ?? 0) + (exposure.sold.value ?? 0) +
      (exposure.unaccounted.value ?? 0)
    ).toBe(exposure.received.value);
  });

  it('uses latest inventory and shipment states instead of summing movement history', () => {
    const records: TraceabilityRecord[] = [
      ...normalExposureRecords,
      { type: 'INVENTORY', sourceRef: 'demo:inventory:warehouse:old', productId: demoProductId, lot: 'L-2403', occurredAt: '2026-09-06T09:00:00.000Z', demo: true, locationRef: 'warehouse:DUB', quantity: 70 },
      { type: 'SHIPMENT', sourceRef: 'demo:shipment:transit:old', productId: demoProductId, lot: 'L-2403', occurredAt: '2026-09-06T09:00:00.000Z', demo: true, shipmentRef: 'SHIP-TRANSITION', destinationRef: 'retailer:GALWAY', quantity: 10, status: 'IN_TRANSIT' },
      { type: 'SHIPMENT', sourceRef: 'demo:shipment:delivered:new', productId: demoProductId, lot: 'L-2403', occurredAt: '2026-09-07T09:00:00.000Z', demo: true, shipmentRef: 'SHIP-TRANSITION', destinationRef: 'retailer:GALWAY', quantity: 10, status: 'DELIVERED' },
      { type: 'RETAILER_RESPONSE', sourceRef: 'demo:retailer:GALWAY:latest', productId: demoProductId, lot: 'L-2403', occurredAt: '2026-09-07T10:15:00.000Z', demo: true, retailerRef: 'retailer:GALWAY', quantity: 0 }
    ];
    const exposure = calculate(records);
    expect(exposure.warehouse.value).toBe(40);
    expect(exposure.inTransit.value).toBe(20);
    expect(exposure.retailer.value).toBe(25);
    expect(exposure.inTransit.sources.map((item) => item.sourceRef)).toContain('demo:shipment:delivered:new');
    expect(exposure.inTransit.sources.map((item) => item.sourceRef)).not.toContain('demo:shipment:transit:old');
  });

  it('treats a returned shipment as no longer in transit or delivered', () => {
    const records = normalExposureRecords.map((record) =>
      record.type === 'SHIPMENT' && record.shipmentRef === 'SHIP-DONE'
        ? { ...record, status: 'RETURNED' as const, occurredAt: '2026-09-07T10:50:00.000Z', sourceRef: 'demo:shipment:return' }
        : record
    );
    const exposure = calculate(records);
    expect(exposure.inTransit.value).toBe(20);
    expect(exposure.retailer).toMatchObject({ value: null, knowledgeStatus: 'PENDING' });
    expect(exposure.received.value).toBe(100);
    expect(exposure.received.sources).toHaveLength(1);
  });

  it('does not treat a missing shipment batch as unaffected', () => {
    const records: TraceabilityRecord[] = [
      ...normalExposureRecords,
      { type: 'SHIPMENT', sourceRef: 'demo:shipment:no-batch', productId: demoProductId, lot: null, occurredAt: calculatedAt, demo: true, shipmentRef: 'SHIP-UNKNOWN', destinationRef: 'retailer:LIMERICK', quantity: 7, status: 'IN_TRANSIT' }
    ];
    const exposure = calculate(records);
    expect(exposure.inTransit).toMatchObject({ value: null, knowledgeStatus: 'UNRESOLVED' });
    expect(exposure.unaccounted.value).toBeNull();
    expect(exposure.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SHIPMENT_BATCH_UNKNOWN' })]));
  });

  it('requires a current retailer response after delivery', () => {
    const stale = normalExposureRecords.map((record) =>
      record.type === 'RETAILER_RESPONSE'
        ? { ...record, occurredAt: '2026-08-20T10:00:00.000Z' }
        : record
    );
    const exposure = calculate(stale);
    expect(exposure.retailer).toMatchObject({ value: null, knowledgeStatus: 'PENDING' });
    expect(exposure.unaccounted.value).toBeNull();
    expect(exposure.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RETAILER_RESPONSE_NOT_CURRENT' })]));
  });

  it('preserves a 105/100 distribution as a five-item conflict', () => {
    const overfilled = normalExposureRecords.map((record) => {
      if (record.type === 'INVENTORY') return { ...record, quantity: 55 };
      return record;
    });
    const exposure = calculate(overfilled);
    expect(exposure.received.value).toBe(100);
    expect(exposure.unaccounted).toMatchObject({ value: null, knowledgeStatus: 'CONFLICTED' });
    expect(exposure.conflicts).toEqual([
      expect.objectContaining({ code: 'DISTRIBUTION_EXCEEDS_RECEIPTS', message: expect.stringContaining('excess 5 ITEM') })
    ]);
  });

  it('keeps affected total unknown when receipt scope is unknown', () => {
    const records = normalExposureRecords.map((record) =>
      record.type === 'RECEIPT' ? { ...record, lot: null } : record
    );
    const exposure = calculate(records);
    expect(exposure.received).toMatchObject({ value: null, knowledgeStatus: 'UNKNOWN' });
    expect(exposure.unaccounted.value).toBeNull();
    expect(exposure.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RECEIPT_BATCH_UNKNOWN' })]));
  });

  it('excludes records outside the confirmed lot boundary', () => {
    const records: TraceabilityRecord[] = [
      ...normalExposureRecords,
      { type: 'RECEIPT', sourceRef: 'demo:receipt:L-2404', productId: demoProductId, lot: 'L-2404', occurredAt: calculatedAt, demo: true, receiptRef: 'RCV-2404', quantity: 900 }
    ];
    expect(calculate(records).received.value).toBe(100);
  });
});
