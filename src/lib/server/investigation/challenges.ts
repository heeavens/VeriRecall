import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { CaseSnapshot } from '../../contracts/recall';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import {
  getCaseHistory,
  readCaseRevisionByCaseVersion,
  readCaseRevisionById,
  readCaseSnapshot,
  type LifecycleContext
} from '../workflow/case-lifecycle';
import {
  AuthoritativeChallengeBaselineError,
  resolveAuthoritativeChallengeBaselineInTransaction,
  type AuthoritativeChallengeBaseline
} from './authoritative-challenge-baseline';
import {
  AuthoritativeConflictContinuationError,
  resolveAuthoritativeConflictContinuationAnchorInTransaction,
  resolveAuthoritativeConflictContinuationInTransaction,
  type AuthoritativeConflictContinuation
} from './authoritative-conflict-continuation';
import { demoHumanAssessorIdentifier } from './demo-context';
import {
  listInvestigationEvidence,
  type InvestigationEvidence
} from './evidence-registry';
import { getInvestigationQuestion, type InvestigationQuestion } from './questions';

const opaqueReferenceSchema = z.string().min(1).max(500).refine(
  (value) => value.trim().length > 0,
  'References must contain a non-whitespace character.'
);
const rationaleSchema = z.string().min(1).max(10_000).refine(
  (value) => value.trim().length > 0,
  'Rationale must contain a non-whitespace character.'
);
const timestampSchema = z.string().datetime();
const canonicalReferenceArraySchema = z.array(opaqueReferenceSchema).min(1).refine(
  (values) => new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1] < value),
  'Reference arrays must be unique and lexically ordered.'
);

const openInvestigationChallengeInputSchema = z.strictObject({
  challengeRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  expectedCaseVersion: z.number().int().positive(),
  expectedMaterialRevision: z.number().int().positive(),
  triggerEvidenceRefs: z.array(opaqueReferenceSchema).min(1),
  rationale: rationaleSchema,
  demo: z.boolean()
});

const openInvestigationConflictContinuationInputSchema = z.strictObject({
  challengeRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  expectedCaseVersion: z.number().int().positive(),
  expectedMaterialRevision: z.number().int().positive(),
  rationale: z.string().trim().min(1).max(10_000),
  demo: z.literal(true)
});

const investigationChallengeSchema = z.strictObject({
  challengeRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  challengedRevisionId: z.string().uuid(),
  challengedMaterialRevision: z.number().int().positive(),
  openedCaseVersion: z.number().int().positive(),
  triggerEvidenceRefs: canonicalReferenceArraySchema,
  openedByKind: z.literal('HUMAN'),
  openedByIdentifier: opaqueReferenceSchema,
  rationale: rationaleSchema,
  createdAt: timestampSchema,
  demo: z.literal(true)
});

const getChallengeInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  challengeRef: z.string().uuid()
});

const listChallengesInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema
});

const currentChallengeWriteInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  challengeRef: z.string().uuid(),
  expectedCaseVersion: z.number().int().positive(),
  expectedMaterialRevision: z.number().int().positive(),
  demo: z.literal(true)
});

const currentChallengeReadInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  challengeRef: z.string().uuid()
});

export type OpenInvestigationChallengeInput = z.infer<
  typeof openInvestigationChallengeInputSchema
>;
export type OpenInvestigationConflictContinuationInput = z.infer<
  typeof openInvestigationConflictContinuationInputSchema
>;
export type InvestigationChallenge = z.infer<typeof investigationChallengeSchema>;

export type InvestigationChallengeErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'VERSIONED_CASE_REQUIRED'
  | 'QUESTION_NOT_FOUND'
  | 'QUESTION_OWNERSHIP_MISMATCH'
  | 'CHALLENGE_NOT_FOUND'
  | 'CHALLENGE_NOT_CURRENT'
  | 'QUESTION_OPEN'
  | 'QUESTION_NOT_ANSWERED'
  | 'ANSWER_CONTINUITY_UNPROVEN'
  | 'ANSWER_CONTINUITY_AMBIGUOUS'
  | 'CHALLENGE_BASELINE_PROVENANCE_INVALID'
  | 'STALE_CASE_VERSION'
  | 'STALE_MATERIAL_REVISION'
  | 'LATE_EVIDENCE_REQUIRED'
  | 'TRIGGER_EVIDENCE_MISMATCH'
  | 'CHALLENGE_ALREADY_EXISTS'
  | 'CHALLENGE_CONFLICT'
  | 'CONFLICT_CONTINUATION_UNPROVEN'
  | 'CONFLICT_CONTINUATION_AMBIGUOUS'
  | 'CONFLICT_CONTINUATION_PROVENANCE_INVALID';

export class InvestigationChallengeError extends Error {
  constructor(
    public readonly code: InvestigationChallengeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvestigationChallengeError';
  }
}

export type InvestigationChallengeContextReason =
  | 'VERSIONED_CASE_MISSING'
  | 'QUESTION_CONTEXT_INVALID'
  | 'PRODUCT_CHANGED'
  | 'MATERIAL_REVISION_CHANGED'
  | 'ANSWER_CONTEXT_CHANGED';

export interface InvestigationChallengeContext {
  challenge: InvestigationChallenge;
  contextKind: 'CURRENT' | 'HISTORICAL';
  reasonCodes: InvestigationChallengeContextReason[];
  currentCaseVersion: number | null;
  currentMaterialRevision: number | null;
}

type CaseHistoryRevision = ReturnType<typeof getCaseHistory>[number];

interface AnswerRevision {
  id: string;
  caseVersion: number;
  materialRevision: number;
  createdAt: string;
}

export interface CurrentInvestigationChallengeForWrite {
  snapshot: CaseSnapshot;
  question: InvestigationQuestion;
  challenge: InvestigationChallenge;
  challengedRevision: AnswerRevision;
  authoritativeBaseline: AuthoritativeChallengeBaseline;
}

