import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import {
  getCaseHistory,
  readCaseSnapshot,
  type LifecycleContext
} from '../workflow/case-lifecycle';

const questionRefSchema = z.string().min(1).max(500).refine(
  (value) => value.trim().length > 0,
  'Question references must contain a non-whitespace character.'
);
const timestampSchema = z.string().datetime();

const registerQuestionInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  questionRef: questionRefSchema,
  expectedCaseVersion: z.number().int().positive(),
  demo: z.literal(true)
});

const questionSchema = z.strictObject({
  questionRef: questionRefSchema,
  caseId: z.string().uuid(),
  subjectRef: z.string().uuid(),
  questionType: z.literal('AFFECTED_BATCH_LOT'),
  originCaseVersion: z.number().int().positive(),
  originMaterialRevision: z.number().int().positive(),
  createdAt: timestampSchema,
  demo: z.boolean()
});

const getQuestionInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  questionRef: questionRefSchema
});

export type RegisterCurrentInvestigationQuestionInput = z.infer<
  typeof registerQuestionInputSchema
>;
export type InvestigationQuestion = z.infer<typeof questionSchema>;
export type InvestigationQuestionContext = {
  question: InvestigationQuestion;
  contextKind: 'OPEN_GAP' | 'NOT_CURRENT';
  currentCaseVersion: number;
  currentMaterialRevision: number | null;
};

export type InvestigationQuestionErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'VERSIONED_CASE_REQUIRED'
  | 'STALE_CASE_VERSION'
  | 'QUESTION_NOT_CURRENT'
  | 'QUESTION_AMBIGUOUS'
  | 'QUESTION_HISTORY_UNPROVEN'
  | 'QUESTION_HISTORY_AMBIGUOUS'
  | 'QUESTION_NOT_FOUND'
  | 'QUESTION_CONFLICT'
  | 'QUESTION_OWNERSHIP_MISMATCH';

export class InvestigationQuestionError extends Error {
  constructor(
    public readonly code: InvestigationQuestionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvestigationQuestionError';
  }
}

type QuestionLineage = Omit<InvestigationQuestion, 'questionType'> & {
  questionType: 'AFFECTED_BATCH_LOT';
};

function hydrateQuestion(
  row: typeof schema.investigationQuestions.$inferSelect
): InvestigationQuestion {
  return questionSchema.parse(row);
}

function exactRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Derive ownership only from authoritative snapshots. Investigation child rows may nominate a
 * reference for reconciliation, but they never prove that the question was authoritative.
 */
function deriveQuestionLineage(
  database: RecallDatabase,
  caseId: string,
  questionRef: string
): QuestionLineage {
  const history = getCaseHistory(database, caseId);
  if (history.length === 0) {
    throw new InvestigationQuestionError(
      'QUESTION_HISTORY_UNPROVEN',
      'Authoritative case revision history does not prove this investigation question.'
    );
  }

  let firstAppearance: QuestionLineage | null = null;
  let lineageProductId: string | null = null;
  let lineageDemo: boolean | null = null;

  for (const revision of history) {
    const snapshot = revision.snapshot;
    const gaps = snapshot.investigation?.gaps.filter((issue) => issue.id === questionRef) ?? [];
    const conflicts = snapshot.investigation?.conflicts.filter(
      (issue) => issue.id === questionRef
    ) ?? [];
    const occurrences = [...gaps, ...conflicts];
    if (occurrences.length === 0) continue;
    if (occurrences.length !== 1) {
      throw new InvestigationQuestionError(
        'QUESTION_HISTORY_AMBIGUOUS',
        'Authoritative history contains a duplicated investigation question identity.'
      );
    }
    const issue = occurrences[0];
    if (issue.code !== 'BATCH_MISSING' && issue.code !== 'BATCH_CONFLICT') {
      throw new InvestigationQuestionError(
        'QUESTION_HISTORY_AMBIGUOUS',
        'The question reference was reused for a different investigation meaning.'
      );
    }
    if (!exactRefs(issue.subjectRefs, [snapshot.productId])) {
      throw new InvestigationQuestionError(
        'QUESTION_HISTORY_AMBIGUOUS',
        'The historical question does not identify exactly the authoritative product.'
      );
    }
    if (
      snapshot.caseId !== caseId ||
      (lineageProductId !== null && lineageProductId !== snapshot.productId) ||
      (lineageDemo !== null && lineageDemo !== snapshot.demo)
    ) {
      throw new InvestigationQuestionError(
        'QUESTION_HISTORY_AMBIGUOUS',
        'The historical question has inconsistent case, product, or demo ownership.'
      );
    }
    lineageProductId = snapshot.productId;
    lineageDemo = snapshot.demo;

    if (issue.code !== 'BATCH_MISSING' || firstAppearance !== null) continue;
    if (revision.materialRevision === null || revision.materialRevision < 1) {
      throw new InvestigationQuestionError(
        'QUESTION_HISTORY_AMBIGUOUS',
        'The first authoritative question appearance has no valid material revision.'
      );
    }
    firstAppearance = {
      questionRef,
      caseId,
      subjectRef: snapshot.productId,
      questionType: 'AFFECTED_BATCH_LOT',
      originCaseVersion: revision.caseVersion,
      originMaterialRevision: revision.materialRevision,
      createdAt: revision.createdAt,
      demo: snapshot.demo
    };
  }

  if (!firstAppearance) {
    throw new InvestigationQuestionError(
      'QUESTION_HISTORY_UNPROVEN',
      'Authoritative case history never records this reference as BATCH_MISSING.'
    );
  }
  return firstAppearance;
}

