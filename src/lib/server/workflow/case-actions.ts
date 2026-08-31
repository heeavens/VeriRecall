import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';

export class CaseWorkflowError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_state' | 'invalid_input',
    message: string
  ) {
    super(message);
    this.name = 'CaseWorkflowError';
  }
}

export interface UpdateDraftInput {
  actionId: string;
  actorName: string;
  subject: string;
  body: string;
}

export interface ApproveDraftInput {
  actionId: string;
  actorName: string;
}

export interface CompleteTaskInput {
  caseId: string;
  taskId: string;
  actorName: string;
}

export interface CloseCaseInput {
  caseId: string;
  actorName: string;
  closureNote: string;
  evidenceReference: string;
}

export interface DraftMutationResult {
  actionId: string;
  caseId: string;
  status: (typeof schema.actionDrafts.$inferSelect)['status'];
  changed: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface CaseMutationResult {
  caseId: string;
  status: (typeof schema.cases.$inferSelect)['status'];
  changed: boolean;
}

function cleanActorName(value: string): string {
  const actorName = value.trim();
  if (!actorName) {
    throw new CaseWorkflowError('invalid_input', 'Enter your name before confirming this action.');
  }
  return actorName;
}

function cleanClosureEvidence(input: CloseCaseInput): {
  closureNote: string;
  evidenceReference: string;
} {
  const closureNote = input.closureNote.trim();
  const evidenceReference = input.evidenceReference.trim();
  if (closureNote.length < 20) {
    throw new CaseWorkflowError(
      'invalid_input',
      'Add a closure note of at least 20 characters describing the containment evidence.'
    );
  }
  if (evidenceReference.length < 3) {
    throw new CaseWorkflowError(
      'invalid_input',
      'Add an evidence reference, such as a ticket, document, stock record or supplier reply.'
    );
  }
  return { closureNote, evidenceReference };
}

function caseRecord(database: RecallDatabase, caseId: string) {
  const record = database.select().from(schema.cases).where(eq(schema.cases.id, caseId)).get();
  if (!record) throw new CaseWorkflowError('not_found', 'The recall case could not be found.');
  return record;
}

function markContainedWhenReady(database: RecallDatabase, caseId: string): void {
  const record = caseRecord(database, caseId);
  if (record.status !== 'open') return;

  const tasks = database
    .select({ status: schema.caseTasks.status })
    .from(schema.caseTasks)
    .where(eq(schema.caseTasks.caseId, caseId))
    .all();
  if (tasks.length === 3 && tasks.every((task) => task.status !== 'pending')) {
    database.update(schema.cases).set({ status: 'contained' }).where(eq(schema.cases.id, caseId)).run();
  }
}

export function updateActionDraft(
  database: RecallDatabase,
  input: UpdateDraftInput,
  now = new Date()
): DraftMutationResult {
  const actorName = cleanActorName(input.actorName);
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject || !body) {
    throw new CaseWorkflowError('invalid_input', 'Subject and message body are required.');
  }

