import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';

const opaqueReferenceSchema = z.string().min(1).max(500).refine(
  (value) => value.trim().length > 0,
  'References must contain a non-whitespace character.'
);
const timestampSchema = z.string().datetime();
const integrityHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

const inputBaseShape = {
  evidenceRef: opaqueReferenceSchema,
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  evidenceRequestId: z.string().uuid().nullable(),
  sourceKind: z.enum(schema.investigationEvidenceSourceKinds),
  sourceIdentifier: opaqueReferenceSchema,
  validAsOf: timestampSchema.nullable(),
  demo: z.boolean()
};

const structuredEvidenceInputSchema = z.strictObject({
  ...inputBaseShape,
  contentKind: z.literal('STRUCTURED'),
  contentJson: z.json(),
  contentLocator: z.null()
});

const locatorEvidenceInputSchema = z.strictObject({
  ...inputBaseShape,
  contentKind: z.literal('LOCATOR'),
  contentJson: z.null(),
  contentLocator: opaqueReferenceSchema,
  integrityHash: integrityHashSchema
});

const recordInvestigationEvidenceInputSchema = z.discriminatedUnion('contentKind', [
  structuredEvidenceInputSchema,
  locatorEvidenceInputSchema
]);

const evidenceBaseShape = {
  ...inputBaseShape,
  receivedAt: timestampSchema,
  integrityHash: integrityHashSchema
};

const investigationEvidenceSchema = z.discriminatedUnion('contentKind', [
  z.strictObject({
    ...evidenceBaseShape,
    contentKind: z.literal('STRUCTURED'),
    contentJson: z.json(),
    contentLocator: z.null()
  }),
  z.strictObject({
    ...evidenceBaseShape,
    contentKind: z.literal('LOCATOR'),
    contentJson: z.null(),
    contentLocator: opaqueReferenceSchema
  })
]);

const readInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  evidenceRef: opaqueReferenceSchema
});

export type RecordInvestigationEvidenceInput = z.infer<
  typeof recordInvestigationEvidenceInputSchema
>;
export type InvestigationEvidence = z.infer<typeof investigationEvidenceSchema>;

export type EvidenceRegistryErrorCode =
  | 'INVALID_INPUT'
  | 'CASE_NOT_FOUND'
  | 'EVIDENCE_REQUEST_NOT_FOUND'
  | 'EVIDENCE_REQUEST_CASE_MISMATCH'
  | 'EVIDENCE_CONFLICT';

export class EvidenceRegistryError extends Error {
  constructor(
    public readonly code: EvidenceRegistryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'EvidenceRegistryError';
  }
}

function canonicalJson(value: z.infer<ReturnType<typeof z.json>>): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Validated JSON content could not be serialized.');
  return serialized;
}

function parseInput(input: RecordInvestigationEvidenceInput) {
  const parsed = recordInvestigationEvidenceInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvidenceRegistryError('INVALID_INPUT', 'Invalid investigation evidence record.');
  }
  return parsed.data;
}

function prepareRecord(input: ReturnType<typeof parseInput>) {
  if (input.contentKind === 'STRUCTURED') {
    const contentJson = canonicalJson(input.contentJson);
    return {
      ...input,
      contentJson,
      integrityHash: createHash('sha256').update(contentJson).digest('hex')
    };
  }
  return { ...input };
}

type PreparedEvidence = ReturnType<typeof prepareRecord>;

function hydrateRecord(
  row: typeof schema.investigationEvidence.$inferSelect
): InvestigationEvidence {
  return investigationEvidenceSchema.parse({
    ...row,
    contentJson: row.contentJson === null ? null : JSON.parse(row.contentJson)
  });
}

function recordsAreEqual(
  existing: typeof schema.investigationEvidence.$inferSelect,
  incoming: PreparedEvidence
): boolean {
  return existing.evidenceRef === incoming.evidenceRef &&
    existing.caseId === incoming.caseId &&
    existing.questionRef === incoming.questionRef &&
    existing.evidenceRequestId === incoming.evidenceRequestId &&
    existing.sourceKind === incoming.sourceKind &&
    existing.sourceIdentifier === incoming.sourceIdentifier &&
    existing.validAsOf === incoming.validAsOf &&
    existing.contentKind === incoming.contentKind &&
    existing.contentJson === incoming.contentJson &&
    existing.contentLocator === incoming.contentLocator &&
    existing.integrityHash === incoming.integrityHash &&
    existing.demo === incoming.demo;
}

