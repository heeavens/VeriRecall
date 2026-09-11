import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';

import type { InvestigationOutcome } from '../../contracts/recall';
import { normalizeBatch } from '../alerts/normalization';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { listInvestigationAssessments } from './assessments';
import {
  getInvestigationAssessmentChallengeRef,
  getInvestigationClaimChallengeRef,
  getInvestigationEstablishmentChallengeRef
} from './challenge-artifacts';
import {
  demoChallengeBatchEstablishmentPolicy,
  evaluateCurrentInvestigationChallengeBatchEstablishmentInTransaction,
  type CurrentChallengeBatchEstablishmentBlockerCode,
  type DemoChallengeBatchEstablishmentBasis
} from './challenge-batch-establishments';
import {
  canonicalChallengeAnalysisState,
  type ChallengeConflictApplicationAnalysisState
} from './challenge-conflict-basis';
import { getInvestigationChallenge } from './challenges';
import { getInvestigationClaim, listInvestigationClaims } from './claims';
import {
  readChallengeEffectiveInvestigationAnalysisInTransaction,
  EffectiveAnalysisError,
  type ChallengeEffectiveInvestigationAnalysis
} from './effective-analysis';
import { listInvestigationEvidence } from './evidence-registry';
import type { InvestigationEstablishment } from './establishments';
import { getInvestigationQuestion } from './questions';

export const challengeBatchApplicationBasisFormatVersion =
  'challenge-batch-application-basis/v1' as const;
export const challengeBatchApplicationPolicy = {
  identifier: 'demo-challenge-batch-human-application-policy',
  version: 'v1'
} as const;

export const challengeBatchApplicationBlockerCodes = [
  'QUESTION_OWNERSHIP_MISMATCH',
  'CHALLENGE_ASSOCIATION_MISMATCH',
  'CHALLENGE_NOT_CURRENT',
  'AUTHORITATIVE_SOURCE_NOT_KNOWN_BATCH',
  'OTHER_AUTHORITATIVE_UNCERTAINTY_PRESENT',
  'ESTABLISHMENT_NOT_CURRENTLY_ELIGIBLE',
  'ESTABLISHMENT_BASIS_MISMATCH',
  'TARGET_CLAIM_INVALID',
  'LOT_EMPTY',
  'QUALIFYING_SUPPORT_REQUIRED',
  'CONFLICT_APPLICATION_EXISTS',
  'POSITIVE_APPLICATION_EXISTS',
  'NOT_DEMO'
] as const;

export type ChallengeBatchApplicationBlockerCode =
  typeof challengeBatchApplicationBlockerCodes[number];

type Investigation = NonNullable<ReturnType<typeof readCaseSnapshot>>['investigation'];
type Issue = InvestigationOutcome['gaps'][number];
type Stage = NonNullable<ReturnType<typeof readCaseSnapshot>>['stage'];