function questionSemanticsMatch(
  existing: typeof schema.investigationQuestions.$inferSelect,
  lineage: QuestionLineage
): boolean {
  return existing.questionRef === lineage.questionRef &&
    existing.caseId === lineage.caseId &&
    existing.subjectRef === lineage.subjectRef &&
    existing.questionType === lineage.questionType &&
    existing.originCaseVersion === lineage.originCaseVersion &&
    existing.originMaterialRevision === lineage.originMaterialRevision &&
    existing.createdAt === lineage.createdAt &&
    existing.demo === lineage.demo;
}

function registerProvenLineage(
  database: RecallDatabase,
  caseId: string,
  questionRef: string,
  demo: boolean
): { question: InvestigationQuestion; replayed: boolean } {
  const existing = database
    .select()
    .from(schema.investigationQuestions)
    .where(eq(schema.investigationQuestions.questionRef, questionRef))
    .get();

  if (existing && (existing.caseId !== caseId || existing.demo !== demo)) {
    throw new InvestigationQuestionError(
      'QUESTION_CONFLICT',
      'This question reference already identifies different immutable ownership.'
    );
  }

  const lineage = deriveQuestionLineage(database, caseId, questionRef);
  if (lineage.demo !== demo) {
    throw new InvestigationQuestionError(
      'QUESTION_OWNERSHIP_MISMATCH',
      'Question demo provenance does not match its authoritative case history.'
    );
  }
  if (existing) {
    if (!questionSemanticsMatch(existing, lineage)) {
      throw new InvestigationQuestionError(
        'QUESTION_CONFLICT',
        'The stored question lineage conflicts with authoritative case history.'
      );
    }
    return { question: hydrateQuestion(existing), replayed: true };
  }

  database.insert(schema.investigationQuestions).values(lineage).run();
  return { question: questionSchema.parse(lineage), replayed: false };
}

/** Internal helper for services that have already validated an exact current gap. */
export function ensureCurrentInvestigationQuestionRegistered(
  database: RecallDatabase,
  input: RegisterCurrentInvestigationQuestionInput
): { question: InvestigationQuestion; replayed: boolean } {
  const parsed = registerQuestionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationQuestionError('INVALID_INPUT', 'Invalid investigation question input.');
  }

  const existing = database
    .select()
    .from(schema.investigationQuestions)
    .where(eq(schema.investigationQuestions.questionRef, parsed.data.questionRef))
    .get();
  if (existing) {
    return registerProvenLineage(
      database,
      parsed.data.caseId,
      parsed.data.questionRef,
      parsed.data.demo
    );
  }

  const current = readCaseSnapshot(database, parsed.data.caseId);
  if (!current) {
    throw new InvestigationQuestionError(
      'VERSIONED_CASE_REQUIRED',
      'The owning case does not have a versioned investigation lifecycle.'
    );
  }
  if (current.caseVersion !== parsed.data.expectedCaseVersion) {
    throw new InvestigationQuestionError(
      'STALE_CASE_VERSION',
      'Refresh the case before registering its current investigation question.'
    );
  }
  const matchingGaps = current.investigation?.gaps.filter(
    (gap) => gap.id === parsed.data.questionRef
  ) ?? [];
  if (matchingGaps.length === 0 || matchingGaps[0]?.code !== 'BATCH_MISSING') {
    throw new InvestigationQuestionError(
      'QUESTION_NOT_CURRENT',
      'Only an exact current BATCH_MISSING gap can register this question type.'
    );
  }
  if (matchingGaps.length !== 1) {
    throw new InvestigationQuestionError(
      'QUESTION_AMBIGUOUS',
      'The current investigation contains a duplicated gap identity.'
    );
  }
  return registerProvenLineage(
    database,
    parsed.data.caseId,
    parsed.data.questionRef,
    parsed.data.demo
  );
}

