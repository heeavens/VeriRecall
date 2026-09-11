import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { CaseSnapshot } from '../../contracts/recall';
import { normalizeBatch } from '../alerts/normalization';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import {
  readCaseRevisionById,
  readCaseRevisionByCaseVersion,
  readCaseRevisionRange,
  type StoredCaseRevision
} from '../workflow/case-lifecycle';
import {
  challengeBatchApplicationBasisFormatVersion,
  challengeBatchApplicationPolicy,
  inheritedChallengeBatchApplicationBasisFormatVersion,
  type ChallengeBatchApplicationBasisFormatVersion
} from './challenge-batch-application-policy';
import {
  classifyChallengeBatchEstablishmentAssessments,
  demoChallengeBatchEstablishmentPolicy,
  demoInheritedChallengeBatchEstablishmentPolicy,
  isSupportedChallengeBatchEstablishmentPolicy
} from './challenge-batch-establishment-policy';
import { demoHumanAssessorIdentifier } from './demo-context';
import type { InvestigationAssessment } from './assessments';
import type { InvestigationClaim } from './claims';

const opaqueReferenceSchema = z.string().min(1).max(500).refine(
  (value) => value.trim().length > 0,
  'References must contain a non-whitespace character.'
);
const canonicalReferenceArraySchema = z.array(opaqueReferenceSchema).min(1).refine(
  (values) => new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1] < value),
  'Reference arrays must be unique and lexically ordered.'
);
const rationaleSchema = z.string().trim().min(1).max(10_000);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const investigationChallengeBatchApplicationSchema = z.strictObject({
  applicationRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  challengeRef: z.string().uuid(),
  establishmentRef: z.string().uuid(),
  claimRef: z.string().uuid(),
  applicationPolicyIdentifier: z.literal(challengeBatchApplicationPolicy.identifier),
  applicationPolicyVersion: z.literal(challengeBatchApplicationPolicy.version),
  basisFormatVersion: z.union([
    z.literal(challengeBatchApplicationBasisFormatVersion),
    z.literal(inheritedChallengeBatchApplicationBasisFormatVersion)
  ]),
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

export interface InitialUnassociatedChallengeBaseline {
  kind: 'INITIAL_UNASSOCIATED';
  challengedRevisionId: string;
  challengedCaseVersion: number;
  challengedMaterialRevision: number;
  questionOriginCaseVersion: number;
  questionOriginMaterialRevision: number;
  baselineClaimRefs: string[];
  baselineAssessmentRefs: string[];
  baselineEvidenceRefs: string[];
}

export interface AppliedChallengeBatchBaseline {
  kind: 'APPLIED_CHALLENGE_BATCH';
  applicationRef: string;
  sourceChallengeRef: string;
  establishmentRef: string;
  claimRef: string;
  appliedLot: string;
  resultingRevisionId: string;
  resultingCaseVersion: number;
  resultingMaterialRevision: number;
  resultBaselineClaimRefs: string[];
  resultBaselineAssessmentRefs: string[];
  resultBaselineEvidenceRefs: string[];
}

export type AuthoritativeChallengeBaseline =
  | InitialUnassociatedChallengeBaseline
  | AppliedChallengeBatchBaseline;

export type AuthoritativeChallengeBaselineErrorCode =
  | 'CHALLENGE_BASELINE_UNPROVEN'
  | 'CHALLENGE_BASELINE_AMBIGUOUS'
  | 'CHALLENGE_BASELINE_PROVENANCE_INVALID';

export class AuthoritativeChallengeBaselineError extends Error {
  constructor(
    public readonly code: AuthoritativeChallengeBaselineErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AuthoritativeChallengeBaselineError';
  }
}

export interface AuthoritativeChallengeAnchor {
  caseId: string;
  questionRef: string;
  challengeRef: string;
  challengedRevisionId: string;
  challengedMaterialRevision: number;
  openedCaseVersion: number;
  currentCaseVersion?: number;
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

function parseCanonicalReferences(value: string): string[] {
  return canonicalReferenceArraySchema.parse(JSON.parse(value));
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

export function challengeBatchApplicationCommandPayload(
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

function readClaim(
  database: RecallDatabase,
  caseId: string,
  claimRef: string
): InvestigationClaim | null {
  const row = database.select().from(schema.investigationClaims).where(and(
    eq(schema.investigationClaims.caseId, caseId),
    eq(schema.investigationClaims.claimRef, claimRef)
  )).get();
  if (!row) return null;
  try {
    const value = z.strictObject({ lot: opaqueReferenceSchema }).parse(JSON.parse(row.valueJson));
    const evidenceRefs = z.array(opaqueReferenceSchema).min(1).refine(
      (refs) => new Set(refs).size === refs.length
    ).parse(JSON.parse(row.evidenceRefsJson));
    return {
      claimRef: row.claimRef,
      caseId: row.caseId,
      questionRef: row.questionRef,
      subjectRef: row.subjectRef,
      claimType: row.claimType,
      value,
      evidenceRefs,
      originKind: row.originKind,
      producerIdentifier: row.producerIdentifier,
      derivationMetadata: row.derivationMetadataJson === null
        ? null
        : z.record(z.string(), z.json()).parse(JSON.parse(row.derivationMetadataJson)),
      supersedesClaimRef: row.supersedesClaimRef,
      createdAt: z.string().datetime().parse(row.createdAt),
      demo: row.demo
    };
  } catch {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge Claim provenance is malformed.'
    );
  }
}

function readAssessment(
  database: RecallDatabase,
  caseId: string,
  assessmentRef: string
): InvestigationAssessment | null {
  const row = database.select().from(schema.investigationAssessments).where(and(
    eq(schema.investigationAssessments.caseId, caseId),
    eq(schema.investigationAssessments.assessmentRef, assessmentRef)
  )).get();
  if (!row) return null;
  try {
    return {
      assessmentRef: row.assessmentRef,
      caseId: row.caseId,
      questionRef: row.questionRef,
      targetClaimRef: row.targetClaimRef,
      verdict: row.verdict,
      evidenceRefs: z.array(opaqueReferenceSchema).min(1).parse(JSON.parse(row.evidenceRefsJson)),
      relatedClaimRefs: z.array(z.string().uuid()).parse(JSON.parse(row.relatedClaimRefsJson)),
      assessorKind: row.assessorKind,
      assessorIdentifier: opaqueReferenceSchema.parse(row.assessorIdentifier),
      ruleIdentifier: row.ruleIdentifier,
      ruleVersion: row.ruleVersion,
      rationale: rationaleSchema.parse(row.rationale),
      basisCaseVersion: z.number().int().positive().parse(row.basisCaseVersion),
      supersedesAssessmentRef: row.supersedesAssessmentRef,
      createdAt: z.string().datetime().parse(row.createdAt),
      demo: row.demo
    };
  } catch {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge Assessment provenance is malformed.'
    );
  }
}

function artifactChallengeRef(
  database: RecallDatabase,
  kind: 'claim' | 'assessment',
  ref: string
): string | null {
  return kind === 'claim'
    ? database.select({ challengeRef: schema.investigationChallengeClaims.challengeRef })
      .from(schema.investigationChallengeClaims)
      .where(eq(schema.investigationChallengeClaims.claimRef, ref)).get()?.challengeRef ?? null
    : database.select({ challengeRef: schema.investigationChallengeAssessments.challengeRef })
      .from(schema.investigationChallengeAssessments)
      .where(eq(schema.investigationChallengeAssessments.assessmentRef, ref)).get()?.challengeRef ?? null;
}

function assertKnownBatchAnswer(snapshot: CaseSnapshot): string {
  const investigation = snapshot.investigation;
  if (
    snapshot.materialRevision === null || !investigation ||
    investigation.materialRevision !== snapshot.materialRevision ||
    investigation.identity.knowledgeStatus !== 'KNOWN' ||
    investigation.identity.conclusion !== 'MATCH' ||
    investigation.scope.kind !== 'BATCH_LOT' ||
    investigation.scope.knowledgeStatus !== 'KNOWN' ||
    investigation.scope.lots.length !== 1
  ) {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_UNPROVEN',
      'The challenged revision is not a clean authoritative known-batch answer.'
    );
  }
  const lot = normalizeBatch(investigation.scope.lots[0]);
  if (lot.length === 0) {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_UNPROVEN',
      'The challenged authoritative lot is empty after canonical normalization.'
    );
  }
  return lot;
}

function assertRevisionContinuity(
  database: RecallDatabase,
  reference: StoredCaseRevision,
  throughCaseVersion: number
): void {
  const rows = readCaseRevisionRange(
    database,
    reference.caseId,
    reference.caseVersion,
    throughCaseVersion
  );
  const expectedCount = throughCaseVersion - reference.caseVersion + 1;
  if (
    rows.length !== expectedCount ||
    rows.some((row, index) =>
      row.caseVersion !== reference.caseVersion + index ||
      row.materialRevision !== reference.materialRevision ||
      row.snapshot.caseId !== reference.snapshot.caseId ||
      row.snapshot.productId !== reference.snapshot.productId ||
      row.snapshot.demo !== reference.snapshot.demo ||
      !sameValue(row.snapshot.investigation, reference.snapshot.investigation)
    )
  ) {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_PROVENANCE_INVALID',
      'The authoritative answer revision chain is incomplete or materially divergent.'
    );
  }
}

