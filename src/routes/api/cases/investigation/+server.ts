import { db } from '$lib/server/db/connection';
import { reserveInvestigationCase } from '$lib/server/workflow/case-lifecycle';
import { invalidLifecycleRequest, lifecycleResponse, localLifecycleContext, readLifecycleBody } from '$lib/server/workflow/lifecycle-http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try { body = await readLifecycleBody(request); } catch { return invalidLifecycleRequest(); }
  return lifecycleResponse(reserveInvestigationCase(db, body, localLifecycleContext()));
};
