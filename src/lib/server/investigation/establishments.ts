import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { CaseSnapshot } from '../../contracts/recall';
import { normalizeBatch } from '../alerts/normalization';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { getCaseHistory, readCaseSnapshot, type LifecycleContext } from '../workflow/case-lifecycle';
import {
  demoHumanAssessorIdentifier,
  listInvestigationAssessments
} from './assessments';
import { listInvestigationClaims } from './claims';
import {
  EffectiveAnalysisError,
  projectEffectiveInvestigationAnalysis,
  type EffectiveInvestigationAnalysis
} from './effective-analysis';
import {
  listInvestigationEvidence,
  type InvestigationEvidence
} from './evidence-registry';

export const demoBatchEstablishmentPolicy = {
  policyIdentifier: 'demo-dual-source-human-reviewed-batch',
  policyVersion: 'v1',
  evaluatorKind: 'RULE',
  evaluatorIdentifier: 'demo-batch-establishment-policy-engine'
} as const;

export type DemoBatchEstablishmentBlockerCode =
  | 'CONTEXT_MISMATCH'
  | 'QUESTION_NOT_CURRENT'
  | 'IDENTITY_NOT_KNOWN_MATCH'
  | 'NOT_DEMO'
  | 'TARGET_NOT_ACTIVE'
  | 'ACTIVE_CLAIM_AMBIGUOUS'
  | 'AI_TARGET_UNSUPPORTED'
  | 'LOT_EMPTY'
  | 'EVIDENCE_CORPUS_EMPTY'
  | 'EVIDENCE_CORPUS_INVALID'
  | 'EVIDENCE_CORPUS_INCOMPLETE'
  | 'INSUFFICIENT_STRUCTURED_EVIDENCE'
  | 'SOURCE_IDENTIFIER_DIVERSITY_MISSING'
  | 'INTEGRITY_HASH_DIVERSITY_MISSING'
  | 'SOURCE_CLASS_COMBINATION_MISSING'
  | 'HUMAN_REVIEW_MISSING'
  | 'HUMAN_REVIEW_NOT_CURRENT'
  | 'HUMAN_REVIEW_INCOMPLETE'
  | 'TARGET_REJECTED'
  | 'TARGET_INSUFFICIENT'
  | 'QUESTION_INSUFFICIENT'
  | 'ACTIVE_CONTRADICTION'
  | 'INCOMPATIBLE_SUPPORTED_CLAIM'
  | 'ANALYSIS_AMBIGUOUS';

export type DemoBatchSourceDiversityBlockerCode =
  | 'INSUFFICIENT_STRUCTURED_EVIDENCE'
  | 'SOURCE_IDENTIFIER_DIVERSITY_MISSING'
  | 'INTEGRITY_HASH_DIVERSITY_MISSING'
  | 'SOURCE_CLASS_COMBINATION_MISSING';

export interface DemoBatchEstablishmentBasis {
  claimRefs: string[];
  assessmentRefs: string[];
  evidenceRefs: string[];
}

export interface DemoBatchEstablishmentPolicyEvaluation {
  eligible: boolean;
  blockerCodes: DemoBatchEstablishmentBlockerCode[];
  basis: DemoBatchEstablishmentBasis;
}

export interface EvaluateDemoBatchEstablishmentPolicyInput {
  snapshot: CaseSnapshot;
  analysis: EffectiveInvestigationAnalysis;
  evidence: readonly InvestigationEvidence[];
  targetClaimRef: string;
}

