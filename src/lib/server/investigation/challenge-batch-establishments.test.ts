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
  evaluateCurrentInvestigationChallengeBatchEstablishment,
  evaluateCurrentInvestigationChallengeBatchEstablishmentInTransaction,
  evaluateDemoChallengeBatchEstablishmentPolicy,
  getInvestigationChallengeBatchEstablishment,
  InvestigationChallengeBatchEstablishmentError,
  recordInvestigationChallengeBatchEstablishment
} from './challenge-batch-establishments';
import {
  getInvestigationAssessmentChallengeRef,
  getInvestigationClaimChallengeRef
} from './challenge-artifacts';
import { openInvestigationChallenge } from './challenges';
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
