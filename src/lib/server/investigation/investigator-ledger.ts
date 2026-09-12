import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { demoHumanAssessorIdentifier } from './demo-context';
import { getInvestigationRequestChallengeRef } from './challenge-artifacts';
import {
  canonicalInvestigatorJson,
  canonicalInvestigatorRefs,
  investigatorActionKey,
  investigatorDigest,
  investigatorModelOutputSchema,
  investigatorPolicy,
  investigatorSnapshotSchema,
  validateInvestigatorRecommendation,
  type InvestigatorModelOutput,
  type InvestigatorSnapshot
} from './investigator-policy';

const storedRefsSchema = z.array(z.string().trim().min(1).max(500));
const storedUuidSchema = z.string().uuid();
const storedTimestampSchema = z.string().datetime();
const storedMetadataSchema = z.string().trim().min(1).max(500);

export type InvestigatorLedgerErrorCode =
  | 'INVESTIGATOR_RECOMMENDATION_NOT_FOUND'
  | 'INVESTIGATOR_RECOMMENDATION_INVALID'
  | 'INVESTIGATOR_RECOMMENDATION_AMBIGUOUS';

export class InvestigatorLedgerError extends Error {
  constructor(
    public readonly code: InvestigatorLedgerErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvestigatorLedgerError';
  }
}

export interface InvestigatorRecommendationEvent {
  eventRef: string;
  recommendationRef: string;
  actionKey: string;
  recommendationKind: InvestigatorModelOutput['recommendation']['kind'];
  eventKind: 'DISMISSED' | 'ACTED' | 'PATH_EXHAUSTED';
  linkedArtifactKind: 'EVIDENCE_REQUEST' | null;
  linkedArtifactRef: string | null;
  supportingEvidenceRefs: string[];
  basisEvidenceRefs: string[];
  basisRequestRefs: string[];
  basisClaimRefs: string[];
  basisAssessmentRefs: string[];
  basisAlertAssertionRefs: string[];
  rationale: string;
  actorKind: 'HUMAN';
  actorIdentifier: string;
  basisCaseVersion: number;
  basisMaterialRevision: number;
  createdAt: string;
  demo: true;
}

export interface HydratedInvestigatorRecommendation {
  recommendationRef: string;
  caseId: string;
  questionRef: string;
  contextChallengeRef: string | null;
  contextKind: 'OPEN_GAP' | 'OPEN_CHALLENGE' | 'APPLIED_CHALLENGE_CONFLICT';
  caseVersion: number;
  materialRevision: number;
  snapshotFormatVersion: 1;
  policyIdentifier: typeof investigatorPolicy.identifier;
  policyVersion: typeof investigatorPolicy.version;
  basis: InvestigatorSnapshot;
  basisDigest: string;
  output: InvestigatorModelOutput;
  recommendationDigest: string;
  actionKey: string;
  providerIdentifier: string;
  clientIdentifier: string;
  modelIdentifier: string;
  promptPolicyVersion: string;
  generatedAt: string;
  demo: true;
  events: InvestigatorRecommendationEvent[];
}

function parseCanonicalJson<T>(
  value: string,
  schemaParser: z.ZodType<T>,
  label: string
): T {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new InvestigatorLedgerError(
      'INVESTIGATOR_RECOMMENDATION_INVALID',
      `Stored ${label} is not valid JSON.`
    );
  }
  const parsed = schemaParser.safeParse(raw);
  if (!parsed.success || canonicalInvestigatorJson(parsed.data) !== value) {
    throw new InvestigatorLedgerError(
      'INVESTIGATOR_RECOMMENDATION_INVALID',
      `Stored ${label} is malformed or noncanonical.`
    );
  }
  return parsed.data;
}

function parseCanonicalRefs(value: string, label: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new InvestigatorLedgerError(
      'INVESTIGATOR_RECOMMENDATION_INVALID',
      `Stored ${label} is not valid JSON.`
    );
  }
  const parsed = storedRefsSchema.safeParse(raw);
  const canonical = parsed.success ? canonicalInvestigatorRefs(parsed.data) : [];
  if (!parsed.success || JSON.stringify(canonical) !== value) {
    throw new InvestigatorLedgerError(
      'INVESTIGATOR_RECOMMENDATION_INVALID',
      `Stored ${label} is malformed or noncanonical.`
    );
  }
  return canonical;
}

function contextChallengeRef(snapshot: InvestigatorSnapshot): string | null {
  if (snapshot.context.kind === 'OPEN_CHALLENGE') return snapshot.context.challengeRef;
  if (snapshot.context.kind === 'APPLIED_CHALLENGE_CONFLICT') {
    return snapshot.context.continuationChallengeRef;
  }
  return null;
}

