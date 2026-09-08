import { randomUUID } from 'node:crypto';
import { commandResultSchema, snapshotResultSchema } from '../src/lib/contracts/recall';
import { confirmedLotOutcome } from '../src/lib/contracts/recall.fixtures';
import { loadDemoFixtures } from '../src/lib/server/db/demo-fixtures';
import { normalExposureRecords, withProduct } from '../src/lib/server/exposure/fixtures';

// Explicit demo client; the server never imports these fixtures as fallback data.
const baseUrl = process.env.VERIRECALL_BASE_URL;
if (!baseUrl || !['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname)) {
  throw new Error('Set VERIRECALL_BASE_URL to the local demo server URL.');
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
const candidate = loadDemoFixtures().matches.find((match) => !match.hasHardConflict)!;
const reserved = snapshotResultSchema.parse(await post('/api/cases/investigation', {
  alertId: candidate.alertId, productId: candidate.productId
}));
if (!reserved.ok) throw new Error(reserved.error.message);
const input = {
  type: 'ACCEPT_INVESTIGATION', schemaVersion: 1, caseId: reserved.snapshot.caseId,
  commandId: randomUUID(), expectedCaseVersion: reserved.snapshot.caseVersion,
  outcome: { ...confirmedLotOutcome, caseId: reserved.snapshot.caseId, productId: candidate.productId }
};
const accepted = commandResultSchema.parse(await post(`/api/cases/${input.caseId}/commands`, input));
if (!accepted.ok) throw new Error(accepted.error.message);
const investigationReplay = commandResultSchema.parse(await post(`/api/cases/${input.caseId}/commands`, input));
if (!investigationReplay.ok || !investigationReplay.replayed) throw new Error('Expected an idempotent investigation replay.');
const exposureInput = {
  type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: input.caseId,
  commandId: randomUUID(), expectedCaseVersion: accepted.snapshot.caseVersion,
  records: withProduct(normalExposureRecords, candidate.productId)
};
const calculated = commandResultSchema.parse(await post(`/api/cases/${input.caseId}/commands`, exposureInput));
if (!calculated.ok) throw new Error(calculated.error.message);
if (calculated.snapshot.tasks.filter((task) => task.status !== 'SUPERSEDED').length !== 4 ||
    calculated.snapshot.pendingDecisions.filter((decision) => decision.type === 'APPROVE_ACTION').length !== 3 ||
    calculated.snapshot.pendingDecisions.filter((decision) => decision.type !== 'APPROVE_ACTION').length !== 2) {
  throw new Error('Expected four active tasks, three action decisions and two investigation reviews.');
}
const exposureReplay = commandResultSchema.parse(await post(`/api/cases/${input.caseId}/commands`, exposureInput));
if (!exposureReplay.ok || !exposureReplay.replayed) throw new Error('Expected an idempotent exposure replay.');
const read = snapshotResultSchema.parse(await (await fetch(`${origin}/api/cases/${input.caseId}/snapshot`)).json());
if (!read.ok || read.snapshot.caseVersion !== calculated.snapshot.caseVersion) throw new Error('Snapshot read failed.');
console.log(JSON.stringify({ caseUrl: `${origin}/cases/${input.caseId}`, result: calculated }, null, 2));
