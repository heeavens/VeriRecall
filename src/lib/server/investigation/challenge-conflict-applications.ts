import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  investigationOutcomeSchema,
  type CaseSnapshot,
  type InvestigationOutcome
} from '../../contracts/recall';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import {
  applyAuthoritativeInvestigationOutcomeInTransaction,
  readCaseRevisionByCaseVersion,
  readCaseRevisionById,
  readCaseSnapshot,
  type LifecycleContext,
  type StoredCaseRevision
} from '../workflow/case-lifecycle';
import {
  challengeConflictApplicationBasisFormatVersion,
  challengeConflictApplicationPolicy,
  readChallengeConflictApplicationBasisInTransaction
} from './challenge-conflict-basis';
import { getInvestigationChallenge } from './challenges';
import { demoHumanAssessorIdentifier } from './demo-context';
import { getInvestigationQuestion } from './questions';

const opaqueReferenceSchema = z.string().min(1).max(500).refine(
  (value) => value.trim().length > 0,
  'References must contain a non-whitespace character.'
);
const rationaleSchema = z.string().trim().min(1).max(10_000);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const canonicalReferenceArraySchema = z.array(opaqueReferenceSchema).min(1).refine(
  (values) => new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1] < value),
  'Reference arrays must be unique and lexically ordered.'
);

const applyInvestigationChallengeConflictInputSchema = z.strictObject({
  applicationRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  challengeRef: z.string().uuid(),
  expectedCaseVersion: z.number().int().positive(),
  expectedMaterialRevision: z.number().int().positive(),
  expectedApplicationBasisDigest: digestSchema,
  rationale: rationaleSchema,
  demo: z.literal(true)
});

const investigationChallengeConflictApplicationSchema = z.strictObject({
  applicationRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  challengeRef: z.string().uuid(),
  policyIdentifier: z.literal(challengeConflictApplicationPolicy.identifier),
  policyVersion: z.literal(challengeConflictApplicationPolicy.version),
  basisFormatVersion: z.literal(challengeConflictApplicationBasisFormatVersion),
  basisDigest: digestSchema,
  reviewedClaimRefs: canonicalReferenceArraySchema,
  reviewedAssessmentRefs: canonicalReferenceArraySchema,
  completeEvidenceRefs: canonicalReferenceArraySchema,
  appliedClaimRefs: canonicalReferenceArraySchema,
  appliedAssessmentRefs: canonicalReferenceArraySchema,
  appliedEvidenceRefs: canonicalReferenceArraySchema,
  sourceRevisionId: z.string().uuid(),
  sourceCaseVersion: z.number().int().positive(),
  sourceMaterialRevision: z.number().int().positive(),
  resultingRevisionId: z.string().uuid(),
  resultingCaseVersion: z.number().int().positive(),
  resultingMaterialRevision: z.number().int().positive(),
  actorKind: z.literal('HUMAN'),
  actorIdentifier: z.literal(demoHumanAssessorIdentifier),
  rationale: rationaleSchema,
  createdAt: z.string().datetime(),
  demo: z.literal(true)
}).superRefine((value, validation) => {
  if (value.resultingCaseVersion !== value.sourceCaseVersion + 1) {
    validation.addIssue({
      code: 'custom',
      path: ['resultingCaseVersion'],
      message: 'The resulting case version must be exactly one greater than its source.'
    });
  }
  if (value.resultingMaterialRevision !== value.sourceMaterialRevision + 1) {
    validation.addIssue({
      code: 'custom',
      path: ['resultingMaterialRevision'],
      message: 'The resulting material revision must be exactly one greater than its source.'
    });
  }
});

export type ApplyInvestigationChallengeConflictInput = z.infer<
  typeof applyInvestigationChallengeConflictInputSchema
>;
export type InvestigationChallengeConflictApplication = z.infer<
  typeof investigationChallengeConflictApplicationSchema
>;

export type InvestigationChallengeConflictApplicationErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'APPLICATION_NOT_FOUND'
  | 'APPLICATION_CONFLICT'
  | 'CHALLENGE_ALREADY_APPLIED'
  | 'CHALLENGE_RESOLUTION_CONFLICT'
  | 'COMMAND_ID_CONFLICT'
  | 'VERSIONED_CASE_REQUIRED'
  | 'STALE_CASE_VERSION'
  | 'STALE_MATERIAL_REVISION'
  | 'STALE_APPLICATION_BASIS'
  | 'APPLICATION_NOT_ELIGIBLE'
  | 'APPLICATION_PROVENANCE_INVALID'
  | 'SOURCE_REVISION_UNRESOLVED'
  | 'RESULT_REVISION_UNRESOLVED';