const blockerOrder: DemoBatchEstablishmentBlockerCode[] = [
  'CONTEXT_MISMATCH',
  'QUESTION_NOT_CURRENT',
  'IDENTITY_NOT_KNOWN_MATCH',
  'NOT_DEMO',
  'TARGET_NOT_ACTIVE',
  'ACTIVE_CLAIM_AMBIGUOUS',
  'AI_TARGET_UNSUPPORTED',
  'LOT_EMPTY',
  'EVIDENCE_CORPUS_EMPTY',
  'EVIDENCE_CORPUS_INVALID',
  'EVIDENCE_CORPUS_INCOMPLETE',
  'INSUFFICIENT_STRUCTURED_EVIDENCE',
  'SOURCE_IDENTIFIER_DIVERSITY_MISSING',
  'INTEGRITY_HASH_DIVERSITY_MISSING',
  'SOURCE_CLASS_COMBINATION_MISSING',
  'HUMAN_REVIEW_MISSING',
  'HUMAN_REVIEW_NOT_CURRENT',
  'HUMAN_REVIEW_INCOMPLETE',
  'TARGET_REJECTED',
  'TARGET_INSUFFICIENT',
  'QUESTION_INSUFFICIENT',
  'ACTIVE_CONTRADICTION',
  'INCOMPATIBLE_SUPPORTED_CLAIM',
  'ANALYSIS_AMBIGUOUS'
];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRefs(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  const canonicalLeft = canonicalRefs(left);
  const canonicalRight = canonicalRefs(right);
  return canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index]);
}

function addBlocker(
  blockers: Set<DemoBatchEstablishmentBlockerCode>,
  blocker: DemoBatchEstablishmentBlockerCode
): void {
  blockers.add(blocker);
}

/**
 * Shared deterministic demo source-diversity rule. It evaluates provenance signals only;
 * callers remain responsible for Question ownership, completeness, and trust policy.
 */
export function evaluateDemoBatchSourceDiversity(
  evidence: readonly InvestigationEvidence[]
): DemoBatchSourceDiversityBlockerCode[] {
  const blockers: DemoBatchSourceDiversityBlockerCode[] = [];
  const structuredEvidence = evidence.filter((item) => item.contentKind === 'STRUCTURED');
  if (structuredEvidence.length < 2) {
    blockers.push('INSUFFICIENT_STRUCTURED_EVIDENCE');
  }
  if (new Set(structuredEvidence.map((item) => item.sourceIdentifier)).size < 2) {
    blockers.push('SOURCE_IDENTIFIER_DIVERSITY_MISSING');
  }
  if (new Set(structuredEvidence.map((item) => item.integrityHash)).size < 2) {
    blockers.push('INTEGRITY_HASH_DIVERSITY_MISSING');
  }
  const sourceKinds = new Set(structuredEvidence.map((item) => item.sourceKind));
  if (
    !sourceKinds.has('INTERNAL') ||
    (!sourceKinds.has('EXTERNAL_PARTY') && !sourceKinds.has('REGULATOR'))
  ) {
    blockers.push('SOURCE_CLASS_COMBINATION_MISSING');
  }
  return blockers;
}

