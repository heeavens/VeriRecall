import { eq } from 'drizzle-orm';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import type { CurrentInvestigationChallengeForWrite } from './challenges';

export type ChallengeArtifactPartition = string | null;
export type ChallengeEvidenceRelevance =
  | 'CURRENT_CHALLENGE'
  | 'INITIAL_BASELINE'
  | 'INHERITED_BASELINE'
  | 'OTHER_CHALLENGE';

export interface ChallengeEvidenceRecord {
  evidenceRef: string;
  caseId: string;
  questionRef: string;
  evidenceRequestId: string | null;
  receivedAt: string;
}

export function getInvestigationRequestChallengeRef(
  database: RecallDatabase,
  requestId: string
): ChallengeArtifactPartition {
  return database
    .select({ challengeRef: schema.investigationChallengeRequests.challengeRef })
    .from(schema.investigationChallengeRequests)
    .where(eq(schema.investigationChallengeRequests.requestId, requestId))
    .get()?.challengeRef ?? null;
}

export function getInvestigationClaimChallengeRef(
  database: RecallDatabase,
  claimRef: string
): ChallengeArtifactPartition {
  return database
    .select({ challengeRef: schema.investigationChallengeClaims.challengeRef })
    .from(schema.investigationChallengeClaims)
    .where(eq(schema.investigationChallengeClaims.claimRef, claimRef))
    .get()?.challengeRef ?? null;
}

export function getInvestigationAssessmentChallengeRef(
  database: RecallDatabase,
  assessmentRef: string
): ChallengeArtifactPartition {
  return database
    .select({ challengeRef: schema.investigationChallengeAssessments.challengeRef })
    .from(schema.investigationChallengeAssessments)
    .where(eq(schema.investigationChallengeAssessments.assessmentRef, assessmentRef))
    .get()?.challengeRef ?? null;
}

export function getInvestigationEstablishmentChallengeRef(
  database: RecallDatabase,
  establishmentRef: string
): ChallengeArtifactPartition {
  return database
    .select({ challengeRef: schema.investigationChallengeEstablishments.challengeRef })
    .from(schema.investigationChallengeEstablishments)
    .where(eq(
      schema.investigationChallengeEstablishments.establishmentRef,
      establishmentRef
    ))
    .get()?.challengeRef ?? null;
}

export function classifyEvidenceForInvestigationChallenge(
  database: RecallDatabase,
  evidence: ChallengeEvidenceRecord,
  authorization: CurrentInvestigationChallengeForWrite
): ChallengeEvidenceRelevance {
  if (
    evidence.caseId !== authorization.challenge.caseId ||
    evidence.questionRef !== authorization.challenge.questionRef
  ) {
    return 'OTHER_CHALLENGE';
  }

  if (evidence.evidenceRequestId !== null) {
    const requestChallengeRef = getInvestigationRequestChallengeRef(
      database,
      evidence.evidenceRequestId
    );
    if (requestChallengeRef !== null) {
      if (requestChallengeRef === authorization.challenge.challengeRef) {
        return 'CURRENT_CHALLENGE';
      }
      if (
        authorization.authoritativeBaseline.kind === 'APPLIED_CHALLENGE_BATCH' &&
        authorization.authoritativeBaseline.resultBaselineEvidenceRefs.includes(
          evidence.evidenceRef
        )
      ) {
        return 'INHERITED_BASELINE';
      }
      return 'OTHER_CHALLENGE';
    }
  }

  const receivedAt = Date.parse(evidence.receivedAt);
  const challengedAt = Date.parse(authorization.challengedRevision.createdAt);
  return Number.isFinite(receivedAt) &&
    Number.isFinite(challengedAt) &&
    receivedAt > challengedAt
    ? 'CURRENT_CHALLENGE'
    : authorization.authoritativeBaseline.kind === 'INITIAL_UNASSOCIATED'
      ? 'INITIAL_BASELINE'
      : authorization.authoritativeBaseline.resultBaselineEvidenceRefs.includes(
          evidence.evidenceRef
        )
        ? 'INHERITED_BASELINE'
        : 'OTHER_CHALLENGE';
}