export class InvestigationChallengeConflictApplicationError extends Error {
  constructor(
    public readonly code: InvestigationChallengeConflictApplicationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvestigationChallengeConflictApplicationError';
  }
}

export interface ApplyInvestigationChallengeConflictResult {
  application: InvestigationChallengeConflictApplication;
  replayed: boolean;
  snapshot: CaseSnapshot;
}

const conflictReason =
  'Incompatible affected batch/lot claims remain unresolved after review.';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalReferences(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameReferences(left: readonly string[], right: readonly string[]): boolean {
  const canonicalLeft = canonicalReferences(left);
  const canonicalRight = canonicalReferences(right);
  return canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index]);
}

function parseInput(input: unknown): ApplyInvestigationChallengeConflictInput {
  const parsed = applyInvestigationChallengeConflictInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationChallengeConflictApplicationError(
      'INVALID_INPUT',
      'Invalid investigation Challenge conflict application request.'
    );
  }
  return parsed.data;
}

function hydrateApplication(
  row: typeof schema.investigationChallengeConflictApplications.$inferSelect
): InvestigationChallengeConflictApplication {
  try {
    return investigationChallengeConflictApplicationSchema.parse({
      applicationRef: row.applicationRef,
      caseId: row.caseId,
      questionRef: row.questionRef,
      challengeRef: row.challengeRef,
      policyIdentifier: row.policyIdentifier,
      policyVersion: row.policyVersion,
      basisFormatVersion: row.basisFormatVersion,
      basisDigest: row.basisDigest,
      reviewedClaimRefs: JSON.parse(row.reviewedClaimRefsJson),
      reviewedAssessmentRefs: JSON.parse(row.reviewedAssessmentRefsJson),
      completeEvidenceRefs: JSON.parse(row.completeEvidenceRefsJson),
      appliedClaimRefs: JSON.parse(row.appliedClaimRefsJson),
      appliedAssessmentRefs: JSON.parse(row.appliedAssessmentRefsJson),
      appliedEvidenceRefs: JSON.parse(row.appliedEvidenceRefsJson),
      sourceRevisionId: row.sourceRevisionId,
      sourceCaseVersion: row.sourceCaseVersion,
      sourceMaterialRevision: row.sourceMaterialRevision,
      resultingRevisionId: row.resultingRevisionId,
      resultingCaseVersion: row.resultingCaseVersion,
      resultingMaterialRevision: row.resultingMaterialRevision,
      actorKind: row.actorKind,
      actorIdentifier: row.actorIdentifier,
      rationale: row.rationale,
      createdAt: row.createdAt,
      demo: row.demo
    });
  } catch {
    throw new InvestigationChallengeConflictApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge conflict application provenance is malformed.'
    );
  }
}

function immutableSemanticsMatch(
  row: typeof schema.investigationChallengeConflictApplications.$inferSelect,
  input: ApplyInvestigationChallengeConflictInput
): boolean {
  return row.applicationRef === input.applicationRef &&
    row.caseId === input.caseId &&
    row.questionRef === input.questionRef &&
    row.challengeRef === input.challengeRef &&
    row.rationale === input.rationale &&
    row.demo === input.demo;
}

function internalCommandPayload(
  application: Pick<
    InvestigationChallengeConflictApplication,
    | 'applicationRef'
    | 'caseId'
    | 'questionRef'
    | 'challengeRef'
    | 'basisDigest'
    | 'sourceCaseVersion'
    | 'sourceMaterialRevision'
  >
): string {
  return JSON.stringify({
    operation: 'APPLY_INVESTIGATION_CHALLENGE_CONFLICT',
    applicationRef: application.applicationRef,
    caseId: application.caseId,
    questionRef: application.questionRef,
    challengeRef: application.challengeRef,
    applicationBasisDigest: application.basisDigest,
    sourceCaseVersion: application.sourceCaseVersion,
    sourceMaterialRevision: application.sourceMaterialRevision
  });
}

