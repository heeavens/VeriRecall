import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { and, count, eq } from 'drizzle-orm';
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { caseSnapshotSchema, type CaseSnapshot } from '../../contracts/recall';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import { batchContradictionRule, recordInvestigationAssessment } from './assessments';
import { openInvestigationChallenge, type InvestigationChallenge } from './challenges';
import { recordInvestigationClaim, type InvestigationClaim } from './claims';
import {
  EffectiveAnalysisError,
  readChallengeEffectiveInvestigationAnalysis
} from './effective-analysis';
import { recordInvestigationEvidence } from './evidence-registry';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const missingBatchMatchId = '50000000-0000-4000-8000-000000000002';
const gapAt = '2026-09-09T10:00:00.000Z';
const baselineAt = '2026-09-09T10:30:00.000Z';
const answerAt = '2026-09-09T12:00:00.000Z';
const lateAt = '2026-09-09T13:00:00.000Z';
const challengeAt = '2026-09-09T14:00:00.000Z';
const fixtures = loadDemoFixtures();
let directory: string;
let connection: TestConnection;

function tableCount(table: AnySQLiteTable): number {
  return connection.db.select({ value: count() }).from(table).get()?.value ?? 0;
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
    { matchId: missingBatchMatchId, actorName: 'demo_operator' },
    new Date(gapAt),
    { mode: 'demo' }
  );
  const snapshot = readCaseSnapshot(connection.db, result.caseId);
  const gap = snapshot?.investigation?.gaps.find((issue) => issue.code === 'BATCH_MISSING');
  if (!snapshot || !gap) throw new Error('Expected the BATCH_MISSING fixture.');
  return { snapshot, gap };
}

function advanceOperationally(current: CaseSnapshot, at: string): CaseSnapshot {
  const advanced = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    updatedAt: at
  });
  persistSnapshot(advanced);
  return advanced;
}

function advanceGapMaterially(current: CaseSnapshot, at: string): CaseSnapshot {
  if (!current.investigation || current.materialRevision === null) {
    throw new Error('Expected a material investigation gap.');
  }
  const materialRevision = current.materialRevision + 1;
  const advanced = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    materialRevision,
    updatedAt: at,
    investigation: {
      ...current.investigation,
      materialRevision,
      updatedAt: at
    }
  });
  persistSnapshot(advanced);
  return advanced;
}

function resolveGap(current: CaseSnapshot, at = answerAt): CaseSnapshot {
  if (!current.investigation) throw new Error('Expected an investigation outcome.');
  const materialRevision = (current.materialRevision ?? 0) + 1;
  const resolved = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    materialRevision,
    updatedAt: at,
    investigation: {
      ...current.investigation,
      materialRevision,
      updatedAt: at,
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

function advanceMaterially(current: CaseSnapshot): CaseSnapshot {
  if (!current.investigation || current.materialRevision === null) {
    throw new Error('Expected a material investigation.');
  }
  const materialRevision = current.materialRevision + 1;
  const advanced = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    materialRevision,
    updatedAt: '2026-09-09T18:00:00.000Z',
    investigation: {
      ...current.investigation,
      materialRevision,
      updatedAt: '2026-09-09T18:00:00.000Z'
    }
  });
  persistSnapshot(advanced);
  return advanced;
}

function recordEvidence(
  snapshot: CaseSnapshot,
  questionRef: string,
  evidenceRef: string,
  receivedAt: string,
  evidenceRequestId: string | null = null,
  validAsOf: string | null = null
) {
  return recordInvestigationEvidence(connection.db, {
    evidenceRef,
    caseId: snapshot.caseId,
    questionRef,
    evidenceRequestId,
    sourceKind: 'EXTERNAL_PARTY',
    sourceIdentifier: `supplier:${evidenceRef}`,
    validAsOf,
    contentKind: 'STRUCTURED',
    contentJson: { assertedLot: 'MFT25' },
    contentLocator: null,
    demo: true
  }, new Date(receivedAt)).evidence;
}

function openGapClaim(
  snapshot: CaseSnapshot,
  questionRef: string,
  evidenceRefs: string[],
  lot = 'MFT24',
  supersedesClaimRef: string | null = null
) {
  return recordInvestigationClaim(connection.db, {
    claimRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    claimType: 'AFFECTED_BATCH_LOT',
    value: { lot },
    evidenceRefs,
    originKind: 'HUMAN_OBSERVED',
    producerIdentifier: 'demo_operator',
    derivationMetadata: null,
    supersedesClaimRef,
    demo: true
  }, { mode: 'demo' }).claim;
}

