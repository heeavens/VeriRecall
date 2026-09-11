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
import { getInvestigationAssessment } from './assessments';
import {
  getInvestigationAssessmentChallengeRef,
  getInvestigationClaimChallengeRef,
  getInvestigationEstablishmentChallengeRef
} from './challenge-artifacts';
import {
  challengeBatchApplicationBasisFormatVersion,
  challengeBatchApplicationPolicy,
  ChallengeBatchApplicationBasisError,
  readChallengeBatchApplicationBasisInTransaction
} from './challenge-batch-application-basis';
import {
  classifyChallengeBatchEstablishmentAssessments,
  demoChallengeBatchEstablishmentPolicy,
  getInvestigationChallengeBatchEstablishment
} from './challenge-batch-establishments';
import { getInvestigationChallenge } from './challenges';
import { getInvestigationClaim } from './claims';
import { demoHumanAssessorIdentifier } from './demo-context';
import { getInvestigationEvidence } from './evidence-registry';
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

const applyInvestigationChallengeBatchInputSchema = z.strictObject({
  applicationRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  challengeRef: z.string().uuid(),
  establishmentRef: z.string().uuid(),
  expectedCaseVersion: z.number().int().positive(),
  expectedMaterialRevision: z.number().int().positive(),
  expectedApplicationBasisDigest: digestSchema,
  rationale: rationaleSchema,
  demo: z.literal(true)
});

const investigationChallengeBatchApplicationSchema = z.strictObject({
  applicationRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  challengeRef: z.string().uuid(),
  establishmentRef: z.string().uuid(),
  claimRef: z.string().uuid(),
  applicationPolicyIdentifier: z.literal(challengeBatchApplicationPolicy.identifier),
  applicationPolicyVersion: z.literal(challengeBatchApplicationPolicy.version),
  basisFormatVersion: z.literal(challengeBatchApplicationBasisFormatVersion),
  basisDigest: digestSchema,
  reviewedClaimRefs: canonicalReferenceArraySchema,
  reviewedAssessmentRefs: canonicalReferenceArraySchema,
  reviewedEvidenceRefs: canonicalReferenceArraySchema,
  appliedAssessmentRefs: canonicalReferenceArraySchema,
  appliedEvidenceRefs: canonicalReferenceArraySchema,
  appliedLot: opaqueReferenceSchema,
  resultBaselineClaimRefs: canonicalReferenceArraySchema,
  resultBaselineAssessmentRefs: canonicalReferenceArraySchema,
  resultBaselineEvidenceRefs: canonicalReferenceArraySchema,
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
    validation.addIssue({ code: 'custom', path: ['resultingCaseVersion'], message: 'Expected exact +1 case version.' });
  }
  if (value.resultingMaterialRevision !== value.sourceMaterialRevision + 1) {
    validation.addIssue({ code: 'custom', path: ['resultingMaterialRevision'], message: 'Expected exact +1 material revision.' });
  }
});

export type ApplyInvestigationChallengeBatchInput = z.infer<
  typeof applyInvestigationChallengeBatchInputSchema
>;
export type InvestigationChallengeBatchApplication = z.infer<
  typeof investigationChallengeBatchApplicationSchema
>;

export type InvestigationChallengeBatchApplicationErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'APPLICATION_NOT_FOUND'
  | 'APPLICATION_CONFLICT'
  | 'CHALLENGE_ALREADY_APPLIED'
  | 'ESTABLISHMENT_ALREADY_APPLIED'
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

export class InvestigationChallengeBatchApplicationError extends Error {
  constructor(
    public readonly code: InvestigationChallengeBatchApplicationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvestigationChallengeBatchApplicationError';
  }
}

export interface ApplyInvestigationChallengeBatchResult {
  application: InvestigationChallengeBatchApplication;
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

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseInput(input: unknown): ApplyInvestigationChallengeBatchInput {
  const parsed = applyInvestigationChallengeBatchInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationChallengeBatchApplicationError(
      'INVALID_INPUT',
      'Invalid Challenge batch application request.'
    );
  }
  return parsed.data;
}

