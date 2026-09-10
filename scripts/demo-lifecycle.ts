import { randomUUID } from 'node:crypto';
import { commandResultSchema, snapshotResultSchema } from '../src/lib/contracts/recall';
import { normalExposureRecords, withProduct } from '../src/lib/server/exposure/fixtures';

// Explicit demo client; the server never imports these fixtures as fallback data.
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
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body)
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}
const current = snapshotResultSchema.parse(await (await fetch(`${origin}/api/cases/${caseId}/snapshot`)).json());
if (!current.ok) throw new Error(current.error.message);
if (current.snapshot.investigation?.scope.kind !== 'BATCH_LOT') {
  throw new Error('The Review-initialized case must have a known BATCH_LOT scope.');
}
const [lot] = current.snapshot.investigation.scope.lots;
if (!lot) throw new Error('The Review-initialized BATCH_LOT scope must contain a lot.');
const exposureInput = {
  type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId,
  commandId: randomUUID(), expectedCaseVersion: current.snapshot.caseVersion,
  records: withProduct(normalExposureRecords, current.snapshot.productId)
    .map((record) => ({ ...record, lot }))
};
const calculated = commandResultSchema.parse(await post(`/api/cases/${caseId}/commands`, exposureInput));
if (!calculated.ok) throw new Error(calculated.error.message);
if (calculated.snapshot.tasks.filter((task) => task.status !== 'SUPERSEDED').length !== 4 ||
    calculated.snapshot.pendingDecisions.filter((decision) => decision.type === 'APPROVE_ACTION').length !== 3 ||
    calculated.snapshot.pendingDecisions.filter((decision) => decision.type !== 'APPROVE_ACTION').length !== 2) {
  throw new Error('Expected four active tasks, three action decisions and two investigation reviews.');
}
const exposureReplay = commandResultSchema.parse(await post(`/api/cases/${caseId}/commands`, exposureInput));
if (!exposureReplay.ok || !exposureReplay.replayed) throw new Error('Expected an idempotent exposure replay.');
const read = snapshotResultSchema.parse(await (await fetch(`${origin}/api/cases/${caseId}/snapshot`)).json());
if (!read.ok || read.snapshot.caseVersion !== calculated.snapshot.caseVersion) throw new Error('Snapshot read failed.');
console.log(JSON.stringify({ caseUrl: `${origin}/cases/${caseId}`, result: calculated }, null, 2));
