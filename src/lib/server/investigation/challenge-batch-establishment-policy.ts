import { normalizeBatch } from '../alerts/normalization';
import type { InvestigationAssessment } from './assessments';
import type { InvestigationClaim } from './claims';
import { demoHumanAssessorIdentifier } from './demo-context';

export const demoChallengeBatchEstablishmentPolicy = {
  policyIdentifier: 'demo-challenge-batch-establishment',
  policyVersion: 'v1',
  evaluatorKind: 'RULE',
  evaluatorIdentifier: 'demo-challenge-batch-establishment-policy-engine'
} as const;

export const demoInheritedChallengeBatchEstablishmentPolicy = {
  ...demoChallengeBatchEstablishmentPolicy,
  policyVersion: 'v2'
} as const;

export const demoConflictContinuationBatchEstablishmentPolicy = {
  ...demoChallengeBatchEstablishmentPolicy,
  policyVersion: 'v3'
} as const;

export type DemoChallengeBatchEstablishmentPolicy =
  | typeof demoChallengeBatchEstablishmentPolicy
  | typeof demoInheritedChallengeBatchEstablishmentPolicy
  | typeof demoConflictContinuationBatchEstablishmentPolicy;

export function challengeBatchEstablishmentPolicyForBaseline(
  baselineKind:
    | 'INITIAL_UNASSOCIATED'
    | 'APPLIED_CHALLENGE_BATCH'
    | 'APPLIED_CHALLENGE_CONFLICT'
): DemoChallengeBatchEstablishmentPolicy {
  if (baselineKind === 'INITIAL_UNASSOCIATED') {
    return demoChallengeBatchEstablishmentPolicy;
  }
  return baselineKind === 'APPLIED_CHALLENGE_BATCH'
    ? demoInheritedChallengeBatchEstablishmentPolicy
    : demoConflictContinuationBatchEstablishmentPolicy;
}

export function isSupportedChallengeBatchEstablishmentPolicy(value: {
  policyIdentifier: string;
  policyVersion: string;
  evaluatorKind: string;
  evaluatorIdentifier: string;
}): boolean {
  return value.policyIdentifier === demoChallengeBatchEstablishmentPolicy.policyIdentifier &&
    (value.policyVersion === demoChallengeBatchEstablishmentPolicy.policyVersion ||
      value.policyVersion === demoInheritedChallengeBatchEstablishmentPolicy.policyVersion ||
      value.policyVersion === demoConflictContinuationBatchEstablishmentPolicy.policyVersion) &&
    value.evaluatorKind === demoChallengeBatchEstablishmentPolicy.evaluatorKind &&
    value.evaluatorIdentifier === demoChallengeBatchEstablishmentPolicy.evaluatorIdentifier;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRefs(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  const canonicalLeft = canonicalRefs(left);
  const canonicalRight = canonicalRefs(right);
  return canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index]);
}

function isTrustedRejection(assessment: InvestigationAssessment): boolean {
  return assessment.assessorKind === 'RULE' ||
    (assessment.assessorKind === 'HUMAN' &&
      assessment.assessorIdentifier === demoHumanAssessorIdentifier);
}

export interface ChallengeBatchAssessmentClassification {
  structuralTargetSupportAssessmentRefs: string[];
  targetSupportAssessmentRefs: string[];
  qualifyingTargetSupportAssessmentRefs: string[];
  reliedUponRejectionAssessmentRefs: string[];
  divergentClaimRefsWithoutTrustedRejection: string[];
}

/** Shared assessment categorization for live v1/v2/v3 policy and provenance validation. */
export function classifyChallengeBatchEstablishmentAssessments(input: {
  activeClaims: readonly InvestigationClaim[];
  structuralAssessmentHeads: readonly InvestigationAssessment[];
  materiallyCurrentAssessmentRefs: ReadonlySet<string>;
  assessmentChallengeRefs: ReadonlyMap<string, string | null>;
  challengeRef: string;
  targetClaimRef: string;
  targetLot: string;
  completeEvidenceRefs: readonly string[];
}): ChallengeBatchAssessmentClassification {
  const structuralTargetSupports = input.structuralAssessmentHeads.filter((assessment) =>
    assessment.verdict === 'SUPPORTED' &&
    assessment.targetClaimRef === input.targetClaimRef &&
    assessment.assessorKind === 'HUMAN' &&
    assessment.assessorIdentifier === demoHumanAssessorIdentifier &&
    input.assessmentChallengeRefs.get(assessment.assessmentRef) === input.challengeRef
  );
  const currentTargetSupports = structuralTargetSupports.filter((assessment) =>
    input.materiallyCurrentAssessmentRefs.has(assessment.assessmentRef)
  );
  const qualifyingTargetSupports = currentTargetSupports.filter((assessment) =>
    sameRefs(assessment.evidenceRefs, input.completeEvidenceRefs)
  );
  const materiallyCurrentByRef = new Map(
    input.structuralAssessmentHeads.filter((assessment) =>
      input.materiallyCurrentAssessmentRefs.has(assessment.assessmentRef)
    ).map((assessment) => [assessment.assessmentRef, assessment])
  );
  const reliedUponRejections: string[] = [];
  const divergentWithoutRejection: string[] = [];
  if (input.targetLot.length > 0) {
    for (const alternative of input.activeClaims) {
      if (
        alternative.claimRef === input.targetClaimRef ||
        normalizeBatch(alternative.value.lot) === input.targetLot
      ) {
        continue;
      }
      const trustedRejections = input.structuralAssessmentHeads.filter((assessment) =>
        assessment.targetClaimRef === alternative.claimRef &&
        assessment.verdict === 'REJECTED' &&
        materiallyCurrentByRef.has(assessment.assessmentRef) &&
        input.assessmentChallengeRefs.get(assessment.assessmentRef) === input.challengeRef &&
        isTrustedRejection(assessment)
      );
      if (trustedRejections.length === 0) {
        divergentWithoutRejection.push(alternative.claimRef);
      } else {
        reliedUponRejections.push(...trustedRejections.map((assessment) =>
          assessment.assessmentRef
        ));
      }
    }
  }
  return {
    structuralTargetSupportAssessmentRefs: canonicalRefs(
      structuralTargetSupports.map((assessment) => assessment.assessmentRef)
    ),
    targetSupportAssessmentRefs: canonicalRefs(
      currentTargetSupports.map((assessment) => assessment.assessmentRef)
    ),
    qualifyingTargetSupportAssessmentRefs: canonicalRefs(
      qualifyingTargetSupports.map((assessment) => assessment.assessmentRef)
    ),
    reliedUponRejectionAssessmentRefs: canonicalRefs(reliedUponRejections),
    divergentClaimRefsWithoutTrustedRejection: canonicalRefs(divergentWithoutRejection)
  };
}
