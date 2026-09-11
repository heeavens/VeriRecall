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

import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { caseSnapshotSchema, type CaseSnapshot } from '../../contracts/recall';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { clearDemoData, seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import {
  batchContradictionRule,
  demoHumanAssessorIdentifier,
  recordInvestigationAssessment,
  type InvestigationAssessment
} from './assessments';
import {
  demoChallengeBatchEstablishmentPolicy,
  demoInheritedChallengeBatchEstablishmentPolicy,
  evaluateCurrentInvestigationChallengeBatchEstablishment,
  evaluateCurrentInvestigationChallengeBatchEstablishmentInTransaction,
  evaluateDemoChallengeBatchEstablishmentPolicy,
  getInvestigationChallengeBatchEstablishment,
  InvestigationChallengeBatchEstablishmentError,
  recordInvestigationChallengeBatchEstablishment
} from './challenge-batch-establishments';
import {
  challengeBatchApplicationBasisFormatVersion,
  challengeBatchApplicationPolicy,
  inheritedChallengeBatchApplicationBasisFormatVersion,
  readChallengeBatchApplicationBasis
} from './challenge-batch-application-basis';
import {
  resolveAuthoritativeChallengeBaseline,
  type AppliedChallengeBatchBaseline
} from './authoritative-challenge-baseline';
import {
  applyInvestigationChallengeBatch,
  getInvestigationChallengeBatchApplication,
  InvestigationChallengeBatchApplicationError
} from './challenge-batch-applications';
import {
  getInvestigationAssessmentChallengeRef,
  getInvestigationClaimChallengeRef
} from './challenge-artifacts';
import { getInvestigationChallenge, openInvestigationChallenge } from './challenges';
import {
  applyInvestigationChallengeConflict,
  InvestigationChallengeConflictApplicationError
} from './challenge-conflict-applications';
import {
  inheritedChallengeConflictApplicationBasisFormatVersion,
  inheritedChallengeConflictApplicationPolicy,
  readChallengeConflictApplicationBasis
} from './challenge-conflict-basis';
import { recordInvestigationClaim, type InvestigationClaim } from './claims';
import { readChallengeEffectiveInvestigationAnalysis } from './effective-analysis';
import {
  applyInvestigationEstablishedBatch
} from './established-batch-applications';
import { readEstablishedBatchApplicationBasis } from './established-batch-application-basis';
import { recordInvestigationEstablishment } from './establishments';
import {
  listInvestigationEvidence,
  recordInvestigationEvidence,
  type InvestigationEvidence
} from './evidence-registry';
import { requestInvestigationEvidence } from './evidence-requests';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const fixtures = loadDemoFixtures();
const matchId = '50000000-0000-4000-8000-000000000002';
const context = { mode: 'demo' as const };
let directory: string;
let connection: TestConnection;
let sequence: number;

function nextDate(): Date {
  sequence += 1;
  return new Date(Date.UTC(2026, 8, 11, 10, 0, sequence));
}

function recordEvidence(
  snapshot: CaseSnapshot,
  questionRef: string,
  evidenceRef: string,
  sourceKind: 'INTERNAL' | 'EXTERNAL_PARTY' | 'REGULATOR',
  lot: string,
  options: { requestId?: string; at?: Date } = {}
): InvestigationEvidence {
  return recordInvestigationEvidence(connection.db, {
    evidenceRef,
    caseId: snapshot.caseId,
    questionRef,
    evidenceRequestId: options.requestId ?? null,
    sourceKind,
    sourceIdentifier: `${sourceKind.toLowerCase()}:${evidenceRef}`,
    validAsOf: null,
    contentKind: 'STRUCTURED',
    contentJson: { lot, evidenceRef },
    contentLocator: null,
    demo: true
  }, options.at ?? nextDate()).evidence;
}

function recordOpenGapClaim(
  snapshot: CaseSnapshot,
  questionRef: string,
  evidenceRefs: string[],
  lot: string
): InvestigationClaim {
  return recordInvestigationClaim(connection.db, {
    claimRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    claimType: 'AFFECTED_BATCH_LOT',
    value: { lot },
    evidenceRefs,
    originKind: 'DETERMINISTIC_EXTRACTED',
    producerIdentifier: 'demo-batch-parser:v1',
    derivationMetadata: null,
    supersedesClaimRef: null,
    demo: true
  }, context, nextDate()).claim;
}

function recordOpenGapSupport(
  snapshot: CaseSnapshot,
  questionRef: string,
  claimRef: string,
  evidenceRefs: string[]
): InvestigationAssessment {
  return recordInvestigationAssessment(connection.db, {
    assessmentRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    verdict: 'SUPPORTED',
    targetClaimRef: claimRef,
    evidenceRefs,
    relatedClaimRefs: [],
    assessorKind: 'HUMAN',
    assessorIdentifier: null,
    ruleIdentifier: null,
    ruleVersion: null,
    rationale: 'Reviewed the complete initial dual-source evidence basis.',
    supersedesAssessmentRef: null,
    demo: true
  }, context, nextDate()).assessment;
}

interface SeedChallengeOptions {
  targetLot?: string;
  targetOrigin?: 'DETERMINISTIC_EXTRACTED' | 'AI_PROPOSED' | 'HUMAN_OBSERVED';
  targetEvidenceRefs?: (seed: BaseChallengeSeed) => string[];
  withSupport?: boolean;
  supportKind?: 'HUMAN' | 'RULE' | 'AI';
  supportEvidenceRefs?: (seed: BaseChallengeSeed) => string[];
}

interface BaseChallengeSeed {
  gapSnapshot: CaseSnapshot;
  knownSnapshot: CaseSnapshot;
  questionRef: string;
  internal: InvestigationEvidence;
  external: InvestigationEvidence;
  late: InvestigationEvidence;
  baselineClaim: InvestigationClaim;
  challengeRef: string;
}

function seedBaseChallenge(): BaseChallengeSeed {
  const match = fixtures.matches.find((candidate) => candidate.id === matchId);
  const product = fixtures.products.find((candidate) => candidate.id === match?.productId);
  if (!match || !product?.ean) throw new Error('Expected a batch-gap demo match.');
  connection.db.update(schema.alerts).set({ ean: product.ean })
    .where(eq(schema.alerts.id, match.alertId)).run();
  connection.db.update(schema.matches).set({ hasHardConflict: false })
    .where(eq(schema.matches.id, matchId)).run();
  const confirmed = confirmReviewMatch(
    connection.db,
    { matchId, actorName: demoHumanAssessorIdentifier },
    nextDate(),
    context
  );
  const gapSnapshot = readCaseSnapshot(connection.db, confirmed.caseId);
  const questionRef = gapSnapshot?.investigation?.gaps.find(
    (issue) => issue.code === 'BATCH_MISSING'
  )?.id;
  if (!gapSnapshot?.investigation || gapSnapshot.materialRevision === null || !questionRef) {
    throw new Error('Expected current BATCH_MISSING state.');
  }

  const internal = recordEvidence(
    gapSnapshot,
    questionRef,
    'evidence:challenge-establishment:internal',
    'INTERNAL',
    'MFT24'
  );
  const external = recordEvidence(
    gapSnapshot,
    questionRef,
    'evidence:challenge-establishment:external',
    'EXTERNAL_PARTY',
    'MFT24'
  );
  const initialEvidenceRefs = [internal.evidenceRef, external.evidenceRef];
  const baselineClaim = recordOpenGapClaim(
    gapSnapshot,
    questionRef,
    initialEvidenceRefs,
    'MFT24'
  );
  recordOpenGapSupport(gapSnapshot, questionRef, baselineClaim.claimRef, initialEvidenceRefs);
  const establishment = recordInvestigationEstablishment(connection.db, {
    establishmentRef: randomUUID(),
    caseId: gapSnapshot.caseId,
    questionRef,
    claimRef: baselineClaim.claimRef,
    expectedCaseVersion: gapSnapshot.caseVersion,
    expectedMaterialRevision: gapSnapshot.materialRevision,
    demo: true
  }, context, nextDate()).establishment;
  const basis = readEstablishedBatchApplicationBasis(
    connection.db,
    gapSnapshot.caseId,
    questionRef,
    establishment.establishmentRef
  );
  const knownSnapshot = applyInvestigationEstablishedBatch(connection.db, {
    applicationRef: randomUUID(),
    caseId: gapSnapshot.caseId,
    questionRef,
    establishmentRef: establishment.establishmentRef,
    expectedCaseVersion: gapSnapshot.caseVersion,
    expectedMaterialRevision: gapSnapshot.materialRevision,
    expectedApplicationBasisDigest: basis.applicationBasisDigest,
    rationale: 'Reviewed the initial established batch basis.',
    demo: true
  }, context, nextDate()).snapshot;

  const late = recordEvidence(
    knownSnapshot,
    questionRef,
    'evidence:challenge-establishment:late',
    'REGULATOR',
    'MFT25',
    { at: nextDate() }
  );
  const challenge = openInvestigationChallenge(connection.db, {
    challengeRef: randomUUID(),
    caseId: knownSnapshot.caseId,
    questionRef,
    expectedCaseVersion: knownSnapshot.caseVersion,
    expectedMaterialRevision: knownSnapshot.materialRevision!,
    triggerEvidenceRefs: [late.evidenceRef],
    rationale: 'Late evidence requires positive batch re-evaluation.',
    demo: true
  }, context, nextDate()).challenge;

  return {
    gapSnapshot,
    knownSnapshot,
    questionRef,
    internal,
    external,
    late,
    baselineClaim,
    challengeRef: challenge.challengeRef
  };
}

function recordChallengeClaim(
  seed: BaseChallengeSeed,
  lot: string,
  options: {
    claimRef?: string;
    originKind?: 'DETERMINISTIC_EXTRACTED' | 'AI_PROPOSED' | 'HUMAN_OBSERVED';
    evidenceRefs?: string[];
    supersedesClaimRef?: string | null;
  } = {}
): InvestigationClaim {
  return recordInvestigationClaim(connection.db, {
    claimRef: options.claimRef ?? randomUUID(),
    caseId: seed.knownSnapshot.caseId,
    questionRef: seed.questionRef,
    challengeRef: seed.challengeRef,
    expectedCaseVersion: seed.knownSnapshot.caseVersion,
    expectedMaterialRevision: seed.knownSnapshot.materialRevision!,
    claimType: 'AFFECTED_BATCH_LOT',
    value: { lot },
    evidenceRefs: options.evidenceRefs ?? [seed.internal.evidenceRef, seed.late.evidenceRef],
    originKind: options.originKind ?? 'DETERMINISTIC_EXTRACTED',
    producerIdentifier: 'demo-challenge-batch-parser:v1',
    derivationMetadata: null,
    supersedesClaimRef: options.supersedesClaimRef ?? null,
    demo: true
  }, context, nextDate()).claim;
}

function recordChallengeAssessment(
  seed: BaseChallengeSeed,
  input: {
    verdict: 'SUPPORTED' | 'INSUFFICIENT' | 'REJECTED' | 'CONTRADICTED';
    targetClaimRef: string | null;
    relatedClaimRefs?: string[];
    evidenceRefs?: string[];
    assessorKind?: 'HUMAN' | 'RULE' | 'AI';
    supersedesAssessmentRef?: string | null;
  }
): InvestigationAssessment {
  const assessorKind = input.assessorKind ?? 'HUMAN';
  const isHuman = assessorKind === 'HUMAN';
  const isContradiction = input.verdict === 'CONTRADICTED';
  return recordInvestigationAssessment(connection.db, {
    assessmentRef: randomUUID(),
    caseId: seed.knownSnapshot.caseId,
    questionRef: seed.questionRef,
    challengeRef: seed.challengeRef,
    expectedCaseVersion: seed.knownSnapshot.caseVersion,
    expectedMaterialRevision: seed.knownSnapshot.materialRevision!,
    verdict: input.verdict,
    targetClaimRef: input.targetClaimRef,
    evidenceRefs: input.evidenceRefs ?? completeEvidenceRefs(seed),
    relatedClaimRefs: input.relatedClaimRefs ?? [],
    assessorKind,
    assessorIdentifier: isHuman ? null : `demo-${assessorKind.toLowerCase()}-reviewer`,
    ruleIdentifier: isContradiction
      ? batchContradictionRule.identifier
      : isHuman ? null : 'demo-challenge-batch-review',
    ruleVersion: isContradiction
      ? batchContradictionRule.version
      : isHuman ? null : 'v1',
    rationale: 'Reviewed the complete current Challenge batch basis.',
    supersedesAssessmentRef: input.supersedesAssessmentRef ?? null,
    demo: true
  }, context, nextDate()).assessment;
}

function completeEvidenceRefs(seed: BaseChallengeSeed): string[] {
  return [seed.external.evidenceRef, seed.internal.evidenceRef, seed.late.evidenceRef].sort();
}

function seedPositiveChallenge(options: SeedChallengeOptions = {}) {
  const seed = seedBaseChallenge();
  const targetClaim = recordChallengeClaim(
    seed,
    options.targetLot ?? ' mft-24 ',
    {
      originKind: options.targetOrigin,
      evidenceRefs: options.targetEvidenceRefs?.(seed)
    }
  );
  let support: InvestigationAssessment | null = null;
  if (options.withSupport !== false) {
    support = recordChallengeAssessment(seed, {
      verdict: 'SUPPORTED',
      targetClaimRef: targetClaim.claimRef,
      evidenceRefs: options.supportEvidenceRefs?.(seed),
      assessorKind: options.supportKind ?? 'HUMAN'
    });
  }
  return { ...seed, targetClaim, support };
}

function recordInput(seed: ReturnType<typeof seedPositiveChallenge>) {
  return {
    establishmentRef: randomUUID(),
    caseId: seed.knownSnapshot.caseId,
    questionRef: seed.questionRef,
    challengeRef: seed.challengeRef,
    claimRef: seed.targetClaim.claimRef,
    expectedCaseVersion: seed.knownSnapshot.caseVersion,
    expectedMaterialRevision: seed.knownSnapshot.materialRevision!,
    demo: true as const
  };
}

function expectChallengeEstablishmentError(
  action: () => unknown,
  code: InvestigationChallengeBatchEstablishmentError['code'],
  blocker?: string
): void {
  try {
    action();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationChallengeBatchEstablishmentError);
    expect((error as InvestigationChallengeBatchEstablishmentError).code).toBe(code);
    if (blocker) {
      expect((error as InvestigationChallengeBatchEstablishmentError).blockerCodes)
        .toContain(blocker);
    }
  }
}

