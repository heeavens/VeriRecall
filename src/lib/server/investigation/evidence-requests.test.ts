import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { rebaseUndecidedDemoMatchFixture } from '../testing/alert-provenance-fixtures';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import {
  InvestigationEvidenceRequestError,
  requestInvestigationEvidence,
  type RequestInvestigationEvidenceInput
} from './evidence-requests';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const fixtures = loadDemoFixtures();
const gapMatchId = '50000000-0000-4000-8000-000000000002';
const createdAt = '2026-09-09T09:00:00.000Z';
const context = { mode: 'demo' as const };

let directory: string;
let connection: TestConnection;

function versionedGapCase() {
  const confirmed = confirmReviewMatch(
    connection.db,
    { matchId: gapMatchId, actorName: 'demo_operator' },
    new Date('2026-09-09T08:00:00.000Z'),
    context
  );
  const snapshot = readCaseSnapshot(connection.db, confirmed.caseId);
  if (!snapshot?.investigation) throw new Error('Expected a versioned investigation.');
  const gap = snapshot.investigation.gaps.find((issue) => issue.code === 'BATCH_MISSING');
  if (!gap) throw new Error('Expected the current batch gap.');
  return { confirmed, gap, snapshot };
}

function inputFor(
  caseId: string,
  questionRef: string,
  expectedCaseVersion: number,
  overrides: Partial<RequestInvestigationEvidenceInput> = {}
): RequestInvestigationEvidenceInput {
  return {
    requestId: '90000000-0000-4000-8000-000000000001',
    caseId,
    questionRef,
    expectedCaseVersion,
    requestedEvidence: ['supplier_invoice', 'barcode_photo', 'supplier_invoice'],
    demo: true,
    ...overrides
  } as RequestInvestigationEvidenceInput;
}

function request(input: RequestInvestigationEvidenceInput) {
  return requestInvestigationEvidence(connection.db, input, context, new Date(createdAt));
}