function hydrateApplication(
  row: typeof schema.investigationChallengeBatchApplications.$inferSelect
): InvestigationChallengeBatchApplication {
  try {
    return investigationChallengeBatchApplicationSchema.parse({
      applicationRef: row.applicationRef,
      caseId: row.caseId,
      questionRef: row.questionRef,
      challengeRef: row.challengeRef,
      establishmentRef: row.establishmentRef,
      claimRef: row.claimRef,
      applicationPolicyIdentifier: row.applicationPolicyIdentifier,
      applicationPolicyVersion: row.applicationPolicyVersion,
      basisFormatVersion: row.basisFormatVersion,
      basisDigest: row.basisDigest,
      reviewedClaimRefs: JSON.parse(row.reviewedClaimRefsJson),
      reviewedAssessmentRefs: JSON.parse(row.reviewedAssessmentRefsJson),
      reviewedEvidenceRefs: JSON.parse(row.reviewedEvidenceRefsJson),
      appliedAssessmentRefs: JSON.parse(row.appliedAssessmentRefsJson),
      appliedEvidenceRefs: JSON.parse(row.appliedEvidenceRefsJson),
      appliedLot: row.appliedLot,
      resultBaselineClaimRefs: JSON.parse(row.resultBaselineClaimRefsJson),
      resultBaselineAssessmentRefs: JSON.parse(row.resultBaselineAssessmentRefsJson),
      resultBaselineEvidenceRefs: JSON.parse(row.resultBaselineEvidenceRefsJson),
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
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge batch application provenance is malformed.'
    );
  }
}

function immutableSemanticsMatch(
  row: typeof schema.investigationChallengeBatchApplications.$inferSelect,
  input: ApplyInvestigationChallengeBatchInput
): boolean {
  return row.applicationRef === input.applicationRef &&
    row.caseId === input.caseId &&
    row.questionRef === input.questionRef &&
    row.challengeRef === input.challengeRef &&
    row.establishmentRef === input.establishmentRef &&
    row.rationale === input.rationale &&
    row.demo === input.demo;
}

function internalCommandPayload(
  application: Pick<
    InvestigationChallengeBatchApplication,
    | 'applicationRef'
    | 'caseId'
    | 'questionRef'
    | 'challengeRef'
    | 'establishmentRef'
    | 'basisDigest'
    | 'sourceCaseVersion'
    | 'sourceMaterialRevision'
  >
): string {
  return JSON.stringify({
    operation: 'APPLY_INVESTIGATION_CHALLENGE_BATCH',
    applicationRef: application.applicationRef,
    caseId: application.caseId,
    questionRef: application.questionRef,
    challengeRef: application.challengeRef,
    establishmentRef: application.establishmentRef,
    applicationBasisDigest: application.basisDigest,
    sourceCaseVersion: application.sourceCaseVersion,
    sourceMaterialRevision: application.sourceMaterialRevision
  });
}

function readRevision(
  database: RecallDatabase,
  application: InvestigationChallengeBatchApplication,
  kind: 'source' | 'result'
): StoredCaseRevision {
  const revisionId = kind === 'source' ? application.sourceRevisionId : application.resultingRevisionId;
  let revision: StoredCaseRevision | null;
  try {
    revision = readCaseRevisionById(database, application.caseId, revisionId);
  } catch {
    revision = null;
  }
  if (!revision) {
    throw new InvestigationChallengeBatchApplicationError(
      kind === 'source' ? 'SOURCE_REVISION_UNRESOLVED' : 'RESULT_REVISION_UNRESOLVED',
      `The exact ${kind} authoritative case revision cannot be resolved.`
    );
  }
  const caseVersion = kind === 'source'
    ? application.sourceCaseVersion
    : application.resultingCaseVersion;
  const materialRevision = kind === 'source'
    ? application.sourceMaterialRevision
    : application.resultingMaterialRevision;
  if (revision.caseVersion !== caseVersion || revision.materialRevision !== materialRevision) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      `Stored Challenge batch ${kind} revision lineage is inconsistent.`
    );
  }
  return revision;
}

