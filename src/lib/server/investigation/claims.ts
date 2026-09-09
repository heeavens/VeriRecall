import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import {
  readCaseSnapshot,
  type LifecycleContext
} from '../workflow/case-lifecycle';

const opaqueReferenceSchema = z.string().min(1).max(500).refine(
  (value) => value.trim().length > 0,
  'References must contain a non-whitespace character.'
);
const timestampSchema = z.string().datetime();
const lotSchema = z.string().min(1).max(500).refine(
  (value) => value.trim().length > 0,
  'The asserted lot must contain a non-whitespace character.'
);
const derivationMetadataSchema = z.record(z.string(), z.json()).nullable();

const recordInvestigationClaimInputSchema = z.strictObject({
  claimRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  expectedCaseVersion: z.number().int().positive(),
  claimType: z.literal('AFFECTED_BATCH_LOT'),
  value: z.strictObject({ lot: lotSchema }),
  evidenceRefs: z.array(opaqueReferenceSchema).min(1),
  originKind: z.enum(schema.investigationClaimOriginKinds),
  producerIdentifier: opaqueReferenceSchema,
  derivationMetadata: derivationMetadataSchema,
  supersedesClaimRef: z.string().uuid().nullable(),
  demo: z.literal(true)
});

const investigationClaimSchema = z.strictObject({
  claimRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  subjectRef: z.string().uuid(),
  claimType: z.literal('AFFECTED_BATCH_LOT'),
  value: z.strictObject({ lot: lotSchema }),
  evidenceRefs: z.array(opaqueReferenceSchema).min(1).refine(
    (values) => new Set(values).size === values.length,
    'Duplicate evidence references are not canonical.'
  ),
  originKind: z.enum(schema.investigationClaimOriginKinds),
  producerIdentifier: opaqueReferenceSchema,
  derivationMetadata: derivationMetadataSchema,
  supersedesClaimRef: z.string().uuid().nullable(),
  createdAt: timestampSchema,
  demo: z.boolean()
});

const getInvestigationClaimInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  claimRef: z.string().uuid()
});

const listInvestigationClaimsInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema
});

export type RecordInvestigationClaimInput = z.infer<
  typeof recordInvestigationClaimInputSchema
>;
export type InvestigationClaim = z.infer<typeof investigationClaimSchema>;

export type InvestigationClaimErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'VERSIONED_CASE_REQUIRED'
  | 'STALE_CASE_VERSION'
  | 'QUESTION_NOT_CURRENT'
  | 'QUESTION_AMBIGUOUS'
  | 'EVIDENCE_NOT_FOUND'
  | 'EVIDENCE_CASE_MISMATCH'
  | 'EVIDENCE_QUESTION_MISMATCH'
  | 'EVIDENCE_REQUEST_MISMATCH'
  | 'LEGACY_EVIDENCE_REQUEST_UNSUPPORTED'
  | 'SUPERSEDED_CLAIM_NOT_FOUND'
  | 'SUPERSESSION_MISMATCH'
  | 'CLAIM_CONFLICT';

export class InvestigationClaimError extends Error {
  constructor(
    public readonly code: InvestigationClaimErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvestigationClaimError';
  }
}

type JsonValue = z.infer<ReturnType<typeof z.json>>;

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Validated JSON metadata could not be serialized.');
  return serialized;
}

function canonicalEvidenceRefs(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

function parseInput(input: RecordInvestigationClaimInput) {
  const parsed = recordInvestigationClaimInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationClaimError('INVALID_INPUT', 'Invalid investigation claim record.');
  }
  return parsed.data;
}

function prepareInput(input: ReturnType<typeof parseInput>) {
  const evidenceRefs = canonicalEvidenceRefs(input.evidenceRefs);
  return {
    ...input,
    evidenceRefs,
    valueJson: canonicalJson(input.value),
    evidenceRefsJson: canonicalJson(evidenceRefs),
    derivationMetadataJson: input.derivationMetadata === null
      ? null
      : canonicalJson(input.derivationMetadata)
  };
}

type PreparedClaimInput = ReturnType<typeof prepareInput>;

function hydrateClaim(row: typeof schema.investigationClaims.$inferSelect): InvestigationClaim {
  return investigationClaimSchema.parse({
    claimRef: row.claimRef,
    caseId: row.caseId,
    questionRef: row.questionRef,
    subjectRef: row.subjectRef,
    claimType: row.claimType,
    value: JSON.parse(row.valueJson),
    evidenceRefs: JSON.parse(row.evidenceRefsJson),
    originKind: row.originKind,
    producerIdentifier: row.producerIdentifier,
    derivationMetadata: row.derivationMetadataJson === null
      ? null
      : JSON.parse(row.derivationMetadataJson),
    supersedesClaimRef: row.supersedesClaimRef,
    createdAt: row.createdAt,
    demo: row.demo
  });
}