function expectRequestError(
  action: () => unknown,
  code: InvestigationEvidenceRequestError['code']
) {
  try {
    action();
    throw new Error('Expected investigation evidence request to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationEvidenceRequestError);
    expect(error).toMatchObject({ code });
  }
}

function tableCount(tableName: string): number {
  return connection.sqlite.prepare(`select count(*) from ${tableName}`).pluck().get() as number;
}

function workflowState(caseId: string, matchId: string) {
  return {
    lifecycle: connection.db.select().from(schema.caseLifecycle)
      .where(eq(schema.caseLifecycle.caseId, caseId)).get(),
    revisions: tableCount('case_revisions'),
    commands: tableCount('case_commands'),
    drafts: tableCount('action_drafts'),
    items: tableCount('case_items'),
    tasks: tableCount('case_tasks'),
    traceability: tableCount('traceability_records'),
    match: connection.db.select().from(schema.matches).where(eq(schema.matches.id, matchId)).get(),
    alert: connection.db.select().from(schema.alerts).where(eq(schema.alerts.id,
      fixtures.matches.find((match) => match.id === matchId)!.alertId)).get()
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-evidence-requests-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('versioned investigation evidence requests', () => {
  it('persists a pending request for the exact current BATCH_MISSING question only', () => {
    const { gap, snapshot } = versionedGapCase();
    const beforeSnapshot = structuredClone(snapshot);
    const beforeWorkflow = workflowState(snapshot.caseId, gapMatchId);
    const beforeAuditCount = tableCount('audit_events');
    const input = inputFor(snapshot.caseId, gap.id, snapshot.caseVersion);

    const result = request(input);
    const stored = connection.db.select().from(schema.evidenceRequests)
      .where(eq(schema.evidenceRequests.id, input.requestId)).get();

    expect(result).toEqual({
      request: {
        id: input.requestId,
        matchId: gapMatchId,
        caseId: snapshot.caseId,
        questionRef: gap.id,
        requestedEvidence: ['barcode_photo', 'supplier_invoice'],
        recipient: fixtures.products[1].supplierEmail,
        status: 'pending',
        createdAt,
        resolvedAt: null
      },
      replayed: false
    });
    expect(stored).toMatchObject({
      id: input.requestId,
      matchId: gapMatchId,
      caseId: snapshot.caseId,
      questionRef: gap.id,
      requestedEvidence: '["barcode_photo","supplier_invoice"]',
      recipient: fixtures.products[1].supplierEmail,
      status: 'pending',
      createdAt,
      resolvedAt: null
    });
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(beforeSnapshot);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toMatchObject({
      caseVersion: snapshot.caseVersion,
      materialRevision: snapshot.materialRevision
    });
    expect(workflowState(snapshot.caseId, gapMatchId)).toEqual(beforeWorkflow);
    expect(tableCount('audit_events')).toBe(beforeAuditCount + 1);
    const auditEvent = connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, 'investigation_evidence_requested')).get();
    expect(auditEvent).toMatchObject({ caseId: snapshot.caseId, actorName: 'demo_operator' });
    expect(JSON.parse(auditEvent!.metadataJson)).toEqual({
      requestId: input.requestId,
      caseId: snapshot.caseId,
      questionRef: gap.id,
      requestedEvidence: ['barcode_photo', 'supplier_invoice'],
      caseVersion: snapshot.caseVersion,
      materialRevision: snapshot.materialRevision,
      matchId: gapMatchId,
      demo: true
    });
  });

  it('replays the same semantic request without another row or audit event', () => {
    const { gap, snapshot } = versionedGapCase();
    const firstInput = inputFor(snapshot.caseId, gap.id, snapshot.caseVersion);
    const first = request(firstInput);
    const auditCount = tableCount('audit_events');
    const replay = request(inputFor(snapshot.caseId, gap.id, snapshot.caseVersion, {
      requestedEvidence: ['barcode_photo', 'supplier_invoice']
    }));

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ request: first.request, replayed: true });
    expect(tableCount('evidence_requests')).toBe(1);
    expect(tableCount('audit_events')).toBe(auditCount);
  });

  it('rejects reuse of a request ID with changed evidence, case or question', () => {
    const { gap, snapshot } = versionedGapCase();
    const input = inputFor(snapshot.caseId, gap.id, snapshot.caseVersion);
    request(input);

    expectRequestError(() => request({ ...input, requestedEvidence: ['batch_label_photo'] }),
      'REQUEST_CONFLICT');
    expectRequestError(() => request({ ...input, questionRef: 'demo:another-question' }),
      'REQUEST_CONFLICT');
    expectRequestError(() => request({ ...input, caseId: randomUUID() }),
      'REQUEST_CONFLICT');
    expect(tableCount('evidence_requests')).toBe(1);
  });

  it('allows a new request ID as another attempt for the same current question', () => {
    const { gap, snapshot } = versionedGapCase();
    request(inputFor(snapshot.caseId, gap.id, snapshot.caseVersion));

    const second = request(inputFor(snapshot.caseId, gap.id, snapshot.caseVersion, {
      requestId: '90000000-0000-4000-8000-000000000002'
    }));

    expect(second.replayed).toBe(false);
    expect(tableCount('evidence_requests')).toBe(2);
    expect(tableCount('investigation_evidence')).toBe(0);
  });

  it('rejects a stale case version without writing request or audit data', () => {
    const { gap, snapshot } = versionedGapCase();
    const beforeAuditCount = tableCount('audit_events');

    expectRequestError(() => request(inputFor(snapshot.caseId, gap.id, snapshot.caseVersion - 1)),
      'STALE_CASE_VERSION');
    expect(tableCount('evidence_requests')).toBe(0);
    expect(tableCount('audit_events')).toBe(beforeAuditCount);
  });

  it('rejects an unknown question and a question present only in conflicts', () => {
    const { snapshot } = versionedGapCase();
    const conflictRef = snapshot.investigation!.conflicts[0].id;
    const beforeAuditCount = tableCount('audit_events');

    expectRequestError(() => request(inputFor(snapshot.caseId, 'demo:not-current', snapshot.caseVersion)),
      'QUESTION_NOT_CURRENT');
    expectRequestError(() => request(inputFor(snapshot.caseId, conflictRef, snapshot.caseVersion)),
      'QUESTION_NOT_CURRENT');
    expect(tableCount('evidence_requests')).toBe(0);
    expect(tableCount('audit_events')).toBe(beforeAuditCount);
  });

  it('does not invent a question for UNKNOWN identity without a gap', () => {
    const match = fixtures.matches[0];
    connection.db.update(schema.alerts).set({ ean: null })
      .where(eq(schema.alerts.id, match.alertId)).run();
    rebaseUndecidedDemoMatchFixture(connection.db, {
      matchId: match.id,
      sourceFields: { ean: null },
      observedAt: '2026-09-09T07:59:00.000Z'
    });
    const confirmed = confirmReviewMatch(
      connection.db,
      { matchId: match.id, actorName: 'demo_operator' },
      new Date('2026-09-09T08:00:00.000Z'),
      context
    );
    const snapshot = readCaseSnapshot(connection.db, confirmed.caseId)!;
    expect(snapshot.investigation).toMatchObject({
      identity: { knowledgeStatus: 'UNKNOWN', conclusion: 'UNRESOLVED' },
      gaps: []
    });

    expectRequestError(() => request(inputFor(snapshot.caseId,
      `demo:identity-gap:${match.id}`, snapshot.caseVersion)), 'QUESTION_NOT_CURRENT');
    expect(tableCount('evidence_requests')).toBe(0);
  });

  it('does not treat another current Issue code as a supported question yet', () => {
    const { gap, snapshot } = versionedGapCase();
    const unsupportedGap = {
      ...structuredClone(gap),
      id: 'demo:identity-gap:explicit-but-unsupported',
      code: 'IDENTITY_MISSING',
      message: 'Obtain deterministic identity evidence.'
    };
    const changedSnapshot = {
      ...structuredClone(snapshot),
      investigation: {
        ...structuredClone(snapshot.investigation!),
        gaps: [unsupportedGap]
      },
      uncertainties: [unsupportedGap]
    };
    connection.db.update(schema.caseLifecycle).set({
      snapshotJson: JSON.stringify(changedSnapshot)
    }).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).run();

    expectRequestError(() => request(inputFor(
      snapshot.caseId,
      unsupportedGap.id,
      snapshot.caseVersion
    )), 'QUESTION_NOT_CURRENT');
    expect(tableCount('evidence_requests')).toBe(0);
  });

  it('rejects a duplicated current gap identity as ambiguous', () => {
    const { gap, snapshot } = versionedGapCase();
    const duplicatedSnapshot = {
      ...structuredClone(snapshot),
      investigation: {
        ...structuredClone(snapshot.investigation!),
        gaps: [structuredClone(gap), structuredClone(gap)]
      }
    };
    connection.db.update(schema.caseLifecycle).set({
      snapshotJson: JSON.stringify(duplicatedSnapshot)
    }).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).run();

    expectRequestError(() => request(inputFor(
      snapshot.caseId,
      gap.id,
      snapshot.caseVersion
    )), 'QUESTION_AMBIGUOUS');
    expect(tableCount('evidence_requests')).toBe(0);
  });

  it('rejects missing and ambiguous derived matches instead of choosing one', () => {
    const missing = versionedGapCase();
    connection.db.delete(schema.alertMatchBases).where(eq(schema.alertMatchBases.matchId, gapMatchId)).run();
    connection.db.delete(schema.matches).where(eq(schema.matches.id, gapMatchId)).run();
    expectRequestError(() => request(inputFor(
      missing.snapshot.caseId,
      missing.gap.id,
      missing.snapshot.caseVersion
    )), 'MATCH_NOT_FOUND');

    connection.sqlite.close();
    connection = createDatabaseConnection(join(directory, 'ambiguous.db'));
    migrate(connection.db, { migrationsFolder: resolve('drizzle') });
    seedDemoData(connection.db, fixtures);
    const ambiguous = versionedGapCase();
    const original = fixtures.matches.find((match) => match.id === gapMatchId)!;
    connection.db.insert(schema.matches).values({
      ...original,
      id: '50000000-0000-4000-8000-000000000099'
    }).run();

    expectRequestError(() => request(inputFor(
      ambiguous.snapshot.caseId,
      ambiguous.gap.id,
      ambiguous.snapshot.caseVersion
    )), 'MATCH_AMBIGUOUS');
    expect(tableCount('evidence_requests')).toBe(0);
  });

  it('rejects disabled mode and invalid evidence selections without writes', () => {
    const { gap, snapshot } = versionedGapCase();
    const input = inputFor(snapshot.caseId, gap.id, snapshot.caseVersion);

    expectRequestError(
      () => requestInvestigationEvidence(connection.db, input, { mode: 'disabled' }),
      'FORBIDDEN'
    );
    expectRequestError(() => request({ ...input, requestedEvidence: [] }), 'INVALID_INPUT');
    expect(tableCount('evidence_requests')).toBe(0);
  });
});