function parseRequestedEvidence(value: string): string[] {
  try {
    const parsed = storedRefsSchema.safeParse(JSON.parse(value));
    return parsed.success ? canonicalInvestigatorRefs(parsed.data) : [];
  } catch {
    return [];
  }
}

function hydrateEvents(
  database: RecallDatabase,
  recommendation: Omit<HydratedInvestigatorRecommendation, 'events'>
): InvestigatorRecommendationEvent[] {
  const rows = database.select()
    .from(schema.investigationInvestigatorRecommendationEvents)
    .where(eq(
      schema.investigationInvestigatorRecommendationEvents.recommendationRef,
      recommendation.recommendationRef
    ))
    .orderBy(
      asc(schema.investigationInvestigatorRecommendationEvents.createdAt),
      asc(schema.investigationInvestigatorRecommendationEvents.eventRef)
    )
    .all();
  const events = rows.map((row): InvestigatorRecommendationEvent => {
    const supportingEvidenceRefs = parseCanonicalRefs(
      row.supportingEvidenceRefsJson,
      'recommendation-event Evidence refs'
    );
    if (
      !storedUuidSchema.safeParse(row.eventRef).success ||
      !storedUuidSchema.safeParse(row.recommendationRef).success ||
      !storedTimestampSchema.safeParse(row.createdAt).success ||
      row.actorKind !== 'HUMAN' || row.actorIdentifier !== demoHumanAssessorIdentifier ||
      !row.rationale.trim() ||
      row.basisCaseVersion !== recommendation.caseVersion ||
      row.basisMaterialRevision !== recommendation.materialRevision ||
      row.demo !== recommendation.demo ||
      (row.eventKind === 'PATH_EXHAUSTED' && supportingEvidenceRefs.length === 0) ||
      ((row.linkedArtifactKind === null) !== (row.linkedArtifactRef === null)) ||
      (row.eventKind === 'DISMISSED' && (
        row.linkedArtifactRef !== null || supportingEvidenceRefs.length !== 0
      )) ||
      (row.eventKind === 'ACTED' && supportingEvidenceRefs.length !== 0)
    ) {
      throw new InvestigatorLedgerError(
        'INVESTIGATOR_RECOMMENDATION_INVALID',
        'Stored recommendation event ownership or provenance is invalid.'
      );
    }
    for (const evidenceRef of supportingEvidenceRefs) {
      const evidence = database.select({
        caseId: schema.investigationEvidence.caseId,
        questionRef: schema.investigationEvidence.questionRef,
        demo: schema.investigationEvidence.demo
      }).from(schema.investigationEvidence).where(eq(
        schema.investigationEvidence.evidenceRef,
        evidenceRef
      )).get();
      if (!evidence || evidence.caseId !== recommendation.caseId ||
          evidence.questionRef !== recommendation.questionRef || evidence.demo !== true) {
        throw new InvestigatorLedgerError(
          'INVESTIGATOR_RECOMMENDATION_INVALID',
          'Stored recommendation event cites missing or foreign supporting Evidence.'
        );
      }
    }
    let linkedRequest: typeof schema.evidenceRequests.$inferSelect | null = null;
    if (row.linkedArtifactKind !== null) {
      if (row.linkedArtifactKind !== 'EVIDENCE_REQUEST' || row.linkedArtifactRef === null) {
        throw new InvestigatorLedgerError(
          'INVESTIGATOR_RECOMMENDATION_INVALID',
          'Stored recommendation event links an unsupported artifact.'
        );
      }
      const request = database.select().from(schema.evidenceRequests).where(eq(
        schema.evidenceRequests.id,
        row.linkedArtifactRef
      )).get();
      if (!request || request.caseId !== recommendation.caseId ||
          request.questionRef !== recommendation.questionRef ||
          getInvestigationRequestChallengeRef(database, request.id) !==
            recommendation.contextChallengeRef) {
        throw new InvestigatorLedgerError(
          'INVESTIGATOR_RECOMMENDATION_INVALID',
          'Stored recommendation event links a missing or foreign Evidence Request.'
        );
      }
      linkedRequest = request;
    }
    const action = recommendation.output.recommendation;
    if (row.eventKind === 'ACTED') {
      if (action.kind === 'REQUEST_EVIDENCE') {
        if (!linkedRequest ||
            !parseRequestedEvidence(linkedRequest.requestedEvidence).includes(action.evidenceType)) {
          throw new InvestigatorLedgerError(
            'INVESTIGATOR_RECOMMENDATION_INVALID',
            'Stored ACTED history does not link the exact recommended Evidence Request.'
          );
        }
      } else if (action.kind === 'FOLLOW_UP_RECORDED_REQUEST') {
        if (!linkedRequest || linkedRequest.id !== action.requestRef) {
          throw new InvestigatorLedgerError(
            'INVESTIGATOR_RECOMMENDATION_INVALID',
            'Stored ACTED history does not link the exact follow-up request.'
          );
        }
      } else if (linkedRequest || action.kind === 'NO_ACTION' ||
          action.kind === 'WAIT_FOR_PENDING_EVIDENCE') {
        throw new InvestigatorLedgerError(
          'INVESTIGATOR_RECOMMENDATION_INVALID',
          'Stored ACTED history is impossible for its recommendation kind.'
        );
      }
    }
    if (row.eventKind === 'PATH_EXHAUSTED' && linkedRequest) {
      if (
        (action.kind === 'REQUEST_EVIDENCE' &&
          !parseRequestedEvidence(linkedRequest.requestedEvidence).includes(action.evidenceType)) ||
        (action.kind === 'FOLLOW_UP_RECORDED_REQUEST' && linkedRequest.id !== action.requestRef) ||
        !['REQUEST_EVIDENCE', 'FOLLOW_UP_RECORDED_REQUEST'].includes(action.kind)
      ) {
        throw new InvestigatorLedgerError(
          'INVESTIGATOR_RECOMMENDATION_INVALID',
          'Stored exhausted history links an unrelated request path.'
        );
      }
    }
    return {
      eventRef: row.eventRef,
      recommendationRef: row.recommendationRef,
      actionKey: recommendation.actionKey,
      recommendationKind: recommendation.output.recommendation.kind,
      eventKind: row.eventKind,
      linkedArtifactKind: row.linkedArtifactKind,
      linkedArtifactRef: row.linkedArtifactRef,
      supportingEvidenceRefs,
      basisEvidenceRefs: canonicalInvestigatorRefs(
        recommendation.basis.evidence.map((item) => item.evidenceRef)
      ),
      basisRequestRefs: canonicalInvestigatorRefs(
        recommendation.basis.requests.map((item) => item.requestRef)
      ),
      basisClaimRefs: canonicalInvestigatorRefs(
        recommendation.basis.claims.map((item) => item.claimRef)
      ),
      basisAssessmentRefs: canonicalInvestigatorRefs(
        recommendation.basis.assessments.map((item) => item.assessmentRef)
      ),
      basisAlertAssertionRefs: canonicalInvestigatorRefs([
        ...recommendation.basis.alertFacts.authoritative,
        ...recommendation.basis.alertFacts.hypotheses,
        ...recommendation.basis.alertFacts.unverified
      ].map((item) => item.assertionRef)),
      rationale: row.rationale,
      actorKind: row.actorKind,
      actorIdentifier: row.actorIdentifier,
      basisCaseVersion: row.basisCaseVersion,
      basisMaterialRevision: row.basisMaterialRevision,
      createdAt: row.createdAt,
      demo: true
    };
  });
  const kinds = new Set(events.map((item) => item.eventKind));
  if (kinds.has('DISMISSED') && (kinds.has('ACTED') || kinds.has('PATH_EXHAUSTED'))) {
    throw new InvestigatorLedgerError(
      'INVESTIGATOR_RECOMMENDATION_INVALID',
      'A dismissed recommendation has conflicting acted or exhausted history.'
    );
  }
  return events;
}