export interface CurrentInvestigationConflictContinuationForWrite {
  snapshot: CaseSnapshot;
  question: InvestigationQuestion;
  challenge: InvestigationChallenge;
  challengedRevision: AnswerRevision;
  authoritativeBaseline: AuthoritativeConflictContinuation;
}

export type CurrentInvestigationContextForWrite =
  | CurrentInvestigationChallengeForWrite
  | CurrentInvestigationConflictContinuationForWrite;

export type CurrentInvestigationChallengeForRead = CurrentInvestigationChallengeForWrite;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalReferences(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameReferences(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseInput(input: OpenInvestigationChallengeInput) {
  const parsed = openInvestigationChallengeInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationChallengeError(
      'INVALID_INPUT',
      'Invalid investigation Challenge request.'
    );
  }
  return {
    ...parsed.data,
    triggerEvidenceRefs: canonicalReferences(parsed.data.triggerEvidenceRefs)
  };
}

function parseConflictContinuationInput(input: OpenInvestigationConflictContinuationInput) {
  const parsed = openInvestigationConflictContinuationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationChallengeError(
      'INVALID_INPUT',
      'Invalid investigation conflict continuation request.'
    );
  }
  return parsed.data;
}

function hydrateChallenge(
  row: typeof schema.investigationChallenges.$inferSelect
): InvestigationChallenge {
  return investigationChallengeSchema.parse({
    challengeRef: row.challengeRef,
    caseId: row.caseId,
    questionRef: row.questionRef,
    challengedRevisionId: row.challengedRevisionId,
    challengedMaterialRevision: row.challengedMaterialRevision,
    openedCaseVersion: row.openedCaseVersion,
    triggerEvidenceRefs: JSON.parse(row.triggerEvidenceRefsJson),
    openedByKind: row.openedByKind,
    openedByIdentifier: row.openedByIdentifier,
    rationale: row.rationale,
    createdAt: row.createdAt,
    demo: row.demo
  });
}

function immutableSemanticsMatch(
  row: typeof schema.investigationChallenges.$inferSelect,
  input: ReturnType<typeof parseInput>
): boolean {
  return row.challengeRef === input.challengeRef &&
    row.caseId === input.caseId &&
    row.questionRef === input.questionRef &&
    row.triggerEvidenceRefsJson === JSON.stringify(input.triggerEvidenceRefs) &&
    row.rationale === input.rationale &&
    row.demo === input.demo;
}

function exactRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function currentQuestionOccurrences(snapshot: CaseSnapshot, questionRef: string) {
  return [
    ...(snapshot.investigation?.gaps.filter((issue) => issue.id === questionRef) ?? []),
    ...(snapshot.investigation?.conflicts.filter((issue) => issue.id === questionRef) ?? [])
  ];
}

function hasKnownBatchAnswer(snapshot: CaseSnapshot): boolean {
  const investigation = snapshot.investigation;
  return snapshot.materialRevision !== null &&
    investigation !== null &&
    investigation.identity.knowledgeStatus === 'KNOWN' &&
    investigation.identity.conclusion === 'MATCH' &&
    investigation.scope.kind === 'BATCH_LOT' &&
    investigation.scope.knowledgeStatus === 'KNOWN' &&
    investigation.scope.lots.length > 0 &&
    investigation.scope.lots.every((lot) => lot.trim().length > 0);
}

function sameAuthoritativeAnswer(left: CaseSnapshot, right: CaseSnapshot): boolean {
  return left.caseId === right.caseId &&
    left.productId === right.productId &&
    left.materialRevision === right.materialRevision &&
    JSON.stringify(left.investigation) === JSON.stringify(right.investigation);
}

function validateQuestionOrigin(
  history: readonly CaseHistoryRevision[],
  question: InvestigationQuestion
): void {
  const origin = history.filter(
    (revision) => revision.caseVersion === question.originCaseVersion
  );
  if (origin.length !== 1 ||
      origin[0].materialRevision !== question.originMaterialRevision ||
      origin[0].createdAt !== question.createdAt) {
    throw new InvestigationChallengeError(
      'ANSWER_CONTINUITY_UNPROVEN',
      'Authoritative history does not reproduce the registered Question origin.'
    );
  }
  const originGaps = origin[0].snapshot.investigation?.gaps.filter(
    (issue) => issue.id === question.questionRef
  ) ?? [];
  const originConflicts = origin[0].snapshot.investigation?.conflicts.filter(
    (issue) => issue.id === question.questionRef
  ) ?? [];
  if (originGaps.length !== 1 ||
      originConflicts.length !== 0 ||
      originGaps[0].code !== 'BATCH_MISSING' ||
      !exactRefs(originGaps[0].subjectRefs, [question.subjectRef])) {
    throw new InvestigationChallengeError(
      originGaps.length + originConflicts.length > 1
        ? 'ANSWER_CONTINUITY_AMBIGUOUS'
        : 'ANSWER_CONTINUITY_UNPROVEN',
      'The registered Question origin is not an exact authoritative BATCH_MISSING issue.'
    );
  }
}

function validateMaterialStateConsistency(
  revisions: readonly CaseHistoryRevision[],
  reference: CaseSnapshot
): void {
  if (revisions.some((revision) => !sameAuthoritativeAnswer(revision.snapshot, reference))) {
    throw new InvestigationChallengeError(
      'ANSWER_CONTINUITY_AMBIGUOUS',
      'One material revision contains inconsistent authoritative investigation state.'
    );
  }
}