function readRevision(
  database: RecallDatabase,
  application: InvestigationChallengeConflictApplication,
  kind: 'source' | 'result'
): StoredCaseRevision {
  const revisionId = kind === 'source'
    ? application.sourceRevisionId
    : application.resultingRevisionId;
  let revision: StoredCaseRevision | null;
  try {
    revision = readCaseRevisionById(database, application.caseId, revisionId);
  } catch {
    revision = null;
  }
  if (!revision) {
    throw new InvestigationChallengeConflictApplicationError(
      kind === 'source' ? 'SOURCE_REVISION_UNRESOLVED' : 'RESULT_REVISION_UNRESOLVED',
      `The exact ${kind} authoritative case revision cannot be resolved.`
    );
  }
  const expectedCaseVersion = kind === 'source'
    ? application.sourceCaseVersion
    : application.resultingCaseVersion;
  const expectedMaterialRevision = kind === 'source'
    ? application.sourceMaterialRevision
    : application.resultingMaterialRevision;
  if (
    revision.caseVersion !== expectedCaseVersion ||
    revision.materialRevision !== expectedMaterialRevision
  ) {
    throw new InvestigationChallengeConflictApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      `Stored Challenge application ${kind} revision lineage is inconsistent.`
    );
  }
  return revision;
}

function validateApplicationProvenance(
  database: RecallDatabase,
  application: InvestigationChallengeConflictApplication
): CaseSnapshot {
  let question: ReturnType<typeof getInvestigationQuestion>;
  let challenge: ReturnType<typeof getInvestigationChallenge>;
  try {
    question = getInvestigationQuestion(
      database,
      application.caseId,
      application.questionRef
    );
    challenge = getInvestigationChallenge(
      database,
      application.caseId,
      application.challengeRef
    );
  } catch {
    throw new InvestigationChallengeConflictApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge application Question or Challenge provenance is malformed.'
    );
  }
  if (
    !question ||
    !challenge ||
    challenge.questionRef !== application.questionRef ||
    challenge.challengedMaterialRevision !== application.sourceMaterialRevision ||
    question.questionType !== 'AFFECTED_BATCH_LOT' ||
    !question.demo ||
    !challenge.demo
  ) {
    throw new InvestigationChallengeConflictApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge application Question or Challenge ownership is inconsistent.'
    );
  }
  const positiveApplication = database.select({
    applicationRef: schema.investigationChallengeBatchApplications.applicationRef
  }).from(schema.investigationChallengeBatchApplications).where(eq(
    schema.investigationChallengeBatchApplications.challengeRef,
    application.challengeRef
  )).get();
  if (positiveApplication) {
    throw new InvestigationChallengeConflictApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Positive and conflict applications coexist for one Challenge.'
    );
  }
  const source = readRevision(database, application, 'source');
  const result = readRevision(database, application, 'result');
  const command = database.select().from(schema.caseCommands).where(and(
    eq(schema.caseCommands.caseId, application.caseId),
    eq(schema.caseCommands.commandId, application.applicationRef)
  )).get();
  if (
    !command ||
    command.appliedCaseVersion !== application.resultingCaseVersion ||
    command.payloadJson !== internalCommandPayload(application) ||
    source.snapshot.productId !== question.subjectRef ||
    source.snapshot.investigation?.scope.kind !== 'BATCH_LOT' ||
    source.snapshot.investigation.scope.knowledgeStatus !== 'KNOWN' ||
    result.snapshot.productId !== question.subjectRef ||
    result.snapshot.investigation?.scope.kind !== 'UNRESOLVED' ||
    result.snapshot.investigation.scope.knowledgeStatus !== 'CONFLICTED' ||
    !result.snapshot.investigation.scope.decisionRefs.includes(application.applicationRef) ||
    !sameReferences(
      result.snapshot.investigation.scope.evidenceRefs,
      application.appliedEvidenceRefs
    ) ||
    !result.snapshot.investigation.decisionRefs.includes(application.applicationRef) ||
    !result.snapshot.investigation.conflicts.some((issue) =>
      issue.id === application.questionRef &&
      issue.code === 'BATCH_CONFLICT' &&
      issue.subjectRefs.length === 1 &&
      issue.subjectRefs[0] === question.subjectRef &&
      sameReferences(issue.evidenceRefs, application.appliedEvidenceRefs)
    )
  ) {
    throw new InvestigationChallengeConflictApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge application execution or authoritative result is inconsistent.'
    );
  }
  return result.snapshot;
}