function hydrateRow(
  database: RecallDatabase,
  row: typeof schema.investigationInvestigatorRecommendations.$inferSelect
): HydratedInvestigatorRecommendation {
  const basis = parseCanonicalJson(row.basisJson, investigatorSnapshotSchema, 'Investigator basis');
  const output = parseCanonicalJson(
    row.recommendationJson,
    investigatorModelOutputSchema,
    'Investigator recommendation'
  );
  let validatedOutput: InvestigatorModelOutput;
  try {
    validatedOutput = validateInvestigatorRecommendation(basis, output);
  } catch {
    throw new InvestigatorLedgerError(
      'INVESTIGATOR_RECOMMENDATION_INVALID',
      'Stored Investigator recommendation is invalid for its immutable basis.'
    );
  }
  const question = database.select({
    caseId: schema.investigationQuestions.caseId,
    demo: schema.investigationQuestions.demo
  }).from(schema.investigationQuestions).where(eq(
    schema.investigationQuestions.questionRef,
    row.questionRef
  )).get();
  const challenge = row.contextChallengeRef === null ? null : database.select({
    caseId: schema.investigationChallenges.caseId,
    questionRef: schema.investigationChallenges.questionRef,
    demo: schema.investigationChallenges.demo
  }).from(schema.investigationChallenges).where(eq(
    schema.investigationChallenges.challengeRef,
    row.contextChallengeRef
  )).get();
  if (
    !storedUuidSchema.safeParse(row.recommendationRef).success ||
    !storedUuidSchema.safeParse(row.caseId).success ||
    !storedTimestampSchema.safeParse(row.generatedAt).success ||
    !question || question.caseId !== row.caseId || !question.demo ||
    row.snapshotFormatVersion !== 1 ||
    row.policyIdentifier !== investigatorPolicy.identifier ||
    row.policyVersion !== investigatorPolicy.version ||
    row.caseVersion !== basis.caseVersion ||
    row.materialRevision !== basis.materialRevision ||
    row.caseId !== basis.caseId || row.questionRef !== basis.question.questionRef ||
    row.contextKind !== basis.context.kind ||
    row.contextChallengeRef !== contextChallengeRef(basis) ||
    (row.contextChallengeRef !== null && (
      !challenge || challenge.caseId !== row.caseId ||
      challenge.questionRef !== row.questionRef || !challenge.demo
    )) ||
    investigatorDigest(basis) !== row.basisDigest ||
    investigatorDigest({ basisDigest: row.basisDigest, output: validatedOutput }) !==
      row.recommendationDigest ||
    investigatorActionKey(row.questionRef, validatedOutput.recommendation) !== row.actionKey ||
    validatedOutput.recommendation.kind !== row.recommendationKind ||
    !storedMetadataSchema.safeParse(row.providerIdentifier).success ||
    !storedMetadataSchema.safeParse(row.clientIdentifier).success ||
    !storedMetadataSchema.safeParse(row.modelIdentifier).success ||
    row.promptPolicyVersion !== investigatorPolicy.promptPolicyVersion ||
    row.demo !== true
  ) {
    throw new InvestigatorLedgerError(
      'INVESTIGATOR_RECOMMENDATION_INVALID',
      'Stored Investigator recommendation identity, digest, or provenance is invalid.'
    );
  }
  const withoutEvents: Omit<HydratedInvestigatorRecommendation, 'events'> = {
    recommendationRef: row.recommendationRef,
    caseId: row.caseId,
    questionRef: row.questionRef,
    contextChallengeRef: row.contextChallengeRef,
    contextKind: row.contextKind,
    caseVersion: row.caseVersion,
    materialRevision: row.materialRevision,
    snapshotFormatVersion: 1,
    policyIdentifier: investigatorPolicy.identifier,
    policyVersion: investigatorPolicy.version,
    basis,
    basisDigest: row.basisDigest,
    output: validatedOutput,
    recommendationDigest: row.recommendationDigest,
    actionKey: row.actionKey,
    providerIdentifier: row.providerIdentifier,
    clientIdentifier: row.clientIdentifier,
    modelIdentifier: row.modelIdentifier,
    promptPolicyVersion: row.promptPolicyVersion,
    generatedAt: row.generatedAt,
    demo: true
  };
  return { ...withoutEvents, events: hydrateEvents(database, withoutEvents) };
}