function resolveAnsweredQuestionRevision(
  database: RecallDatabase,
  question: InvestigationQuestion,
  current: CaseSnapshot
): AnswerRevision {
  if (question.questionType !== 'AFFECTED_BATCH_LOT' ||
      current.caseId !== question.caseId ||
      current.productId !== question.subjectRef ||
      current.demo !== question.demo) {
    throw new InvestigationChallengeError(
      'QUESTION_OWNERSHIP_MISMATCH',
      'The registered Question does not belong to the current case product and demo context.'
    );
  }

  const currentOccurrences = currentQuestionOccurrences(current, question.questionRef);
  if (currentOccurrences.length > 1) {
    throw new InvestigationChallengeError(
      'ANSWER_CONTINUITY_AMBIGUOUS',
      'The current investigation reuses the Question identity ambiguously.'
    );
  }
  if (currentOccurrences.length === 1 &&
      currentOccurrences[0].code === 'BATCH_MISSING' &&
      current.investigation?.gaps.some((issue) => issue.id === question.questionRef)) {
    throw new InvestigationChallengeError(
      'QUESTION_OPEN',
      'A current BATCH_MISSING gap does not require a resolved-question Challenge.'
    );
  }
  if (currentOccurrences.length !== 0) {
    throw new InvestigationChallengeError(
      'QUESTION_NOT_ANSWERED',
      'The Question is still represented as current uncertainty or conflict.'
    );
  }
  const otherCurrentBatchQuestions = [
    ...(current.investigation?.gaps ?? []),
    ...(current.investigation?.conflicts ?? [])
  ].filter((issue) =>
    issue.id !== question.questionRef &&
    (issue.code === 'BATCH_MISSING' || issue.code === 'BATCH_CONFLICT') &&
    exactRefs(issue.subjectRefs, [question.subjectRef])
  );
  if (otherCurrentBatchQuestions.length > 0) {
    throw new InvestigationChallengeError(
      'ANSWER_CONTINUITY_AMBIGUOUS',
      'Another current batch Question prevents attribution of the answer to this lineage.'
    );
  }
  if (!hasKnownBatchAnswer(current)) {
    throw new InvestigationChallengeError(
      'QUESTION_NOT_ANSWERED',
      'The current InvestigationOutcome does not contain a known MATCH batch answer.'
    );
  }

  const currentMaterialRevision = current.materialRevision!;
  const history = getCaseHistory(database, current.caseId);
  validateQuestionOrigin(history, question);
  const currentRows = history.filter(
    (revision) => revision.materialRevision === currentMaterialRevision
  );
  if (currentRows.length === 0) {
    const attemptedPositiveAnchor = database.select({
      applicationRef: schema.investigationChallengeBatchApplications.applicationRef
    }).from(schema.investigationChallengeBatchApplications).where(and(
      eq(schema.investigationChallengeBatchApplications.caseId, current.caseId),
      eq(schema.investigationChallengeBatchApplications.questionRef, question.questionRef),
      eq(
        schema.investigationChallengeBatchApplications.resultingMaterialRevision,
        currentMaterialRevision
      )
    )).get();
    throw new InvestigationChallengeError(
      attemptedPositiveAnchor
        ? 'CHALLENGE_BASELINE_PROVENANCE_INVALID'
        : 'ANSWER_CONTINUITY_UNPROVEN',
      'Authoritative history does not contain the current material revision.'
    );
  }
  validateMaterialStateConsistency(currentRows, current);
  if (!currentRows.some((revision) => revision.caseVersion === current.caseVersion)) {
    throw new InvestigationChallengeError(
      'ANSWER_CONTINUITY_UNPROVEN',
      'The current authoritative case version is missing from revision history.'
    );
  }
  const answer = currentRows[0];

  const rawAnswerRows = database
    .select({ id: schema.caseRevisions.id })
    .from(schema.caseRevisions)
    .where(and(
      eq(schema.caseRevisions.caseId, current.caseId),
      eq(schema.caseRevisions.caseVersion, answer.caseVersion)
    ))
    .all();
  if (rawAnswerRows.length !== 1) {
    throw new InvestigationChallengeError(
      'ANSWER_CONTINUITY_AMBIGUOUS',
      'The authoritative answer revision identity cannot be resolved uniquely.'
    );
  }
  return {
    id: rawAnswerRows[0].id,
    caseVersion: answer.caseVersion,
    materialRevision: currentMaterialRevision,
    createdAt: answer.createdAt
  };
}

function completeLateEvidence(
  evidence: readonly InvestigationEvidence[],
  question: InvestigationQuestion,
  challengedAt: string
): InvestigationEvidence[] {
  const challengedTime = Date.parse(challengedAt);
  if (!Number.isFinite(challengedTime)) {
    throw new InvestigationChallengeError(
      'ANSWER_CONTINUITY_UNPROVEN',
      'The authoritative answer revision has no valid receipt-time boundary.'
    );
  }
  if (evidence.some((item) =>
    item.caseId !== question.caseId ||
    item.questionRef !== question.questionRef ||
    item.demo !== question.demo
  )) {
    throw new InvestigationChallengeError(
      'TRIGGER_EVIDENCE_MISMATCH',
      'The registered Evidence corpus has inconsistent Question ownership.'
    );
  }
  return evidence.filter((item) => Date.parse(item.receivedAt) > challengedTime);
}

interface DerivedChallengeContext {
  context: InvestigationChallengeContext;
  snapshot: CaseSnapshot | null;
  question: InvestigationQuestion | null;
  challengedRevision: AnswerRevision | null;
  authoritativeBaseline: AuthoritativeChallengeBaseline | null;
}