function policyInput(seed: ReturnType<typeof seedPositiveChallenge>) {
  const projection = readChallengeEffectiveInvestigationAnalysis(
    connection.db,
    seed.knownSnapshot.caseId,
    seed.questionRef,
    seed.challengeRef
  );
  return {
    snapshot: readCaseSnapshot(connection.db, seed.knownSnapshot.caseId)!,
    projection,
    evidence: listInvestigationEvidence(
      connection.db,
      seed.knownSnapshot.caseId,
      seed.questionRef
    ),
    targetClaimRef: seed.targetClaim.claimRef,
    claimChallengeRef: getInvestigationClaimChallengeRef(
      connection.db,
      seed.targetClaim.claimRef
    ),
    claimChallengeRefs: new Map(
      projection.analysis.activeClaims.map((claim) => [
        claim.claimRef,
        getInvestigationClaimChallengeRef(connection.db, claim.claimRef)
      ])
    ),
    assessmentChallengeRefs: new Map(
      projection.analysis.structuralAssessmentHeads.map((assessment) => [
        assessment.assessmentRef,
        getInvestigationAssessmentChallengeRef(connection.db, assessment.assessmentRef)
      ])
    )
  };
}

function protectedState(caseId: string) {
  const snapshot = readCaseSnapshot(connection.db, caseId);
  return {
    caseRow: connection.db.select().from(schema.cases)
      .where(eq(schema.cases.id, caseId)).get(),
    snapshot,
    lifecycle: connection.db.select().from(schema.caseLifecycle)
      .where(eq(schema.caseLifecycle.caseId, caseId)).all(),
    revisions: connection.db.select().from(schema.caseRevisions)
      .where(eq(schema.caseRevisions.caseId, caseId)).all(),
    commands: connection.db.select().from(schema.caseCommands)
      .where(eq(schema.caseCommands.caseId, caseId)).all(),
    positiveApplications: connection.db.select()
      .from(schema.investigationChallengeBatchApplications)
      .where(eq(schema.investigationChallengeBatchApplications.caseId, caseId)).all(),
    conflictApplications: connection.db.select()
      .from(schema.investigationChallengeConflictApplications)
      .where(eq(schema.investigationChallengeConflictApplications.caseId, caseId)).all(),
    decisions: snapshot?.decisions,
    tasks: snapshot?.tasks,
    exposure: snapshot?.exposure,
    closure: snapshot?.closure,
    questions: connection.db.select().from(schema.investigationQuestions)
      .where(eq(schema.investigationQuestions.caseId, caseId)).all(),
    challenges: connection.db.select().from(schema.investigationChallenges)
      .where(eq(schema.investigationChallenges.caseId, caseId)).all(),
    evidence: connection.db.select().from(schema.investigationEvidence)
      .where(eq(schema.investigationEvidence.caseId, caseId)).all(),
    claims: connection.db.select().from(schema.investigationClaims)
      .where(eq(schema.investigationClaims.caseId, caseId)).all(),
    assessments: connection.db.select().from(schema.investigationAssessments)
      .where(eq(schema.investigationAssessments.caseId, caseId)).all(),
    traceability: connection.db.select().from(schema.traceabilityRecords)
      .where(eq(schema.traceabilityRecords.caseId, caseId)).all()
  };
}

function advanceMaterially(snapshot: CaseSnapshot): CaseSnapshot {
  if (!snapshot.investigation || snapshot.materialRevision === null) {
    throw new Error('Expected material investigation state.');
  }
  const at = nextDate().toISOString();
  const materialRevision = snapshot.materialRevision + 1;
  const advanced = caseSnapshotSchema.parse({
    ...snapshot,
    caseVersion: snapshot.caseVersion + 1,
    materialRevision,
    updatedAt: at,
    investigation: {
      ...snapshot.investigation,
      materialRevision,
      updatedAt: at
    }
  });
  connection.db.update(schema.caseLifecycle).set({
    caseVersion: advanced.caseVersion,
    materialRevision,
    snapshotJson: JSON.stringify(advanced),
    updatedAt: at
  }).where(eq(schema.caseLifecycle.caseId, advanced.caseId)).run();
  connection.db.insert(schema.caseRevisions).values({
    id: randomUUID(),
    caseId: advanced.caseId,
    caseVersion: advanced.caseVersion,
    materialRevision,
    snapshotJson: JSON.stringify(advanced),
    actorId: 'test_fixture',
    createdAt: at
  }).run();
  return advanced;
}

