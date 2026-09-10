import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  investigationOutcomeSchema,
  type CaseSnapshot,
  type InvestigationOutcome
} from '../../contracts/recall';
import { normalizeBatch } from '../alerts/normalization';
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
import { getInvestigationClaim } from './claims';
import { demoHumanAssessorIdentifier } from './demo-context';
import {
  establishedBatchApplicationBasisFormatVersion,
  establishedBatchApplicationPolicy,
  EstablishedBatchApplicationBasisError,
  readEstablishedBatchApplicationBasisInTransaction
} from './established-batch-application-basis';
import { getInvestigationEstablishment } from './establishments';
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

const applyInvestigationEstablishedBatchInputSchema = z.strictObject({
  applicationRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  establishmentRef: z.string().uuid(),
  expectedCaseVersion: z.number().int().positive(),
  expectedMaterialRevision: z.number().int().positive(),
  expectedApplicationBasisDigest: digestSchema,
  rationale: rationaleSchema,
  demo: z.literal(true)
});

const investigationEstablishedBatchApplicationSchema = z.strictObject({
  applicationRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  establishmentRef: z.string().uuid(),
  claimRef: z.string().uuid(),
  applicationPolicyIdentifier: z.literal(establishedBatchApplicationPolicy.identifier),
  applicationPolicyVersion: z.literal(establishedBatchApplicationPolicy.version),
  basisFormatVersion: z.literal(establishedBatchApplicationBasisFormatVersion),
  basisDigest: digestSchema,
  reviewedClaimRefs: canonicalReferenceArraySchema,
  reviewedAssessmentRefs: canonicalReferenceArraySchema,
  reviewedEvidenceRefs: canonicalReferenceArraySchema,
  appliedEvidenceRefs: canonicalReferenceArraySchema,
  appliedLot: opaqueReferenceSchema,
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

export type ApplyInvestigationEstablishedBatchInput = z.infer<
  typeof applyInvestigationEstablishedBatchInputSchema
>;
export type InvestigationEstablishedBatchApplication = z.infer<
  typeof investigationEstablishedBatchApplicationSchema
>;

export type InvestigationEstablishedBatchApplicationErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'APPLICATION_NOT_FOUND'
  | 'APPLICATION_CONFLICT'
  | 'ESTABLISHMENT_NOT_FOUND'
  | 'ESTABLISHMENT_ALREADY_APPLIED'
  | 'COMMAND_ID_CONFLICT'
  | 'VERSIONED_CASE_REQUIRED'
  | 'STALE_CASE_VERSION'
  | 'STALE_MATERIAL_REVISION'
  | 'STALE_APPLICATION_BASIS'
  | 'APPLICATION_NOT_ELIGIBLE'
  | 'APPLICATION_PROVENANCE_INVALID'
  | 'SOURCE_REVISION_UNRESOLVED'
  | 'RESULT_REVISION_UNRESOLVED';

export class InvestigationEstablishedBatchApplicationError extends Error {
  constructor(
    public readonly code: InvestigationEstablishedBatchApplicationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvestigationEstablishedBatchApplicationError';
  }
}

export interface ApplyInvestigationEstablishedBatchResult {
  application: InvestigationEstablishedBatchApplication;
  replayed: boolean;
  snapshot: CaseSnapshot;
}

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

function parseInput(input: unknown): ApplyInvestigationEstablishedBatchInput {
  const parsed = applyInvestigationEstablishedBatchInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationEstablishedBatchApplicationError(
      'INVALID_INPUT',
      'Invalid established batch application request.'
    );
  }
  return parsed.data;
}

function hydrateApplication(
  row: typeof schema.investigationEstablishedBatchApplications.$inferSelect
): InvestigationEstablishedBatchApplication {
  try {
    return investigationEstablishedBatchApplicationSchema.parse({
      applicationRef: row.applicationRef,
      caseId: row.caseId,
      questionRef: row.questionRef,
      establishmentRef: row.establishmentRef,
      claimRef: row.claimRef,
      applicationPolicyIdentifier: row.applicationPolicyIdentifier,
      applicationPolicyVersion: row.applicationPolicyVersion,
      basisFormatVersion: row.basisFormatVersion,
      basisDigest: row.basisDigest,
      reviewedClaimRefs: JSON.parse(row.reviewedClaimRefsJson),
      reviewedAssessmentRefs: JSON.parse(row.reviewedAssessmentRefsJson),
      reviewedEvidenceRefs: JSON.parse(row.reviewedEvidenceRefsJson),
      appliedEvidenceRefs: JSON.parse(row.appliedEvidenceRefsJson),
      appliedLot: row.appliedLot,
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
    throw new InvestigationEstablishedBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored established batch application provenance is malformed.'
    );
  }
}

function immutableSemanticsMatch(
  row: typeof schema.investigationEstablishedBatchApplications.$inferSelect,
  input: ApplyInvestigationEstablishedBatchInput
): boolean {
  return row.applicationRef === input.applicationRef &&
    row.caseId === input.caseId &&
    row.questionRef === input.questionRef &&
    row.establishmentRef === input.establishmentRef &&
    row.rationale === input.rationale &&
    row.demo === input.demo;
}

function internalCommandPayload(
  application: Pick<
    InvestigationEstablishedBatchApplication,
    | 'applicationRef'
    | 'caseId'
    | 'questionRef'
    | 'establishmentRef'
    | 'basisDigest'
    | 'sourceCaseVersion'
    | 'sourceMaterialRevision'
  >
): string {
  return JSON.stringify({
    operation: 'APPLY_INVESTIGATION_ESTABLISHED_BATCH',
    applicationRef: application.applicationRef,
    caseId: application.caseId,
    questionRef: application.questionRef,
    establishmentRef: application.establishmentRef,
    applicationBasisDigest: application.basisDigest,
    sourceCaseVersion: application.sourceCaseVersion,
    sourceMaterialRevision: application.sourceMaterialRevision
  });
}

function readRevision(
  database: RecallDatabase,
  application: InvestigationEstablishedBatchApplication,
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
    throw new InvestigationEstablishedBatchApplicationError(
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
    throw new InvestigationEstablishedBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      `Stored established batch application ${kind} revision lineage is inconsistent.`
    );
  }
  return revision;
}

function validateApplicationProvenance(
  database: RecallDatabase,
  application: InvestigationEstablishedBatchApplication
): CaseSnapshot {
  let question: ReturnType<typeof getInvestigationQuestion>;
  let establishment: ReturnType<typeof getInvestigationEstablishment>;
  let claim: ReturnType<typeof getInvestigationClaim>;
  try {
    question = getInvestigationQuestion(database, application.caseId, application.questionRef);
    establishment = getInvestigationEstablishment(
      database,
      application.caseId,
      application.establishmentRef
    );
    claim = getInvestigationClaim(database, application.caseId, application.claimRef);
  } catch {
    question = null;
    establishment = null;
    claim = null;
  }
  if (
    !question || !establishment || !claim ||
    question.questionType !== 'AFFECTED_BATCH_LOT' ||
    question.subjectRef !== claim.subjectRef ||
    establishment.questionRef !== application.questionRef ||
    establishment.claimRef !== application.claimRef ||
    establishment.basisMaterialRevision !== application.sourceMaterialRevision ||
    claim.questionRef !== application.questionRef ||
    normalizeBatch(claim.value.lot) !== application.appliedLot ||
    !sameReferences(establishment.basisClaimRefs, application.reviewedClaimRefs) ||
    !sameReferences(establishment.basisAssessmentRefs, application.reviewedAssessmentRefs) ||
    !sameReferences(establishment.basisEvidenceRefs, application.reviewedEvidenceRefs) ||
    !sameReferences(establishment.basisEvidenceRefs, application.appliedEvidenceRefs)
  ) {
    throw new InvestigationEstablishedBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored established batch Question, Establishment, or Claim provenance is inconsistent.'
    );
  }

  const source = readRevision(database, application, 'source');
  const result = readRevision(database, application, 'result');
  const command = database.select().from(schema.caseCommands).where(and(
    eq(schema.caseCommands.caseId, application.caseId),
    eq(schema.caseCommands.commandId, application.applicationRef)
  )).get();
  const sourceQuestionIssues = source.snapshot.investigation?.gaps.filter((issue) =>
    issue.id === application.questionRef &&
    issue.code === 'BATCH_MISSING' &&
    issue.subjectRefs.length === 1 &&
    issue.subjectRefs[0] === question?.subjectRef
  ) ?? [];
  const resultInvestigation = result.snapshot.investigation;
  const sourceInvestigation = source.snapshot.investigation;
  if (
    !command ||
    command.appliedCaseVersion !== application.resultingCaseVersion ||
    command.payloadJson !== internalCommandPayload(application) ||
    source.snapshot.productId !== question.subjectRef ||
    !sourceInvestigation ||
    sourceInvestigation.identity.knowledgeStatus !== 'KNOWN' ||
    sourceInvestigation.identity.conclusion !== 'MATCH' ||
    sourceInvestigation.scope.kind !== 'UNRESOLVED' ||
    sourceInvestigation.scope.knowledgeStatus === 'CONFLICTED' ||
    sourceInvestigation.knowledgeStatus === 'CONFLICTED' ||
    sourceQuestionIssues.length !== 1 ||
    sourceInvestigation.gaps.length !== 1 ||
    sourceInvestigation.conflicts.length !== 0 ||
    result.snapshot.productId !== question.subjectRef ||
    !resultInvestigation ||
    resultInvestigation.knowledgeStatus !== 'KNOWN' ||
    resultInvestigation.scope.kind !== 'BATCH_LOT' ||
    resultInvestigation.scope.knowledgeStatus !== 'KNOWN' ||
    resultInvestigation.scope.lots.length !== 1 ||
    resultInvestigation.scope.lots[0] !== application.appliedLot ||
    JSON.stringify(resultInvestigation.identity) !== JSON.stringify(sourceInvestigation.identity) ||
    !sameReferences(resultInvestigation.scope.evidenceRefs, application.appliedEvidenceRefs) ||
    !sameReferences(resultInvestigation.scope.decisionRefs, [application.applicationRef]) ||
    !resultInvestigation.decisionRefs.includes(application.applicationRef) ||
    resultInvestigation.gaps.some((issue) => issue.id === application.questionRef) ||
    resultInvestigation.conflicts.length !== 0
  ) {
    throw new InvestigationEstablishedBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored established batch execution or authoritative result is inconsistent.'
    );
  }
  return result.snapshot;
}

