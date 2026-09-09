import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { clearDemoData, seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import {
  batchContradictionRule,
  getInvestigationAssessment,
  InvestigationAssessmentError,
  listInvestigationAssessments,
  recordInvestigationAssessment,
  type RecordInvestigationAssessmentInput
} from './assessments';
import { recordInvestigationClaim } from './claims';
import { recordInvestigationEvidence } from './evidence-registry';
import { requestInvestigationEvidence } from './evidence-requests';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const fixtures = loadDemoFixtures();
const gapMatchId = '50000000-0000-4000-8000-000000000002';
const context = { mode: 'demo' as const };
const assessmentCreatedAt = '2026-09-09T16:00:00.000Z';

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
  requestId = '93000000-0000-4000-8000-000000000001',
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
  evidenceRef: string,
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

function createClaim(
  caseId: string,
  questionRef: string,
  expectedCaseVersion: number,
  evidenceRefs: string[],
  claimRef = '94000000-0000-4000-8000-000000000001',
  lot = 'MFT24',
  database = connection.db
) {
  return recordInvestigationClaim(database, {
    claimRef,
    caseId,
    questionRef,
    expectedCaseVersion,
    claimType: 'AFFECTED_BATCH_LOT',
    value: { lot },
    evidenceRefs,
    originKind: 'DETERMINISTIC_EXTRACTED',
    producerIdentifier: 'batch-field-parser:v1',
    derivationMetadata: null,
    supersedesClaimRef: null,
    demo: true
  }, context, new Date('2026-09-09T13:00:00.000Z')).claim;
}

function assessmentInput(
  caseId: string,
  questionRef: string,
  expectedCaseVersion: number,
  evidenceRefs: string[],
  targetClaimRef: string | null,
  overrides: Partial<RecordInvestigationAssessmentInput> = {}
): RecordInvestigationAssessmentInput {
  return {
    assessmentRef: '95000000-0000-4000-8000-000000000001',
    caseId,
    questionRef,
    expectedCaseVersion,
    verdict: 'SUPPORTED',
    targetClaimRef,
    evidenceRefs,
    relatedClaimRefs: [],
    assessorKind: 'HUMAN',
    assessorIdentifier: null,
    ruleIdentifier: null,
    ruleVersion: null,
    rationale: 'Reviewed the registered evidence against the assertion.',
    supersedesAssessmentRef: null,
    demo: true,
    ...overrides
  } as RecordInvestigationAssessmentInput;
}

function record(
  input: RecordInvestigationAssessmentInput,
  now = new Date(assessmentCreatedAt),
  database = connection.db
) {
  return recordInvestigationAssessment(database, input, context, now);
}

function expectAssessmentError(
  action: () => unknown,
  code: InvestigationAssessmentError['code']
) {
  try {
    action();
    throw new Error('Expected investigation assessment operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationAssessmentError);
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
    claims: connection.db.select().from(schema.investigationClaims).all(),
    matches: connection.db.select().from(schema.matches).all(),
    alerts: connection.db.select().from(schema.alerts).all(),
    drafts: connection.db.select().from(schema.actionDrafts).all(),
    items: connection.db.select().from(schema.caseItems).all(),
    legacyTasks: connection.db.select().from(schema.caseTasks).all(),
    traceability: connection.db.select().from(schema.traceabilityRecords).all()
  };
}

function setSnapshot(snapshot: NonNullable<ReturnType<typeof readCaseSnapshot>>) {
  connection.db.update(schema.caseLifecycle).set({
    caseVersion: snapshot.caseVersion,
    materialRevision: snapshot.materialRevision,
    snapshotJson: JSON.stringify(snapshot),
    updatedAt: snapshot.updatedAt
  }).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).run();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-investigation-assessments-'));
  databasePath = join(directory, 'test.db');
  connection = createDatabaseConnection(databasePath);
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('investigation assessments', () => {
  it('does not create an assessment merely because a claim exists', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:claim-only');

    createClaim(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);

    expect(tableCount('investigation_assessments')).toBe(0);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(snapshot);
  });

  it('persists canonical SUPPORTED analysis without changing authoritative or source state', () => {
    const { gap, snapshot } = versionedGapCase();
    const request = createVersionedRequest(snapshot.caseId, gap.id, snapshot.caseVersion);
    const second = createEvidence(
      snapshot.caseId,
      gap.id,
      'evidence:assessment:supported-b',
      request.id
    );
    const first = createEvidence(
      snapshot.caseId,
      gap.id,
      'evidence:assessment:supported-a',
      request.id
    );
    const claim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion, [first.evidenceRef]);
    const before = protectedState();
    const beforeSnapshot = structuredClone(snapshot);
    const beforeAuditCount = tableCount('audit_events');
    const input = assessmentInput(
      snapshot.caseId,
      gap.id,
      snapshot.caseVersion,
      [second.evidenceRef, first.evidenceRef, second.evidenceRef],
      claim.claimRef
    );

    const result = record(input);
    const stored = connection.db.select().from(schema.investigationAssessments)
      .where(eq(schema.investigationAssessments.assessmentRef, input.assessmentRef)).get();

    expect(result).toEqual({
      replayed: false,
      assessment: {
        assessmentRef: input.assessmentRef,
        caseId: snapshot.caseId,
        questionRef: gap.id,
        targetClaimRef: claim.claimRef,
        verdict: 'SUPPORTED',
        evidenceRefs: [first.evidenceRef, second.evidenceRef],
        relatedClaimRefs: [],
        assessorKind: 'HUMAN',
        assessorIdentifier: 'demo_operator',
        ruleIdentifier: null,
        ruleVersion: null,
        rationale: input.rationale,
        basisCaseVersion: snapshot.caseVersion,
        supersedesAssessmentRef: null,
        createdAt: assessmentCreatedAt,
        demo: true
      }
    });
    expect(stored).toMatchObject({
      evidenceRefsJson: JSON.stringify([first.evidenceRef, second.evidenceRef]),
      relatedClaimRefsJson: '[]',
      basisCaseVersion: snapshot.caseVersion,
      createdAt: assessmentCreatedAt
    });
    expect(stored).not.toHaveProperty('trusted');
    expect(stored).not.toHaveProperty('established');
    expect(stored).not.toHaveProperty('knowledgeStatus');
    expect(protectedState()).toEqual(before);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(beforeSnapshot);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)?.investigation?.gaps).toContainEqual(gap);
    expect(tableCount('audit_events')).toBe(beforeAuditCount + 1);
    const audit = connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, 'investigation_assessment_recorded')).get();
    expect(JSON.parse(audit!.metadataJson)).toMatchObject({
      assessmentRef: input.assessmentRef,
      verdict: 'SUPPORTED',
      assessorKind: 'HUMAN',
      assessorIdentifier: 'demo_operator',
      basisCaseVersion: snapshot.caseVersion
    });
  });

  it('rejects ESTABLISHED and enforces non-authoritative assessor metadata', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:assessors');
    const claim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);
    const base = assessmentInput(
      snapshot.caseId,
      gap.id,
      snapshot.caseVersion,
      [evidence.evidenceRef],
      claim.claimRef
    );

    expectAssessmentError(() => record({ ...base, verdict: 'ESTABLISHED' } as never), 'INVALID_INPUT');
    expectAssessmentError(() => record({
      ...base,
      assessorIdentifier: 'caller-selected-human'
    }), 'INVALID_INPUT');
    expectAssessmentError(() => record({
      ...base,
      assessorKind: 'RULE',
      assessorIdentifier: 'rule-engine:v1',
      ruleIdentifier: null,
      ruleVersion: null
    }), 'INVALID_INPUT');
    expectAssessmentError(() => record({
      ...base,
      ruleIdentifier: 'manual-review-policy',
      ruleVersion: null
    }), 'INVALID_INPUT');
    expectAssessmentError(() => record({ ...base, rationale: '   ' }), 'INVALID_INPUT');
    expectAssessmentError(() => recordInvestigationAssessment(
      connection.db,
      base,
      { mode: 'disabled' }
    ), 'FORBIDDEN');

    const ai = record({
      ...base,
      assessmentRef: '95000000-0000-4000-8000-000000000011',
      assessorKind: 'AI',
      assessorIdentifier: 'offline-analysis-adapter',
      ruleIdentifier: 'batch-evidence-consistency',
      ruleVersion: 'v1'
    });
    const rule = record({
      ...base,
      assessmentRef: '95000000-0000-4000-8000-000000000012',
      assessorKind: 'RULE',
      assessorIdentifier: 'deterministic-batch-reviewer',
      ruleIdentifier: 'batch-evidence-consistency',
      ruleVersion: 'v1'
    });

    expect(ai.assessment).toMatchObject({ assessorKind: 'AI', verdict: 'SUPPORTED' });
    expect(rule.assessment).toMatchObject({ assessorKind: 'RULE', verdict: 'SUPPORTED' });
    expect(ai.assessment).not.toHaveProperty('trusted');
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(snapshot);
  });

  it('records both INSUFFICIENT forms and REJECTED without inventing facts or claims', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:insufficient');
    const claim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);
    const claimCount = tableCount('investigation_claims');

    const questionLevel = record(assessmentInput(
      snapshot.caseId,
      gap.id,
      snapshot.caseVersion,
      [evidence.evidenceRef],
      null,
      {
        assessmentRef: '95000000-0000-4000-8000-000000000021',
        verdict: 'INSUFFICIENT',
        rationale: 'The invoice contains no readable batch value.'
      }
    ));
    const claimLevel = record(assessmentInput(
      snapshot.caseId,
      gap.id,
      snapshot.caseVersion,
      [evidence.evidenceRef],
      claim.claimRef,
      {
        assessmentRef: '95000000-0000-4000-8000-000000000022',
        verdict: 'INSUFFICIENT'
      }
    ));
    const rejected = record(assessmentInput(
      snapshot.caseId,
      gap.id,
      snapshot.caseVersion,
      [evidence.evidenceRef],
      claim.claimRef,
      {
        assessmentRef: '95000000-0000-4000-8000-000000000023',
        verdict: 'REJECTED',
        rationale: 'The transcription addresses a different line item.'
      }
    ));

    expect(questionLevel.assessment.targetClaimRef).toBeNull();
    expect(claimLevel.assessment.verdict).toBe('INSUFFICIENT');
    expect(rejected.assessment.verdict).toBe('REJECTED');
    expect(tableCount('investigation_claims')).toBe(claimCount);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(snapshot);
  });

  it('enforces every verdict target/related-claim shape', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:shape');
    const claim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);
    const base = assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], claim.claimRef);

    for (const changed of [
      { verdict: 'SUPPORTED', targetClaimRef: null },
      { verdict: 'REJECTED', targetClaimRef: null },
      { verdict: 'SUPPORTED', relatedClaimRefs: [claim.claimRef] },
      { verdict: 'INSUFFICIENT', relatedClaimRefs: [claim.claimRef] },
      { verdict: 'CONTRADICTED', targetClaimRef: claim.claimRef, relatedClaimRefs: [claim.claimRef] },
      { verdict: 'CONTRADICTED', targetClaimRef: null, relatedClaimRefs: [claim.claimRef] },
      { verdict: 'CONTRADICTED', targetClaimRef: null, relatedClaimRefs: [claim.claimRef, claim.claimRef] }
    ]) {
      expectAssessmentError(() => record({ ...base, ...changed } as never), 'INVALID_VERDICT_BASIS');
    }
    expect(tableCount('investigation_assessments')).toBe(0);
  });

  it('records only a genuine normalized contradiction and preserves every claim', () => {
    const { gap, snapshot } = versionedGapCase();
    const firstEvidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:mft24');
    const secondEvidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:mft25');
    const first = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion,
      [firstEvidence.evidenceRef], '94000000-0000-4000-8000-000000000031', 'MFT24');
    const second = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion,
      [secondEvidence.evidenceRef], '94000000-0000-4000-8000-000000000032', 'MFT25');
    const claimsBefore = connection.db.select().from(schema.investigationClaims).all();

    const contradiction = record(assessmentInput(
      snapshot.caseId,
      gap.id,
      snapshot.caseVersion,
      [secondEvidence.evidenceRef, firstEvidence.evidenceRef],
      null,
      {
        assessmentRef: '95000000-0000-4000-8000-000000000031',
        verdict: 'CONTRADICTED',
        relatedClaimRefs: [second.claimRef, first.claimRef, second.claimRef]
      }
    ));

    expect(contradiction.assessment).toMatchObject({
      verdict: 'CONTRADICTED',
      targetClaimRef: null,
      relatedClaimRefs: [first.claimRef, second.claimRef],
      ruleIdentifier: batchContradictionRule.identifier,
      ruleVersion: batchContradictionRule.version
    });
    expect(connection.db.select().from(schema.investigationClaims).all()).toEqual(claimsBefore);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(snapshot);
  });

  it('rejects equivalent normalized lots and incomplete contradiction evidence', () => {
    const { gap, snapshot } = versionedGapCase();
    const firstEvidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:equiv-a');
    const secondEvidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:equiv-b');
    const first = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion,
      [firstEvidence.evidenceRef], '94000000-0000-4000-8000-000000000041', 'MFT-24');
    const equivalent = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion,
      [secondEvidence.evidenceRef], '94000000-0000-4000-8000-000000000042', 'MFT24');
    const base = assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [firstEvidence.evidenceRef, secondEvidence.evidenceRef], null, {
        verdict: 'CONTRADICTED',
        relatedClaimRefs: [first.claimRef, equivalent.claimRef]
      });

    expectAssessmentError(() => record(base), 'CONTRADICTION_NOT_DETERMINISTIC');
    const different = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion,
      [secondEvidence.evidenceRef], '94000000-0000-4000-8000-000000000043', 'MFT25');
    expectAssessmentError(() => record({
      ...base,
      relatedClaimRefs: [first.claimRef, different.claimRef],
      evidenceRefs: [firstEvidence.evidenceRef]
    }), 'EVIDENCE_BASIS_INCOMPLETE');
    expectAssessmentError(() => record({
      ...base,
      relatedClaimRefs: [first.claimRef, different.claimRef],
      ruleIdentifier: 'caller-selected-comparison',
      ruleVersion: 'v9'
    }), 'INVALID_INPUT');
  });

  it('requires complete target evidence while allowing extra owned evidence', () => {
    const { gap, snapshot } = versionedGapCase();
    const first = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:target-a');
    const second = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:target-b');
    const extra = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:target-extra');
    const claim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion,
      [first.evidenceRef, second.evidenceRef]);
    const base = assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [first.evidenceRef], claim.claimRef);

    expectAssessmentError(() => record(base), 'EVIDENCE_BASIS_INCOMPLETE');
    expect(record({
      ...base,
      evidenceRefs: [extra.evidenceRef, second.evidenceRef, first.evidenceRef]
    })).toMatchObject({ replayed: false });
  });

  it('rejects missing, cross-owned and legacy-request-linked evidence', () => {
    const { gap, snapshot } = versionedGapCase();
    const owned = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:owned');
    const claim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion, [owned.evidenceRef]);
    const base = assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [owned.evidenceRef], claim.claimRef);
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
        integrityHash: 'b'.repeat(64),
        demo: true
      }).run();
      return { evidenceRef };
    };
    const wrongCase = insertHistoricalEvidence(
      'evidence:assessment:wrong-case', otherConfirmed.caseId, gap.id
    );
    const wrongQuestion = insertHistoricalEvidence(
      'evidence:assessment:wrong-question', snapshot.caseId, 'question:wrong'
    );

    expectAssessmentError(() => record({ ...base, evidenceRefs: ['evidence:not-found'] }),
      'EVIDENCE_NOT_FOUND');
    expectAssessmentError(() => record({ ...base, evidenceRefs: [wrongCase.evidenceRef] }),
      'EVIDENCE_CASE_MISMATCH');
    expectAssessmentError(() => record({ ...base, evidenceRefs: [wrongQuestion.evidenceRef] }),
      'EVIDENCE_QUESTION_MISMATCH');

    const legacyRequestId = '93000000-0000-4000-8000-000000000091';
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
      'evidence:assessment:legacy-linked',
      legacyRequestId
    );
    expectAssessmentError(() => record({ ...base, evidenceRefs: [legacyLinked.evidenceRef] }),
      'LEGACY_EVIDENCE_REQUEST_UNSUPPORTED');
  });

  it('rejects missing and cross-owned claim bases', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:claim-ownership');
    const base = assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], '94000000-0000-4000-8000-000000000099');

    expectAssessmentError(() => record(base), 'CLAIM_NOT_FOUND');
    const insertClaim = (claimRef: string, caseId: string, questionRef: string, subjectRef: string) =>
      connection.db.insert(schema.investigationClaims).values({
        claimRef,
        caseId,
        questionRef,
        subjectRef,
        claimType: 'AFFECTED_BATCH_LOT',
        valueJson: '{"lot":"MFT24"}',
        evidenceRefsJson: JSON.stringify([evidence.evidenceRef]),
        originKind: 'HUMAN_OBSERVED',
        producerIdentifier: 'fixture:ownership',
        derivationMetadataJson: null,
        supersedesClaimRef: null,
        createdAt: '2026-09-09T13:00:00.000Z',
        demo: true
      }).run();
    const otherConfirmed = confirmReviewMatch(
      connection.db,
      { matchId: fixtures.matches[0].id, actorName: 'demo_operator' },
      new Date('2026-09-09T10:30:00.000Z'),
      context
    );
    const wrongCaseRef = '94000000-0000-4000-8000-000000000091';
    insertClaim(wrongCaseRef, otherConfirmed.caseId, gap.id, snapshot.productId);
    expectAssessmentError(() => record({ ...base, targetClaimRef: wrongCaseRef }),
      'CLAIM_CASE_MISMATCH');
    const wrongQuestionRef = '94000000-0000-4000-8000-000000000092';
    insertClaim(wrongQuestionRef, snapshot.caseId, 'question:wrong', snapshot.productId);
    expectAssessmentError(() => record({ ...base, targetClaimRef: wrongQuestionRef }),
      'CLAIM_QUESTION_MISMATCH');
    const wrongSubjectRef = '94000000-0000-4000-8000-000000000093';
    insertClaim(wrongSubjectRef, snapshot.caseId, gap.id, fixtures.products[0].id);
    expectAssessmentError(() => record({ ...base, targetClaimRef: wrongSubjectRef }),
      'CLAIM_SUBJECT_MISMATCH');

    const unsupportedClaimRef = '94000000-0000-4000-8000-000000000094';
    connection.sqlite.pragma('ignore_check_constraints = ON');
    try {
      connection.sqlite.prepare(`
        insert into investigation_claims (
          claim_ref, case_id, question_ref, subject_ref, claim_type, value_json,
          evidence_refs_json, origin_kind, producer_identifier,
          derivation_metadata_json, supersedes_claim_ref, created_at, demo
        ) values (?, ?, ?, ?, 'IDENTITY', '{"lot":"MFT24"}', ?,
          'HUMAN_OBSERVED', 'fixture:unsupported', null, null, ?, 1)
      `).run(
        unsupportedClaimRef,
        snapshot.caseId,
        gap.id,
        snapshot.productId,
        JSON.stringify([evidence.evidenceRef]),
        '2026-09-09T13:00:00.000Z'
      );
    } finally {
      connection.sqlite.pragma('ignore_check_constraints = OFF');
    }
    expectAssessmentError(() => record({ ...base, targetClaimRef: unsupportedClaimRef }),
      'UNSUPPORTED_CLAIM_TYPE');
  });

  it('rejects stale and non-current question contexts atomically', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:freshness');
    const claim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);
    const base = assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], claim.claimRef);

    expectAssessmentError(() => record({ ...base, expectedCaseVersion: snapshot.caseVersion + 1 }),
      'STALE_CASE_VERSION');
    expectAssessmentError(() => record({ ...base, questionRef: 'question:invented' }),
      'QUESTION_NOT_CURRENT');

    const conflictOnly = structuredClone(snapshot);
    conflictOnly.investigation!.gaps = [];
    conflictOnly.investigation!.conflicts = [{ ...gap, id: 'question:conflict-only' }];
    setSnapshot(conflictOnly);
    expectAssessmentError(() => record({
      ...base,
      assessmentRef: '95000000-0000-4000-8000-000000000052',
      questionRef: 'question:conflict-only'
    }), 'QUESTION_NOT_CURRENT');

    const unsupported = structuredClone(snapshot);
    unsupported.investigation!.gaps = [{ ...gap, code: 'OTHER_GAP' }];
    setSnapshot(unsupported);
    expectAssessmentError(() => record({
      ...base,
      assessmentRef: '95000000-0000-4000-8000-000000000053'
    }), 'QUESTION_NOT_CURRENT');

    const duplicated = structuredClone(snapshot);
    duplicated.investigation!.gaps = [gap, { ...gap }];
    setSnapshot(duplicated);
    expectAssessmentError(() => record({
      ...base,
      assessmentRef: '95000000-0000-4000-8000-000000000054'
    }), 'QUESTION_AMBIGUOUS');
    expect(tableCount('investigation_assessments')).toBe(0);
  });

  it('replays canonical semantics without duplicate writes, including after lifecycle advancement', () => {
    const { gap, snapshot } = versionedGapCase();
    const first = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:replay-a');
    const second = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:replay-b');
    const claim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion,
      [first.evidenceRef, second.evidenceRef]);
    const input = assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [second.evidenceRef, first.evidenceRef, second.evidenceRef], claim.claimRef);
    const created = record(input);
    const auditCount = tableCount('audit_events');
    const advanced = structuredClone(snapshot);
    advanced.caseVersion += 1;
    advanced.updatedAt = '2026-09-09T17:00:00.000Z';
    advanced.investigation!.gaps = [];
    advanced.uncertainties = [];
    setSnapshot(advanced);

    const replay = record({
      ...input,
      expectedCaseVersion: snapshot.caseVersion + 99,
      evidenceRefs: [first.evidenceRef, second.evidenceRef]
    });

    expect(replay).toEqual({ assessment: created.assessment, replayed: true });
    expect(tableCount('investigation_assessments')).toBe(1);
    expect(tableCount('audit_events')).toBe(auditCount);
  });

  it('rejects every immutable semantic change under an existing assessmentRef', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:conflict');
    const claim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);
    const input = assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], claim.claimRef, {
        assessorKind: 'RULE',
        assessorIdentifier: 'rule-engine:v1',
        ruleIdentifier: 'batch-evidence-consistency',
        ruleVersion: 'v1'
      });
    record(input);

    for (const changed of [
      { caseId: '60000000-0000-4000-8000-000000000099' },
      { questionRef: 'question:different' },
      { verdict: 'INSUFFICIENT' },
      { targetClaimRef: null },
      { evidenceRefs: ['evidence:different'] },
      { relatedClaimRefs: [claim.claimRef] },
      { assessorKind: 'AI' },
      { assessorIdentifier: 'rule-engine:v2' },
      { ruleIdentifier: 'different-rule' },
      { ruleVersion: 'v2' },
      { rationale: 'Changed rationale.' },
      { supersedesAssessmentRef: '95000000-0000-4000-8000-000000000099' }
    ]) {
      expectAssessmentError(() => record({ ...input, ...changed } as never), 'ASSESSMENT_CONFLICT');
    }
    expect(tableCount('investigation_assessments')).toBe(1);
  });

  it('preserves reassessment history and rejects invalid supersession chains', () => {
    const { gap, snapshot } = versionedGapCase();
    const firstEvidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:super-a');
    const secondEvidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:super-b');
    const firstClaim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion,
      [firstEvidence.evidenceRef], '94000000-0000-4000-8000-000000000071', 'MFT24');
    const secondClaim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion,
      [secondEvidence.evidenceRef], '94000000-0000-4000-8000-000000000072', 'MFT25');
    const firstInput = assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [firstEvidence.evidenceRef], firstClaim.claimRef, {
        assessmentRef: '95000000-0000-4000-8000-000000000071'
      });
    const first = record(firstInput).assessment;
    const second = record({
      ...firstInput,
      assessmentRef: '95000000-0000-4000-8000-000000000072',
      verdict: 'REJECTED',
      supersedesAssessmentRef: first.assessmentRef
    }).assessment;

    expect(getInvestigationAssessment(connection.db, snapshot.caseId, first.assessmentRef))
      .toEqual(first);
    expect(second.supersedesAssessmentRef).toBe(first.assessmentRef);
    expectAssessmentError(() => record({
      ...firstInput,
      assessmentRef: '95000000-0000-4000-8000-000000000073',
      supersedesAssessmentRef: '95000000-0000-4000-8000-000000000073'
    }), 'SUPERSESSION_MISMATCH');
    expectAssessmentError(() => record({
      ...firstInput,
      assessmentRef: '95000000-0000-4000-8000-000000000074',
      targetClaimRef: secondClaim.claimRef,
      evidenceRefs: [secondEvidence.evidenceRef],
      supersedesAssessmentRef: first.assessmentRef
    }), 'SUPERSESSION_MISMATCH');

    connection.db.insert(schema.investigationAssessments).values({
      assessmentRef: '95000000-0000-4000-8000-000000000075',
      caseId: snapshot.caseId,
      questionRef: 'question:other',
      targetClaimRef: null,
      verdict: 'INSUFFICIENT',
      evidenceRefsJson: JSON.stringify([firstEvidence.evidenceRef]),
      relatedClaimRefsJson: '[]',
      assessorKind: 'HUMAN',
      assessorIdentifier: 'demo_operator',
      ruleIdentifier: null,
      ruleVersion: null,
      rationale: 'Historical question-level attempt.',
      basisCaseVersion: snapshot.caseVersion,
      supersedesAssessmentRef: null,
      createdAt: '2026-09-09T15:00:00.000Z',
      demo: true
    }).run();
    expectAssessmentError(() => record({
      ...firstInput,
      assessmentRef: '95000000-0000-4000-8000-000000000076',
      supersedesAssessmentRef: '95000000-0000-4000-8000-000000000075'
    }), 'SUPERSESSION_MISMATCH');

    const otherConfirmed = confirmReviewMatch(
      connection.db,
      { matchId: fixtures.matches[0].id, actorName: 'demo_operator' },
      new Date('2026-09-09T14:30:00.000Z'),
      context
    );
    connection.db.insert(schema.investigationAssessments).values({
      assessmentRef: '95000000-0000-4000-8000-000000000077',
      caseId: otherConfirmed.caseId,
      questionRef: gap.id,
      targetClaimRef: null,
      verdict: 'INSUFFICIENT',
      evidenceRefsJson: JSON.stringify([firstEvidence.evidenceRef]),
      relatedClaimRefsJson: '[]',
      assessorKind: 'HUMAN',
      assessorIdentifier: 'demo_operator',
      ruleIdentifier: null,
      ruleVersion: null,
      rationale: 'Historical cross-case attempt.',
      basisCaseVersion: snapshot.caseVersion,
      supersedesAssessmentRef: null,
      createdAt: '2026-09-09T15:10:00.000Z',
      demo: true
    }).run();
    expectAssessmentError(() => record({
      ...firstInput,
      assessmentRef: '95000000-0000-4000-8000-000000000078',
      supersedesAssessmentRef: '95000000-0000-4000-8000-000000000077'
    }), 'SUPERSESSION_MISMATCH');
  });

  it('keeps multiple assessments visible in deterministic order without an effective winner', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:list');
    const claim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);
    const laterRef = '95000000-0000-4000-8000-000000000082';
    const earlierRef = '95000000-0000-4000-8000-000000000081';
    record(assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], claim.claimRef, {
        assessmentRef: laterRef,
        verdict: 'REJECTED'
      }), new Date('2026-09-09T17:00:00.000Z'));
    record(assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], claim.claimRef, {
        assessmentRef: earlierRef,
        verdict: 'SUPPORTED'
      }), new Date('2026-09-09T16:00:00.000Z'));

    const listed = listInvestigationAssessments(connection.db, snapshot.caseId, gap.id);
    expect(listed.map((assessment) => assessment.assessmentRef)).toEqual([earlierRef, laterRef]);
    expect(listed.map((assessment) => assessment.verdict)).toEqual(['SUPPORTED', 'REJECTED']);
    expect(getInvestigationAssessment(
      connection.db,
      '60000000-0000-4000-8000-000000000099',
      earlierRef
    )).toBeNull();
  });

  it('keeps demo reset compatible with restrictive assessment and claim foreign keys', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:reset');
    const claim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);
    record(assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], claim.claimRef));

    expect(() => clearDemoData(connection.db)).not.toThrow();
    expect(tableCount('investigation_assessments')).toBe(0);
    expect(tableCount('investigation_claims')).toBe(0);
    expect(tableCount('cases')).toBe(0);
  });

  it('survives database close and reopen', () => {
    const { gap, snapshot } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'evidence:assessment:persistence');
    const claim = createClaim(snapshot.caseId, gap.id, snapshot.caseVersion, [evidence.evidenceRef]);
    const recorded = record(assessmentInput(snapshot.caseId, gap.id, snapshot.caseVersion,
      [evidence.evidenceRef], claim.claimRef)).assessment;

    connection.sqlite.close();
    connection = createDatabaseConnection(databasePath);

    expect(getInvestigationAssessment(connection.db, snapshot.caseId, recorded.assessmentRef))
      .toEqual(recorded);
  });

  it('upgrades a populated 0006 database, reruns safely and preserves prior investigation data', () => {
    const preAssessmentFolder = join(directory, 'pre-assessment-migrations');
    mkdirSync(join(preAssessmentFolder, 'meta'), { recursive: true });
    for (const file of [
      '0000_initial.sql',
      '0001_last_living_lightning.sql',
      '0002_case_lifecycle.sql',
      '0003_traceability_exposure.sql',
      '0004_last_thunderbolt.sql',
      '0005_majestic_centennial.sql',
      '0006_cynical_rictor.sql'
    ]) cpSync(join('drizzle', file), join(preAssessmentFolder, file));
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 7);
    writeFileSync(join(preAssessmentFolder, 'meta/_journal.json'), JSON.stringify(journal));
    const existing = createDatabaseConnection(join(directory, 'populated-0006.db'));
    try {
      migrate(existing.db, { migrationsFolder: preAssessmentFolder });
      seedDemoData(existing.db, fixtures);
      const caseId = '60000000-0000-4000-8000-000000000098';
      const questionRef = 'historical:pre-assessment:question';
      const requestId = '93000000-0000-4000-8000-000000000098';
      const evidenceRef = 'evidence:assessment:pre-0007';
      existing.db.insert(schema.cases).values({
        id: caseId,
        caseNumber: 'CASE-PRE-ASSESSMENT-098',
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
        evidenceRef,
        caseId,
        questionRef,
        evidenceRequestId: requestId,
        sourceKind: 'EXTERNAL_PARTY',
        sourceIdentifier: 'supplier:pre-assessment',
        receivedAt: '2026-09-09T12:00:00.000Z',
        validAsOf: null,
        contentKind: 'STRUCTURED',
        contentJson: '{"assertedBatch":"MFT24"}',
        contentLocator: null,
        integrityHash: 'd'.repeat(64),
        demo: true
      }).run();
      existing.db.insert(schema.investigationClaims).values({
        claimRef: '94000000-0000-4000-8000-000000000098',
        caseId,
        questionRef,
        subjectRef: fixtures.matches[1].productId,
        claimType: 'AFFECTED_BATCH_LOT',
        valueJson: '{"lot":"MFT24"}',
        evidenceRefsJson: JSON.stringify([evidenceRef]),
        originKind: 'DETERMINISTIC_EXTRACTED',
        producerIdentifier: 'historical:pre-assessment',
        derivationMetadataJson: null,
        supersedesClaimRef: null,
        createdAt: '2026-09-09T13:00:00.000Z',
        demo: true
      }).run();
      const beforeClaims = existing.db.select().from(schema.investigationClaims).all();

      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      migrate(existing.db, { migrationsFolder: resolve('drizzle') });

      expect(existing.db.select().from(schema.investigationClaims).all()).toEqual(beforeClaims);
      expect(existing.db.select().from(schema.investigationAssessments).all()).toEqual([]);
      expect(existing.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      existing.sqlite.close();
    }
  });
});
