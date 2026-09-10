import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { normalizeBatch } from '../alerts/normalization';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import {
  classifyEvidenceForInvestigationChallenge,
  getInvestigationAssessmentChallengeRef,
  getInvestigationClaimChallengeRef
} from './challenge-artifacts';
import {
  InvestigationChallengeError,
  resolveCurrentInvestigationChallengeForWrite,
  type CurrentInvestigationChallengeForWrite
} from './challenges';
import { demoHumanAssessorIdentifier } from './demo-context';
import { ensureCurrentInvestigationQuestionRegistered } from './questions';
import {
  readCaseSnapshot,
  type LifecycleContext
} from '../workflow/case-lifecycle';

export { demoHumanAssessorIdentifier };
export const batchContradictionRule = {
  identifier: 'batch-normalization-comparison',
  version: 'v1'
} as const;

const opaqueReferenceSchema = z.string().min(1).max(500).refine(
  (value) => value.trim().length > 0,
  'References must contain a non-whitespace character.'
);
const rationaleSchema = z.string().min(1).max(10_000).refine(
  (value) => value.trim().length > 0,
  'Rationale must contain a non-whitespace character.'
);
const timestampSchema = z.string().datetime();

const assessmentInputShape = {
  assessmentRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  expectedCaseVersion: z.number().int().positive(),
  verdict: z.enum(schema.investigationAssessmentVerdicts),
  targetClaimRef: z.string().uuid().nullable(),
  evidenceRefs: z.array(opaqueReferenceSchema).min(1),
  relatedClaimRefs: z.array(z.string().uuid()),
  assessorKind: z.enum(schema.investigationAssessmentAssessorKinds),
  assessorIdentifier: opaqueReferenceSchema.nullable(),
  ruleIdentifier: opaqueReferenceSchema.nullable(),
  ruleVersion: opaqueReferenceSchema.nullable(),
  rationale: rationaleSchema,
  supersedesAssessmentRef: z.string().uuid().nullable(),
  demo: z.literal(true)
};

function validateAssessorInput(
  value: z.infer<z.ZodObject<typeof assessmentInputShape>>,
  context: z.RefinementCtx
): void {
  const hasRuleIdentifier = value.ruleIdentifier !== null;
  const hasRuleVersion = value.ruleVersion !== null;
  if (hasRuleIdentifier !== hasRuleVersion) {
    context.addIssue({
      code: 'custom',
      message: 'Rule identifier and version must both be present or both be null.'
    });
  }
  if (value.assessorKind === 'HUMAN') {
    if (value.assessorIdentifier !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Human assessor identity is derived from trusted server context.'
      });
    }
  } else {
    if (value.assessorIdentifier === null) {
      context.addIssue({ code: 'custom', message: 'RULE and AI assessments require an assessor.' });
    }
    if (!hasRuleIdentifier || !hasRuleVersion) {
      context.addIssue({
        code: 'custom',
        message: 'RULE and AI assessments require a rule identifier and version.'
      });
    }
  }
}

const openGapAssessmentInputSchema = z.strictObject(assessmentInputShape)
  .superRefine(validateAssessorInput);

const challengeAssessmentInputSchema = z.strictObject({
  ...assessmentInputShape,
  challengeRef: z.string().uuid(),
  expectedMaterialRevision: z.number().int().positive()
}).superRefine(validateAssessorInput);

const recordInvestigationAssessmentInputSchema = z.union([
  challengeAssessmentInputSchema,
  openGapAssessmentInputSchema
]);

const investigationAssessmentSchema = z.strictObject({
  assessmentRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  targetClaimRef: z.string().uuid().nullable(),
  verdict: z.enum(schema.investigationAssessmentVerdicts),
  evidenceRefs: z.array(opaqueReferenceSchema).min(1),
  relatedClaimRefs: z.array(z.string().uuid()),
  assessorKind: z.enum(schema.investigationAssessmentAssessorKinds),
  assessorIdentifier: opaqueReferenceSchema,
  ruleIdentifier: opaqueReferenceSchema.nullable(),
  ruleVersion: opaqueReferenceSchema.nullable(),
  rationale: rationaleSchema,
  basisCaseVersion: z.number().int().positive(),
  supersedesAssessmentRef: z.string().uuid().nullable(),
  createdAt: timestampSchema,
  demo: z.boolean()
});

const getInvestigationAssessmentInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  assessmentRef: z.string().uuid()
});

const listInvestigationAssessmentsInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema
});

const batchClaimValueSchema = z.strictObject({
  lot: z.string().min(1).max(500).refine(
    (value) => value.trim().length > 0,
    'A batch claim must contain a non-whitespace lot.'
  )
});
const storedEvidenceRefsSchema = z.array(opaqueReferenceSchema).min(1);
const storedRelatedClaimRefsSchema = z.array(z.string().uuid());

export type RecordInvestigationAssessmentInput = z.infer<
  typeof recordInvestigationAssessmentInputSchema
>;
export type InvestigationAssessment = z.infer<typeof investigationAssessmentSchema>;

export type InvestigationAssessmentErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'VERSIONED_CASE_REQUIRED'
  | 'STALE_CASE_VERSION'
  | 'STALE_MATERIAL_REVISION'
  | 'QUESTION_NOT_CURRENT'
  | 'QUESTION_AMBIGUOUS'
  | 'CHALLENGE_NOT_CURRENT'
  | 'CHALLENGE_ASSOCIATION_CONFLICT'
  | 'CHALLENGE_EVIDENCE_REQUIRED'
  | 'EVIDENCE_CHALLENGE_MISMATCH'
  | 'CLAIM_CHALLENGE_MISMATCH'
  | 'INVALID_VERDICT_BASIS'
  | 'CLAIM_NOT_FOUND'
  | 'CLAIM_CASE_MISMATCH'
  | 'CLAIM_QUESTION_MISMATCH'
  | 'CLAIM_SUBJECT_MISMATCH'
  | 'UNSUPPORTED_CLAIM_TYPE'
  | 'CLAIM_BASIS_INVALID'
  | 'EVIDENCE_NOT_FOUND'
  | 'EVIDENCE_CASE_MISMATCH'
  | 'EVIDENCE_QUESTION_MISMATCH'
  | 'EVIDENCE_REQUEST_MISMATCH'
  | 'LEGACY_EVIDENCE_REQUEST_UNSUPPORTED'
  | 'EVIDENCE_BASIS_INCOMPLETE'
  | 'CONTRADICTION_NOT_DETERMINISTIC'
  | 'SUPERSEDED_ASSESSMENT_NOT_FOUND'
  | 'SUPERSESSION_MISMATCH'
  | 'ASSESSMENT_CONFLICT';

export class InvestigationAssessmentError extends Error {
  constructor(
    public readonly code: InvestigationAssessmentErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvestigationAssessmentError';
  }
}

function canonicalReferences(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

function parseInput(input: RecordInvestigationAssessmentInput) {
  const parsed = recordInvestigationAssessmentInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationAssessmentError(
      'INVALID_INPUT',
      'Invalid investigation assessment record.'
    );
  }
  return parsed.data;
}

function prepareInput(input: ReturnType<typeof parseInput>) {
  let ruleIdentifier = input.ruleIdentifier;
  let ruleVersion = input.ruleVersion;
  const usesDefaultContradictionRule = input.verdict === 'CONTRADICTED' &&
    ruleIdentifier === null && ruleVersion === null;
  const usesNamedContradictionRule = input.verdict === 'CONTRADICTED' &&
    ruleIdentifier === batchContradictionRule.identifier &&
    ruleVersion === batchContradictionRule.version;
  if (usesDefaultContradictionRule || usesNamedContradictionRule) {
    ruleIdentifier = batchContradictionRule.identifier;
    ruleVersion = batchContradictionRule.version;
  }

  const evidenceRefs = canonicalReferences(input.evidenceRefs);
  const relatedClaimRefs = canonicalReferences(input.relatedClaimRefs);
  return {
    ...input,
    evidenceRefs,
    relatedClaimRefs,
    evidenceRefsJson: JSON.stringify(evidenceRefs),
    relatedClaimRefsJson: JSON.stringify(relatedClaimRefs),
    assessorIdentifier: input.assessorKind === 'HUMAN'
      ? demoHumanAssessorIdentifier
      : input.assessorIdentifier!,
    ruleIdentifier,
    ruleVersion
  };
}

type PreparedAssessmentInput = ReturnType<typeof prepareInput>;
type ClaimRow = typeof schema.investigationClaims.$inferSelect;