function closePositiveChallengeFixture(current: CaseSnapshot): CaseSnapshot {
  if (!current.investigation || current.materialRevision === null) {
    throw new Error('Expected known Challenge investigation state.');
  }
  const closedAt = nextDate().toISOString();
  const knownZero = {
    value: 0,
    unit: 'ITEM' as const,
    knowledgeStatus: 'KNOWN' as const,
    sources: [{
      sourceRef: 'demo:positive-challenge:closed-source',
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
    consequence: 'Trusted demo operator reviewed the known scope.',
    rationale: 'Closed positive-Challenge fixture.',
    actorId: demoHumanAssessorIdentifier,
    actorRole: 'CASE_MANAGER' as const,
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
  connection.db.update(schema.caseLifecycle).set({
    caseVersion: closed.caseVersion,
    materialRevision: closed.materialRevision,
    snapshotJson: JSON.stringify(closed),
    updatedAt: closed.updatedAt
  }).where(eq(schema.caseLifecycle.caseId, closed.caseId)).run();
  connection.db.insert(schema.caseRevisions).values({
    id: randomUUID(),
    caseId: closed.caseId,
    caseVersion: closed.caseVersion,
    materialRevision: closed.materialRevision,
    snapshotJson: JSON.stringify(closed),
    actorId: 'test_fixture',
    createdAt: closed.updatedAt
  }).run();
  return closed;
}

function advanceOperationally(snapshot: CaseSnapshot): CaseSnapshot {
  const at = nextDate().toISOString();
  const advanced = caseSnapshotSchema.parse({
    ...snapshot,
    caseVersion: snapshot.caseVersion + 1,
    updatedAt: at
  });
  connection.db.update(schema.caseLifecycle).set({
    caseVersion: advanced.caseVersion,
    materialRevision: advanced.materialRevision,
    snapshotJson: JSON.stringify(advanced),
    updatedAt: at
  }).where(eq(schema.caseLifecycle.caseId, advanced.caseId)).run();
  connection.db.insert(schema.caseRevisions).values({
    id: randomUUID(),
    caseId: advanced.caseId,
    caseVersion: advanced.caseVersion,
    materialRevision: advanced.materialRevision,
    snapshotJson: JSON.stringify(advanced),
    actorId: 'test_fixture',
    createdAt: at
  }).run();
  return advanced;
}

function resetTestDatabase(): void {
  if (connection) connection.sqlite.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  sequence = 0;
  directory = mkdtempSync(join(tmpdir(), 'verirecall-challenge-batch-establishment-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
}

beforeEach(resetTestDatabase);

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('Challenge batch Establishment policy', () => {
  it('records a canonical non-authoritative reaffirmation with exact association and replay', () => {
    const seed = seedPositiveChallenge();
    const input = recordInput(seed);
    const before = protectedState(seed.knownSnapshot.caseId);
    const auditBefore = connection.db.select().from(schema.auditEvents).all().length;
    const result = recordInvestigationChallengeBatchEstablishment(
      connection.db,
      input,
      context,
      nextDate()
    );

    expect(result).toMatchObject({ replayed: false, challengeRef: seed.challengeRef });
    expect(result.establishment).toMatchObject({
      policyIdentifier: demoChallengeBatchEstablishmentPolicy.policyIdentifier,
      policyVersion: demoChallengeBatchEstablishmentPolicy.policyVersion,
      evaluatorKind: 'RULE',
      evaluatorIdentifier: demoChallengeBatchEstablishmentPolicy.evaluatorIdentifier,
      claimRef: seed.targetClaim.claimRef,
      basisMaterialRevision: seed.knownSnapshot.materialRevision
    });
    expect(result.establishment.basisClaimRefs).toEqual([
      seed.baselineClaim.claimRef,
      seed.targetClaim.claimRef
    ].sort());
    expect(result.establishment.basisAssessmentRefs).toContain(seed.support!.assessmentRef);
    expect(result.establishment.basisEvidenceRefs).toEqual(completeEvidenceRefs(seed));
    expect(connection.db.select().from(schema.investigationChallengeEstablishments).all())
      .toEqual([{ establishmentRef: input.establishmentRef, challengeRef: seed.challengeRef }]);
    expect(protectedState(seed.knownSnapshot.caseId)).toEqual(before);
    expect(connection.db.select().from(schema.auditEvents).all().length).toBe(auditBefore + 1);
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(connection.db, {
        ...input,
        claimRef: seed.baselineClaim.claimRef
      }, context),
      'ESTABLISHMENT_CONFLICT'
    );

    const replay = recordInvestigationChallengeBatchEstablishment(
      connection.db,
      { ...input, expectedCaseVersion: 999, expectedMaterialRevision: 999 },
      context
    );
    expect(replay).toMatchObject({ replayed: true, challengeRef: seed.challengeRef });
    expect(connection.db.select().from(schema.investigationEstablishments).where(eq(
      schema.investigationEstablishments.establishmentRef,
      input.establishmentRef
    )).all()).toHaveLength(1);
    expect(connection.db.select().from(schema.investigationChallengeEstablishments).all())
      .toHaveLength(1);
    expect(connection.db.select().from(schema.auditEvents).all().length).toBe(auditBefore + 1);
  });

  it('supports replacement only when every divergent active Claim has current trusted rejection', () => {
    const seed = seedPositiveChallenge({ targetLot: 'MFT25' });
    const input = recordInput(seed);
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(connection.db, input, context),
      'POLICY_NOT_SATISFIED',
      'DIVERGENT_ACTIVE_CLAIM_NOT_REJECTED'
    );

    const rejection = recordChallengeAssessment(seed, {
      verdict: 'REJECTED',
      targetClaimRef: seed.baselineClaim.claimRef,
      assessorKind: 'RULE'
    });
    const applied = recordInvestigationChallengeBatchEstablishment(
      connection.db,
      input,
      context
    );
    expect(applied.establishment.basisClaimRefs).toEqual([
      seed.baselineClaim.claimRef,
      seed.targetClaim.claimRef
    ].sort());
    expect(applied.establishment.basisAssessmentRefs).toEqual(expect.arrayContaining([
      seed.support!.assessmentRef,
      rejection.assessmentRef
    ]));
  });

  it('does not let AI support or rejection satisfy the positive policy', () => {
    const aiSupport = seedPositiveChallenge({ supportKind: 'AI' });
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(
        connection.db,
        recordInput(aiSupport),
        context
      ),
      'POLICY_NOT_SATISFIED',
      'HUMAN_SUPPORT_MISSING'
    );

    resetTestDatabase();
    const aiRejection = seedPositiveChallenge({ targetLot: 'MFT25' });
    recordChallengeAssessment(aiRejection, {
      verdict: 'REJECTED',
      targetClaimRef: aiRejection.baselineClaim.claimRef,
      assessorKind: 'AI'
    });
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(
        connection.db,
        recordInput(aiRejection),
        context
      ),
      'POLICY_NOT_SATISFIED',
      'DIVERGENT_ACTIVE_CLAIM_NOT_REJECTED'
    );
  });

  it('requires complete HUMAN support and preserves Commit 9 source diversity semantics', () => {
    const incomplete = seedPositiveChallenge({
      supportEvidenceRefs: (seed) => [seed.internal.evidenceRef, seed.late.evidenceRef]
    });
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(
        connection.db,
        recordInput(incomplete),
        context
      ),
      'POLICY_NOT_SATISFIED',
      'HUMAN_SUPPORT_INCOMPLETE'
    );

    resetTestDatabase();
    const noInternal = seedPositiveChallenge({
      targetEvidenceRefs: (seed) => [seed.external.evidenceRef, seed.late.evidenceRef]
    });
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(
        connection.db,
        recordInput(noInternal),
        context
      ),
      'POLICY_NOT_SATISFIED',
      'SOURCE_CLASS_COMBINATION_MISSING'
    );

    resetTestDatabase();
    const staleSupport = seedPositiveChallenge();
    const staleInput = policyInput(staleSupport);
    expect(evaluateDemoChallengeBatchEstablishmentPolicy({
      ...staleInput,
      projection: {
        ...staleInput.projection,
        analysis: {
          ...staleInput.projection.analysis,
          materiallyCurrentAssessmentHeads:
            staleInput.projection.analysis.materiallyCurrentAssessmentHeads.filter(
              (assessment) => assessment.assessmentRef !== staleSupport.support!.assessmentRef
            )
        }
      }
    }).blockerCodes).toContain('HUMAN_SUPPORT_NOT_CURRENT');
  });

  it('blocks target rejection, insufficiency, contradiction, and ambiguity', () => {
    const rejected = seedPositiveChallenge();
    recordChallengeAssessment(rejected, {
      verdict: 'REJECTED',
      targetClaimRef: rejected.targetClaim.claimRef
    });
    expect(evaluateDemoChallengeBatchEstablishmentPolicy(
      policyInput(rejected)
    ).blockerCodes).toContain('ANALYSIS_AMBIGUOUS');
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(
        connection.db,
        recordInput(rejected),
        context
      ),
      'POLICY_NOT_SATISFIED',
      'TARGET_REJECTED'
    );

    resetTestDatabase();
    const insufficient = seedPositiveChallenge();
    recordChallengeAssessment(insufficient, {
      verdict: 'INSUFFICIENT',
      targetClaimRef: null
    });
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(
        connection.db,
        recordInput(insufficient),
        context
      ),
      'POLICY_NOT_SATISFIED',
      'QUESTION_INSUFFICIENT'
    );

    resetTestDatabase();
    const claimInsufficient = seedPositiveChallenge();
    recordChallengeAssessment(claimInsufficient, {
      verdict: 'INSUFFICIENT',
      targetClaimRef: claimInsufficient.targetClaim.claimRef
    });
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(
        connection.db,
        recordInput(claimInsufficient),
        context
      ),
      'POLICY_NOT_SATISFIED',
      'ACTIVE_CLAIM_INSUFFICIENT'
    );

    resetTestDatabase();
    const contradicted = seedPositiveChallenge({ targetLot: 'MFT25' });
    recordChallengeAssessment(contradicted, {
      verdict: 'CONTRADICTED',
      targetClaimRef: null,
      relatedClaimRefs: [contradicted.baselineClaim.claimRef, contradicted.targetClaim.claimRef],
      assessorKind: 'RULE'
    });
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(
        connection.db,
        recordInput(contradicted),
        context
      ),
      'POLICY_NOT_SATISFIED',
      'ACTIVE_CONTRADICTION'
    );
  });

  it('rejects baseline, AI, inactive, empty-normalized, and wrong-partition targets', () => {
    const baseline = seedPositiveChallenge();
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(connection.db, {
        ...recordInput(baseline),
        claimRef: baseline.baselineClaim.claimRef
      }, context),
      'POLICY_NOT_SATISFIED',
      'TARGET_NOT_SELECTED_CHALLENGE'
    );

    resetTestDatabase();
    const ai = seedPositiveChallenge({ targetOrigin: 'AI_PROPOSED' });
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(connection.db, recordInput(ai), context),
      'POLICY_NOT_SATISFIED',
      'AI_TARGET_UNSUPPORTED'
    );

    resetTestDatabase();
    const inactive = seedPositiveChallenge();
    recordChallengeClaim(inactive, 'MFT24', {
      supersedesClaimRef: inactive.targetClaim.claimRef
    });
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(
        connection.db,
        recordInput(inactive),
        context
      ),
      'POLICY_NOT_SATISFIED',
      'TARGET_NOT_ACTIVE'
    );

    resetTestDatabase();
    const empty = seedPositiveChallenge({ targetLot: '---' });
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(
        connection.db,
        recordInput(empty),
        context
      ),
      'POLICY_NOT_SATISFIED',
      'LOT_EMPTY'
    );

    resetTestDatabase();
    const wrongPartition = seedPositiveChallenge();
    const direct = policyInput(wrongPartition);
    expect(evaluateDemoChallengeBatchEstablishmentPolicy({
      ...direct,
      claimChallengeRef: randomUUID()
    }).blockerCodes).toContain('TARGET_NOT_SELECTED_CHALLENGE');

    const noAuthoritativeBaseline = new Map(direct.claimChallengeRefs);
    noAuthoritativeBaseline.set(
      wrongPartition.baselineClaim.claimRef,
      wrongPartition.challengeRef
    );
    expect(evaluateDemoChallengeBatchEstablishmentPolicy({
      ...direct,
      claimChallengeRefs: noAuthoritativeBaseline
    }).blockerCodes).toContain('AUTHORITATIVE_BATCH_CLAIM_MISSING');
  });

  it('requires exact current Challenge ownership and fresh versions for NEW records', () => {
    const seed = seedPositiveChallenge();
    const input = recordInput(seed);
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(connection.db, {
        ...input,
        expectedCaseVersion: input.expectedCaseVersion - 1
      }, context),
      'STALE_CASE_VERSION'
    );
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(connection.db, {
        ...input,
        expectedMaterialRevision: input.expectedMaterialRevision - 1
      }, context),
      'STALE_MATERIAL_REVISION'
    );
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(connection.db, {
        ...input,
        challengeRef: randomUUID()
      }, context),
      'CHALLENGE_NOT_FOUND'
    );
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(connection.db, {
        ...input,
        questionRef: 'different:question'
      }, context),
      'QUESTION_OWNERSHIP_MISMATCH'
    );
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(connection.db, input, {
        mode: 'disabled'
      }),
      'FORBIDDEN'
    );
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(connection.db, {
        ...input,
        callerLot: 'MFT99'
      }, context),
      'INVALID_INPUT'
    );
  });

  it('supports Challenge-request Evidence and direct late Evidence without owning Evidence', () => {
    const seed = seedBaseChallenge();
    const requestId = randomUUID();
    requestInvestigationEvidence(connection.db, {
      requestId,
      caseId: seed.knownSnapshot.caseId,
      questionRef: seed.questionRef,
      challengeRef: seed.challengeRef,
      expectedCaseVersion: seed.knownSnapshot.caseVersion,
      expectedMaterialRevision: seed.knownSnapshot.materialRevision!,
      requestedEvidence: ['supplier_invoice'],
      demo: true
    }, context, nextDate());
    const requested = recordEvidence(
      seed.knownSnapshot,
      seed.questionRef,
      'evidence:challenge-establishment:requested',
      'EXTERNAL_PARTY',
      'MFT24',
      { requestId, at: nextDate() }
    );
    const expanded = { ...seed, requested };
    const targetClaim = recordChallengeClaim(seed, 'MFT24', {
      evidenceRefs: [seed.internal.evidenceRef, requested.evidenceRef]
    });
    const support = recordChallengeAssessment(seed, {
      verdict: 'SUPPORTED',
      targetClaimRef: targetClaim.claimRef,
      evidenceRefs: [...completeEvidenceRefs(seed), requested.evidenceRef]
    });
    const result = recordInvestigationChallengeBatchEstablishment(connection.db, {
      establishmentRef: randomUUID(),
      caseId: seed.knownSnapshot.caseId,
      questionRef: seed.questionRef,
      challengeRef: seed.challengeRef,
      claimRef: targetClaim.claimRef,
      expectedCaseVersion: seed.knownSnapshot.caseVersion,
      expectedMaterialRevision: seed.knownSnapshot.materialRevision!,
      demo: true
    }, context);
    expect(result.establishment.basisEvidenceRefs).toEqual([
      ...completeEvidenceRefs(seed),
      expanded.requested.evidenceRef
    ].sort());
    expect(result.establishment.basisAssessmentRefs).toContain(support.assessmentRef);
    expect(connection.db.select().from(schema.investigationEvidence).where(eq(
      schema.investigationEvidence.evidenceRef,
      requested.evidenceRef
    )).get()).not.toHaveProperty('challengeRef');
  });

  it('reevaluates drift without mutating the immutable Establishment', () => {
    const seed = seedPositiveChallenge();
    const input = recordInput(seed);
    const established = recordInvestigationChallengeBatchEstablishment(
      connection.db,
      input,
      context
    ).establishment;
    const current = evaluateCurrentInvestigationChallengeBatchEstablishment(
      connection.db,
      seed.knownSnapshot.caseId,
      established.establishmentRef
    );
    const inTransaction = connection.db.transaction((transaction) =>
      evaluateCurrentInvestigationChallengeBatchEstablishmentInTransaction(
        transaction,
        seed.knownSnapshot.caseId,
        established.establishmentRef
      )
    );
    expect(current).toEqual(inTransaction);
    expect(current).toMatchObject({ currentlyEligible: true, blockerCodes: [] });

    recordEvidence(
      seed.knownSnapshot,
      seed.questionRef,
      'evidence:challenge-establishment:unreviewed',
      'EXTERNAL_PARTY',
      'MFT24'
    );
    const drifted = evaluateCurrentInvestigationChallengeBatchEstablishment(
      connection.db,
      seed.knownSnapshot.caseId,
      established.establishmentRef
    );
    expect(drifted?.currentlyEligible).toBe(false);
    expect(drifted?.blockerCodes).toEqual(expect.arrayContaining([
      'HUMAN_SUPPORT_INCOMPLETE',
      'EVIDENCE_BASIS_CHANGED'
    ]));
    expect(getInvestigationChallengeBatchEstablishment(
      connection.db,
      seed.knownSnapshot.caseId,
      established.establishmentRef
    )).toEqual(established);
  });

  it('reevaluates Claim, Assessment, and supersession drift against immutable basis', () => {
    const newClaimSeed = seedPositiveChallenge();
    const newClaimInput = recordInput(newClaimSeed);
    recordInvestigationChallengeBatchEstablishment(connection.db, newClaimInput, context);
    recordChallengeClaim(newClaimSeed, 'MFT24');
    expect(evaluateCurrentInvestigationChallengeBatchEstablishment(
      connection.db,
      newClaimSeed.knownSnapshot.caseId,
      newClaimInput.establishmentRef
    )?.blockerCodes).toContain('CLAIM_BASIS_CHANGED');

    resetTestDatabase();
    const newAssessmentSeed = seedPositiveChallenge();
    const newAssessmentInput = recordInput(newAssessmentSeed);
    recordInvestigationChallengeBatchEstablishment(connection.db, newAssessmentInput, context);
    recordChallengeAssessment(newAssessmentSeed, {
      verdict: 'SUPPORTED',
      targetClaimRef: newAssessmentSeed.targetClaim.claimRef,
      supersedesAssessmentRef: newAssessmentSeed.support!.assessmentRef
    });
    expect(evaluateCurrentInvestigationChallengeBatchEstablishment(
      connection.db,
      newAssessmentSeed.knownSnapshot.caseId,
      newAssessmentInput.establishmentRef
    )?.blockerCodes).toContain('ASSESSMENT_BASIS_CHANGED');

    resetTestDatabase();
    const supersessionSeed = seedPositiveChallenge();
    const supersessionInput = recordInput(supersessionSeed);
    recordInvestigationChallengeBatchEstablishment(connection.db, supersessionInput, context);
    recordChallengeClaim(supersessionSeed, 'MFT24', {
      supersedesClaimRef: supersessionSeed.targetClaim.claimRef
    });
    const superseded = evaluateCurrentInvestigationChallengeBatchEstablishment(
      connection.db,
      supersessionSeed.knownSnapshot.caseId,
      supersessionInput.establishmentRef
    );
    expect(superseded?.blockerCodes).toEqual(expect.arrayContaining([
      'TARGET_NOT_ACTIVE',
      'CLAIM_BASIS_CHANGED'
    ]));
  });

  it('marks material/currentness drift historical while exact replay remains valid', () => {
    const seed = seedPositiveChallenge();
    const input = recordInput(seed);
    const original = recordInvestigationChallengeBatchEstablishment(
      connection.db,
      input,
      context
    );
    advanceMaterially(seed.knownSnapshot);
    expectChallengeEstablishmentError(
      () => recordInvestigationChallengeBatchEstablishment(connection.db, {
        ...input,
        establishmentRef: randomUUID(),
        expectedCaseVersion: input.expectedCaseVersion + 1,
        expectedMaterialRevision: input.expectedMaterialRevision + 1
      }, context),
      'CHALLENGE_NOT_CURRENT'
    );
    const current = evaluateCurrentInvestigationChallengeBatchEstablishment(
      connection.db,
      seed.knownSnapshot.caseId,
      input.establishmentRef
    );
    expect(current?.currentlyEligible).toBe(false);
    expect(current?.blockerCodes).toEqual(expect.arrayContaining([
      'MATERIAL_REVISION_CHANGED',
      'CHALLENGE_NOT_CURRENT'
    ]));
    expect(recordInvestigationChallengeBatchEstablishment(connection.db, {
      ...input,
      expectedCaseVersion: 1,
      expectedMaterialRevision: 1
    }, context)).toEqual({ ...original, replayed: true });
  });

  it('rolls back Establishment and audit if association insertion fails', () => {
    const seed = seedPositiveChallenge();
    const input = recordInput(seed);
    const auditBefore = connection.db.select().from(schema.auditEvents).all().length;
    connection.sqlite.exec(`
      create trigger force_challenge_establishment_association_failure
      before insert on investigation_challenge_establishments
      begin
        select raise(abort, 'forced association failure');
      end;
    `);
    expect(() => recordInvestigationChallengeBatchEstablishment(
      connection.db,
      input,
      context
    )).toThrow('forced association failure');
    expect(connection.db.select().from(schema.investigationEstablishments).where(eq(
      schema.investigationEstablishments.establishmentRef,
      input.establishmentRef
    )).get()).toBeUndefined();
    expect(connection.db.select().from(schema.investigationChallengeEstablishments).all())
      .toEqual([]);
    expect(connection.db.select().from(schema.auditEvents).all().length).toBe(auditBefore);
  });

  it('enforces restrictive FKs, survives reopen, and reset removes associations first', () => {
    const seed = seedPositiveChallenge();
    const input = recordInput(seed);
    recordInvestigationChallengeBatchEstablishment(connection.db, input, context);
    expect(() => connection.db.delete(schema.investigationChallenges).where(eq(
      schema.investigationChallenges.challengeRef,
      seed.challengeRef
    )).run()).toThrow();
    expect(() => connection.db.delete(schema.investigationEstablishments).where(eq(
      schema.investigationEstablishments.establishmentRef,
      input.establishmentRef
    )).run()).toThrow();
    expect(() => connection.db.insert(schema.investigationChallengeEstablishments).values({
      establishmentRef: randomUUID(),
      challengeRef: seed.challengeRef
    }).run()).toThrow();
    const baselineEstablishment = connection.db.select({
      establishmentRef: schema.investigationEstablishments.establishmentRef
    }).from(schema.investigationEstablishments).where(eq(
      schema.investigationEstablishments.claimRef,
      seed.baselineClaim.claimRef
    )).get();
    if (!baselineEstablishment) throw new Error('Expected baseline Establishment.');
    expect(() => connection.db.insert(schema.investigationChallengeEstablishments).values({
      establishmentRef: baselineEstablishment.establishmentRef,
      challengeRef: randomUUID()
    }).run()).toThrow();

    const path = connection.sqlite.name;
    connection.sqlite.close();
    connection = createDatabaseConnection(path);
    expect(connection.db.select().from(schema.investigationChallengeEstablishments).all())
      .toEqual([{ establishmentRef: input.establishmentRef, challengeRef: seed.challengeRef }]);
    expect(() => clearDemoData(connection.db)).not.toThrow();
    expect(connection.db.select().from(schema.investigationChallengeEstablishments).all())
      .toEqual([]);
    expect(() => seedDemoData(connection.db, fixtures)).not.toThrow();
  });

  it('upgrades populated 0013 state additively, preserves data, and reruns safely', () => {
    const preAssociationFolder = join(directory, 'pre-challenge-establishment-migrations');
    mkdirSync(join(preAssociationFolder, 'meta'), { recursive: true });
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
      '0011_confused_hannibal_king.sql',
      '0012_stiff_squadron_supreme.sql',
      '0013_tricky_amazoness.sql'
    ]) cpSync(join('drizzle', file), join(preAssociationFolder, file));
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 14);
    writeFileSync(
      join(preAssociationFolder, 'meta/_journal.json'),
      JSON.stringify(journal)
    );

    const existing = createDatabaseConnection(join(directory, 'populated-0013.db'));
    try {
      migrate(existing.db, { migrationsFolder: preAssociationFolder });
      seedDemoData(existing.db, fixtures);
      expect(existing.sqlite.prepare(
        "select name from sqlite_master where type = 'table' and name = ?"
      ).get('investigation_challenge_establishments')).toBeUndefined();
      const productsBefore = existing.db.select().from(schema.products).all();
      const alertsBefore = existing.db.select().from(schema.alerts).all();
      const matchesBefore = existing.db.select().from(schema.matches).all();

      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      expect(existing.db.select().from(schema.products).all()).toEqual(productsBefore);
      expect(existing.db.select().from(schema.alerts).all()).toEqual(alertsBefore);
      expect(existing.db.select().from(schema.matches).all()).toEqual(matchesBefore);
      expect(existing.db.select().from(schema.investigationChallengeEstablishments).all())
        .toEqual([]);
      expect(existing.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      existing.sqlite.close();
    }
  });
});

