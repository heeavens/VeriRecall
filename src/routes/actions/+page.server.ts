import { fail } from '@sveltejs/kit';
import { z } from 'zod';

import { getActionDraftsView } from '$lib/server/cases/queries';
import { db } from '$lib/server/db/connection';
import {
  approveActionDraft,
  CaseWorkflowError,
  updateActionDraft
} from '$lib/server/workflow/case-actions';

import type { Actions, PageServerLoad } from './$types';

const actorSchema = z.object({
  actionId: z.string().uuid(),
  actorName: z.string().trim().min(1).max(80)
});

const updateSchema = actorSchema.extend({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000)
});

function workflowFailure(kind: 'update' | 'approve', workflowError: unknown) {
  if (workflowError instanceof CaseWorkflowError) {
    const status = workflowError.code === 'not_found' ? 404 : workflowError.code === 'invalid_input' ? 400 : 409;
    return fail(status, { kind, success: false as const, message: workflowError.message });
  }
  return fail(500, {
    kind,
    success: false as const,
    message: 'The action could not be saved. No partial changes were applied.'
  });
}

export const load: PageServerLoad = ({ url }) => ({
  actions: getActionDraftsView(db, url.searchParams.get('case'))
});

export const actions: Actions = {
  update: async ({ request }) => {
    const formData = await request.formData();
    const input = updateSchema.safeParse({
      actionId: formData.get('actionId'),
      actorName: formData.get('actorName'),
      subject: formData.get('subject'),
      body: formData.get('body')
    });
    if (!input.success) {
      return fail(400, {
        kind: 'update' as const,
        success: false as const,
        message: 'Subject, message body and reviewer name are required.'
      });
    }

    try {
      const result = updateActionDraft(db, input.data);
      return {
        kind: 'update' as const,
        success: true as const,
        message: result.changed ? 'Draft updated and added to the audit timeline.' : 'No draft changes to save.'
      };
    } catch (workflowError) {
      return workflowFailure('update', workflowError);
    }
  },

  approve: async ({ request }) => {
    const formData = await request.formData();
    const input = actorSchema.safeParse({
      actionId: formData.get('actionId'),
      actorName: formData.get('actorName')
    });
    if (!input.success) {
      return fail(400, {
        kind: 'approve' as const,
        success: false as const,
        message: 'Choose a valid draft and enter the approving reviewer name.'
      });
    }

    try {
      const result = approveActionDraft(db, input.data);
      return {
        kind: 'approve' as const,
        success: true as const,
        message: result.changed
          ? 'Approval recorded. The action is marked SIMULATED SEND; no external message was sent.'
          : 'This action already has a simulated-send record.'
      };
    } catch (workflowError) {
      return workflowFailure('approve', workflowError);
    }
  }
};