function deriveChallengeContext(
  database: RecallDatabase,
  challenge: InvestigationChallenge
): DerivedChallengeContext {
  const reasons = new Set<InvestigationChallengeContextReason>();
  const current = readCaseSnapshot(database, challenge.caseId);
  if (!current) {
    reasons.add('VERSIONED_CASE_MISSING');
    return {
      context: {
        challenge,
        contextKind: 'HISTORICAL',
        reasonCodes: sortContextReasons(reasons),
        currentCaseVersion: null,
        currentMaterialRevision: null
      },
      snapshot: null,
      question: null,
      challengedRevision: null,
      authoritativeBaseline: null
    };
  }

  const question = getInvestigationQuestion(
    database,
    challenge.caseId,
    challenge.questionRef
  );
  if (!question) {
    reasons.add('QUESTION_CONTEXT_INVALID');
  } else if (question.subjectRef !== current.productId || question.demo !== current.demo) {
    reasons.add('PRODUCT_CHANGED');
  }
  if (current.materialRevision !== challenge.challengedMaterialRevision) {
    reasons.add('MATERIAL_REVISION_CHANGED');
  }

  let challengedRevision: AnswerRevision | null = null;
  let authoritativeBaseline: AuthoritativeChallengeBaseline | null = null;
  if (question && reasons.size === 0) {
    try {
      const resolved = resolveAnsweredQuestionRevision(database, question, current);
      if (resolved.id !== challenge.challengedRevisionId) {
        reasons.add('ANSWER_CONTEXT_CHANGED');
      } else {
        challengedRevision = resolved;
        authoritativeBaseline = resolveAuthoritativeChallengeBaselineInTransaction(database, {
          caseId: challenge.caseId,
          questionRef: challenge.questionRef,
          challengeRef: challenge.challengeRef,
          challengedRevisionId: challenge.challengedRevisionId,
          challengedMaterialRevision: challenge.challengedMaterialRevision,
          openedCaseVersion: challenge.openedCaseVersion,
          currentCaseVersion: current.caseVersion
        });
      }
    } catch (error) {
      if (error instanceof AuthoritativeChallengeBaselineError) {
        throw new InvestigationChallengeError(
          error.code === 'CHALLENGE_BASELINE_PROVENANCE_INVALID'
            ? 'CHALLENGE_BASELINE_PROVENANCE_INVALID'
            : error.code === 'CHALLENGE_BASELINE_AMBIGUOUS'
              ? 'ANSWER_CONTINUITY_AMBIGUOUS'
              : 'ANSWER_CONTINUITY_UNPROVEN',
          error.message
        );
      }
      reasons.add('ANSWER_CONTEXT_CHANGED');
    }
  }

  return {
    context: {
      challenge,
      contextKind: reasons.size === 0 ? 'CURRENT' : 'HISTORICAL',
      reasonCodes: sortContextReasons(reasons),
      currentCaseVersion: current.caseVersion,
      currentMaterialRevision: current.materialRevision
    },
    snapshot: current,
    question,
    challengedRevision,
    authoritativeBaseline
  };
}

/**
 * Transaction-compatible current Challenge resolution for read models.
 * The caller owns the surrounding read transaction and observes the versions returned here.
 */
export function resolveCurrentInvestigationChallengeForRead(
  database: RecallDatabase,
  input: {
    caseId: string;
    questionRef: string;
    challengeRef: string;
  }
): CurrentInvestigationChallengeForRead {
  const parsed = currentChallengeReadInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationChallengeError(
      'INVALID_INPUT',
      'Invalid current Challenge read input.'
    );
  }
  const challenge = getInvestigationChallenge(
    database,
    parsed.data.caseId,
    parsed.data.challengeRef
  );
  if (!challenge) {
    throw new InvestigationChallengeError(
      'CHALLENGE_NOT_FOUND',
      'The selected investigation Challenge does not exist for this case.'
    );
  }
  if (challenge.questionRef !== parsed.data.questionRef) {
    throw new InvestigationChallengeError(
      'QUESTION_OWNERSHIP_MISMATCH',
      'The selected Challenge belongs to a different investigation Question.'
    );
  }

  const derived = deriveChallengeContext(database, challenge);
  if (!derived.snapshot) {
    throw new InvestigationChallengeError(
      'VERSIONED_CASE_REQUIRED',
      'The owning case does not have a versioned investigation lifecycle.'
    );
  }
  if (
    !derived.question ||
    derived.question.questionType !== 'AFFECTED_BATCH_LOT' ||
    derived.question.caseId !== challenge.caseId ||
    derived.question.subjectRef !== derived.snapshot.productId ||
    derived.question.demo !== challenge.demo ||
    derived.snapshot.demo !== challenge.demo
  ) {
    throw new InvestigationChallengeError(
      'QUESTION_OWNERSHIP_MISMATCH',
      'The selected Challenge does not match the permanent Question or current product.'
    );
  }
  if (
    derived.context.contextKind !== 'CURRENT' ||
    !derived.challengedRevision ||
    !derived.authoritativeBaseline
  ) {
    throw new InvestigationChallengeError(
      'CHALLENGE_NOT_CURRENT',
      'The selected Challenge is no longer current for the authoritative material answer.'
    );
  }
  return {
    snapshot: derived.snapshot,
    question: derived.question,
    challenge,
    challengedRevision: derived.challengedRevision,
    authoritativeBaseline: derived.authoritativeBaseline
  };
}

/**
 * Transaction-compatible authorization for non-authoritative writes under a current Challenge.
 * The caller supplies the surrounding immediate transaction.
 */
