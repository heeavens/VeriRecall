import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import {
  getInvestigationClaim,
  InvestigationClaimError,
  listInvestigationClaims,
  recordInvestigationClaim,
  type RecordInvestigationClaimInput
} from './claims';
import { recordInvestigationEvidence } from './evidence-registry';
import { requestInvestigationEvidence } from './evidence-requests';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const fixtures = loadDemoFixtures();
const gapMatchId = '50000000-0000-4000-8000-000000000002';
const context = { mode: 'demo' as const };
const claimCreatedAt = '2026-09-09T14:00:00.000Z';

let directory: string;
let databasePath: string;
let connection: TestConnection;

function versionedGapCase(database = connection.db) {
  const confirmed = confirmReviewMatch(
    database,
    { matchId: gapMatchId, actorName: 'demo_operator' },
    new Date('2026-09-09T10:00:00.000Z'),
    context
  );
  const snapshot = readCaseSnapshot(database, confirmed.caseId);
  const gap = snapshot?.investigation?.gaps.find((issue) => issue.code === 'BATCH_MISSING');
  if (!snapshot?.investigation || !gap) throw new Error('Expected a current versioned batch gap.');
  return { gap, snapshot };
}

function createVersionedRequest(
  caseId: string,
  questionRef: string,
  expectedCaseVersion: number,
  requestId = '91000000-0000-4000-8000-000000000001',
  database = connection.db
) {
  return requestInvestigationEvidence(database, {
    requestId,
    caseId,
    questionRef,
    expectedCaseVersion,
    requestedEvidence: ['batch_label_photo'],
    demo: true
  }, context, new Date('2026-09-09T11:00:00.000Z')).request;
}

function createEvidence(
  caseId: string,
  questionRef: string,
  evidenceRef = 'evidence:external:batch-label-001',
  evidenceRequestId: string | null = null,
  database = connection.db
) {
  return recordInvestigationEvidence(database, {
    evidenceRef,
    caseId,
    questionRef,
    evidenceRequestId,
    sourceKind: 'EXTERNAL_PARTY',
    sourceIdentifier: `supplier:${evidenceRef}`,
    validAsOf: null,
    contentKind: 'STRUCTURED',
    contentJson: { assertedBatch: 'MFT24' },
    contentLocator: null,
    demo: true
  }, new Date('2026-09-09T12:00:00.000Z')).evidence;
}

function claimInput(
  caseId: string,
  questionRef: string,
  expectedCaseVersion: number,
  evidenceRefs: string[],
  overrides: Partial<RecordInvestigationClaimInput> = {}
): RecordInvestigationClaimInput {
  return {
    claimRef: '92000000-0000-4000-8000-000000000001',
    caseId,
    questionRef,
    expectedCaseVersion,
    claimType: 'AFFECTED_BATCH_LOT',
    value: { lot: 'MFT24' },
    evidenceRefs,
    originKind: 'DETERMINISTIC_EXTRACTED',
    producerIdentifier: 'batch-field-parser:v1',
    derivationMetadata: { field: 'supplierInvoice.batch', parserVersion: 1 },
    supersedesClaimRef: null,
    demo: true,
    ...overrides
  } as RecordInvestigationClaimInput;
}

function record(input: RecordInvestigationClaimInput, now = new Date(claimCreatedAt)) {
  return recordInvestigationClaim(connection.db, input, context, now);
}