function establishChallengeBatch(seed: ReturnType<typeof seedPositiveChallenge>) {
  const input = recordInput(seed);
  const establishment = recordInvestigationChallengeBatchEstablishment(
    connection.db,
    input,
    context,
    nextDate()
  ).establishment;
  return { input, establishment };
}

function challengeBatchApplicationInput(
  seed: ReturnType<typeof seedPositiveChallenge>,
  establishmentRef: string
) {
  const basis = readChallengeBatchApplicationBasis(
    connection.db,
    seed.knownSnapshot.caseId,
    seed.questionRef,
    seed.challengeRef,
    establishmentRef
  );
  return {
    basis,
    input: {
      applicationRef: randomUUID(),
      caseId: seed.knownSnapshot.caseId,
      questionRef: seed.questionRef,
      challengeRef: seed.challengeRef,
      establishmentRef,
      expectedCaseVersion: seed.knownSnapshot.caseVersion,
      expectedMaterialRevision: seed.knownSnapshot.materialRevision!,
      expectedApplicationBasisDigest: basis.applicationBasisDigest,
      rationale: 'Reviewed the exact current positive Challenge application basis.',
      demo: true as const
    }
  };
}

function allQuestionEvidenceRefs(snapshot: CaseSnapshot, questionRef: string): string[] {
  return listInvestigationEvidence(connection.db, snapshot.caseId, questionRef)
    .map((evidence) => evidence.evidenceRef)
    .sort();
}

function openNextPositiveChallenge(
  prior: BaseChallengeSeed,
  knownSnapshot: CaseSnapshot,
  baselineClaim: InvestigationClaim,
  evidenceRef: string,
  lot: string
): BaseChallengeSeed {
  const late = recordEvidence(
    knownSnapshot,
    prior.questionRef,
    evidenceRef,
    'REGULATOR',
    lot,
    { at: nextDate() }
  );
  const challenge = openInvestigationChallenge(connection.db, {
    challengeRef: randomUUID(),
    caseId: knownSnapshot.caseId,
    questionRef: prior.questionRef,
    expectedCaseVersion: knownSnapshot.caseVersion,
    expectedMaterialRevision: knownSnapshot.materialRevision!,
    triggerEvidenceRefs: [late.evidenceRef],
    rationale: 'Later Evidence requires another provenance-backed positive cycle.',
    demo: true
  }, context, nextDate()).challenge;
  return {
    ...prior,
    knownSnapshot,
    late,
    baselineClaim,
    challengeRef: challenge.challengeRef
  };
}