function assertReferencedArtifacts(
  database: RecallDatabase,
  application: InvestigationChallengeBatchApplication
): void {
  for (const claimRef of application.reviewedClaimRefs) {
    const claim = getInvestigationClaim(database, application.caseId, claimRef);
    if (!claim || claim.questionRef !== application.questionRef) {
      throw new InvestigationChallengeBatchApplicationError(
        'APPLICATION_PROVENANCE_INVALID',
        'A reviewed Challenge Claim is missing or has invalid ownership.'
      );
    }
  }
  for (const assessmentRef of application.reviewedAssessmentRefs) {
    const assessment = getInvestigationAssessment(database, application.caseId, assessmentRef);
    if (!assessment || assessment.questionRef !== application.questionRef) {
      throw new InvestigationChallengeBatchApplicationError(
        'APPLICATION_PROVENANCE_INVALID',
        'A reviewed Challenge Assessment is missing or has invalid ownership.'
      );
    }
  }
  for (const evidenceRef of application.reviewedEvidenceRefs) {
    const evidence = getInvestigationEvidence(database, application.caseId, evidenceRef);
    if (!evidence || evidence.questionRef !== application.questionRef) {
      throw new InvestigationChallengeBatchApplicationError(
        'APPLICATION_PROVENANCE_INVALID',
        'Reviewed Challenge Evidence is missing or has invalid ownership.'
      );
    }
  }
}

