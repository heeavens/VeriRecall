import { randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  caseSnapshotSchema,
  investigationOutcomeSchema,
  type CaseSnapshot
} from '../../contracts/recall';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { clearDemoData, seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import {
  batchContradictionRule,
  recordInvestigationAssessment
} from './assessments';
import {
  applyInvestigationChallengeConflict,
  getInvestigationChallengeConflictApplication,
  InvestigationChallengeConflictApplicationError
} from './challenge-conflict-applications';
import { readChallengeConflictApplicationBasis } from './challenge-conflict-basis';
import { openInvestigationChallenge } from './challenges';
import { recordInvestigationClaim } from './claims';
import { recordInvestigationEvidence } from './evidence-registry';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const matchId = '50000000-0000-4000-8000-000000000002';
const gapAt = '2026-09-10T08:00:00.000Z';
const answerAt = '2026-09-10T09:00:00.000Z';
const lateAt = '2026-09-10T09:30:00.000Z';
const applicationAt = '2026-09-10T11:00:00.000Z';
const fixtures = loadDemoFixtures();
let directory: string;
let connection: TestConnection;

function persistSnapshot(snapshot: CaseSnapshot): string {
  connection.db.update(schema.caseLifecycle).set({
    productId: snapshot.productId,
    caseVersion: snapshot.caseVersion,
    materialRevision: snapshot.materialRevision,
    snapshotJson: JSON.stringify(snapshot),
    updatedAt: snapshot.updatedAt
  }).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).run();
  const revisionId = randomUUID();
  connection.db.insert(schema.caseRevisions).values({
    id: revisionId,
    caseId: snapshot.caseId,
    caseVersion: snapshot.caseVersion,
    materialRevision: snapshot.materialRevision,
    snapshotJson: JSON.stringify(snapshot),
    actorId: 'test_fixture',
    createdAt: snapshot.updatedAt
  }).run();
  return revisionId;
}

function recordEvidence(
  snapshot: CaseSnapshot,
  questionRef: string,
  evidenceRef: string,
  receivedAt: string,
  lot: string
): void {
  recordInvestigationEvidence(connection.db, {
    evidenceRef,
    caseId: snapshot.caseId,
    questionRef,
    evidenceRequestId: null,
    sourceKind: 'EXTERNAL_PARTY',
    sourceIdentifier: `source:${evidenceRef}`,
    validAsOf: null,
    contentKind: 'STRUCTURED',
    contentJson: { assertedLot: lot },
    contentLocator: null,
    demo: true
  }, new Date(receivedAt));
}

function recordClaim(
  snapshot: CaseSnapshot,
  questionRef: string,
  evidenceRefs: string[],
  lot: string,
  challengeRef?: string
) {
  return recordInvestigationClaim(connection.db, {
    claimRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    ...(challengeRef
      ? { challengeRef, expectedMaterialRevision: snapshot.materialRevision! }
      : {}),
    claimType: 'AFFECTED_BATCH_LOT',
    value: { lot },
    evidenceRefs,
    originKind: 'HUMAN_OBSERVED',
    producerIdentifier: 'demo_operator',
    derivationMetadata: null,
    supersedesClaimRef: null,
    demo: true
  }, { mode: 'demo' }, new Date('2026-09-10T10:15:00.000Z')).claim;
}

function recordAssessment(
  snapshot: CaseSnapshot,
  questionRef: string,
  input: {
    verdict: 'SUPPORTED' | 'CONTRADICTED';
    targetClaimRef: string | null;
    relatedClaimRefs: string[];
    evidenceRefs: string[];
    challengeRef?: string;
  }
) {
  return recordInvestigationAssessment(connection.db, {
    assessmentRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    ...(input.challengeRef
      ? {
          challengeRef: input.challengeRef,
          expectedMaterialRevision: snapshot.materialRevision!
        }
      : {}),
    verdict: input.verdict,
    targetClaimRef: input.targetClaimRef,
    evidenceRefs: input.evidenceRefs,
    relatedClaimRefs: input.relatedClaimRefs,
    assessorKind: input.verdict === 'SUPPORTED' ? 'HUMAN' : 'RULE',
    assessorIdentifier: input.verdict === 'SUPPORTED' ? null : 'rule-reviewer',
    ruleIdentifier: input.verdict === 'SUPPORTED'
      ? null
      : batchContradictionRule.identifier,
    ruleVersion: input.verdict === 'SUPPORTED'
      ? null
      : batchContradictionRule.version,
    rationale: 'Reviewed the complete immutable conflict basis.',
    supersedesAssessmentRef: null,
    demo: true
  }, { mode: 'demo' }, new Date('2026-09-10T10:30:00.000Z')).assessment;
}

