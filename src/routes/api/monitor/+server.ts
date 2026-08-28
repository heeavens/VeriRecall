import { json } from '@sveltejs/kit';

import { db } from '$lib/server/db/connection';
import { runMonitoringCycle } from '$lib/server/workflow/monitoring';

import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
  try {
    return json(await runMonitoringCycle(db));
  } catch {
    return json({ message: 'Monitoring could not be completed. Please try again.' }, { status: 500 });
  }
};