export function registerCurrentInvestigationQuestion(
  database: RecallDatabase,
  input: RegisterCurrentInvestigationQuestionInput,
  context: LifecycleContext
): { question: InvestigationQuestion; replayed: boolean } {
  if (context.mode !== 'demo') {
    throw new InvestigationQuestionError(
      'FORBIDDEN',
      'Investigation question registration requires explicit local demo mode.'
    );
  }
  return database.transaction(
    (transaction) => ensureCurrentInvestigationQuestionRegistered(transaction, input),
    { behavior: 'immediate' }
  );
}

/**
 * Used by evidence receipt. It permits a historically proven registered question after the gap
 * disappears, but it does not make Claims or Assessments post-resolution writable.
 */
export function ensureInvestigationQuestionLineageRegistered(
  database: RecallDatabase,
  input: { caseId: string; questionRef: string; demo: boolean }
): { question: InvestigationQuestion; replayed: boolean } {
  const parsed = z.strictObject({
    caseId: z.string().uuid(),
    questionRef: questionRefSchema,
    demo: z.boolean()
  }).safeParse(input);
  if (!parsed.success) {
    throw new InvestigationQuestionError('INVALID_INPUT', 'Invalid question ownership input.');
  }
  const result = registerProvenLineage(
    database,
    parsed.data.caseId,
    parsed.data.questionRef,
    parsed.data.demo
  );
  const current = readCaseSnapshot(database, parsed.data.caseId);
  if (!current || current.productId !== result.question.subjectRef) {
    throw new InvestigationQuestionError(
      'QUESTION_OWNERSHIP_MISMATCH',
      'The registered question does not belong to the current versioned case product.'
    );
  }
  return result;
}

export function getInvestigationQuestion(
  database: RecallDatabase,
  caseId: string,
  questionRef: string
): InvestigationQuestion | null {
  const parsed = getQuestionInputSchema.safeParse({ caseId, questionRef });
  if (!parsed.success) {
    throw new InvestigationQuestionError('INVALID_INPUT', 'Invalid investigation question lookup.');
  }
  const row = database
    .select()
    .from(schema.investigationQuestions)
    .where(and(
      eq(schema.investigationQuestions.caseId, parsed.data.caseId),
      eq(schema.investigationQuestions.questionRef, parsed.data.questionRef)
    ))
    .get();
  return row ? hydrateQuestion(row) : null;
}

export function listInvestigationQuestions(
  database: RecallDatabase,
  caseId: string
): InvestigationQuestion[] {
  const parsed = z.string().uuid().safeParse(caseId);
  if (!parsed.success) {
    throw new InvestigationQuestionError('INVALID_INPUT', 'Invalid investigation question list.');
  }
  return database
    .select()
    .from(schema.investigationQuestions)
    .where(eq(schema.investigationQuestions.caseId, parsed.data))
    .orderBy(
      asc(schema.investigationQuestions.createdAt),
      asc(schema.investigationQuestions.questionRef)
    )
    .all()
    .map(hydrateQuestion);
}

export function readInvestigationQuestionContext(
  database: RecallDatabase,
  caseId: string,
  questionRef: string
): InvestigationQuestionContext {
  const question = getInvestigationQuestion(database, caseId, questionRef);
  if (!question) {
    throw new InvestigationQuestionError('QUESTION_NOT_FOUND', 'Investigation question not found.');
  }
  const current = readCaseSnapshot(database, caseId);
  if (!current || current.productId !== question.subjectRef) {
    throw new InvestigationQuestionError(
      'QUESTION_OWNERSHIP_MISMATCH',
      'The question does not match the current versioned case product.'
    );
  }
  const matching = current.investigation?.gaps.filter((gap) => gap.id === questionRef) ?? [];
  if (matching.length > 1) {
    throw new InvestigationQuestionError(
      'QUESTION_AMBIGUOUS',
      'The current investigation contains a duplicated gap identity.'
    );
  }
  return {
    question,
    contextKind: matching.length === 1 && matching[0].code === 'BATCH_MISSING'
      ? 'OPEN_GAP'
      : 'NOT_CURRENT',
    currentCaseVersion: current.caseVersion,
    currentMaterialRevision: current.materialRevision
  };
}