function validateApplicationProvenance(
  database: RecallDatabase,
  application: InvestigationChallengeBatchApplication
): CaseSnapshot {
  const question = getInvestigationQuestion(database, application.caseId, application.questionRef);
  const challenge = getInvestigationChallenge(database, application.caseId, application.challengeRef);
  const establishment = getInvestigationChallengeBatchEstablishment(
    database,
    application.caseId,
    application.establishmentRef
  );
  const claim = getInvestigationClaim(database, application.caseId, application.claimRef);
  const claimChallengeRef = claim
    ? getInvestigationClaimChallengeRef(database, claim.claimRef)
    : null;
  const establishmentChallengeRef = getInvestigationEstablishmentChallengeRef(
    database,
    application.establishmentRef
  );
  if (
    !question || !challenge || !establishment || !claim ||
    question.questionType !== 'AFFECTED_BATCH_LOT' ||
    question.subjectRef !== claim.subjectRef ||
    challenge.questionRef !== application.questionRef ||
    establishment.questionRef !== application.questionRef ||
    establishment.claimRef !== application.claimRef ||
    establishmentChallengeRef !== application.challengeRef ||
    claimChallengeRef !== application.challengeRef ||
    establishment.policyIdentifier !== demoChallengeBatchEstablishmentPolicy.policyIdentifier ||
    establishment.policyVersion !== demoChallengeBatchEstablishmentPolicy.policyVersion ||
    establishment.evaluatorKind !== demoChallengeBatchEstablishmentPolicy.evaluatorKind ||
    establishment.evaluatorIdentifier !== demoChallengeBatchEstablishmentPolicy.evaluatorIdentifier ||
    normalizeBatch(claim.value.lot) !== application.appliedLot ||
    !sameReferences(establishment.basisClaimRefs, application.reviewedClaimRefs) ||
    !sameReferences(establishment.basisAssessmentRefs, application.reviewedAssessmentRefs) ||
    !sameReferences(establishment.basisEvidenceRefs, application.reviewedEvidenceRefs) ||
    !sameReferences(application.appliedEvidenceRefs, application.reviewedEvidenceRefs) ||
    !sameReferences(application.resultBaselineEvidenceRefs, application.reviewedEvidenceRefs) ||
    !sameReferences(application.resultBaselineClaimRefs, [application.claimRef]) ||
    !application.reviewedClaimRefs.includes(application.claimRef)
  ) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge, Establishment, Claim, or Evidence provenance is inconsistent.'
    );
  }

  assertReferencedArtifacts(database, application);
  const reviewedClaims = application.reviewedClaimRefs.map((claimRef) =>
    getInvestigationClaim(database, application.caseId, claimRef)
  );
  const reviewedAssessments = application.reviewedAssessmentRefs.map((assessmentRef) =>
    getInvestigationAssessment(database, application.caseId, assessmentRef)
  );
  if (
    reviewedClaims.some((item) => !item || item.claimType !== 'AFFECTED_BATCH_LOT' ||
      ![null, application.challengeRef].includes(
        getInvestigationClaimChallengeRef(database, item.claimRef)
      )) ||
    reviewedAssessments.some((item) => !item)
  ) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Reviewed Challenge artifact ownership is inconsistent.'
    );
  }
  const assessmentIsCurrentAtSource = (basisCaseVersion: number): boolean => {
    try {
      return readCaseRevisionByCaseVersion(
        database,
        application.caseId,
        basisCaseVersion
      )?.materialRevision === application.sourceMaterialRevision;
    } catch {
      return false;
    }
  };
  const validReviewedClaims = reviewedClaims.filter(
    (item): item is NonNullable<typeof item> => item !== null
  );
  const validReviewedAssessments = reviewedAssessments.filter(
    (item): item is NonNullable<typeof item> => item !== null
  );
  const classification = classifyChallengeBatchEstablishmentAssessments({
    activeClaims: validReviewedClaims,
    structuralAssessmentHeads: validReviewedAssessments,
    materiallyCurrentAssessmentRefs: new Set(validReviewedAssessments.filter((item) =>
      assessmentIsCurrentAtSource(item.basisCaseVersion) &&
      [
        ...(item.targetClaimRef === null ? [] : [item.targetClaimRef]),
        ...item.relatedClaimRefs
      ].every((claimRef) => application.reviewedClaimRefs.includes(claimRef))
    ).map((item) => item.assessmentRef)),
    assessmentChallengeRefs: new Map(validReviewedAssessments.map((item) => [
      item.assessmentRef,
      getInvestigationAssessmentChallengeRef(database, item.assessmentRef)
    ])),
    challengeRef: application.challengeRef,
    targetClaimRef: application.claimRef,
    targetLot: application.appliedLot,
    completeEvidenceRefs: application.reviewedEvidenceRefs
  });
  if (
    classification.divergentClaimRefsWithoutTrustedRejection.length > 0 ||
    classification.qualifyingTargetSupportAssessmentRefs.length === 0 ||
    !sameReferences(
      application.resultBaselineAssessmentRefs,
      classification.qualifyingTargetSupportAssessmentRefs
    ) ||
    !sameReferences(
      application.appliedAssessmentRefs,
      [
        ...classification.qualifyingTargetSupportAssessmentRefs,
        ...classification.reliedUponRejectionAssessmentRefs
      ]
    )
  ) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Applied and result-baseline Assessment provenance does not match the 16A policy.'
    );
  }

  const conflict = database.select({
    applicationRef: schema.investigationChallengeConflictApplications.applicationRef
  }).from(schema.investigationChallengeConflictApplications).where(eq(
    schema.investigationChallengeConflictApplications.challengeRef,
    application.challengeRef
  )).get();
  if (conflict) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Positive and conflict applications coexist for one Challenge.'
    );
  }

  const source = readRevision(database, application, 'source');
  const result = readRevision(database, application, 'result');
  let challenged: StoredCaseRevision | null;
  try {
    challenged = readCaseRevisionById(
      database,
      application.caseId,
      challenge.challengedRevisionId
    );
  } catch {
    challenged = null;
  }
  const command = database.select().from(schema.caseCommands).where(and(
    eq(schema.caseCommands.caseId, application.caseId),
    eq(schema.caseCommands.commandId, application.applicationRef)
  )).get();
  const sourceInvestigation = source.snapshot.investigation;
  const resultInvestigation = result.snapshot.investigation;
  if (
    !challenged || !command || !sourceInvestigation || !resultInvestigation ||
    source.snapshot.productId !== question.subjectRef ||
    result.snapshot.productId !== question.subjectRef ||
    challenge.challengedMaterialRevision !== application.sourceMaterialRevision ||
    establishment.basisMaterialRevision !== application.sourceMaterialRevision ||
    challenged.materialRevision !== application.sourceMaterialRevision ||
    !sameValue(challenged.snapshot.investigation, sourceInvestigation) ||
    command.appliedCaseVersion !== application.resultingCaseVersion ||
    command.payloadJson !== internalCommandPayload(application) ||
    sourceInvestigation.knowledgeStatus !== 'KNOWN' ||
    sourceInvestigation.identity.knowledgeStatus !== 'KNOWN' ||
    sourceInvestigation.identity.conclusion !== 'MATCH' ||
    sourceInvestigation.scope.kind !== 'BATCH_LOT' ||
    sourceInvestigation.scope.knowledgeStatus !== 'KNOWN' ||
    sourceInvestigation.scope.lots.length !== 1 ||
    normalizeBatch(sourceInvestigation.scope.lots[0]).length === 0 ||
    sourceInvestigation.gaps.length !== 0 || sourceInvestigation.conflicts.length !== 0 ||
    resultInvestigation.knowledgeStatus !== 'KNOWN' ||
    resultInvestigation.scope.kind !== 'BATCH_LOT' ||
    resultInvestigation.scope.knowledgeStatus !== 'KNOWN' ||
    resultInvestigation.scope.lots.length !== 1 ||
    resultInvestigation.scope.lots[0] !== application.appliedLot ||
    !sameValue(resultInvestigation.identity, sourceInvestigation.identity) ||
    !sameReferences(resultInvestigation.scope.evidenceRefs, application.appliedEvidenceRefs) ||
    !sameReferences(resultInvestigation.scope.decisionRefs, [application.applicationRef]) ||
    !sameReferences(resultInvestigation.evidenceRefs, canonicalReferences([
      ...sourceInvestigation.evidenceRefs,
      ...sourceInvestigation.identity.evidenceRefs,
      ...application.appliedEvidenceRefs
    ])) ||
    !sameReferences(resultInvestigation.decisionRefs, canonicalReferences([
      ...sourceInvestigation.decisionRefs,
      ...sourceInvestigation.identity.decisionRefs,
      application.applicationRef
    ])) ||
    !resultInvestigation.decisionRefs.includes(application.applicationRef) ||
    resultInvestigation.gaps.length !== 0 || resultInvestigation.conflicts.length !== 0
  ) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge batch execution or authoritative result is inconsistent.'
    );
  }
  return result.snapshot;
}

