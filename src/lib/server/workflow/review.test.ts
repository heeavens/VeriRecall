import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import {
  actionDrafts,
  alerts,
  auditEvents,
  caseItems,
  cases,
  evidenceRequests,
  matches
} from '../db/schema';
import {
  confirmReviewMatch,
  getReviewQueueView,
  rejectReviewMatch,
  requestMatchEvidence
} from './review';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const uncertainMatchId = '50000000-0000-4000-8000-000000000002';
const uncertainAlertId = '40000000-0000-4000-8000-000000000002';
const actor = { matchId: uncertainMatchId, actorName: 'Herman' };

let temporaryDirectory: string;
let connection: TestConnection;

function tableCount(tableName: string): number {
  const row = connection.sqlite.prepare(`select count(*) as value from ${tableName}`).get() as {
    value: number;
  };
  return row.value;
}

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'recallops-review-test-'));
  connection = createDatabaseConnection(join(temporaryDirectory, 'recallops.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, loadDemoFixtures());
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('Stage 4 human review workflow', () => {
  it('places the uncertain fixture in the queue with positive and conflicting signals', () => {
    const queue = getReviewQueueView(connection.db);

    expect(queue.items).toHaveLength(1);
    expect(queue.selected?.match.id).toBe(uncertainMatchId);
    expect(queue.selected?.match.status).toBe('candidate');
    expect(queue.selected?.positiveReasons.length).toBeGreaterThanOrEqual(1);
    expect(queue.selected?.uncertaintyReasons.length).toBeGreaterThanOrEqual(1);
    expect(queue.selected?.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tone: 'positive' }),
        expect.objectContaining({ tone: 'conflict' }),
        expect.objectContaining({ tone: 'missing' })
      ])
    );
    expect(queue.selected?.recommendedEvidence).toEqual([
      'barcode_photo',
      'supplier_invoice',
      'batch_label_photo'
    ]);
  });

  it('refuses a direct decision for a match outside the review queue', () => {
    const notRelevantMatchId = '50000000-0000-4000-8000-000000000003';

    expect(() =>
      confirmReviewMatch(connection.db, {
        matchId: notRelevantMatchId,
        actorName: 'Herman'
      })
    ).toThrow('This match is not awaiting a human review decision.');
    expect(tableCount('cases')).toBe(1);
    expect(tableCount('case_items')).toBe(1);
    expect(tableCount('audit_events')).toBe(5);
    expect(connection.db.select().from(matches).where(eq(matches.id, notRelevantMatchId)).get())
      .toMatchObject({ status: 'candidate', decidedAt: null });
  });

  it('confirms once, creates a case item and reuses both on a repeated decision', () => {
    const first = confirmReviewMatch(connection.db, actor, new Date('2026-08-29T10:00:00Z'));
    const afterFirst = {
      cases: tableCount('cases'),
      caseItems: tableCount('case_items'),
      auditEvents: tableCount('audit_events')
    };
    const repeated = confirmReviewMatch(
      connection.db,
      actor,
      new Date('2026-08-29T10:01:00Z')
    );

    expect(first).toMatchObject({ changed: true, caseNumber: 'CASE-0002' });
    expect(repeated).toMatchObject({ changed: false, caseId: first.caseId });
    expect(afterFirst).toEqual({ cases: 2, caseItems: 2, auditEvents: 10 });
    expect({
      cases: tableCount('cases'),
      caseItems: tableCount('case_items'),
      auditEvents: tableCount('audit_events')
    }).toEqual(afterFirst);
    expect(connection.db.select().from(matches).where(eq(matches.id, uncertainMatchId)).get())
      .toMatchObject({ status: 'confirmed', decidedAt: '2026-08-29T10:00:00.000Z' });
    expect(connection.db.select().from(alerts).where(eq(alerts.id, uncertainAlertId)).get())
      .toMatchObject({ status: 'matched' });
    expect(connection.db.select().from(caseItems).where(eq(caseItems.caseId, first.caseId)).all())
      .toHaveLength(1);
  });

  it('rejects once without creating a case or duplicate audit events', () => {
    const first = rejectReviewMatch(connection.db, actor, new Date('2026-08-29T11:00:00Z'));
    const afterFirst = {
      cases: tableCount('cases'),
      caseItems: tableCount('case_items'),
      auditEvents: tableCount('audit_events')
    };
    const repeated = rejectReviewMatch(
      connection.db,
      actor,
      new Date('2026-08-29T11:01:00Z')
    );

    expect(first.changed).toBe(true);
    expect(repeated.changed).toBe(false);
    expect(afterFirst).toEqual({ cases: 1, caseItems: 1, auditEvents: 6 });
    expect({
      cases: tableCount('cases'),
      caseItems: tableCount('case_items'),
      auditEvents: tableCount('audit_events')
    }).toEqual(afterFirst);
    expect(connection.db.select().from(cases).where(eq(cases.alertId, uncertainAlertId)).get())
      .toBeUndefined();
    expect(connection.db.select().from(matches).where(eq(matches.id, uncertainMatchId)).get())
      .toMatchObject({ status: 'rejected', decidedAt: '2026-08-29T11:00:00.000Z' });
    expect(connection.db.select().from(alerts).where(eq(alerts.id, uncertainAlertId)).get())
      .toMatchObject({ status: 'not_relevant' });
  });

  it('creates one evidence request and unsent supplier draft, then reuses its case on confirm', () => {
    const input = {
      ...actor,
      requestedEvidence: ['barcode_photo', 'supplier_invoice', 'batch_label_photo'] as const
    };
    const first = requestMatchEvidence(
      connection.db,
      { ...input, requestedEvidence: [...input.requestedEvidence] },
      new Date('2026-08-29T12:00:00Z')
    );
    const afterFirst = {
      cases: tableCount('cases'),
      caseItems: tableCount('case_items'),
      evidenceRequests: tableCount('evidence_requests'),
      actionDrafts: tableCount('action_drafts'),
      auditEvents: tableCount('audit_events')
    };
    const repeated = requestMatchEvidence(
      connection.db,
      { ...input, requestedEvidence: [...input.requestedEvidence] },
      new Date('2026-08-29T12:01:00Z')
    );

    expect(first.changed).toBe(true);
    expect(repeated).toEqual({ ...first, changed: false });
    expect(afterFirst).toEqual({
      cases: 2,
      caseItems: 1,
      evidenceRequests: 1,
      actionDrafts: 4,
      auditEvents: 8
    });
    expect({
      cases: tableCount('cases'),
      caseItems: tableCount('case_items'),
      evidenceRequests: tableCount('evidence_requests'),
      actionDrafts: tableCount('action_drafts'),
      auditEvents: tableCount('audit_events')
    }).toEqual(afterFirst);
    expect(connection.db.select().from(evidenceRequests).where(eq(evidenceRequests.id, first.evidenceRequestId)).get())
      .toMatchObject({ status: 'pending' });
    expect(connection.db.select().from(actionDrafts).where(eq(actionDrafts.id, first.draftId)).get())
      .toMatchObject({ status: 'draft', type: 'notify_supplier' });
    expect(connection.db.select().from(matches).where(eq(matches.id, uncertainMatchId)).get())
      .toMatchObject({ status: 'awaiting_evidence', decidedAt: null });

    const confirmed = confirmReviewMatch(
      connection.db,
      actor,
      new Date('2026-08-29T12:02:00Z')
    );
    expect(confirmed).toMatchObject({ changed: true, caseId: first.caseId });
    expect(tableCount('cases')).toBe(2);
    expect(tableCount('case_items')).toBe(2);
    expect(connection.db.select().from(auditEvents).where(eq(auditEvents.caseId, first.caseId)).all())
      .toHaveLength(6);
  });
});