export function evaluateDemoBatchEstablishmentPolicy(
  input: EvaluateDemoBatchEstablishmentPolicyInput
): DemoBatchEstablishmentPolicyEvaluation {
  const { snapshot, analysis, evidence, targetClaimRef } = input;
  const blockers = new Set<DemoBatchEstablishmentBlockerCode>();
  const basis: DemoBatchEstablishmentBasis = {
    claimRefs: canonicalRefs(analysis.activeClaims.map((claim) => claim.claimRef)),
    assessmentRefs: canonicalRefs(
      analysis.structuralAssessmentHeads.map((assessment) => assessment.assessmentRef)
    ),
    evidenceRefs: canonicalRefs(evidence.map((item) => item.evidenceRef))
  };

  if (
    snapshot.caseId !== analysis.caseId ||
    snapshot.productId !== analysis.productId ||
    snapshot.caseVersion !== analysis.currentCaseVersion ||
    snapshot.materialRevision !== analysis.currentMaterialRevision
  ) {
    addBlocker(blockers, 'CONTEXT_MISMATCH');
  }
  const currentQuestions = snapshot.investigation?.gaps.filter(
    (gap) => gap.id === analysis.questionRef
  ) ?? [];
  if (currentQuestions.length !== 1 || currentQuestions[0].code !== 'BATCH_MISSING') {
    addBlocker(blockers, 'QUESTION_NOT_CURRENT');
  }
  if (
    snapshot.investigation?.identity.knowledgeStatus !== 'KNOWN' ||
    snapshot.investigation.identity.conclusion !== 'MATCH'
  ) {
    addBlocker(blockers, 'IDENTITY_NOT_KNOWN_MATCH');
  }

  const target = analysis.activeClaims.find((claim) => claim.claimRef === targetClaimRef);
  if (!target) addBlocker(blockers, 'TARGET_NOT_ACTIVE');
  if (analysis.activeClaims.length !== 1) {
    addBlocker(blockers, 'ACTIVE_CLAIM_AMBIGUOUS');
  }
  if (target?.originKind === 'AI_PROPOSED') {
    addBlocker(blockers, 'AI_TARGET_UNSUPPORTED');
  }
  if (target && normalizeBatch(target.value.lot).length === 0) {
    addBlocker(blockers, 'LOT_EMPTY');
  }

  const evidenceRefs = evidence.map((item) => item.evidenceRef);
  const duplicateEvidenceRefs = new Set(evidenceRefs).size !== evidenceRefs.length;
  const evidenceContextMismatch = evidence.some((item) =>
    item.caseId !== analysis.caseId || item.questionRef !== analysis.questionRef
  );
  if (evidence.length === 0) addBlocker(blockers, 'EVIDENCE_CORPUS_EMPTY');
  if (duplicateEvidenceRefs || evidenceContextMismatch) {
    addBlocker(blockers, 'EVIDENCE_CORPUS_INVALID');
  }

  const evidenceByRef = new Map(evidence.map((item) => [item.evidenceRef, item]));
  const targetEvidence = target?.evidenceRefs.map((evidenceRef) => evidenceByRef.get(evidenceRef)) ?? [];
  if (targetEvidence.some((item) => item === undefined)) {
    addBlocker(blockers, 'EVIDENCE_CORPUS_INCOMPLETE');
  }
  const completeTargetEvidence = targetEvidence.filter(
    (item): item is InvestigationEvidence => item !== undefined
  );
  for (const blocker of evaluateDemoBatchSourceDiversity(completeTargetEvidence)) {
    addBlocker(blockers, blocker);
  }

  const structuralHumanReviews = analysis.structuralAssessmentHeads.filter((assessment) =>
    assessment.verdict === 'SUPPORTED' &&
    assessment.targetClaimRef === targetClaimRef &&
    assessment.assessorKind === 'HUMAN' &&
    assessment.assessorIdentifier === demoHumanAssessorIdentifier
  );
  const materiallyCurrentRefs = new Set(
    analysis.materiallyCurrentAssessmentHeads.map((assessment) => assessment.assessmentRef)
  );
  const currentHumanReviews = structuralHumanReviews.filter((assessment) =>
    materiallyCurrentRefs.has(assessment.assessmentRef)
  );
  if (structuralHumanReviews.length === 0) {
    addBlocker(blockers, 'HUMAN_REVIEW_MISSING');
  } else if (currentHumanReviews.length === 0) {
    addBlocker(blockers, 'HUMAN_REVIEW_NOT_CURRENT');
  } else if (!currentHumanReviews.some((assessment) =>
    sameRefs(assessment.evidenceRefs, basis.evidenceRefs)
  )) {
    addBlocker(blockers, 'HUMAN_REVIEW_INCOMPLETE');
  }

  const targetAnalysis = analysis.targetedAssessments.find(
    (item) => item.claimRef === targetClaimRef
  );
  if ((targetAnalysis?.rejectedAssessmentRefs.length ?? 0) > 0) {
    addBlocker(blockers, 'TARGET_REJECTED');
  }
  if ((targetAnalysis?.insufficientAssessmentRefs.length ?? 0) > 0) {
    addBlocker(blockers, 'TARGET_INSUFFICIENT');
  }
  if (analysis.questionLevelInsufficientAssessmentRefs.length > 0) {
    addBlocker(blockers, 'QUESTION_INSUFFICIENT');
  }
  if (analysis.activeContradictions.length > 0) {
    addBlocker(blockers, 'ACTIVE_CONTRADICTION');
  }

  if (target) {
    const normalizedTarget = normalizeBatch(target.value.lot);
    const incompatibleSupported = analysis.activeClaims.some((claim) => {
      if (claim.claimRef === target.claimRef) return false;
      const state = analysis.targetedAssessments.find((item) => item.claimRef === claim.claimRef);
      return (state?.supportedAssessmentRefs.length ?? 0) > 0 &&
        normalizeBatch(claim.value.lot) !== normalizedTarget;
    });
    if (incompatibleSupported) addBlocker(blockers, 'INCOMPATIBLE_SUPPORTED_CLAIM');
  }
  if (analysis.ambiguities.length > 0) {
    addBlocker(blockers, 'ANALYSIS_AMBIGUOUS');
  }

  const allStructuralAssessmentsAreDemo = analysis.structuralAssessmentHeads.every(
    (assessment) => assessment.demo
  );
  if (
    !snapshot.demo ||
    !target?.demo ||
    !allStructuralAssessmentsAreDemo ||
    evidence.some((item) => !item.demo)
  ) {
    addBlocker(blockers, 'NOT_DEMO');
  }

  const blockerCodes = [...blockers].sort((left, right) =>
    blockerOrder.indexOf(left) - blockerOrder.indexOf(right)
  );
  return { eligible: blockerCodes.length === 0, blockerCodes, basis };
}