export function resolveCurrentInvestigationChallengeForWrite(
  database: RecallDatabase,
  input: {
    caseId: string;
    questionRef: string;
    challengeRef: string;
    expectedCaseVersion: number;
    expectedMaterialRevision: number;
    demo: true;
  }
): CurrentInvestigationChallengeForWrite {
  const parsed = currentChallengeWriteInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationChallengeError(
      'INVALID_INPUT',
      'Invalid current Challenge authorization input.'
    );
  }
  const challenge = getInvestigationChallenge(
    database,
    parsed.data.caseId,
    parsed.data.challengeRef
  );
  if (!challenge) {
    throw new InvestigationChallengeError(
      'CHALLENGE_NOT_FOUND',
      'The selected investigation Challenge does not exist for this case.'
    );
  }
  if (challenge.questionRef !== parsed.data.questionRef) {
    throw new InvestigationChallengeError(
      'QUESTION_OWNERSHIP_MISMATCH',
      'The selected Challenge belongs to a different investigation Question.'
    );
  }

  const derived = deriveChallengeContext(database, challenge);
  if (!derived.snapshot) {
    throw new InvestigationChallengeError(
      'VERSIONED_CASE_REQUIRED',
      'The owning case does not have a versioned investigation lifecycle.'
    );
  }
  if (derived.snapshot.caseVersion !== parsed.data.expectedCaseVersion) {
    throw new InvestigationChallengeError(
      'STALE_CASE_VERSION',
      'Refresh the case before writing under its current Challenge.'
    );
  }
  if (derived.snapshot.materialRevision !== parsed.data.expectedMaterialRevision) {
    throw new InvestigationChallengeError(
      'STALE_MATERIAL_REVISION',
      'Refresh the authoritative material answer before writing under its Challenge.'
    );
  }
  if (!parsed.data.demo || !challenge.demo || !derived.snapshot.demo || !derived.question?.demo) {
    throw new InvestigationChallengeError(
      'FORBIDDEN',
      'Challenge-scoped investigation writes require explicit matching demo provenance.'
    );
  }
  if (
    derived.context.contextKind !== 'CURRENT' ||
    !derived.question ||
    !derived.challengedRevision ||
    !derived.authoritativeBaseline
  ) {
    throw new InvestigationChallengeError(
      'CHALLENGE_NOT_CURRENT',
      'The selected Challenge is no longer current for the authoritative material answer.'
    );
  }
  return {
    snapshot: derived.snapshot,
    question: derived.question,
    challenge,
    challengedRevision: derived.challengedRevision,
    authoritativeBaseline: derived.authoritativeBaseline
  };
}

function mapConflictContinuationError(
  error: AuthoritativeConflictContinuationError
): InvestigationChallengeError {
  return new InvestigationChallengeError(error.code, error.message);
}

/**
 * Transaction-compatible authorization for the distinct investigation partition that follows
 * an authoritative HUMAN-applied Challenge conflict.
 */
export function resolveCurrentInvestigationConflictContinuationForWrite(
  database: RecallDatabase,
  input: {
    caseId: string;
    questionRef: string;
    challengeRef: string;
    expectedCaseVersion: number;
    expectedMaterialRevision: number;
    demo: true;
  }
): CurrentInvestigationConflictContinuationForWrite {
  const parsed = currentChallengeWriteInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationChallengeError(
      'INVALID_INPUT',
      'Invalid current conflict continuation authorization input.'
    );
  }
  const challenge = getInvestigationChallenge(
    database,
    parsed.data.caseId,
    parsed.data.challengeRef
  );
  if (!challenge) {
    throw new InvestigationChallengeError(
      'CHALLENGE_NOT_FOUND',
      'The selected conflict continuation Challenge does not exist.'
    );
  }
  const question = getInvestigationQuestion(database, parsed.data.caseId, parsed.data.questionRef);
  const snapshot = readCaseSnapshot(database, parsed.data.caseId);
  if (!snapshot) {
    throw new InvestigationChallengeError(
      'VERSIONED_CASE_REQUIRED',
      'The owning case does not have a versioned investigation lifecycle.'
    );
  }
  if (snapshot.caseVersion !== parsed.data.expectedCaseVersion) {
    throw new InvestigationChallengeError(
      'STALE_CASE_VERSION',
      'Refresh the case before writing under its conflict continuation.'
    );
  }
  if (snapshot.materialRevision !== parsed.data.expectedMaterialRevision) {
    throw new InvestigationChallengeError(
      'STALE_MATERIAL_REVISION',
      'Refresh the authoritative conflict before writing under its continuation.'
    );
  }
  if (
    !question || challenge.questionRef !== parsed.data.questionRef ||
    question.subjectRef !== snapshot.productId || question.caseId !== parsed.data.caseId
  ) {
    throw new InvestigationChallengeError(
      'QUESTION_OWNERSHIP_MISMATCH',
      'The continuation Challenge does not match the permanent Question or product.'
    );
  }
  if (!parsed.data.demo || !challenge.demo || !question.demo || !snapshot.demo) {
    throw new InvestigationChallengeError(
      'FORBIDDEN',
      'Conflict-continuation writes require explicit matching demo provenance.'
    );
  }
  let authoritativeBaseline: AuthoritativeConflictContinuation;
  try {
    authoritativeBaseline = resolveAuthoritativeConflictContinuationInTransaction(database, {
      caseId: parsed.data.caseId,
      questionRef: parsed.data.questionRef,
      continuationChallengeRef: parsed.data.challengeRef,
      currentCaseVersion: snapshot.caseVersion
    });
  } catch (error) {
    if (error instanceof AuthoritativeConflictContinuationError) {
      throw mapConflictContinuationError(error);
    }
    throw error;
  }
  const resultRevision = readCaseRevisionById(
    database,
    parsed.data.caseId,
    authoritativeBaseline.resultingRevisionId
  );
  const currentRevision = readCaseRevisionByCaseVersion(
    database,
    parsed.data.caseId,
    snapshot.caseVersion
  );
  if (
    !resultRevision || !currentRevision ||
    JSON.stringify(currentRevision.snapshot) !== JSON.stringify(snapshot)
  ) {
    throw new InvestigationChallengeError(
      'CONFLICT_CONTINUATION_PROVENANCE_INVALID',
      'The continuation conflict result or current revision is missing or divergent.'
    );
  }
  return {
    snapshot,
    question,
    challenge,
    challengedRevision: {
      id: resultRevision.revisionId,
      caseVersion: resultRevision.caseVersion,
      materialRevision: resultRevision.materialRevision!,
      createdAt: resultRevision.createdAt
    },
    authoritativeBaseline
  };
}

