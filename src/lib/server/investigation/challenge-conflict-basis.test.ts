import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { caseSnapshotSchema, type CaseSnapshot } from '../../contracts/recall';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import {
  batchContradictionRule,
  recordInvestigationAssessment,
  type InvestigationAssessment
} from './assessments';
import {
  challengeConflictApplicationBasisFormatVersion,
  challengeConflictApplicationPolicy,
  readChallengeConflictApplicationBasis
} from './challenge-conflict-basis';
import { openInvestigationChallenge } from './challenges';
import { recordInvestigationClaim, type InvestigationClaim } from './claims';
import {
  EffectiveAnalysisError,
  readChallengeEffectiveInvestigationAnalysis
} from './effective-analysis';
import { recordInvestigationEvidence } from './evidence-registry';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const matchId = '50000000-0000-4000-8000-000000000002';
const gapAt = '2026-09-10T08:00:00.000Z';
const baselineAt = '2026-09-10T08:15:00.000Z';
const answerAt = '2026-09-10T09:00:00.000Z';
const lateAt = '2026-09-10T09:30:00.000Z';
const challengeAt = '2026-09-10T10:00:00.000Z';
const fixtures = loadDemoFixtures();
let directory: string;
let connection: TestConnection;

function resetTestDatabase(): void {
  if (connection) connection.sqlite.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = mkdtempSync(join(tmpdir(), 'verirecall-conflict-basis-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
}

function persistSnapshot(snapshot: CaseSnapshot): void {
  connection.db.update(schema.caseLifecycle).set({
    productId: snapshot.productId,
    caseVersion: snapshot.caseVersion,
    materialRevision: snapshot.materialRevision,
    snapshotJson: JSON.stringify(snapshot),
    updatedAt: snapshot.updatedAt
  }).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).run();
  connection.db.insert(schema.caseRevisions).values({
    id: randomUUID(),
    caseId: snapshot.caseId,
    caseVersion: snapshot.caseVersion,
    materialRevision: snapshot.materialRevision,
    snapshotJson: JSON.stringify(snapshot),
    actorId: 'test_fixture',
    createdAt: snapshot.updatedAt
  }).run();
}

function confirmGapCase() {
  const result = confirmReviewMatch(
    connection.db,
    { matchId, actorName: 'demo_operator' },
    new Date(gapAt),
    { mode: 'demo' }
  );
  const snapshot = readCaseSnapshot(connection.db, result.caseId);
  const gap = snapshot?.investigation?.gaps.find((issue) => issue.code === 'BATCH_MISSING');
  if (!snapshot || !gap) throw new Error('Expected BATCH_MISSING demo state.');
  return { snapshot, questionRef: gap.id };
}

function resolveGap(current: CaseSnapshot): CaseSnapshot {
  if (!current.investigation) throw new Error('Expected current investigation.');
  const materialRevision = (current.materialRevision ?? 0) + 1;
  const resolved = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    materialRevision,
    updatedAt: answerAt,
    investigation: {
      ...current.investigation,
      materialRevision,
      updatedAt: answerAt,
      knowledgeStatus: 'KNOWN',
      identity: {
        ...current.investigation.identity,
        knowledgeStatus: 'KNOWN',
        conclusion: 'MATCH'
      },
      scope: {
        kind: 'BATCH_LOT',
        knowledgeStatus: 'KNOWN',
        lots: ['MFT24'],
        evidenceRefs: [current.investigation.evidenceRefs[0]],
        decisionRefs: current.investigation.decisionRefs
      },
      gaps: [],
      conflicts: []
    },
    uncertainties: [],
    conflicts: []
  });
  persistSnapshot(resolved);
  return resolved;
}

function advanceOperationally(current: CaseSnapshot): CaseSnapshot {
  const advanced = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    updatedAt: '2026-09-10T12:00:00.000Z'
  });
  persistSnapshot(advanced);
  return advanced;
}

function advanceMaterially(current: CaseSnapshot): CaseSnapshot {
  if (!current.investigation || current.materialRevision === null) {
    throw new Error('Expected material investigation.');
  }
  const materialRevision = current.materialRevision + 1;
  const advanced = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    materialRevision,
    updatedAt: '2026-09-10T12:30:00.000Z',
    investigation: {
      ...current.investigation,
      materialRevision,
      updatedAt: '2026-09-10T12:30:00.000Z'
    }
  });
  persistSnapshot(advanced);
  return advanced;
}

