import { fail } from '@sveltejs/kit';
import { z } from 'zod';

import { db } from '$lib/server/db/connection';
import {
  confirmReviewMatch,
  evidenceTypes,
  getReviewQueueView,
  rejectReviewMatch,
  requestMatchEvidence,
  ReviewWorkflowError
} from '$lib/server/workflow/review';
import { localLifecycleContext } from '$lib/server/workflow/lifecycle-http';

import type { Actions, PageServerLoad } from './$types';

const actorSchema = z.object({
  matchId: z.string().uuid(),
  actorName: z.string().trim().min(1).max(80)
});

const confirmSchema = actorSchema.pick({ matchId: true });

const evidenceSchema = actorSchema.extend({
  requestedEvidence: z.array(z.enum(evidenceTypes)).min(1)
});

function workflowFailure(kind: 'confirm' | 'reject' | 'evidence', error: unknown) {
  if (error instanceof ReviewWorkflowError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'invalid_state' ? 409 : 400;
    return fail(status, { kind, success: false as const, message: error.message });
  }
  return fail(500, {
    kind,
    success: false as const,
    message: 'The review decision could not be saved. No partial changes were applied.'
  });
}

export const load: PageServerLoad = ({ url }) =>
  getReviewQueueView(db, url.searchParams.get('match'));

export const actions: Actions = {
  confirm: async ({ request }) => {
    const formData = await request.formData();
    const input = confirmSchema.safeParse({ matchId: formData.get('matchId') });
    if (!input.success) {
      return fail(400, {
        kind: 'confirm' as const,
        success: false as const,
        message: 'Choose a valid match.'
      });
    }

    try {
      const result = confirmReviewMatch(
        db,
        { ...input.data, actorName: 'demo_operator' },
        new Date(),
        localLifecycleContext()
      );
      return {
        kind: 'confirm' as const,
        success: true as const,
        caseId: result.caseId,
        caseNumber: result.caseNumber,
        message: result.lifecycleChanged
          ? `Match confirmed. ${result.caseNumber} now has a versioned investigation snapshot; review scope and calculate exposure before acting.`
          : `This match was already integrated in ${result.caseNumber}.`
      };
    } catch (error) {
      return workflowFailure('confirm', error);
    }
  },

  reject: async ({ request }) => {
    const formData = await request.formData();
    const input = actorSchema.safeParse({
      matchId: formData.get('matchId'),
      actorName: formData.get('actorName')
    });
    if (!input.success) {
      return fail(400, {
        kind: 'reject' as const,
        success: false as const,
        message: 'Choose a valid match and enter the reviewer name.'
      });
    }

    try {
      const result = rejectReviewMatch(db, input.data);
      return {
        kind: 'reject' as const,
        success: true as const,
        message: result.changed
          ? 'Match rejected. The alert is marked not relevant to your catalogue, and the decision was recorded.'
          : 'This match was already rejected.'
      };
    } catch (error) {
      return workflowFailure('reject', error);
    }
  },

  requestEvidence: async ({ request }) => {
    const formData = await request.formData();
    const input = evidenceSchema.safeParse({
      matchId: formData.get('matchId'),
      actorName: formData.get('actorName'),
      requestedEvidence: formData.getAll('requestedEvidence')
    });
    if (!input.success) {
      return fail(400, {
        kind: 'evidence' as const,
        success: false as const,
        message: 'Select at least one evidence type and enter the reviewer name.'
      });
    }

    try {
      const result = requestMatchEvidence(db, input.data);
      return {
        kind: 'evidence' as const,
        success: true as const,
        message: result.changed
          ? 'Evidence request recorded. An unsent supplier draft was created; no message was sent.'
          : 'An evidence request already exists for this match.'
      };
    } catch (error) {
      return workflowFailure('evidence', error);
    }
  }
};