export interface ChallengeBatchApplicationBasis {
  basisFormatVersion: typeof challengeBatchApplicationBasisFormatVersion;
  applicationPolicyIdentifier: typeof challengeBatchApplicationPolicy.identifier;
  applicationPolicyVersion: typeof challengeBatchApplicationPolicy.version;
  caseId: string;
  productId: string;
  questionRef: string;
  challengeRef: string;
  establishmentRef: string;
  claimRef: string;
  currentCaseVersion: number;
  currentMaterialRevision: number;
  currentStage: Stage;
  authoritativeContext: InvestigationOutcome;
  challengeAnchor: {
    challengedRevisionId: string;
    challengedMaterialRevision: number;
    openedCaseVersion: number;
    triggerEvidenceRefs: string[];
    openedByKind: 'HUMAN';
    openedByIdentifier: string;
    rationale: string;
    createdAt: string;
    demo: true;
  };
  analysisContext: ChallengeEffectiveInvestigationAnalysis['analysisContext'] | null;
  projectionBasis: ChallengeEffectiveInvestigationAnalysis['projectionBasis'] | null;
  analysisState: ChallengeConflictApplicationAnalysisState | null;
  firstCyclePartitions: {
    claims: Array<{ claimRef: string; partition: 'BASELINE' | 'SELECTED_CHALLENGE' }>;
    assessments: Array<{
      assessmentRef: string;
      partition: 'BASELINE' | 'SELECTED_CHALLENGE';
    }>;
  };
  completeEvidenceRefs: string[];
  establishment: {
    policyIdentifier: string;
    policyVersion: string;
    evaluatorKind: 'RULE';
    evaluatorIdentifier: string;
    basisCaseVersion: number;
    basisMaterialRevision: number;
    basisClaimRefs: string[];
    basisAssessmentRefs: string[];
    basisEvidenceRefs: string[];
    createdAt: string;
    demo: boolean;
  };
  currentEvaluation: {
    currentlyEligible: boolean;
    blockerCodes: CurrentChallengeBatchEstablishmentBlockerCode[];
    basis: DemoChallengeBatchEstablishmentBasis | null;
    targetLot: string | null;
    qualifyingTargetSupportAssessmentRefs: string[];
    reliedUponRejectionAssessmentRefs: string[];
  };
  currentArtifactRefs: {
    claimRefs: string[];
    assessmentRefs: string[];
    evidenceRefs: string[];
  };
  targetClaim: {
    claimRef: string;
    claimType: 'AFFECTED_BATCH_LOT';
    rawLot: string;
    normalizedLot: string;
    originKind: 'DETERMINISTIC_EXTRACTED' | 'AI_PROPOSED' | 'HUMAN_OBSERVED';
    producerIdentifier: string;
    evidenceRefs: string[];
    challengeRef: string | null;
    demo: boolean;
  } | null;
  resolutionKind: 'REAFFIRM' | 'REPLACE' | null;
  currentAuthoritativeNormalizedLot: string | null;
  targetNormalizedLot: string | null;
  reviewedClaimRefs: string[];
  reviewedAssessmentRefs: string[];
  reviewedEvidenceRefs: string[];
  appliedAssessmentRefs: string[];
  appliedEvidenceRefs: string[];
  resultBaselineClaimRefs: string[];
  resultBaselineAssessmentRefs: string[];
  resultBaselineEvidenceRefs: string[];
  occupancy: {
    positiveApplicationRefForChallenge: string | null;
    positiveApplicationRefForEstablishment: string | null;
    conflictApplicationRefForChallenge: string | null;
  };
  eligibility: {
    eligible: boolean;
    blockerCodes: ChallengeBatchApplicationBlockerCode[];
  };
  applicationBasisDigest: string;
}

type BasisWithoutDigest = Omit<ChallengeBatchApplicationBasis, 'applicationBasisDigest'>;

export type ChallengeBatchApplicationBasisErrorCode =
  | 'ESTABLISHMENT_NOT_FOUND'
  | 'CHALLENGE_NOT_FOUND'
  | 'APPLICATION_BASIS_INVALID';

