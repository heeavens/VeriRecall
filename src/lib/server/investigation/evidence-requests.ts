import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import {
  readCaseSnapshot,
  type LifecycleContext
} from '../workflow/case-lifecycle';
import { evidenceTypes, type EvidenceType } from '../workflow/review';
import {
  getInvestigationRequestChallengeRef
} from './challenge-artifacts';
import {
  InvestigationChallengeError,
  resolveCurrentInvestigationContextForWrite
} from './challenges';
import { demoHumanAssessorIdentifier } from './demo-context';
import { ensureCurrentInvestigationQuestionRegistered } from './questions';

const actorId = demoHumanAssessorIdentifier;
const questionRefSchema = z.string().trim().min(1).max(500);
const timestampSchema = z.string().datetime();

const openGapRequestInputSchema = z.strictObject({
  requestId: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: questionRefSchema,
  expectedCaseVersion: z.number().int().positive(),
  requestedEvidence: z.array(z.enum(evidenceTypes)).min(1),
  demo: z.literal(true)
});

const challengeRequestInputSchema = z.strictObject({
  requestId: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: questionRefSchema,
  challengeRef: z.string().uuid(),
  expectedCaseVersion: z.number().int().positive(),
  expectedMaterialRevision: z.number().int().positive(),
  requestedEvidence: z.array(z.enum(evidenceTypes)).min(1),
  demo: z.literal(true)
});

const requestInvestigationEvidenceInputSchema = z.union([
  challengeRequestInputSchema,
  openGapRequestInputSchema
]);

const investigationEvidenceRequestSchema = z.strictObject({
  id: z.string().uuid(),
  matchId: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: questionRefSchema,
  requestedEvidence: z.array(z.enum(evidenceTypes)).min(1),
  recipient: z.string().nullable(),
  status: z.literal('pending'),
  createdAt: timestampSchema,
  resolvedAt: z.null()
});

export type RequestInvestigationEvidenceInput = z.infer<
  typeof requestInvestigationEvidenceInputSchema
>;
export type InvestigationEvidenceRequest = z.infer<
  typeof investigationEvidenceRequestSchema
>;

export type InvestigationEvidenceRequestErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'VERSIONED_CASE_REQUIRED'
  | 'STALE_CASE_VERSION'
  | 'STALE_MATERIAL_REVISION'
  | 'QUESTION_NOT_CURRENT'
  | 'QUESTION_AMBIGUOUS'
  | 'CHALLENGE_NOT_CURRENT'
  | 'CHALLENGE_ASSOCIATION_CONFLICT'
  | 'MATCH_NOT_FOUND'
  | 'MATCH_AMBIGUOUS'
  | 'REQUEST_CONFLICT';

export class InvestigationEvidenceRequestError extends Error {
  constructor(
    public readonly code: InvestigationEvidenceRequestErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvestigationEvidenceRequestError';
  }
}

function canonicalEvidence(values: readonly EvidenceType[]): EvidenceType[] {
  return evidenceTypes.filter((type) => values.includes(type));
}

function parseStoredEvidence(value: string): EvidenceType[] | null {
  try {
    const parsed = z.array(z.enum(evidenceTypes)).safeParse(JSON.parse(value));
    return parsed.success && parsed.data.length > 0
      ? canonicalEvidence(parsed.data)
      : null;
  } catch {
    return null;
  }
}