function initialBaseline(
  database: RecallDatabase,
  anchor: AuthoritativeChallengeAnchor,
  challenged: StoredCaseRevision
): InitialUnassociatedChallengeBaseline {
  const question = database.select().from(schema.investigationQuestions).where(and(
    eq(schema.investigationQuestions.caseId, anchor.caseId),
    eq(schema.investigationQuestions.questionRef, anchor.questionRef)
  )).get();
  if (!question || question.questionType !== 'AFFECTED_BATCH_LOT') {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_UNPROVEN',
      'The permanent Question origin cannot be resolved.'
    );
  }
  const origin = readCaseRevisionByCaseVersion(
    database,
    anchor.caseId,
    question.originCaseVersion
  );
  const predecessor = readCaseRevisionByCaseVersion(
    database,
    anchor.caseId,
    challenged.caseVersion - 1
  );
  const originIssue = origin?.snapshot.investigation?.gaps.filter((issue) =>
    issue.id === anchor.questionRef && issue.code === 'BATCH_MISSING' &&
    sameReferences(issue.subjectRefs, [question.subjectRef])
  ) ?? [];
  if (
    !origin || !predecessor || originIssue.length !== 1 ||
    origin.caseVersion !== question.originCaseVersion ||
    origin.materialRevision !== question.originMaterialRevision ||
    origin.createdAt !== question.createdAt ||
    predecessor.materialRevision === null ||
    predecessor.materialRevision === challenged.materialRevision
  ) {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_UNPROVEN',
      'The challenged answer does not follow the registered unassociated BATCH_MISSING baseline.'
    );
  }
  const earlierChallenges = database.select({
    challengeRef: schema.investigationChallenges.challengeRef,
    openedCaseVersion: schema.investigationChallenges.openedCaseVersion,
    challengedMaterialRevision: schema.investigationChallenges.challengedMaterialRevision
  })
    .from(schema.investigationChallenges).where(and(
      eq(schema.investigationChallenges.caseId, anchor.caseId),
      eq(schema.investigationChallenges.questionRef, anchor.questionRef)
    )).orderBy(asc(schema.investigationChallenges.openedCaseVersion)).all().filter((row) =>
      row.challengeRef !== anchor.challengeRef &&
      (row.openedCaseVersion < anchor.openedCaseVersion ||
        row.challengedMaterialRevision <= anchor.challengedMaterialRevision)
    );
  if (earlierChallenges.length > 0) {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_UNPROVEN',
      'An earlier Challenge prevents use of the initial unassociated baseline.'
    );
  }
  const baselineRows = readCaseRevisionRange(
    database,
    anchor.caseId,
    question.originCaseVersion,
    predecessor.caseVersion
  );
  if (baselineRows.some((row) =>
    row.materialRevision === predecessor.materialRevision &&
    !sameValue(row.snapshot.investigation, predecessor.snapshot.investigation)
  )) {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_AMBIGUOUS',
      'The preceding authoritative material state is not internally consistent.'
    );
  }
  const predecessorQuestions = predecessor.snapshot.investigation?.gaps.filter((issue) =>
    issue.code === 'BATCH_MISSING' && sameReferences(issue.subjectRefs, [question.subjectRef])
  ) ?? [];
  if (predecessorQuestions.length !== 1) {
    throw new AuthoritativeChallengeBaselineError(
      predecessorQuestions.length > 1
        ? 'CHALLENGE_BASELINE_AMBIGUOUS'
        : 'CHALLENGE_BASELINE_UNPROVEN',
      'The preceding material state does not identify one authoritative batch Question.'
    );
  }
  if (predecessorQuestions[0].id !== anchor.questionRef) {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_UNPROVEN',
      'The challenged answer follows a different factual Question.'
    );
  }
  if (baselineRows.some((row) => {
    const issues = row.snapshot.investigation?.gaps.filter((issue) =>
      issue.id === anchor.questionRef && issue.code === 'BATCH_MISSING' &&
      sameReferences(issue.subjectRefs, [question.subjectRef])
    ) ?? [];
    return row.materialRevision === null || row.snapshot.productId !== question.subjectRef ||
      row.snapshot.demo !== question.demo || issues.length !== 1;
  })) {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_PROVENANCE_INVALID',
      'The original BATCH_MISSING lineage is not continuous.'
    );
  }
  const claims = database.select().from(schema.investigationClaims).where(and(
    eq(schema.investigationClaims.caseId, anchor.caseId),
    eq(schema.investigationClaims.questionRef, anchor.questionRef)
  )).all().filter((row) => artifactChallengeRef(database, 'claim', row.claimRef) === null);
  const assessments = database.select().from(schema.investigationAssessments).where(and(
    eq(schema.investigationAssessments.caseId, anchor.caseId),
    eq(schema.investigationAssessments.questionRef, anchor.questionRef)
  )).all().filter((row) => artifactChallengeRef(database, 'assessment', row.assessmentRef) === null);
  return {
    kind: 'INITIAL_UNASSOCIATED',
    challengedRevisionId: challenged.revisionId,
    challengedCaseVersion: challenged.caseVersion,
    challengedMaterialRevision: challenged.materialRevision!,
    questionOriginCaseVersion: question.originCaseVersion,
    questionOriginMaterialRevision: question.originMaterialRevision,
    baselineClaimRefs: canonicalReferences(claims.map((row) => row.claimRef)),
    baselineAssessmentRefs: canonicalReferences(assessments.map((row) => row.assessmentRef)),
    baselineEvidenceRefs: canonicalReferences([
      ...claims.flatMap((row) => parseCanonicalReferences(row.evidenceRefsJson)),
      ...assessments.flatMap((row) => parseCanonicalReferences(row.evidenceRefsJson))
    ])
  };
}