function assertEvidenceRequestOwnership(
  database: RecallDatabase,
  caseId: string,
  evidenceRequestId: string
): void {
  const request = database
    .select({
      id: schema.evidenceRequests.id,
      caseId: schema.cases.id,
      requestProductId: schema.matches.productId,
      lifecycleProductId: schema.caseLifecycle.productId
    })
    .from(schema.evidenceRequests)
    .innerJoin(schema.matches, eq(schema.matches.id, schema.evidenceRequests.matchId))
    .leftJoin(schema.cases, eq(schema.cases.alertId, schema.matches.alertId))
    .leftJoin(schema.caseLifecycle, eq(schema.caseLifecycle.caseId, schema.cases.id))
    .where(eq(schema.evidenceRequests.id, evidenceRequestId))
    .get();

  if (!request) {
    throw new EvidenceRegistryError(
      'EVIDENCE_REQUEST_NOT_FOUND',
      'The related evidence request does not exist.'
    );
  }
  if (request.caseId !== caseId || (
    request.lifecycleProductId !== null &&
    request.lifecycleProductId !== request.requestProductId
  )) {
    throw new EvidenceRegistryError(
      'EVIDENCE_REQUEST_CASE_MISMATCH',
      'The evidence request does not belong to the owning case.'
    );
  }
}

export function recordInvestigationEvidence(
  database: RecallDatabase,
  input: RecordInvestigationEvidenceInput,
  now = new Date()
): { evidence: InvestigationEvidence; replayed: boolean } {
  const parsed = parseInput(input);
  const prepared = prepareRecord(parsed);

  return database.transaction((transaction) => {
    const owningCase = transaction
      .select({ id: schema.cases.id })
      .from(schema.cases)
      .where(eq(schema.cases.id, prepared.caseId))
      .get();
    if (!owningCase) {
      throw new EvidenceRegistryError('CASE_NOT_FOUND', 'The owning case does not exist.');
    }

    const existing = transaction
      .select()
      .from(schema.investigationEvidence)
      .where(eq(schema.investigationEvidence.evidenceRef, prepared.evidenceRef))
      .get();
    if (existing) {
      if (!recordsAreEqual(existing, prepared)) {
        throw new EvidenceRegistryError(
          'EVIDENCE_CONFLICT',
          'This evidence reference already identifies a different immutable record.'
        );
      }
      return { evidence: hydrateRecord(existing), replayed: true };
    }

    if (prepared.evidenceRequestId !== null) {
      assertEvidenceRequestOwnership(transaction, prepared.caseId, prepared.evidenceRequestId);
    }

    const insertedRecord = {
      ...prepared,
      receivedAt: now.toISOString()
    } satisfies typeof schema.investigationEvidence.$inferInsert;
    transaction.insert(schema.investigationEvidence).values(insertedRecord).run();
    const inserted = transaction
      .select()
      .from(schema.investigationEvidence)
      .where(eq(schema.investigationEvidence.evidenceRef, prepared.evidenceRef))
      .get();
    if (!inserted) throw new Error('Investigation evidence insert did not persist a record.');
    return { evidence: hydrateRecord(inserted), replayed: false };
  }, { behavior: 'immediate' });
}

export function getInvestigationEvidence(
  database: RecallDatabase,
  caseId: string,
  evidenceRef: string
): InvestigationEvidence | null {
  const parsed = readInputSchema.safeParse({ caseId, evidenceRef });
  if (!parsed.success) {
    throw new EvidenceRegistryError('INVALID_INPUT', 'Invalid investigation evidence lookup.');
  }

  const row = database
    .select()
    .from(schema.investigationEvidence)
    .where(and(
      eq(schema.investigationEvidence.caseId, parsed.data.caseId),
      eq(schema.investigationEvidence.evidenceRef, parsed.data.evidenceRef)
    ))
    .get();
  return row ? hydrateRecord(row) : null;
}