function makeClosed(current: CaseSnapshot): CaseSnapshot {
  if (!current.investigation || current.materialRevision === null ||
      current.investigation.scope.kind !== 'BATCH_LOT') {
    throw new Error('Expected resolved batch investigation.');
  }
  const at = '2026-09-10T11:30:00.000Z';
  const source = {
    sourceRef: 'demo:closed:derived',
    sourceType: 'DERIVED' as const,
    asOf: at,
    demo: true
  };
  const knownZero = {
    value: 0,
    unit: 'ITEM' as const,
    knowledgeStatus: 'KNOWN' as const,
    sources: [source],
    asOf: at
  };
  const coverage = current.investigation.scope;
  const decision = (
    id: string,
    type: 'CONFIRM_IDENTITY' | 'CONFIRM_SCOPE' | 'CLOSE_CASE'
  ) => ({
    id,
    type,
    status: 'APPROVED' as const,
    subjectRef: type === 'CLOSE_CASE' ? current.caseId : current.productId,
    basisCaseVersion: current.caseVersion + 1,
    basisMaterialRevision: current.materialRevision!,
    coverage,
    evidenceRefs: current.investigation!.evidenceRefs,
    uncertaintyRefs: [],
    conflictRefs: [],
    consequence: 'Trusted demo operator reviewed the current known batch basis.',
    rationale: 'Test-only closed-case fixture.',
    actorId: 'demo_operator',
    actorRole: 'CASE_MANAGER',
    decidedAt: at,
    demo: true
  });
  const closeDecisionRef = randomUUID();
  return caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    stage: 'CLOSED',
    updatedAt: at,
    exposure: {
      status: 'CALCULATED',
      basisMaterialRevision: current.materialRevision,
      calculatedAt: at,
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
    decisions: [
      decision(randomUUID(), 'CONFIRM_IDENTITY'),
      decision(randomUUID(), 'CONFIRM_SCOPE'),
      decision(closeDecisionRef, 'CLOSE_CASE')
    ],
    closure: { status: 'CLOSED', blockers: [], decisionRef: closeDecisionRef }
  });
}

function recordEvidence(
  snapshot: CaseSnapshot,
  questionRef: string,
  evidenceRef: string,
  receivedAt: string,
  lot = 'MFT25',
  validAsOf: string | null = null
) {
  return recordInvestigationEvidence(connection.db, {
    evidenceRef,
    caseId: snapshot.caseId,
    questionRef,
    evidenceRequestId: null,
    sourceKind: 'EXTERNAL_PARTY',
    sourceIdentifier: `source:${evidenceRef}`,
    validAsOf,
    contentKind: 'STRUCTURED',
    contentJson: { assertedLot: lot },
    contentLocator: null,
    demo: true
  }, new Date(receivedAt)).evidence;
}

function recordClaim(
  snapshot: CaseSnapshot,
  questionRef: string,
  evidenceRefs: string[],
  lot: string,
  options: {
    challengeRef?: string;
    claimRef?: string;
    supersedesClaimRef?: string | null;
  } = {}
): InvestigationClaim {
  const challenge = options.challengeRef === undefined ? {} : {
    challengeRef: options.challengeRef,
    expectedMaterialRevision: snapshot.materialRevision!
  };
  return recordInvestigationClaim(connection.db, {
    claimRef: options.claimRef ?? randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    ...challenge,
    claimType: 'AFFECTED_BATCH_LOT',
    value: { lot },
    evidenceRefs,
    originKind: 'HUMAN_OBSERVED',
    producerIdentifier: 'demo_operator',
    derivationMetadata: null,
    supersedesClaimRef: options.supersedesClaimRef ?? null,
    demo: true
  }, { mode: 'demo' }, new Date('2026-09-10T10:15:00.000Z')).claim;
}

function recordAssessment(
  snapshot: CaseSnapshot,
  questionRef: string,
  input: {
    verdict: 'SUPPORTED' | 'INSUFFICIENT' | 'REJECTED' | 'CONTRADICTED';
    targetClaimRef: string | null;
    relatedClaimRefs: string[];
    evidenceRefs: string[];
    assessorKind?: 'HUMAN' | 'RULE' | 'AI';
    challengeRef?: string;
    supersedesAssessmentRef?: string | null;
  }
): InvestigationAssessment {
  const assessorKind = input.assessorKind ?? 'RULE';
  const requiresRule = assessorKind !== 'HUMAN' || input.verdict === 'CONTRADICTED';
  const challenge = input.challengeRef === undefined ? {} : {
    challengeRef: input.challengeRef,
    expectedMaterialRevision: snapshot.materialRevision!
  };
  return recordInvestigationAssessment(connection.db, {
    assessmentRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    ...challenge,
    verdict: input.verdict,
    targetClaimRef: input.targetClaimRef,
    evidenceRefs: input.evidenceRefs,
    relatedClaimRefs: input.relatedClaimRefs,
    assessorKind,
    assessorIdentifier: assessorKind === 'HUMAN' ? null : `${assessorKind.toLowerCase()}-reviewer`,
    ruleIdentifier: requiresRule ? batchContradictionRule.identifier : null,
    ruleVersion: requiresRule ? batchContradictionRule.version : null,
    rationale: 'Reviewed the complete deterministic batch conflict basis.',
    supersedesAssessmentRef: input.supersedesAssessmentRef ?? null,
    demo: true
  }, { mode: 'demo' }, new Date('2026-09-10T10:30:00.000Z')).assessment;
}