/** Selects the exact current investigation partition without falling back after conflict evidence. */
export function resolveCurrentInvestigationContextForWrite(
  database: RecallDatabase,
  input: {
    caseId: string;
    questionRef: string;
    challengeRef: string;
    expectedCaseVersion: number;
    expectedMaterialRevision: number;
    demo: true;
  }
): CurrentInvestigationContextForWrite {
  const challenge = getInvestigationChallenge(database, input.caseId, input.challengeRef);
  if (challenge) {
    const snapshot = readCaseSnapshot(database, input.caseId);
    const isCurrentConflictPartition = snapshot?.materialRevision ===
        challenge.challengedMaterialRevision &&
      snapshot.investigation?.knowledgeStatus === 'CONFLICTED' &&
      snapshot.investigation.scope.kind === 'UNRESOLVED' &&
      snapshot.investigation.scope.knowledgeStatus === 'CONFLICTED';
    const attemptedConflictAnchors = database.select({
      applicationRef: schema.investigationChallengeConflictApplications.applicationRef
    }).from(schema.investigationChallengeConflictApplications).where(and(
      eq(schema.investigationChallengeConflictApplications.caseId, input.caseId),
      eq(schema.investigationChallengeConflictApplications.questionRef, input.questionRef),
      eq(
        schema.investigationChallengeConflictApplications.resultingMaterialRevision,
        challenge.challengedMaterialRevision
      )
    )).all();
    if (isCurrentConflictPartition || attemptedConflictAnchors.length > 0) {
      return resolveCurrentInvestigationConflictContinuationForWrite(database, input);
    }
  }
  return resolveCurrentInvestigationChallengeForWrite(database, input);
}

export function openInvestigationConflictContinuation(
  database: RecallDatabase,
  input: OpenInvestigationConflictContinuationInput,
  context: LifecycleContext,
  now = new Date()
): { challenge: InvestigationChallenge; replayed: boolean } {
  if (context.mode !== 'demo') {
    throw new InvestigationChallengeError(
      'FORBIDDEN',
      'Opening an investigation conflict continuation requires explicit local demo mode.'
    );
  }
  const parsed = parseConflictContinuationInput(input);
  return database.transaction((transaction) => {
    const existing = transaction.select().from(schema.investigationChallenges)
      .where(eq(schema.investigationChallenges.challengeRef, parsed.challengeRef)).get();
    if (existing) {
      const challenge = hydrateChallenge(existing);
      if (
        challenge.caseId !== parsed.caseId || challenge.questionRef !== parsed.questionRef ||
        challenge.rationale !== parsed.rationale || challenge.demo !== parsed.demo
      ) {
        throw new InvestigationChallengeError(
          'CHALLENGE_CONFLICT',
          'This Challenge reference already identifies different immutable semantics.'
        );
      }
      try {
        resolveAuthoritativeConflictContinuationInTransaction(transaction, {
          caseId: challenge.caseId,
          questionRef: challenge.questionRef,
          continuationChallengeRef: challenge.challengeRef,
          currentCaseVersion: challenge.openedCaseVersion
        });
      } catch (error) {
        if (error instanceof AuthoritativeConflictContinuationError) {
          throw mapConflictContinuationError(error);
        }
        throw error;
      }
      return { challenge, replayed: true };
    }

    const current = readCaseSnapshot(transaction, parsed.caseId);
    const question = getInvestigationQuestion(transaction, parsed.caseId, parsed.questionRef);
    if (!current) {
      throw new InvestigationChallengeError(
        'VERSIONED_CASE_REQUIRED',
        'The owning case does not have a versioned investigation lifecycle.'
      );
    }
    if (current.caseVersion !== parsed.expectedCaseVersion) {
      throw new InvestigationChallengeError(
        'STALE_CASE_VERSION',
        'Refresh the case before opening its conflict continuation.'
      );
    }
    if (
      current.materialRevision === null ||
      current.materialRevision !== parsed.expectedMaterialRevision
    ) {
      throw new InvestigationChallengeError(
        'STALE_MATERIAL_REVISION',
        'Refresh the authoritative conflict before opening its continuation.'
      );
    }
    if (
      !question || question.questionType !== 'AFFECTED_BATCH_LOT' ||
      question.subjectRef !== current.productId || !question.demo || !current.demo
    ) {
      throw new InvestigationChallengeError(
        question ? 'QUESTION_OWNERSHIP_MISMATCH' : 'QUESTION_NOT_FOUND',
        'A matching permanent demo Question is required for conflict continuation.'
      );
    }

    let baseline: AuthoritativeConflictContinuation;
    try {
      baseline = resolveAuthoritativeConflictContinuationAnchorInTransaction(transaction, {
        caseId: parsed.caseId,
        questionRef: parsed.questionRef,
        continuationChallengeRef: parsed.challengeRef,
        currentCaseVersion: current.caseVersion,
        currentMaterialRevision: current.materialRevision!
      });
    } catch (error) {
      if (error instanceof AuthoritativeConflictContinuationError) {
        throw mapConflictContinuationError(error);
      }
      throw error;
    }
    const sameCycle = transaction.select({ challengeRef: schema.investigationChallenges.challengeRef })
      .from(schema.investigationChallenges).where(and(
        eq(schema.investigationChallenges.caseId, parsed.caseId),
        eq(schema.investigationChallenges.questionRef, parsed.questionRef),
        eq(
          schema.investigationChallenges.challengedMaterialRevision,
          baseline.resultingMaterialRevision
        )
      )).get();
    if (sameCycle) {
      throw new InvestigationChallengeError(
        'CHALLENGE_ALREADY_EXISTS',
        'This authoritative conflict already has a continuation Challenge.'
      );
    }
    const caseRecord = transaction.select({ alertId: schema.cases.alertId }).from(schema.cases)
      .where(eq(schema.cases.id, parsed.caseId)).get();
    if (!caseRecord) {
      throw new InvestigationChallengeError(
        'VERSIONED_CASE_REQUIRED',
        'The versioned lifecycle has no owning case record.'
      );
    }
    const triggerEvidenceRefs = canonicalReferences(baseline.conflictEvidenceRefs);
    const createdAt = now.toISOString();
    transaction.insert(schema.investigationChallenges).values({
      challengeRef: parsed.challengeRef,
      caseId: parsed.caseId,
      questionRef: parsed.questionRef,
      challengedRevisionId: baseline.resultingRevisionId,
      challengedMaterialRevision: baseline.resultingMaterialRevision,
      openedCaseVersion: current.caseVersion,
      triggerEvidenceRefsJson: JSON.stringify(triggerEvidenceRefs),
      openedByKind: 'HUMAN',
      openedByIdentifier: demoHumanAssessorIdentifier,
      rationale: parsed.rationale,
      createdAt,
      demo: true
    }).run();
    transaction.insert(schema.auditEvents).values({
      id: randomUUID(),
      caseId: parsed.caseId,
      alertId: caseRecord.alertId,
      eventType: 'investigation_conflict_continuation_opened',
      actorType: 'human',
      actorName: demoHumanAssessorIdentifier,
      summary: 'Opened a distinct investigation continuation for an authoritative applied conflict.',
      metadataJson: JSON.stringify({
        challengeRef: parsed.challengeRef,
        questionRef: parsed.questionRef,
        conflictApplicationRef: baseline.conflictApplicationRef,
        sourceChallengeRef: baseline.sourceChallengeRef,
        challengedRevisionId: baseline.resultingRevisionId,
        challengedMaterialRevision: baseline.resultingMaterialRevision,
        openedCaseVersion: current.caseVersion,
        triggerEvidenceRefs,
        demo: true
      }),
      createdAt
    }).run();
    const inserted = transaction.select().from(schema.investigationChallenges)
      .where(eq(schema.investigationChallenges.challengeRef, parsed.challengeRef)).get();
    if (!inserted) throw new Error('Conflict continuation Challenge insert did not persist.');
    return { challenge: hydrateChallenge(inserted), replayed: false };
  }, { behavior: 'immediate' });
}

