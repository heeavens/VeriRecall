import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import type { LifecycleContext } from '../workflow/case-lifecycle';
import {
  InvestigatorLlmClientError,
  type InvestigatorLlmClient
} from '../llm/investigator-client';
import { demoHumanAssessorIdentifier } from './demo-context';
import { getInvestigationRequestChallengeRef } from './challenge-artifacts';
import {
  getInvestigatorRecommendationByBasisInTransaction,
  getInvestigatorRecommendationInTransaction,
  type HydratedInvestigatorRecommendation,
  type InvestigatorRecommendationEvent
} from './investigator-ledger';
import {
  canonicalInvestigatorJson,
  canonicalInvestigatorRefs,
  deriveInvestigatorCapabilities,
  investigatorActionKey,
  investigatorDigest,
  investigatorPolicy,
  InvestigatorValidationError,
  parseInvestigatorModelOutput,
  validateInvestigatorRecommendation,
  type InvestigatorModelOutput,
  type InvestigatorSnapshot
} from './investigator-policy';
import {
  buildInvestigatorSnapshotInTransaction,
  InvestigatorSnapshotError,
  type InactiveInvestigatorPartition
} from './investigator-snapshot';

const investigatorInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  questionRef: z.string().trim().min(1).max(500),
  expectedCaseVersion: z.number().int().positive(),
  expectedMaterialRevision: z.number().int().positive()
});

const linkedArtifactSchema = z.strictObject({
  kind: z.literal('EVIDENCE_REQUEST'),
  ref: z.string().uuid()
});

const eventInputSchema = z.discriminatedUnion('eventKind', [
  z.strictObject({
    eventRef: z.string().uuid(),
    recommendationRef: z.string().uuid(),
    eventKind: z.literal('DISMISSED'),
    expectedCaseVersion: z.number().int().positive(),
    expectedMaterialRevision: z.number().int().positive(),
    rationale: z.string().trim().min(1).max(10_000),
    demo: z.literal(true)
  }),
  z.strictObject({
    eventRef: z.string().uuid(),
    recommendationRef: z.string().uuid(),
    eventKind: z.literal('ACTED'),
    expectedCaseVersion: z.number().int().positive(),
    expectedMaterialRevision: z.number().int().positive(),
    linkedArtifact: linkedArtifactSchema.nullable(),
    rationale: z.string().trim().min(1).max(10_000),
    demo: z.literal(true)
  }),
  z.strictObject({
    eventRef: z.string().uuid(),
    recommendationRef: z.string().uuid(),
    eventKind: z.literal('PATH_EXHAUSTED'),
    expectedCaseVersion: z.number().int().positive(),
    expectedMaterialRevision: z.number().int().positive(),
    linkedArtifact: linkedArtifactSchema.nullable(),
    supportingEvidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(64),
    rationale: z.string().trim().min(1).max(10_000),
    demo: z.literal(true)
  })
]);

const clientProvenanceSchema = z.strictObject({
  providerIdentifier: z.string().trim().min(1).max(500),
  clientIdentifier: z.string().trim().min(1).max(500),
  modelIdentifier: z.string().trim().min(1).max(500),
  promptPolicyVersion: z.literal(investigatorPolicy.promptPolicyVersion)
});

export type InvestigateNextStepInput = z.infer<typeof investigatorInputSchema>;
export type RecordInvestigatorRecommendationEventInput = z.infer<typeof eventInputSchema>;