function seedConflict(assessorKind: 'HUMAN' | 'RULE' | 'AI' = 'RULE') {
  const { snapshot: gapSnapshot, questionRef } = confirmGapCase();
  const baselineEvidenceRef = 'demo:evidence:zz-baseline';
  recordEvidence(gapSnapshot, questionRef, baselineEvidenceRef, baselineAt, 'MFT24');
  const baselineClaim = recordClaim(
    gapSnapshot,
    questionRef,
    [baselineEvidenceRef],
    'MFT24',
    { claimRef: '10000000-0000-4000-8000-000000000002' }
  );
  const baselineAssessment = recordAssessment(gapSnapshot, questionRef, {
    verdict: 'SUPPORTED',
    targetClaimRef: baselineClaim.claimRef,
    relatedClaimRefs: [],
    evidenceRefs: [baselineEvidenceRef],
    assessorKind: 'HUMAN'
  });
  const answered = resolveGap(gapSnapshot);
  const lateEvidenceRef = 'demo:evidence:aa-late';
  recordEvidence(
    answered,
    questionRef,
    lateEvidenceRef,
    lateAt,
    'MFT25',
    '2020-01-01T00:00:00.000Z'
  );
  const challenge = openInvestigationChallenge(connection.db, {
    challengeRef: randomUUID(),
    caseId: answered.caseId,
    questionRef,
    expectedCaseVersion: answered.caseVersion,
    expectedMaterialRevision: answered.materialRevision!,
    triggerEvidenceRefs: [lateEvidenceRef],
    rationale: 'Late Evidence requires a conflict re-review.',
    demo: true
  }, { mode: 'demo' }, new Date(challengeAt)).challenge;
  const challengeClaim = recordClaim(
    answered,
    questionRef,
    [lateEvidenceRef],
    'MFT25',
    {
      challengeRef: challenge.challengeRef,
      claimRef: '90000000-0000-4000-8000-000000000002'
    }
  );
  const contradiction = recordAssessment(answered, questionRef, {
    verdict: 'CONTRADICTED',
    targetClaimRef: null,
    relatedClaimRefs: [challengeClaim.claimRef, baselineClaim.claimRef],
    evidenceRefs: [lateEvidenceRef, baselineEvidenceRef],
    assessorKind,
    challengeRef: challenge.challengeRef
  });
  return {
    gapSnapshot,
    answered,
    questionRef,
    baselineEvidenceRef,
    lateEvidenceRef,
    baselineClaim,
    baselineAssessment,
    challenge,
    challengeClaim,
    contradiction
  };
}

function databaseState() {
  return {
    lifecycle: connection.db.select().from(schema.caseLifecycle).all(),
    revisions: connection.db.select().from(schema.caseRevisions).all(),
    commands: connection.db.select().from(schema.caseCommands).all(),
    audit: connection.db.select().from(schema.auditEvents).all(),
    questions: connection.db.select().from(schema.investigationQuestions).all(),
    challenges: connection.db.select().from(schema.investigationChallenges).all(),
    evidence: connection.db.select().from(schema.investigationEvidence).all(),
    claims: connection.db.select().from(schema.investigationClaims).all(),
    claimAssociations: connection.db.select().from(schema.investigationChallengeClaims).all(),
    assessments: connection.db.select().from(schema.investigationAssessments).all(),
    assessmentAssociations: connection.db
      .select().from(schema.investigationChallengeAssessments).all(),
    establishments: connection.db.select().from(schema.investigationEstablishments).all(),
    tasks: connection.db.select().from(schema.caseTasks).all(),
    traceability: connection.db.select().from(schema.traceabilityRecords).all()
  };
}

