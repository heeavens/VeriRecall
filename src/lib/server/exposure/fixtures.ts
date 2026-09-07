import type { TraceabilityRecord } from '../../contracts/recall';
import { demoProductId } from '../../contracts/recall.fixtures';

const demo = true;
export const normalExposureRecords = [
  { type: 'RECEIPT', sourceRef: 'demo:receipt:L-2403', productId: demoProductId, lot: 'L-2403', occurredAt: '2026-09-01T08:00:00.000Z', demo, receiptRef: 'RCV-2403', quantity: 100 },
  { type: 'INVENTORY', sourceRef: 'demo:inventory:warehouse:latest', productId: demoProductId, lot: 'L-2403', occurredAt: '2026-09-07T09:00:00.000Z', demo, locationRef: 'warehouse:DUB', quantity: 40 },
  { type: 'SHIPMENT', sourceRef: 'demo:shipment:transit:1', productId: demoProductId, lot: 'L-2403', occurredAt: '2026-09-07T09:30:00.000Z', demo, shipmentRef: 'SHIP-TRANSIT', destinationRef: 'retailer:CORK', quantity: 20, status: 'IN_TRANSIT' },
  { type: 'SHIPMENT', sourceRef: 'demo:shipment:delivered:1', productId: demoProductId, lot: 'L-2403', occurredAt: '2026-09-05T09:30:00.000Z', demo, shipmentRef: 'SHIP-DONE', destinationRef: 'retailer:DUB', quantity: 35, status: 'DELIVERED' },
  { type: 'RETAILER_RESPONSE', sourceRef: 'demo:retailer:DUB:latest', productId: demoProductId, lot: 'L-2403', occurredAt: '2026-09-07T10:00:00.000Z', demo, retailerRef: 'retailer:DUB', quantity: 25 },
  { type: 'SALE', sourceRef: 'demo:sale:L-2403:confirmed', productId: demoProductId, lot: 'L-2403', occurredAt: '2026-09-07T10:30:00.000Z', demo, saleRef: 'SALES-2403', quantity: 5 },
  { type: 'CONTAINMENT', sourceRef: 'demo:hold:warehouse', productId: demoProductId, lot: 'L-2403', occurredAt: '2026-09-07T10:45:00.000Z', demo, locationRef: 'warehouse:DUB', quantity: 40 }
] satisfies TraceabilityRecord[];

export function withProduct(records: TraceabilityRecord[], productId: string): TraceabilityRecord[] {
  return records.map((record) => ({ ...record, productId }));
}