function deriveConflictOutcome(
  current: CaseSnapshot,
  applicationRef: string,
  questionRef: string,
  appliedEvidenceRefs: readonly string[],
  updatedAt: string
): InvestigationOutcome {
  const investigation = current.investigation;
  if (
    !investigation ||
    current.materialRevision === null ||
    investigation.materialRevision !== current.materialRevision ||
    investigation.identity.knowledgeStatus !== 'KNOWN' ||
    investigation.identity.conclusion !== 'MATCH' ||
    investigation.scope.kind !== 'BATCH_LOT' ||
    investigation.scope.knowledgeStatus !== 'KNOWN'
  ) {
    throw new InvestigationChallengeConflictApplicationError(
      'APPLICATION_NOT_ELIGIBLE',
      'The current authoritative outcome no longer contains the challenged known batch answer.'
    );
  }
  if (
    [...investigation.gaps, ...investigation.conflicts].some((issue) =>
      issue.id === questionRef ||
      ((issue.code === 'BATCH_MISSING' || issue.code === 'BATCH_CONFLICT') &&
        issue.subjectRefs.length === 1 && issue.subjectRefs[0] === current.productId)
    )
  ) {
    throw new InvestigationChallengeConflictApplicationError(
      'APPLICATION_NOT_ELIGIBLE',
      'The current authoritative outcome already contains inconsistent conflict lineage.'
    );
  }

  const evidenceRefs = canonicalReferences([
    ...investigation.evidenceRefs,
    ...investigation.identity.evidenceRefs,
    ...appliedEvidenceRefs,
    ...investigation.gaps.flatMap((issue) => issue.evidenceRefs),
    ...investigation.conflicts.flatMap((issue) => issue.evidenceRefs)
  ]);
  const decisionRefs = canonicalReferences([
    ...investigation.decisionRefs,
    ...investigation.identity.decisionRefs,
    applicationRef
  ]);
  const appliedEvidence = canonicalReferences(appliedEvidenceRefs);
  return investigationOutcomeSchema.parse({
    ...investigation,
    materialRevision: current.materialRevision + 1,
    updatedAt,
    knowledgeStatus: 'CONFLICTED',
    identity: structuredClone(investigation.identity),
    scope: {
      kind: 'UNRESOLVED',
      reason: conflictReason,
      knowledgeStatus: 'CONFLICTED',
      evidenceRefs: appliedEvidence,
      decisionRefs: [applicationRef]
    },
    evidenceRefs,
    decisionRefs,
    gaps: structuredClone(investigation.gaps),
    conflicts: [
      ...structuredClone(investigation.conflicts),
      {
        id: questionRef,
        code: 'BATCH_CONFLICT',
        message: conflictReason,
        critical: true,
        subjectRefs: [current.productId],
        evidenceRefs: appliedEvidence
      }
    ],
    demo: true
  });
}

export function getInvestigationChallengeConflictApplication(
  database: RecallDatabase,
  caseId: string,
  applicationRef: string
): InvestigationChallengeConflictApplication | null {
  const row = database.select().from(schema.investigationChallengeConflictApplications)
    .where(and(
      eq(schema.investigationChallengeConflictApplications.caseId, caseId),
      eq(schema.investigationChallengeConflictApplications.applicationRef, applicationRef)
    )).get();
  if (!row) return null;
  const application = hydrateApplication(row);
  validateApplicationProvenance(database, application);
  return application;
}

