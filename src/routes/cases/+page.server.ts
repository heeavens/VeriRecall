import { db } from '$lib/server/db/connection';
import { getCasesView } from '$lib/server/cases/queries';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ cases: getCasesView(db) });