function applicationBaseline(
  application: InvestigationChallengeBatchApplication
): AppliedChallengeBatchBaseline {
  return {
    kind: 'APPLIED_CHALLENGE_BATCH',
    applicationRef: application.applicationRef,
    sourceChallengeRef: application.challengeRef,
    establishmentRef: application.establishmentRef,
    claimRef: application.claimRef,
    appliedLot: application.appliedLot,
    resultingRevisionId: application.resultingRevisionId,
    resultingCaseVersion: application.resultingCaseVersion,
    resultingMaterialRevision: application.resultingMaterialRevision,
    resultBaselineClaimRefs: [...application.resultBaselineClaimRefs],
    resultBaselineAssessmentRefs: [...application.resultBaselineAssessmentRefs],
    resultBaselineEvidenceRefs: [...application.resultBaselineEvidenceRefs]
  };
}

function validateApplicationProvenance(
  database: RecallDatabase,
  application: InvestigationChallengeBatchApplication,
  visitedApplications: ReadonlySet<string>
): CaseSnapshot {
  if (visitedApplications.has(application.applicationRef)) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Challenge application provenance contains a cycle.'
    );
  }
  const nextVisited = new Set(visitedApplications).add(application.applicationRef);
  const question = database.select().from(schema.investigationQuestions).where(and(
    eq(schema.investigationQuestions.caseId, application.caseId),
    eq(schema.investigationQuestions.questionRef, application.questionRef)
  )).get();
  const challenge = database.select().from(schema.investigationChallenges).where(and(
    eq(schema.investigationChallenges.caseId, application.caseId),
    eq(schema.investigationChallenges.challengeRef, application.challengeRef)
  )).get();
  const establishment = database.select().from(schema.investigationEstablishments).where(and(
    eq(schema.investigationEstablishments.caseId, application.caseId),
    eq(schema.investigationEstablishments.establishmentRef, application.establishmentRef)
  )).get();
  const establishmentAssociation = database.select().from(schema.investigationChallengeEstablishments)
    .where(eq(schema.investigationChallengeEstablishments.establishmentRef, application.establishmentRef)).get();
  const claim = readClaim(database, application.caseId, application.claimRef);
  if (!question || !challenge || !establishment || !establishmentAssociation || !claim) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge application ownership is incomplete.'
    );
  }
  let establishmentClaimRefs: string[];
  let establishmentAssessmentRefs: string[];
  let establishmentEvidenceRefs: string[];
  try {
    establishmentClaimRefs = parseCanonicalReferences(establishment.basisClaimRefsJson);
    establishmentAssessmentRefs = parseCanonicalReferences(establishment.basisAssessmentRefsJson);
    establishmentEvidenceRefs = parseCanonicalReferences(establishment.basisEvidenceRefsJson);
  } catch {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge Establishment basis is malformed.'
    );
  }
  const expectedEstablishmentPolicy = application.basisFormatVersion ===
      challengeBatchApplicationBasisFormatVersion
    ? demoChallengeBatchEstablishmentPolicy
    : demoInheritedChallengeBatchEstablishmentPolicy;
  if (
    question.questionType !== 'AFFECTED_BATCH_LOT' || question.subjectRef !== claim.subjectRef ||
    challenge.questionRef !== application.questionRef ||
    establishment.questionRef !== application.questionRef ||
    establishment.claimRef !== application.claimRef ||
    establishmentAssociation.challengeRef !== application.challengeRef ||
    artifactChallengeRef(database, 'claim', claim.claimRef) !== application.challengeRef ||
    !isSupportedChallengeBatchEstablishmentPolicy(establishment) ||
    establishment.policyVersion !== expectedEstablishmentPolicy.policyVersion ||
    normalizeBatch(claim.value.lot) !== application.appliedLot ||
    !sameReferences(establishmentClaimRefs, application.reviewedClaimRefs) ||
    !sameReferences(establishmentAssessmentRefs, application.reviewedAssessmentRefs) ||
    !sameReferences(establishmentEvidenceRefs, application.reviewedEvidenceRefs) ||
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

  const baseline = resolveAuthoritativeChallengeBaselineInternal(database, {
    caseId: application.caseId,
    questionRef: application.questionRef,
    challengeRef: application.challengeRef,
    challengedRevisionId: challenge.challengedRevisionId,
    challengedMaterialRevision: challenge.challengedMaterialRevision,
    openedCaseVersion: challenge.openedCaseVersion,
    currentCaseVersion: application.sourceCaseVersion
  }, nextVisited);
  if (
    (application.basisFormatVersion === challengeBatchApplicationBasisFormatVersion &&
      baseline.kind !== 'INITIAL_UNASSOCIATED') ||
    (application.basisFormatVersion === inheritedChallengeBatchApplicationBasisFormatVersion &&
      baseline.kind !== 'APPLIED_CHALLENGE_BATCH')
  ) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge application basis format does not match its authoritative baseline.'
    );
  }
  const inheritedClaimRefs = baseline.kind === 'APPLIED_CHALLENGE_BATCH'
    ? new Set(baseline.resultBaselineClaimRefs)
    : new Set<string>();
  const inheritedAssessmentRefs = baseline.kind === 'APPLIED_CHALLENGE_BATCH'
    ? new Set(baseline.resultBaselineAssessmentRefs)
    : new Set<string>();
  const reviewedClaims = application.reviewedClaimRefs.map((claimRef) =>
    readClaim(database, application.caseId, claimRef)
  );
  const reviewedAssessments = application.reviewedAssessmentRefs.map((assessmentRef) =>
    readAssessment(database, application.caseId, assessmentRef)
  );
  const reviewedEvidence = application.reviewedEvidenceRefs.map((evidenceRef) =>
    database.select().from(schema.investigationEvidence).where(and(
      eq(schema.investigationEvidence.caseId, application.caseId),
      eq(schema.investigationEvidence.evidenceRef, evidenceRef)
    )).get()
  );
  if (
    reviewedClaims.some((item) => !item || !item.demo ||
      item.questionRef !== application.questionRef ||
      item.claimType !== 'AFFECTED_BATCH_LOT' || (
        artifactChallengeRef(database, 'claim', item.claimRef) !== application.challengeRef &&
        !inheritedClaimRefs.has(item.claimRef) &&
        !(baseline.kind === 'INITIAL_UNASSOCIATED' &&
          artifactChallengeRef(database, 'claim', item.claimRef) === null)
      )) ||
    reviewedAssessments.some((item) => !item || !item.demo ||
      item.questionRef !== application.questionRef || (
      artifactChallengeRef(database, 'assessment', item.assessmentRef) !== application.challengeRef &&
      !inheritedAssessmentRefs.has(item.assessmentRef) &&
      !(baseline.kind === 'INITIAL_UNASSOCIATED' &&
        artifactChallengeRef(database, 'assessment', item.assessmentRef) === null)
    )) ||
    reviewedEvidence.some((item) => !item || !item.demo ||
      item.questionRef !== application.questionRef)
  ) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Reviewed Challenge artifact ownership is inconsistent.'
    );
  }
  const source = readRevision(database, application, 'source');
  const result = readRevision(database, application, 'result');
  const validClaims = reviewedClaims.filter((item): item is InvestigationClaim => item !== null);
  const validAssessments = reviewedAssessments.filter(
    (item): item is InvestigationAssessment => item !== null
  );
  const materiallyCurrentAssessmentRefs = new Set(validAssessments.filter((assessment) => {
    try {
      return readCaseRevisionByCaseVersion(
        database,
        application.caseId,
        assessment.basisCaseVersion
      )?.materialRevision === application.sourceMaterialRevision &&
        [
          ...(assessment.targetClaimRef === null ? [] : [assessment.targetClaimRef]),
          ...assessment.relatedClaimRefs
        ].every((claimRef) => application.reviewedClaimRefs.includes(claimRef));
    } catch {
      return false;
    }
  }).map((assessment) => assessment.assessmentRef));
  const classification = classifyChallengeBatchEstablishmentAssessments({
    activeClaims: validClaims,
    structuralAssessmentHeads: validAssessments,
    materiallyCurrentAssessmentRefs,
    assessmentChallengeRefs: new Map(validAssessments.map((assessment) => [
      assessment.assessmentRef,
      artifactChallengeRef(database, 'assessment', assessment.assessmentRef)
    ])),
    challengeRef: application.challengeRef,
    targetClaimRef: application.claimRef,
    targetLot: application.appliedLot,
    completeEvidenceRefs: application.reviewedEvidenceRefs
  });
  if (
    classification.divergentClaimRefsWithoutTrustedRejection.length > 0 ||
    classification.qualifyingTargetSupportAssessmentRefs.length === 0 ||
    !sameReferences(application.resultBaselineAssessmentRefs,
      classification.qualifyingTargetSupportAssessmentRefs) ||
    !sameReferences(application.appliedAssessmentRefs, [
      ...classification.qualifyingTargetSupportAssessmentRefs,
      ...classification.reliedUponRejectionAssessmentRefs
    ])
  ) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Applied and result-baseline Assessment provenance does not match the Establishment policy.'
    );
  }
  const conflict = database.select({
    applicationRef: schema.investigationChallengeConflictApplications.applicationRef
  }).from(schema.investigationChallengeConflictApplications).where(eq(
    schema.investigationChallengeConflictApplications.challengeRef,
    application.challengeRef
  )).get();
  const command = database.select().from(schema.caseCommands).where(and(
    eq(schema.caseCommands.caseId, application.caseId),
    eq(schema.caseCommands.commandId, application.applicationRef)
  )).get();
  const sourceInvestigation = source.snapshot.investigation;
  const resultInvestigation = result.snapshot.investigation;
  const baselineMaterialRevision = baseline.kind === 'INITIAL_UNASSOCIATED'
    ? baseline.challengedMaterialRevision
    : baseline.resultingMaterialRevision;
  if (
    conflict || !command || !sourceInvestigation || !resultInvestigation ||
    source.snapshot.productId !== question.subjectRef ||
    result.snapshot.productId !== question.subjectRef ||
    challenge.challengedMaterialRevision !== application.sourceMaterialRevision ||
    establishment.basisMaterialRevision !== application.sourceMaterialRevision ||
    baselineMaterialRevision !== application.sourceMaterialRevision ||
    command.appliedCaseVersion !== application.resultingCaseVersion ||
    command.payloadJson !== challengeBatchApplicationCommandPayload(application) ||
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
    resultInvestigation.gaps.length !== 0 || resultInvestigation.conflicts.length !== 0
  ) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_PROVENANCE_INVALID',
      'Stored Challenge batch execution or authoritative result is inconsistent.'
    );
  }
  return result.snapshot;
}