export function applyInvestigationChallengeConflict(
  database: RecallDatabase,
  input: unknown,
  context: LifecycleContext,
  now = new Date()
): ApplyInvestigationChallengeConflictResult {
  if (context.mode !== 'demo') {
    throw new InvestigationChallengeConflictApplicationError(
      'FORBIDDEN',
      'Challenge conflict application requires explicit local demo mode.'
    );
  }
  const parsed = parseInput(input);

  return database.transaction((transaction) => {
    const existing = transaction.select()
      .from(schema.investigationChallengeConflictApplications)
      .where(eq(
        schema.investigationChallengeConflictApplications.applicationRef,
        parsed.applicationRef
      )).get();
    if (existing) {
      if (!immutableSemanticsMatch(existing, parsed)) {
        throw new InvestigationChallengeConflictApplicationError(
          'APPLICATION_CONFLICT',
          'This application reference already identifies different immutable semantics.'
        );
      }
      const application = hydrateApplication(existing);
      return {
        application,
        replayed: true,
        snapshot: validateApplicationProvenance(transaction, application)
      };
    }

    const challengeApplication = transaction.select({
      applicationRef: schema.investigationChallengeConflictApplications.applicationRef
    }).from(schema.investigationChallengeConflictApplications).where(eq(
      schema.investigationChallengeConflictApplications.challengeRef,
      parsed.challengeRef
    )).get();
    if (challengeApplication) {
      throw new InvestigationChallengeConflictApplicationError(
        'CHALLENGE_ALREADY_APPLIED',
        'This investigation Challenge already produced an authoritative conflict application.'
      );
    }
    const positiveApplication = transaction.select({
      applicationRef: schema.investigationChallengeBatchApplications.applicationRef
    }).from(schema.investigationChallengeBatchApplications).where(eq(
      schema.investigationChallengeBatchApplications.challengeRef,
      parsed.challengeRef
    )).get();
    if (positiveApplication) {
      throw new InvestigationChallengeConflictApplicationError(
        'CHALLENGE_RESOLUTION_CONFLICT',
        'This Challenge already has an authoritative positive batch application.'
      );
    }
    const commandCollision = transaction.select({ id: schema.caseCommands.id })
      .from(schema.caseCommands)
      .where(eq(schema.caseCommands.commandId, parsed.applicationRef))
      .get();
    if (commandCollision) {
      throw new InvestigationChallengeConflictApplicationError(
        'COMMAND_ID_CONFLICT',
        'The application reference is already used by an unrelated lifecycle command.'
      );
    }

    const current = readCaseSnapshot(transaction, parsed.caseId);
    if (!current) {
      throw new InvestigationChallengeConflictApplicationError(
        'VERSIONED_CASE_REQUIRED',
        'The owning case does not have a versioned investigation lifecycle.'
      );
    }
    if (current.caseVersion !== parsed.expectedCaseVersion) {
      throw new InvestigationChallengeConflictApplicationError(
        'STALE_CASE_VERSION',
        'Refresh the case before applying its Challenge conflict.'
      );
    }
    if (current.materialRevision !== parsed.expectedMaterialRevision) {
      throw new InvestigationChallengeConflictApplicationError(
        'STALE_MATERIAL_REVISION',
        'Refresh the authoritative material answer before applying its Challenge conflict.'
      );
    }
    if (current.materialRevision === null) {
      throw new InvestigationChallengeConflictApplicationError(
        'SOURCE_REVISION_UNRESOLVED',
        'The current authoritative material revision is missing.'
      );
    }

    let sourceRevision: StoredCaseRevision | null;
    try {
      sourceRevision = readCaseRevisionByCaseVersion(
        transaction,
        parsed.caseId,
        current.caseVersion
      );
    } catch {
      sourceRevision = null;
    }
    if (
      !sourceRevision ||
      sourceRevision.materialRevision !== current.materialRevision
    ) {
      throw new InvestigationChallengeConflictApplicationError(
        'SOURCE_REVISION_UNRESOLVED',
        'The exact current authoritative source revision cannot be resolved.'
      );
    }

    const basis = readChallengeConflictApplicationBasisInTransaction(
      transaction,
      parsed.caseId,
      parsed.questionRef,
      parsed.challengeRef
    );
    if (basis.applicationBasisDigest !== parsed.expectedApplicationBasisDigest) {
      throw new InvestigationChallengeConflictApplicationError(
        'STALE_APPLICATION_BASIS',
        'The reviewed Challenge conflict basis has changed; refresh and review it again.'
      );
    }
    if (!basis.eligibility.eligible || !basis.qualifyingConflict) {
      throw new InvestigationChallengeConflictApplicationError(
        'APPLICATION_NOT_ELIGIBLE',
        'The current Challenge analysis does not satisfy conflict application policy.'
      );
    }

    const question = getInvestigationQuestion(
      transaction,
      parsed.caseId,
      parsed.questionRef
    );
    const caseRecord = transaction.select().from(schema.cases)
      .where(eq(schema.cases.id, parsed.caseId)).get();
    if (!question || question.subjectRef !== current.productId || !caseRecord) {
      throw new InvestigationChallengeConflictApplicationError(
        'APPLICATION_PROVENANCE_INVALID',
        'The application case, Question, or product ownership is inconsistent.'
      );
    }

    const updatedAt = now.toISOString();
    const outcome = deriveConflictOutcome(
      current,
      parsed.applicationRef,
      parsed.questionRef,
      basis.qualifyingConflict.evidenceRefs,
      updatedAt
    );
    const applicationCommand = {
      applicationRef: parsed.applicationRef,
      caseId: parsed.caseId,
      questionRef: parsed.questionRef,
      challengeRef: parsed.challengeRef,
      basisDigest: basis.applicationBasisDigest,
      sourceCaseVersion: current.caseVersion,
      sourceMaterialRevision: current.materialRevision
    };
    const commandPayloadJson = internalCommandPayload(applicationCommand);
    const transition = applyAuthoritativeInvestigationOutcomeInTransaction(transaction, {
      current,
      outcome,
      alertId: caseRecord.alertId,
      commandId: parsed.applicationRef,
      commandPayloadJson,
      updatedAt,
      eventType: current.stage === 'CLOSED'
        ? 'case_reopened'
        : 'investigation_challenge_conflict_applied',
      eventSummary: current.stage === 'CLOSED'
        ? 'Reopened the case after applying a reviewed investigation Challenge conflict.'
        : 'Applied a reviewed investigation Challenge as authoritative unresolved conflict.',
      eventMetadata: {
        applicationRef: parsed.applicationRef,
        challengeRef: parsed.challengeRef,
        policyIdentifier: basis.policyIdentifier,
        policyVersion: basis.policyVersion,
        basisFormatVersion: basis.basisFormatVersion,
        basisDigest: basis.applicationBasisDigest,
        sourceRevisionId: sourceRevision.revisionId,
        sourceCaseVersion: current.caseVersion,
        sourceMaterialRevision: current.materialRevision
      },
      includeTransitionAuditMetadata: true
    });

    transaction.insert(schema.investigationChallengeConflictApplications).values({
      applicationRef: parsed.applicationRef,
      caseId: parsed.caseId,
      questionRef: parsed.questionRef,
      challengeRef: parsed.challengeRef,
      policyIdentifier: basis.policyIdentifier,
      policyVersion: basis.policyVersion,
      basisFormatVersion: basis.basisFormatVersion,
      basisDigest: basis.applicationBasisDigest,
      reviewedClaimRefsJson: JSON.stringify(canonicalReferences(basis.projectionBasis.claimRefs)),
      reviewedAssessmentRefsJson: JSON.stringify(
        canonicalReferences(basis.projectionBasis.assessmentRefs)
      ),
      completeEvidenceRefsJson: JSON.stringify(
        canonicalReferences(basis.completeEvidenceRefs)
      ),
      appliedClaimRefsJson: JSON.stringify(
        canonicalReferences(basis.qualifyingConflict.relatedClaimRefs)
      ),
      appliedAssessmentRefsJson: JSON.stringify([
        basis.qualifyingConflict.contradictionAssessmentRef
      ]),
      appliedEvidenceRefsJson: JSON.stringify(
        canonicalReferences(basis.qualifyingConflict.evidenceRefs)
      ),
      sourceRevisionId: sourceRevision.revisionId,
      sourceCaseVersion: current.caseVersion,
      sourceMaterialRevision: current.materialRevision,
      resultingRevisionId: transition.resultingRevisionId,
      resultingCaseVersion: transition.snapshot.caseVersion,
      resultingMaterialRevision: transition.snapshot.materialRevision!,
      actorKind: 'HUMAN',
      actorIdentifier: demoHumanAssessorIdentifier,
      rationale: parsed.rationale,
      createdAt: updatedAt,
      demo: true
    }).run();

    const stored = getInvestigationChallengeConflictApplication(
      transaction,
      parsed.caseId,
      parsed.applicationRef
    );
    if (!stored) {
      throw new InvestigationChallengeConflictApplicationError(
        'APPLICATION_PROVENANCE_INVALID',
        'The stored Challenge conflict application could not be reloaded.'
      );
    }
    return { application: stored, replayed: false, snapshot: transition.snapshot };
  }, { behavior: 'immediate' });
}
