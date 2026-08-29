import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';

import { getCaseDetail } from '$lib/server/cases/queries';
import { db } from '$lib/server/db/connection';
import {
  CaseWorkflowError,
  closeRecallCase,
  completeCaseTask
} from '$lib/server/workflow/case-actions';

import type { Actions, PageServerLoad } from './$types';

const actorSchema = z.object({
  actorName: z.string().trim().min(1).max(80)
});

const taskSchema = actorSchema.extend({
  taskId: z.string().uuid()
});

function workflowFailure(kind: 'task' | 'close', workflowError: unknown) {
  if (workflowError instanceof CaseWorkflowError) {
    const status = workflowError.code === 'not_found' ? 404 : 409;
    return fail(status, {
      kind,
      success: false as const,
      message: workflowError.message
    });
  }
  return fail(500, {
    kind,
    success: false as const,
    message: 'The case update could not be saved. No partial changes were applied.'
  });
}

export const load: PageServerLoad = ({ params }) => {
  const detail = getCaseDetail(db, params.id);
  if (!detail) error(404, 'Recall case not found');
  return detail;
};

export const actions: Actions = {
  completeTask: async ({ params, request }) => {
    const formData = await request.formData();
    const input = taskSchema.safeParse({
      taskId: formData.get('taskId'),
      actorName: formData.get('actorName')
    });
    if (!input.success) {
      return fail(400, {
        kind: 'task' as const,
        success: false as const,
        message: 'Choose a valid task and enter your name.'
      });
    }

    try {
      const result = completeCaseTask(db, { caseId: params.id, ...input.data });
      return {
        kind: 'task' as const,
        success: true as const,
        message: result.changed
          ? 'Checklist task completed and added to the audit timeline.'
          : 'This checklist task was already completed.'
      };
    } catch (workflowError) {
      return workflowFailure('task', workflowError);
    }
  },

  close: async ({ params, request }) => {
    const formData = await request.formData();
    const input = actorSchema.safeParse({ actorName: formData.get('actorName') });
    if (!input.success) {
      return fail(400, {
        kind: 'close' as const,
        success: false as const,
        message: 'Enter your name before closing the case.'
      });
    }

    try {
      const result = closeRecallCase(db, { caseId: params.id, ...input.data });
      return {
        kind: 'close' as const,
        success: true as const,
        message: result.changed ? 'Case closed and recorded in the audit log.' : 'Case already closed.'
      };
    } catch (workflowError) {
      return workflowFailure('close', workflowError);
    }
  }
};
