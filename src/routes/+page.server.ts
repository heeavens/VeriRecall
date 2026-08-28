import { redirect } from '@sveltejs/kit';

import { db } from '$lib/server/db/connection';
import { getSetupState } from '$lib/server/imports/setup';

export function load(): never {
  const destination = getSetupState(db).onboardingCompleted ? '/dashboard' : '/onboarding';
  redirect(307, destination);
}