function seedEligibleConflict(options: { unrelatedIssues?: boolean } = {}) {
  const confirmed = confirmReviewMatch(
    connection.db,
    { matchId, actorName: 'demo_operator' },
    new Date(gapAt),
    { mode: 'demo' }
  );
  const gapSnapshot = readCaseSnapshot(connection.db, confirmed.caseId);
  const questionRef = gapSnapshot?.investigation?.gaps.find(
    (issue) => issue.code === 'BATCH_MISSING'
  )?.id;
  if (!gapSnapshot || !questionRef || !gapSnapshot.investigation) {
    throw new Error('Expected a versioned BATCH_MISSING Question fixture.');
  }

  const baselineEvidenceRef = 'demo:evidence:application-baseline';
  recordEvidence(gapSnapshot, questionRef, baselineEvidenceRef, '2026-09-10T08:15:00.000Z', 'MFT24');
  const baselineClaim = recordClaim(
    gapSnapshot,
    questionRef,
    [baselineEvidenceRef],
    'MFT24'
  );
  recordAssessment(gapSnapshot, questionRef, {
    verdict: 'SUPPORTED',
    targetClaimRef: baselineClaim.claimRef,
    relatedClaimRefs: [],
    evidenceRefs: [baselineEvidenceRef]
  });

  const materialRevision = gapSnapshot.materialRevision! + 1;
  const unrelatedGap = {
    id: 'demo:unrelated:packaging-gap',
    code: 'EVIDENCE_MISSING',
    message: 'Packaging disposition remains under review.',
    critical: false,
    subjectRefs: [gapSnapshot.productId],
    evidenceRefs: []
  };
  const unrelatedConflict = {
    id: 'demo:unrelated:route-conflict',
    code: 'ROUTE_CONFLICT',
    message: 'Distribution route records remain contradictory.',
    critical: true,
    subjectRefs: [gapSnapshot.productId],
    evidenceRefs: []
  };
  const answered = caseSnapshotSchema.parse({
    ...gapSnapshot,
    caseVersion: gapSnapshot.caseVersion + 1,
    materialRevision,
    updatedAt: answerAt,
    investigation: {
      ...gapSnapshot.investigation,
      materialRevision,
      updatedAt: answerAt,
      knowledgeStatus: options.unrelatedIssues ? 'CONFLICTED' : 'KNOWN',
      identity: {
        ...gapSnapshot.investigation.identity,
        knowledgeStatus: 'KNOWN',
        conclusion: 'MATCH'
      },
      scope: {
        kind: 'BATCH_LOT',
        knowledgeStatus: 'KNOWN',
        lots: ['MFT24'],
        evidenceRefs: [gapSnapshot.investigation.evidenceRefs[0]],
        decisionRefs: gapSnapshot.investigation.decisionRefs
      },
      gaps: options.unrelatedIssues ? [unrelatedGap] : [],
      conflicts: options.unrelatedIssues ? [unrelatedConflict] : []
    },
    uncertainties: options.unrelatedIssues ? [unrelatedGap] : [],
    conflicts: options.unrelatedIssues ? [unrelatedConflict] : []
  });
  const answerRevisionId = persistSnapshot(answered);

  const lateEvidenceRef = 'demo:evidence:application-late';
  recordEvidence(answered, questionRef, lateEvidenceRef, lateAt, 'MFT25');
  const challenge = openInvestigationChallenge(connection.db, {
    challengeRef: randomUUID(),
    caseId: answered.caseId,
    questionRef,
    expectedCaseVersion: answered.caseVersion,
    expectedMaterialRevision: answered.materialRevision!,
    triggerEvidenceRefs: [lateEvidenceRef],
    rationale: 'Late Evidence requires authoritative conflict re-review.',
    demo: true
  }, { mode: 'demo' }, new Date('2026-09-10T10:00:00.000Z')).challenge;
  const challengeClaim = recordClaim(
    answered,
    questionRef,
    [lateEvidenceRef],
    'MFT25',
    challenge.challengeRef
  );
  const contradiction = recordAssessment(answered, questionRef, {
    verdict: 'CONTRADICTED',
    targetClaimRef: null,
    relatedClaimRefs: [baselineClaim.claimRef, challengeClaim.claimRef],
    evidenceRefs: [baselineEvidenceRef, lateEvidenceRef],
    challengeRef: challenge.challengeRef
  });
  const basis = readChallengeConflictApplicationBasis(
    connection.db,
    answered.caseId,
    questionRef,
    challenge.challengeRef
  );
  if (!basis.eligibility.eligible || !basis.qualifyingConflict) {
    throw new Error('Expected an eligible Challenge conflict fixture.');
  }
  return {
    gapSnapshot,
    answered,
    answerRevisionId,
    questionRef,
    baselineEvidenceRef,
    lateEvidenceRef,
    baselineClaim,
    challengeClaim,
    contradiction,
    challenge,
    basis
  };
}

