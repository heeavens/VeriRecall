import { createHash } from 'node:crypto';

import { normalizeBatch } from '../alerts/normalization';
import type { RecallDatabase } from '../db/repositories';
import {
  getInvestigationAssessmentChallengeRef,
  getInvestigationClaimChallengeRef
} from './challenge-artifacts';
import {
  readChallengeEffectiveInvestigationAnalysisInTransaction,
  type AnalysisAmbiguity,
  type AssessmentStaleReason,
  type ChallengeEffectiveInvestigationAnalysis,
  type InvestigationPartitionEffectiveAnalysis,
  type TargetedAssessmentState
} from './effective-analysis';
import { listInvestigationEvidence } from './evidence-registry';
import type { AppliedChallengeBatchBaseline } from './authoritative-challenge-baseline';
import {
  challengeConflictApplicationBasisFormatVersion,
  challengeConflictApplicationPolicy,
  inheritedChallengeConflictApplicationBasisFormatVersion,
  inheritedChallengeConflictApplicationPolicy
} from './challenge-conflict-application-policy';

export {
  challengeConflictApplicationBasisFormatVersion,
  challengeConflictApplicationPolicy,
  inheritedChallengeConflictApplicationBasisFormatVersion,
  inheritedChallengeConflictApplicationPolicy
} from './challenge-conflict-application-policy';

export const challengeConflictApplicationBlockerCodes = [
  'NO_CURRENT_CONTRADICTION',
  'MULTIPLE_CURRENT_CONTRADICTIONS',
  'CONTRADICTION_NOT_CHALLENGE_SCOPED',
  'CONTRADICTION_ASSESSOR_NOT_ALLOWED',
  'CONTRADICTION_DOES_NOT_COVER_ALL_ACTIVE_CLAIMS',
  'BASELINE_CLAIM_REQUIRED',
  'CHALLENGE_CLAIM_REQUIRED',
  'DISTINCT_LOTS_REQUIRED',
  'UNREVIEWED_EVIDENCE_PRESENT',
  'ACTIVE_CLAIM_REJECTED',
  'ACTIVE_CLAIM_INSUFFICIENT',
  'QUESTION_INSUFFICIENT',
  'BLOCKING_AMBIGUITY'
] as const;

export type ChallengeConflictApplicationBlockerCode =
  typeof challengeConflictApplicationBlockerCodes[number];

export interface ChallengeConflictApplicationQualifyingConflict {
  contradictionAssessmentRef: string;
  relatedClaimRefs: string[];
  evidenceRefs: string[];
  baselineClaimRefs: string[];
  challengeClaimRefs: string[];
  distinctNormalizedLots: string[];
}

export interface ChallengeConflictApplicationAnalysisState {
  activeClaimRefs: string[];
  inactiveClaimRefs: string[];
  structuralAssessmentRefs: string[];
  applicableAssessmentRefs: string[];
  materiallyCurrentAssessmentRefs: string[];
  staleAssessments: Array<{
    assessmentRef: string;
    reasons: AssessmentStaleReason[];
  }>;
  targetedAssessments: TargetedAssessmentState[];
  questionLevelInsufficientAssessmentRefs: string[];
  activeContradictions: Array<{
    assessmentRef: string;
    relatedClaimRefs: string[];
  }>;
  ambiguities: AnalysisAmbiguity[];
}

export interface ChallengeConflictApplicationBasis {
  basisFormatVersion:
    | typeof challengeConflictApplicationBasisFormatVersion
    | typeof inheritedChallengeConflictApplicationBasisFormatVersion;
  policyIdentifier: typeof challengeConflictApplicationPolicy.identifier;
  policyVersion:
    | typeof challengeConflictApplicationPolicy.version
    | typeof inheritedChallengeConflictApplicationPolicy.version;
  caseId: string;
  questionRef: string;
  productId: string;
  analysisContext: ChallengeEffectiveInvestigationAnalysis['analysisContext'];
  projectionBasis: ChallengeEffectiveInvestigationAnalysis['projectionBasis'];
  completeEvidenceRefs: string[];
  analysisState: ChallengeConflictApplicationAnalysisState;
  authoritativeBaseline?: AppliedChallengeBatchBaseline;
  eligibility: {
    eligible: boolean;
    blockerCodes: ChallengeConflictApplicationBlockerCode[];
  };
  qualifyingConflict: ChallengeConflictApplicationQualifyingConflict | null;
  applicationBasisDigest: string;
}

