import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { CaseSnapshot } from '../../contracts/recall';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import {
  getCaseHistory,
  readCaseSnapshot,
  type LifecycleContext
} from '../workflow/case-lifecycle';
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

export type OpenInvestigationChallengeInput = z.infer<
  typeof openInvestigationChallengeInputSchema
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
  | 'STALE_CASE_VERSION'
  | 'STALE_MATERIAL_REVISION'
  | 'LATE_EVIDENCE_REQUIRED'
  | 'TRIGGER_EVIDENCE_MISMATCH'
  | 'CHALLENGE_ALREADY_EXISTS'
  | 'CHALLENGE_CONFLICT';

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
}

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
    throw new InvestigationChallengeError(
      'ANSWER_CONTINUITY_UNPROVEN',
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

  const priorRows = history.filter(
    (revision) => revision.caseVersion < answer.caseVersion &&
      revision.materialRevision !== null &&
      revision.materialRevision !== currentMaterialRevision
  );
  const predecessor = priorRows.at(-1);
  if (!predecessor || predecessor.materialRevision === null) {
    throw new InvestigationChallengeError(
      'ANSWER_CONTINUITY_UNPROVEN',
      'The known batch answer has no preceding authoritative material Question state.'
    );
  }
  const predecessorRows = priorRows.filter(
    (revision) => revision.materialRevision === predecessor.materialRevision
  );
  validateMaterialStateConsistency(predecessorRows, predecessor.snapshot);

  const candidateQuestions = predecessor.snapshot.investigation?.gaps.filter((issue) =>
    issue.code === 'BATCH_MISSING' && exactRefs(issue.subjectRefs, [question.subjectRef])
  ) ?? [];
  if (candidateQuestions.length !== 1) {
    throw new InvestigationChallengeError(
      candidateQuestions.length > 1
        ? 'ANSWER_CONTINUITY_AMBIGUOUS'
        : 'ANSWER_CONTINUITY_UNPROVEN',
      'The preceding material state does not identify one authoritative batch Question.'
    );
  }
  if (candidateQuestions[0].id !== question.questionRef) {
    throw new InvestigationChallengeError(
      'ANSWER_CONTINUITY_UNPROVEN',
      'The current batch answer follows a different factual Question.'
    );
  }

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
      challengedRevision: null
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
  if (question && reasons.size === 0) {
    try {
      const resolved = resolveAnsweredQuestionRevision(database, question, current);
      if (resolved.id !== challenge.challengedRevisionId) {
        reasons.add('ANSWER_CONTEXT_CHANGED');
      } else {
        challengedRevision = resolved;
      }
    } catch {
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
    challengedRevision
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
    !derived.challengedRevision
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
    challengedRevision: derived.challengedRevision
  };
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