function immutableSemanticsMatch(
  row: typeof schema.investigationClaims.$inferSelect,
  input: PreparedClaimInput
): boolean {
  return row.claimRef === input.claimRef &&
    row.caseId === input.caseId &&
    row.questionRef === input.questionRef &&
    row.claimType === input.claimType &&
    row.valueJson === input.valueJson &&
    row.evidenceRefsJson === input.evidenceRefsJson &&
    row.originKind === input.originKind &&
    row.producerIdentifier === input.producerIdentifier &&
    row.derivationMetadataJson === input.derivationMetadataJson &&
    row.supersedesClaimRef === input.supersedesClaimRef &&
    row.demo === input.demo;
}

function validateEvidenceOwnership(
  database: RecallDatabase,
  input: PreparedClaimInput
): void {
  for (const evidenceRef of input.evidenceRefs) {
    const evidence = database
      .select()
      .from(schema.investigationEvidence)
      .where(eq(schema.investigationEvidence.evidenceRef, evidenceRef))
      .get();
    if (!evidence) {
      throw new InvestigationClaimError(
        'EVIDENCE_NOT_FOUND',
        'Every claim source must be registered investigation evidence.'
      );
    }
    if (evidence.caseId !== input.caseId) {
      throw new InvestigationClaimError(
        'EVIDENCE_CASE_MISMATCH',
        'Claim evidence must belong to the owning case.'
      );
    }
    if (evidence.questionRef !== input.questionRef) {
      throw new InvestigationClaimError(
        'EVIDENCE_QUESTION_MISMATCH',
        'Claim evidence must belong to the investigation question.'
      );
    }
    if (evidence.evidenceRequestId === null) continue;

    const request = database
      .select({
        caseId: schema.evidenceRequests.caseId,
        questionRef: schema.evidenceRequests.questionRef
      })
      .from(schema.evidenceRequests)
      .where(eq(schema.evidenceRequests.id, evidence.evidenceRequestId))
      .get();
    if (!request) {
      throw new InvestigationClaimError(
        'EVIDENCE_REQUEST_MISMATCH',
        'Claim evidence references a missing evidence request.'
      );
    }
    if (request.caseId === null && request.questionRef === null) {
      throw new InvestigationClaimError(
        'LEGACY_EVIDENCE_REQUEST_UNSUPPORTED',
        'Legacy evidence requests cannot prove versioned investigation question ownership.'
      );
    }
    if (request.caseId !== input.caseId || request.questionRef !== input.questionRef) {
      throw new InvestigationClaimError(
        'EVIDENCE_REQUEST_MISMATCH',
        'Claim evidence request ownership must match the case and question.'
      );
    }
  }
}

function validateSupersession(
  database: RecallDatabase,
  input: PreparedClaimInput,
  subjectRef: string
): void {
  if (input.supersedesClaimRef === null) return;
  if (input.supersedesClaimRef === input.claimRef) {
    throw new InvestigationClaimError(
      'SUPERSESSION_MISMATCH',
      'A claim cannot supersede itself.'
    );
  }
  const superseded = database
    .select()
    .from(schema.investigationClaims)
    .where(eq(schema.investigationClaims.claimRef, input.supersedesClaimRef))
    .get();
  if (!superseded) {
    throw new InvestigationClaimError(
      'SUPERSEDED_CLAIM_NOT_FOUND',
      'The superseded claim does not exist.'
    );
  }
  if (
    superseded.caseId !== input.caseId ||
    superseded.questionRef !== input.questionRef ||
    superseded.subjectRef !== subjectRef ||
    superseded.claimType !== input.claimType
  ) {
    throw new InvestigationClaimError(
      'SUPERSESSION_MISMATCH',
      'A claim may supersede only the same case, question, subject, and claim type.'
    );
  }
}