export type InvestigatorErrorCode =
  | 'INVESTIGATOR_INVALID_INPUT'
  | 'INVESTIGATOR_FORBIDDEN'
  | 'INVESTIGATOR_CONTEXT_UNPROVEN'
  | 'INVESTIGATOR_CONTEXT_AMBIGUOUS'
  | 'INVESTIGATOR_CONTEXT_CORRUPT'
  | 'INVESTIGATOR_CONTEXT_TOO_LARGE'
  | 'INVESTIGATOR_UNAVAILABLE'
  | 'INVESTIGATOR_TIMEOUT'
  | 'INVESTIGATOR_MODEL_ERROR'
  | 'INVESTIGATOR_REFUSAL'
  | 'INVESTIGATOR_OUTPUT_INVALID'
  | 'INVESTIGATOR_REFERENCE_INVALID'
  | 'INVESTIGATOR_ACTION_FORBIDDEN'
  | 'INVESTIGATOR_BASIS_STALE'
  | 'INVESTIGATOR_RECOMMENDATION_NOT_FOUND'
  | 'INVESTIGATOR_RECOMMENDATION_CONFLICT'
  | 'INVESTIGATOR_EVENT_CONFLICT';

export class InvestigatorError extends Error {
  constructor(
    public readonly code: InvestigatorErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvestigatorError';
  }
}

export type InvestigateNextStepResult =
  | {
      kind: 'RECOMMENDATION';
      recommendation: HydratedInvestigatorRecommendation;
      replayed: boolean;
    }
  | {
      kind: 'INELIGIBLE';
      reason: 'QUESTION_RESOLVED' | 'CONTINUATION_REQUIRED' | 'AWAITING_HUMAN_AUTHORITY';
    };

type InvestigatorIneligibleResult = Extract<InvestigateNextStepResult, { kind: 'INELIGIBLE' }>;

function requireDemo(context: LifecycleContext): void {
  if (context.mode !== 'demo') {
    throw new InvestigatorError(
      'INVESTIGATOR_FORBIDDEN',
      'Investigator recommendations require explicit local demo mode.'
    );
  }
}

function asInvestigatorError(error: unknown): never {
  if (error instanceof InvestigatorError) throw error;
  if (error instanceof InvestigatorLlmClientError) {
    throw new InvestigatorError(error.code, error.message);
  }
  if (error instanceof InvestigatorSnapshotError) {
    throw new InvestigatorError(error.code, error.message);
  }
  if (error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string' && error.code.startsWith('INVESTIGATOR_')) {
    throw new InvestigatorError(
      error.code as InvestigatorErrorCode,
      error instanceof Error ? error.message : 'The Investigator operation failed.'
    );
  }
  throw error;
}

function asInvestigatorModelError(error: unknown): never {
  if (error instanceof InvestigatorError) throw error;
  if (error instanceof InvestigatorLlmClientError) {
    throw new InvestigatorError(error.code, error.message);
  }
  if (error instanceof InvestigatorValidationError) {
    throw new InvestigatorError(error.code, 'The Investigator model response was rejected.');
  }
  throw new InvestigatorError(
    'INVESTIGATOR_MODEL_ERROR',
    'The Investigator model request failed.'
  );
}

function contextChallengeRef(snapshot: InvestigatorSnapshot): string | null {
  if (snapshot.context.kind === 'OPEN_CHALLENGE') return snapshot.context.challengeRef;
  if (snapshot.context.kind === 'APPLIED_CHALLENGE_CONFLICT') {
    return snapshot.context.continuationChallengeRef;
  }
  return null;
}

function assertExpectedVersions(
  snapshot: { caseVersion: number; materialRevision: number | null },
  input: InvestigateNextStepInput
): void {
  if (snapshot.caseVersion !== input.expectedCaseVersion ||
      snapshot.materialRevision !== input.expectedMaterialRevision) {
    throw new InvestigatorError(
      'INVESTIGATOR_BASIS_STALE',
      'The requested case or material version is stale.'
    );
  }
}

