import { randomUUID } from 'node:crypto';
import { commandResultSchema, snapshotResultSchema } from '../src/lib/contracts/recall';
import { confirmedLotOutcome } from '../src/lib/contracts/recall.fixtures';
import { loadDemoFixtures } from '../src/lib/server/db/demo-fixtures';

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
const replay = commandResultSchema.parse(await post(`/api/cases/${input.caseId}/commands`, input));
if (!replay.ok || !replay.replayed) throw new Error('Expected an idempotent replay.');
const read = snapshotResultSchema.parse(await (await fetch(`${origin}/api/cases/${input.caseId}/snapshot`)).json());
if (!read.ok || read.snapshot.caseVersion !== accepted.snapshot.caseVersion) throw new Error('Snapshot read failed.');
console.log(JSON.stringify({ caseUrl: `${origin}/cases/${input.caseId}`, result: accepted }, null, 2));
