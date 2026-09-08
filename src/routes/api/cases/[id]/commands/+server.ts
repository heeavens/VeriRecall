import { db } from '$lib/server/db/connection';
import { createRecallService } from '$lib/server/workflow/case-lifecycle';
import { invalidLifecycleRequest, lifecycleResponse, localLifecycleContext, readLifecycleBody } from '$lib/server/workflow/lifecycle-http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
  let body: unknown;
  try { body = await readLifecycleBody(request); } catch { return invalidLifecycleRequest(); }
  if (!body || typeof body !== 'object' || !('caseId' in body) || body.caseId !== params.id) return invalidLifecycleRequest();
  return lifecycleResponse(await createRecallService(db, localLifecycleContext()).execute(body));
};