export type InvestigationQuestionReconciliation = {
  registered: string[];
  existing: string[];
  unverified: string[];
  conflicts: string[];
};

/**
 * Explicit post-migration reconciliation. Existing versioned child rows nominate candidates;
 * authoritative case revisions alone decide whether a question may be registered.
 */
export function reconcileExistingInvestigationQuestions(
  database: RecallDatabase
): InvestigationQuestionReconciliation {
  const candidates = [
    ...database.select({
      caseId: schema.evidenceRequests.caseId,
      questionRef: schema.evidenceRequests.questionRef,
      subjectRef: schema.matches.productId
    }).from(schema.evidenceRequests)
      .innerJoin(schema.matches, eq(schema.matches.id, schema.evidenceRequests.matchId))
      .where(isNotNull(schema.evidenceRequests.caseId)).all()
      .map((row) => ({ ...row, demo: true })),
    ...database.select({
      caseId: schema.investigationClaims.caseId,
      questionRef: schema.investigationClaims.questionRef,
      subjectRef: schema.investigationClaims.subjectRef,
      demo: schema.investigationClaims.demo
    }).from(schema.investigationClaims).all(),
    ...database.select({
      caseId: schema.investigationAssessments.caseId,
      questionRef: schema.investigationAssessments.questionRef,
      subjectRef: schema.investigationAssessments.targetClaimRef,
      demo: schema.investigationAssessments.demo
    }).from(schema.investigationAssessments).all()
      .map((row) => ({ ...row, subjectRef: null })),
    ...database.select({
      caseId: schema.investigationEstablishments.caseId,
      questionRef: schema.investigationEstablishments.questionRef,
      subjectRef: schema.investigationEstablishments.claimRef,
      demo: schema.investigationEstablishments.demo
    }).from(schema.investigationEstablishments).all()
      .map((row) => ({ ...row, subjectRef: null }))
  ].filter((row): row is {
    caseId: string;
    questionRef: string;
    subjectRef: string | null;
    demo: boolean;
  } =>
    row.caseId !== null && row.questionRef !== null
  );

  const grouped = new Map<string, typeof candidates>();
  const result: InvestigationQuestionReconciliation = {
    registered: [], existing: [], unverified: [], conflicts: []
  };
  for (const candidate of candidates) {
    const key = `${candidate.caseId}\u0000${candidate.questionRef}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const conflictedRefs = new Set(
    [...grouped.values()]
      .flatMap((group) => group)
      .filter((candidate, _index, all) => all.some((other) =>
        other.questionRef === candidate.questionRef && other.caseId !== candidate.caseId
      ))
      .map((candidate) => candidate.questionRef)
  );

  for (const group of [...grouped.values()].sort((left, right) =>
    left[0].caseId.localeCompare(right[0].caseId) ||
    left[0].questionRef.localeCompare(right[0].questionRef)
  )) {
    const candidate = group[0];
    const label = `${candidate.caseId}:${candidate.questionRef}`;
    if (
      conflictedRefs.has(candidate.questionRef) ||
      new Set(group.map((item) => item.demo)).size !== 1
    ) {
      result.conflicts.push(label);
      continue;
    }
    try {
      const lineage = deriveQuestionLineage(database, candidate.caseId, candidate.questionRef);
      const candidateSubjects = new Set(
        group.flatMap((item) => item.subjectRef === null ? [] : [item.subjectRef])
      );
      if (
        candidateSubjects.size > 1 ||
        (candidateSubjects.size === 1 && !candidateSubjects.has(lineage.subjectRef))
      ) {
        result.conflicts.push(label);
        continue;
      }
      const registered = registerProvenLineage(
        database,
        candidate.caseId,
        candidate.questionRef,
        candidate.demo
      );
      (registered.replayed ? result.existing : result.registered).push(label);
    } catch (error) {
      if (
        error instanceof InvestigationQuestionError &&
        error.code === 'QUESTION_HISTORY_UNPROVEN'
      ) {
        result.unverified.push(label);
      } else {
        result.conflicts.push(label);
      }
    }
  }
  return result;
}