export function openInvestigationChallenge(
  database: RecallDatabase,
  input: OpenInvestigationChallengeInput,
  context: LifecycleContext,
  now = new Date()
): { challenge: InvestigationChallenge; replayed: boolean } {
  if (context.mode !== 'demo') {
    throw new InvestigationChallengeError(
      'FORBIDDEN',
      'Opening an investigation Challenge requires explicit local demo mode.'
    );
  }
  const parsed = parseInput(input);

  return database.transaction((transaction) => {
    const existing = transaction
      .select()
      .from(schema.investigationChallenges)
      .where(eq(schema.investigationChallenges.challengeRef, parsed.challengeRef))
      .get();
    if (existing) {
      if (!immutableSemanticsMatch(existing, parsed)) {
        throw new InvestigationChallengeError(
          'CHALLENGE_CONFLICT',
          'This Challenge reference already identifies different immutable semantics.'
        );
      }
      return { challenge: hydrateChallenge(existing), replayed: true };
    }

    const question = getInvestigationQuestion(
      transaction,
      parsed.caseId,
      parsed.questionRef
    );
    if (!question) {
      throw new InvestigationChallengeError(
        'QUESTION_NOT_FOUND',
        'A registered investigation Question is required.'
      );
    }
    const current = readCaseSnapshot(transaction, parsed.caseId);
    if (!current) {
      throw new InvestigationChallengeError(
        'VERSIONED_CASE_REQUIRED',
        'The owning case does not have a versioned investigation lifecycle.'
      );
    }
    if (current.caseVersion !== parsed.expectedCaseVersion) {
      throw new InvestigationChallengeError(
        'STALE_CASE_VERSION',
        'Refresh the case before opening its re-review cycle.'
      );
    }
    if (current.materialRevision !== parsed.expectedMaterialRevision) {
      throw new InvestigationChallengeError(
        'STALE_MATERIAL_REVISION',
        'Refresh the authoritative material answer before opening its re-review cycle.'
      );
    }
    if (!current.demo || !question.demo || !parsed.demo) {
      throw new InvestigationChallengeError(
        'FORBIDDEN',
        'Commit 11 supports only explicit demo Question Challenges.'
      );
    }

    const challengedRevision = resolveAnsweredQuestionRevision(transaction, question, current);
    const sameCycle = transaction
      .select({ challengeRef: schema.investigationChallenges.challengeRef })
      .from(schema.investigationChallenges)
      .where(and(
        eq(schema.investigationChallenges.caseId, parsed.caseId),
        eq(schema.investigationChallenges.questionRef, parsed.questionRef),
        eq(
          schema.investigationChallenges.challengedMaterialRevision,
          challengedRevision.materialRevision
        )
      ))
      .get();
    if (sameCycle) {
      throw new InvestigationChallengeError(
        'CHALLENGE_ALREADY_EXISTS',
        'This authoritative Question answer already has a re-review Challenge.'
      );
    }
    try {
      resolveAuthoritativeChallengeBaselineInTransaction(transaction, {
        caseId: parsed.caseId,
        questionRef: parsed.questionRef,
        challengeRef: parsed.challengeRef,
        challengedRevisionId: challengedRevision.id,
        challengedMaterialRevision: challengedRevision.materialRevision,
        openedCaseVersion: current.caseVersion,
        currentCaseVersion: current.caseVersion
      });
    } catch (error) {
      if (error instanceof AuthoritativeChallengeBaselineError) {
        throw new InvestigationChallengeError(
          error.code === 'CHALLENGE_BASELINE_PROVENANCE_INVALID'
            ? 'CHALLENGE_BASELINE_PROVENANCE_INVALID'
            : error.code === 'CHALLENGE_BASELINE_AMBIGUOUS'
              ? 'ANSWER_CONTINUITY_AMBIGUOUS'
              : 'ANSWER_CONTINUITY_UNPROVEN',
          error.message
        );
      }
      throw error;
    }

    const evidence = listInvestigationEvidence(transaction, parsed.caseId, parsed.questionRef);
    const lateEvidence = completeLateEvidence(evidence, question, challengedRevision.createdAt);
    if (lateEvidence.length === 0) {
      throw new InvestigationChallengeError(
        'LATE_EVIDENCE_REQUIRED',
        'At least one registered Evidence item received after the answer is required.'
      );
    }
    const completeTriggerRefs = canonicalReferences(
      lateEvidence.map((item) => item.evidenceRef)
    );
    if (!sameReferences(parsed.triggerEvidenceRefs, completeTriggerRefs)) {
      throw new InvestigationChallengeError(
        'TRIGGER_EVIDENCE_MISMATCH',
        'Trigger Evidence must equal the complete late-Evidence corpus.'
      );
    }

    const caseRecord = transaction
      .select({ alertId: schema.cases.alertId })
      .from(schema.cases)
      .where(eq(schema.cases.id, parsed.caseId))
      .get();
    if (!caseRecord) {
      throw new InvestigationChallengeError(
        'VERSIONED_CASE_REQUIRED',
        'The versioned lifecycle has no owning case record.'
      );
    }

    const createdAt = now.toISOString();
    transaction.insert(schema.investigationChallenges).values({
      challengeRef: parsed.challengeRef,
      caseId: parsed.caseId,
      questionRef: parsed.questionRef,
      challengedRevisionId: challengedRevision.id,
      challengedMaterialRevision: challengedRevision.materialRevision,
      openedCaseVersion: current.caseVersion,
      triggerEvidenceRefsJson: JSON.stringify(completeTriggerRefs),
      openedByKind: 'HUMAN',
      openedByIdentifier: demoHumanAssessorIdentifier,
      rationale: parsed.rationale,
      createdAt,
      demo: true
    }).run();
    transaction.insert(schema.auditEvents).values({
      id: randomUUID(),
      caseId: parsed.caseId,
      alertId: caseRecord.alertId,
      eventType: 'investigation_challenge_opened',
      actorType: 'human',
      actorName: demoHumanAssessorIdentifier,
      summary: 'Authorized evidence-based re-review of an answered demo investigation Question.',
      metadataJson: JSON.stringify({
        challengeRef: parsed.challengeRef,
        caseId: parsed.caseId,
        questionRef: parsed.questionRef,
        challengedRevisionId: challengedRevision.id,
        challengedMaterialRevision: challengedRevision.materialRevision,
        openedCaseVersion: current.caseVersion,
        triggerEvidenceRefs: completeTriggerRefs,
        openedByKind: 'HUMAN',
        openedByIdentifier: demoHumanAssessorIdentifier,
        rationale: parsed.rationale,
        demo: true
      }),
      createdAt
    }).run();

    const inserted = transaction
      .select()
      .from(schema.investigationChallenges)
      .where(eq(schema.investigationChallenges.challengeRef, parsed.challengeRef))
      .get();
    if (!inserted) throw new Error('Investigation Challenge insert did not persist.');
    return { challenge: hydrateChallenge(inserted), replayed: false };
  }, { behavior: 'immediate' });
}

