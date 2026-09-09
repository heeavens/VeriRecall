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
import { ensureCurrentInvestigationQuestionRegistered } from './questions';

const actorId = 'demo_operator';
const questionRefSchema = z.string().trim().min(1).max(500);
const timestampSchema = z.string().datetime();

const requestInvestigationEvidenceInputSchema = z.strictObject({
  requestId: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: questionRefSchema,
  expectedCaseVersion: z.number().int().positive(),
  requestedEvidence: z.array(z.enum(evidenceTypes)).min(1),
  demo: z.literal(true)
});

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
  | 'QUESTION_NOT_CURRENT'
  | 'QUESTION_AMBIGUOUS'
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
      return { request: hydrateRequest(existing), replayed: true };
    }

    const current = readCaseSnapshot(transaction, parsed.data.caseId);
    if (!current) {
      throw new InvestigationEvidenceRequestError(
        'VERSIONED_CASE_REQUIRED',
        'The owning case does not have a versioned investigation lifecycle.'
      );
    }
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
      questionRef: matchingGaps[0].id,
      requestedEvidence: JSON.stringify(requestedEvidence),
      recipient: product.supplierEmail,
      status: 'pending',
      createdAt,
      resolvedAt: null
    }).run();
    transaction.insert(schema.auditEvents).values({
      id: randomUUID(),
      caseId: current.caseId,
      alertId: caseRecord.alertId,
      eventType: 'investigation_evidence_requested',
      actorType: 'human',
      actorName: actorId,
      summary: 'Recorded a pending evidence-request attempt for a current investigation gap.',
      metadataJson: JSON.stringify({
        requestId: parsed.data.requestId,
        caseId: current.caseId,
        questionRef: matchingGaps[0].id,
        requestedEvidence,
        caseVersion: current.caseVersion,
        materialRevision: current.materialRevision,
        matchId: candidateMatches[0].id,
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
