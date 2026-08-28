import { db } from '$lib/server/db/connection';
import { getDashboardView } from '$lib/server/alerts/queries';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => getDashboardView(db);