function deriveChallengeBatchOutcome(
  current: CaseSnapshot,
  applicationRef: string,
  appliedEvidenceRefs: readonly string[],
  appliedLot: string,
  updatedAt: string
): InvestigationOutcome {
  const investigation = current.investigation;
  if (
    !investigation || current.materialRevision === null ||
    investigation.materialRevision !== current.materialRevision ||
    investigation.knowledgeStatus !== 'KNOWN' ||
    investigation.identity.knowledgeStatus !== 'KNOWN' ||
    investigation.identity.conclusion !== 'MATCH' ||
    investigation.scope.kind !== 'BATCH_LOT' ||
    investigation.scope.knowledgeStatus !== 'KNOWN' ||
    investigation.scope.lots.length !== 1 ||
    investigation.gaps.length !== 0 || investigation.conflicts.length !== 0 ||
    !investigation.demo || appliedLot.length === 0
  ) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_NOT_ELIGIBLE',
      'The authoritative source is not a clean known-batch state.'
    );
  }
  const appliedEvidence = canonicalReferences(appliedEvidenceRefs);
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
    evidenceRefs: canonicalReferences([
      ...investigation.evidenceRefs,
      ...investigation.identity.evidenceRefs,
      ...appliedEvidence
    ]),
    decisionRefs: canonicalReferences([
      ...investigation.decisionRefs,
      ...investigation.identity.decisionRefs,
      applicationRef
    ]),
    gaps: [],
    conflicts: [],
    demo: true
  });
}

