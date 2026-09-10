import { randomUUID } from 'node:crypto';

import {
  commandResultSchema,
  snapshotResultSchema,
  type CaseSnapshot,
  type RecallCommand,
  type TraceabilityRecord
} from '../src/lib/contracts/recall';

const baseUrl = process.env.VERIRECALL_BASE_URL;
if (!baseUrl || !['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname)) {
  throw new Error('Set VERIRECALL_BASE_URL to the local demo server URL.');
}
const caseId = process.env.VERIRECALL_CASE_ID;
if (!caseId) {
  throw new Error('Set VERIRECALL_CASE_ID to a case initialized through the Review workflow.');
}
const origin = new URL(baseUrl).origin;

async function post(path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body)
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}

async function execute(command: RecallCommand): Promise<CaseSnapshot> {
  const result = commandResultSchema.parse(await post(`/api/cases/${command.caseId}/commands`, command));
  if (!result.ok) throw new Error(result.error.message);
  return result.snapshot;
}

const current = snapshotResultSchema.parse(await (await fetch(`${origin}/api/cases/${caseId}/snapshot`)).json());
if (!current.ok) throw new Error(current.error.message);
let snapshot = current.snapshot;
if (snapshot.investigation?.scope.kind !== 'BATCH_LOT') {
  throw new Error('The Review-initialized case must have a known BATCH_LOT scope.');
}
const [lot] = snapshot.investigation.scope.lots;
if (!lot) throw new Error('The Review-initialized BATCH_LOT scope must contain a lot.');

const records: TraceabilityRecord[] = [
  { type: 'RECEIPT', sourceRef: 'demo:ready:receipt', productId: snapshot.productId, lot, occurredAt: '2026-09-07T08:00:00.000Z', demo: true, receiptRef: 'READY-RECEIPT', quantity: 100 },
  { type: 'INVENTORY', sourceRef: 'demo:ready:inventory', productId: snapshot.productId, lot, occurredAt: '2026-09-07T09:00:00.000Z', demo: true, locationRef: 'warehouse:DUB', quantity: 100 },
  { type: 'SHIPMENT', sourceRef: 'demo:ready:shipment', productId: snapshot.productId, lot, occurredAt: '2026-09-07T09:10:00.000Z', demo: true, shipmentRef: 'READY-SHIPMENT', destinationRef: 'retailer:DUB', quantity: 0, status: 'RETURNED' },
  { type: 'RETAILER_RESPONSE', sourceRef: 'demo:ready:retailer', productId: snapshot.productId, lot, occurredAt: '2026-09-07T09:20:00.000Z', demo: true, retailerRef: 'retailer:DUB', quantity: 0 },
  { type: 'SALE', sourceRef: 'demo:ready:sale', productId: snapshot.productId, lot, occurredAt: '2026-09-07T09:30:00.000Z', demo: true, saleRef: 'READY-SALES', quantity: 0 },
  { type: 'CONTAINMENT', sourceRef: 'demo:ready:containment', productId: snapshot.productId, lot, occurredAt: '2026-09-07T10:00:00.000Z', demo: true, locationRef: 'warehouse:DUB', quantity: 100 }
];

snapshot = await execute({
  type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: snapshot.caseId,
  commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion, records
});

for (const type of ['CONFIRM_IDENTITY', 'CONFIRM_SCOPE'] as const) {
  const decision = snapshot.pendingDecisions.find((item) => item.type === type);
  if (!decision) throw new Error(`Missing ${type} decision.`);
  snapshot = await execute({
    type: 'DECIDE_INVESTIGATION', schemaVersion: 1, caseId: snapshot.caseId,
    commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
    decisionId: decision.id, decision: 'APPROVED',
    rationale: `Reviewed ${type} against the listed demo evidence.`,
    evidenceRefs: decision.evidenceRefs, demo: true
  });
}

const hold = snapshot.tasks.find((task) => task.type === 'HOLD_STOCK' && task.status !== 'SUPERSEDED');
if (!hold) throw new Error('Expected a HOLD_STOCK task.');
snapshot = await execute({
  type: 'DECIDE_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
  commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
  taskId: hold.id, decision: 'APPROVED',
  rationale: 'Reviewed the current affected stock and lot coverage.',
  evidenceRefs: hold.sourceRefs, demo: true
});
snapshot = await execute({
  type: 'REQUEST_ACTION', schemaVersion: 1, caseId: snapshot.caseId,
  commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
  taskId: hold.id, demo: true
});
const resultEvidenceRef = 'demo:result:hold_stock';
snapshot = await execute({
  type: 'ATTACH_RESULT', schemaVersion: 1, caseId: snapshot.caseId,
  commandId: randomUUID(), expectedCaseVersion: snapshot.caseVersion,
  taskId: hold.id, evidenceRefs: [resultEvidenceRef],
  summary: 'Verified that all 100 affected ITEM are held in the demo warehouse.', demo: true
});

if (snapshot.stage !== 'CLOSURE_REVIEW' || snapshot.closure.status !== 'READY_FOR_HUMAN_CLOSURE') {
  throw new Error('Expected a closure-ready case.');
}

console.log(JSON.stringify({
  caseUrl: `${origin}/cases/${snapshot.caseId}`,
  caseId: snapshot.caseId,
  caseVersion: snapshot.caseVersion,
  stage: snapshot.stage,
  closureEvidenceRefs: [resultEvidenceRef]
}, null, 2));