const opaqueReferenceSchema = z.string().min(1).max(500).refine(
  (value) => value.trim().length > 0,
  'References must contain a non-whitespace character.'
);
const canonicalReferenceArraySchema = z.array(opaqueReferenceSchema).min(1).refine(
  (values) => new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1] < value),
  'Reference arrays must be unique and lexically ordered.'
);

const recordInvestigationEstablishmentInputSchema = z.strictObject({
  establishmentRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  claimRef: z.string().uuid(),
  expectedCaseVersion: z.number().int().positive(),
  expectedMaterialRevision: z.number().int().positive(),
  demo: z.boolean()
});

const investigationEstablishmentSchema = z.strictObject({
  establishmentRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  claimRef: z.string().uuid(),
  policyIdentifier: opaqueReferenceSchema,
  policyVersion: opaqueReferenceSchema,
  basisClaimRefs: canonicalReferenceArraySchema,
  basisAssessmentRefs: canonicalReferenceArraySchema,
  basisEvidenceRefs: canonicalReferenceArraySchema,
  evaluatorKind: z.literal('RULE'),
  evaluatorIdentifier: opaqueReferenceSchema,
  basisCaseVersion: z.number().int().positive(),
  basisMaterialRevision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  demo: z.literal(true)
});

const getEstablishmentInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  establishmentRef: z.string().uuid()
});

const listEstablishmentsInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema
});

export type RecordInvestigationEstablishmentInput = z.infer<
  typeof recordInvestigationEstablishmentInputSchema
>;
export type InvestigationEstablishment = z.infer<typeof investigationEstablishmentSchema>;

export type InvestigationEstablishmentErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'VERSIONED_CASE_REQUIRED'
  | 'STALE_CASE_VERSION'
  | 'STALE_MATERIAL_REVISION'
  | 'POLICY_NOT_SATISFIED'
  | 'ANALYSIS_UNAVAILABLE'
  | 'ESTABLISHMENT_CONFLICT';

export class InvestigationEstablishmentError extends Error {
  constructor(
    public readonly code: InvestigationEstablishmentErrorCode,
    message: string,
    public readonly blockerCodes: DemoBatchEstablishmentBlockerCode[] = []
  ) {
    super(message);
    this.name = 'InvestigationEstablishmentError';
  }
}

export type CurrentEstablishmentBlockerCode =
  | DemoBatchEstablishmentBlockerCode
  | 'VERSIONED_CASE_REQUIRED'
  | 'POLICY_UNSUPPORTED'
  | 'ANALYSIS_UNAVAILABLE'
  | 'MATERIAL_REVISION_CHANGED'
  | 'CLAIM_BASIS_CHANGED'
  | 'ASSESSMENT_BASIS_CHANGED'
  | 'EVIDENCE_BASIS_CHANGED';