function buildBasis(
  database: RecallDatabase,
  input: InvestigateNextStepInput
): InvestigatorSnapshot | InvestigatorIneligibleResult {
  const built = buildInvestigatorSnapshotInTransaction(database, {
    caseId: input.caseId,
    questionRef: input.questionRef
  });
  if (isInactivePartition(built) && built.kind === 'RESOLVED') {
    assertExpectedVersions(built.snapshot, input);
    return { kind: 'INELIGIBLE', reason: 'QUESTION_RESOLVED' };
  }
  if (isInactivePartition(built) && built.kind === 'CONTINUATION_REQUIRED') {
    assertExpectedVersions(built.snapshot, input);
    return { kind: 'INELIGIBLE', reason: 'CONTINUATION_REQUIRED' };
  }
  assertExpectedVersions(built, input);
  if (built.establishment.awaitingHumanAuthority) {
    return { kind: 'INELIGIBLE', reason: 'AWAITING_HUMAN_AUTHORITY' };
  }
  return built;
}

function isInactivePartition(
  value: InvestigatorSnapshot | InactiveInvestigatorPartition
): value is InactiveInvestigatorPartition {
  return 'kind' in value;
}

function isIneligible(value: unknown): value is InvestigatorIneligibleResult {
  return Boolean(value && typeof value === 'object' && 'kind' in value &&
    value.kind === 'INELIGIBLE');
}

/**
 * Obtain one advisory next step. The remote model call is deliberately outside both DB
 * transactions; transaction B proves that transaction A's complete semantic basis is unchanged.
 */
export async function investigateNextStep(
  database: RecallDatabase,
  input: InvestigateNextStepInput,
  client: InvestigatorLlmClient,
  context: LifecycleContext,
  now = new Date()
): Promise<InvestigateNextStepResult> {
  requireDemo(context);
  const parsed = investigatorInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigatorError('INVESTIGATOR_INVALID_INPUT', 'Invalid Investigator input.');
  }

  let transactionA: {
    snapshot: InvestigatorSnapshot;
    basisDigest: string;
    existing: HydratedInvestigatorRecommendation | null;
  } | InvestigateNextStepResult;
  try {
    transactionA = database.transaction((transaction) => {
      const basis = buildBasis(transaction, parsed.data);
      if (isIneligible(basis)) return basis;
      const basisDigest = investigatorDigest(basis);
      return {
        snapshot: basis,
        basisDigest,
        existing: getInvestigatorRecommendationByBasisInTransaction(transaction, basisDigest)
      };
    });
  } catch (error) {
    return asInvestigatorError(error);
  }
  if (isIneligible(transactionA)) return transactionA;
  if (transactionA.existing) {
    return { kind: 'RECOMMENDATION', recommendation: transactionA.existing, replayed: true };
  }

  let output: InvestigatorModelOutput;
  try {
    if (!clientProvenanceSchema.safeParse(client.provenance).success) {
      throw new InvestigatorError(
        'INVESTIGATOR_MODEL_ERROR',
        'The Investigator client provenance is invalid.'
      );
    }
    output = validateInvestigatorRecommendation(
      transactionA.snapshot,
      parseInvestigatorModelOutput(await client.recommendNextStep(transactionA.snapshot))
    );
  } catch (error) {
    return asInvestigatorModelError(error);
  }

  try {
    return database.transaction((transaction): InvestigateNextStepResult => {
      const rebuilt = buildBasis(transaction, parsed.data);
      if (isIneligible(rebuilt) || investigatorDigest(rebuilt) !== transactionA.basisDigest) {
        throw new InvestigatorError(
          'INVESTIGATOR_BASIS_STALE',
          'The investigation state changed while the model was reasoning.'
        );
      }
      const revalidated = validateInvestigatorRecommendation(rebuilt, output);
      const existing = getInvestigatorRecommendationByBasisInTransaction(
        transaction,
        transactionA.basisDigest
      );
      if (existing) {
        return { kind: 'RECOMMENDATION', recommendation: existing, replayed: true };
      }
      const generatedAt = now.toISOString();
      const recommendationRef = randomUUID();
      try {
        transaction.insert(schema.investigationInvestigatorRecommendations).values({
          recommendationRef,
          caseId: rebuilt.caseId,
          questionRef: rebuilt.question.questionRef,
          contextChallengeRef: contextChallengeRef(rebuilt),
          contextKind: rebuilt.context.kind,
          caseVersion: rebuilt.caseVersion,
          materialRevision: rebuilt.materialRevision,
          snapshotFormatVersion: rebuilt.schemaVersion,
          policyIdentifier: investigatorPolicy.identifier,
          policyVersion: investigatorPolicy.version,
          basisJson: canonicalInvestigatorJson(rebuilt),
          basisDigest: transactionA.basisDigest,
          recommendationKind: revalidated.recommendation.kind,
          recommendationJson: canonicalInvestigatorJson(revalidated),
          recommendationDigest: investigatorDigest({
            basisDigest: transactionA.basisDigest,
            output: revalidated
          }),
          actionKey: investigatorActionKey(rebuilt.question.questionRef, revalidated.recommendation),
          providerIdentifier: client.provenance.providerIdentifier,
          clientIdentifier: client.provenance.clientIdentifier,
          modelIdentifier: client.provenance.modelIdentifier,
          promptPolicyVersion: client.provenance.promptPolicyVersion,
          generatedAt,
          demo: true
        }).run();
      } catch (error) {
        const winner = getInvestigatorRecommendationByBasisInTransaction(
          transaction,
          transactionA.basisDigest
        );
        if (winner) {
          return { kind: 'RECOMMENDATION', recommendation: winner, replayed: true };
        }
        throw error;
      }
      const stored = getInvestigatorRecommendationInTransaction(transaction, recommendationRef);
      if (!stored) {
        throw new InvestigatorError(
          'INVESTIGATOR_RECOMMENDATION_CONFLICT',
          'The persisted recommendation could not be validated.'
        );
      }
      return { kind: 'RECOMMENDATION', recommendation: stored, replayed: false };
    }, { behavior: 'immediate' });
  } catch (error) {
    return asInvestigatorError(error);
  }
}