type BasisWithoutDigest = Omit<ChallengeConflictApplicationBasis, 'applicationBasisDigest'>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameReferences(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function canonicalTargetedAssessments(
  values: readonly TargetedAssessmentState[]
): TargetedAssessmentState[] {
  return values.map((value) => ({
    claimRef: value.claimRef,
    supportedAssessmentRefs: sortedUnique(value.supportedAssessmentRefs),
    insufficientAssessmentRefs: sortedUnique(value.insufficientAssessmentRefs),
    rejectedAssessmentRefs: sortedUnique(value.rejectedAssessmentRefs)
  })).sort((left, right) => compareText(left.claimRef, right.claimRef));
}

function canonicalAmbiguities(values: readonly AnalysisAmbiguity[]): AnalysisAmbiguity[] {
  return values.map((value) => ({
    code: value.code,
    claimRefs: sortedUnique(value.claimRefs),
    assessmentRefs: sortedUnique(value.assessmentRefs)
  })).sort((left, right) =>
    compareText(left.code, right.code) ||
    compareText(left.claimRefs.join('\u0000'), right.claimRefs.join('\u0000')) ||
    compareText(left.assessmentRefs.join('\u0000'), right.assessmentRefs.join('\u0000'))
  );
}

export function canonicalChallengeAnalysisState(
  projection: InvestigationPartitionEffectiveAnalysis
): ChallengeConflictApplicationAnalysisState {
  const analysis = projection.analysis;
  return {
    activeClaimRefs: sortedUnique(analysis.activeClaims.map((claim) => claim.claimRef)),
    inactiveClaimRefs: sortedUnique(analysis.inactiveClaimRefs),
    structuralAssessmentRefs: sortedUnique(
      analysis.structuralAssessmentHeads.map((assessment) => assessment.assessmentRef)
    ),
    applicableAssessmentRefs: sortedUnique(
      analysis.applicableAssessmentHeads.map((assessment) => assessment.assessmentRef)
    ),
    materiallyCurrentAssessmentRefs: sortedUnique(
      analysis.materiallyCurrentAssessmentHeads.map(
        (assessment) => assessment.assessmentRef
      )
    ),
    staleAssessments: analysis.staleAssessments.map((value) => ({
      assessmentRef: value.assessment.assessmentRef,
      reasons: [...value.reasons].sort(compareText)
    })).sort((left, right) => compareText(left.assessmentRef, right.assessmentRef)),
    targetedAssessments: canonicalTargetedAssessments(analysis.targetedAssessments),
    questionLevelInsufficientAssessmentRefs: sortedUnique(
      analysis.questionLevelInsufficientAssessmentRefs
    ),
    activeContradictions: analysis.activeContradictions.map((value) => ({
      assessmentRef: value.assessmentRef,
      relatedClaimRefs: sortedUnique(value.relatedClaimRefs)
    })).sort((left, right) => compareText(left.assessmentRef, right.assessmentRef)),
    ambiguities: canonicalAmbiguities(analysis.ambiguities)
  };
}

function addBlocker(
  blockers: Set<ChallengeConflictApplicationBlockerCode>,
  blocker: ChallengeConflictApplicationBlockerCode
): void {
  blockers.add(blocker);
}

function orderedBlockers(
  blockers: ReadonlySet<ChallengeConflictApplicationBlockerCode>
): ChallengeConflictApplicationBlockerCode[] {
  return challengeConflictApplicationBlockerCodes.filter((code) => blockers.has(code));
}

function deriveConflictPolicy(
  database: RecallDatabase,
  projection: ChallengeEffectiveInvestigationAnalysis,
  completeEvidenceRefs: readonly string[]
): {
  eligibility: ChallengeConflictApplicationBasis['eligibility'];
  qualifyingConflict: ChallengeConflictApplicationQualifyingConflict | null;
} {
  const blockers = new Set<ChallengeConflictApplicationBlockerCode>();
  const analysis = projection.analysis;
  const contradictionGroups = analysis.activeContradictions;
  if (contradictionGroups.length === 0) addBlocker(blockers, 'NO_CURRENT_CONTRADICTION');
  if (contradictionGroups.length > 1) {
    addBlocker(blockers, 'MULTIPLE_CURRENT_CONTRADICTIONS');
  }
  if (analysis.targetedAssessments.some((value) => value.rejectedAssessmentRefs.length > 0)) {
    addBlocker(blockers, 'ACTIVE_CLAIM_REJECTED');
  }
  if (analysis.targetedAssessments.some(
    (value) => value.insufficientAssessmentRefs.length > 0
  )) {
    addBlocker(blockers, 'ACTIVE_CLAIM_INSUFFICIENT');
  }
  if (analysis.questionLevelInsufficientAssessmentRefs.length > 0) {
    addBlocker(blockers, 'QUESTION_INSUFFICIENT');
  }
  if (analysis.ambiguities.some((ambiguity) =>
    ambiguity.code !== 'SUPPORTED_CLAIM_IN_CONTRADICTION'
  )) {
    addBlocker(blockers, 'BLOCKING_AMBIGUITY');
  }

  const candidateGroup = contradictionGroups.length === 1
    ? contradictionGroups[0]
    : null;
  const assessmentByRef = new Map(
    analysis.materiallyCurrentAssessmentHeads.map((assessment) => [
      assessment.assessmentRef,
      assessment
    ])
  );
  const activeClaimByRef = new Map(
    analysis.activeClaims.map((claim) => [claim.claimRef, claim])
  );
  let candidateBasis: ChallengeConflictApplicationQualifyingConflict | null = null;
  const baselineClaimRefsForProjection = new Set(
    projection.authoritativeBaseline.kind === 'INITIAL_UNASSOCIATED'
      ? projection.authoritativeBaseline.baselineClaimRefs
      : projection.authoritativeBaseline.resultBaselineClaimRefs
  );

  if (candidateGroup) {
    const assessment = assessmentByRef.get(candidateGroup.assessmentRef);
    if (!assessment || assessment.verdict !== 'CONTRADICTED') {
      addBlocker(blockers, 'NO_CURRENT_CONTRADICTION');
    } else {
      if (
        getInvestigationAssessmentChallengeRef(database, assessment.assessmentRef) !==
        projection.analysisContext.challengeRef
      ) {
        addBlocker(blockers, 'CONTRADICTION_NOT_CHALLENGE_SCOPED');
      }
      if (assessment.assessorKind === 'AI') {
        addBlocker(blockers, 'CONTRADICTION_ASSESSOR_NOT_ALLOWED');
      }

      const relatedClaimRefs = sortedUnique(candidateGroup.relatedClaimRefs);
      const activeClaimRefs = sortedUnique([...activeClaimByRef.keys()]);
      if (!sameReferences(relatedClaimRefs, activeClaimRefs)) {
        addBlocker(blockers, 'CONTRADICTION_DOES_NOT_COVER_ALL_ACTIVE_CLAIMS');
      }

      const baselineClaimRefs: string[] = [];
      const challengeClaimRefs: string[] = [];
      const normalizedLots: string[] = [];
      for (const claimRef of relatedClaimRefs) {
        const claim = activeClaimByRef.get(claimRef);
        if (!claim || claim.claimType !== 'AFFECTED_BATCH_LOT') {
          addBlocker(blockers, 'CONTRADICTION_DOES_NOT_COVER_ALL_ACTIVE_CLAIMS');
          continue;
        }
        const partition = getInvestigationClaimChallengeRef(database, claimRef);
        if (baselineClaimRefsForProjection.has(claimRef)) baselineClaimRefs.push(claimRef);
        if (partition === projection.analysisContext.challengeRef) {
          challengeClaimRefs.push(claimRef);
        }
        const normalizedLot = normalizeBatch(claim.value.lot);
        if (normalizedLot.length > 0) normalizedLots.push(normalizedLot);
      }
      if (baselineClaimRefs.length === 0) addBlocker(blockers, 'BASELINE_CLAIM_REQUIRED');
      if (challengeClaimRefs.length === 0) addBlocker(blockers, 'CHALLENGE_CLAIM_REQUIRED');
      const distinctNormalizedLots = sortedUnique(normalizedLots);
      if (
        normalizedLots.length !== relatedClaimRefs.length ||
        distinctNormalizedLots.length < 2
      ) {
        addBlocker(blockers, 'DISTINCT_LOTS_REQUIRED');
      }

      const evidenceRefs = sortedUnique(assessment.evidenceRefs);
      if (!sameReferences(evidenceRefs, completeEvidenceRefs)) {
        addBlocker(blockers, 'UNREVIEWED_EVIDENCE_PRESENT');
      }

      candidateBasis = {
        contradictionAssessmentRef: assessment.assessmentRef,
        relatedClaimRefs,
        evidenceRefs,
        baselineClaimRefs: sortedUnique(baselineClaimRefs),
        challengeClaimRefs: sortedUnique(challengeClaimRefs),
        distinctNormalizedLots
      };
    }
  }

  const blockerCodes = orderedBlockers(blockers);
  const eligible = blockerCodes.length === 0;
  return {
    eligibility: { eligible, blockerCodes },
    qualifyingConflict: eligible ? candidateBasis : null
  };
}

/**
 * Derive a conflict-application basis inside a transaction owned by the caller.
 * Future authoritative application must invoke this helper inside its immediate transaction.
 */
export function readChallengeConflictApplicationBasisInTransaction(
  database: RecallDatabase,
  caseId: string,
  questionRef: string,
  challengeRef: string
): ChallengeConflictApplicationBasis {
  const projection = readChallengeEffectiveInvestigationAnalysisInTransaction(
    database,
    caseId,
    questionRef,
    challengeRef
  );
  const completeEvidenceRefs = sortedUnique(
    listInvestigationEvidence(database, caseId, questionRef)
      .map((evidence) => evidence.evidenceRef)
  );
  const analysisState = canonicalChallengeAnalysisState(projection);
  const policy = deriveConflictPolicy(database, projection, completeEvidenceRefs);
  const inheritedBaseline = projection.authoritativeBaseline.kind ===
      'APPLIED_CHALLENGE_BATCH'
    ? projection.authoritativeBaseline
    : null;
  const basis: BasisWithoutDigest = {
    basisFormatVersion: inheritedBaseline
      ? inheritedChallengeConflictApplicationBasisFormatVersion
      : challengeConflictApplicationBasisFormatVersion,
    policyIdentifier: challengeConflictApplicationPolicy.identifier,
    policyVersion: inheritedBaseline
      ? inheritedChallengeConflictApplicationPolicy.version
      : challengeConflictApplicationPolicy.version,
    caseId: projection.analysis.caseId,
    questionRef: projection.analysis.questionRef,
    productId: projection.analysis.productId,
    analysisContext: { ...projection.analysisContext },
    projectionBasis: {
      claimRefs: sortedUnique(projection.projectionBasis.claimRefs),
      assessmentRefs: sortedUnique(projection.projectionBasis.assessmentRefs),
      referencedEvidenceRefs: sortedUnique(
        projection.projectionBasis.referencedEvidenceRefs
      )
    },
    completeEvidenceRefs,
    analysisState,
    ...(inheritedBaseline
      ? { authoritativeBaseline: structuredClone(inheritedBaseline) }
      : {}),
    eligibility: policy.eligibility,
    qualifyingConflict: policy.qualifyingConflict
  };
  return {
    ...basis,
    applicationBasisDigest: digestBasis(basis)
  };
}

export function readChallengeConflictApplicationBasis(
  database: RecallDatabase,
  caseId: string,
  questionRef: string,
  challengeRef: string
): ChallengeConflictApplicationBasis {
  return database.transaction((transaction) =>
    readChallengeConflictApplicationBasisInTransaction(
      transaction,
      caseId,
      questionRef,
      challengeRef
    )
  );
}