function openGapAssessment(
  snapshot: CaseSnapshot,
  questionRef: string,
  claim: InvestigationClaim,
  evidenceRefs: string[]
) {
  return recordInvestigationAssessment(connection.db, {
    assessmentRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    verdict: 'SUPPORTED',
    targetClaimRef: claim.claimRef,
    evidenceRefs,
    relatedClaimRefs: [],
    assessorKind: 'HUMAN',
    assessorIdentifier: null,
    ruleIdentifier: null,
    ruleVersion: null,
    rationale: 'Reviewed the registered baseline Evidence.',
    supersedesAssessmentRef: null,
    demo: true
  }, { mode: 'demo' }).assessment;
}

function openChallenge(
  snapshot: CaseSnapshot,
  questionRef: string,
  triggerEvidenceRef: string
): InvestigationChallenge {
  if (snapshot.materialRevision === null) throw new Error('Expected material revision.');
  return openInvestigationChallenge(connection.db, {
    challengeRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    expectedMaterialRevision: snapshot.materialRevision,
    triggerEvidenceRefs: [triggerEvidenceRef],
    rationale: 'Late supplier Evidence requires factual re-review.',
    demo: true
  }, { mode: 'demo' }, new Date(challengeAt)).challenge;
}

function challengeClaim(
  snapshot: CaseSnapshot,
  questionRef: string,
  challengeRef: string,
  evidenceRefs: string[],
  lot = 'MFT25',
  supersedesClaimRef: string | null = null
) {
  if (snapshot.materialRevision === null) throw new Error('Expected material revision.');
  return recordInvestigationClaim(connection.db, {
    claimRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    challengeRef,
    expectedCaseVersion: snapshot.caseVersion,
    expectedMaterialRevision: snapshot.materialRevision,
    claimType: 'AFFECTED_BATCH_LOT',
    value: { lot },
    evidenceRefs,
    originKind: 'HUMAN_OBSERVED',
    producerIdentifier: 'demo_operator',
    derivationMetadata: null,
    supersedesClaimRef,
    demo: true
  }, { mode: 'demo' }).claim;
}

function contradictionAssessment(
  snapshot: CaseSnapshot,
  questionRef: string,
  challengeRef: string,
  claims: InvestigationClaim[],
  evidenceRefs: string[]
) {
  if (snapshot.materialRevision === null) throw new Error('Expected material revision.');
  return recordInvestigationAssessment(connection.db, {
    assessmentRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    challengeRef,
    expectedCaseVersion: snapshot.caseVersion,
    expectedMaterialRevision: snapshot.materialRevision,
    verdict: 'CONTRADICTED',
    targetClaimRef: null,
    evidenceRefs,
    relatedClaimRefs: claims.map((claim) => claim.claimRef),
    assessorKind: 'RULE',
    assessorIdentifier: 'batch-contradiction-detector',
    ruleIdentifier: batchContradictionRule.identifier,
    ruleVersion: batchContradictionRule.version,
    rationale: 'The baseline and Challenge lot assertions normalize differently.',
    supersedesAssessmentRef: null,
    demo: true
  }, { mode: 'demo' }).assessment;
}

function seedAnsweredChallenge(operationalGapRevisions = 0, materialGapRevisions = 0) {
  const { snapshot: origin, gap } = confirmGapCase();
  const baselineEvidenceRef = `demo:evidence:${randomUUID()}`;
  recordEvidence(origin, gap.id, baselineEvidenceRef, baselineAt);
  const baselineClaim = openGapClaim(origin, gap.id, [baselineEvidenceRef]);
  const baselineAssessment = openGapAssessment(
    origin,
    gap.id,
    baselineClaim,
    [baselineEvidenceRef]
  );
  let gapSnapshot = origin;
  for (let index = 0; index < operationalGapRevisions; index += 1) {
    gapSnapshot = advanceOperationally(
      gapSnapshot,
      `2026-09-09T11:0${index}:00.000Z`
    );
  }
  for (let index = 0; index < materialGapRevisions; index += 1) {
    gapSnapshot = advanceGapMaterially(
      gapSnapshot,
      `2026-09-09T11:1${index}:00.000Z`
    );
  }
  const answered = resolveGap(gapSnapshot);
  const lateEvidenceRef = `demo:evidence:${randomUUID()}`;
  recordEvidence(
    answered,
    gap.id,
    lateEvidenceRef,
    lateAt,
    null,
    '2025-01-01T00:00:00.000Z'
  );
  const challenge = openChallenge(answered, gap.id, lateEvidenceRef);
  return {
    origin,
    gapSnapshot,
    answered,
    gap,
    baselineEvidenceRef,
    lateEvidenceRef,
    baselineClaim,
    baselineAssessment,
    challenge
  };
}