const currentBlockerOrder: CurrentEstablishmentBlockerCode[] = [
  'VERSIONED_CASE_REQUIRED',
  'POLICY_UNSUPPORTED',
  'ANALYSIS_UNAVAILABLE',
  'MATERIAL_REVISION_CHANGED',
  ...blockerOrder,
  'CLAIM_BASIS_CHANGED',
  'ASSESSMENT_BASIS_CHANGED',
  'EVIDENCE_BASIS_CHANGED'
];

function sortCurrentBlockers(
  blockers: Iterable<CurrentEstablishmentBlockerCode>
): CurrentEstablishmentBlockerCode[] {
  return [...new Set(blockers)].sort((left, right) =>
    currentBlockerOrder.indexOf(left) - currentBlockerOrder.indexOf(right)
  );
}

export interface CurrentInvestigationEstablishmentEvaluation {
  establishment: InvestigationEstablishment;
  currentlyEligible: boolean;
  blockerCodes: CurrentEstablishmentBlockerCode[];
  currentBasis: DemoBatchEstablishmentBasis | null;
}

function parseRecordInput(input: RecordInvestigationEstablishmentInput) {
  const parsed = recordInvestigationEstablishmentInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationEstablishmentError(
      'INVALID_INPUT',
      'Invalid investigation establishment record.'
    );
  }
  return parsed.data;
}

function hydrateEstablishment(
  row: typeof schema.investigationEstablishments.$inferSelect
): InvestigationEstablishment {
  return investigationEstablishmentSchema.parse({
    establishmentRef: row.establishmentRef,
    caseId: row.caseId,
    questionRef: row.questionRef,
    claimRef: row.claimRef,
    policyIdentifier: row.policyIdentifier,
    policyVersion: row.policyVersion,
    basisClaimRefs: JSON.parse(row.basisClaimRefsJson),
    basisAssessmentRefs: JSON.parse(row.basisAssessmentRefsJson),
    basisEvidenceRefs: JSON.parse(row.basisEvidenceRefsJson),
    evaluatorKind: row.evaluatorKind,
    evaluatorIdentifier: row.evaluatorIdentifier,
    basisCaseVersion: row.basisCaseVersion,
    basisMaterialRevision: row.basisMaterialRevision,
    createdAt: row.createdAt,
    demo: row.demo
  });
}

function immutableIdentityMatches(
  row: typeof schema.investigationEstablishments.$inferSelect,
  input: ReturnType<typeof parseRecordInput>
): boolean {
  return row.establishmentRef === input.establishmentRef &&
    row.caseId === input.caseId &&
    row.questionRef === input.questionRef &&
    row.claimRef === input.claimRef &&
    row.demo === input.demo;
}

function loadEffectiveAnalysis(
  database: RecallDatabase,
  snapshot: CaseSnapshot,
  questionRef: string
): EffectiveInvestigationAnalysis {
  return projectEffectiveInvestigationAnalysis({
    snapshot,
    questionRef,
    claims: listInvestigationClaims(database, snapshot.caseId, questionRef),
    assessments: listInvestigationAssessments(database, snapshot.caseId, questionRef),
    caseRevisions: getCaseHistory(database, snapshot.caseId).map((revision) => ({
      caseVersion: revision.caseVersion,
      materialRevision: revision.materialRevision
    }))
  });
}

function mapAnalysisError(error: unknown): DemoBatchEstablishmentBlockerCode[] {
  if (error instanceof EffectiveAnalysisError && (
    error.code === 'QUESTION_NOT_CURRENT' || error.code === 'QUESTION_AMBIGUOUS'
  )) {
    return ['QUESTION_NOT_CURRENT'];
  }
  return [];
}