export function getInvestigatorRecommendationInTransaction(
  database: RecallDatabase,
  recommendationRef: string
): HydratedInvestigatorRecommendation | null {
  const row = database.select()
    .from(schema.investigationInvestigatorRecommendations)
    .where(eq(
      schema.investigationInvestigatorRecommendations.recommendationRef,
      recommendationRef
    )).get();
  return row ? hydrateRow(database, row) : null;
}

export function getInvestigatorRecommendationByBasisInTransaction(
  database: RecallDatabase,
  basisDigest: string
): HydratedInvestigatorRecommendation | null {
  const rows = database.select()
    .from(schema.investigationInvestigatorRecommendations)
    .where(eq(schema.investigationInvestigatorRecommendations.basisDigest, basisDigest))
    .all();
  if (rows.length > 1) {
    throw new InvestigatorLedgerError(
      'INVESTIGATOR_RECOMMENDATION_AMBIGUOUS',
      'More than one Investigator recommendation claims the same immutable basis.'
    );
  }
  return rows[0] ? hydrateRow(database, rows[0]) : null;
}

export function listInvestigatorMemoryEventsInTransaction(
  database: RecallDatabase,
  caseId: string,
  questionRef: string
): InvestigatorRecommendationEvent[] {
  const recommendations = database.select()
    .from(schema.investigationInvestigatorRecommendations)
    .where(and(
      eq(schema.investigationInvestigatorRecommendations.caseId, caseId),
      eq(schema.investigationInvestigatorRecommendations.questionRef, questionRef)
    ))
    .orderBy(
      asc(schema.investigationInvestigatorRecommendations.generatedAt),
      asc(schema.investigationInvestigatorRecommendations.recommendationRef)
    ).all();
  return recommendations.flatMap((row) => hydrateRow(database, row).events);
}