function deriveEstablishedBatchOutcome(
  current: CaseSnapshot,
  applicationRef: string,
  questionRef: string,
  appliedEvidenceRefs: readonly string[],
  appliedLot: string,
  updatedAt: string
): InvestigationOutcome {
  const investigation = current.investigation;
  if (
    !investigation ||
    current.materialRevision === null ||
    investigation.materialRevision !== current.materialRevision ||
    investigation.identity.knowledgeStatus !== 'KNOWN' ||
    investigation.identity.conclusion !== 'MATCH' ||
    investigation.scope.kind !== 'UNRESOLVED' ||
    investigation.scope.knowledgeStatus === 'CONFLICTED' ||
    investigation.knowledgeStatus === 'CONFLICTED' ||
    appliedLot.length === 0
  ) {
    throw new InvestigationEstablishedBatchApplicationError(
      'APPLICATION_NOT_ELIGIBLE',
      'The current authoritative outcome is not an eligible open batch gap.'
    );
  }
  const targetGaps = investigation.gaps.filter((issue) =>
    issue.id === questionRef &&
    issue.code === 'BATCH_MISSING' &&
    issue.subjectRefs.length === 1 &&
    issue.subjectRefs[0] === current.productId
  );
  if (
    targetGaps.length !== 1 ||
    investigation.gaps.length !== 1 ||
    investigation.conflicts.length !== 0
  ) {
    throw new InvestigationEstablishedBatchApplicationError(
      'APPLICATION_NOT_ELIGIBLE',
      'Authoritative uncertainty outside the exact batch gap prevents a KNOWN outcome.'
    );
  }

  const appliedEvidence = canonicalReferences(appliedEvidenceRefs);
  const evidenceRefs = canonicalReferences([
    ...investigation.evidenceRefs,
    ...investigation.identity.evidenceRefs,
    ...appliedEvidence
  ]);
  const decisionRefs = canonicalReferences([
    ...investigation.decisionRefs,
    ...investigation.identity.decisionRefs,
    applicationRef
  ]);
  return investigationOutcomeSchema.parse({
    ...investigation,
    materialRevision: current.materialRevision + 1,
    updatedAt,
    knowledgeStatus: 'KNOWN',
    identity: structuredClone(investigation.identity),
    scope: {
      kind: 'BATCH_LOT',
      lots: [appliedLot],
      knowledgeStatus: 'KNOWN',
      evidenceRefs: appliedEvidence,
      decisionRefs: [applicationRef]
    },
    evidenceRefs,
    decisionRefs,
    gaps: [],
    conflicts: [],
    demo: true
  });
}