export function recordInvestigationEstablishment(
  database: RecallDatabase,
  input: RecordInvestigationEstablishmentInput,
  context: LifecycleContext,
  now = new Date()
): { establishment: InvestigationEstablishment; replayed: boolean } {
  if (context.mode !== 'demo') {
    throw new InvestigationEstablishmentError(
      'FORBIDDEN',
      'Investigation establishments require explicit local demo mode.'
    );
  }
  const parsed = parseRecordInput(input);

  return database.transaction((transaction) => {
    const existing = transaction
      .select()
      .from(schema.investigationEstablishments)
      .where(eq(schema.investigationEstablishments.establishmentRef, parsed.establishmentRef))
      .get();
    if (existing) {
      if (!immutableIdentityMatches(existing, parsed)) {
        throw new InvestigationEstablishmentError(
          'ESTABLISHMENT_CONFLICT',
          'This establishment reference already identifies a different historical policy result.'
        );
      }
      return { establishment: hydrateEstablishment(existing), replayed: true };
    }
    if (!parsed.demo) {
      throw new InvestigationEstablishmentError(
        'FORBIDDEN',
        'Only explicit demo establishments are supported.'
      );
    }

    const snapshot = readCaseSnapshot(transaction, parsed.caseId);
    if (!snapshot?.investigation || snapshot.materialRevision === null) {
      throw new InvestigationEstablishmentError(
        'VERSIONED_CASE_REQUIRED',
        'The owning case does not have a current versioned investigation.'
      );
    }
    if (snapshot.caseVersion !== parsed.expectedCaseVersion) {
      throw new InvestigationEstablishmentError(
        'STALE_CASE_VERSION',
        'Refresh the case before recording an establishment.'
      );
    }
    if (snapshot.materialRevision !== parsed.expectedMaterialRevision) {
      throw new InvestigationEstablishmentError(
        'STALE_MATERIAL_REVISION',
        'Refresh the material investigation basis before recording an establishment.'
      );
    }

    let analysis: EffectiveInvestigationAnalysis;
    try {
      analysis = loadEffectiveAnalysis(transaction, snapshot, parsed.questionRef);
    } catch (error) {
      const blockerCodes = mapAnalysisError(error);
      if (blockerCodes.length > 0) {
        throw new InvestigationEstablishmentError(
          'POLICY_NOT_SATISFIED',
          'The demo establishment policy did not pass.',
          blockerCodes
        );
      }
      throw new InvestigationEstablishmentError(
        'ANALYSIS_UNAVAILABLE',
        'Current effective investigation analysis could not be derived.'
      );
    }
    const evidence = listInvestigationEvidence(
      transaction,
      parsed.caseId,
      parsed.questionRef
    );
    const evaluation = evaluateDemoBatchEstablishmentPolicy({
      snapshot,
      analysis,
      evidence,
      targetClaimRef: parsed.claimRef
    });
    if (!evaluation.eligible) {
      throw new InvestigationEstablishmentError(
        'POLICY_NOT_SATISFIED',
        'The demo establishment policy did not pass.',
        evaluation.blockerCodes
      );
    }

    const caseRecord = transaction
      .select({ alertId: schema.cases.alertId })
      .from(schema.cases)
      .where(eq(schema.cases.id, parsed.caseId))
      .get();
    if (!caseRecord) {
      throw new InvestigationEstablishmentError(
        'VERSIONED_CASE_REQUIRED',
        'The versioned investigation has no owning case record.'
      );
    }

    const createdAt = now.toISOString();
    transaction.insert(schema.investigationEstablishments).values({
      establishmentRef: parsed.establishmentRef,
      caseId: parsed.caseId,
      questionRef: parsed.questionRef,
      claimRef: parsed.claimRef,
      policyIdentifier: demoBatchEstablishmentPolicy.policyIdentifier,
      policyVersion: demoBatchEstablishmentPolicy.policyVersion,
      basisClaimRefsJson: JSON.stringify(evaluation.basis.claimRefs),
      basisAssessmentRefsJson: JSON.stringify(evaluation.basis.assessmentRefs),
      basisEvidenceRefsJson: JSON.stringify(evaluation.basis.evidenceRefs),
      evaluatorKind: demoBatchEstablishmentPolicy.evaluatorKind,
      evaluatorIdentifier: demoBatchEstablishmentPolicy.evaluatorIdentifier,
      basisCaseVersion: snapshot.caseVersion,
      basisMaterialRevision: snapshot.materialRevision,
      createdAt,
      demo: true
    }).run();
    transaction.insert(schema.auditEvents).values({
      id: randomUUID(),
      caseId: parsed.caseId,
      alertId: caseRecord.alertId,
      eventType: 'investigation_establishment_recorded',
      actorType: 'agent',
      actorName: demoBatchEstablishmentPolicy.evaluatorIdentifier,
      summary: 'Recorded success under a deterministic demo-only batch establishment policy.',
      metadataJson: JSON.stringify({
        establishmentRef: parsed.establishmentRef,
        caseId: parsed.caseId,
        questionRef: parsed.questionRef,
        claimRef: parsed.claimRef,
        ...demoBatchEstablishmentPolicy,
        basisClaimRefs: evaluation.basis.claimRefs,
        basisAssessmentRefs: evaluation.basis.assessmentRefs,
        basisEvidenceRefs: evaluation.basis.evidenceRefs,
        basisCaseVersion: snapshot.caseVersion,
        basisMaterialRevision: snapshot.materialRevision,
        demo: true
      }),
      createdAt
    }).run();

    const inserted = transaction
      .select()
      .from(schema.investigationEstablishments)
      .where(eq(schema.investigationEstablishments.establishmentRef, parsed.establishmentRef))
      .get();
    if (!inserted) throw new Error('Investigation establishment insert did not persist.');
    return { establishment: hydrateEstablishment(inserted), replayed: false };
  }, { behavior: 'immediate' });
}