function getApplicationInternal(
  database: RecallDatabase,
  caseId: string,
  applicationRef: string,
  visitedApplications: ReadonlySet<string>
): { application: InvestigationChallengeBatchApplication; snapshot: CaseSnapshot } | null {
  const row = database.select().from(schema.investigationChallengeBatchApplications).where(and(
    eq(schema.investigationChallengeBatchApplications.caseId, caseId),
    eq(schema.investigationChallengeBatchApplications.applicationRef, applicationRef)
  )).get();
  if (!row) return null;
  const application = hydrateApplication(row);
  return {
    application,
    snapshot: validateApplicationProvenance(database, application, visitedApplications)
  };
}

export function getInvestigationChallengeBatchApplication(
  database: RecallDatabase,
  caseId: string,
  applicationRef: string
): InvestigationChallengeBatchApplication | null {
  return getApplicationInternal(database, caseId, applicationRef, new Set())?.application ?? null;
}

export function readInvestigationChallengeBatchApplicationResult(
  database: RecallDatabase,
  caseId: string,
  applicationRef: string
): { application: InvestigationChallengeBatchApplication; snapshot: CaseSnapshot } | null {
  return getApplicationInternal(database, caseId, applicationRef, new Set());
}

function resolveAuthoritativeChallengeBaselineInternal(
  database: RecallDatabase,
  anchor: AuthoritativeChallengeAnchor,
  visitedApplications: ReadonlySet<string>
): AuthoritativeChallengeBaseline {
  const challenged = readCaseRevisionById(
    database,
    anchor.caseId,
    anchor.challengedRevisionId
  );
  if (
    !challenged || challenged.materialRevision !== anchor.challengedMaterialRevision ||
    challenged.caseVersion > anchor.openedCaseVersion
  ) {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_PROVENANCE_INVALID',
      'The challenged authoritative revision anchor is missing or inconsistent.'
    );
  }
  const challengedLot = assertKnownBatchAnswer(challenged.snapshot);
  const throughCaseVersion = anchor.currentCaseVersion ?? anchor.openedCaseVersion;
  if (throughCaseVersion < anchor.openedCaseVersion) {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_PROVENANCE_INVALID',
      'The Challenge continuity range regresses before its opening version.'
    );
  }
  assertRevisionContinuity(database, challenged, throughCaseVersion);

  const exactAnchorRows = database.select().from(schema.investigationChallengeBatchApplications)
    .where(eq(
      schema.investigationChallengeBatchApplications.resultingRevisionId,
      anchor.challengedRevisionId
    )).all();
  const sameMaterialRows = database.select().from(schema.investigationChallengeBatchApplications)
    .where(and(
      eq(schema.investigationChallengeBatchApplications.caseId, anchor.caseId),
      eq(schema.investigationChallengeBatchApplications.resultingMaterialRevision,
        anchor.challengedMaterialRevision)
    )).all();
  if (exactAnchorRows.length > 1 || sameMaterialRows.length > 1) {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_PROVENANCE_INVALID',
      'The challenged material state has ambiguous positive application provenance.'
    );
  }
  if (exactAnchorRows.length === 1) {
    let loaded;
    try {
      loaded = getApplicationInternal(
        database,
        anchor.caseId,
        exactAnchorRows[0].applicationRef,
        visitedApplications
      );
    } catch (error) {
      throw new AuthoritativeChallengeBaselineError(
        'CHALLENGE_BASELINE_PROVENANCE_INVALID',
        error instanceof Error ? error.message : 'Positive application provenance is invalid.'
      );
    }
    if (
      !loaded || loaded.application.caseId !== anchor.caseId ||
      loaded.application.questionRef !== anchor.questionRef ||
      loaded.application.challengeRef === anchor.challengeRef ||
      loaded.application.resultingRevisionId !== anchor.challengedRevisionId ||
      loaded.application.resultingMaterialRevision !== anchor.challengedMaterialRevision ||
      loaded.application.resultingCaseVersion !== challenged.caseVersion ||
      loaded.application.appliedLot !== challengedLot
    ) {
      throw new AuthoritativeChallengeBaselineError(
        'CHALLENGE_BASELINE_PROVENANCE_INVALID',
        'The positive application does not exactly create the challenged material answer.'
      );
    }
    return applicationBaseline(loaded.application);
  }
  if (sameMaterialRows.length > 0) {
    throw new AuthoritativeChallengeBaselineError(
      'CHALLENGE_BASELINE_PROVENANCE_INVALID',
      'A positive application claims this material revision without matching its answer anchor.'
    );
  }
  return initialBaseline(database, anchor, challenged);
}

/** Resolve one exact Challenge baseline inside a transaction owned by the caller. */
export function resolveAuthoritativeChallengeBaselineInTransaction(
  database: RecallDatabase,
  anchor: AuthoritativeChallengeAnchor
): AuthoritativeChallengeBaseline {
  return resolveAuthoritativeChallengeBaselineInternal(database, anchor, new Set());
}

export function resolveAuthoritativeChallengeBaseline(
  database: RecallDatabase,
  anchor: AuthoritativeChallengeAnchor
): AuthoritativeChallengeBaseline {
  return database.transaction((transaction) =>
    resolveAuthoritativeChallengeBaselineInTransaction(transaction, anchor)
  );
}

export function basisFormatForAuthoritativeChallengeBaseline(
  baseline: AuthoritativeChallengeBaseline
): ChallengeBatchApplicationBasisFormatVersion {
  return baseline.kind === 'INITIAL_UNASSOCIATED'
    ? challengeBatchApplicationBasisFormatVersion
    : inheritedChallengeBatchApplicationBasisFormatVersion;
}