export function recordInvestigationClaim(
  database: RecallDatabase,
  input: RecordInvestigationClaimInput,
  context: LifecycleContext,
  now = new Date()
): { claim: InvestigationClaim; replayed: boolean } {
  if (context.mode !== 'demo') {
    throw new InvestigationClaimError(
      'FORBIDDEN',
      'Investigation claims require explicit local demo mode.'
    );
  }
  const prepared = prepareInput(parseInput(input));

  return database.transaction((transaction) => {
    const existing = transaction
      .select()
      .from(schema.investigationClaims)
      .where(eq(schema.investigationClaims.claimRef, prepared.claimRef))
      .get();
    if (existing) {
      if (!immutableSemanticsMatch(existing, prepared)) {
        throw new InvestigationClaimError(
          'CLAIM_CONFLICT',
          'This claim reference already identifies a different immutable assertion.'
        );
      }
      return { claim: hydrateClaim(existing), replayed: true };
    }

    const current = readCaseSnapshot(transaction, prepared.caseId);
    if (!current) {
      throw new InvestigationClaimError(
        'VERSIONED_CASE_REQUIRED',
        'The owning case does not have a versioned investigation lifecycle.'
      );
    }
    if (current.caseVersion !== prepared.expectedCaseVersion) {
      throw new InvestigationClaimError(
        'STALE_CASE_VERSION',
        'Refresh the case before recording a claim for its current gaps.'
      );
    }

    const matchingGaps = current.investigation?.gaps.filter(
      (gap) => gap.id === prepared.questionRef
    ) ?? [];
    if (matchingGaps.length === 0) {
      throw new InvestigationClaimError(
        'QUESTION_NOT_CURRENT',
        'The question reference is not an exact current InvestigationOutcome gap.'
      );
    }
    if (matchingGaps.length > 1) {
      throw new InvestigationClaimError(
        'QUESTION_AMBIGUOUS',
        'The current investigation contains a duplicated gap identity.'
      );
    }
    if (matchingGaps[0].code !== 'BATCH_MISSING') {
      throw new InvestigationClaimError(
        'QUESTION_NOT_CURRENT',
        'Only the current BATCH_MISSING gap supports claims in this version.'
      );
    }

    validateEvidenceOwnership(transaction, prepared);
    validateSupersession(transaction, prepared, current.productId);

    const caseRecord = transaction
      .select({ alertId: schema.cases.alertId })
      .from(schema.cases)
      .where(eq(schema.cases.id, current.caseId))
      .get();
    if (!caseRecord) {
      throw new InvestigationClaimError(
        'VERSIONED_CASE_REQUIRED',
        'The versioned investigation has no owning case record.'
      );
    }

    const createdAt = now.toISOString();
    transaction.insert(schema.investigationClaims).values({
      claimRef: prepared.claimRef,
      caseId: current.caseId,
      questionRef: matchingGaps[0].id,
      subjectRef: current.productId,
      claimType: prepared.claimType,
      valueJson: prepared.valueJson,
      evidenceRefsJson: prepared.evidenceRefsJson,
      originKind: prepared.originKind,
      producerIdentifier: prepared.producerIdentifier,
      derivationMetadataJson: prepared.derivationMetadataJson,
      supersedesClaimRef: prepared.supersedesClaimRef,
      createdAt,
      demo: prepared.demo
    }).run();
    transaction.insert(schema.auditEvents).values({
      id: randomUUID(),
      caseId: current.caseId,
      alertId: caseRecord.alertId,
      eventType: 'investigation_claim_recorded',
      actorType: 'agent',
      actorName: 'investigation_claim_registry',
      summary: 'Recorded an untrusted evidence-derived investigation claim.',
      metadataJson: JSON.stringify({
        claimRef: prepared.claimRef,
        caseId: current.caseId,
        questionRef: matchingGaps[0].id,
        subjectRef: current.productId,
        claimType: prepared.claimType,
        evidenceRefs: prepared.evidenceRefs,
        originKind: prepared.originKind,
        producerIdentifier: prepared.producerIdentifier,
        caseVersion: current.caseVersion,
        materialRevision: current.materialRevision,
        supersedesClaimRef: prepared.supersedesClaimRef,
        demo: prepared.demo
      }),
      createdAt
    }).run();

    const inserted = transaction
      .select()
      .from(schema.investigationClaims)
      .where(eq(schema.investigationClaims.claimRef, prepared.claimRef))
      .get();
    if (!inserted) throw new Error('Investigation claim insert did not persist.');
    return { claim: hydrateClaim(inserted), replayed: false };
  }, { behavior: 'immediate' });
}

export function getInvestigationClaim(
  database: RecallDatabase,
  caseId: string,
  claimRef: string
): InvestigationClaim | null {
  const parsed = getInvestigationClaimInputSchema.safeParse({ caseId, claimRef });
  if (!parsed.success) {
    throw new InvestigationClaimError('INVALID_INPUT', 'Invalid investigation claim lookup.');
  }
  const row = database
    .select()
    .from(schema.investigationClaims)
    .where(and(
      eq(schema.investigationClaims.caseId, parsed.data.caseId),
      eq(schema.investigationClaims.claimRef, parsed.data.claimRef)
    ))
    .get();
  return row ? hydrateClaim(row) : null;
}

export function listInvestigationClaims(
  database: RecallDatabase,
  caseId: string,
  questionRef: string
): InvestigationClaim[] {
  const parsed = listInvestigationClaimsInputSchema.safeParse({ caseId, questionRef });
  if (!parsed.success) {
    throw new InvestigationClaimError('INVALID_INPUT', 'Invalid investigation claim list lookup.');
  }
  return database
    .select()
    .from(schema.investigationClaims)
    .where(and(
      eq(schema.investigationClaims.caseId, parsed.data.caseId),
      eq(schema.investigationClaims.questionRef, parsed.data.questionRef)
    ))
    .orderBy(
      asc(schema.investigationClaims.createdAt),
      asc(schema.investigationClaims.claimRef)
    )
    .all()
    .map(hydrateClaim);
}