export function getInvestigationEstablishment(
  database: RecallDatabase,
  caseId: string,
  establishmentRef: string
): InvestigationEstablishment | null {
  const parsed = getEstablishmentInputSchema.safeParse({ caseId, establishmentRef });
  if (!parsed.success) {
    throw new InvestigationEstablishmentError(
      'INVALID_INPUT',
      'Invalid investigation establishment lookup.'
    );
  }
  const row = database
    .select()
    .from(schema.investigationEstablishments)
    .where(and(
      eq(schema.investigationEstablishments.caseId, parsed.data.caseId),
      eq(schema.investigationEstablishments.establishmentRef, parsed.data.establishmentRef)
    ))
    .get();
  return row ? hydrateEstablishment(row) : null;
}

export function listInvestigationEstablishments(
  database: RecallDatabase,
  caseId: string,
  questionRef: string
): InvestigationEstablishment[] {
  const parsed = listEstablishmentsInputSchema.safeParse({ caseId, questionRef });
  if (!parsed.success) {
    throw new InvestigationEstablishmentError(
      'INVALID_INPUT',
      'Invalid investigation establishment list lookup.'
    );
  }
  return database
    .select()
    .from(schema.investigationEstablishments)
    .where(and(
      eq(schema.investigationEstablishments.caseId, parsed.data.caseId),
      eq(schema.investigationEstablishments.questionRef, parsed.data.questionRef)
    ))
    .orderBy(
      asc(schema.investigationEstablishments.createdAt),
      asc(schema.investigationEstablishments.establishmentRef)
    )
    .all()
    .map(hydrateEstablishment);
}

function currentEvaluationWithoutAnalysis(
  establishment: InvestigationEstablishment,
  blockerCodes: CurrentEstablishmentBlockerCode[]
): CurrentInvestigationEstablishmentEvaluation {
  return {
    establishment,
    currentlyEligible: false,
    blockerCodes: sortCurrentBlockers(blockerCodes),
    currentBasis: null
  };
}