function applicationInput(seed: ReturnType<typeof seedEligibleConflict>) {
  return {
    applicationRef: randomUUID(),
    caseId: seed.answered.caseId,
    questionRef: seed.questionRef,
    challengeRef: seed.challenge.challengeRef,
    expectedCaseVersion: seed.answered.caseVersion,
    expectedMaterialRevision: seed.answered.materialRevision!,
    expectedApplicationBasisDigest: seed.basis.applicationBasisDigest,
    rationale: '  Reviewed the exact current conflict basis and accept unresolved uncertainty.  ',
    demo: true as const
  };
}

function stateCounts(caseId: string) {
  return {
    revisions: connection.db.select().from(schema.caseRevisions)
      .where(eq(schema.caseRevisions.caseId, caseId)).all().length,
    commands: connection.db.select().from(schema.caseCommands)
      .where(eq(schema.caseCommands.caseId, caseId)).all().length,
    audit: connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.caseId, caseId)).all().length,
    applications: connection.db.select()
      .from(schema.investigationChallengeConflictApplications)
      .where(eq(schema.investigationChallengeConflictApplications.caseId, caseId)).all().length
  };
}

function expectApplicationError(
  action: () => unknown,
  code: InvestigationChallengeConflictApplicationError['code']
): void {
  try {
    action();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationChallengeConflictApplicationError);
    expect((error as InvestigationChallengeConflictApplicationError).code).toBe(code);
  }
}

