import { db } from '$lib/server/db/connection';
import { createRecallService } from '$lib/server/workflow/case-lifecycle';
import { lifecycleResponse, localLifecycleContext } from '$lib/server/workflow/lifecycle-http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => lifecycleResponse(
  await createRecallService(db, localLifecycleContext()).getSnapshot({ schemaVersion: 1, caseId: params.id })
);