function challengeRefOf(input: PreparedAssessmentInput): string | null {
  return 'challengeRef' in input ? input.challengeRef : null;
}

function resolveChallengeAuthorization(
  database: RecallDatabase,
  input: PreparedAssessmentInput & { challengeRef: string; expectedMaterialRevision: number }
): CurrentInvestigationChallengeForWrite {
  try {
    return resolveCurrentInvestigationChallengeForWrite(database, {
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
        throw new InvestigationAssessmentError('STALE_CASE_VERSION', error.message);
      }
      if (error.code === 'STALE_MATERIAL_REVISION') {
        throw new InvestigationAssessmentError('STALE_MATERIAL_REVISION', error.message);
      }
      throw new InvestigationAssessmentError('CHALLENGE_NOT_CURRENT', error.message);
    }
    throw error;
  }
}

function hydrateAssessment(
  row: typeof schema.investigationAssessments.$inferSelect
): InvestigationAssessment {
  return investigationAssessmentSchema.parse({
    assessmentRef: row.assessmentRef,
    caseId: row.caseId,
    questionRef: row.questionRef,
    targetClaimRef: row.targetClaimRef,
    verdict: row.verdict,
    evidenceRefs: JSON.parse(row.evidenceRefsJson),
    relatedClaimRefs: JSON.parse(row.relatedClaimRefsJson),
    assessorKind: row.assessorKind,
    assessorIdentifier: row.assessorIdentifier,
    ruleIdentifier: row.ruleIdentifier,
    ruleVersion: row.ruleVersion,
    rationale: row.rationale,
    basisCaseVersion: row.basisCaseVersion,
    supersedesAssessmentRef: row.supersedesAssessmentRef,
    createdAt: row.createdAt,
    demo: row.demo
  });
}

function immutableSemanticsMatch(
  row: typeof schema.investigationAssessments.$inferSelect,
  input: PreparedAssessmentInput
): boolean {
  return row.assessmentRef === input.assessmentRef &&
    row.caseId === input.caseId &&
    row.questionRef === input.questionRef &&
    row.targetClaimRef === input.targetClaimRef &&
    row.verdict === input.verdict &&
    row.evidenceRefsJson === input.evidenceRefsJson &&
    row.relatedClaimRefsJson === input.relatedClaimRefsJson &&
    row.assessorKind === input.assessorKind &&
    row.assessorIdentifier === input.assessorIdentifier &&
    row.ruleIdentifier === input.ruleIdentifier &&
    row.ruleVersion === input.ruleVersion &&
    row.rationale === input.rationale &&
    row.supersedesAssessmentRef === input.supersedesAssessmentRef &&
    row.demo === input.demo;
}

function validateVerdictStructure(input: PreparedAssessmentInput): void {
  const hasTarget = input.targetClaimRef !== null;
  const relatedCount = input.relatedClaimRefs.length;
  const valid = input.verdict === 'SUPPORTED'
    ? hasTarget && relatedCount === 0
    : input.verdict === 'INSUFFICIENT'
      ? relatedCount === 0
      : input.verdict === 'REJECTED'
        ? hasTarget && relatedCount === 0
        : !hasTarget && relatedCount >= 2;
  if (!valid) {
    throw new InvestigationAssessmentError(
      'INVALID_VERDICT_BASIS',
      'The target and related claims do not match the assessment verdict.'
    );
  }
}

function validateContradictionRule(input: PreparedAssessmentInput): void {
  if (input.verdict !== 'CONTRADICTED') return;
  if (
    input.ruleIdentifier !== batchContradictionRule.identifier ||
    input.ruleVersion !== batchContradictionRule.version
  ) {
    throw new InvestigationAssessmentError(
      'INVALID_INPUT',
      'Contradiction assessments use the server-owned batch comparison rule.'
    );
  }
}

function readClaimEvidenceRefs(row: ClaimRow): string[] {
  try {
    const parsed = storedEvidenceRefsSchema.safeParse(JSON.parse(row.evidenceRefsJson));
    if (!parsed.success) throw new Error('Invalid claim evidence JSON.');
    return canonicalReferences(parsed.data);
  } catch {
    throw new InvestigationAssessmentError(
      'CLAIM_BASIS_INVALID',
      'The stored claim has an invalid evidence basis.'
    );
  }
}

