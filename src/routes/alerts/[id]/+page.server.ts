import { error } from '@sveltejs/kit';

import { db } from '$lib/server/db/connection';
import { getAlertDetail } from '$lib/server/alerts/queries';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
  const detail = getAlertDetail(db, params.id);
  if (!detail) error(404, 'Alert not found');
  return detail;
};