function evidenceRequestForEvent(
  database: RecallDatabase,
  recommendation: HydratedInvestigatorRecommendation,
  linked: { kind: 'EVIDENCE_REQUEST'; ref: string } | null
): typeof schema.evidenceRequests.$inferSelect | null {
  if (!linked) return null;
  const request = database.select().from(schema.evidenceRequests)
    .where(eq(schema.evidenceRequests.id, linked.ref)).get();
  if (!request || request.caseId !== recommendation.caseId ||
      request.questionRef !== recommendation.questionRef ||
      getInvestigationRequestChallengeRef(database, request.id) !==
        recommendation.contextChallengeRef) {
    throw new InvestigatorError(
      'INVESTIGATOR_REFERENCE_INVALID',
      'The acted recommendation links a missing or foreign Evidence Request.'
    );
  }
  return request;
}

function assertActedLink(
  recommendation: HydratedInvestigatorRecommendation,
  request: typeof schema.evidenceRequests.$inferSelect | null
): void {
  const action = recommendation.output.recommendation;
  if (action.kind === 'REQUEST_EVIDENCE') {
    let requested: unknown;
    try {
      requested = request ? JSON.parse(request.requestedEvidence) : null;
    } catch {
      requested = null;
    }
    if (!request || !Array.isArray(requested) || !requested.includes(action.evidenceType)) {
      throw new InvestigatorError(
        'INVESTIGATOR_REFERENCE_INVALID',
        'ACTED requires the exact current-partition Evidence Request for the recommended type.'
      );
    }
    return;
  }
  if (action.kind === 'FOLLOW_UP_RECORDED_REQUEST') {
    if (!request || request.id !== action.requestRef) {
      throw new InvestigatorError(
        'INVESTIGATOR_REFERENCE_INVALID',
        'ACTED must link the exact Evidence Request named by the follow-up.'
      );
    }
    return;
  }
  if (request !== null || action.kind === 'NO_ACTION' ||
      action.kind === 'WAIT_FOR_PENDING_EVIDENCE') {
    throw new InvestigatorError(
      'INVESTIGATOR_ACTION_FORBIDDEN',
      'This recommendation cannot be recorded as acted with that linked artifact.'
    );
  }
}