  return database.transaction((transaction) => {
    const draft = transaction
      .select({ draft: schema.actionDrafts, caseRecord: schema.cases })
      .from(schema.actionDrafts)
      .innerJoin(schema.cases, eq(schema.cases.id, schema.actionDrafts.caseId))
      .where(eq(schema.actionDrafts.id, input.actionId))
      .get();
    if (!draft) throw new CaseWorkflowError('not_found', 'The action draft could not be found.');
    if (draft.caseRecord.status === 'closed') {
      throw new CaseWorkflowError('invalid_state', 'Drafts cannot change after a case is closed.');
    }
    if (draft.draft.status !== 'draft') {
      throw new CaseWorkflowError('invalid_state', 'Only unsent drafts can be edited.');
    }
    if (draft.draft.subject === subject && draft.draft.body === body) {
      return {
        actionId: draft.draft.id,
        caseId: draft.draft.caseId,
        status: draft.draft.status,
        changed: false,
        approvedBy: draft.draft.approvedBy,
        approvedAt: draft.draft.approvedAt
      };
    }

    const createdAt = now.toISOString();
    transaction
      .update(schema.actionDrafts)
      .set({ subject, body })
      .where(eq(schema.actionDrafts.id, draft.draft.id))
      .run();
    transaction
      .insert(schema.auditEvents)
      .values({
        id: randomUUID(),
        caseId: draft.draft.caseId,
        alertId: draft.caseRecord.alertId,
        eventType: 'action_draft_edited',
        actorType: 'human',
        actorName,
        summary: `Edited the ${draft.draft.type.replaceAll('_', ' ')} draft.`,
        metadataJson: JSON.stringify({
          actionId: draft.draft.id,
          type: draft.draft.type,
          previousSubject: draft.draft.subject,
          previousBody: draft.draft.body,
          subject,
          body
        }),
        createdAt
      })
      .run();

    return {
      actionId: draft.draft.id,
      caseId: draft.draft.caseId,
      status: draft.draft.status,
      changed: true,
      approvedBy: null,
      approvedAt: null
    };
  });
}

export function approveActionDraft(
  database: RecallDatabase,
  input: ApproveDraftInput,
  now = new Date()
): DraftMutationResult {
  const actorName = cleanActorName(input.actorName);

  return database.transaction((transaction) => {
    const record = transaction
      .select({ draft: schema.actionDrafts, caseRecord: schema.cases })
      .from(schema.actionDrafts)
      .innerJoin(schema.cases, eq(schema.cases.id, schema.actionDrafts.caseId))
      .where(eq(schema.actionDrafts.id, input.actionId))
      .get();
    if (!record) throw new CaseWorkflowError('not_found', 'The action draft could not be found.');
    if (record.draft.status === 'simulated_sent') {
      return {
        actionId: record.draft.id,
        caseId: record.draft.caseId,
        status: record.draft.status,
        changed: false,
        approvedBy: record.draft.approvedBy,
        approvedAt: record.draft.approvedAt
      };
    }
    if (record.caseRecord.status === 'closed') {
      throw new CaseWorkflowError('invalid_state', 'Actions cannot be approved after a case is closed.');
    }
    if (record.draft.status === 'not_available') {
      throw new CaseWorkflowError('invalid_state', 'This action is unavailable for the case data.');
    }
    if (record.draft.type !== 'block_sale' && !record.draft.recipient) {
      throw new CaseWorkflowError('invalid_state', 'Recipient required before approval.');
    }

    const approvedAt = now.toISOString();
    transaction
      .update(schema.actionDrafts)
      .set({ status: 'simulated_sent', approvedBy: actorName, approvedAt })
      .where(eq(schema.actionDrafts.id, record.draft.id))
      .run();
    transaction
      .update(schema.caseTasks)
      .set({ status: 'completed', completedBy: actorName, completedAt: approvedAt })
      .where(
        and(
          eq(schema.caseTasks.caseId, record.draft.caseId),
          eq(schema.caseTasks.type, record.draft.type),
          eq(schema.caseTasks.status, 'pending')
        )
      )
      .run();
    transaction
      .insert(schema.auditEvents)
      .values([
        {
          id: randomUUID(),
          caseId: record.draft.caseId,
          alertId: record.caseRecord.alertId,
          eventType: 'action_draft_approved',
          actorType: 'human',
          actorName,
          summary: `Approved the ${record.draft.type.replaceAll('_', ' ')} action.`,
          metadataJson: JSON.stringify({ actionId: record.draft.id, type: record.draft.type }),
          createdAt: approvedAt
        },
        {
          id: randomUUID(),
          caseId: record.draft.caseId,
          alertId: record.caseRecord.alertId,
          eventType: 'action_simulated_sent',
          actorType: 'human',
          actorName,
          summary: `Recorded a simulated send for the ${record.draft.type.replaceAll('_', ' ')} action.`,
          metadataJson: JSON.stringify({
            actionId: record.draft.id,
            type: record.draft.type,
            externalSideEffect: false
          }),
          createdAt: approvedAt
        }
      ])
      .run();
    markContainedWhenReady(transaction, record.draft.caseId);

    return {
      actionId: record.draft.id,
      caseId: record.draft.caseId,
      status: 'simulated_sent',
      changed: true,
      approvedBy: actorName,
      approvedAt
    };
  });
}

