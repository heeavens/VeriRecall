import { json } from '@sveltejs/kit';
import type { CommandResult, SnapshotResult } from '../../contracts/recall';
import type { LifecycleContext } from './case-lifecycle';

export function localLifecycleContext(): LifecycleContext {
  return { mode: process.env.VERIRECALL_DEMO_MODE === 'true' ? 'demo' : 'disabled' };
}
export function lifecycleResponse(result: CommandResult | SnapshotResult) {
  const status = result.ok ? 200 : {
    INVALID_INPUT: 400, UNSUPPORTED_SCHEMA_VERSION: 400, UNSUPPORTED_SCOPE: 400,
    NOT_FOUND: 404, FORBIDDEN: 403, VERSION_CONFLICT: 409, STALE_INVESTIGATION: 409,
    IDEMPOTENCY_CONFLICT: 409, INVALID_STATE: 409, EVIDENCE_REQUIRED: 409,
    CLOSURE_BLOCKED: 409, NOT_IMPLEMENTED: 501
  }[result.error.code];
  return json(result, { status, headers: { 'Cache-Control': 'no-store' } });
}
export async function readLifecycleBody(request: Request): Promise<unknown> {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new Error('Invalid origin');
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Expected JSON');
  const body = await request.text();
  if (body.length > 1_000_000) throw new Error('Payload too large');
  return JSON.parse(body);
}
export function invalidLifecycleRequest() {
  return lifecycleResponse({ ok: false, error: { code: 'INVALID_INPUT', message: 'Expected same-origin JSON with a valid route caseId.', currentCaseVersion: null, issueRefs: [] } });
}