/** Append a HUMAN audit event without changing any Case, Question, Task, or authority state. */
export function recordInvestigatorRecommendationEvent(
  database: RecallDatabase,
  input: RecordInvestigatorRecommendationEventInput,
  context: LifecycleContext,
  now = new Date()
): { event: InvestigatorRecommendationEvent; replayed: boolean } {
  requireDemo(context);
  const parsed = eventInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigatorError('INVESTIGATOR_INVALID_INPUT', 'Invalid recommendation event.');
  }
  try {
    return database.transaction((transaction) => {
      const existingRow = transaction.select()
        .from(schema.investigationInvestigatorRecommendationEvents)
        .where(eq(schema.investigationInvestigatorRecommendationEvents.eventRef, parsed.data.eventRef))
        .get();
      if (existingRow) {
        const recommendation = getInvestigatorRecommendationInTransaction(
          transaction,
          existingRow.recommendationRef
        );
        const event = recommendation?.events.find((item) => item.eventRef === parsed.data.eventRef);
        const linked = 'linkedArtifact' in parsed.data ? parsed.data.linkedArtifact : null;
        const supporting = 'supportingEvidenceRefs' in parsed.data
          ? canonicalInvestigatorRefs(parsed.data.supportingEvidenceRefs)
          : [];
        if (!event || existingRow.recommendationRef !== parsed.data.recommendationRef ||
            existingRow.eventKind !== parsed.data.eventKind ||
            existingRow.rationale !== parsed.data.rationale ||
            existingRow.linkedArtifactKind !== (linked?.kind ?? null) ||
            existingRow.linkedArtifactRef !== (linked?.ref ?? null) ||
            existingRow.supportingEvidenceRefsJson !== JSON.stringify(supporting)) {
          throw new InvestigatorError(
            'INVESTIGATOR_EVENT_CONFLICT',
            'The event reference is already bound to different semantics.'
          );
        }
        return { event, replayed: true };
      }

      const recommendation = getInvestigatorRecommendationInTransaction(
        transaction,
        parsed.data.recommendationRef
      );
      if (!recommendation) {
        throw new InvestigatorError(
          'INVESTIGATOR_RECOMMENDATION_NOT_FOUND',
          'The Investigator recommendation does not exist.'
        );
      }
      if (recommendation.events.some((item) => item.eventKind === parsed.data.eventKind)) {
        throw new InvestigatorError(
          'INVESTIGATOR_EVENT_CONFLICT',
          'This recommendation already has that event kind.'
        );
      }
      if (recommendation.events.length > 0) {
        throw new InvestigatorError(
          'INVESTIGATOR_EVENT_CONFLICT',
          'The recommendation already has an incompatible human disposition.'
        );
      }
      if (recommendation.caseVersion !== parsed.data.expectedCaseVersion ||
          recommendation.materialRevision !== parsed.data.expectedMaterialRevision) {
        throw new InvestigatorError(
          'INVESTIGATOR_BASIS_STALE',
          'The recommendation event does not match its immutable case basis.'
        );
      }

      const current = buildInvestigatorSnapshotInTransaction(transaction, {
        caseId: recommendation.caseId,
        questionRef: recommendation.questionRef
      });
      if (isInactivePartition(current) ||
          current.caseVersion !== recommendation.caseVersion ||
          current.materialRevision !== recommendation.materialRevision) {
        throw new InvestigatorError(
          'INVESTIGATOR_BASIS_STALE',
          'The recommendation is no longer applicable to the current investigation state.'
        );
      }

      const linked = 'linkedArtifact' in parsed.data ? parsed.data.linkedArtifact : null;
      const linkedRequest = evidenceRequestForEvent(transaction, recommendation, linked);
      const supportingEvidenceRefs = 'supportingEvidenceRefs' in parsed.data
        ? canonicalInvestigatorRefs(parsed.data.supportingEvidenceRefs)
        : [];
      if (parsed.data.eventKind === 'DISMISSED') {
        if (investigatorDigest(current) !== recommendation.basisDigest) {
          throw new InvestigatorError(
            'INVESTIGATOR_BASIS_STALE',
            'Only a current recommendation may be dismissed.'
          );
        }
      } else if (parsed.data.eventKind === 'ACTED') {
        assertActedLink(recommendation, linkedRequest);
        const action = recommendation.output.recommendation;
        const { allowedCapabilities: _currentCapabilities, ...currentWithoutCapabilities } = current;
        const comparableBase: Omit<InvestigatorSnapshot, 'allowedCapabilities'> =
          action.kind === 'REQUEST_EVIDENCE' && linkedRequest
          ? {
              ...currentWithoutCapabilities,
              requests: current.requests.filter((item) => item.requestRef !== linkedRequest.id)
            }
          : currentWithoutCapabilities;
        const comparable: InvestigatorSnapshot = {
          ...comparableBase,
          allowedCapabilities: deriveInvestigatorCapabilities(comparableBase)
        };
        if (investigatorDigest(comparable) !== recommendation.basisDigest) {
          throw new InvestigatorError(
            'INVESTIGATOR_BASIS_STALE',
            'ACTED may differ from its basis only by the exact linked Evidence Request.'
          );
        }
      } else {
        if (recommendation.output.recommendation.kind === 'NO_ACTION' ||
            recommendation.output.recommendation.kind === 'WAIT_FOR_PENDING_EVIDENCE') {
          throw new InvestigatorError(
            'INVESTIGATOR_ACTION_FORBIDDEN',
            'This recommendation does not describe an exhaustible investigation path.'
          );
        }
        for (const evidenceRef of supportingEvidenceRefs) {
          const item = current.evidence.find((evidence) => evidence.evidenceRef === evidenceRef);
          if (!item || item.relevance === 'HISTORICAL') {
            throw new InvestigatorError(
              'INVESTIGATOR_REFERENCE_INVALID',
              'PATH_EXHAUSTED requires current durable supporting Evidence.'
            );
          }
        }
        if (investigatorDigest(current) !== recommendation.basisDigest) {
          throw new InvestigatorError(
            'INVESTIGATOR_BASIS_STALE',
            'Only a current recommendation path may be marked exhausted.'
          );
        }
      }

      transaction.insert(schema.investigationInvestigatorRecommendationEvents).values({
        eventRef: parsed.data.eventRef,
        recommendationRef: recommendation.recommendationRef,
        eventKind: parsed.data.eventKind,
        linkedArtifactKind: linked?.kind ?? null,
        linkedArtifactRef: linked?.ref ?? null,
        supportingEvidenceRefsJson: JSON.stringify(supportingEvidenceRefs),
        rationale: parsed.data.rationale,
        actorKind: 'HUMAN',
        actorIdentifier: demoHumanAssessorIdentifier,
        basisCaseVersion: recommendation.caseVersion,
        basisMaterialRevision: recommendation.materialRevision,
        createdAt: now.toISOString(),
        demo: true
      }).run();
      const stored = getInvestigatorRecommendationInTransaction(
        transaction,
        recommendation.recommendationRef
      );
      const event = stored?.events.find((item) => item.eventRef === parsed.data.eventRef);
      if (!event) {
        throw new InvestigatorError(
          'INVESTIGATOR_EVENT_CONFLICT',
          'The persisted recommendation event could not be validated.'
        );
      }
      return { event, replayed: false };
    }, { behavior: 'immediate' });
  } catch (error) {
    return asInvestigatorError(error);
  }
}