function expectClaimError(action: () => unknown, code: InvestigationClaimError['code']) {
  try {
    action();
    throw new Error('Expected investigation claim operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationClaimError);
    expect(error).toMatchObject({ code });
  }
}

function tableCount(tableName: string): number {
  return connection.sqlite.prepare(`select count(*) from ${tableName}`).pluck().get() as number;
}

function protectedState() {
  return {
    cases: connection.db.select().from(schema.cases).all(),
    lifecycle: connection.db.select().from(schema.caseLifecycle).all(),
    revisions: connection.db.select().from(schema.caseRevisions).all(),
    commands: connection.db.select().from(schema.caseCommands).all(),
    requests: connection.db.select().from(schema.evidenceRequests).all(),
    evidence: connection.db.select().from(schema.investigationEvidence).all(),
    matches: connection.db.select().from(schema.matches).all(),
    alerts: connection.db.select().from(schema.alerts).all(),
    drafts: connection.db.select().from(schema.actionDrafts).all(),
    items: connection.db.select().from(schema.caseItems).all(),
    legacyTasks: connection.db.select().from(schema.caseTasks).all(),
    traceability: connection.db.select().from(schema.traceabilityRecords).all()
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-investigation-claims-'));
  databasePath = join(directory, 'test.db');
  connection = createDatabaseConnection(databasePath);
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('investigation claims', () => {
  it('does not create a claim merely because evidence was received', () => {
    const { gap, snapshot } = versionedGapCase();
    const request = createVersionedRequest(snapshot.caseId, gap.id, snapshot.caseVersion);

    createEvidence(snapshot.caseId, gap.id, 'evidence:external:receipt-only', request.id);

    expect(tableCount('investigation_claims')).toBe(0);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(snapshot);
  });

  it('persists a canonical deterministic batch assertion without changing authoritative state', () => {
    const { gap, snapshot } = versionedGapCase();
    const request = createVersionedRequest(snapshot.caseId, gap.id, snapshot.caseVersion);
    const second = createEvidence(
      snapshot.caseId,
      gap.id,
      'evidence:external:invoice-002',
      request.id
    );
    const first = createEvidence(
      snapshot.caseId,
      gap.id,
      'evidence:external:label-001',
      request.id
    );
    const before = protectedState();
    const beforeSnapshot = structuredClone(snapshot);
    const beforeAuditCount = tableCount('audit_events');
    const input = claimInput(snapshot.caseId, gap.id, snapshot.caseVersion, [
      second.evidenceRef,
      first.evidenceRef,
      second.evidenceRef
    ], {
      value: { lot: ' MFT24 ' },
      derivationMetadata: { z: 2, a: { sourceField: 'batch' } }
    });

    const result = record(input);
    const stored = connection.db.select().from(schema.investigationClaims)
      .where(eq(schema.investigationClaims.claimRef, input.claimRef)).get();

    expect(result).toEqual({
      replayed: false,
      claim: {
        claimRef: input.claimRef,
        caseId: snapshot.caseId,
        questionRef: gap.id,
        subjectRef: snapshot.productId,
        claimType: 'AFFECTED_BATCH_LOT',
        value: { lot: ' MFT24 ' },
        evidenceRefs: [second.evidenceRef, first.evidenceRef],
        originKind: 'DETERMINISTIC_EXTRACTED',
        producerIdentifier: 'batch-field-parser:v1',
        derivationMetadata: { a: { sourceField: 'batch' }, z: 2 },
        supersedesClaimRef: null,
        createdAt: claimCreatedAt,
        demo: true
      }
    });
    expect(stored).toMatchObject({
      subjectRef: snapshot.productId,
      valueJson: '{"lot":" MFT24 "}',
      evidenceRefsJson: JSON.stringify([second.evidenceRef, first.evidenceRef]),
      derivationMetadataJson: '{"a":{"sourceField":"batch"},"z":2}',
      createdAt: claimCreatedAt
    });
    expect(stored).not.toHaveProperty('status');
    expect(stored).not.toHaveProperty('trusted');
    expect(stored).not.toHaveProperty('knowledgeStatus');
    expect(protectedState()).toEqual(before);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(beforeSnapshot);
    expect(tableCount('audit_events')).toBe(beforeAuditCount + 1);
    const audit = connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, 'investigation_claim_recorded')).get();
    expect(JSON.parse(audit!.metadataJson)).toEqual({
      claimRef: input.claimRef,
      caseId: snapshot.caseId,
      questionRef: gap.id,
      subjectRef: snapshot.productId,
      claimType: 'AFFECTED_BATCH_LOT',
      evidenceRefs: [second.evidenceRef, first.evidenceRef],
      originKind: 'DETERMINISTIC_EXTRACTED',
      producerIdentifier: 'batch-field-parser:v1',
      caseVersion: snapshot.caseVersion,
      materialRevision: snapshot.materialRevision,
      supersedesClaimRef: null,
      demo: true
    });
  });

  it('records AI and human origins only as claims, without LLM or HumanDecision integration', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id);
    const beforeSnapshot = structuredClone(snapshot);

    const ai = record(claimInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], {
        claimRef: '92000000-0000-4000-8000-000000000011',
        originKind: 'AI_PROPOSED',
        producerIdentifier: 'offline-proposal:test-adapter'
      }));
    const human = record(claimInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], {
        claimRef: '92000000-0000-4000-8000-000000000012',
        originKind: 'HUMAN_OBSERVED',
        producerIdentifier: 'operator:demo-01'
      }));

    expect(ai.claim.originKind).toBe('AI_PROPOSED');
    expect(human.claim.originKind).toBe('HUMAN_OBSERVED');
    expect(ai.claim).not.toHaveProperty('trusted');
    expect(human.claim).not.toHaveProperty('decisionRef');
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(beforeSnapshot);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)?.decisions).toEqual(snapshot.decisions);
  });

  it('rejects empty lots, empty evidence, disabled mode and unsupported claim types', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id);
    const base = claimInput(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);

    expectClaimError(() => record({ ...base, value: { lot: '   ' } }), 'INVALID_INPUT');
    expectClaimError(() => record({ ...base, evidenceRefs: [] }), 'INVALID_INPUT');
    expectClaimError(() => recordInvestigationClaim(
      connection.db,
      base,
      { mode: 'disabled' }
    ), 'FORBIDDEN');
    expectClaimError(() => record({ ...base, claimType: 'IDENTITY' } as never), 'INVALID_INPUT');
    expect(tableCount('investigation_claims')).toBe(0);
  });

  it('rejects missing, wrong-case and wrong-question evidence', () => {
    const { gap, snapshot } = versionedGapCase();
    const otherConfirmed = confirmReviewMatch(
      connection.db,
      { matchId: fixtures.matches[0].id, actorName: 'demo_operator' },
      new Date('2026-09-09T10:30:00.000Z'),
      context
    );
    const insertHistoricalEvidence = (evidenceRef: string, caseId: string, questionRef: string) => {
      connection.db.insert(schema.investigationEvidence).values({
        evidenceRef,
        caseId,
        questionRef,
        evidenceRequestId: null,
        sourceKind: 'EXTERNAL_PARTY',
        sourceIdentifier: `historical:${evidenceRef}`,
        receivedAt: '2026-09-09T12:00:00.000Z',
        validAsOf: null,
        contentKind: 'STRUCTURED',
        contentJson: '{"assertedBatch":"MFT24"}',
        contentLocator: null,
        integrityHash: 'a'.repeat(64),
        demo: true
      }).run();
      return { evidenceRef };
    };
    const otherEvidence = insertHistoricalEvidence(
      'evidence:external:wrong-case', otherConfirmed.caseId, gap.id
    );
    const wrongQuestionEvidence = insertHistoricalEvidence(
      'evidence:external:wrong-question', snapshot.caseId, 'question:another-gap'
    );
    const base = claimInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      ['evidence:not-registered']);

    expectClaimError(() => record(base), 'EVIDENCE_NOT_FOUND');
    expectClaimError(() => record({ ...base, evidenceRefs: [otherEvidence.evidenceRef] }),
      'EVIDENCE_CASE_MISMATCH');
    expectClaimError(() => record({ ...base, evidenceRefs: [wrongQuestionEvidence.evidenceRef] }),
      'EVIDENCE_QUESTION_MISMATCH');
    expect(tableCount('investigation_claims')).toBe(0);
  });

  it('rejects legacy-request-linked evidence but accepts explicit versioned linkage', () => {
    const { gap, snapshot } = versionedGapCase();
    const legacyRequestId = '91000000-0000-4000-8000-000000000091';
    connection.db.insert(schema.evidenceRequests).values({
      id: legacyRequestId,
      matchId: gapMatchId,
      caseId: null,
      questionRef: null,
      requestedEvidence: '["batch_label_photo"]',
      recipient: null,
      status: 'pending',
      createdAt: '2026-09-09T11:00:00.000Z',
      resolvedAt: null
    }).run();
    const legacyLinked = createEvidence(
      snapshot.caseId,
      gap.id,
      'evidence:external:legacy-request-linked',
      legacyRequestId
    );

    expectClaimError(() => record(claimInput(
      snapshot.caseId,
      gap.id,
      snapshot.caseVersion,
      [legacyLinked.evidenceRef]
    )), 'LEGACY_EVIDENCE_REQUEST_UNSUPPORTED');

    const versionedRequest = createVersionedRequest(
      snapshot.caseId,
      gap.id,
      snapshot.caseVersion,
      '91000000-0000-4000-8000-000000000092'
    );
    const versionedLinked = createEvidence(
      snapshot.caseId,
      gap.id,
      'evidence:external:versioned-request-linked',
      versionedRequest.id
    );
    expect(record(claimInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [versionedLinked.evidenceRef]))).toMatchObject({ replayed: false });
  });

  it('replays a canonical semantic claim without duplicate rows or audit events', () => {
    const { gap, snapshot } = versionedGapCase();
    const first = createEvidence(snapshot.caseId, gap.id, 'evidence:external:a');
    const second = createEvidence(snapshot.caseId, gap.id, 'evidence:external:b');
    const input = claimInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [second.evidenceRef, first.evidenceRef, second.evidenceRef]);
    const created = record(input);
    const auditCount = tableCount('audit_events');

    const replay = record({ ...input, evidenceRefs: [first.evidenceRef, second.evidenceRef] });

    expect(replay).toEqual({ claim: created.claim, replayed: true });
    expect(tableCount('investigation_claims')).toBe(1);
    expect(tableCount('audit_events')).toBe(auditCount);
  });

  it('replays an existing claim after the question and case version have advanced', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id);
    const input = claimInput(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);
    const created = record(input);
    const auditCount = tableCount('audit_events');
    const advancedSnapshot = {
      ...structuredClone(snapshot),
      caseVersion: snapshot.caseVersion + 1,
      updatedAt: '2026-09-09T15:00:00.000Z',
      investigation: {
        ...structuredClone(snapshot.investigation!),
        gaps: []
      },
      uncertainties: []
    };
    connection.db.update(schema.caseLifecycle).set({
      caseVersion: advancedSnapshot.caseVersion,
      snapshotJson: JSON.stringify(advancedSnapshot),
      updatedAt: advancedSnapshot.updatedAt
    }).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).run();

    expect(record({ ...input, expectedCaseVersion: snapshot.caseVersion + 99 })).toEqual({
      claim: created.claim,
      replayed: true
    });
    expect(tableCount('audit_events')).toBe(auditCount);
  });

  it('rejects every immutable semantic change under an existing claimRef', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id);
    const input = claimInput(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);
    record(input);
    const auditCount = tableCount('audit_events');
    const changes: RecordInvestigationClaimInput[] = [
      { ...input, value: { lot: 'MFT25' } },
      { ...input, evidenceRefs: ['evidence:different'] },
      { ...input, originKind: 'AI_PROPOSED' },
      { ...input, producerIdentifier: 'another-producer' },
      { ...input, derivationMetadata: { parserVersion: 2 } },
      { ...input, supersedesClaimRef: '92000000-0000-4000-8000-000000000099' },
      { ...input, questionRef: 'question:different' },
      { ...input, caseId: '60000000-0000-4000-8000-000000000099' }
    ];

    for (const changed of changes) {
      expectClaimError(() => record(changed), 'CLAIM_CONFLICT');
    }
    expect(tableCount('investigation_claims')).toBe(1);
    expect(tableCount('audit_events')).toBe(auditCount);
  });

  it('keeps duplicate assertions and conflicting lot values visible without choosing a winner', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id);
    const beforeSnapshot = structuredClone(snapshot);

    for (const [claimRef, lot] of [
      ['92000000-0000-4000-8000-000000000021', 'MFT24'],
      ['92000000-0000-4000-8000-000000000022', 'MFT24'],
      ['92000000-0000-4000-8000-000000000023', 'MFT25']
    ] as const) {
      record(claimInput(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef], {
        claimRef,
        value: { lot }
      }));
    }

    expect(listInvestigationClaims(connection.db, snapshot.caseId, gap.id)
      .map((claim) => claim.value.lot)).toEqual(['MFT24', 'MFT24', 'MFT25']);
    expect(tableCount('investigation_claims')).toBe(3);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(beforeSnapshot);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)?.investigation?.gaps).toContainEqual(gap);
  });

  it('rejects stale, absent, conflict-only and unsupported current questions without writes', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id);
    const base = claimInput(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);
    const conflictRef = snapshot.investigation!.conflicts[0].id;
    const auditCount = tableCount('audit_events');

    expectClaimError(() => record({ ...base, expectedCaseVersion: snapshot.caseVersion - 1 }),
      'STALE_CASE_VERSION');
    expectClaimError(() => record({ ...base, questionRef: 'question:not-current' }),
      'QUESTION_NOT_CURRENT');
    expectClaimError(() => record({ ...base, questionRef: conflictRef }),
      'QUESTION_NOT_CURRENT');

    const unsupportedGap = { ...structuredClone(gap), code: 'IDENTITY_MISSING' };
    const unsupportedSnapshot = {
      ...structuredClone(snapshot),
      investigation: { ...structuredClone(snapshot.investigation!), gaps: [unsupportedGap] },
      uncertainties: [unsupportedGap]
    };
    connection.db.update(schema.caseLifecycle).set({
      snapshotJson: JSON.stringify(unsupportedSnapshot)
    }).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).run();
    expectClaimError(() => record({ ...base, questionRef: unsupportedGap.id }),
      'QUESTION_NOT_CURRENT');

    const duplicatedSnapshot = {
      ...structuredClone(snapshot),
      investigation: { ...structuredClone(snapshot.investigation!), gaps: [gap, gap] }
    };
    connection.db.update(schema.caseLifecycle).set({
      snapshotJson: JSON.stringify(duplicatedSnapshot)
    }).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).run();
    expectClaimError(() => record(base), 'QUESTION_AMBIGUOUS');
    expect(tableCount('investigation_claims')).toBe(0);
    expect(tableCount('audit_events')).toBe(auditCount);
  });

  it('does not invent a claim question for UNKNOWN identity without a gap', () => {
    const match = fixtures.matches[0];
    connection.db.update(schema.alerts).set({ ean: null })
      .where(eq(schema.alerts.id, match.alertId)).run();
    const confirmed = confirmReviewMatch(
      connection.db,
      { matchId: match.id, actorName: 'demo_operator' },
      new Date('2026-09-09T10:00:00.000Z'),
      context
    );
    const snapshot = readCaseSnapshot(connection.db, confirmed.caseId)!;
    expect(snapshot.investigation).toMatchObject({
      identity: { knowledgeStatus: 'UNKNOWN', conclusion: 'UNRESOLVED' },
      gaps: []
    });

    expectClaimError(() => record(claimInput(
      snapshot.caseId,
      'question:invented-identity',
      snapshot.caseVersion,
      ['evidence:not-reached']
    )), 'QUESTION_NOT_CURRENT');
    expect(tableCount('investigation_claims')).toBe(0);
  });

  it('preserves superseded claims and validates the complete supersession boundary', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id);
    const originalInput = claimInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef]);
    const original = record(originalInput).claim;
    const correctedInput = claimInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], {
        claimRef: '92000000-0000-4000-8000-000000000032',
        value: { lot: 'MFT25' },
        supersedesClaimRef: original.claimRef
      });

    const corrected = record(correctedInput).claim;

    expect(corrected.supersedesClaimRef).toBe(original.claimRef);
    expect(getInvestigationClaim(connection.db, snapshot.caseId, original.claimRef)).toEqual(original);
    expect(listInvestigationClaims(connection.db, snapshot.caseId, gap.id)).toHaveLength(2);
    expectClaimError(() => record({
      ...correctedInput,
      claimRef: '92000000-0000-4000-8000-000000000033',
      supersedesClaimRef: '92000000-0000-4000-8000-000000000033'
    }), 'SUPERSESSION_MISMATCH');
    expectClaimError(() => record({
      ...correctedInput,
      claimRef: '92000000-0000-4000-8000-000000000034',
      supersedesClaimRef: '92000000-0000-4000-8000-000000000099'
    }), 'SUPERSEDED_CLAIM_NOT_FOUND');
  });

  it('rejects supersession across question and case ownership', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id);
    const wrongQuestionClaimRef = '92000000-0000-4000-8000-000000000041';
    connection.db.insert(schema.investigationClaims).values({
      claimRef: wrongQuestionClaimRef,
      caseId: snapshot.caseId,
      questionRef: 'question:historical-other',
      subjectRef: snapshot.productId,
      claimType: 'AFFECTED_BATCH_LOT',
      valueJson: '{"lot":"MFT23"}',
      evidenceRefsJson: '["evidence:historical"]',
      originKind: 'HUMAN_OBSERVED',
      producerIdentifier: 'operator:historical',
      derivationMetadataJson: null,
      supersedesClaimRef: null,
      createdAt: '2026-09-08T10:00:00.000Z',
      demo: true
    }).run();
    expectClaimError(() => record(claimInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], {
        claimRef: '92000000-0000-4000-8000-000000000042',
        supersedesClaimRef: wrongQuestionClaimRef
      })), 'SUPERSESSION_MISMATCH');

    const otherConfirmed = confirmReviewMatch(
      connection.db,
      { matchId: fixtures.matches[0].id, actorName: 'demo_operator' },
      new Date('2026-09-09T10:30:00.000Z'),
      context
    );
    const otherSnapshot = readCaseSnapshot(connection.db, otherConfirmed.caseId)!;
    const wrongCaseClaimRef = '92000000-0000-4000-8000-000000000043';
    connection.db.insert(schema.investigationClaims).values({
      claimRef: wrongCaseClaimRef,
      caseId: otherSnapshot.caseId,
      questionRef: gap.id,
      subjectRef: otherSnapshot.productId,
      claimType: 'AFFECTED_BATCH_LOT',
      valueJson: '{"lot":"MFT23"}',
      evidenceRefsJson: '["evidence:historical"]',
      originKind: 'HUMAN_OBSERVED',
      producerIdentifier: 'operator:historical',
      derivationMetadataJson: null,
      supersedesClaimRef: null,
      createdAt: '2026-09-08T10:00:00.000Z',
      demo: true
    }).run();
    expectClaimError(() => record(claimInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], {
        claimRef: '92000000-0000-4000-8000-000000000044',
        supersedesClaimRef: wrongCaseClaimRef
      })), 'SUPERSESSION_MISMATCH');
  });

  it('scopes reads to the owning case and survives closing and reopening the database', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id);
    const recorded = record(claimInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef])).claim;

    expect(getInvestigationClaim(
      connection.db,
      '60000000-0000-4000-8000-000000000099',
      recorded.claimRef
    )).toBeNull();
    connection.sqlite.close();
    connection = createDatabaseConnection(databasePath);
    expect(getInvestigationClaim(connection.db, snapshot.caseId, recorded.claimRef)).toEqual(recorded);
  });

  it('upgrades a populated 0005 database, reruns safely and preserves foreign keys', () => {
    const preClaimsFolder = join(directory, 'pre-claims-migrations');
    mkdirSync(join(preClaimsFolder, 'meta'), { recursive: true });
    for (const file of [
      '0000_initial.sql',
      '0001_last_living_lightning.sql',
      '0002_case_lifecycle.sql',
      '0003_traceability_exposure.sql',
      '0004_last_thunderbolt.sql',
      '0005_majestic_centennial.sql'
    ]) cpSync(join('drizzle', file), join(preClaimsFolder, file));
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 6);
    writeFileSync(join(preClaimsFolder, 'meta/_journal.json'), JSON.stringify(journal));
    const existing = createDatabaseConnection(join(directory, 'populated-0005.db'));
    try {
      migrate(existing.db, { migrationsFolder: preClaimsFolder });
      seedDemoData(existing.db, fixtures);
      const caseId = '60000000-0000-4000-8000-000000000081';
      const questionRef = 'historical:pre-claims:question';
      const requestId = '91000000-0000-4000-8000-000000000081';
      existing.db.insert(schema.cases).values({
        id: caseId,
        caseNumber: 'CASE-PRE-CLAIMS-081',
        alertId: fixtures.matches[1].alertId,
        status: 'open',
        severity: 'high',
        openedAt: '2026-09-09T10:00:00.000Z',
        closedAt: null
      }).run();
      existing.db.insert(schema.evidenceRequests).values({
        id: requestId,
        matchId: gapMatchId,
        caseId,
        questionRef,
        requestedEvidence: '["batch_label_photo"]',
        recipient: null,
        status: 'pending',
        createdAt: '2026-09-09T11:00:00.000Z',
        resolvedAt: null
      }).run();
      existing.db.insert(schema.investigationEvidence).values({
        evidenceRef: 'evidence:external:pre-claims',
        caseId,
        questionRef,
        evidenceRequestId: requestId,
        sourceKind: 'EXTERNAL_PARTY',
        sourceIdentifier: 'supplier:pre-claims',
        receivedAt: '2026-09-09T12:00:00.000Z',
        validAsOf: null,
        contentKind: 'STRUCTURED',
        contentJson: '{"assertedBatch":"MFT24"}',
        contentLocator: null,
        integrityHash: 'c'.repeat(64),
        demo: true
      }).run();
      const beforeRequest = existing.db.select().from(schema.evidenceRequests).all();
      const beforeEvidence = existing.db.select().from(schema.investigationEvidence).all();

      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      migrate(existing.db, { migrationsFolder: resolve('drizzle') });

      expect(existing.db.select().from(schema.evidenceRequests).all()).toEqual(beforeRequest);
      expect(existing.db.select().from(schema.investigationEvidence).all()).toEqual(beforeEvidence);
      expect(existing.db.select().from(schema.investigationClaims).all()).toEqual([]);
      expect(existing.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      existing.sqlite.close();
    }
  });
});
