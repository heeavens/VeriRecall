import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDashboardView } from '../alerts/queries';
import { getCaseDetail } from '../cases/queries';
import { createDatabaseConnection } from '../db/client';
import { CaseReportExporter } from '../exports/case-report';
import { getSetupState, useDemoData } from '../imports/setup';
import { approveActionDraft, closeRecallCase } from './case-actions';
import {
  confirmReviewMatch,
  getReviewQueueView,
  requestMatchEvidence
} from './review';

let temporaryDirectory: string;
let connection: ReturnType<typeof createDatabaseConnection>;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'recallops-demo-flow-test-'));
  connection = createDatabaseConnection(join(temporaryDirectory, 'recallops.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  useDemoData(connection.db);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('Stage 7 final demo flow', () => {
  it('moves from demo setup through evidence, confirmation, closure and both exports', async () => {
    const setup = getSetupState(connection.db);
    expect(setup.onboardingCompleted).toBe(true);
    expect(setup.productCount).toBeGreaterThan(0);

    const dashboard = getDashboardView(connection.db);
    expect(new Set(dashboard.alerts.map((alert) => alert.status))).toEqual(
      new Set(['matched', 'needs_review', 'not_relevant'])
    );

    const review = getReviewQueueView(connection.db);
    expect(review.selected).not.toBeNull();
    const evidence = requestMatchEvidence(
      connection.db,
      {
        matchId: review.selected!.match.id,
        actorName: 'Herman',
        requestedEvidence: ['barcode_photo']
      },
      new Date('2026-08-31T09:00:00Z')
    );
    const evidenceCase = getCaseDetail(connection.db, evidence.caseId);
    expect(evidenceCase?.drafts).toEqual([
      expect.objectContaining({ type: 'notify_supplier', status: 'draft' })
    ]);
    expect(
      evidenceCase?.timeline.some((event) => event.eventType === 'evidence_requested')
    ).toBe(true);

    const confirmed = confirmReviewMatch(
      connection.db,
      { matchId: review.selected!.match.id, actorName: 'Herman' },
      new Date('2026-08-31T09:01:00Z')
    );
    expect(confirmed.caseId).toBe(evidence.caseId);

    const opened = getCaseDetail(connection.db, confirmed.caseId);
    expect(opened).toMatchObject({ totalStock: 42, completedTasks: 0, actionableTasks: 3 });
    expect(opened?.drafts).toHaveLength(3);

    opened?.drafts.forEach((draft, index) => {
      approveActionDraft(
        connection.db,
        { actionId: draft.id, actorName: 'Herman' },
        new Date(`2026-08-31T09:0${index + 2}:00Z`)
      );
    });

    const contained = getCaseDetail(connection.db, confirmed.caseId);
    expect(contained?.caseRecord.status).toBe('contained');
    expect(contained?.tasks.every((task) => task.status !== 'pending')).toBe(true);
    expect(contained?.drafts.every((draft) => draft.status === 'simulated_sent')).toBe(true);

    closeRecallCase(
      connection.db,
      { caseId: confirmed.caseId, actorName: 'Herman' },
      new Date('2026-08-31T09:10:00Z')
    );
    const closed = getCaseDetail(connection.db, confirmed.caseId);
    expect(closed?.caseRecord).toMatchObject({
      status: 'closed',
      closedAt: '2026-08-31T09:10:00.000Z'
    });
    expect(closed?.timeline.some((event) => event.eventType === 'case_closed')).toBe(true);

    const exporter = new CaseReportExporter(
      connection.db,
      () => '2026-08-31T09:11:00.000Z'
    );
    const csv = new TextDecoder().decode(await exporter.exportCase(confirmed.caseId, 'csv'));
    expect(csv).toContain('Case summary');
    expect(csv).toContain('closed');
    expect(csv).toContain('simulated_sent');

    const pdf = await exporter.exportCase(confirmed.caseId, 'pdf');
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(0);
  });
});