beforeEach(() => {
  resetTestDatabase();
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('Challenge conflict application basis', () => {
  it('returns the compatible Challenge projection as an eligible canonical MFT24/MFT25 basis without writes', () => {
    const seeded = seedConflict();
    const projection = readChallengeEffectiveInvestigationAnalysis(
      connection.db,
      seeded.answered.caseId,
      seeded.questionRef,
      seeded.challenge.challengeRef
    );
    const before = databaseState();
    const basis = readChallengeConflictApplicationBasis(
      connection.db,
      seeded.answered.caseId,
      seeded.questionRef,
      seeded.challenge.challengeRef
    );

    expect(challengeConflictApplicationBasisFormatVersion).toBe(
      'challenge-conflict-application-basis/v1'
    );
    expect(challengeConflictApplicationPolicy).toEqual({
      identifier: 'demo-challenge-conflict-application-policy',
      version: 'v1'
    });
    expect(basis.basisFormatVersion).toBe('challenge-conflict-application-basis/v1');
    expect(basis.policyIdentifier).toBe('demo-challenge-conflict-application-policy');
    expect(basis.policyVersion).toBe('v1');
    expect(basis.projectionBasis).toEqual(projection.projectionBasis);
    expect(basis.completeEvidenceRefs).toEqual([
      seeded.lateEvidenceRef,
      seeded.baselineEvidenceRef
    ]);
    expect(basis.eligibility).toEqual({ eligible: true, blockerCodes: [] });
    expect(basis.qualifyingConflict).toEqual({
      contradictionAssessmentRef: seeded.contradiction.assessmentRef,
      relatedClaimRefs: [seeded.baselineClaim.claimRef, seeded.challengeClaim.claimRef],
      evidenceRefs: [seeded.lateEvidenceRef, seeded.baselineEvidenceRef],
      baselineClaimRefs: [seeded.baselineClaim.claimRef],
      challengeClaimRefs: [seeded.challengeClaim.claimRef],
      distinctNormalizedLots: ['mft24', 'mft25']
    });
    expect(basis.analysisState.staleAssessments).toContainEqual({
      assessmentRef: seeded.baselineAssessment.assessmentRef,
      reasons: ['MATERIAL_REVISION_STALE']
    });
    expect(basis.analysisState.ambiguities).toEqual([]);
    expect(basis.applicationBasisDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(databaseState()).toEqual(before);
  });

  it('is deterministic, lexically canonical, and changes coherently on an operational case version', () => {
    const seeded = seedConflict();
    const first = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    const repeated = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    expect(repeated).toEqual(first);
    expect(first.completeEvidenceRefs).toEqual([...first.completeEvidenceRefs].sort());
    expect(first.projectionBasis.claimRefs).toEqual([...first.projectionBasis.claimRefs].sort());
    expect(first.projectionBasis.assessmentRefs).toEqual(
      [...first.projectionBasis.assessmentRefs].sort()
    );

    const advanced = advanceOperationally(seeded.answered);
    const afterOperationalAdvance = readChallengeConflictApplicationBasis(
      connection.db, advanced.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    expect(afterOperationalAdvance.analysisContext.currentCaseVersion).toBe(
      advanced.caseVersion
    );
    expect(afterOperationalAdvance.analysisContext.currentMaterialRevision).toBe(
      seeded.answered.materialRevision
    );
    expect(afterOperationalAdvance.applicationBasisDigest).not.toBe(
      first.applicationBasisDigest
    );
  });

  it('does not depend on SQLite row insertion order for identical immutable semantics', () => {
    const seeded = seedConflict();
    const before = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    const evidence = connection.db.select().from(schema.investigationEvidence).where(
      eq(schema.investigationEvidence.caseId, seeded.answered.caseId)
    ).all();
    const claims = connection.db.select().from(schema.investigationClaims).where(
      eq(schema.investigationClaims.caseId, seeded.answered.caseId)
    ).all();
    const claimAssociations = connection.db.select()
      .from(schema.investigationChallengeClaims).all();
    const assessments = connection.db.select().from(schema.investigationAssessments).where(
      eq(schema.investigationAssessments.caseId, seeded.answered.caseId)
    ).all();
    const assessmentAssociations = connection.db.select()
      .from(schema.investigationChallengeAssessments).all();

    connection.db.delete(schema.investigationChallengeAssessments).run();
    connection.db.delete(schema.investigationAssessments).run();
    connection.db.delete(schema.investigationChallengeClaims).run();
    connection.db.delete(schema.investigationClaims).run();
    connection.db.delete(schema.investigationEvidence).run();
    connection.db.insert(schema.investigationEvidence).values([...evidence].reverse()).run();
    connection.db.insert(schema.investigationClaims).values([...claims].reverse()).run();
    connection.db.insert(schema.investigationChallengeClaims)
      .values([...claimAssociations].reverse()).run();
    connection.db.insert(schema.investigationAssessments)
      .values([...assessments].reverse()).run();
    connection.db.insert(schema.investigationChallengeAssessments)
      .values([...assessmentAssociations].reverse()).run();

    const after = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    expect(after).toEqual(before);
  });

  it('includes unreferenced Evidence, changes the digest, and requires a superseding complete review', () => {
    const seeded = seedConflict();
    const initial = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    const newEvidenceRef = 'demo:evidence:mm-unreferenced';
    recordEvidence(
      seeded.answered,
      seeded.questionRef,
      newEvidenceRef,
      '2026-09-10T11:00:00.000Z',
      'unreadable'
    );
    const incomplete = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    expect(incomplete.completeEvidenceRefs).toContain(newEvidenceRef);
    expect(incomplete.projectionBasis.referencedEvidenceRefs).not.toContain(newEvidenceRef);
    expect(incomplete.applicationBasisDigest).not.toBe(initial.applicationBasisDigest);
    expect(incomplete.eligibility.blockerCodes).toContain('UNREVIEWED_EVIDENCE_PRESENT');

    const superseding = recordAssessment(seeded.answered, seeded.questionRef, {
      verdict: 'CONTRADICTED',
      targetClaimRef: null,
      relatedClaimRefs: [seeded.baselineClaim.claimRef, seeded.challengeClaim.claimRef],
      evidenceRefs: [seeded.baselineEvidenceRef, seeded.lateEvidenceRef, newEvidenceRef],
      assessorKind: 'RULE',
      challengeRef: seeded.challenge.challengeRef,
      supersedesAssessmentRef: seeded.contradiction.assessmentRef
    });
    const reviewed = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    expect(reviewed.eligibility).toEqual({ eligible: true, blockerCodes: [] });
    expect(reviewed.qualifyingConflict?.contradictionAssessmentRef).toBe(
      superseding.assessmentRef
    );
    expect(reviewed.qualifyingConflict?.evidenceRefs).toEqual(reviewed.completeEvidenceRefs);
  });

  it('fingerprints new Claims and blocks a contradiction that hides an active Claim', () => {
    const seeded = seedConflict();
    const initial = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    const hidden = recordClaim(
      seeded.answered,
      seeded.questionRef,
      [seeded.lateEvidenceRef],
      'MFT26',
      { challengeRef: seeded.challenge.challengeRef }
    );
    const changed = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    expect(changed.analysisState.activeClaimRefs).toContain(hidden.claimRef);
    expect(changed.applicationBasisDigest).not.toBe(initial.applicationBasisDigest);
    expect(changed.eligibility.blockerCodes).toContain(
      'CONTRADICTION_DOES_NOT_COVER_ALL_ACTIVE_CLAIMS'
    );
  });

  it('fingerprints new Assessments and permits only the descriptive supported-in-conflict ambiguity', () => {
    const seeded = seedConflict();
    const initial = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    recordAssessment(seeded.answered, seeded.questionRef, {
      verdict: 'SUPPORTED',
      targetClaimRef: seeded.challengeClaim.claimRef,
      relatedClaimRefs: [],
      evidenceRefs: [seeded.lateEvidenceRef],
      assessorKind: 'HUMAN',
      challengeRef: seeded.challenge.challengeRef
    });
    const changed = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    expect(changed.applicationBasisDigest).not.toBe(initial.applicationBasisDigest);
    expect(changed.eligibility).toEqual({ eligible: true, blockerCodes: [] });
    expect(changed.analysisState.ambiguities).toContainEqual(expect.objectContaining({
      code: 'SUPPORTED_CLAIM_IN_CONTRADICTION'
    }));
  });

  it('fingerprints Claim and Assessment supersession without transferring old judgments', () => {
    const seeded = seedConflict();
    const initial = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    const replacement = recordClaim(
      seeded.answered,
      seeded.questionRef,
      [seeded.lateEvidenceRef],
      'MFT25',
      {
        challengeRef: seeded.challenge.challengeRef,
        supersedesClaimRef: seeded.challengeClaim.claimRef
      }
    );
    const claimChanged = readChallengeConflictApplicationBasis(
      connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
    );
    expect(claimChanged.applicationBasisDigest).not.toBe(initial.applicationBasisDigest);
    expect(claimChanged.analysisState.activeClaimRefs).toContain(replacement.claimRef);
    expect(claimChanged.eligibility.blockerCodes).toContain('NO_CURRENT_CONTRADICTION');

    resetTestDatabase();
    const second = seedConflict();
    const beforeAssessmentSupersession = readChallengeConflictApplicationBasis(
      connection.db, second.answered.caseId, second.questionRef, second.challenge.challengeRef
    );
    recordAssessment(second.answered, second.questionRef, {
      verdict: 'CONTRADICTED',
      targetClaimRef: null,
      relatedClaimRefs: [second.baselineClaim.claimRef, second.challengeClaim.claimRef],
      evidenceRefs: [second.baselineEvidenceRef, second.lateEvidenceRef],
      assessorKind: 'RULE',
      challengeRef: second.challenge.challengeRef,
      supersedesAssessmentRef: second.contradiction.assessmentRef
    });
    const assessmentChanged = readChallengeConflictApplicationBasis(
      connection.db, second.answered.caseId, second.questionRef, second.challenge.challengeRef
    );
    expect(assessmentChanged.applicationBasisDigest).not.toBe(
      beforeAssessmentSupersession.applicationBasisDigest
    );
    expect(assessmentChanged.eligibility.eligible).toBe(true);
  });

  it.each(['HUMAN', 'RULE'] as const)(
    'allows a complete %s contradiction but never selects a lot winner',
    (assessorKind) => {
      const seeded = seedConflict(assessorKind);
      const basis = readChallengeConflictApplicationBasis(
        connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
      );
      expect(basis.eligibility.eligible).toBe(true);
      expect(basis.qualifyingConflict?.distinctNormalizedLots).toEqual(['mft24', 'mft25']);
      expect(basis.qualifyingConflict).not.toHaveProperty('winningClaimRef');
      expect(basis.qualifyingConflict).not.toHaveProperty('winningLot');
    }
  );

  it('rejects AI contradiction provenance and multiple or absent current contradictions', () => {
    const ai = seedConflict('AI');
    const aiBasis = readChallengeConflictApplicationBasis(
      connection.db, ai.answered.caseId, ai.questionRef, ai.challenge.challengeRef
    );
    expect(aiBasis.eligibility.blockerCodes).toContain(
      'CONTRADICTION_ASSESSOR_NOT_ALLOWED'
    );
    expect(aiBasis.qualifyingConflict).toBeNull();

    resetTestDatabase();
    const multiple = seedConflict();
    recordAssessment(multiple.answered, multiple.questionRef, {
      verdict: 'CONTRADICTED',
      targetClaimRef: null,
      relatedClaimRefs: [multiple.baselineClaim.claimRef, multiple.challengeClaim.claimRef],
      evidenceRefs: [multiple.baselineEvidenceRef, multiple.lateEvidenceRef],
      assessorKind: 'HUMAN',
      challengeRef: multiple.challenge.challengeRef
    });
    const multipleBasis = readChallengeConflictApplicationBasis(
      connection.db,
      multiple.answered.caseId,
      multiple.questionRef,
      multiple.challenge.challengeRef
    );
    expect(multipleBasis.eligibility.blockerCodes).toContain(
      'MULTIPLE_CURRENT_CONTRADICTIONS'
    );

    connection.db.delete(schema.investigationChallengeAssessments)
      .where(eq(
        schema.investigationChallengeAssessments.assessmentRef,
        multiple.contradiction.assessmentRef
      )).run();
    connection.db.delete(schema.investigationAssessments)
      .where(eq(schema.investigationAssessments.assessmentRef, multiple.contradiction.assessmentRef))
      .run();
    const stillOne = readChallengeConflictApplicationBasis(
      connection.db,
      multiple.answered.caseId,
      multiple.questionRef,
      multiple.challenge.challengeRef
    );
    expect(stillOne.eligibility.eligible).toBe(true);

    resetTestDatabase();
    const absent = seedConflict();
    connection.db.delete(schema.investigationChallengeAssessments)
      .where(eq(
        schema.investigationChallengeAssessments.assessmentRef,
        absent.contradiction.assessmentRef
      )).run();
    connection.db.delete(schema.investigationAssessments)
      .where(eq(schema.investigationAssessments.assessmentRef, absent.contradiction.assessmentRef))
      .run();
    const absentBasis = readChallengeConflictApplicationBasis(
      connection.db,
      absent.answered.caseId,
      absent.questionRef,
      absent.challenge.challengeRef
    );
    expect(absentBasis.eligibility.blockerCodes).toContain('NO_CURRENT_CONTRADICTION');
  });

  it('blocks current rejection, claim insufficiency, question insufficiency, and blocking ambiguity', () => {
    const cases = [
      { verdict: 'REJECTED' as const, target: 'challenge', blocker: 'ACTIVE_CLAIM_REJECTED' },
      { verdict: 'INSUFFICIENT' as const, target: 'challenge', blocker: 'ACTIVE_CLAIM_INSUFFICIENT' },
      { verdict: 'INSUFFICIENT' as const, target: 'question', blocker: 'QUESTION_INSUFFICIENT' }
    ];
    for (const [index, item] of cases.entries()) {
      if (index > 0) resetTestDatabase();
      const seeded = seedConflict();
      recordAssessment(seeded.answered, seeded.questionRef, {
        verdict: item.verdict,
        targetClaimRef: item.target === 'challenge' ? seeded.challengeClaim.claimRef : null,
        relatedClaimRefs: [],
        evidenceRefs: [seeded.lateEvidenceRef],
        assessorKind: 'HUMAN',
        challengeRef: seeded.challenge.challengeRef
      });
      const basis = readChallengeConflictApplicationBasis(
        connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
      );
      expect(basis.eligibility.blockerCodes).toContain(item.blocker);
    }
  });

  it('blocks supported/rejected, supported/insufficient, and branching ambiguities', () => {
    for (const verdict of ['REJECTED', 'INSUFFICIENT'] as const) {
      const seeded = seedConflict();
      recordAssessment(seeded.answered, seeded.questionRef, {
        verdict: 'SUPPORTED',
        targetClaimRef: seeded.challengeClaim.claimRef,
        relatedClaimRefs: [],
        evidenceRefs: [seeded.lateEvidenceRef],
        assessorKind: 'HUMAN',
        challengeRef: seeded.challenge.challengeRef
      });
      recordAssessment(seeded.answered, seeded.questionRef, {
        verdict,
        targetClaimRef: seeded.challengeClaim.claimRef,
        relatedClaimRefs: [],
        evidenceRefs: [seeded.lateEvidenceRef],
        assessorKind: 'HUMAN',
        challengeRef: seeded.challenge.challengeRef
      });
      const basis = readChallengeConflictApplicationBasis(
        connection.db, seeded.answered.caseId, seeded.questionRef, seeded.challenge.challengeRef
      );
      expect(basis.eligibility.blockerCodes).toContain('BLOCKING_AMBIGUITY');
      expect(basis.analysisState.ambiguities.map((item) => item.code)).toContain(
        verdict === 'REJECTED'
          ? 'CLAIM_SUPPORTED_AND_REJECTED'
          : 'CLAIM_SUPPORTED_AND_INSUFFICIENT'
      );
      resetTestDatabase();
    }

    const branching = seedConflict();
    for (const assessorKind of ['HUMAN', 'RULE'] as const) {
      recordAssessment(branching.answered, branching.questionRef, {
        verdict: 'CONTRADICTED',
        targetClaimRef: null,
        relatedClaimRefs: [branching.baselineClaim.claimRef, branching.challengeClaim.claimRef],
        evidenceRefs: [branching.baselineEvidenceRef, branching.lateEvidenceRef],
        assessorKind,
        challengeRef: branching.challenge.challengeRef,
        supersedesAssessmentRef: branching.contradiction.assessmentRef
      });
    }
    const branchingBasis = readChallengeConflictApplicationBasis(
      connection.db,
      branching.answered.caseId,
      branching.questionRef,
      branching.challenge.challengeRef
    );
    expect(branchingBasis.analysisState.ambiguities.map((item) => item.code)).toContain(
      'ASSESSMENT_BRANCHING'
    );
    expect(branchingBasis.eligibility.blockerCodes).toContain('BLOCKING_AMBIGUITY');
  });

  it('ignores stale historical negative analysis but fails closed on equivalent normalized lots', () => {
    const { snapshot: gapSnapshot, questionRef } = confirmGapCase();
    const baselineEvidenceRef = 'demo:evidence:baseline-stale-negative';
    recordEvidence(gapSnapshot, questionRef, baselineEvidenceRef, baselineAt, 'MFT24');
    const baselineClaim = recordClaim(gapSnapshot, questionRef, [baselineEvidenceRef], 'MFT24');
    recordAssessment(gapSnapshot, questionRef, {
      verdict: 'REJECTED',
      targetClaimRef: baselineClaim.claimRef,
      relatedClaimRefs: [],
      evidenceRefs: [baselineEvidenceRef],
      assessorKind: 'HUMAN'
    });
    recordAssessment(gapSnapshot, questionRef, {
      verdict: 'INSUFFICIENT',
      targetClaimRef: baselineClaim.claimRef,
      relatedClaimRefs: [],
      evidenceRefs: [baselineEvidenceRef],
      assessorKind: 'HUMAN'
    });
    const answered = resolveGap(gapSnapshot);
    const lateEvidenceRef = 'demo:evidence:late-stale-negative';
    recordEvidence(answered, questionRef, lateEvidenceRef, lateAt, 'MFT25');
    const challenge = openInvestigationChallenge(connection.db, {
      challengeRef: randomUUID(),
      caseId: answered.caseId,
      questionRef,
      expectedCaseVersion: answered.caseVersion,
      expectedMaterialRevision: answered.materialRevision!,
      triggerEvidenceRefs: [lateEvidenceRef],
      rationale: 'Review late Evidence.',
      demo: true
    }, { mode: 'demo' }, new Date(challengeAt)).challenge;
    const challengeClaim = recordClaim(
      answered,
      questionRef,
      [lateEvidenceRef],
      'MFT25',
      { challengeRef: challenge.challengeRef }
    );
    recordAssessment(answered, questionRef, {
      verdict: 'CONTRADICTED',
      targetClaimRef: null,
      relatedClaimRefs: [baselineClaim.claimRef, challengeClaim.claimRef],
      evidenceRefs: [baselineEvidenceRef, lateEvidenceRef],
      assessorKind: 'RULE',
      challengeRef: challenge.challengeRef
    });
    const historicalNegative = readChallengeConflictApplicationBasis(
      connection.db, answered.caseId, questionRef, challenge.challengeRef
    );
    expect(historicalNegative.eligibility.eligible).toBe(true);
    expect(historicalNegative.eligibility.blockerCodes).not.toContain('ACTIVE_CLAIM_REJECTED');
    expect(historicalNegative.eligibility.blockerCodes).not.toContain(
      'ACTIVE_CLAIM_INSUFFICIENT'
    );

    connection.db.update(schema.investigationClaims).set({
      valueJson: JSON.stringify({ lot: 'MFT-24' })
    }).where(eq(schema.investigationClaims.claimRef, challengeClaim.claimRef)).run();
    const equivalent = readChallengeConflictApplicationBasis(
      connection.db, answered.caseId, questionRef, challenge.challengeRef
    );
    expect(equivalent.eligibility.blockerCodes).toContain('DISTINCT_LOTS_REQUIRED');
    expect(equivalent.qualifyingConflict).toBeNull();
  });

  it('requires both baseline and selected-Challenge Claims in the complete conflict', () => {
    const { snapshot: gapSnapshot, questionRef } = confirmGapCase();
    const answered = resolveGap(gapSnapshot);
    const lateEvidenceRef = 'demo:evidence:only-challenge';
    recordEvidence(answered, questionRef, lateEvidenceRef, lateAt, 'MFT25');
    const challenge = openInvestigationChallenge(connection.db, {
      challengeRef: randomUUID(),
      caseId: answered.caseId,
      questionRef,
      expectedCaseVersion: answered.caseVersion,
      expectedMaterialRevision: answered.materialRevision!,
      triggerEvidenceRefs: [lateEvidenceRef],
      rationale: 'Review two Challenge assertions.',
      demo: true
    }, { mode: 'demo' }, new Date(challengeAt)).challenge;
    const first = recordClaim(
      answered, questionRef, [lateEvidenceRef], 'MFT25', { challengeRef: challenge.challengeRef }
    );
    const second = recordClaim(
      answered, questionRef, [lateEvidenceRef], 'MFT26', { challengeRef: challenge.challengeRef }
    );
    recordAssessment(answered, questionRef, {
      verdict: 'CONTRADICTED',
      targetClaimRef: null,
      relatedClaimRefs: [first.claimRef, second.claimRef],
      evidenceRefs: [lateEvidenceRef],
      assessorKind: 'RULE',
      challengeRef: challenge.challengeRef
    });
    const basis = readChallengeConflictApplicationBasis(
      connection.db, answered.caseId, questionRef, challenge.challengeRef
    );
    expect(basis.eligibility.blockerCodes).toContain('BASELINE_CLAIM_REQUIRED');

    resetTestDatabase();
    const baseline = confirmGapCase();
    const firstEvidenceRef = 'demo:evidence:baseline-one';
    const secondEvidenceRef = 'demo:evidence:baseline-two';
    recordEvidence(baseline.snapshot, baseline.questionRef, firstEvidenceRef, baselineAt, 'MFT24');
    recordEvidence(
      baseline.snapshot,
      baseline.questionRef,
      secondEvidenceRef,
      '2026-09-10T08:20:00.000Z',
      'MFT25'
    );
    const firstBaseline = recordClaim(
      baseline.snapshot, baseline.questionRef, [firstEvidenceRef], 'MFT24'
    );
    const secondBaseline = recordClaim(
      baseline.snapshot, baseline.questionRef, [secondEvidenceRef], 'MFT25'
    );
    const baselineAnswered = resolveGap(baseline.snapshot);
    const triggerEvidenceRef = 'demo:evidence:challenge-trigger-only';
    recordEvidence(
      baselineAnswered,
      baseline.questionRef,
      triggerEvidenceRef,
      lateAt,
      'unreadable'
    );
    const baselineChallenge = openInvestigationChallenge(connection.db, {
      challengeRef: randomUUID(),
      caseId: baselineAnswered.caseId,
      questionRef: baseline.questionRef,
      expectedCaseVersion: baselineAnswered.caseVersion,
      expectedMaterialRevision: baselineAnswered.materialRevision!,
      triggerEvidenceRefs: [triggerEvidenceRef],
      rationale: 'Review a baseline-only contradiction.',
      demo: true
    }, { mode: 'demo' }, new Date(challengeAt)).challenge;
    recordAssessment(baselineAnswered, baseline.questionRef, {
      verdict: 'CONTRADICTED',
      targetClaimRef: null,
      relatedClaimRefs: [firstBaseline.claimRef, secondBaseline.claimRef],
      evidenceRefs: [firstEvidenceRef, secondEvidenceRef, triggerEvidenceRef],
      assessorKind: 'RULE',
      challengeRef: baselineChallenge.challengeRef
    });
    const noChallengeClaim = readChallengeConflictApplicationBasis(
      connection.db,
      baselineAnswered.caseId,
      baseline.questionRef,
      baselineChallenge.challengeRef
    );
    expect(noChallengeClaim.eligibility.blockerCodes).toContain('CHALLENGE_CLAIM_REQUIRED');
  });

  it('does not treat an unassociated contradiction as the selected Challenge judgment', () => {
    const { snapshot: gapSnapshot, questionRef } = confirmGapCase();
    const firstEvidenceRef = 'demo:evidence:unscoped-one';
    const secondEvidenceRef = 'demo:evidence:unscoped-two';
    recordEvidence(gapSnapshot, questionRef, firstEvidenceRef, baselineAt, 'MFT24');
    recordEvidence(
      gapSnapshot,
      questionRef,
      secondEvidenceRef,
      '2026-09-10T08:20:00.000Z',
      'MFT25'
    );
    const first = recordClaim(gapSnapshot, questionRef, [firstEvidenceRef], 'MFT24');
    const second = recordClaim(gapSnapshot, questionRef, [secondEvidenceRef], 'MFT25');
    const unassociated = recordAssessment(gapSnapshot, questionRef, {
      verdict: 'CONTRADICTED',
      targetClaimRef: null,
      relatedClaimRefs: [first.claimRef, second.claimRef],
      evidenceRefs: [firstEvidenceRef, secondEvidenceRef],
      assessorKind: 'RULE'
    });
    const answered = resolveGap(gapSnapshot);
    const triggerEvidenceRef = 'demo:evidence:unscoped-trigger';
    recordEvidence(answered, questionRef, triggerEvidenceRef, lateAt, 'unreadable');
    const challenge = openInvestigationChallenge(connection.db, {
      challengeRef: randomUUID(),
      caseId: answered.caseId,
      questionRef,
      expectedCaseVersion: answered.caseVersion,
      expectedMaterialRevision: answered.materialRevision!,
      triggerEvidenceRefs: [triggerEvidenceRef],
      rationale: 'Open a Challenge without a scoped contradiction.',
      demo: true
    }, { mode: 'demo' }, new Date(challengeAt)).challenge;
    connection.db.update(schema.investigationAssessments).set({
      basisCaseVersion: answered.caseVersion,
      evidenceRefsJson: JSON.stringify([
        firstEvidenceRef,
        secondEvidenceRef,
        triggerEvidenceRef
      ].sort())
    }).where(eq(schema.investigationAssessments.assessmentRef, unassociated.assessmentRef)).run();

    const basis = readChallengeConflictApplicationBasis(
      connection.db, answered.caseId, questionRef, challenge.challengeRef
    );
    expect(basis.eligibility.blockerCodes).toContain(
      'CONTRADICTION_NOT_CHALLENGE_SCOPED'
    );
    expect(basis.qualifyingConflict).toBeNull();
  });

  it('preserves existing hard Challenge currentness errors and CLOSED state', () => {
    const seeded = seedConflict();
    const current = readCaseSnapshot(connection.db, seeded.answered.caseId)!;
    const validClosed = makeClosed(current);
    connection.db.update(schema.cases).set({ status: 'closed', closedAt: validClosed.updatedAt })
      .where(eq(schema.cases.id, current.caseId)).run();
    persistSnapshot(validClosed);
    const before = databaseState();
    expect(readChallengeConflictApplicationBasis(
      connection.db, validClosed.caseId, seeded.questionRef, seeded.challenge.challengeRef
    ).eligibility.eligible).toBe(true);
    expect(databaseState()).toEqual(before);

    resetTestDatabase();
    const historical = seedConflict();
    advanceMaterially(historical.answered);
    expect(() => readChallengeConflictApplicationBasis(
      connection.db,
      historical.answered.caseId,
      historical.questionRef,
      historical.challenge.challengeRef
    )).toThrow(expect.objectContaining<Partial<EffectiveAnalysisError>>({
      code: 'CHALLENGE_NOT_CURRENT'
    }));
  });
});