function assertAppliedBaseline(
  seed: BaseChallengeSeed,
  applicationRef: string,
  expectedClaimRefs: string[],
  expectedAssessmentRefs: string[],
  expectedEvidenceRefs: string[]
): AppliedChallengeBatchBaseline {
  const challenge = getInvestigationChallenge(
    connection.db,
    seed.knownSnapshot.caseId,
    seed.challengeRef
  );
  if (!challenge) throw new Error('Expected the later Challenge anchor.');
  const baseline = resolveAuthoritativeChallengeBaseline(connection.db, {
    caseId: seed.knownSnapshot.caseId,
    questionRef: seed.questionRef,
    challengeRef: seed.challengeRef,
    challengedRevisionId: challenge.challengedRevisionId,
    challengedMaterialRevision: challenge.challengedMaterialRevision,
    openedCaseVersion: challenge.openedCaseVersion,
    currentCaseVersion: seed.knownSnapshot.caseVersion
  });
  expect(baseline).toMatchObject({
    kind: 'APPLIED_CHALLENGE_BATCH',
    applicationRef,
    resultBaselineClaimRefs: expectedClaimRefs,
    resultBaselineAssessmentRefs: expectedAssessmentRefs,
    resultBaselineEvidenceRefs: expectedEvidenceRefs
  });
  return baseline as AppliedChallengeBatchBaseline;
}

function applyFirstReplacementForInheritance() {
  const seed = seedPositiveChallenge({ targetLot: 'MFT25' });
  recordChallengeAssessment(seed, {
    verdict: 'REJECTED',
    targetClaimRef: seed.baselineClaim.claimRef,
    assessorKind: 'RULE'
  });
  const establishment = establishChallengeBatch(seed).establishment;
  const applicationInput = challengeBatchApplicationInput(seed, establishment.establishmentRef);
  const applied = applyInvestigationChallengeBatch(
    connection.db,
    applicationInput.input,
    context,
    nextDate()
  );
  return { seed, establishment, applicationInput, applied };
}

function expectLaterChallengeBaselineFailure(
  seed: ReturnType<typeof seedPositiveChallenge>,
  snapshot: CaseSnapshot,
  code: string
): void {
  const late = recordEvidence(
    snapshot,
    seed.questionRef,
    `evidence:challenge-establishment:corruption:${randomUUID()}`,
    'REGULATOR',
    'MFT26',
    { at: nextDate() }
  );
  expect(() => openInvestigationChallenge(connection.db, {
    challengeRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef: seed.questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    expectedMaterialRevision: snapshot.materialRevision!,
    triggerEvidenceRefs: [late.evidenceRef],
    rationale: 'Corrupt positive provenance must fail closed.',
    demo: true
  }, context, nextDate())).toThrow(expect.objectContaining({ code }));
}

function expectChallengeBatchApplicationError(
  action: () => unknown,
  code: InvestigationChallengeBatchApplicationError['code']
): void {
  try {
    action();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationChallengeBatchApplicationError);
    expect((error as InvestigationChallengeBatchApplicationError).code).toBe(code);
  }
}