function makeClosed(current: CaseSnapshot): CaseSnapshot {
  if (!current.investigation || current.materialRevision === null ||
      current.investigation.scope.kind !== 'BATCH_LOT') {
    throw new Error('Expected a resolved batch investigation.');
  }
  const at = '2026-09-09T16:00:00.000Z';
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
  const decision = (id: string, type: 'CONFIRM_IDENTITY' | 'CONFIRM_SCOPE' | 'CLOSE_CASE') => ({
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
  const closeDecisionId = randomUUID();
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
      decision(closeDecisionId, 'CLOSE_CASE')
    ],
    closure: { status: 'CLOSED', blockers: [], decisionRef: closeDecisionId }
  });
}

function seedLaterChallengeArtifacts(
  answered: CaseSnapshot,
  questionRef: string,
  selected: InvestigationChallenge,
  targetClaimRef: string
) {
  const challengeRef = randomUUID();
  connection.db.insert(schema.investigationChallenges).values({
    challengeRef,
    caseId: answered.caseId,
    questionRef,
    challengedRevisionId: selected.challengedRevisionId,
    challengedMaterialRevision: selected.challengedMaterialRevision + 100,
    openedCaseVersion: selected.openedCaseVersion + 1,
    triggerEvidenceRefsJson: JSON.stringify(selected.triggerEvidenceRefs),
    openedByKind: 'HUMAN',
    openedByIdentifier: 'demo_operator',
    rationale: 'Later-cycle projection boundary fixture.',
    createdAt: '2026-09-09T15:00:00.000Z',
    demo: true
  }).run();
  const evidenceRef = `demo:evidence:${randomUUID()}`;
  const requestId = randomUUID();
  connection.db.insert(schema.evidenceRequests).values({
    id: requestId,
    matchId: missingBatchMatchId,
    caseId: answered.caseId,
    questionRef,
    requestedEvidence: JSON.stringify(['supplier_invoice']),
    recipient: null,
    status: 'pending',
    createdAt: '2026-09-09T15:05:00.000Z',
    resolvedAt: null
  }).run();
  connection.db.insert(schema.investigationChallengeRequests).values({
    requestId,
    challengeRef
  }).run();
  recordEvidence(answered, questionRef, evidenceRef, '2026-09-09T15:10:00.000Z', requestId);
  const claimRef = randomUUID();
  connection.db.insert(schema.investigationClaims).values({
    claimRef,
    caseId: answered.caseId,
    questionRef,
    subjectRef: answered.productId,
    claimType: 'AFFECTED_BATCH_LOT',
    valueJson: JSON.stringify({ lot: 'MFT26' }),
    evidenceRefsJson: JSON.stringify([evidenceRef]),
    originKind: 'HUMAN_OBSERVED',
    producerIdentifier: 'demo_operator',
    derivationMetadataJson: null,
    supersedesClaimRef: null,
    createdAt: '2026-09-09T15:15:00.000Z',
    demo: true
  }).run();
  connection.db.insert(schema.investigationChallengeClaims).values({
    claimRef,
    challengeRef
  }).run();
  const assessmentRef = randomUUID();
  connection.db.insert(schema.investigationAssessments).values({
    assessmentRef,
    caseId: answered.caseId,
    questionRef,
    targetClaimRef,
    verdict: 'SUPPORTED',
    evidenceRefsJson: JSON.stringify([evidenceRef]),
    relatedClaimRefsJson: JSON.stringify([]),
    assessorKind: 'HUMAN',
    assessorIdentifier: 'demo_operator',
    ruleIdentifier: null,
    ruleVersion: null,
    rationale: 'Excluded later-cycle Assessment may reference a baseline Claim.',
    basisCaseVersion: answered.caseVersion,
    supersedesAssessmentRef: null,
    createdAt: '2026-09-09T15:20:00.000Z',
    demo: true
  }).run();
  connection.db.insert(schema.investigationChallengeAssessments).values({
    assessmentRef,
    challengeRef
  }).run();
  return { challengeRef, evidenceRef, claimRef, assessmentRef };
}

function expectAnalysisError(action: () => unknown, code: EffectiveAnalysisError['code']) {
  expect(action).toThrow(expect.objectContaining({ code }));
}