function closeFixture(seed: ReturnType<typeof seedEligibleConflict>): CaseSnapshot {
  const current = seed.answered;
  if (!current.investigation) throw new Error('Expected investigation.');
  const closedAt = '2026-09-10T10:45:00.000Z';
  const knownZero = {
    value: 0,
    unit: 'ITEM' as const,
    knowledgeStatus: 'KNOWN' as const,
    sources: [{
      sourceRef: 'demo:closed:source',
      sourceType: 'DERIVED' as const,
      asOf: closedAt,
      demo: true
    }],
    asOf: closedAt
  };
  const decision = (type: 'CONFIRM_IDENTITY' | 'CONFIRM_SCOPE' | 'CLOSE_CASE') => ({
    id: randomUUID(),
    type,
    status: 'APPROVED' as const,
    subjectRef: type === 'CLOSE_CASE' ? current.caseId : current.productId,
    basisCaseVersion: current.caseVersion + 1,
    basisMaterialRevision: current.materialRevision!,
    coverage: current.investigation!.scope,
    evidenceRefs: current.investigation!.evidenceRefs,
    uncertaintyRefs: [],
    conflictRefs: [],
    consequence: 'Trusted demo operator reviewed the current known scope.',
    rationale: 'Closed-case application fixture.',
    actorId: 'demo_operator',
    actorRole: 'CASE_MANAGER',
    decidedAt: closedAt,
    demo: true
  });
  const closeDecision = decision('CLOSE_CASE');
  const closed = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    stage: 'CLOSED',
    updatedAt: closedAt,
    exposure: {
      status: 'CALCULATED',
      basisMaterialRevision: current.materialRevision,
      calculatedAt: closedAt,
      received: knownZero,
      warehouse: knownZero,
      inTransit: knownZero,
      retailer: knownZero,
      sold: knownZero,
      unaccounted: knownZero,
      contained: knownZero,
      gaps: [],
      conflicts: []
    },
    tasks: [],
    uncertainties: [],
    conflicts: [],
    attentionItems: [],
    pendingDecisions: [],
    decisions: [decision('CONFIRM_IDENTITY'), decision('CONFIRM_SCOPE'), closeDecision],
    closure: { status: 'CLOSED', blockers: [], decisionRef: closeDecision.id }
  });
  connection.db.update(schema.cases).set({ status: 'closed', closedAt })
    .where(eq(schema.cases.id, current.caseId)).run();
  persistSnapshot(closed);
  return closed;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-conflict-application-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('Challenge conflict authoritative application', () => {
  it('atomically applies the exact reviewed conflict basis and persists canonical provenance', () => {
    const seed = seedEligibleConflict();
    const input = applicationInput(seed);
    const beforeCounts = stateCounts(seed.answered.caseId);
    const result = applyInvestigationChallengeConflict(
      connection.db,
      input,
      { mode: 'demo' },
      new Date(applicationAt)
    );

    expect(result.replayed).toBe(false);
    expect(result.snapshot.caseVersion).toBe(seed.answered.caseVersion + 1);
    expect(result.snapshot.materialRevision).toBe(seed.answered.materialRevision! + 1);
    expect(result.snapshot.stage).toBe('INVESTIGATING');
    expect(result.snapshot.exposure.status).toBe('NOT_CALCULATED');
    expect(result.snapshot.closure.status).toBe('NOT_READY');
    const outcome = investigationOutcomeSchema.parse(result.snapshot.investigation);
    expect(outcome.identity).toEqual(seed.answered.investigation!.identity);
    expect(outcome).toMatchObject({
      knowledgeStatus: 'CONFLICTED',
      materialRevision: seed.answered.materialRevision! + 1,
      scope: {
        kind: 'UNRESOLVED',
        knowledgeStatus: 'CONFLICTED',
        reason: 'Incompatible affected batch/lot claims remain unresolved after review.',
        decisionRefs: [input.applicationRef]
      }
    });
    expect(outcome.conflicts).toContainEqual({
      id: seed.questionRef,
      code: 'BATCH_CONFLICT',
      message: 'Incompatible affected batch/lot claims remain unresolved after review.',
      critical: true,
      subjectRefs: [seed.answered.productId],
      evidenceRefs: seed.basis.qualifyingConflict!.evidenceRefs
    });
    expect(outcome.decisionRefs).toContain(input.applicationRef);
    expect(outcome.evidenceRefs).toEqual(expect.arrayContaining(
      seed.basis.qualifyingConflict!.evidenceRefs
    ));
    expect(outcome.evidenceRefs).not.toContain(seed.baselineClaim.claimRef);
    expect(outcome.evidenceRefs).not.toContain(seed.challengeClaim.claimRef);
    expect(outcome.evidenceRefs).not.toContain(seed.contradiction.assessmentRef);
    expect(outcome.evidenceRefs).not.toContain(seed.challenge.challengeRef);
    expect(result.snapshot.decisions.some((decision) =>
      decision.id === input.applicationRef
    )).toBe(false);

    expect(result.application).toMatchObject({
      applicationRef: input.applicationRef,
      policyIdentifier: 'demo-challenge-conflict-application-policy',
      policyVersion: 'v1',
      basisFormatVersion: 'challenge-conflict-application-basis/v1',
      basisDigest: seed.basis.applicationBasisDigest,
      sourceRevisionId: seed.answerRevisionId,
      sourceCaseVersion: seed.answered.caseVersion,
      sourceMaterialRevision: seed.answered.materialRevision,
      resultingRevisionId: expect.any(String),
      resultingCaseVersion: seed.answered.caseVersion + 1,
      resultingMaterialRevision: seed.answered.materialRevision! + 1,
      actorKind: 'HUMAN',
      actorIdentifier: 'demo_operator',
      rationale: 'Reviewed the exact current conflict basis and accept unresolved uncertainty.',
      createdAt: applicationAt,
      demo: true
    });
    expect(result.application.reviewedClaimRefs).toEqual(seed.basis.projectionBasis.claimRefs);
    expect(result.application.reviewedAssessmentRefs)
      .toEqual(seed.basis.projectionBasis.assessmentRefs);
    expect(result.application.completeEvidenceRefs).toEqual(seed.basis.completeEvidenceRefs);
    expect(result.application.appliedClaimRefs)
      .toEqual(seed.basis.qualifyingConflict!.relatedClaimRefs);
    expect(result.application.appliedAssessmentRefs)
      .toEqual([seed.contradiction.assessmentRef]);
    expect(result.application.appliedEvidenceRefs)
      .toEqual(seed.basis.qualifyingConflict!.evidenceRefs);
    expect(stateCounts(seed.answered.caseId)).toEqual({
      revisions: beforeCounts.revisions + 1,
      commands: beforeCounts.commands + 1,
      audit: beforeCounts.audit + 1,
      applications: 1
    });
    const resultingRevision = connection.db.select().from(schema.caseRevisions)
      .where(eq(schema.caseRevisions.id, result.application.resultingRevisionId)).get();
    expect(resultingRevision).toMatchObject({
      caseVersion: result.snapshot.caseVersion,
      materialRevision: result.snapshot.materialRevision
    });
    const event = connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, 'investigation_challenge_conflict_applied')).get();
    expect(event).toBeTruthy();
    expect(JSON.parse(event!.metadataJson)).toMatchObject({
      applicationRef: input.applicationRef,
      challengeRef: seed.challenge.challengeRef,
      sourceRevisionId: seed.answerRevisionId,
      resultingRevisionId: result.application.resultingRevisionId,
      reopened: false
    });
  });

  it('preserves unrelated authoritative gaps, conflicts, and their lineage', () => {
    const seed = seedEligibleConflict({ unrelatedIssues: true });
    const input = applicationInput(seed);
    const result = applyInvestigationChallengeConflict(
      connection.db,
      input,
      { mode: 'demo' },
      new Date(applicationAt)
    );
    const outcome = investigationOutcomeSchema.parse(result.snapshot.investigation);

    expect(outcome.gaps).toContainEqual(seed.answered.investigation!.gaps[0]);
    expect(outcome.conflicts).toEqual(expect.arrayContaining([
      seed.answered.investigation!.conflicts[0],
      expect.objectContaining({ id: seed.questionRef, code: 'BATCH_CONFLICT' })
    ]));
    expect(outcome.identity).toEqual(seed.answered.investigation!.identity);
    expect(outcome.evidenceRefs).toEqual(expect.arrayContaining(
      seed.answered.investigation!.evidenceRefs
    ));
    expect(outcome.decisionRefs).toEqual(expect.arrayContaining([
      ...seed.answered.investigation!.decisionRefs,
      input.applicationRef
    ]));
  });

  it('replays from the exact resulting revision after later advancement and ignores stale preconditions', () => {
    const seed = seedEligibleConflict();
    const input = applicationInput(seed);
    const applied = applyInvestigationChallengeConflict(connection.db, input, { mode: 'demo' });
    const later = caseSnapshotSchema.parse({
      ...applied.snapshot,
      caseVersion: applied.snapshot.caseVersion + 1,
      updatedAt: '2026-09-10T12:00:00.000Z'
    });
    persistSnapshot(later);
    const before = stateCounts(seed.answered.caseId);

    const replay = applyInvestigationChallengeConflict(connection.db, {
      ...input,
      expectedCaseVersion: 1,
      expectedMaterialRevision: 1,
      expectedApplicationBasisDigest: `sha256:${'f'.repeat(64)}`
    }, { mode: 'demo' });
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot).toEqual(applied.snapshot);
    expect(replay.snapshot).not.toEqual(readCaseSnapshot(connection.db, seed.answered.caseId));
    expect(stateCounts(seed.answered.caseId)).toEqual(before);

    expectApplicationError(() => applyInvestigationChallengeConflict(connection.db, {
      ...input,
      rationale: 'Different immutable human authorization.'
    }, { mode: 'demo' }), 'APPLICATION_CONFLICT');
    expectApplicationError(() => applyInvestigationChallengeConflict(connection.db, {
      ...input,
      applicationRef: randomUUID()
    }, { mode: 'demo' }), 'CHALLENGE_ALREADY_APPLIED');
  });

  it.each(['evidence', 'claim', 'assessment'] as const)(
    'rejects a human-reviewed digest after a new %s without lifecycle version changes',
    (change) => {
      const seed = seedEligibleConflict();
      const input = applicationInput(seed);
      const before = readCaseSnapshot(connection.db, seed.answered.caseId)!;
      if (change === 'evidence') {
        recordEvidence(
          seed.answered,
          seed.questionRef,
          'demo:evidence:application-unreviewed',
          '2026-09-10T10:45:00.000Z',
          'MFT26'
        );
      } else if (change === 'claim') {
        recordClaim(
          seed.answered,
          seed.questionRef,
          [seed.lateEvidenceRef],
          'MFT26',
          seed.challenge.challengeRef
        );
      } else {
        recordAssessment(seed.answered, seed.questionRef, {
          verdict: 'SUPPORTED',
          targetClaimRef: seed.challengeClaim.claimRef,
          relatedClaimRefs: [],
          evidenceRefs: [seed.lateEvidenceRef],
          challengeRef: seed.challenge.challengeRef
        });
      }
      expect(readCaseSnapshot(connection.db, seed.answered.caseId)).toEqual(before);
      expectApplicationError(() => applyInvestigationChallengeConflict(
        connection.db,
        input,
        { mode: 'demo' }
      ), 'STALE_APPLICATION_BASIS');
      expect(stateCounts(seed.answered.caseId).applications).toBe(0);
    }
  );

  it('rejects stale versions, current ineligible state, invalid input, and command collisions', () => {
    const seed = seedEligibleConflict();
    const input = applicationInput(seed);
    expectApplicationError(() => applyInvestigationChallengeConflict(connection.db, {
      ...input,
      expectedCaseVersion: input.expectedCaseVersion - 1
    }, { mode: 'demo' }), 'STALE_CASE_VERSION');
    expectApplicationError(() => applyInvestigationChallengeConflict(connection.db, {
      ...input,
      expectedMaterialRevision: input.expectedMaterialRevision - 1
    }, { mode: 'demo' }), 'STALE_MATERIAL_REVISION');
    expectApplicationError(() => applyInvestigationChallengeConflict(connection.db, {
      ...input,
      unexpectedActorKind: 'AI'
    }, { mode: 'demo' }), 'INVALID_INPUT');
    expectApplicationError(() => applyInvestigationChallengeConflict(connection.db, {
      ...input,
      applicationRef: 'not-an-immutable-identifier'
    }, { mode: 'demo' }), 'INVALID_INPUT');
    expectApplicationError(() => applyInvestigationChallengeConflict(connection.db, {
      ...input,
      demo: false
    }, { mode: 'demo' }), 'INVALID_INPUT');
    expectApplicationError(() => applyInvestigationChallengeConflict(connection.db, input, {
      mode: 'disabled'
    }), 'FORBIDDEN');

    recordEvidence(
      seed.answered,
      seed.questionRef,
      'demo:evidence:application-incomplete',
      '2026-09-10T10:45:00.000Z',
      'MFT26'
    );
    const ineligible = readChallengeConflictApplicationBasis(
      connection.db,
      seed.answered.caseId,
      seed.questionRef,
      seed.challenge.challengeRef
    );
    expect(ineligible.eligibility.eligible).toBe(false);
    expectApplicationError(() => applyInvestigationChallengeConflict(connection.db, {
      ...input,
      expectedApplicationBasisDigest: ineligible.applicationBasisDigest
    }, { mode: 'demo' }), 'APPLICATION_NOT_ELIGIBLE');

    resetConnection();
    const collisionSeed = seedEligibleConflict();
    const collisionInput = applicationInput(collisionSeed);
    connection.db.insert(schema.caseCommands).values({
      id: randomUUID(),
      caseId: collisionSeed.answered.caseId,
      commandId: collisionInput.applicationRef,
      payloadJson: '{"operation":"UNRELATED"}',
      appliedCaseVersion: collisionSeed.answered.caseVersion,
      createdAt: applicationAt
    }).run();
    expectApplicationError(() => applyInvestigationChallengeConflict(
      connection.db,
      collisionInput,
      { mode: 'demo' }
    ), 'COMMAND_ID_CONFLICT');
  });

  it('rolls back the complete lifecycle transition when application persistence fails', () => {
    const seed = seedEligibleConflict();
    const closed = closeFixture(seed);
    const basis = readChallengeConflictApplicationBasis(
      connection.db,
      closed.caseId,
      seed.questionRef,
      seed.challenge.challengeRef
    );
    const input = {
      ...applicationInput(seed),
      expectedCaseVersion: closed.caseVersion,
      expectedApplicationBasisDigest: basis.applicationBasisDigest
    };
    const beforeSnapshot = readCaseSnapshot(connection.db, seed.answered.caseId);
    const beforeCase = connection.db.select().from(schema.cases)
      .where(eq(schema.cases.id, seed.answered.caseId)).get();
    const beforeCounts = stateCounts(seed.answered.caseId);
    connection.sqlite.exec(`
      create trigger fail_conflict_application
      before insert on investigation_challenge_conflict_applications
      begin
        select raise(abort, 'forced application failure');
      end
    `);
    expect(() => applyInvestigationChallengeConflict(
      connection.db,
      input,
      { mode: 'demo' }
    )).toThrow(/forced application failure/);
    expect(readCaseSnapshot(connection.db, seed.answered.caseId)).toEqual(beforeSnapshot);
    expect(connection.db.select().from(schema.cases)
      .where(eq(schema.cases.id, seed.answered.caseId)).get()).toEqual(beforeCase);
    expect(stateCounts(seed.answered.caseId)).toEqual(beforeCounts);
  });

  it('leaves no application or partial lifecycle write when revision persistence fails', () => {
    const seed = seedEligibleConflict();
    const input = applicationInput(seed);
    const beforeSnapshot = readCaseSnapshot(connection.db, seed.answered.caseId);
    const beforeCounts = stateCounts(seed.answered.caseId);
    connection.sqlite.exec(`
      create trigger fail_conflict_revision
      before insert on case_revisions
      begin
        select raise(abort, 'forced revision failure');
      end
    `);
    expect(() => applyInvestigationChallengeConflict(
      connection.db,
      input,
      { mode: 'demo' }
    )).toThrow(/forced revision failure/);
    expect(readCaseSnapshot(connection.db, seed.answered.caseId)).toEqual(beforeSnapshot);
    expect(stateCounts(seed.answered.caseId)).toEqual(beforeCounts);
  });

  it('reuses material-change lifecycle behavior to reopen a CLOSED case', () => {
    const seed = seedEligibleConflict();
    const closed = closeFixture(seed);
    connection.db.insert(schema.traceabilityRecords).values({
      id: randomUUID(),
      caseId: closed.caseId,
      sourceRef: 'demo:application:traceability',
      recordType: 'RECEIPT',
      payloadJson: '{}',
      occurredAt: '2026-09-10T10:40:00.000Z',
      createdAt: '2026-09-10T10:40:00.000Z'
    }).run();
    const basis = readChallengeConflictApplicationBasis(
      connection.db,
      closed.caseId,
      seed.questionRef,
      seed.challenge.challengeRef
    );
    const result = applyInvestigationChallengeConflict(connection.db, {
      ...applicationInput(seed),
      expectedCaseVersion: closed.caseVersion,
      expectedApplicationBasisDigest: basis.applicationBasisDigest
    }, { mode: 'demo' }, new Date(applicationAt));

    expect(result.snapshot).toMatchObject({
      caseVersion: closed.caseVersion + 1,
      materialRevision: closed.materialRevision! + 1,
      stage: 'INVESTIGATING',
      exposure: { status: 'NOT_CALCULATED' },
      closure: { status: 'NOT_READY' }
    });
    expect(result.snapshot.decisions.every((decision) =>
      decision.status === 'STALE'
    )).toBe(true);
    expect(connection.db.select().from(schema.cases)
      .where(eq(schema.cases.id, closed.caseId)).get()).toMatchObject({
      status: 'open',
      closedAt: null
    });
    expect(connection.db.select().from(schema.traceabilityRecords)
      .where(eq(schema.traceabilityRecords.caseId, closed.caseId)).all()).toHaveLength(1);
    expect(connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, 'case_reopened')).all()).toHaveLength(1);
  });

  it('persists and validates application provenance after reopening the database', () => {
    const seed = seedEligibleConflict();
    const input = applicationInput(seed);
    const applied = applyInvestigationChallengeConflict(connection.db, input, { mode: 'demo' });
    const databasePath = join(directory, 'test.db');
    connection.sqlite.close();
    connection = createDatabaseConnection(databasePath);

    expect(getInvestigationChallengeConflictApplication(
      connection.db,
      seed.answered.caseId,
      input.applicationRef
    )).toEqual(applied.application);
    expect(getInvestigationChallengeConflictApplication(
      connection.db,
      randomUUID(),
      input.applicationRef
    )).toBeNull();
  });

  it('fails closed when stored application provenance is malformed', () => {
    const seed = seedEligibleConflict();
    const input = applicationInput(seed);
    applyInvestigationChallengeConflict(connection.db, input, { mode: 'demo' });
    connection.sqlite.prepare(`
      update investigation_challenge_conflict_applications
      set applied_claim_refs_json = '[]'
      where application_ref = ?
    `).run(input.applicationRef);

    expectApplicationError(() => getInvestigationChallengeConflictApplication(
      connection.db,
      seed.answered.caseId,
      input.applicationRef
    ), 'APPLICATION_PROVENANCE_INVALID');
  });

  it('enforces immutable application constraints, restrictive lineage FKs, and reset order', () => {
    const seed = seedEligibleConflict();
    const input = applicationInput(seed);
    const applied = applyInvestigationChallengeConflict(connection.db, input, { mode: 'demo' });
    const update = (assignment: string) => connection.sqlite.prepare(
      `update investigation_challenge_conflict_applications set ${assignment} where application_ref = ?`
    );

    expect(() => update("actor_kind = 'AI'").run(input.applicationRef))
      .toThrow(/actor_kind_check/);
    expect(() => update('demo = 0').run(input.applicationRef)).toThrow(/demo_check/);
    expect(() => update("basis_digest = 'sha256:ABC'").run(input.applicationRef))
      .toThrow(/basis_digest_check/);
    expect(() => update('resulting_case_version = source_case_version + 2')
      .run(input.applicationRef)).toThrow(/case_version_step_check/);
    expect(() => update('resulting_material_revision = source_material_revision + 2')
      .run(input.applicationRef)).toThrow(/material_revision_step_check/);
    expect(() => connection.db.delete(schema.caseRevisions).where(eq(
      schema.caseRevisions.id,
      applied.application.resultingRevisionId
    )).run()).toThrow(/FOREIGN KEY constraint failed/);
    expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);

    expect(() => clearDemoData(connection.db)).not.toThrow();
    expect(connection.db.select().from(schema.investigationChallengeConflictApplications).all())
      .toEqual([]);
    expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(() => seedDemoData(connection.db, fixtures)).not.toThrow();
  });

  it('upgrades a populated 0011 database additively, preserves prior data, and reruns safely', () => {
    const preApplicationFolder = join(directory, 'pre-application-migrations');
    mkdirSync(join(preApplicationFolder, 'meta'), { recursive: true });
    for (const file of [
      '0000_initial.sql',
      '0001_last_living_lightning.sql',
      '0002_case_lifecycle.sql',
      '0003_traceability_exposure.sql',
      '0004_last_thunderbolt.sql',
      '0005_majestic_centennial.sql',
      '0006_cynical_rictor.sql',
      '0007_calm_captain_cross.sql',
      '0008_warm_zarek.sql',
      '0009_glamorous_celestials.sql',
      '0010_lying_hellcat.sql',
      '0011_confused_hannibal_king.sql'
    ]) cpSync(join('drizzle', file), join(preApplicationFolder, file));
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 12);
    writeFileSync(
      join(preApplicationFolder, 'meta/_journal.json'),
      JSON.stringify(journal)
    );

    const existing = createDatabaseConnection(join(directory, 'populated-0011.db'));
    try {
      migrate(existing.db, { migrationsFolder: preApplicationFolder });
      seedDemoData(existing.db, fixtures);
      expect(existing.sqlite.prepare(
        "select name from sqlite_master where type = 'table' and name = ?"
      ).get('investigation_challenge_conflict_applications')).toBeUndefined();
      const productsBefore = existing.db.select().from(schema.products).all();
      const alertsBefore = existing.db.select().from(schema.alerts).all();
      const matchesBefore = existing.db.select().from(schema.matches).all();

      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      expect(existing.db.select().from(schema.products).all()).toEqual(productsBefore);
      expect(existing.db.select().from(schema.alerts).all()).toEqual(alertsBefore);
      expect(existing.db.select().from(schema.matches).all()).toEqual(matchesBefore);
      expect(existing.db.select()
        .from(schema.investigationChallengeConflictApplications).all()).toEqual([]);
      expect(existing.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      existing.sqlite.close();
    }
  });
});

function resetConnection(): void {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
  directory = mkdtempSync(join(tmpdir(), 'verirecall-conflict-application-reset-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
}
