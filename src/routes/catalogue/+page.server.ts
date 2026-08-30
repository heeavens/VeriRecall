import { getCatalogueView } from '$lib/server/catalogue/queries';
import { db } from '$lib/server/db/connection';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ catalogue: getCatalogueView(db) });