function sameEvidence(left: readonly EvidenceType[], right: readonly EvidenceType[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function challengeRefOf(
  input: z.infer<typeof requestInvestigationEvidenceInputSchema>
): string | null {
  return 'challengeRef' in input ? input.challengeRef : null;
}

function resolveChallengeAuthorization(
  database: RecallDatabase,
  input: z.infer<typeof challengeRequestInputSchema>
) {
  try {
    return resolveCurrentInvestigationContextForWrite(database, {
      caseId: input.caseId,
      questionRef: input.questionRef,
      challengeRef: input.challengeRef,
      expectedCaseVersion: input.expectedCaseVersion,
      expectedMaterialRevision: input.expectedMaterialRevision,
      demo: input.demo
    });
  } catch (error) {
    if (error instanceof InvestigationChallengeError) {
      if (error.code === 'STALE_CASE_VERSION') {
        throw new InvestigationEvidenceRequestError('STALE_CASE_VERSION', error.message);
      }
      if (error.code === 'STALE_MATERIAL_REVISION') {
        throw new InvestigationEvidenceRequestError('STALE_MATERIAL_REVISION', error.message);
      }
      throw new InvestigationEvidenceRequestError('CHALLENGE_NOT_CURRENT', error.message);
    }
    throw error;
  }
}

function hydrateRequest(
  row: typeof schema.evidenceRequests.$inferSelect
): InvestigationEvidenceRequest {
  const requestedEvidence = parseStoredEvidence(row.requestedEvidence);
  return investigationEvidenceRequestSchema.parse({
    ...row,
    requestedEvidence
  });
}

export function requestInvestigationEvidence(
  database: RecallDatabase,
  input: RequestInvestigationEvidenceInput,
  context: LifecycleContext,
  now = new Date()
): { request: InvestigationEvidenceRequest; replayed: boolean } {
  if (context.mode !== 'demo') {
    throw new InvestigationEvidenceRequestError(
      'FORBIDDEN',
      'Versioned evidence requests require explicit local demo mode.'
    );
  }
  const parsed = requestInvestigationEvidenceInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationEvidenceRequestError(
      'INVALID_INPUT',
      'Invalid versioned investigation evidence request.'
    );
  }
  const requestedEvidence = canonicalEvidence(parsed.data.requestedEvidence);

  return database.transaction((transaction) => {
    const existing = transaction
      .select()
      .from(schema.evidenceRequests)
      .where(eq(schema.evidenceRequests.id, parsed.data.requestId))
      .get();
    if (existing) {
      const existingEvidence = parseStoredEvidence(existing.requestedEvidence);
      if (
        existing.caseId !== parsed.data.caseId ||
        existing.questionRef !== parsed.data.questionRef ||
        !existingEvidence ||
        !sameEvidence(existingEvidence, requestedEvidence)
      ) {
        throw new InvestigationEvidenceRequestError(
          'REQUEST_CONFLICT',
          'This request ID already identifies a different immutable request attempt.'
        );
      }
      const existingChallengeRef = getInvestigationRequestChallengeRef(
        transaction,
        parsed.data.requestId
      );
      if (existingChallengeRef !== challengeRefOf(parsed.data)) {
        throw new InvestigationEvidenceRequestError(
          'CHALLENGE_ASSOCIATION_CONFLICT',
          'This request ID belongs to a different investigation authorization context.'
        );
      }
      return { request: hydrateRequest(existing), replayed: true };
    }

    const challengeRef = challengeRefOf(parsed.data);
    const challengeAuthorization = 'challengeRef' in parsed.data
      ? resolveChallengeAuthorization(transaction, parsed.data)
      : null;
    const current = challengeAuthorization
      ? challengeAuthorization.snapshot
      : readCaseSnapshot(transaction, parsed.data.caseId);
    const authorizationContext = challengeAuthorization?.authoritativeBaseline.kind ===
      'APPLIED_CHALLENGE_CONFLICT' ? 'APPLIED_CHALLENGE_CONFLICT' : 'OPEN_CHALLENGE';
    if (!current) {
      throw new InvestigationEvidenceRequestError(
        'VERSIONED_CASE_REQUIRED',
        'The owning case does not have a versioned investigation lifecycle.'
      );
    }
    if (!('challengeRef' in parsed.data)) {
      if (current.caseVersion !== parsed.data.expectedCaseVersion) {
        throw new InvestigationEvidenceRequestError(
          'STALE_CASE_VERSION',
          'Refresh the case before requesting evidence for its current gaps.'
        );
      }

      const matchingGaps = current.investigation?.gaps.filter(
        (gap) => gap.id === parsed.data.questionRef
      ) ?? [];
      if (matchingGaps.length === 0) {
        throw new InvestigationEvidenceRequestError(
          'QUESTION_NOT_CURRENT',
          'The question reference is not an exact current InvestigationOutcome gap.'
        );
      }
      if (matchingGaps.length > 1) {
        throw new InvestigationEvidenceRequestError(
          'QUESTION_AMBIGUOUS',
          'The current investigation contains a duplicated gap identity.'
        );
      }
      if (matchingGaps[0].code !== 'BATCH_MISSING') {
        throw new InvestigationEvidenceRequestError(
          'QUESTION_NOT_CURRENT',
          'Only the current BATCH_MISSING gap is requestable in this version.'
        );
      }

      ensureCurrentInvestigationQuestionRegistered(transaction, {
        caseId: current.caseId,
        questionRef: matchingGaps[0].id,
        expectedCaseVersion: current.caseVersion,
        demo: true
      });
    }

    const caseRecord = transaction
      .select()
      .from(schema.cases)
      .where(eq(schema.cases.id, current.caseId))
      .get();
    if (!caseRecord) {
      throw new InvestigationEvidenceRequestError(
        'VERSIONED_CASE_REQUIRED',
        'The versioned investigation has no owning case record.'
      );
    }
    const candidateMatches = transaction
      .select()
      .from(schema.matches)
      .where(and(
        eq(schema.matches.alertId, caseRecord.alertId),
        eq(schema.matches.productId, current.productId)
      ))
      .all();
    if (candidateMatches.length === 0) {
      throw new InvestigationEvidenceRequestError(
        'MATCH_NOT_FOUND',
        'No persisted match relates the authoritative case alert and product.'
      );
    }
    if (candidateMatches.length > 1) {
      throw new InvestigationEvidenceRequestError(
        'MATCH_AMBIGUOUS',
        'More than one match relates the authoritative case alert and product.'
      );
    }

    const product = transaction
      .select({ supplierEmail: schema.products.supplierEmail })
      .from(schema.products)
      .where(eq(schema.products.id, current.productId))
      .get();
    if (!product) {
      throw new InvestigationEvidenceRequestError(
        'MATCH_NOT_FOUND',
        'The authoritative case product no longer exists.'
      );
    }

    const createdAt = now.toISOString();
    transaction.insert(schema.evidenceRequests).values({
      id: parsed.data.requestId,
      matchId: candidateMatches[0].id,
      caseId: current.caseId,
      questionRef: parsed.data.questionRef,
      requestedEvidence: JSON.stringify(requestedEvidence),
      recipient: product.supplierEmail,
      status: 'pending',
      createdAt,
      resolvedAt: null
    }).run();
    if (challengeRef !== null) {
      transaction.insert(schema.investigationChallengeRequests).values({
        requestId: parsed.data.requestId,
        challengeRef
      }).run();
    }
    transaction.insert(schema.auditEvents).values({
      id: randomUUID(),
      caseId: current.caseId,
      alertId: caseRecord.alertId,
      eventType: 'investigation_evidence_requested',
      actorType: 'human',
      actorName: actorId,
      summary: challengeRef === null
        ? 'Recorded a pending evidence-request attempt for a current investigation gap.'
        : challengeAuthorization?.authoritativeBaseline.kind === 'APPLIED_CHALLENGE_CONFLICT'
          ? 'Recorded a pending evidence-request attempt under an applied-conflict continuation.'
          : 'Recorded a pending evidence-request attempt under a current investigation Challenge.',
      metadataJson: JSON.stringify({
        requestId: parsed.data.requestId,
        caseId: current.caseId,
        questionRef: parsed.data.questionRef,
        requestedEvidence,
        caseVersion: current.caseVersion,
        materialRevision: current.materialRevision,
        matchId: candidateMatches[0].id,
        ...(challengeRef === null
          ? {}
          : { authorizationContext, challengeRef }),
        demo: true
      }),
      createdAt
    }).run();

    const inserted = transaction
      .select()
      .from(schema.evidenceRequests)
      .where(eq(schema.evidenceRequests.id, parsed.data.requestId))
      .get();
    if (!inserted) throw new Error('Investigation evidence request insert did not persist.');
    return { request: hydrateRequest(inserted), replayed: false };
  }, { behavior: 'immediate' });
}