export function getInvestigationChallenge(
  database: RecallDatabase,
  caseId: string,
  challengeRef: string
): InvestigationChallenge | null {
  const parsed = getChallengeInputSchema.safeParse({ caseId, challengeRef });
  if (!parsed.success) {
    throw new InvestigationChallengeError('INVALID_INPUT', 'Invalid Challenge lookup.');
  }
  const row = database
    .select()
    .from(schema.investigationChallenges)
    .where(and(
      eq(schema.investigationChallenges.caseId, parsed.data.caseId),
      eq(schema.investigationChallenges.challengeRef, parsed.data.challengeRef)
    ))
    .get();
  return row ? hydrateChallenge(row) : null;
}

export function listInvestigationChallenges(
  database: RecallDatabase,
  caseId: string,
  questionRef: string
): InvestigationChallenge[] {
  const parsed = listChallengesInputSchema.safeParse({ caseId, questionRef });
  if (!parsed.success) {
    throw new InvestigationChallengeError('INVALID_INPUT', 'Invalid Challenge list lookup.');
  }
  return database
    .select()
    .from(schema.investigationChallenges)
    .where(and(
      eq(schema.investigationChallenges.caseId, parsed.data.caseId),
      eq(schema.investigationChallenges.questionRef, parsed.data.questionRef)
    ))
    .orderBy(
      asc(schema.investigationChallenges.createdAt),
      asc(schema.investigationChallenges.challengeRef)
    )
    .all()
    .map(hydrateChallenge);
}

function sortContextReasons(
  reasons: Iterable<InvestigationChallengeContextReason>
): InvestigationChallengeContextReason[] {
  const order: InvestigationChallengeContextReason[] = [
    'VERSIONED_CASE_MISSING',
    'QUESTION_CONTEXT_INVALID',
    'PRODUCT_CHANGED',
    'MATERIAL_REVISION_CHANGED',
    'ANSWER_CONTEXT_CHANGED'
  ];
  return [...new Set(reasons)].sort((left, right) => order.indexOf(left) - order.indexOf(right));
}

export function readInvestigationChallengeContext(
  database: RecallDatabase,
  caseId: string,
  challengeRef: string
): InvestigationChallengeContext | null {
  const parsed = getChallengeInputSchema.safeParse({ caseId, challengeRef });
  if (!parsed.success) {
    throw new InvestigationChallengeError('INVALID_INPUT', 'Invalid Challenge context lookup.');
  }
  return database.transaction((transaction) => {
    const challenge = getInvestigationChallenge(
      transaction,
      parsed.data.caseId,
      parsed.data.challengeRef
    );
    if (!challenge) return null;
    return deriveChallengeContext(transaction, challenge).context;
  });
}