function readBatchLot(row: ClaimRow): string {
  try {
    const parsed = batchClaimValueSchema.safeParse(JSON.parse(row.valueJson));
    if (!parsed.success) throw new Error('Invalid batch claim JSON.');
    return parsed.data.lot;
  } catch {
    throw new InvestigationAssessmentError(
      'CLAIM_BASIS_INVALID',
      'The stored batch claim has an invalid value.'
    );
  }
}

function loadClaim(
  database: RecallDatabase,
  claimRef: string,
  input: PreparedAssessmentInput,
  subjectRef: string
): ClaimRow {
  const claim = database
    .select()
    .from(schema.investigationClaims)
    .where(eq(schema.investigationClaims.claimRef, claimRef))
    .get();
  if (!claim) {
    throw new InvestigationAssessmentError('CLAIM_NOT_FOUND', 'Assessment claim not found.');
  }
  if (claim.caseId !== input.caseId) {
    throw new InvestigationAssessmentError(
      'CLAIM_CASE_MISMATCH',
      'Assessment claims must belong to the owning case.'
    );
  }
  if (claim.questionRef !== input.questionRef) {
    throw new InvestigationAssessmentError(
      'CLAIM_QUESTION_MISMATCH',
      'Assessment claims must belong to the investigation question.'
    );
  }
  if (claim.subjectRef !== subjectRef) {
    throw new InvestigationAssessmentError(
      'CLAIM_SUBJECT_MISMATCH',
      'Assessment claims must concern the authoritative current product.'
    );
  }
  if (claim.claimType !== 'AFFECTED_BATCH_LOT') {
    throw new InvestigationAssessmentError(
      'UNSUPPORTED_CLAIM_TYPE',
      'Only AFFECTED_BATCH_LOT claims can be assessed in this version.'
    );
  }
  return claim;
}

function validateClaimBasis(
  database: RecallDatabase,
  input: PreparedAssessmentInput,
  subjectRef: string,
  partition: string | null
): ClaimRow[] {
  const claimRefs = [
    ...(input.targetClaimRef === null ? [] : [input.targetClaimRef]),
    ...input.relatedClaimRefs
  ];
  const claims = claimRefs.map((claimRef) => loadClaim(database, claimRef, input, subjectRef));
  if (claims.some((claim) => {
    const claimPartition = getInvestigationClaimChallengeRef(database, claim.claimRef);
    return partition === null
      ? claimPartition !== null
      : claimPartition !== null && claimPartition !== partition;
  })) {
    throw new InvestigationAssessmentError(
      'CLAIM_CHALLENGE_MISMATCH',
      partition === null
        ? 'OPEN_GAP assessments may use only unassociated Claims.'
        : 'Challenge assessments may use only baseline or same-Challenge claims.'
    );
  }
  const requiredEvidence = new Set(claims.flatMap(readClaimEvidenceRefs));
  const suppliedEvidence = new Set(input.evidenceRefs);
  if ([...requiredEvidence].some((evidenceRef) => !suppliedEvidence.has(evidenceRef))) {
    throw new InvestigationAssessmentError(
      'EVIDENCE_BASIS_INCOMPLETE',
      'Assessment evidence must cover every referenced claim evidence item.'
    );
  }

  if (input.verdict === 'CONTRADICTED') {
    const normalizedLots = claims.map((claim) => normalizeBatch(readBatchLot(claim)));
    if (
      normalizedLots.some((lot) => lot.length === 0) ||
      new Set(normalizedLots).size < 2
    ) {
      throw new InvestigationAssessmentError(
        'CONTRADICTION_NOT_DETERMINISTIC',
        'Related claims do not contain distinct non-empty normalized batch values.'
      );
    }
  }
  return claims;
}