export function evaluateCurrentInvestigationEstablishment(
  database: RecallDatabase,
  caseId: string,
  establishmentRef: string
): CurrentInvestigationEstablishmentEvaluation | null {
  const parsed = getEstablishmentInputSchema.safeParse({ caseId, establishmentRef });
  if (!parsed.success) {
    throw new InvestigationEstablishmentError(
      'INVALID_INPUT',
      'Invalid current establishment evaluation lookup.'
    );
  }

  return database.transaction((transaction) =>
    evaluateCurrentInvestigationEstablishmentInTransaction(
      transaction,
      parsed.data.caseId,
      parsed.data.establishmentRef
    )
  );
}

/** Evaluate an Establishment inside a transaction already owned by the caller. */
export function evaluateCurrentInvestigationEstablishmentInTransaction(
  database: RecallDatabase,
  caseId: string,
  establishmentRef: string
): CurrentInvestigationEstablishmentEvaluation | null {
  const parsed = getEstablishmentInputSchema.safeParse({ caseId, establishmentRef });
  if (!parsed.success) {
    throw new InvestigationEstablishmentError(
      'INVALID_INPUT',
      'Invalid current establishment evaluation lookup.'
    );
  }

  const row = database
    .select()
    .from(schema.investigationEstablishments)
    .where(and(
      eq(schema.investigationEstablishments.caseId, parsed.data.caseId),
      eq(schema.investigationEstablishments.establishmentRef, parsed.data.establishmentRef)
    ))
    .get();
  if (!row) return null;
  const establishment = hydrateEstablishment(row);
  const snapshot = readCaseSnapshot(database, parsed.data.caseId);
  if (!snapshot?.investigation || snapshot.materialRevision === null) {
    return currentEvaluationWithoutAnalysis(establishment, ['VERSIONED_CASE_REQUIRED']);
  }

  const currentBlockers = new Set<CurrentEstablishmentBlockerCode>();
  if (
    establishment.policyIdentifier !== demoBatchEstablishmentPolicy.policyIdentifier ||
    establishment.policyVersion !== demoBatchEstablishmentPolicy.policyVersion ||
    establishment.evaluatorKind !== demoBatchEstablishmentPolicy.evaluatorKind ||
    establishment.evaluatorIdentifier !== demoBatchEstablishmentPolicy.evaluatorIdentifier
  ) {
    currentBlockers.add('POLICY_UNSUPPORTED');
  }
  if (snapshot.materialRevision !== establishment.basisMaterialRevision) {
    currentBlockers.add('MATERIAL_REVISION_CHANGED');
  }

  let analysis: EffectiveInvestigationAnalysis;
  try {
    analysis = loadEffectiveAnalysis(database, snapshot, establishment.questionRef);
  } catch (error) {
    const mapped = mapAnalysisError(error);
    if (mapped.length > 0) {
      return currentEvaluationWithoutAnalysis(establishment, [
        ...currentBlockers,
        ...mapped
      ]);
    }
    return currentEvaluationWithoutAnalysis(establishment, [
      ...currentBlockers,
      'ANALYSIS_UNAVAILABLE'
    ]);
  }
  const evidence = listInvestigationEvidence(
    database,
    establishment.caseId,
    establishment.questionRef
  );
  const policy = evaluateDemoBatchEstablishmentPolicy({
    snapshot,
    analysis,
    evidence,
    targetClaimRef: establishment.claimRef
  });
  for (const blocker of policy.blockerCodes) currentBlockers.add(blocker);
  if (!sameRefs(establishment.basisClaimRefs, policy.basis.claimRefs)) {
    currentBlockers.add('CLAIM_BASIS_CHANGED');
  }
  if (!sameRefs(establishment.basisAssessmentRefs, policy.basis.assessmentRefs)) {
    currentBlockers.add('ASSESSMENT_BASIS_CHANGED');
  }
  if (!sameRefs(establishment.basisEvidenceRefs, policy.basis.evidenceRefs)) {
    currentBlockers.add('EVIDENCE_BASIS_CHANGED');
  }

  return {
    establishment,
    currentlyEligible: currentBlockers.size === 0,
    blockerCodes: sortCurrentBlockers(currentBlockers),
    currentBasis: policy.basis
  };
}
