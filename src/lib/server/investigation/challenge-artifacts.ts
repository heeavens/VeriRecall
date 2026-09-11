import { eq } from 'drizzle-orm';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import type { CurrentInvestigationChallengeForWrite } from './challenges';

export type ChallengeArtifactPartition = string | null;
export type ChallengeEvidenceRelevance =
  | 'CHALLENGE_RELEVANT'
  | 'BASELINE'
  | 'OTHER_CHALLENGE';

export interface ChallengeEvidenceRecord {
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
      return requestChallengeRef === authorization.challenge.challengeRef
        ? 'CHALLENGE_RELEVANT'
        : 'OTHER_CHALLENGE';
    }
  }

  const receivedAt = Date.parse(evidence.receivedAt);
  const challengedAt = Date.parse(authorization.challengedRevision.createdAt);
  return Number.isFinite(receivedAt) &&
    Number.isFinite(challengedAt) &&
    receivedAt > challengedAt
    ? 'CHALLENGE_RELEVANT'
    : 'BASELINE';
}