export class ChallengeBatchApplicationBasisError extends Error {
  constructor(
    public readonly code: ChallengeBatchApplicationBasisErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ChallengeBatchApplicationBasisError';
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameReferences(left: readonly string[], right: readonly string[]): boolean {
  const canonicalLeft = sortedUnique(left);
  const canonicalRight = sortedUnique(right);
  return canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestBasis(value: BasisWithoutDigest): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalIssue(issue: Issue): Issue {
  return {
    ...structuredClone(issue),
    subjectRefs: sortedUnique(issue.subjectRefs),
    evidenceRefs: sortedUnique(issue.evidenceRefs)
  };
}

function canonicalIssues(issues: readonly Issue[]): Issue[] {
  return issues.map(canonicalIssue).sort((left, right) =>
    compareText(left.id, right.id) || compareText(left.code, right.code)
  );
}

function canonicalIdentity(identity: NonNullable<Investigation>['identity']) {
  return {
    ...structuredClone(identity),
    evidenceRefs: sortedUnique(identity.evidenceRefs),
    decisionRefs: sortedUnique(identity.decisionRefs)
  };
}

function canonicalScope(scope: NonNullable<Investigation>['scope']) {
  return scope.kind === 'BATCH_LOT'
    ? {
        ...structuredClone(scope),
        lots: sortedUnique(scope.lots),
        evidenceRefs: sortedUnique(scope.evidenceRefs),
        decisionRefs: sortedUnique(scope.decisionRefs)
      }
    : {
        ...structuredClone(scope),
        evidenceRefs: sortedUnique(scope.evidenceRefs),
        decisionRefs: sortedUnique(scope.decisionRefs)
      };
}

function canonicalBasis(basis: DemoChallengeBatchEstablishmentBasis | null) {
  return basis ? {
    claimRefs: sortedUnique(basis.claimRefs),
    assessmentRefs: sortedUnique(basis.assessmentRefs),
    evidenceRefs: sortedUnique(basis.evidenceRefs)
  } : null;
}

function establishmentSummary(establishment: InvestigationEstablishment) {
  return {
    policyIdentifier: establishment.policyIdentifier,
    policyVersion: establishment.policyVersion,
    evaluatorKind: establishment.evaluatorKind,
    evaluatorIdentifier: establishment.evaluatorIdentifier,
    basisCaseVersion: establishment.basisCaseVersion,
    basisMaterialRevision: establishment.basisMaterialRevision,
    basisClaimRefs: sortedUnique(establishment.basisClaimRefs),
    basisAssessmentRefs: sortedUnique(establishment.basisAssessmentRefs),
    basisEvidenceRefs: sortedUnique(establishment.basisEvidenceRefs),
    createdAt: establishment.createdAt,
    demo: establishment.demo
  };
}

/** Derive the HUMAN-reviewable positive Challenge basis in the caller's transaction. */
export function readChallengeBatchApplicationBasisInTransaction(
  database: RecallDatabase,
  caseId: string,
  questionRef: string,
  challengeRef: string,
  establishmentRef: string
): ChallengeBatchApplicationBasis {
  const evaluation = evaluateCurrentInvestigationChallengeBatchEstablishmentInTransaction(
    database,
    caseId,
    establishmentRef
  );
  if (!evaluation) {
    throw new ChallengeBatchApplicationBasisError(
      'ESTABLISHMENT_NOT_FOUND',
      'The requested Challenge batch Establishment does not exist for this case.'
    );
  }
  const establishment = evaluation.establishment;
  if (
    establishment.questionRef !== questionRef ||
    evaluation.challengeRef !== challengeRef ||
    getInvestigationEstablishmentChallengeRef(database, establishmentRef) !== challengeRef
  ) {
    throw new ChallengeBatchApplicationBasisError(
      'APPLICATION_BASIS_INVALID',
      'The Establishment does not belong to the requested Question and Challenge.'
    );
  }
  const challenge = getInvestigationChallenge(database, caseId, challengeRef);
  if (!challenge) {
    throw new ChallengeBatchApplicationBasisError(
      'CHALLENGE_NOT_FOUND',
      'The requested investigation Challenge does not exist for this case.'
    );
  }
  if (challenge.questionRef !== questionRef) {
    throw new ChallengeBatchApplicationBasisError(
      'APPLICATION_BASIS_INVALID',
      'The Challenge does not belong to the requested permanent Question.'
    );
  }
  const snapshot = readCaseSnapshot(database, caseId);
  if (!snapshot?.investigation || snapshot.materialRevision === null) {
    throw new ChallengeBatchApplicationBasisError(
      'APPLICATION_BASIS_INVALID',
      'A current versioned InvestigationOutcome is required.'
    );
  }

  const question = getInvestigationQuestion(database, caseId, questionRef);
  const target = getInvestigationClaim(database, caseId, establishment.claimRef);
  const claims = listInvestigationClaims(database, caseId, questionRef);
  const assessments = listInvestigationAssessments(database, caseId, questionRef);
  const evidence = listInvestigationEvidence(database, caseId, questionRef);
  let projection: ChallengeEffectiveInvestigationAnalysis | null = null;
  try {
    projection = readChallengeEffectiveInvestigationAnalysisInTransaction(
      database,
      caseId,
      questionRef,
      challengeRef
    );
  } catch (error) {
    if (error instanceof EffectiveAnalysisError && error.code === 'CHALLENGE_NOT_CURRENT') {
      projection = null;
    } else {
      throw error;
    }
  }

  const positiveForChallenge = database.select({
    applicationRef: schema.investigationChallengeBatchApplications.applicationRef
  }).from(schema.investigationChallengeBatchApplications).where(eq(
    schema.investigationChallengeBatchApplications.challengeRef,
    challengeRef
  )).get()?.applicationRef ?? null;
  const positiveForEstablishment = database.select({
    applicationRef: schema.investigationChallengeBatchApplications.applicationRef
  }).from(schema.investigationChallengeBatchApplications).where(eq(
    schema.investigationChallengeBatchApplications.establishmentRef,
    establishmentRef
  )).get()?.applicationRef ?? null;
  const conflictForChallenge = database.select({
    applicationRef: schema.investigationChallengeConflictApplications.applicationRef
  }).from(schema.investigationChallengeConflictApplications).where(eq(
    schema.investigationChallengeConflictApplications.challengeRef,
    challengeRef
  )).get()?.applicationRef ?? null;

  const blockers = new Set<ChallengeBatchApplicationBlockerCode>();
  if (
    !question ||
    question.questionType !== 'AFFECTED_BATCH_LOT' ||
    question.caseId !== caseId ||
    question.subjectRef !== snapshot.productId ||
    establishment.caseId !== caseId ||
    establishment.questionRef !== questionRef
  ) {
    blockers.add('QUESTION_OWNERSHIP_MISMATCH');
  }
  if (
    challenge.caseId !== caseId ||
    challenge.questionRef !== questionRef ||
    evaluation.challengeRef !== challengeRef
  ) {
    blockers.add('CHALLENGE_ASSOCIATION_MISMATCH');
  }
  if (projection === null) {
    blockers.add('CHALLENGE_NOT_CURRENT');
  }

  const investigation = snapshot.investigation;
  let currentAuthoritativeNormalizedLot: string | null = null;
  if (
    investigation.knowledgeStatus !== 'KNOWN' ||
    investigation.identity.knowledgeStatus !== 'KNOWN' ||
    investigation.identity.conclusion !== 'MATCH' ||
    investigation.scope.kind !== 'BATCH_LOT' ||
    investigation.scope.knowledgeStatus !== 'KNOWN'
  ) {
    blockers.add('AUTHORITATIVE_SOURCE_NOT_KNOWN_BATCH');
  } else {
    const lots = sortedUnique(investigation.scope.lots.map(normalizeBatch));
    if (lots.length !== 1 || lots[0].length === 0) {
      blockers.add('AUTHORITATIVE_SOURCE_NOT_KNOWN_BATCH');
    } else {
      currentAuthoritativeNormalizedLot = lots[0];
    }
  }
  if (investigation.gaps.length > 0 || investigation.conflicts.length > 0) {
    blockers.add('OTHER_AUTHORITATIVE_UNCERTAINTY_PRESENT');
  }
  if (!evaluation.currentlyEligible) {
    blockers.add('ESTABLISHMENT_NOT_CURRENTLY_ELIGIBLE');
  }
  if (
    !evaluation.currentBasis ||
    !sameReferences(evaluation.currentBasis.claimRefs, establishment.basisClaimRefs) ||
    !sameReferences(evaluation.currentBasis.assessmentRefs, establishment.basisAssessmentRefs) ||
    !sameReferences(evaluation.currentBasis.evidenceRefs, establishment.basisEvidenceRefs)
  ) {
    blockers.add('ESTABLISHMENT_BASIS_MISMATCH');
  }
  const targetChallengeRef = target
    ? getInvestigationClaimChallengeRef(database, target.claimRef)
    : null;
  if (
    !target ||
    target.questionRef !== questionRef ||
    target.subjectRef !== snapshot.productId ||
    target.claimType !== 'AFFECTED_BATCH_LOT' ||
    target.originKind === 'AI_PROPOSED' ||
    targetChallengeRef !== challengeRef
  ) {
    blockers.add('TARGET_CLAIM_INVALID');
  }
  const targetNormalizedLot = target ? normalizeBatch(target.value.lot) : '';
  if (targetNormalizedLot.length === 0) blockers.add('LOT_EMPTY');
  if (evaluation.qualifyingTargetSupportAssessmentRefs.length === 0) {
    blockers.add('QUALIFYING_SUPPORT_REQUIRED');
  }
  if (conflictForChallenge !== null) blockers.add('CONFLICT_APPLICATION_EXISTS');
  if (positiveForChallenge !== null || positiveForEstablishment !== null) {
    blockers.add('POSITIVE_APPLICATION_EXISTS');
  }
  if (
    !snapshot.demo ||
    !question?.demo ||
    !challenge.demo ||
    !establishment.demo ||
    !target?.demo ||
    claims.some((claim) => !claim.demo) ||
    assessments.some((assessment) => !assessment.demo) ||
    evidence.some((item) => !item.demo) ||
    establishment.policyIdentifier !== demoChallengeBatchEstablishmentPolicy.policyIdentifier ||
    establishment.policyVersion !== demoChallengeBatchEstablishmentPolicy.policyVersion ||
    establishment.evaluatorKind !== demoChallengeBatchEstablishmentPolicy.evaluatorKind ||
    establishment.evaluatorIdentifier !== demoChallengeBatchEstablishmentPolicy.evaluatorIdentifier
  ) {
    blockers.add('NOT_DEMO');
  }

  const reviewedClaimRefs = sortedUnique(establishment.basisClaimRefs);
  const reviewedAssessmentRefs = sortedUnique(establishment.basisAssessmentRefs);
  const reviewedEvidenceRefs = sortedUnique(establishment.basisEvidenceRefs);
  const qualifyingSupportRefs = sortedUnique(
    evaluation.qualifyingTargetSupportAssessmentRefs
  );
  const reliedUponRejectionRefs = sortedUnique(
    evaluation.reliedUponRejectionAssessmentRefs
  );
  const appliedAssessmentRefs = sortedUnique([
    ...qualifyingSupportRefs,
    ...reliedUponRejectionRefs
  ]);
  const resultBaselineClaimRefs = target ? [target.claimRef] : [];
  const resolutionKind = currentAuthoritativeNormalizedLot !== null && targetNormalizedLot.length > 0
    ? currentAuthoritativeNormalizedLot === targetNormalizedLot ? 'REAFFIRM' : 'REPLACE'
    : null;
  const includedClaimRefs = new Set(projection?.projectionBasis.claimRefs ?? []);
  const includedAssessmentRefs = new Set(projection?.projectionBasis.assessmentRefs ?? []);

  const basis: BasisWithoutDigest = {
    basisFormatVersion: challengeBatchApplicationBasisFormatVersion,
    applicationPolicyIdentifier: challengeBatchApplicationPolicy.identifier,
    applicationPolicyVersion: challengeBatchApplicationPolicy.version,
    caseId,
    productId: snapshot.productId,
    questionRef,
    challengeRef,
    establishmentRef,
    claimRef: establishment.claimRef,
    currentCaseVersion: snapshot.caseVersion,
    currentMaterialRevision: snapshot.materialRevision,
    currentStage: snapshot.stage,
    authoritativeContext: {
      ...structuredClone(investigation),
      identity: canonicalIdentity(investigation.identity),
      scope: canonicalScope(investigation.scope),
      evidenceRefs: sortedUnique(investigation.evidenceRefs),
      decisionRefs: sortedUnique(investigation.decisionRefs),
      gaps: canonicalIssues(investigation.gaps),
      conflicts: canonicalIssues(investigation.conflicts),
      demo: investigation.demo
    },
    challengeAnchor: {
      challengedRevisionId: challenge.challengedRevisionId,
      challengedMaterialRevision: challenge.challengedMaterialRevision,
      openedCaseVersion: challenge.openedCaseVersion,
      triggerEvidenceRefs: sortedUnique(challenge.triggerEvidenceRefs),
      openedByKind: challenge.openedByKind,
      openedByIdentifier: challenge.openedByIdentifier,
      rationale: challenge.rationale,
      createdAt: challenge.createdAt,
      demo: challenge.demo
    },
    analysisContext: projection ? structuredClone(projection.analysisContext) : null,
    projectionBasis: projection ? {
      claimRefs: sortedUnique(projection.projectionBasis.claimRefs),
      assessmentRefs: sortedUnique(projection.projectionBasis.assessmentRefs),
      referencedEvidenceRefs: sortedUnique(projection.projectionBasis.referencedEvidenceRefs)
    } : null,
    analysisState: projection ? canonicalChallengeAnalysisState(projection) : null,
    firstCyclePartitions: {
      claims: claims.filter((claim) => includedClaimRefs.has(claim.claimRef)).map((claim) => ({
        claimRef: claim.claimRef,
        partition: getInvestigationClaimChallengeRef(database, claim.claimRef) === challengeRef
          ? 'SELECTED_CHALLENGE' as const
          : 'BASELINE' as const
      })).sort((left, right) => compareText(left.claimRef, right.claimRef)),
      assessments: assessments
        .filter((assessment) => includedAssessmentRefs.has(assessment.assessmentRef))
        .map((assessment) => ({
          assessmentRef: assessment.assessmentRef,
          partition: getInvestigationAssessmentChallengeRef(database, assessment.assessmentRef) ===
              challengeRef
            ? 'SELECTED_CHALLENGE' as const
            : 'BASELINE' as const
        })).sort((left, right) => compareText(left.assessmentRef, right.assessmentRef))
    },
    completeEvidenceRefs: sortedUnique(evidence.map((item) => item.evidenceRef)),
    establishment: establishmentSummary(establishment),
    currentEvaluation: {
      currentlyEligible: evaluation.currentlyEligible,
      blockerCodes: [...evaluation.blockerCodes],
      basis: canonicalBasis(evaluation.currentBasis),
      targetLot: evaluation.targetLot,
      qualifyingTargetSupportAssessmentRefs: qualifyingSupportRefs,
      reliedUponRejectionAssessmentRefs: reliedUponRejectionRefs
    },
    currentArtifactRefs: {
      claimRefs: sortedUnique(claims.map((claim) => claim.claimRef)),
      assessmentRefs: sortedUnique(assessments.map((assessment) => assessment.assessmentRef)),
      evidenceRefs: sortedUnique(evidence.map((item) => item.evidenceRef))
    },
    targetClaim: target ? {
      claimRef: target.claimRef,
      claimType: target.claimType,
      rawLot: target.value.lot,
      normalizedLot: targetNormalizedLot,
      originKind: target.originKind,
      producerIdentifier: target.producerIdentifier,
      evidenceRefs: sortedUnique(target.evidenceRefs),
      challengeRef: targetChallengeRef,
      demo: target.demo
    } : null,
    resolutionKind,
    currentAuthoritativeNormalizedLot,
    targetNormalizedLot: targetNormalizedLot.length > 0 ? targetNormalizedLot : null,
    reviewedClaimRefs,
    reviewedAssessmentRefs,
    reviewedEvidenceRefs,
    appliedAssessmentRefs,
    appliedEvidenceRefs: reviewedEvidenceRefs,
    resultBaselineClaimRefs,
    resultBaselineAssessmentRefs: qualifyingSupportRefs,
    resultBaselineEvidenceRefs: reviewedEvidenceRefs,
    occupancy: {
      positiveApplicationRefForChallenge: positiveForChallenge,
      positiveApplicationRefForEstablishment: positiveForEstablishment,
      conflictApplicationRefForChallenge: conflictForChallenge
    },
    eligibility: {
      eligible: blockers.size === 0,
      blockerCodes: challengeBatchApplicationBlockerCodes.filter((code) => blockers.has(code))
    }
  };
  return { ...basis, applicationBasisDigest: digestBasis(basis) };
}

export function readChallengeBatchApplicationBasis(
  database: RecallDatabase,
  caseId: string,
  questionRef: string,
  challengeRef: string,
  establishmentRef: string
): ChallengeBatchApplicationBasis {
  return database.transaction((transaction) =>
    readChallengeBatchApplicationBasisInTransaction(
      transaction,
      caseId,
      questionRef,
      challengeRef,
      establishmentRef
    )
  );
}