function validateEvidenceOwnership(
  database: RecallDatabase,
  input: PreparedAssessmentInput
): Array<typeof schema.investigationEvidence.$inferSelect> {
  const records: Array<typeof schema.investigationEvidence.$inferSelect> = [];
  for (const evidenceRef of input.evidenceRefs) {
    const evidence = database
      .select()
      .from(schema.investigationEvidence)
      .where(eq(schema.investigationEvidence.evidenceRef, evidenceRef))
      .get();
    if (!evidence) {
      throw new InvestigationAssessmentError(
        'EVIDENCE_NOT_FOUND',
        'Every assessment basis item must be registered investigation evidence.'
      );
    }
    if (evidence.caseId !== input.caseId) {
      throw new InvestigationAssessmentError(
        'EVIDENCE_CASE_MISMATCH',
        'Assessment evidence must belong to the owning case.'
      );
    }
    if (evidence.questionRef !== input.questionRef) {
      throw new InvestigationAssessmentError(
        'EVIDENCE_QUESTION_MISMATCH',
        'Assessment evidence must belong to the investigation question.'
      );
    }
    records.push(evidence);
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
      throw new InvestigationAssessmentError(
        'EVIDENCE_REQUEST_MISMATCH',
        'Assessment evidence references a missing evidence request.'
      );
    }
    if (request.caseId === null && request.questionRef === null) {
      throw new InvestigationAssessmentError(
        'LEGACY_EVIDENCE_REQUEST_UNSUPPORTED',
        'Legacy evidence requests cannot prove versioned investigation question ownership.'
      );
    }
    if (request.caseId !== input.caseId || request.questionRef !== input.questionRef) {
      throw new InvestigationAssessmentError(
        'EVIDENCE_REQUEST_MISMATCH',
        'Assessment evidence request ownership must match the case and question.'
      );
    }
  }
  return records;
}

function validateChallengeEvidenceBasis(
  database: RecallDatabase,
  evidence: readonly (typeof schema.investigationEvidence.$inferSelect)[],
  authorization: CurrentInvestigationChallengeForWrite
): void {
  const relevance = evidence.map((item) =>
    classifyEvidenceForInvestigationChallenge(database, item, authorization)
  );
  if (relevance.includes('OTHER_CHALLENGE')) {
    throw new InvestigationAssessmentError(
      'EVIDENCE_CHALLENGE_MISMATCH',
      'Challenge assessments cannot use Evidence exclusively associated with another Challenge.'
    );
  }
  if (!relevance.includes('CHALLENGE_RELEVANT')) {
    throw new InvestigationAssessmentError(
      'CHALLENGE_EVIDENCE_REQUIRED',
      'A Challenge assessment requires at least one Evidence item relevant to that Challenge.'
    );
  }
}

function validateSupersession(
  database: RecallDatabase,
  input: PreparedAssessmentInput,
  partition: string | null
): void {
  if (input.supersedesAssessmentRef === null) return;
  if (input.supersedesAssessmentRef === input.assessmentRef) {
    throw new InvestigationAssessmentError(
      'SUPERSESSION_MISMATCH',
      'An assessment cannot supersede itself.'
    );
  }
  const superseded = database
    .select()
    .from(schema.investigationAssessments)
    .where(eq(
      schema.investigationAssessments.assessmentRef,
      input.supersedesAssessmentRef
    ))
    .get();
  if (!superseded) {
    throw new InvestigationAssessmentError(
      'SUPERSEDED_ASSESSMENT_NOT_FOUND',
      'The superseded assessment does not exist.'
    );
  }
  if (superseded.caseId !== input.caseId || superseded.questionRef !== input.questionRef) {
    throw new InvestigationAssessmentError(
      'SUPERSESSION_MISMATCH',
      'An assessment may supersede only one for the same case and question.'
    );
  }
  if (
    getInvestigationAssessmentChallengeRef(database, superseded.assessmentRef) !== partition
  ) {
    throw new InvestigationAssessmentError(
      'SUPERSESSION_MISMATCH',
      'Assessment supersession cannot cross OPEN_GAP or Challenge association partitions.'
    );
  }

  const oldClaimRefs = canonicalReferences([
    ...(superseded.targetClaimRef === null ? [] : [superseded.targetClaimRef]),
    ...parseStoredRelatedClaimRefs(superseded.relatedClaimRefsJson)
  ]);
  const newClaimRefs = new Set([
    ...(input.targetClaimRef === null ? [] : [input.targetClaimRef]),
    ...input.relatedClaimRefs
  ]);
  if (oldClaimRefs.some((claimRef) => !newClaimRefs.has(claimRef))) {
    throw new InvestigationAssessmentError(
      'SUPERSESSION_MISMATCH',
      'A reassessment must retain the superseded assessment claim basis.'
    );
  }
}