export function completeCaseTask(
  database: RecallDatabase,
  input: CompleteTaskInput,
  now = new Date()
): CaseMutationResult {
  const actorName = cleanActorName(input.actorName);

  return database.transaction((transaction) => {
    const record = caseRecord(transaction, input.caseId);
    if (record.status === 'closed') {
      throw new CaseWorkflowError('invalid_state', 'Tasks cannot change after a case is closed.');
    }
    const task = transaction
      .select()
      .from(schema.caseTasks)
      .where(
        and(eq(schema.caseTasks.id, input.taskId), eq(schema.caseTasks.caseId, input.caseId))
      )
      .get();
    if (!task) throw new CaseWorkflowError('not_found', 'The checklist task could not be found.');
    if (task.status === 'not_available') {
      throw new CaseWorkflowError('invalid_state', 'This checklist task is not available.');
    }
    if (task.status === 'completed') {
      return { caseId: record.id, status: record.status, changed: false };
    }

    const completedAt = now.toISOString();
    transaction
      .update(schema.caseTasks)
      .set({ status: 'completed', completedBy: actorName, completedAt })
      .where(eq(schema.caseTasks.id, task.id))
      .run();
    transaction
      .insert(schema.auditEvents)
      .values({
        id: randomUUID(),
        caseId: record.id,
        alertId: record.alertId,
        eventType: 'case_task_completed',
        actorType: 'human',
        actorName,
        summary: `Completed checklist task: ${task.label}.`,
        metadataJson: JSON.stringify({ taskId: task.id, type: task.type }),
        createdAt: completedAt
      })
      .run();
    markContainedWhenReady(transaction, record.id);
    const updated = caseRecord(transaction, record.id);
    return { caseId: record.id, status: updated.status, changed: true };
  });
}

export function closeRecallCase(
  database: RecallDatabase,
  input: CloseCaseInput,
  now = new Date()
): CaseMutationResult {
  const actorName = cleanActorName(input.actorName);
  const { closureNote, evidenceReference } = cleanClosureEvidence(input);

  return database.transaction((transaction) => {
    const record = caseRecord(transaction, input.caseId);
    if (record.status === 'closed') {
      return { caseId: record.id, status: record.status, changed: false };
    }
    const tasks = transaction
      .select()
      .from(schema.caseTasks)
      .where(eq(schema.caseTasks.caseId, record.id))
      .all();
    if (tasks.length !== 3 || tasks.some((task) => task.status === 'pending')) {
      throw new CaseWorkflowError(
        'invalid_state',
        'Complete every available containment task before closing this case.'
      );
    }

    const closedAt = now.toISOString();
    transaction
      .update(schema.cases)
      .set({ status: 'closed', closedAt })
      .where(eq(schema.cases.id, record.id))
      .run();
    transaction
      .insert(schema.auditEvents)
      .values({
        id: randomUUID(),
        caseId: record.id,
        alertId: record.alertId,
        eventType: 'case_closed',
        actorType: 'human',
        actorName,
        summary: `Closed ${record.caseNumber} after containment tasks were confirmed.`,
        metadataJson: JSON.stringify({
          caseId: record.id,
          closureNote,
          evidenceReference
        }),
        createdAt: closedAt
      })
      .run();

    return { caseId: record.id, status: 'closed', changed: true };
  });
}