export function getInvestigationEstablishedBatchApplication(
  database: RecallDatabase,
  caseId: string,
  applicationRef: string
): InvestigationEstablishedBatchApplication | null {
  const row = database.select().from(schema.investigationEstablishedBatchApplications)
    .where(and(
      eq(schema.investigationEstablishedBatchApplications.caseId, caseId),
      eq(schema.investigationEstablishedBatchApplications.applicationRef, applicationRef)
    )).get();
  if (!row) return null;
  const application = hydrateApplication(row);
  validateApplicationProvenance(database, application);
  return application;
}

export function applyInvestigationEstablishedBatch(
  database: RecallDatabase,
  input: unknown,
  context: LifecycleContext,
  now = new Date()
): ApplyInvestigationEstablishedBatchResult {
  if (context.mode !== 'demo') {
    throw new InvestigationEstablishedBatchApplicationError(
      'FORBIDDEN',
      'Established batch application requires explicit local demo mode.'
    );
  }
  const parsed = parseInput(input);

  return database.transaction((transaction) => {
    const existing = transaction.select()
      .from(schema.investigationEstablishedBatchApplications)
      .where(eq(
        schema.investigationEstablishedBatchApplications.applicationRef,
        parsed.applicationRef
      )).get();
    if (existing) {
      if (!immutableSemanticsMatch(existing, parsed)) {
        throw new InvestigationEstablishedBatchApplicationError(
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

    const establishmentApplication = transaction.select({
      applicationRef: schema.investigationEstablishedBatchApplications.applicationRef
    }).from(schema.investigationEstablishedBatchApplications).where(eq(
      schema.investigationEstablishedBatchApplications.establishmentRef,
      parsed.establishmentRef
    )).get();
    if (establishmentApplication) {
      throw new InvestigationEstablishedBatchApplicationError(
        'ESTABLISHMENT_ALREADY_APPLIED',
        'This investigation Establishment already produced an authoritative batch application.'
      );
    }
    const commandCollision = transaction.select({ id: schema.caseCommands.id })
      .from(schema.caseCommands)
      .where(eq(schema.caseCommands.commandId, parsed.applicationRef))
      .get();
    if (commandCollision) {
      throw new InvestigationEstablishedBatchApplicationError(
        'COMMAND_ID_CONFLICT',
        'The application reference is already used by an unrelated lifecycle command.'
      );
    }

    const current = readCaseSnapshot(transaction, parsed.caseId);
    if (!current?.investigation) {
      throw new InvestigationEstablishedBatchApplicationError(
        'VERSIONED_CASE_REQUIRED',
        'The owning case does not have a versioned InvestigationOutcome.'
      );
    }
    if (current.caseVersion !== parsed.expectedCaseVersion) {
      throw new InvestigationEstablishedBatchApplicationError(
        'STALE_CASE_VERSION',
        'Refresh the case before applying its established batch.'
      );
    }
    if (current.materialRevision !== parsed.expectedMaterialRevision) {
      throw new InvestigationEstablishedBatchApplicationError(
        'STALE_MATERIAL_REVISION',
        'Refresh the authoritative material investigation before applying its batch.'
      );
    }
    if (current.materialRevision === null) {
      throw new InvestigationEstablishedBatchApplicationError(
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
      sourceRevision.materialRevision !== current.materialRevision ||
      JSON.stringify(sourceRevision.snapshot) !== JSON.stringify(current)
    ) {
      throw new InvestigationEstablishedBatchApplicationError(
        'SOURCE_REVISION_UNRESOLVED',
        'The exact current authoritative source revision cannot be resolved.'
      );
    }

    let basis;
    try {
      basis = readEstablishedBatchApplicationBasisInTransaction(
        transaction,
        parsed.caseId,
        parsed.questionRef,
        parsed.establishmentRef
      );
    } catch (error) {
      if (
        error instanceof EstablishedBatchApplicationBasisError &&
        error.code === 'ESTABLISHMENT_NOT_FOUND'
      ) {
        throw new InvestigationEstablishedBatchApplicationError(
          'ESTABLISHMENT_NOT_FOUND',
          'The requested investigation Establishment does not exist for this case.'
        );
      }
      if (error instanceof EstablishedBatchApplicationBasisError) {
        throw new InvestigationEstablishedBatchApplicationError(
          'APPLICATION_NOT_ELIGIBLE',
          error.message
        );
      }
      throw error;
    }
    if (basis.applicationBasisDigest !== parsed.expectedApplicationBasisDigest) {
      throw new InvestigationEstablishedBatchApplicationError(
        'STALE_APPLICATION_BASIS',
        'The reviewed established batch basis has changed; refresh and review it again.'
      );
    }
    if (!basis.eligibility.eligible || !basis.targetClaim) {
      throw new InvestigationEstablishedBatchApplicationError(
        'APPLICATION_NOT_ELIGIBLE',
        'The current Establishment does not satisfy authoritative batch application policy.'
      );
    }

    const question = getInvestigationQuestion(transaction, parsed.caseId, parsed.questionRef);
    const caseRecord = transaction.select().from(schema.cases)
      .where(eq(schema.cases.id, parsed.caseId)).get();
    if (!question || question.subjectRef !== current.productId || !caseRecord) {
      throw new InvestigationEstablishedBatchApplicationError(
        'APPLICATION_PROVENANCE_INVALID',
        'The application case, Question, or product ownership is inconsistent.'
      );
    }

    const appliedEvidenceRefs = canonicalReferences(
      basis.currentEvaluation.basis?.evidenceRefs ?? []
    );
    const reviewedBasis = basis.currentEvaluation.basis;
    if (!reviewedBasis) {
      throw new InvestigationEstablishedBatchApplicationError(
        'APPLICATION_NOT_ELIGIBLE',
        'The qualifying Establishment has no current reviewed basis.'
      );
    }
    const appliedLot = basis.targetClaim.normalizedLot;
    const updatedAt = now.toISOString();
    const outcome = deriveEstablishedBatchOutcome(
      current,
      parsed.applicationRef,
      parsed.questionRef,
      appliedEvidenceRefs,
      appliedLot,
      updatedAt
    );
    const applicationCommand = {
      applicationRef: parsed.applicationRef,
      caseId: parsed.caseId,
      questionRef: parsed.questionRef,
      establishmentRef: parsed.establishmentRef,
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
        : 'investigation_established_batch_applied',
      eventSummary: current.stage === 'CLOSED'
        ? 'Reopened the case after applying a reviewed established batch.'
        : 'Applied a reviewed investigation Establishment as authoritative batch scope.',
      eventMetadata: {
        applicationRef: parsed.applicationRef,
        establishmentRef: parsed.establishmentRef,
        questionRef: parsed.questionRef,
        claimRef: basis.claimRef,
        applicationPolicyIdentifier: basis.applicationPolicyIdentifier,
        applicationPolicyVersion: basis.applicationPolicyVersion,
        basisFormatVersion: basis.basisFormatVersion,
        basisDigest: basis.applicationBasisDigest,
        appliedLot,
        sourceRevisionId: sourceRevision.revisionId,
        sourceCaseVersion: current.caseVersion,
        sourceMaterialRevision: current.materialRevision
      },
      includeTransitionAuditMetadata: true
    });

    transaction.insert(schema.investigationEstablishedBatchApplications).values({
      applicationRef: parsed.applicationRef,
      caseId: parsed.caseId,
      questionRef: parsed.questionRef,
      establishmentRef: parsed.establishmentRef,
      claimRef: basis.claimRef,
      applicationPolicyIdentifier: basis.applicationPolicyIdentifier,
      applicationPolicyVersion: basis.applicationPolicyVersion,
      basisFormatVersion: basis.basisFormatVersion,
      basisDigest: basis.applicationBasisDigest,
      reviewedClaimRefsJson: JSON.stringify(canonicalReferences(reviewedBasis.claimRefs)),
      reviewedAssessmentRefsJson: JSON.stringify(
        canonicalReferences(reviewedBasis.assessmentRefs)
      ),
      reviewedEvidenceRefsJson: JSON.stringify(
        canonicalReferences(reviewedBasis.evidenceRefs)
      ),
      appliedEvidenceRefsJson: JSON.stringify(appliedEvidenceRefs),
      appliedLot,
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

    const stored = getInvestigationEstablishedBatchApplication(
      transaction,
      parsed.caseId,
      parsed.applicationRef
    );
    if (!stored) {
      throw new InvestigationEstablishedBatchApplicationError(
        'APPLICATION_PROVENANCE_INVALID',
        'The stored established batch application could not be reloaded.'
      );
    }
    return { application: stored, replayed: false, snapshot: transition.snapshot };
  }, { behavior: 'immediate' });
}