export function getInvestigationChallengeBatchApplication(
  database: RecallDatabase,
  caseId: string,
  applicationRef: string
): InvestigationChallengeBatchApplication | null {
  const row = database.select().from(schema.investigationChallengeBatchApplications).where(and(
    eq(schema.investigationChallengeBatchApplications.caseId, caseId),
    eq(schema.investigationChallengeBatchApplications.applicationRef, applicationRef)
  )).get();
  if (!row) return null;
  const application = hydrateApplication(row);
  validateApplicationProvenance(database, application);
  return application;
}

export function applyInvestigationChallengeBatch(
  database: RecallDatabase,
  input: unknown,
  context: LifecycleContext,
  now = new Date()
): ApplyInvestigationChallengeBatchResult {
  if (context.mode !== 'demo') {
    throw new InvestigationChallengeBatchApplicationError(
      'FORBIDDEN',
      'Challenge batch application requires explicit local demo mode.'
    );
  }
  const parsed = parseInput(input);
  return database.transaction((transaction) => {
    const existing = transaction.select().from(schema.investigationChallengeBatchApplications)
      .where(eq(schema.investigationChallengeBatchApplications.applicationRef, parsed.applicationRef))
      .get();
    if (existing) {
      if (!immutableSemanticsMatch(existing, parsed)) {
        throw new InvestigationChallengeBatchApplicationError(
          'APPLICATION_CONFLICT',
          'This application reference already identifies different immutable semantics.'
        );
      }
      const application = hydrateApplication(existing);
      return { application, replayed: true, snapshot: validateApplicationProvenance(transaction, application) };
    }

    const challengeApplication = transaction.select({
      applicationRef: schema.investigationChallengeBatchApplications.applicationRef
    }).from(schema.investigationChallengeBatchApplications).where(eq(
      schema.investigationChallengeBatchApplications.challengeRef,
      parsed.challengeRef
    )).get();
    if (challengeApplication) {
      throw new InvestigationChallengeBatchApplicationError(
        'CHALLENGE_ALREADY_APPLIED',
        'This Challenge already produced a positive authoritative application.'
      );
    }
    const establishmentApplication = transaction.select({
      applicationRef: schema.investigationChallengeBatchApplications.applicationRef
    }).from(schema.investigationChallengeBatchApplications).where(eq(
      schema.investigationChallengeBatchApplications.establishmentRef,
      parsed.establishmentRef
    )).get();
    if (establishmentApplication) {
      throw new InvestigationChallengeBatchApplicationError(
        'ESTABLISHMENT_ALREADY_APPLIED',
        'This Challenge Establishment already produced an authoritative application.'
      );
    }
    const conflictApplication = transaction.select({
      applicationRef: schema.investigationChallengeConflictApplications.applicationRef
    }).from(schema.investigationChallengeConflictApplications).where(eq(
      schema.investigationChallengeConflictApplications.challengeRef,
      parsed.challengeRef
    )).get();
    if (conflictApplication) {
      throw new InvestigationChallengeBatchApplicationError(
        'CHALLENGE_RESOLUTION_CONFLICT',
        'This Challenge already has an authoritative conflict application.'
      );
    }
    const commandCollision = transaction.select({ id: schema.caseCommands.id })
      .from(schema.caseCommands).where(eq(schema.caseCommands.commandId, parsed.applicationRef)).get();
    if (commandCollision) {
      throw new InvestigationChallengeBatchApplicationError(
        'COMMAND_ID_CONFLICT',
        'The application reference is already used by an unrelated lifecycle command.'
      );
    }

    const current = readCaseSnapshot(transaction, parsed.caseId);
    if (!current || current.materialRevision === null) {
      throw new InvestigationChallengeBatchApplicationError(
        'VERSIONED_CASE_REQUIRED',
        'The owning case does not have a versioned investigation lifecycle.'
      );
    }
    if (current.caseVersion !== parsed.expectedCaseVersion) {
      throw new InvestigationChallengeBatchApplicationError(
        'STALE_CASE_VERSION',
        'Refresh the case before applying its Challenge batch resolution.'
      );
    }
    if (current.materialRevision !== parsed.expectedMaterialRevision) {
      throw new InvestigationChallengeBatchApplicationError(
        'STALE_MATERIAL_REVISION',
        'Refresh the material answer before applying its Challenge batch resolution.'
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
      !sourceRevision || sourceRevision.materialRevision !== current.materialRevision ||
      !sameValue(sourceRevision.snapshot, current)
    ) {
      throw new InvestigationChallengeBatchApplicationError(
        'SOURCE_REVISION_UNRESOLVED',
        'The exact current authoritative source revision cannot be resolved.'
      );
    }

    let basis: ReturnType<typeof readChallengeBatchApplicationBasisInTransaction>;
    try {
      basis = readChallengeBatchApplicationBasisInTransaction(
        transaction,
        parsed.caseId,
        parsed.questionRef,
        parsed.challengeRef,
        parsed.establishmentRef
      );
    } catch (error) {
      if (error instanceof ChallengeBatchApplicationBasisError) {
        throw new InvestigationChallengeBatchApplicationError(
          'APPLICATION_NOT_ELIGIBLE',
          error.message
        );
      }
      throw error;
    }
    if (basis.applicationBasisDigest !== parsed.expectedApplicationBasisDigest) {
      throw new InvestigationChallengeBatchApplicationError(
        'STALE_APPLICATION_BASIS',
        'The reviewed Challenge batch basis has changed; refresh and review it again.'
      );
    }
    if (!basis.eligibility.eligible || !basis.targetClaim || !basis.targetNormalizedLot) {
      throw new InvestigationChallengeBatchApplicationError(
        'APPLICATION_NOT_ELIGIBLE',
        'The current Challenge Establishment is not eligible for positive application.'
      );
    }
    if (
      basis.currentMaterialRevision !== current.materialRevision ||
      basis.currentCaseVersion !== current.caseVersion ||
      basis.challengeAnchor.challengedMaterialRevision !== current.materialRevision ||
      basis.establishment.basisMaterialRevision !== current.materialRevision
    ) {
      throw new InvestigationChallengeBatchApplicationError(
        'APPLICATION_NOT_ELIGIBLE',
        'The Challenge, Establishment, and authoritative source revisions do not agree.'
      );
    }

    const caseRecord = transaction.select().from(schema.cases)
      .where(eq(schema.cases.id, parsed.caseId)).get();
    if (!caseRecord) {
      throw new InvestigationChallengeBatchApplicationError(
        'APPLICATION_PROVENANCE_INVALID',
        'The application case ownership is inconsistent.'
      );
    }
    const updatedAt = now.toISOString();
    const outcome = deriveChallengeBatchOutcome(
      current,
      parsed.applicationRef,
      basis.appliedEvidenceRefs,
      basis.targetNormalizedLot,
      updatedAt
    );
    const command = {
      applicationRef: parsed.applicationRef,
      caseId: parsed.caseId,
      questionRef: parsed.questionRef,
      challengeRef: parsed.challengeRef,
      establishmentRef: parsed.establishmentRef,
      basisDigest: basis.applicationBasisDigest,
      sourceCaseVersion: current.caseVersion,
      sourceMaterialRevision: current.materialRevision
    };
    const transition = applyAuthoritativeInvestigationOutcomeInTransaction(transaction, {
      current,
      outcome,
      alertId: caseRecord.alertId,
      commandId: parsed.applicationRef,
      commandPayloadJson: internalCommandPayload(command),
      updatedAt,
      eventType: current.stage === 'CLOSED'
        ? 'case_reopened'
        : 'investigation_challenge_batch_applied',
      eventSummary: current.stage === 'CLOSED'
        ? 'Reopened the case after applying a reviewed positive Challenge batch resolution.'
        : 'Applied a reviewed Challenge batch Establishment as authoritative known scope.',
      eventMetadata: {
        applicationRef: parsed.applicationRef,
        challengeRef: parsed.challengeRef,
        establishmentRef: parsed.establishmentRef,
        claimRef: basis.claimRef,
        policyIdentifier: basis.applicationPolicyIdentifier,
        policyVersion: basis.applicationPolicyVersion,
        basisFormatVersion: basis.basisFormatVersion,
        basisDigest: basis.applicationBasisDigest,
        appliedLot: basis.targetNormalizedLot,
        resolutionKind: basis.resolutionKind,
        sourceRevisionId: sourceRevision.revisionId,
        sourceCaseVersion: current.caseVersion,
        sourceMaterialRevision: current.materialRevision
      },
      includeTransitionAuditMetadata: true
    });
    if (
      transition.snapshot.caseVersion !== current.caseVersion + 1 ||
      transition.snapshot.materialRevision !== current.materialRevision + 1
    ) {
      throw new InvestigationChallengeBatchApplicationError(
        'APPLICATION_PROVENANCE_INVALID',
        'The lifecycle transition did not produce the required exact +1 versions.'
      );
    }

    transaction.insert(schema.investigationChallengeBatchApplications).values({
      applicationRef: parsed.applicationRef,
      caseId: parsed.caseId,
      questionRef: parsed.questionRef,
      challengeRef: parsed.challengeRef,
      establishmentRef: parsed.establishmentRef,
      claimRef: basis.claimRef,
      applicationPolicyIdentifier: basis.applicationPolicyIdentifier,
      applicationPolicyVersion: basis.applicationPolicyVersion,
      basisFormatVersion: basis.basisFormatVersion,
      basisDigest: basis.applicationBasisDigest,
      reviewedClaimRefsJson: JSON.stringify(basis.reviewedClaimRefs),
      reviewedAssessmentRefsJson: JSON.stringify(basis.reviewedAssessmentRefs),
      reviewedEvidenceRefsJson: JSON.stringify(basis.reviewedEvidenceRefs),
      appliedAssessmentRefsJson: JSON.stringify(basis.appliedAssessmentRefs),
      appliedEvidenceRefsJson: JSON.stringify(basis.appliedEvidenceRefs),
      appliedLot: basis.targetNormalizedLot,
      resultBaselineClaimRefsJson: JSON.stringify(basis.resultBaselineClaimRefs),
      resultBaselineAssessmentRefsJson: JSON.stringify(basis.resultBaselineAssessmentRefs),
      resultBaselineEvidenceRefsJson: JSON.stringify(basis.resultBaselineEvidenceRefs),
      sourceRevisionId: sourceRevision.revisionId,
      sourceCaseVersion: current.caseVersion,
      sourceMaterialRevision: current.materialRevision,
      resultingRevisionId: transition.resultingRevisionId,
      resultingCaseVersion: transition.snapshot.caseVersion,
      resultingMaterialRevision: transition.snapshot.materialRevision,
      actorKind: 'HUMAN',
      actorIdentifier: demoHumanAssessorIdentifier,
      rationale: parsed.rationale,
      createdAt: updatedAt,
      demo: true
    }).run();

    const stored = getInvestigationChallengeBatchApplication(
      transaction,
      parsed.caseId,
      parsed.applicationRef
    );
    if (!stored) {
      throw new InvestigationChallengeBatchApplicationError(
        'APPLICATION_PROVENANCE_INVALID',
        'The stored Challenge batch application could not be reloaded.'
      );
    }
    return { application: stored, replayed: false, snapshot: transition.snapshot };
  }, { behavior: 'immediate' });
}