function databaseState() {
  return {
    lifecycle: connection.db.select().from(schema.caseLifecycle).all(),
    revisions: connection.db.select().from(schema.caseRevisions).all(),
    commands: connection.db.select().from(schema.caseCommands).all(),
    questions: connection.db.select().from(schema.investigationQuestions).all(),
    challenges: connection.db.select().from(schema.investigationChallenges).all(),
    requests: connection.db.select().from(schema.evidenceRequests).all(),
    requestAssociations: connection.db.select().from(schema.investigationChallengeRequests).all(),
    evidence: connection.db.select().from(schema.investigationEvidence).all(),
    claims: connection.db.select().from(schema.investigationClaims).all(),
    claimAssociations: connection.db.select().from(schema.investigationChallengeClaims).all(),
    assessments: connection.db.select().from(schema.investigationAssessments).all(),
    assessmentAssociations: connection.db
      .select().from(schema.investigationChallengeAssessments).all(),
    establishments: connection.db.select().from(schema.investigationEstablishments).all(),
    audit: connection.db.select().from(schema.auditEvents).all(),
    tasks: connection.db.select().from(schema.caseTasks).all(),
    traceability: connection.db.select().from(schema.traceabilityRecords).all()
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-challenge-analysis-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('Challenge-scoped effective investigation analysis', () => {
  it('projects the baseline contradiction truthfully, deterministically, and without writes', () => {
    const seeded = seedAnsweredChallenge();
    const challengeClaimRecord = challengeClaim(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge.challengeRef,
      [seeded.lateEvidenceRef]
    );
    const contradiction = contradictionAssessment(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge.challengeRef,
      [seeded.baselineClaim, challengeClaimRecord],
      [seeded.baselineEvidenceRef, seeded.lateEvidenceRef]
    );
    const snapshotBefore = structuredClone(readCaseSnapshot(connection.db, seeded.answered.caseId));
    const stateBefore = databaseState();

    const first = readChallengeEffectiveInvestigationAnalysis(
      connection.db,
      seeded.answered.caseId,
      seeded.gap.id,
      seeded.challenge.challengeRef
    );
    const second = readChallengeEffectiveInvestigationAnalysis(
      connection.db,
      seeded.answered.caseId,
      seeded.gap.id,
      seeded.challenge.challengeRef
    );

    expect(first).toEqual(second);
    expect(first.analysisContext).toEqual({
      kind: 'OPEN_CHALLENGE',
      challengeRef: seeded.challenge.challengeRef,
      challengedRevisionId: seeded.challenge.challengedRevisionId,
      challengedMaterialRevision: seeded.challenge.challengedMaterialRevision,
      currentCaseVersion: seeded.answered.caseVersion,
      currentMaterialRevision: seeded.answered.materialRevision
    });
    expect(first.analysis.activeClaims.map((claim) => claim.claimRef)).toEqual([
      seeded.baselineClaim.claimRef,
      challengeClaimRecord.claimRef
    ]);
    expect(first.analysis.structuralAssessmentHeads.map(
      (assessment) => assessment.assessmentRef
    )).toEqual([seeded.baselineAssessment.assessmentRef, contradiction.assessmentRef]);
    expect(first.analysis.applicableAssessmentHeads.map(
      (assessment) => assessment.assessmentRef
    )).toEqual([seeded.baselineAssessment.assessmentRef, contradiction.assessmentRef]);
    expect(first.analysis.materiallyCurrentAssessmentHeads.map(
      (assessment) => assessment.assessmentRef
    )).toEqual([contradiction.assessmentRef]);
    expect(first.analysis.staleAssessments).toContainEqual({
      assessment: seeded.baselineAssessment,
      reasons: ['MATERIAL_REVISION_STALE']
    });
    expect(first.analysis.activeContradictions).toEqual([{
      assessmentRef: contradiction.assessmentRef,
      relatedClaimRefs: [seeded.baselineClaim.claimRef, challengeClaimRecord.claimRef].sort()
    }]);
    expect(first.projectionBasis).toEqual({
      claimRefs: [seeded.baselineClaim.claimRef, challengeClaimRecord.claimRef].sort(),
      assessmentRefs: [seeded.baselineAssessment.assessmentRef, contradiction.assessmentRef].sort(),
      referencedEvidenceRefs: [seeded.baselineEvidenceRef, seeded.lateEvidenceRef].sort()
    });
    expect(readCaseSnapshot(connection.db, seeded.answered.caseId)).toEqual(snapshotBefore);
    expect(databaseState()).toEqual(stateBefore);
  });

  it('requires the exact current Challenge and rejects material advancement', () => {
    const seeded = seedAnsweredChallenge();
    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        seeded.answered.caseId,
        seeded.gap.id,
        randomUUID()
      ),
      'CHALLENGE_NOT_FOUND'
    );
    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        seeded.answered.caseId,
        'another-question',
        seeded.challenge.challengeRef
      ),
      'QUESTION_OWNERSHIP_MISMATCH'
    );
    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        randomUUID(),
        seeded.gap.id,
        seeded.challenge.challengeRef
      ),
      'CHALLENGE_NOT_FOUND'
    );

    advanceMaterially(seeded.answered);
    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        seeded.answered.caseId,
        seeded.gap.id,
        seeded.challenge.challengeRef
      ),
      'CHALLENGE_NOT_CURRENT'
    );
  });

  it('survives operational version advancement and continuous operational baseline revisions', () => {
    const seeded = seedAnsweredChallenge(2);
    const operational = advanceOperationally(
      seeded.answered,
      '2026-09-09T16:00:00.000Z'
    );
    const result = readChallengeEffectiveInvestigationAnalysis(
      connection.db,
      seeded.answered.caseId,
      seeded.gap.id,
      seeded.challenge.challengeRef
    );
    expect(result.analysisContext.currentCaseVersion).toBe(operational.caseVersion);
    expect(result.analysisContext.currentMaterialRevision).toBe(operational.materialRevision);
  });

  it('fails closed when an earlier cycle or an interrupted baseline exists', () => {
    const earlierCycle = seedAnsweredChallenge();
    connection.db.insert(schema.investigationChallenges).values({
      challengeRef: randomUUID(),
      caseId: earlierCycle.answered.caseId,
      questionRef: earlierCycle.gap.id,
      challengedRevisionId: earlierCycle.challenge.challengedRevisionId,
      challengedMaterialRevision: earlierCycle.challenge.challengedMaterialRevision + 100,
      openedCaseVersion: earlierCycle.challenge.openedCaseVersion - 1,
      triggerEvidenceRefsJson: JSON.stringify([earlierCycle.lateEvidenceRef]),
      openedByKind: 'HUMAN',
      openedByIdentifier: 'demo_operator',
      rationale: 'Earlier-cycle boundary fixture.',
      createdAt: '2026-09-09T13:30:00.000Z',
      demo: true
    }).run();
    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        earlierCycle.answered.caseId,
        earlierCycle.gap.id,
        earlierCycle.challenge.challengeRef
      ),
      'CHALLENGE_BASELINE_UNPROVEN'
    );

    connection.sqlite.close();
    connection = createDatabaseConnection(join(directory, 'broken.db'));
    migrate(connection.db, { migrationsFolder: resolve('drizzle') });
    seedDemoData(connection.db, fixtures);
    const interrupted = seedAnsweredChallenge(0, 2);
    const brokenVersion = interrupted.origin.caseVersion + 1;
    const row = connection.db.select().from(schema.caseRevisions)
      .where(and(
        eq(schema.caseRevisions.caseId, interrupted.answered.caseId),
        eq(schema.caseRevisions.caseVersion, brokenVersion)
      )).get();
    if (!row) throw new Error('Expected an intermediate baseline revision.');
    const broken = caseSnapshotSchema.parse({
      ...JSON.parse(row.snapshotJson),
      investigation: {
        ...JSON.parse(row.snapshotJson).investigation,
        gaps: []
      },
      uncertainties: []
    });
    connection.db.update(schema.caseRevisions).set({
      snapshotJson: JSON.stringify(broken)
    }).where(eq(schema.caseRevisions.id, row.id)).run();
    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        interrupted.answered.caseId,
        interrupted.gap.id,
        interrupted.challenge.challengeRef
      ),
      'CHALLENGE_BASELINE_UNPROVEN'
    );
  });

  it('includes baseline plus selected Challenge and excludes a later Challenge partition', () => {
    const seeded = seedAnsweredChallenge();
    const selectedClaim = challengeClaim(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge.challengeRef,
      [seeded.lateEvidenceRef],
      'MFT-24'
    );
    const other = seedLaterChallengeArtifacts(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge,
      seeded.baselineClaim.claimRef
    );

    const result = readChallengeEffectiveInvestigationAnalysis(
      connection.db,
      seeded.answered.caseId,
      seeded.gap.id,
      seeded.challenge.challengeRef
    );
    expect(result.projectionBasis.claimRefs).toEqual([
      seeded.baselineClaim.claimRef,
      selectedClaim.claimRef
    ].sort());
    expect(result.projectionBasis.claimRefs).not.toContain(other.claimRef);
    expect(result.projectionBasis.assessmentRefs).toEqual([
      seeded.baselineAssessment.assessmentRef
    ]);
    expect(result.projectionBasis.assessmentRefs).not.toContain(other.assessmentRef);
    expect(result.analysis.activeClaims.map((claim) => claim.value.lot)).toHaveLength(2);
    expect(result.analysis.activeClaims.map((claim) => claim.value.lot)).toEqual(
      expect.arrayContaining(['MFT24', 'MFT-24'])
    );
  });

  it('fails closed on bidirectional cross-partition Claim and Assessment supersession', () => {
    const seeded = seedAnsweredChallenge();
    const selectedClaim = challengeClaim(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge.challengeRef,
      [seeded.lateEvidenceRef]
    );
    const selectedAssessment = recordInvestigationAssessment(connection.db, {
      assessmentRef: randomUUID(),
      caseId: seeded.answered.caseId,
      questionRef: seeded.gap.id,
      challengeRef: seeded.challenge.challengeRef,
      expectedCaseVersion: seeded.answered.caseVersion,
      expectedMaterialRevision: seeded.answered.materialRevision!,
      verdict: 'SUPPORTED',
      targetClaimRef: selectedClaim.claimRef,
      evidenceRefs: [seeded.lateEvidenceRef],
      relatedClaimRefs: [],
      assessorKind: 'HUMAN',
      assessorIdentifier: null,
      ruleIdentifier: null,
      ruleVersion: null,
      rationale: 'Selected-Challenge review.',
      supersedesAssessmentRef: null,
      demo: true
    }, { mode: 'demo' }).assessment;
    const other = seedLaterChallengeArtifacts(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge,
      seeded.baselineClaim.claimRef
    );
    const read = () => readChallengeEffectiveInvestigationAnalysis(
      connection.db,
      seeded.answered.caseId,
      seeded.gap.id,
      seeded.challenge.challengeRef
    );

    connection.db.update(schema.investigationClaims).set({
      supersedesClaimRef: other.claimRef
    }).where(eq(schema.investigationClaims.claimRef, selectedClaim.claimRef)).run();
    expectAnalysisError(read, 'CHALLENGE_GRAPH_BOUNDARY_INVALID');
    connection.db.update(schema.investigationClaims).set({
      supersedesClaimRef: null
    }).where(eq(schema.investigationClaims.claimRef, selectedClaim.claimRef)).run();
    connection.db.update(schema.investigationClaims).set({
      supersedesClaimRef: seeded.baselineClaim.claimRef
    }).where(eq(schema.investigationClaims.claimRef, other.claimRef)).run();
    expectAnalysisError(read, 'CHALLENGE_GRAPH_BOUNDARY_INVALID');
    connection.db.update(schema.investigationClaims).set({
      supersedesClaimRef: null
    }).where(eq(schema.investigationClaims.claimRef, other.claimRef)).run();

    connection.db.update(schema.investigationAssessments).set({
      supersedesAssessmentRef: other.assessmentRef
    }).where(eq(
      schema.investigationAssessments.assessmentRef,
      selectedAssessment.assessmentRef
    )).run();
    expectAnalysisError(read, 'CHALLENGE_GRAPH_BOUNDARY_INVALID');
    connection.db.update(schema.investigationAssessments).set({
      supersedesAssessmentRef: null
    }).where(eq(
      schema.investigationAssessments.assessmentRef,
      selectedAssessment.assessmentRef
    )).run();
    connection.db.update(schema.investigationAssessments).set({
      supersedesAssessmentRef: seeded.baselineAssessment.assessmentRef
    }).where(eq(schema.investigationAssessments.assessmentRef, other.assessmentRef)).run();
    expectAnalysisError(read, 'CHALLENGE_GRAPH_BOUNDARY_INVALID');
  });

  it('preserves same-partition graph semantics and rejects excluded Claim dependencies', () => {
    const seeded = seedAnsweredChallenge();
    const first = challengeClaim(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge.challengeRef,
      [seeded.lateEvidenceRef]
    );
    const successor = challengeClaim(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge.challengeRef,
      [seeded.lateEvidenceRef],
      'MFT-25',
      first.claimRef
    );
    const other = seedLaterChallengeArtifacts(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge,
      seeded.baselineClaim.claimRef
    );
    let result = readChallengeEffectiveInvestigationAnalysis(
      connection.db,
      seeded.answered.caseId,
      seeded.gap.id,
      seeded.challenge.challengeRef
    );
    expect(result.analysis.inactiveClaimRefs).toContain(first.claimRef);
    expect(result.analysis.activeClaims.map((claim) => claim.claimRef)).toContain(successor.claimRef);

    const selectedAssessment = recordInvestigationAssessment(connection.db, {
      assessmentRef: randomUUID(),
      caseId: seeded.answered.caseId,
      questionRef: seeded.gap.id,
      challengeRef: seeded.challenge.challengeRef,
      expectedCaseVersion: seeded.answered.caseVersion,
      expectedMaterialRevision: seeded.answered.materialRevision!,
      verdict: 'SUPPORTED',
      targetClaimRef: successor.claimRef,
      evidenceRefs: [seeded.lateEvidenceRef],
      relatedClaimRefs: [],
      assessorKind: 'HUMAN',
      assessorIdentifier: null,
      ruleIdentifier: null,
      ruleVersion: null,
      rationale: 'Selected-Challenge review.',
      supersedesAssessmentRef: null,
      demo: true
    }, { mode: 'demo' }).assessment;
    connection.db.update(schema.investigationAssessments).set({
      targetClaimRef: other.claimRef
    }).where(eq(
      schema.investigationAssessments.assessmentRef,
      selectedAssessment.assessmentRef
    )).run();
    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        seeded.answered.caseId,
        seeded.gap.id,
        seeded.challenge.challengeRef
      ),
      'CHALLENGE_GRAPH_BOUNDARY_INVALID'
    );

    connection.db.update(schema.investigationAssessments).set({
      targetClaimRef: selectedAssessment.targetClaimRef
    }).where(eq(
      schema.investigationAssessments.assessmentRef,
      selectedAssessment.assessmentRef
    )).run();
    connection.db.update(schema.investigationAssessments).set({
      targetClaimRef: successor.claimRef
    }).where(eq(
      schema.investigationAssessments.assessmentRef,
      seeded.baselineAssessment.assessmentRef
    )).run();
    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        seeded.answered.caseId,
        seeded.gap.id,
        seeded.challenge.challengeRef
      ),
      'CHALLENGE_GRAPH_BOUNDARY_INVALID'
    );
  });

  it('retains INVALID_SUPERSESSION_GRAPH for a cycle inside the selected partition', () => {
    const seeded = seedAnsweredChallenge();
    const first = challengeClaim(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge.challengeRef,
      [seeded.lateEvidenceRef]
    );
    const second = challengeClaim(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge.challengeRef,
      [seeded.lateEvidenceRef],
      'MFT26',
      first.claimRef
    );
    connection.db.update(schema.investigationClaims).set({
      supersedesClaimRef: second.claimRef
    }).where(eq(schema.investigationClaims.claimRef, first.claimRef)).run();
    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        seeded.answered.caseId,
        seeded.gap.id,
        seeded.challenge.challengeRef
      ),
      'INVALID_SUPERSESSION_GRAPH'
    );
  });

  it('fails closed when included artifacts cross Evidence Challenge partitions', () => {
    const seeded = seedAnsweredChallenge();
    const selectedClaim = challengeClaim(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge.challengeRef,
      [seeded.lateEvidenceRef]
    );
    const other = seedLaterChallengeArtifacts(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge,
      seeded.baselineClaim.claimRef
    );
    connection.db.update(schema.investigationClaims).set({
      evidenceRefsJson: JSON.stringify([other.evidenceRef])
    }).where(eq(schema.investigationClaims.claimRef, selectedClaim.claimRef)).run();
    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        seeded.answered.caseId,
        seeded.gap.id,
        seeded.challenge.challengeRef
      ),
      'CHALLENGE_GRAPH_BOUNDARY_INVALID'
    );

    connection.db.update(schema.investigationClaims).set({
      evidenceRefsJson: JSON.stringify([seeded.lateEvidenceRef])
    }).where(eq(schema.investigationClaims.claimRef, selectedClaim.claimRef)).run();
    connection.db.update(schema.investigationClaims).set({
      evidenceRefsJson: JSON.stringify([other.evidenceRef])
    }).where(eq(
      schema.investigationClaims.claimRef,
      seeded.baselineClaim.claimRef
    )).run();
    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        seeded.answered.caseId,
        seeded.gap.id,
        seeded.challenge.challengeRef
      ),
      'CHALLENGE_GRAPH_BOUNDARY_INVALID'
    );
  });

  it('fails closed when an artifact association points to another Question', () => {
    const seeded = seedAnsweredChallenge();
    const selectedClaim = challengeClaim(
      seeded.answered,
      seeded.gap.id,
      seeded.challenge.challengeRef,
      [seeded.lateEvidenceRef]
    );
    const wrongQuestionRef = 'demo:scope-gap:wrong-question-association';
    connection.db.insert(schema.investigationQuestions).values({
      questionRef: wrongQuestionRef,
      caseId: seeded.answered.caseId,
      subjectRef: seeded.answered.productId,
      questionType: 'AFFECTED_BATCH_LOT',
      originCaseVersion: seeded.origin.caseVersion,
      originMaterialRevision: seeded.origin.materialRevision!,
      createdAt: seeded.origin.updatedAt,
      demo: true
    }).run();
    const wrongChallengeRef = randomUUID();
    connection.db.insert(schema.investigationChallenges).values({
      challengeRef: wrongChallengeRef,
      caseId: seeded.answered.caseId,
      questionRef: wrongQuestionRef,
      challengedRevisionId: seeded.challenge.challengedRevisionId,
      challengedMaterialRevision: seeded.challenge.challengedMaterialRevision + 100,
      openedCaseVersion: seeded.challenge.openedCaseVersion + 1,
      triggerEvidenceRefsJson: JSON.stringify(seeded.challenge.triggerEvidenceRefs),
      openedByKind: 'HUMAN',
      openedByIdentifier: 'demo_operator',
      rationale: 'Wrong-Question association fixture.',
      createdAt: '2026-09-09T15:00:00.000Z',
      demo: true
    }).run();
    connection.db.update(schema.investigationChallengeClaims).set({
      challengeRef: wrongChallengeRef
    }).where(eq(schema.investigationChallengeClaims.claimRef, selectedClaim.claimRef)).run();

    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        seeded.answered.caseId,
        seeded.gap.id,
        seeded.challenge.challengeRef
      ),
      'CHALLENGE_GRAPH_BOUNDARY_INVALID'
    );
  });

  it('fails closed when the selected Challenge hides a cross-Question artifact', () => {
    const seeded = seedAnsweredChallenge();
    const wrongQuestionRef = 'demo:scope-gap:hidden-cross-question-artifact';
    connection.db.insert(schema.investigationQuestions).values({
      questionRef: wrongQuestionRef,
      caseId: seeded.answered.caseId,
      subjectRef: seeded.answered.productId,
      questionType: 'AFFECTED_BATCH_LOT',
      originCaseVersion: seeded.origin.caseVersion,
      originMaterialRevision: seeded.origin.materialRevision!,
      createdAt: seeded.origin.updatedAt,
      demo: true
    }).run();
    const hiddenClaimRef = randomUUID();
    connection.db.insert(schema.investigationClaims).values({
      claimRef: hiddenClaimRef,
      caseId: seeded.answered.caseId,
      questionRef: wrongQuestionRef,
      subjectRef: seeded.answered.productId,
      claimType: 'AFFECTED_BATCH_LOT',
      valueJson: JSON.stringify({ lot: 'MFT99' }),
      evidenceRefsJson: JSON.stringify([seeded.lateEvidenceRef]),
      originKind: 'HUMAN_OBSERVED',
      producerIdentifier: 'demo_operator',
      derivationMetadataJson: null,
      supersedesClaimRef: null,
      createdAt: '2026-09-09T15:00:00.000Z',
      demo: true
    }).run();
    connection.db.insert(schema.investigationChallengeClaims).values({
      claimRef: hiddenClaimRef,
      challengeRef: seeded.challenge.challengeRef
    }).run();

    expectAnalysisError(
      () => readChallengeEffectiveInvestigationAnalysis(
        connection.db,
        seeded.answered.caseId,
        seeded.gap.id,
        seeded.challenge.challengeRef
      ),
      'CHALLENGE_GRAPH_BOUNDARY_INVALID'
    );
  });

  it('allows projection while CLOSED without reopening or changing lifecycle state', () => {
    const seeded = seedAnsweredChallenge();
    const closed = makeClosed(seeded.answered);
    persistSnapshot(closed);
    const before = readCaseSnapshot(connection.db, closed.caseId);
    const commandsBefore = tableCount(schema.caseCommands);
    const result = readChallengeEffectiveInvestigationAnalysis(
      connection.db,
      closed.caseId,
      seeded.gap.id,
      seeded.challenge.challengeRef
    );
    expect(result.analysisContext.currentCaseVersion).toBe(closed.caseVersion);
    expect(readCaseSnapshot(connection.db, closed.caseId)).toEqual(before);
    expect(readCaseSnapshot(connection.db, closed.caseId)?.stage).toBe('CLOSED');
    expect(tableCount(schema.caseCommands)).toBe(commandsBefore);
  });
});