function parseStoredRelatedClaimRefs(value: string): string[] {
  try {
    const parsed = storedRelatedClaimRefsSchema.safeParse(JSON.parse(value));
    if (!parsed.success) throw new Error('Invalid related claims JSON.');
    return canonicalReferences(parsed.data);
  } catch {
    throw new InvestigationAssessmentError(
      'SUPERSESSION_MISMATCH',
      'The superseded assessment has an invalid claim basis.'
    );
  }
}

export function recordInvestigationAssessment(
  database: RecallDatabase,
  input: RecordInvestigationAssessmentInput,
  context: LifecycleContext,
  now = new Date()
): { assessment: InvestigationAssessment; replayed: boolean } {
  if (context.mode !== 'demo') {
    throw new InvestigationAssessmentError(
      'FORBIDDEN',
      'Investigation assessments require explicit local demo mode.'
    );
  }
  const prepared = prepareInput(parseInput(input));

  return database.transaction((transaction) => {
    const existing = transaction
      .select()
      .from(schema.investigationAssessments)
      .where(eq(schema.investigationAssessments.assessmentRef, prepared.assessmentRef))
      .get();
    if (existing) {
      if (!immutableSemanticsMatch(existing, prepared)) {
        throw new InvestigationAssessmentError(
          'ASSESSMENT_CONFLICT',
          'This assessment reference already identifies different immutable analysis.'
        );
      }
      const existingChallengeRef = getInvestigationAssessmentChallengeRef(
        transaction,
        prepared.assessmentRef
      );
      if (existingChallengeRef !== challengeRefOf(prepared)) {
        throw new InvestigationAssessmentError(
          'CHALLENGE_ASSOCIATION_CONFLICT',
          'This assessment reference belongs to a different investigation authorization context.'
        );
      }
      return { assessment: hydrateAssessment(existing), replayed: true };
    }

    validateVerdictStructure(prepared);
    validateContradictionRule(prepared);

    const challengeRef = challengeRefOf(prepared);
    const challengeAuthorization = 'challengeRef' in prepared
      ? resolveChallengeAuthorization(transaction, prepared)
      : null;
    const current = challengeAuthorization?.snapshot ??
      readCaseSnapshot(transaction, prepared.caseId);
    if (!current) {
      throw new InvestigationAssessmentError(
        'VERSIONED_CASE_REQUIRED',
        'The owning case does not have a versioned investigation lifecycle.'
      );
    }
    if (challengeAuthorization === null) {
      if (current.caseVersion !== prepared.expectedCaseVersion) {
        throw new InvestigationAssessmentError(
          'STALE_CASE_VERSION',
          'Refresh the case before assessing its current investigation question.'
        );
      }

      const matchingGaps = current.investigation?.gaps.filter(
        (gap) => gap.id === prepared.questionRef
      ) ?? [];
      if (matchingGaps.length === 0) {
        throw new InvestigationAssessmentError(
          'QUESTION_NOT_CURRENT',
          'The question reference is not an exact current InvestigationOutcome gap.'
        );
      }
      if (matchingGaps.length > 1) {
        throw new InvestigationAssessmentError(
          'QUESTION_AMBIGUOUS',
          'The current investigation contains a duplicated gap identity.'
        );
      }
      if (matchingGaps[0].code !== 'BATCH_MISSING') {
        throw new InvestigationAssessmentError(
          'QUESTION_NOT_CURRENT',
          'Only the current BATCH_MISSING gap supports assessments in this version.'
        );
      }

      ensureCurrentInvestigationQuestionRegistered(transaction, {
        caseId: current.caseId,
        questionRef: matchingGaps[0].id,
        expectedCaseVersion: current.caseVersion,
        demo: true
      });
    }

    const evidence = validateEvidenceOwnership(transaction, prepared);
    if (challengeAuthorization !== null) {
      validateChallengeEvidenceBasis(transaction, evidence, challengeAuthorization);
    }
    validateClaimBasis(transaction, prepared, current.productId, challengeRef);
    validateSupersession(transaction, prepared, challengeRef);

    const caseRecord = transaction
      .select({ alertId: schema.cases.alertId })
      .from(schema.cases)
      .where(eq(schema.cases.id, current.caseId))
      .get();
    if (!caseRecord) {
      throw new InvestigationAssessmentError(
        'VERSIONED_CASE_REQUIRED',
        'The versioned investigation has no owning case record.'
      );
    }

    const createdAt = now.toISOString();
    transaction.insert(schema.investigationAssessments).values({
      assessmentRef: prepared.assessmentRef,
      caseId: current.caseId,
      questionRef: prepared.questionRef,
      targetClaimRef: prepared.targetClaimRef,
      verdict: prepared.verdict,
      evidenceRefsJson: prepared.evidenceRefsJson,
      relatedClaimRefsJson: prepared.relatedClaimRefsJson,
      assessorKind: prepared.assessorKind,
      assessorIdentifier: prepared.assessorIdentifier,
      ruleIdentifier: prepared.ruleIdentifier,
      ruleVersion: prepared.ruleVersion,
      rationale: prepared.rationale,
      basisCaseVersion: current.caseVersion,
      supersedesAssessmentRef: prepared.supersedesAssessmentRef,
      createdAt,
      demo: prepared.demo
    }).run();
    if (challengeRef !== null) {
      transaction.insert(schema.investigationChallengeAssessments).values({
        assessmentRef: prepared.assessmentRef,
        challengeRef
      }).run();
    }
    transaction.insert(schema.auditEvents).values({
      id: randomUUID(),
      caseId: current.caseId,
      alertId: caseRecord.alertId,
      eventType: 'investigation_assessment_recorded',
      actorType: prepared.assessorKind === 'HUMAN' ? 'human' : 'agent',
      actorName: prepared.assessorIdentifier,
      summary: challengeRef === null
        ? 'Recorded non-authoritative analysis of investigation evidence and claims.'
        : 'Recorded non-authoritative analysis under a current investigation Challenge.',
      metadataJson: JSON.stringify({
        assessmentRef: prepared.assessmentRef,
        caseId: current.caseId,
        questionRef: prepared.questionRef,
        verdict: prepared.verdict,
        targetClaimRef: prepared.targetClaimRef,
        evidenceRefs: prepared.evidenceRefs,
        relatedClaimRefs: prepared.relatedClaimRefs,
        assessorKind: prepared.assessorKind,
        assessorIdentifier: prepared.assessorIdentifier,
        ruleIdentifier: prepared.ruleIdentifier,
        ruleVersion: prepared.ruleVersion,
        basisCaseVersion: current.caseVersion,
        supersedesAssessmentRef: prepared.supersedesAssessmentRef,
        ...(challengeRef === null
          ? {}
          : { authorizationContext: 'OPEN_CHALLENGE', challengeRef }),
        demo: prepared.demo
      }),
      createdAt
    }).run();

    const inserted = transaction
      .select()
      .from(schema.investigationAssessments)
      .where(eq(schema.investigationAssessments.assessmentRef, prepared.assessmentRef))
      .get();
    if (!inserted) throw new Error('Investigation assessment insert did not persist.');
    return { assessment: hydrateAssessment(inserted), replayed: false };
  }, { behavior: 'immediate' });
}

