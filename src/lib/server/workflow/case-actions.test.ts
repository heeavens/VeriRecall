import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getActionDraftsView, getCaseDetail, getCasesView } from '../cases/queries';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import { actionDrafts, auditEvents, caseTasks, cases } from '../db/schema';
import {
  approveActionDraft,
  closeRecallCase,
  completeCaseTask,
  updateActionDraft
} from './case-actions';
import { confirmReviewMatch } from './review';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const highConfidenceMatchId = '50000000-0000-4000-8000-000000000001';
const uncertainMatchId = '50000000-0000-4000-8000-000000000002';

let temporaryDirectory: string;
let connection: TestConnection;
let seededCaseId: string;
let blockSaleDraftId: string;

function caseEventCount(caseId: string): number {
  return connection.db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(eq(auditEvents.caseId, caseId))
    .all().length;
}

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'recallops-case-actions-test-'));
  connection = createDatabaseConnection(join(temporaryDirectory, 'recallops.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, loadDemoFixtures());
  const confirmed = confirmReviewMatch(
    connection.db,
    { matchId: highConfidenceMatchId, actorName: 'Herman' },
    new Date('2026-08-29T09:00:00Z')
  );
  seededCaseId = confirmed.caseId;
  blockSaleDraftId = getCaseDetail(connection.db, seededCaseId)!.drafts.find(
    (draft) => draft.type === 'block_sale'
  )!.id;
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('Stage 5 incident response workflow', () => {
  it('exposes the next containment task and pending approvals in the case register', () => {
    const [caseView] = getCasesView(connection.db);

    expect(caseView).toMatchObject({
      pendingTasks: 3,
      nextTaskLabel: 'Block sale for affected inventory',
      pendingApprovals: 3,
      completedTasks: 0,
      actionableTasks: 3
    });
  });

  it('initializes three checklist tasks and unsent drafts when review opens a case', () => {
    const result = confirmReviewMatch(
      connection.db,
      { matchId: uncertainMatchId, actorName: 'Herman' },
      new Date('2026-08-29T13:00:00Z')
    );
    const detail = getCaseDetail(connection.db, result.caseId);

    expect(detail?.items).toHaveLength(1);
    expect(detail?.tasks.map((task) => task.type)).toEqual([
      'block_sale',
      'notify_supplier',
      'notify_customers'
    ]);
    expect(detail?.tasks.every((task) => task.status === 'pending')).toBe(true);
    expect(detail?.drafts).toHaveLength(3);
    expect(detail?.drafts.every((draft) => draft.status === 'draft')).toBe(true);
    expect(
      detail?.timeline.filter((event) => event.eventType === 'action_simulated_sent')
    ).toHaveLength(0);
  });

  it('edits an unsent draft without approving or simulating a send', () => {
    const result = updateActionDraft(
      connection.db,
      {
        actionId: blockSaleDraftId,
        actorName: 'Herman',
        subject: 'Updated internal sales hold',
        body: 'Hold every affected unit pending the final containment review.'
      },
      new Date('2026-08-29T14:00:00Z')
    );
    const draft = connection.db
      .select()
      .from(actionDrafts)
      .where(eq(actionDrafts.id, blockSaleDraftId))
      .get();

    expect(result.changed).toBe(true);
    expect(draft).toMatchObject({
      subject: 'Updated internal sales hold',
      status: 'draft',
      approvedBy: null,
      approvedAt: null
    });
    expect(
      connection.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.caseId, seededCaseId),
            eq(auditEvents.eventType, 'action_simulated_sent')
          )
        )
        .all()
    ).toHaveLength(0);
  });

  it('records actor and time once when an action is approved for simulated send', () => {
    const first = approveActionDraft(
      connection.db,
      { actionId: blockSaleDraftId, actorName: 'Herman' },
      new Date('2026-08-29T15:00:00Z')
    );
    const countAfterFirst = caseEventCount(seededCaseId);
    const repeated = approveActionDraft(
      connection.db,
      { actionId: blockSaleDraftId, actorName: 'Another Reviewer' },
      new Date('2026-08-29T15:01:00Z')
    );
    const draft = connection.db
      .select()
      .from(actionDrafts)
      .where(eq(actionDrafts.id, blockSaleDraftId))
      .get();
    const task = connection.db
      .select()
      .from(caseTasks)
      .where(and(eq(caseTasks.caseId, seededCaseId), eq(caseTasks.type, 'block_sale')))
      .get();
    const timeline = getCaseDetail(connection.db, seededCaseId)?.timeline ?? [];

    expect(first).toMatchObject({
      changed: true,
      status: 'simulated_sent',
      approvedBy: 'Herman',
      approvedAt: '2026-08-29T15:00:00.000Z'
    });
    expect(repeated).toEqual({ ...first, changed: false });
    expect(draft).toMatchObject({
      status: 'simulated_sent',
      approvedBy: 'Herman',
      approvedAt: '2026-08-29T15:00:00.000Z'
    });
    expect(task).toMatchObject({
      status: 'completed',
      completedBy: 'Herman',
      completedAt: '2026-08-29T15:00:00.000Z'
    });
    expect(caseEventCount(seededCaseId)).toBe(countAfterFirst);
    expect(new Set(timeline.map((event) => event.actorType))).toEqual(new Set(['human']));
    expect(timeline.filter((event) => event.eventType === 'action_simulated_sent')).toHaveLength(1);
  });

  it('places drafts awaiting a human decision before recorded outcomes', () => {
    approveActionDraft(
      connection.db,
      { actionId: blockSaleDraftId, actorName: 'Herman' },
      new Date('2026-08-29T15:00:00Z')
    );

    const approvals = getActionDraftsView(connection.db, seededCaseId);

    expect(approvals.map((item) => item.draft.status)).toEqual([
      'draft',
      'draft',
      'simulated_sent'
    ]);
    expect(approvals.every((item) => item.caseRecord.id === seededCaseId)).toBe(true);
  });

  it('blocks incomplete closure, then closes once after all checklist tasks complete', () => {
    const eventsBeforeClose = caseEventCount(seededCaseId);
    expect(() =>
      closeRecallCase(
        connection.db,
        {
          caseId: seededCaseId,
          actorName: 'Herman',
          closureNote: 'All containment tasks are complete and verified.',
          evidenceReference: 'STOCK-HOLD-1042'
        },
        new Date('2026-08-29T16:00:00Z')
      )
    ).toThrow('Complete every available containment task before closing this case.');
    expect(connection.db.select().from(cases).where(eq(cases.id, seededCaseId)).get())
      .toMatchObject({ status: 'open', closedAt: null });
    expect(caseEventCount(seededCaseId)).toBe(eventsBeforeClose);

    const pendingTasks = connection.db
      .select()
      .from(caseTasks)
      .where(eq(caseTasks.caseId, seededCaseId))
      .all();
    pendingTasks.forEach((task, index) => {
      completeCaseTask(
        connection.db,
        { caseId: seededCaseId, taskId: task.id, actorName: 'Herman' },
        new Date(`2026-08-29T16:0${index + 1}:00Z`)
      );
    });
    expect(connection.db.select().from(cases).where(eq(cases.id, seededCaseId)).get())
      .toMatchObject({ status: 'contained', closedAt: null });

    expect(() =>
      closeRecallCase(connection.db, {
        caseId: seededCaseId,
        actorName: 'Herman',
        closureNote: 'Too short',
        evidenceReference: 'STOCK-HOLD-1042'
      })
    ).toThrow('Add a closure note of at least 20 characters');

    const first = closeRecallCase(
      connection.db,
      {
        caseId: seededCaseId,
        actorName: 'Herman',
        closureNote: 'All containment tasks are complete and verified.',
        evidenceReference: 'STOCK-HOLD-1042'
      },
      new Date('2026-08-29T16:10:00Z')
    );
    const countAfterFirst = caseEventCount(seededCaseId);
    const repeated = closeRecallCase(
      connection.db,
      {
        caseId: seededCaseId,
        actorName: 'Herman',
        closureNote: 'All containment tasks are complete and verified.',
        evidenceReference: 'STOCK-HOLD-1042'
      },
      new Date('2026-08-29T16:11:00Z')
    );

    expect(first).toEqual({ caseId: seededCaseId, status: 'closed', changed: true });
    expect(repeated).toEqual({ caseId: seededCaseId, status: 'closed', changed: false });
    expect(connection.db.select().from(cases).where(eq(cases.id, seededCaseId)).get())
      .toMatchObject({ status: 'closed', closedAt: '2026-08-29T16:10:00.000Z' });
    expect(caseEventCount(seededCaseId)).toBe(countAfterFirst);
    expect(getCaseDetail(connection.db, seededCaseId)?.closureEvidence).toEqual({
      note: 'All containment tasks are complete and verified.',
      reference: 'STOCK-HOLD-1042',
      actorName: 'Herman',
      recordedAt: '2026-08-29T16:10:00.000Z'
    });
  });
});