describe('positive Challenge batch application', () => {
  it('derives a stable read-only basis and exposes the exact 16A classification', () => {
    const seed = seedPositiveChallenge();
    const initialProjection = readChallengeEffectiveInvestigationAnalysis(
      connection.db,
      seed.knownSnapshot.caseId,
      seed.questionRef,
      seed.challengeRef
    );
    expect(initialProjection.authoritativeBaseline).toMatchObject({
      kind: 'INITIAL_UNASSOCIATED',
      baselineClaimRefs: [seed.baselineClaim.claimRef]
    });
    const { establishment } = establishChallengeBatch(seed);
    const before = protectedState(seed.knownSnapshot.caseId);
    const first = readChallengeBatchApplicationBasis(
      connection.db,
      seed.knownSnapshot.caseId,
      seed.questionRef,
      seed.challengeRef,
      establishment.establishmentRef
    );
    const second = readChallengeBatchApplicationBasis(
      connection.db,
      seed.knownSnapshot.caseId,
      seed.questionRef,
      seed.challengeRef,
      establishment.establishmentRef
    );

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      basisFormatVersion: challengeBatchApplicationBasisFormatVersion,
      applicationPolicyIdentifier: challengeBatchApplicationPolicy.identifier,
      applicationPolicyVersion: challengeBatchApplicationPolicy.version,
      challengeRef: seed.challengeRef,
      establishmentRef: establishment.establishmentRef,
      claimRef: seed.targetClaim.claimRef,
      resolutionKind: 'REAFFIRM',
      targetNormalizedLot: 'mft24',
      eligibility: { eligible: true, blockerCodes: [] }
    });
    expect(first.currentEvaluation.qualifyingTargetSupportAssessmentRefs)
      .toEqual([seed.support!.assessmentRef]);
    expect(first.currentEvaluation.reliedUponRejectionAssessmentRefs).toEqual([]);
    expect(first.currentEvaluation.basis).toEqual({
      claimRefs: establishment.basisClaimRefs,
      assessmentRefs: establishment.basisAssessmentRefs,
      evidenceRefs: establishment.basisEvidenceRefs
    });
    expect(first.reviewedClaimRefs).toEqual(establishment.basisClaimRefs);
    expect(first.reviewedAssessmentRefs).toEqual(establishment.basisAssessmentRefs);
    expect(first.reviewedEvidenceRefs).toEqual(completeEvidenceRefs(seed));
    expect(first.resultBaselineClaimRefs).toEqual([seed.targetClaim.claimRef]);
    expect(first.resultBaselineAssessmentRefs).toEqual([seed.support!.assessmentRef]);
    expect(first.applicationBasisDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evaluateCurrentInvestigationChallengeBatchEstablishment(
      connection.db,
      seed.knownSnapshot.caseId,
      establishment.establishmentRef
    )).toMatchObject({
      qualifyingTargetSupportAssessmentRefs: [seed.support!.assessmentRef],
      reliedUponRejectionAssessmentRefs: []
    });
    expect(protectedState(seed.knownSnapshot.caseId)).toEqual(before);
  });

  it('changes the reviewed digest for Claim and Assessment drift without lifecycle versions', () => {
    const seed = seedPositiveChallenge();
    const { establishment } = establishChallengeBatch(seed);
    const original = readChallengeBatchApplicationBasis(
      connection.db,
      seed.knownSnapshot.caseId,
      seed.questionRef,
      seed.challengeRef,
      establishment.establishmentRef
    );
    recordChallengeClaim(seed, 'MFT24', { claimRef: randomUUID() });
    const claimDrift = readChallengeBatchApplicationBasis(
      connection.db,
      seed.knownSnapshot.caseId,
      seed.questionRef,
      seed.challengeRef,
      establishment.establishmentRef
    );
    expect(claimDrift.currentCaseVersion).toBe(original.currentCaseVersion);
    expect(claimDrift.currentMaterialRevision).toBe(original.currentMaterialRevision);
    expect(claimDrift.applicationBasisDigest).not.toBe(original.applicationBasisDigest);

    resetTestDatabase();
    const assessmentSeed = seedPositiveChallenge();
    const recorded = establishChallengeBatch(assessmentSeed).establishment;
    const beforeAssessment = readChallengeBatchApplicationBasis(
      connection.db,
      assessmentSeed.knownSnapshot.caseId,
      assessmentSeed.questionRef,
      assessmentSeed.challengeRef,
      recorded.establishmentRef
    );
    recordChallengeAssessment(assessmentSeed, {
      verdict: 'SUPPORTED',
      targetClaimRef: assessmentSeed.targetClaim.claimRef,
      assessorKind: 'RULE'
    });
    const assessmentDrift = readChallengeBatchApplicationBasis(
      connection.db,
      assessmentSeed.knownSnapshot.caseId,
      assessmentSeed.questionRef,
      assessmentSeed.challengeRef,
      recorded.establishmentRef
    );
    expect(assessmentDrift.currentCaseVersion).toBe(beforeAssessment.currentCaseVersion);
    expect(assessmentDrift.currentMaterialRevision).toBe(beforeAssessment.currentMaterialRevision);
    expect(assessmentDrift.applicationBasisDigest).not.toBe(
      beforeAssessment.applicationBasisDigest
    );
  });

  it('applies a same-lot reaffirmation as exact +1 material authority and replays historically', () => {
    const seed = seedPositiveChallenge();
    const { establishment } = establishChallengeBatch(seed);
    const { basis, input } = challengeBatchApplicationInput(seed, establishment.establishmentRef);
    const beforeRevisions = connection.db.select().from(schema.caseRevisions).all().length;
    const beforeCommands = connection.db.select().from(schema.caseCommands).all().length;
    const beforeAudit = connection.db.select().from(schema.auditEvents).all().length;
    const applied = applyInvestigationChallengeBatch(
      connection.db,
      input,
      context,
      nextDate()
    );

    expect(applied.replayed).toBe(false);
    expect(applied.snapshot.caseVersion).toBe(seed.knownSnapshot.caseVersion + 1);
    expect(applied.snapshot.materialRevision).toBe(seed.knownSnapshot.materialRevision! + 1);
    expect(applied.snapshot.investigation).toMatchObject({
      knowledgeStatus: 'KNOWN',
      scope: {
        kind: 'BATCH_LOT',
        lots: ['mft24'],
        knowledgeStatus: 'KNOWN',
        evidenceRefs: basis.appliedEvidenceRefs,
        decisionRefs: [input.applicationRef]
      },
      gaps: [],
      conflicts: []
    });
    expect(applied.snapshot.investigation!.identity)
      .toEqual(seed.knownSnapshot.investigation!.identity);
    expect(applied.snapshot.decisions.some(
      (decision) => decision.id === input.applicationRef
    )).toBe(false);
    expect(applied.application).toMatchObject({
      claimRef: seed.targetClaim.claimRef,
      appliedLot: 'mft24',
      actorKind: 'HUMAN',
      actorIdentifier: demoHumanAssessorIdentifier,
      reviewedClaimRefs: basis.reviewedClaimRefs,
      appliedAssessmentRefs: basis.appliedAssessmentRefs,
      resultBaselineClaimRefs: [seed.targetClaim.claimRef],
      resultBaselineAssessmentRefs: [seed.support!.assessmentRef]
    });
    expect(applied.application.resultingCaseVersion)
      .toBe(applied.application.sourceCaseVersion + 1);
    expect(applied.application.resultingMaterialRevision)
      .toBe(applied.application.sourceMaterialRevision + 1);

    const replay = applyInvestigationChallengeBatch(connection.db, {
      ...input,
      expectedCaseVersion: 999,
      expectedMaterialRevision: 999,
      expectedApplicationBasisDigest: `sha256:${'0'.repeat(64)}`
    }, context, nextDate());
    expect(replay).toEqual({ ...applied, replayed: true });
    expect(getInvestigationChallengeBatchApplication(
      connection.db,
      input.caseId,
      input.applicationRef
    )).toEqual(applied.application);
    expect(connection.db.select().from(schema.investigationChallengeBatchApplications).all())
      .toHaveLength(1);
    expect(connection.db.select().from(schema.caseRevisions).all().length).toBe(beforeRevisions + 1);
    expect(connection.db.select().from(schema.caseCommands).all().length).toBe(beforeCommands + 1);
    expect(connection.db.select().from(schema.auditEvents).all().length).toBe(beforeAudit + 1);
  });

  it('replaces the lot while separating reviewed rejection justification from result baseline', () => {
    const seed = seedPositiveChallenge({ targetLot: 'MFT25' });
    const rejection = recordChallengeAssessment(seed, {
      verdict: 'REJECTED',
      targetClaimRef: seed.baselineClaim.claimRef,
      assessorKind: 'RULE'
    });
    const { establishment } = establishChallengeBatch(seed);
    const { basis, input } = challengeBatchApplicationInput(seed, establishment.establishmentRef);
    expect(basis.resolutionKind).toBe('REPLACE');
    expect(basis.appliedAssessmentRefs).toEqual([
      rejection.assessmentRef,
      seed.support!.assessmentRef
    ].sort());
    expect(basis.resultBaselineClaimRefs).toEqual([seed.targetClaim.claimRef]);
    expect(basis.resultBaselineAssessmentRefs).toEqual([seed.support!.assessmentRef]);
    expect(basis.resultBaselineClaimRefs).not.toContain(seed.baselineClaim.claimRef);
    expect(basis.resultBaselineAssessmentRefs).not.toContain(rejection.assessmentRef);

    const applied = applyInvestigationChallengeBatch(connection.db, input, context, nextDate());
    expect(applied.snapshot.investigation!.scope).toMatchObject({
      kind: 'BATCH_LOT',
      lots: ['mft25'],
      evidenceRefs: completeEvidenceRefs(seed)
    });
    expect(applied.application.appliedAssessmentRefs).toEqual(basis.appliedAssessmentRefs);
    expect(applied.application.resultBaselineAssessmentRefs)
      .toEqual([seed.support!.assessmentRef]);
  });

  it('supports provenance-safe CH2 and CH3 positive replacement cycles', () => {
    const first = seedPositiveChallenge({ targetLot: 'MFT25' });
    const firstRejection = recordChallengeAssessment(first, {
      verdict: 'REJECTED',
      targetClaimRef: first.baselineClaim.claimRef,
      assessorKind: 'RULE'
    });
    const firstEstablishment = establishChallengeBatch(first);
    const firstApplication = challengeBatchApplicationInput(
      first,
      firstEstablishment.establishment.establishmentRef
    );
    const appliedFirst = applyInvestigationChallengeBatch(
      connection.db,
      firstApplication.input,
      context,
      nextDate()
    );
    expect(firstEstablishment.establishment.policyVersion).toBe('v1');
    expect(firstApplication.basis.basisFormatVersion)
      .toBe(challengeBatchApplicationBasisFormatVersion);

    const operationalFirst = advanceOperationally(appliedFirst.snapshot);
    const secondBase = openNextPositiveChallenge(
      first,
      operationalFirst,
      first.targetClaim,
      'evidence:challenge-establishment:cycle-two',
      'MFT26'
    );
    const firstBaseline = assertAppliedBaseline(
      secondBase,
      appliedFirst.application.applicationRef,
      [first.targetClaim.claimRef],
      [first.support!.assessmentRef],
      appliedFirst.application.resultBaselineEvidenceRefs
    );
    expect(firstBaseline.resultingRevisionId)
      .toBe(appliedFirst.application.resultingRevisionId);
    expect(getInvestigationChallenge(
      connection.db,
      secondBase.knownSnapshot.caseId,
      secondBase.challengeRef
    )?.challengedRevisionId).toBe(appliedFirst.application.resultingRevisionId);

    expect(() => recordChallengeClaim(secondBase, 'MFT26', {
      supersedesClaimRef: first.targetClaim.claimRef
    })).toThrow(expect.objectContaining({ code: 'SUPERSESSION_MISMATCH' }));
    expect(() => recordChallengeAssessment(secondBase, {
      verdict: 'REJECTED',
      targetClaimRef: first.baselineClaim.claimRef,
      evidenceRefs: allQuestionEvidenceRefs(secondBase.knownSnapshot, secondBase.questionRef)
    })).toThrow(expect.objectContaining({ code: 'CLAIM_CHALLENGE_MISMATCH' }));

    const secondRequest = requestInvestigationEvidence(connection.db, {
      requestId: randomUUID(),
      caseId: secondBase.knownSnapshot.caseId,
      questionRef: secondBase.questionRef,
      challengeRef: secondBase.challengeRef,
      expectedCaseVersion: secondBase.knownSnapshot.caseVersion,
      expectedMaterialRevision: secondBase.knownSnapshot.materialRevision!,
      requestedEvidence: ['supplier_invoice'],
      demo: true
    }, context, nextDate()).request;
    const secondRequestEvidence = recordEvidence(
      secondBase.knownSnapshot,
      secondBase.questionRef,
      'evidence:challenge-establishment:cycle-two-request',
      'EXTERNAL_PARTY',
      'MFT26',
      { requestId: secondRequest.id, at: nextDate() }
    );
    const secondClaim = recordChallengeClaim(secondBase, 'MFT26', {
      evidenceRefs: [secondBase.internal.evidenceRef, secondRequestEvidence.evidenceRef]
    });
    const secondEvidenceRefs = allQuestionEvidenceRefs(
      secondBase.knownSnapshot,
      secondBase.questionRef
    );
    const secondSupport = recordChallengeAssessment(secondBase, {
      verdict: 'SUPPORTED',
      targetClaimRef: secondClaim.claimRef,
      evidenceRefs: secondEvidenceRefs
    });
    expect(() => recordChallengeAssessment(secondBase, {
      verdict: 'SUPPORTED',
      targetClaimRef: secondClaim.claimRef,
      evidenceRefs: secondEvidenceRefs,
      supersedesAssessmentRef: first.support!.assessmentRef
    })).toThrow(expect.objectContaining({ code: 'SUPERSESSION_MISMATCH' }));
    const secondRejection = recordChallengeAssessment(secondBase, {
      verdict: 'REJECTED',
      targetClaimRef: first.targetClaim.claimRef,
      evidenceRefs: secondEvidenceRefs,
      assessorKind: 'RULE'
    });
    const second = {
      ...secondBase,
      targetClaim: secondClaim,
      support: secondSupport
    };
    const secondProjection = readChallengeEffectiveInvestigationAnalysis(
      connection.db,
      second.knownSnapshot.caseId,
      second.questionRef,
      second.challengeRef
    );
    expect(secondProjection.authoritativeBaseline).toEqual(firstBaseline);
    expect(secondProjection.analysis.activeClaims.map((claim) => claim.claimRef).sort())
      .toEqual([first.targetClaim.claimRef, secondClaim.claimRef].sort());
    expect(secondProjection.analysis.structuralAssessmentHeads
      .map((assessment) => assessment.assessmentRef).sort())
      .toEqual([first.support!.assessmentRef, secondSupport.assessmentRef,
        secondRejection.assessmentRef].sort());
    expect(secondProjection.analysis.staleAssessments.map(
      ({ assessment }) => assessment.assessmentRef
    )).toContain(first.support!.assessmentRef);
    expect(secondProjection.analysis.materiallyCurrentAssessmentHeads.map(
      (assessment) => assessment.assessmentRef
    )).not.toContain(first.support!.assessmentRef);
    expect(secondProjection.analysis.activeClaims.map((claim) => claim.claimRef))
      .not.toContain(first.baselineClaim.claimRef);
    expect(secondProjection.analysis.structuralAssessmentHeads.map(
      (assessment) => assessment.assessmentRef
    )).not.toContain(firstRejection.assessmentRef);

    const secondEstablishment = establishChallengeBatch(second);
    expect(secondEstablishment.establishment.policyIdentifier)
      .toBe(demoInheritedChallengeBatchEstablishmentPolicy.policyIdentifier);
    expect(secondEstablishment.establishment.policyVersion)
      .toBe(demoInheritedChallengeBatchEstablishmentPolicy.policyVersion);
    const secondApplication = challengeBatchApplicationInput(
      second,
      secondEstablishment.establishment.establishmentRef
    );
    expect(secondApplication.basis).toMatchObject({
      basisFormatVersion: inheritedChallengeBatchApplicationBasisFormatVersion,
      authoritativeBaseline: {
        kind: 'APPLIED_CHALLENGE_BATCH',
        applicationRef: appliedFirst.application.applicationRef
      },
      resultBaselineClaimRefs: [secondClaim.claimRef],
      resultBaselineAssessmentRefs: [secondSupport.assessmentRef]
    });
    expect(secondApplication.basis.appliedAssessmentRefs).toEqual([
      secondRejection.assessmentRef,
      secondSupport.assessmentRef
    ].sort());
    expect(secondApplication.basis.resultBaselineClaimRefs)
      .not.toContain(first.targetClaim.claimRef);
    expect(secondApplication.basis.resultBaselineAssessmentRefs)
      .not.toContain(secondRejection.assessmentRef);

    const appliedSecond = applyInvestigationChallengeBatch(
      connection.db,
      secondApplication.input,
      context,
      nextDate()
    );
    expect(appliedSecond.snapshot.investigation!.scope).toMatchObject({
      kind: 'BATCH_LOT',
      lots: ['mft26'],
      evidenceRefs: secondEvidenceRefs
    });
    expect(appliedSecond.snapshot.materialRevision)
      .toBe(operationalFirst.materialRevision! + 1);

    const thirdBase = openNextPositiveChallenge(
      secondBase,
      appliedSecond.snapshot,
      secondClaim,
      'evidence:challenge-establishment:cycle-three',
      'MFT27'
    );
    const secondBaseline = assertAppliedBaseline(
      thirdBase,
      appliedSecond.application.applicationRef,
      [secondClaim.claimRef],
      [secondSupport.assessmentRef],
      appliedSecond.application.resultBaselineEvidenceRefs
    );
    const thirdProjection = readChallengeEffectiveInvestigationAnalysis(
      connection.db,
      thirdBase.knownSnapshot.caseId,
      thirdBase.questionRef,
      thirdBase.challengeRef
    );
    expect(thirdProjection.authoritativeBaseline).toEqual(secondBaseline);
    expect(thirdProjection.analysis.activeClaims.map((claim) => claim.claimRef))
      .toEqual([secondClaim.claimRef]);
    expect(thirdProjection.analysis.structuralAssessmentHeads.map(
      (assessment) => assessment.assessmentRef
    )).toEqual([secondSupport.assessmentRef]);
    expect(thirdProjection.analysis.activeClaims.map((claim) => claim.claimRef))
      .not.toContain(first.targetClaim.claimRef);
    expect(thirdProjection.analysis.structuralAssessmentHeads.map(
      (assessment) => assessment.assessmentRef
    )).not.toContain(firstRejection.assessmentRef);

    expect(recordInvestigationChallengeBatchEstablishment(connection.db, {
      ...secondEstablishment.input,
      expectedCaseVersion: 999,
      expectedMaterialRevision: 999
    }, context, nextDate())).toMatchObject({ replayed: true });
    expect(applyInvestigationChallengeBatch(connection.db, {
      ...secondApplication.input,
      expectedCaseVersion: 999,
      expectedMaterialRevision: 999,
      expectedApplicationBasisDigest: `sha256:${'0'.repeat(64)}`
    }, context, nextDate())).toEqual({ ...appliedSecond, replayed: true });
  });

  it('uses the inherited v2 conflict basis without enabling post-conflict continuation', () => {
    const first = seedPositiveChallenge({ targetLot: 'MFT25' });
    recordChallengeAssessment(first, {
      verdict: 'REJECTED',
      targetClaimRef: first.baselineClaim.claimRef,
      assessorKind: 'RULE'
    });
    const firstEstablishment = establishChallengeBatch(first).establishment;
    const firstApplication = challengeBatchApplicationInput(
      first,
      firstEstablishment.establishmentRef
    );
    const appliedFirst = applyInvestigationChallengeBatch(
      connection.db,
      firstApplication.input,
      context,
      nextDate()
    );
    const second = openNextPositiveChallenge(
      first,
      appliedFirst.snapshot,
      first.targetClaim,
      'evidence:challenge-conflict:cycle-two',
      'MFT26'
    );
    const competing = recordChallengeClaim(second, 'MFT26');
    const evidenceRefs = allQuestionEvidenceRefs(second.knownSnapshot, second.questionRef);
    recordChallengeAssessment(second, {
      verdict: 'CONTRADICTED',
      targetClaimRef: null,
      relatedClaimRefs: [first.targetClaim.claimRef, competing.claimRef],
      evidenceRefs,
      assessorKind: 'HUMAN'
    });
    const basis = readChallengeConflictApplicationBasis(
      connection.db,
      second.knownSnapshot.caseId,
      second.questionRef,
      second.challengeRef
    );
    expect(basis).toMatchObject({
      basisFormatVersion: inheritedChallengeConflictApplicationBasisFormatVersion,
      policyIdentifier: inheritedChallengeConflictApplicationPolicy.identifier,
      policyVersion: inheritedChallengeConflictApplicationPolicy.version,
      authoritativeBaseline: {
        kind: 'APPLIED_CHALLENGE_BATCH',
        applicationRef: appliedFirst.application.applicationRef
      },
      eligibility: { eligible: true }
    });
    const input = {
      applicationRef: randomUUID(),
      caseId: second.knownSnapshot.caseId,
      questionRef: second.questionRef,
      challengeRef: second.challengeRef,
      expectedCaseVersion: second.knownSnapshot.caseVersion,
      expectedMaterialRevision: second.knownSnapshot.materialRevision!,
      expectedApplicationBasisDigest: basis.applicationBasisDigest,
      rationale: 'Reviewed the inherited-cycle conflict basis.',
      demo: true as const
    };
    const conflicted = applyInvestigationChallengeConflict(
      connection.db,
      input,
      context,
      nextDate()
    );
    expect(conflicted.application).toMatchObject({
      basisFormatVersion: inheritedChallengeConflictApplicationBasisFormatVersion,
      policyIdentifier: inheritedChallengeConflictApplicationPolicy.identifier,
      policyVersion: inheritedChallengeConflictApplicationPolicy.version
    });
    expect(conflicted.snapshot.investigation).toMatchObject({
      knowledgeStatus: 'CONFLICTED',
      scope: { kind: 'UNRESOLVED', knowledgeStatus: 'CONFLICTED' }
    });
    expect(applyInvestigationChallengeConflict(connection.db, {
      ...input,
      expectedCaseVersion: 999,
      expectedMaterialRevision: 999,
      expectedApplicationBasisDigest: `sha256:${'0'.repeat(64)}`
    }, context, nextDate())).toEqual({ ...conflicted, replayed: true });
  });

  it('does not fall back to the initial baseline when positive provenance is corrupt', () => {
    const first = seedPositiveChallenge({ targetLot: 'MFT25' });
    recordChallengeAssessment(first, {
      verdict: 'REJECTED',
      targetClaimRef: first.baselineClaim.claimRef,
      assessorKind: 'RULE'
    });
    const establishment = establishChallengeBatch(first).establishment;
    const applicationInput = challengeBatchApplicationInput(
      first,
      establishment.establishmentRef
    );
    const applied = applyInvestigationChallengeBatch(
      connection.db,
      applicationInput.input,
      context,
      nextDate()
    );
    connection.db.update(schema.investigationChallengeBatchApplications).set({
      resultBaselineClaimRefsJson: JSON.stringify([randomUUID()])
    }).where(eq(
      schema.investigationChallengeBatchApplications.applicationRef,
      applied.application.applicationRef
    )).run();
    const late = recordEvidence(
      applied.snapshot,
      first.questionRef,
      'evidence:challenge-establishment:corrupt-positive',
      'REGULATOR',
      'MFT26',
      { at: nextDate() }
    );
    expect(() => openInvestigationChallenge(connection.db, {
      challengeRef: randomUUID(),
      caseId: applied.snapshot.caseId,
      questionRef: first.questionRef,
      expectedCaseVersion: applied.snapshot.caseVersion,
      expectedMaterialRevision: applied.snapshot.materialRevision!,
      triggerEvidenceRefs: [late.evidenceRef],
      rationale: 'Corrupt positive provenance must not fall back.',
      demo: true
    }, context, nextDate())).toThrow(expect.objectContaining({
      code: 'CHALLENGE_BASELINE_PROVENANCE_INVALID'
    }));
  });

  it('fails closed when operational revision continuity after a positive result has a gap', () => {
    const first = seedPositiveChallenge({ targetLot: 'MFT25' });
    recordChallengeAssessment(first, {
      verdict: 'REJECTED',
      targetClaimRef: first.baselineClaim.claimRef,
      assessorKind: 'RULE'
    });
    const establishment = establishChallengeBatch(first).establishment;
    const applicationInput = challengeBatchApplicationInput(
      first,
      establishment.establishmentRef
    );
    const applied = applyInvestigationChallengeBatch(
      connection.db,
      applicationInput.input,
      context,
      nextDate()
    );
    const firstOperational = advanceOperationally(applied.snapshot);
    const secondOperational = advanceOperationally(firstOperational);
    connection.db.delete(schema.caseRevisions).where(and(
      eq(schema.caseRevisions.caseId, firstOperational.caseId),
      eq(schema.caseRevisions.caseVersion, firstOperational.caseVersion)
    )).run();
    const late = recordEvidence(
      secondOperational,
      first.questionRef,
      'evidence:challenge-establishment:revision-gap',
      'REGULATOR',
      'MFT26',
      { at: nextDate() }
    );
    expect(() => openInvestigationChallenge(connection.db, {
      challengeRef: randomUUID(),
      caseId: secondOperational.caseId,
      questionRef: first.questionRef,
      expectedCaseVersion: secondOperational.caseVersion,
      expectedMaterialRevision: secondOperational.materialRevision!,
      triggerEvidenceRefs: [late.evidenceRef],
      rationale: 'A missing operational revision must fail closed.',
      demo: true
    }, context, nextDate())).toThrow(expect.objectContaining({
      code: 'CHALLENGE_BASELINE_PROVENANCE_INVALID'
    }));
  });

  it('fails closed when an operational revision changes the authoritative InvestigationOutcome', () => {
    const { applied } = applyFirstReplacementForInheritance();
    const operational = advanceOperationally(applied.snapshot);
    const divergent = caseSnapshotSchema.parse({
      ...operational,
      investigation: {
        ...operational.investigation!,
        updatedAt: nextDate().toISOString()
      }
    });
    connection.db.update(schema.caseRevisions).set({
      snapshotJson: JSON.stringify(divergent)
    }).where(and(
      eq(schema.caseRevisions.caseId, operational.caseId),
      eq(schema.caseRevisions.caseVersion, operational.caseVersion)
    )).run();

    expect(() => resolveAuthoritativeChallengeBaseline(connection.db, {
      caseId: operational.caseId,
      questionRef: applied.application.questionRef,
      challengeRef: randomUUID(),
      challengedRevisionId: applied.application.resultingRevisionId,
      challengedMaterialRevision: applied.application.resultingMaterialRevision,
      openedCaseVersion: operational.caseVersion,
      currentCaseVersion: operational.caseVersion
    })).toThrow(expect.objectContaining({
      code: 'CHALLENGE_BASELINE_PROVENANCE_INVALID'
    }));
  });

  it.each([
    {
      name: 'applied lot mismatch',
      change: (application: ReturnType<typeof applyFirstReplacementForInheritance>['applied']['application']) => ({
        appliedLot: `${application.appliedLot}-corrupt`
      })
    },
    {
      name: 'missing result-baseline Assessment',
      change: () => ({ resultBaselineAssessmentRefsJson: JSON.stringify([randomUUID()]) })
    },
    {
      name: 'missing result-baseline Evidence',
      change: () => ({ resultBaselineEvidenceRefsJson: JSON.stringify(['evidence:missing']) })
    },
    {
      name: 'unsupported basis format',
      change: () => ({ basisFormatVersion: 'challenge-batch-application-basis/v999' })
    },
    {
      name: 'recorded material version mismatch',
      change: (application: ReturnType<typeof applyFirstReplacementForInheritance>['applied']['application']) => ({
        sourceMaterialRevision: application.sourceMaterialRevision + 10,
        resultingMaterialRevision: application.sourceMaterialRevision + 11
      })
    }
  ])('fails closed for $name without initial-baseline fallback', ({ change }) => {
    const { seed, applied } = applyFirstReplacementForInheritance();
    connection.db.update(schema.investigationChallengeBatchApplications).set(
      change(applied.application)
    ).where(eq(
      schema.investigationChallengeBatchApplications.applicationRef,
      applied.application.applicationRef
    )).run();
    expectLaterChallengeBaselineFailure(
      seed,
      applied.snapshot,
      'CHALLENGE_BASELINE_PROVENANCE_INVALID'
    );
  });

  it('distinguishes absent positive provenance from corrupt attempted provenance', () => {
    const { seed, applied } = applyFirstReplacementForInheritance();
    connection.db.delete(schema.investigationChallengeBatchApplications).where(eq(
      schema.investigationChallengeBatchApplications.applicationRef,
      applied.application.applicationRef
    )).run();
    expectLaterChallengeBaselineFailure(seed, applied.snapshot, 'ANSWER_CONTINUITY_UNPROVEN');

    resetTestDatabase();
    const missingRevision = applyFirstReplacementForInheritance();
    connection.sqlite.pragma('foreign_keys = OFF');
    connection.db.delete(schema.caseRevisions).where(eq(
      schema.caseRevisions.id,
      missingRevision.applied.application.resultingRevisionId
    )).run();
    connection.sqlite.pragma('foreign_keys = ON');
    expectLaterChallengeBaselineFailure(
      missingRevision.seed,
      missingRevision.applied.snapshot,
      'CHALLENGE_BASELINE_PROVENANCE_INVALID'
    );
  });

  it('rejects a positive application as its own source Challenge', () => {
    const { seed, applied } = applyFirstReplacementForInheritance();
    expect(() => resolveAuthoritativeChallengeBaseline(connection.db, {
      caseId: seed.knownSnapshot.caseId,
      questionRef: seed.questionRef,
      challengeRef: applied.application.challengeRef,
      challengedRevisionId: applied.application.resultingRevisionId,
      challengedMaterialRevision: applied.application.resultingMaterialRevision,
      openedCaseVersion: applied.application.resultingCaseVersion,
      currentCaseVersion: applied.application.resultingCaseVersion
    })).toThrow(expect.objectContaining({
      code: 'CHALLENGE_BASELINE_PROVENANCE_INVALID'
    }));
  });

  it('reuses shared material-change semantics to reopen a CLOSED case', () => {
    const seed = seedPositiveChallenge();
    const { establishment } = establishChallengeBatch(seed);
    const closed = closePositiveChallengeFixture(seed.knownSnapshot);
    const basis = readChallengeBatchApplicationBasis(
      connection.db,
      closed.caseId,
      seed.questionRef,
      seed.challengeRef,
      establishment.establishmentRef
    );
    expect(basis.eligibility.eligible).toBe(true);
    const applied = applyInvestigationChallengeBatch(connection.db, {
      applicationRef: randomUUID(),
      caseId: closed.caseId,
      questionRef: seed.questionRef,
      challengeRef: seed.challengeRef,
      establishmentRef: establishment.establishmentRef,
      expectedCaseVersion: closed.caseVersion,
      expectedMaterialRevision: closed.materialRevision!,
      expectedApplicationBasisDigest: basis.applicationBasisDigest,
      rationale: 'Reviewed the current closed-case reaffirmation basis.',
      demo: true
    }, context, nextDate());
    expect(applied.snapshot).toMatchObject({
      caseVersion: closed.caseVersion + 1,
      materialRevision: closed.materialRevision! + 1,
      stage: 'INVESTIGATING',
      exposure: { status: 'NOT_CALCULATED' },
      closure: { status: 'NOT_READY' }
    });
    expect(connection.db.select().from(schema.cases).where(eq(
      schema.cases.id,
      closed.caseId
    )).get()).toMatchObject({ status: 'open', closedAt: null });
    expect(connection.db.select().from(schema.auditEvents).where(eq(
      schema.auditEvents.eventType,
      'case_reopened'
    )).all()).toHaveLength(1);
  });

  it('rejects strict caller authority, stale freshness, and exact digest drift', () => {
    const seed = seedPositiveChallenge();
    const { establishment } = establishChallengeBatch(seed);
    const { input } = challengeBatchApplicationInput(seed, establishment.establishmentRef);
    expectChallengeBatchApplicationError(
      () => applyInvestigationChallengeBatch(connection.db, { ...input, lot: 'MFT99' }, context),
      'INVALID_INPUT'
    );
    expectChallengeBatchApplicationError(
      () => applyInvestigationChallengeBatch(connection.db, input, { mode: 'disabled' }),
      'FORBIDDEN'
    );
    expectChallengeBatchApplicationError(
      () => applyInvestigationChallengeBatch(connection.db, {
        ...input,
        expectedCaseVersion: input.expectedCaseVersion + 1
      }, context),
      'STALE_CASE_VERSION'
    );
    recordEvidence(
      seed.knownSnapshot,
      seed.questionRef,
      'evidence:challenge-application:drift',
      'EXTERNAL_PARTY',
      'MFT24'
    );
    expectChallengeBatchApplicationError(
      () => applyInvestigationChallengeBatch(connection.db, input, context),
      'STALE_APPLICATION_BASIS'
    );
  });

  it('enforces positive replay/collisions and reciprocal conflict exclusivity', () => {
    const seed = seedPositiveChallenge();
    const { establishment } = establishChallengeBatch(seed);
    const { input } = challengeBatchApplicationInput(seed, establishment.establishmentRef);
    applyInvestigationChallengeBatch(connection.db, input, context, nextDate());
    expectChallengeBatchApplicationError(
      () => applyInvestigationChallengeBatch(connection.db, {
        ...input,
        rationale: 'Different immutable human semantics.'
      }, context),
      'APPLICATION_CONFLICT'
    );
    expectChallengeBatchApplicationError(
      () => applyInvestigationChallengeBatch(connection.db, {
        ...input,
        applicationRef: randomUUID()
      }, context),
      'CHALLENGE_ALREADY_APPLIED'
    );

    try {
      applyInvestigationChallengeConflict(connection.db, {
        applicationRef: randomUUID(),
        caseId: seed.knownSnapshot.caseId,
        questionRef: seed.questionRef,
        challengeRef: seed.challengeRef,
        expectedCaseVersion: seed.knownSnapshot.caseVersion,
        expectedMaterialRevision: seed.knownSnapshot.materialRevision!,
        expectedApplicationBasisDigest: `sha256:${'0'.repeat(64)}`,
        rationale: 'Attempted competing conflict resolution.',
        demo: true
      }, context);
      throw new Error('Expected reciprocal conflict exclusion.');
    } catch (error) {
      expect(error).toBeInstanceOf(InvestigationChallengeConflictApplicationError);
      expect((error as InvestigationChallengeConflictApplicationError).code)
        .toBe('CHALLENGE_RESOLUTION_CONFLICT');
    }
  });

  it('rejects a positive application when the same Challenge already has conflict authority', () => {
    const seed = seedPositiveChallenge({ targetLot: 'MFT25' });
    const rejection = recordChallengeAssessment(seed, {
      verdict: 'REJECTED',
      targetClaimRef: seed.baselineClaim.claimRef,
      assessorKind: 'RULE'
    });
    const { establishment } = establishChallengeBatch(seed);
    recordChallengeAssessment(seed, {
      verdict: 'SUPPORTED',
      targetClaimRef: seed.baselineClaim.claimRef,
      assessorKind: 'HUMAN',
      supersedesAssessmentRef: rejection.assessmentRef
    });
    recordChallengeAssessment(seed, {
      verdict: 'CONTRADICTED',
      targetClaimRef: null,
      relatedClaimRefs: [seed.baselineClaim.claimRef, seed.targetClaim.claimRef],
      assessorKind: 'HUMAN'
    });
    const conflictBasis = readChallengeConflictApplicationBasis(
      connection.db,
      seed.knownSnapshot.caseId,
      seed.questionRef,
      seed.challengeRef
    );
    expect(conflictBasis.eligibility.eligible).toBe(true);
    const conflictInput = {
      applicationRef: randomUUID(),
      caseId: seed.knownSnapshot.caseId,
      questionRef: seed.questionRef,
      challengeRef: seed.challengeRef,
      expectedCaseVersion: seed.knownSnapshot.caseVersion,
      expectedMaterialRevision: seed.knownSnapshot.materialRevision!,
      expectedApplicationBasisDigest: conflictBasis.applicationBasisDigest,
      rationale: 'Reviewed the exact competing conflict basis.',
      demo: true as const
    };
    const conflict = applyInvestigationChallengeConflict(
      connection.db,
      conflictInput,
      context,
      nextDate()
    );
    expect(conflict.replayed).toBe(false);
    expect(applyInvestigationChallengeConflict(
      connection.db,
      { ...conflictInput, expectedCaseVersion: 999 },
      context,
      nextDate()
    )).toEqual({ ...conflict, replayed: true });

    const positiveInput = {
      applicationRef: randomUUID(),
      caseId: seed.knownSnapshot.caseId,
      questionRef: seed.questionRef,
      challengeRef: seed.challengeRef,
      establishmentRef: establishment.establishmentRef,
      expectedCaseVersion: seed.knownSnapshot.caseVersion,
      expectedMaterialRevision: seed.knownSnapshot.materialRevision!,
      expectedApplicationBasisDigest: `sha256:${'0'.repeat(64)}`,
      rationale: 'Attempted competing positive resolution.',
      demo: true as const
    };
    expectChallengeBatchApplicationError(
      () => applyInvestigationChallengeBatch(connection.db, positiveInput, context),
      'CHALLENGE_RESOLUTION_CONFLICT'
    );
  });

  it('rolls back all lifecycle writes when positive provenance insertion fails', () => {
    const seed = seedPositiveChallenge();
    const { establishment } = establishChallengeBatch(seed);
    const { input } = challengeBatchApplicationInput(seed, establishment.establishmentRef);
    const before = protectedState(seed.knownSnapshot.caseId);
    const auditBefore = connection.db.select().from(schema.auditEvents).all();
    connection.sqlite.exec(`
      create trigger force_positive_challenge_application_failure
      before insert on investigation_challenge_batch_applications
      begin
        select raise(abort, 'forced positive application failure');
      end;
    `);
    expect(() => applyInvestigationChallengeBatch(connection.db, input, context, nextDate()))
      .toThrow('forced positive application failure');
    expect(protectedState(seed.knownSnapshot.caseId)).toEqual(before);
    expect(connection.db.select().from(schema.auditEvents).all()).toEqual(auditBefore);
    expect(connection.db.select().from(schema.investigationChallengeBatchApplications).all())
      .toEqual([]);
  });

  it('leaves no application or lifecycle side effect when case revision persistence fails', () => {
    const seed = seedPositiveChallenge();
    const { establishment } = establishChallengeBatch(seed);
    const { input } = challengeBatchApplicationInput(seed, establishment.establishmentRef);
    const before = protectedState(seed.knownSnapshot.caseId);
    const auditBefore = connection.db.select().from(schema.auditEvents).all();
    connection.sqlite.exec(`
      create trigger force_positive_challenge_revision_failure
      before insert on case_revisions
      begin
        select raise(abort, 'forced positive revision failure');
      end;
    `);
    expect(() => applyInvestigationChallengeBatch(connection.db, input, context, nextDate()))
      .toThrow('forced positive revision failure');
    expect(protectedState(seed.knownSnapshot.caseId)).toEqual(before);
    expect(connection.db.select().from(schema.auditEvents).all()).toEqual(auditBefore);
    expect(connection.db.select().from(schema.investigationChallengeBatchApplications).all())
      .toEqual([]);
  });

  it('enforces restrictive parents, persists after reopen, and resets before parents', () => {
    const seed = seedPositiveChallenge();
    const { establishment } = establishChallengeBatch(seed);
    const { input } = challengeBatchApplicationInput(seed, establishment.establishmentRef);
    applyInvestigationChallengeBatch(connection.db, input, context, nextDate());
    expect(() => connection.db.delete(schema.investigationChallengeEstablishments).where(eq(
      schema.investigationChallengeEstablishments.establishmentRef,
      establishment.establishmentRef
    )).run()).toThrow();
    const path = connection.sqlite.name;
    connection.sqlite.close();
    connection = createDatabaseConnection(path);
    expect(getInvestigationChallengeBatchApplication(
      connection.db,
      input.caseId,
      input.applicationRef
    )).not.toBeNull();
    expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(() => clearDemoData(connection.db)).not.toThrow();
    expect(connection.db.select().from(schema.investigationChallengeBatchApplications).all())
      .toEqual([]);
    expect(() => seedDemoData(connection.db, fixtures)).not.toThrow();
  });

  it('fails closed when immutable JSON or HUMAN/demo database invariants are corrupted', () => {
    const seed = seedPositiveChallenge();
    const { establishment } = establishChallengeBatch(seed);
    const { input } = challengeBatchApplicationInput(seed, establishment.establishmentRef);
    applyInvestigationChallengeBatch(connection.db, input, context, nextDate());
    expect(() => connection.db.update(schema.investigationChallengeBatchApplications).set({
      demo: false
    }).where(eq(
      schema.investigationChallengeBatchApplications.applicationRef,
      input.applicationRef
    )).run()).toThrow();
    expect(() => connection.sqlite.prepare(
      'update investigation_challenge_batch_applications set actor_kind = ? where application_ref = ?'
    ).run('AI', input.applicationRef)).toThrow();
    expect(() => connection.sqlite.prepare(
      `update investigation_challenge_batch_applications
       set resulting_material_revision = source_material_revision + 2
       where application_ref = ?`
    ).run(input.applicationRef)).toThrow();
    expect(() => connection.sqlite.prepare(
      'update investigation_challenge_batch_applications set basis_digest = ? where application_ref = ?'
    ).run(`sha256:${'A'.repeat(64)}`, input.applicationRef)).toThrow();
    connection.db.update(schema.investigationChallengeBatchApplications).set({
      reviewedClaimRefsJson: JSON.stringify([
        seed.targetClaim.claimRef,
        seed.baselineClaim.claimRef
      ].sort().reverse())
    }).where(eq(
      schema.investigationChallengeBatchApplications.applicationRef,
      input.applicationRef
    )).run();
    expectChallengeBatchApplicationError(
      () => getInvestigationChallengeBatchApplication(
        connection.db,
        input.caseId,
        input.applicationRef
      ),
      'APPLICATION_PROVENANCE_INVALID'
    );
  });

  it('upgrades populated 0014 state additively and reruns migration safely', () => {
    const preApplicationFolder = join(directory, 'pre-positive-application-migrations');
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
      '0011_confused_hannibal_king.sql',
      '0012_stiff_squadron_supreme.sql',
      '0013_tricky_amazoness.sql',
      '0014_sour_firelord.sql'
    ]) cpSync(join('drizzle', file), join(preApplicationFolder, file));
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 15);
    writeFileSync(join(preApplicationFolder, 'meta/_journal.json'), JSON.stringify(journal));

    const existing = createDatabaseConnection(join(directory, 'populated-0014.db'));
    try {
      migrate(existing.db, { migrationsFolder: preApplicationFolder });
      seedDemoData(existing.db, fixtures);
      expect(existing.sqlite.prepare(
        "select name from sqlite_master where type = 'table' and name = ?"
      ).get('investigation_challenge_batch_applications')).toBeUndefined();
      const productsBefore = existing.db.select().from(schema.products).all();
      const alertsBefore = existing.db.select().from(schema.alerts).all();
      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      expect(existing.db.select().from(schema.products).all()).toEqual(productsBefore);
      expect(existing.db.select().from(schema.alerts).all()).toEqual(alertsBefore);
      expect(existing.db.select().from(schema.investigationChallengeBatchApplications).all())
        .toEqual([]);
      expect(existing.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      existing.sqlite.close();
    }
  });
});