export function getInvestigationAssessment(
  database: RecallDatabase,
  caseId: string,
  assessmentRef: string
): InvestigationAssessment | null {
  const parsed = getInvestigationAssessmentInputSchema.safeParse({ caseId, assessmentRef });
  if (!parsed.success) {
    throw new InvestigationAssessmentError(
      'INVALID_INPUT',
      'Invalid investigation assessment lookup.'
    );
  }
  const row = database
    .select()
    .from(schema.investigationAssessments)
    .where(and(
      eq(schema.investigationAssessments.caseId, parsed.data.caseId),
      eq(schema.investigationAssessments.assessmentRef, parsed.data.assessmentRef)
    ))
    .get();
  return row ? hydrateAssessment(row) : null;
}

export function listInvestigationAssessments(
  database: RecallDatabase,
  caseId: string,
  questionRef: string
): InvestigationAssessment[] {
  const parsed = listInvestigationAssessmentsInputSchema.safeParse({ caseId, questionRef });
  if (!parsed.success) {
    throw new InvestigationAssessmentError(
      'INVALID_INPUT',
      'Invalid investigation assessment list lookup.'
    );
  }
  return database
    .select()
    .from(schema.investigationAssessments)
    .where(and(
      eq(schema.investigationAssessments.caseId, parsed.data.caseId),
      eq(schema.investigationAssessments.questionRef, parsed.data.questionRef)
    ))
    .orderBy(
      asc(schema.investigationAssessments.createdAt),
      asc(schema.investigationAssessments.assessmentRef)
    )
    .all()
    .map(hydrateAssessment);
}
