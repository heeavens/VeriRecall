import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { CaseSnapshot } from '../../contracts/recall';
import { normalizeBatch } from '../alerts/normalization';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { readCaseSnapshot, type LifecycleContext } from '../workflow/case-lifecycle';
import {
  demoHumanAssessorIdentifier,
  type InvestigationAssessment
} from './assessments';
import {
  getInvestigationAssessmentChallengeRef,
  getInvestigationClaimChallengeRef,
  getInvestigationEstablishmentChallengeRef
} from './challenge-artifacts';
import {
  InvestigationChallengeError,
  resolveCurrentInvestigationChallengeForWrite
} from './challenges';
import {
  EffectiveAnalysisError,
  readChallengeEffectiveInvestigationAnalysisInTransaction,
  type ChallengeEffectiveInvestigationAnalysis
} from './effective-analysis';
import {
  evaluateDemoBatchSourceDiversity,
  getInvestigationEstablishment,
  type DemoBatchSourceDiversityBlockerCode,
  type InvestigationEstablishment
} from './establishments';
import {
  listInvestigationEvidence,
  type InvestigationEvidence
} from './evidence-registry';

export const demoChallengeBatchEstablishmentPolicy = {
  policyIdentifier: 'demo-challenge-batch-establishment',
  policyVersion: 'v1',
  evaluatorKind: 'RULE',
  evaluatorIdentifier: 'demo-challenge-batch-establishment-policy-engine'
} as const;

export type DemoChallengeBatchEstablishmentBlockerCode =
  | 'CONTEXT_MISMATCH'
  | 'IDENTITY_NOT_KNOWN_MATCH'
  | 'AUTHORITATIVE_BATCH_NOT_KNOWN'
  | 'AUTHORITATIVE_BATCH_AMBIGUOUS'
  | 'AUTHORITATIVE_BATCH_CLAIM_MISSING'
  | 'NOT_DEMO'
  | 'TARGET_NOT_ACTIVE'
  | 'TARGET_NOT_SELECTED_CHALLENGE'
  | 'TARGET_TYPE_UNSUPPORTED'
  | 'AI_TARGET_UNSUPPORTED'
  | 'LOT_EMPTY'
  | 'EVIDENCE_CORPUS_EMPTY'
  | 'EVIDENCE_CORPUS_INVALID'
  | 'EVIDENCE_CORPUS_INCOMPLETE'
  | DemoBatchSourceDiversityBlockerCode
  | 'HUMAN_SUPPORT_MISSING'
  | 'HUMAN_SUPPORT_NOT_CURRENT'
  | 'HUMAN_SUPPORT_INCOMPLETE'
  | 'TARGET_REJECTED'
  | 'ACTIVE_CLAIM_INSUFFICIENT'
  | 'QUESTION_INSUFFICIENT'
  | 'ACTIVE_CONTRADICTION'
  | 'DIVERGENT_ACTIVE_CLAIM_NOT_REJECTED'
  | 'ANALYSIS_AMBIGUOUS';

const blockerOrder: DemoChallengeBatchEstablishmentBlockerCode[] = [
  'CONTEXT_MISMATCH',
  'IDENTITY_NOT_KNOWN_MATCH',
  'AUTHORITATIVE_BATCH_NOT_KNOWN',
  'AUTHORITATIVE_BATCH_AMBIGUOUS',
  'AUTHORITATIVE_BATCH_CLAIM_MISSING',
  'NOT_DEMO',
  'TARGET_NOT_ACTIVE',
  'TARGET_NOT_SELECTED_CHALLENGE',
  'TARGET_TYPE_UNSUPPORTED',
  'AI_TARGET_UNSUPPORTED',
  'LOT_EMPTY',
  'EVIDENCE_CORPUS_EMPTY',
  'EVIDENCE_CORPUS_INVALID',
  'EVIDENCE_CORPUS_INCOMPLETE',
  'INSUFFICIENT_STRUCTURED_EVIDENCE',
  'SOURCE_IDENTIFIER_DIVERSITY_MISSING',
  'INTEGRITY_HASH_DIVERSITY_MISSING',
  'SOURCE_CLASS_COMBINATION_MISSING',
  'HUMAN_SUPPORT_MISSING',
  'HUMAN_SUPPORT_NOT_CURRENT',
  'HUMAN_SUPPORT_INCOMPLETE',
  'TARGET_REJECTED',
  'ACTIVE_CLAIM_INSUFFICIENT',
  'QUESTION_INSUFFICIENT',
  'ACTIVE_CONTRADICTION',
  'DIVERGENT_ACTIVE_CLAIM_NOT_REJECTED',
  'ANALYSIS_AMBIGUOUS'
];

export interface DemoChallengeBatchEstablishmentBasis {
  claimRefs: string[];
  assessmentRefs: string[];
  evidenceRefs: string[];
}

export interface DemoChallengeBatchEstablishmentPolicyEvaluation {
  eligible: boolean;
  blockerCodes: DemoChallengeBatchEstablishmentBlockerCode[];
  basis: DemoChallengeBatchEstablishmentBasis;
  targetLot: string | null;
  targetSupportAssessmentRefs: string[];
  reliedUponRejectionAssessmentRefs: string[];
}

export interface EvaluateDemoChallengeBatchEstablishmentPolicyInput {
  snapshot: CaseSnapshot;
  projection: ChallengeEffectiveInvestigationAnalysis;
  evidence: readonly InvestigationEvidence[];
  targetClaimRef: string;
  claimChallengeRef: string | null;
  claimChallengeRefs: ReadonlyMap<string, string | null>;
  assessmentChallengeRefs: ReadonlyMap<string, string | null>;
}

const opaqueReferenceSchema = z.string().min(1).max(500).refine(
  (value) => value.trim().length > 0,
  'References must contain a non-whitespace character.'
);

const recordChallengeBatchEstablishmentInputSchema = z.strictObject({
  establishmentRef: z.string().uuid(),
  caseId: z.string().uuid(),
  questionRef: opaqueReferenceSchema,
  challengeRef: z.string().uuid(),
  claimRef: z.string().uuid(),
  expectedCaseVersion: z.number().int().positive(),
  expectedMaterialRevision: z.number().int().positive(),
  demo: z.literal(true)
});

export type RecordInvestigationChallengeBatchEstablishmentInput = z.infer<
  typeof recordChallengeBatchEstablishmentInputSchema
>;

export type InvestigationChallengeBatchEstablishmentErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'ESTABLISHMENT_NOT_FOUND'
  | 'ESTABLISHMENT_CONFLICT'
  | 'CHALLENGE_ASSOCIATION_REQUIRED'
  | 'CHALLENGE_NOT_FOUND'
  | 'CHALLENGE_NOT_CURRENT'
  | 'QUESTION_OWNERSHIP_MISMATCH'
  | 'VERSIONED_CASE_REQUIRED'
  | 'STALE_CASE_VERSION'
  | 'STALE_MATERIAL_REVISION'
  | 'POLICY_NOT_SATISFIED'
  | 'ANALYSIS_UNAVAILABLE';

export class InvestigationChallengeBatchEstablishmentError extends Error {
  constructor(
    public readonly code: InvestigationChallengeBatchEstablishmentErrorCode,
    message: string,
    public readonly blockerCodes: DemoChallengeBatchEstablishmentBlockerCode[] = []
  ) {
    super(message);
    this.name = 'InvestigationChallengeBatchEstablishmentError';
  }
}

export type CurrentChallengeBatchEstablishmentBlockerCode =
  | DemoChallengeBatchEstablishmentBlockerCode
  | 'POLICY_UNSUPPORTED'
  | 'CHALLENGE_NOT_CURRENT'
  | 'ANALYSIS_UNAVAILABLE'
  | 'MATERIAL_REVISION_CHANGED'
  | 'CLAIM_BASIS_CHANGED'
  | 'ASSESSMENT_BASIS_CHANGED'
  | 'EVIDENCE_BASIS_CHANGED';

const currentBlockerOrder: CurrentChallengeBatchEstablishmentBlockerCode[] = [
  'POLICY_UNSUPPORTED',
  'CHALLENGE_NOT_CURRENT',
  'ANALYSIS_UNAVAILABLE',
  'MATERIAL_REVISION_CHANGED',
  ...blockerOrder,
  'CLAIM_BASIS_CHANGED',
  'ASSESSMENT_BASIS_CHANGED',
  'EVIDENCE_BASIS_CHANGED'
];

export interface CurrentInvestigationChallengeBatchEstablishmentEvaluation {
  establishment: InvestigationEstablishment;
  challengeRef: string;
  currentlyEligible: boolean;
  blockerCodes: CurrentChallengeBatchEstablishmentBlockerCode[];
  currentBasis: DemoChallengeBatchEstablishmentBasis | null;
  targetLot: string | null;
}

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

function sortedBlockers(
  blockers: Iterable<DemoChallengeBatchEstablishmentBlockerCode>
): DemoChallengeBatchEstablishmentBlockerCode[] {
  return [...new Set(blockers)].sort((left, right) =>
    blockerOrder.indexOf(left) - blockerOrder.indexOf(right)
  );
}

function sortedCurrentBlockers(
  blockers: Iterable<CurrentChallengeBatchEstablishmentBlockerCode>
): CurrentChallengeBatchEstablishmentBlockerCode[] {
  return [...new Set(blockers)].sort((left, right) =>
    currentBlockerOrder.indexOf(left) - currentBlockerOrder.indexOf(right)
  );
}

function isTrustedRejection(assessment: InvestigationAssessment): boolean {
  return assessment.assessorKind === 'RULE' ||
    (assessment.assessorKind === 'HUMAN' &&
      assessment.assessorIdentifier === demoHumanAssessorIdentifier);
}

export function evaluateDemoChallengeBatchEstablishmentPolicy(
  input: EvaluateDemoChallengeBatchEstablishmentPolicyInput
): DemoChallengeBatchEstablishmentPolicyEvaluation {
  const { snapshot, projection, evidence, targetClaimRef } = input;
  const { analysis, analysisContext } = projection;
  const blockers = new Set<DemoChallengeBatchEstablishmentBlockerCode>();
  const basis: DemoChallengeBatchEstablishmentBasis = {
    claimRefs: canonicalRefs(analysis.activeClaims.map((claim) => claim.claimRef)),
    assessmentRefs: canonicalRefs(
      analysis.structuralAssessmentHeads.map((assessment) => assessment.assessmentRef)
    ),
    evidenceRefs: canonicalRefs(evidence.map((item) => item.evidenceRef))
  };

  if (
    snapshot.caseId !== analysis.caseId ||
    snapshot.productId !== analysis.productId ||
    snapshot.caseVersion !== analysisContext.currentCaseVersion ||
    snapshot.materialRevision !== analysisContext.currentMaterialRevision ||
    snapshot.caseVersion !== analysis.currentCaseVersion ||
    snapshot.materialRevision !== analysis.currentMaterialRevision
  ) {
    blockers.add('CONTEXT_MISMATCH');
  }
  if (
    snapshot.investigation?.identity.knowledgeStatus !== 'KNOWN' ||
    snapshot.investigation.identity.conclusion !== 'MATCH'
  ) {
    blockers.add('IDENTITY_NOT_KNOWN_MATCH');
  }
  const scope = snapshot.investigation?.scope;
  let authoritativeLot: string | null = null;
  if (scope?.kind !== 'BATCH_LOT' || scope.knowledgeStatus !== 'KNOWN') {
    blockers.add('AUTHORITATIVE_BATCH_NOT_KNOWN');
  } else {
    const authoritativeLots = canonicalRefs(scope.lots.map((lot) => normalizeBatch(lot)));
    if (authoritativeLots.length !== 1 || authoritativeLots[0].length === 0) {
      blockers.add('AUTHORITATIVE_BATCH_AMBIGUOUS');
    } else {
      authoritativeLot = authoritativeLots[0];
    }
  }

  if (
    authoritativeLot !== null &&
    !analysis.activeClaims.some((claim) =>
      input.claimChallengeRefs.get(claim.claimRef) === null &&
      normalizeBatch(claim.value.lot) === authoritativeLot
    )
  ) {
    blockers.add('AUTHORITATIVE_BATCH_CLAIM_MISSING');
  }

  const target = analysis.activeClaims.find((claim) => claim.claimRef === targetClaimRef);
  if (!target) blockers.add('TARGET_NOT_ACTIVE');
  if (input.claimChallengeRef !== analysisContext.challengeRef) {
    blockers.add('TARGET_NOT_SELECTED_CHALLENGE');
  }
  if (target && target.claimType !== 'AFFECTED_BATCH_LOT') {
    blockers.add('TARGET_TYPE_UNSUPPORTED');
  }
  if (target?.originKind === 'AI_PROPOSED') blockers.add('AI_TARGET_UNSUPPORTED');
  const targetLot = target ? normalizeBatch(target.value.lot) : '';
  if (target && targetLot.length === 0) blockers.add('LOT_EMPTY');

  const evidenceRefs = evidence.map((item) => item.evidenceRef);
  if (evidence.length === 0) blockers.add('EVIDENCE_CORPUS_EMPTY');
  if (
    new Set(evidenceRefs).size !== evidenceRefs.length ||
    evidence.some((item) =>
      item.caseId !== analysis.caseId || item.questionRef !== analysis.questionRef
    )
  ) {
    blockers.add('EVIDENCE_CORPUS_INVALID');
  }
  const evidenceByRef = new Map(evidence.map((item) => [item.evidenceRef, item]));
  const targetEvidence = target?.evidenceRefs.map((ref) => evidenceByRef.get(ref)) ?? [];
  if (targetEvidence.some((item) => item === undefined)) {
    blockers.add('EVIDENCE_CORPUS_INCOMPLETE');
  }
  for (const blocker of evaluateDemoBatchSourceDiversity(
    targetEvidence.filter((item): item is InvestigationEvidence => item !== undefined)
  )) {
    blockers.add(blocker);
  }

  const structuralTargetSupports = analysis.structuralAssessmentHeads.filter((assessment) =>
    assessment.verdict === 'SUPPORTED' &&
    assessment.targetClaimRef === targetClaimRef &&
    assessment.assessorKind === 'HUMAN' &&
    assessment.assessorIdentifier === demoHumanAssessorIdentifier &&
    input.assessmentChallengeRefs.get(assessment.assessmentRef) === analysisContext.challengeRef
  );
  const materiallyCurrentRefs = new Set(
    analysis.materiallyCurrentAssessmentHeads.map((assessment) => assessment.assessmentRef)
  );
  const currentTargetSupports = structuralTargetSupports.filter((assessment) =>
    materiallyCurrentRefs.has(assessment.assessmentRef)
  );
  if (structuralTargetSupports.length === 0) {
    blockers.add('HUMAN_SUPPORT_MISSING');
  } else if (currentTargetSupports.length === 0) {
    blockers.add('HUMAN_SUPPORT_NOT_CURRENT');
  } else if (!currentTargetSupports.some((assessment) =>
    sameRefs(assessment.evidenceRefs, basis.evidenceRefs)
  )) {
    blockers.add('HUMAN_SUPPORT_INCOMPLETE');
  }

  const targetAnalysis = analysis.targetedAssessments.find(
    (state) => state.claimRef === targetClaimRef
  );
  if ((targetAnalysis?.rejectedAssessmentRefs.length ?? 0) > 0) {
    blockers.add('TARGET_REJECTED');
  }
  if (analysis.targetedAssessments.some(
    (state) => state.insufficientAssessmentRefs.length > 0
  )) {
    blockers.add('ACTIVE_CLAIM_INSUFFICIENT');
  }
  if (analysis.questionLevelInsufficientAssessmentRefs.length > 0) {
    blockers.add('QUESTION_INSUFFICIENT');
  }
  if (analysis.activeContradictions.length > 0) blockers.add('ACTIVE_CONTRADICTION');

  const materiallyCurrentByRef = new Map(
    analysis.materiallyCurrentAssessmentHeads.map((assessment) => [
      assessment.assessmentRef,
      assessment
    ])
  );
  const reliedUponRejections: string[] = [];
  if (target && targetLot.length > 0) {
    for (const alternative of analysis.activeClaims) {
      if (
        alternative.claimRef === target.claimRef ||
        normalizeBatch(alternative.value.lot) === targetLot
      ) {
        continue;
      }
      const state = analysis.targetedAssessments.find(
        (item) => item.claimRef === alternative.claimRef
      );
      const trustedRejections = (state?.rejectedAssessmentRefs ?? []).filter((ref) => {
        const assessment = materiallyCurrentByRef.get(ref);
        return assessment !== undefined &&
          input.assessmentChallengeRefs.get(ref) === analysisContext.challengeRef &&
          isTrustedRejection(assessment);
      });
      if (trustedRejections.length === 0) {
        blockers.add('DIVERGENT_ACTIVE_CLAIM_NOT_REJECTED');
      } else {
        reliedUponRejections.push(...trustedRejections);
      }
    }
  }

  if (analysis.ambiguities.length > 0) blockers.add('ANALYSIS_AMBIGUOUS');
  if (
    !snapshot.demo ||
    !target?.demo ||
    evidence.some((item) => !item.demo) ||
    analysis.structuralAssessmentHeads.some((assessment) => !assessment.demo)
  ) {
    blockers.add('NOT_DEMO');
  }

  const blockerCodes = sortedBlockers(blockers);
  return {
    eligible: blockerCodes.length === 0,
    blockerCodes,
    basis,
    targetLot: targetLot.length > 0 ? targetLot : null,
    targetSupportAssessmentRefs: canonicalRefs(
      currentTargetSupports.map((assessment) => assessment.assessmentRef)
    ),
    reliedUponRejectionAssessmentRefs: canonicalRefs(reliedUponRejections)
  };
}

function parseRecordInput(input: unknown): RecordInvestigationChallengeBatchEstablishmentInput {
  const parsed = recordChallengeBatchEstablishmentInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigationChallengeBatchEstablishmentError(
      'INVALID_INPUT',
      'Invalid Challenge batch Establishment record.'
    );
  }
  return parsed.data;
}

function immutableSemanticsMatch(
  establishment: InvestigationEstablishment,
  input: RecordInvestigationChallengeBatchEstablishmentInput,
  challengeRef: string | null
): boolean {
  return establishment.establishmentRef === input.establishmentRef &&
    establishment.caseId === input.caseId &&
    establishment.questionRef === input.questionRef &&
    establishment.claimRef === input.claimRef &&
    establishment.demo === input.demo &&
    challengeRef === input.challengeRef;
}

function mapChallengeAuthorizationError(error: InvestigationChallengeError): never {
  if (error.code === 'CHALLENGE_NOT_FOUND') {
    throw new InvestigationChallengeBatchEstablishmentError('CHALLENGE_NOT_FOUND', error.message);
  }
  if (error.code === 'QUESTION_OWNERSHIP_MISMATCH') {
    throw new InvestigationChallengeBatchEstablishmentError(
      'QUESTION_OWNERSHIP_MISMATCH',
      error.message
    );
  }
  if (error.code === 'STALE_CASE_VERSION') {
    throw new InvestigationChallengeBatchEstablishmentError('STALE_CASE_VERSION', error.message);
  }
  if (error.code === 'STALE_MATERIAL_REVISION') {
    throw new InvestigationChallengeBatchEstablishmentError(
      'STALE_MATERIAL_REVISION',
      error.message
    );
  }
  if (error.code === 'VERSIONED_CASE_REQUIRED') {
    throw new InvestigationChallengeBatchEstablishmentError(
      'VERSIONED_CASE_REQUIRED',
      error.message
    );
  }
  throw new InvestigationChallengeBatchEstablishmentError('CHALLENGE_NOT_CURRENT', error.message);
}

function loadPolicyInput(
  database: RecallDatabase,
  snapshot: CaseSnapshot,
  caseId: string,
  questionRef: string,
  challengeRef: string,
  claimRef: string
): EvaluateDemoChallengeBatchEstablishmentPolicyInput {
  let projection: ChallengeEffectiveInvestigationAnalysis;
  try {
    projection = readChallengeEffectiveInvestigationAnalysisInTransaction(
      database,
      caseId,
      questionRef,
      challengeRef
    );
  } catch (error) {
    if (error instanceof EffectiveAnalysisError) {
      if (error.code === 'CHALLENGE_NOT_FOUND') {
        throw new InvestigationChallengeBatchEstablishmentError(
          'CHALLENGE_NOT_FOUND',
          error.message
        );
      }
      if (error.code === 'CHALLENGE_NOT_CURRENT') {
        throw new InvestigationChallengeBatchEstablishmentError(
          'CHALLENGE_NOT_CURRENT',
          error.message
        );
      }
      if (error.code === 'QUESTION_OWNERSHIP_MISMATCH') {
        throw new InvestigationChallengeBatchEstablishmentError(
          'QUESTION_OWNERSHIP_MISMATCH',
          error.message
        );
      }
      throw new InvestigationChallengeBatchEstablishmentError(
        'ANALYSIS_UNAVAILABLE',
        'Current Challenge Effective Analysis could not be derived.'
      );
    }
    throw error;
  }

  return {
    snapshot,
    projection,
    evidence: listInvestigationEvidence(database, caseId, questionRef),
    targetClaimRef: claimRef,
    claimChallengeRef: getInvestigationClaimChallengeRef(database, claimRef),
    claimChallengeRefs: new Map(
      projection.analysis.activeClaims.map((claim) => [
        claim.claimRef,
        getInvestigationClaimChallengeRef(database, claim.claimRef)
      ])
    ),
    assessmentChallengeRefs: new Map(
      projection.analysis.structuralAssessmentHeads.map((assessment) => [
        assessment.assessmentRef,
        getInvestigationAssessmentChallengeRef(database, assessment.assessmentRef)
      ])
    )
  };
}

export function getInvestigationChallengeBatchEstablishment(
  database: RecallDatabase,
  caseId: string,
  establishmentRef: string
): InvestigationEstablishment | null {
  const establishment = getInvestigationEstablishment(database, caseId, establishmentRef);
  if (!establishment) return null;
  const challengeRef = getInvestigationEstablishmentChallengeRef(database, establishmentRef);
  if (challengeRef === null) return null;
  const challenge = database.select({
    caseId: schema.investigationChallenges.caseId,
    questionRef: schema.investigationChallenges.questionRef,
    demo: schema.investigationChallenges.demo
  }).from(schema.investigationChallenges).where(eq(
    schema.investigationChallenges.challengeRef,
    challengeRef
  )).get();
  if (
    !challenge ||
    challenge.caseId !== establishment.caseId ||
    challenge.questionRef !== establishment.questionRef ||
    challenge.demo !== establishment.demo
  ) {
    throw new InvestigationChallengeBatchEstablishmentError(
      'CHALLENGE_ASSOCIATION_REQUIRED',
      'The Establishment Challenge association has invalid ownership.'
    );
  }
  return establishment;
}

export function recordInvestigationChallengeBatchEstablishment(
  database: RecallDatabase,
  input: unknown,
  context: LifecycleContext,
  now = new Date()
): { establishment: InvestigationEstablishment; challengeRef: string; replayed: boolean } {
  if (context.mode !== 'demo') {
    throw new InvestigationChallengeBatchEstablishmentError(
      'FORBIDDEN',
      'Challenge batch Establishment requires explicit local demo mode.'
    );
  }
  const parsed = parseRecordInput(input);

  return database.transaction((transaction) => {
    const existingIdentity = transaction.select({
      caseId: schema.investigationEstablishments.caseId
    }).from(schema.investigationEstablishments).where(eq(
      schema.investigationEstablishments.establishmentRef,
      parsed.establishmentRef
    )).get();
    const existing = getInvestigationEstablishment(
      transaction,
      existingIdentity?.caseId ?? parsed.caseId,
      parsed.establishmentRef
    );
    if (existing) {
      const associatedChallengeRef = getInvestigationEstablishmentChallengeRef(
        transaction,
        parsed.establishmentRef
      );
      if (
        !immutableSemanticsMatch(existing, parsed, associatedChallengeRef) ||
        getInvestigationChallengeBatchEstablishment(
          transaction,
          existing.caseId,
          existing.establishmentRef
        ) === null
      ) {
        throw new InvestigationChallengeBatchEstablishmentError(
          'ESTABLISHMENT_CONFLICT',
          'This Establishment reference identifies different immutable semantics or context.'
        );
      }
      return {
        establishment: existing,
        challengeRef: associatedChallengeRef!,
        replayed: true
      };
    }

    let authorization;
    try {
      authorization = resolveCurrentInvestigationChallengeForWrite(transaction, {
        caseId: parsed.caseId,
        questionRef: parsed.questionRef,
        challengeRef: parsed.challengeRef,
        expectedCaseVersion: parsed.expectedCaseVersion,
        expectedMaterialRevision: parsed.expectedMaterialRevision,
        demo: parsed.demo
      });
    } catch (error) {
      if (error instanceof InvestigationChallengeError) mapChallengeAuthorizationError(error);
      throw error;
    }

    const policy = evaluateDemoChallengeBatchEstablishmentPolicy(loadPolicyInput(
      transaction,
      authorization.snapshot,
      parsed.caseId,
      parsed.questionRef,
      parsed.challengeRef,
      parsed.claimRef
    ));
    if (!policy.eligible) {
      throw new InvestigationChallengeBatchEstablishmentError(
        'POLICY_NOT_SATISFIED',
        'The deterministic Challenge batch Establishment policy did not pass.',
        policy.blockerCodes
      );
    }

    const caseRecord = transaction.select({ alertId: schema.cases.alertId })
      .from(schema.cases)
      .where(eq(schema.cases.id, parsed.caseId))
      .get();
    if (!caseRecord) {
      throw new InvestigationChallengeBatchEstablishmentError(
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
      policyIdentifier: demoChallengeBatchEstablishmentPolicy.policyIdentifier,
      policyVersion: demoChallengeBatchEstablishmentPolicy.policyVersion,
      basisClaimRefsJson: JSON.stringify(policy.basis.claimRefs),
      basisAssessmentRefsJson: JSON.stringify(policy.basis.assessmentRefs),
      basisEvidenceRefsJson: JSON.stringify(policy.basis.evidenceRefs),
      evaluatorKind: demoChallengeBatchEstablishmentPolicy.evaluatorKind,
      evaluatorIdentifier: demoChallengeBatchEstablishmentPolicy.evaluatorIdentifier,
      basisCaseVersion: authorization.snapshot.caseVersion,
      basisMaterialRevision: authorization.snapshot.materialRevision!,
      createdAt,
      demo: true
    }).run();
    transaction.insert(schema.investigationChallengeEstablishments).values({
      establishmentRef: parsed.establishmentRef,
      challengeRef: parsed.challengeRef
    }).run();
    transaction.insert(schema.auditEvents).values({
      id: randomUUID(),
      caseId: parsed.caseId,
      alertId: caseRecord.alertId,
      eventType: 'investigation_establishment_recorded',
      actorType: 'agent',
      actorName: demoChallengeBatchEstablishmentPolicy.evaluatorIdentifier,
      summary: 'Recorded deterministic non-authoritative Challenge batch policy success.',
      metadataJson: JSON.stringify({
        establishmentRef: parsed.establishmentRef,
        caseId: parsed.caseId,
        questionRef: parsed.questionRef,
        challengeRef: parsed.challengeRef,
        claimRef: parsed.claimRef,
        ...demoChallengeBatchEstablishmentPolicy,
        basisClaimRefs: policy.basis.claimRefs,
        basisAssessmentRefs: policy.basis.assessmentRefs,
        basisEvidenceRefs: policy.basis.evidenceRefs,
        targetLot: policy.targetLot,
        targetSupportAssessmentRefs: policy.targetSupportAssessmentRefs,
        reliedUponRejectionAssessmentRefs: policy.reliedUponRejectionAssessmentRefs,
        basisCaseVersion: authorization.snapshot.caseVersion,
        basisMaterialRevision: authorization.snapshot.materialRevision,
        authorizationContext: 'OPEN_CHALLENGE',
        demo: true
      }),
      createdAt
    }).run();

    const establishment = getInvestigationEstablishment(
      transaction,
      parsed.caseId,
      parsed.establishmentRef
    );
    if (!establishment) throw new Error('Challenge batch Establishment insert did not persist.');
    return { establishment, challengeRef: parsed.challengeRef, replayed: false };
  }, { behavior: 'immediate' });
}

function currentEvaluationWithoutAnalysis(
  establishment: InvestigationEstablishment,
  challengeRef: string,
  blockerCodes: CurrentChallengeBatchEstablishmentBlockerCode[]
): CurrentInvestigationChallengeBatchEstablishmentEvaluation {
  return {
    establishment,
    challengeRef,
    currentlyEligible: false,
    blockerCodes: sortedCurrentBlockers(blockerCodes),
    currentBasis: null,
    targetLot: null
  };
}

export function evaluateCurrentInvestigationChallengeBatchEstablishment(
  database: RecallDatabase,
  caseId: string,
  establishmentRef: string
): CurrentInvestigationChallengeBatchEstablishmentEvaluation | null {
  return database.transaction((transaction) =>
    evaluateCurrentInvestigationChallengeBatchEstablishmentInTransaction(
      transaction,
      caseId,
      establishmentRef
    )
  );
}

/** Evaluate Challenge Establishment inside a transaction already owned by the caller. */
export function evaluateCurrentInvestigationChallengeBatchEstablishmentInTransaction(
  database: RecallDatabase,
  caseId: string,
  establishmentRef: string
): CurrentInvestigationChallengeBatchEstablishmentEvaluation | null {
  const parsed = z.strictObject({
    caseId: z.string().uuid(),
    establishmentRef: z.string().uuid()
  }).safeParse({ caseId, establishmentRef });
  if (!parsed.success) {
    throw new InvestigationChallengeBatchEstablishmentError(
      'INVALID_INPUT',
      'Invalid current Challenge batch Establishment lookup.'
    );
  }
  const establishment = getInvestigationEstablishment(
    database,
    parsed.data.caseId,
    parsed.data.establishmentRef
  );
  if (!establishment) return null;
  const challengeRef = getInvestigationEstablishmentChallengeRef(
    database,
    establishment.establishmentRef
  );
  if (challengeRef === null) {
    throw new InvestigationChallengeBatchEstablishmentError(
      'CHALLENGE_ASSOCIATION_REQUIRED',
      'The Establishment is not associated with an investigation Challenge.'
    );
  }
  const currentBlockers = new Set<CurrentChallengeBatchEstablishmentBlockerCode>();
  if (
    establishment.policyIdentifier !== demoChallengeBatchEstablishmentPolicy.policyIdentifier ||
    establishment.policyVersion !== demoChallengeBatchEstablishmentPolicy.policyVersion ||
    establishment.evaluatorKind !== demoChallengeBatchEstablishmentPolicy.evaluatorKind ||
    establishment.evaluatorIdentifier !== demoChallengeBatchEstablishmentPolicy.evaluatorIdentifier
  ) {
    currentBlockers.add('POLICY_UNSUPPORTED');
  }
  const snapshot = readCaseSnapshot(database, establishment.caseId);
  if (!snapshot?.investigation || snapshot.materialRevision === null) {
    return currentEvaluationWithoutAnalysis(
      establishment,
      challengeRef,
      [...currentBlockers, 'ANALYSIS_UNAVAILABLE']
    );
  }
  if (snapshot.materialRevision !== establishment.basisMaterialRevision) {
    currentBlockers.add('MATERIAL_REVISION_CHANGED');
  }

  let policyInput: EvaluateDemoChallengeBatchEstablishmentPolicyInput;
  try {
    policyInput = loadPolicyInput(
      database,
      snapshot,
      establishment.caseId,
      establishment.questionRef,
      challengeRef,
      establishment.claimRef
    );
  } catch (error) {
    if (
      error instanceof InvestigationChallengeBatchEstablishmentError &&
      error.code === 'CHALLENGE_NOT_CURRENT'
    ) {
      return currentEvaluationWithoutAnalysis(
        establishment,
        challengeRef,
        [...currentBlockers, 'CHALLENGE_NOT_CURRENT']
      );
    }
    if (error instanceof InvestigationChallengeBatchEstablishmentError) {
      return currentEvaluationWithoutAnalysis(
        establishment,
        challengeRef,
        [...currentBlockers, 'ANALYSIS_UNAVAILABLE']
      );
    }
    throw error;
  }

  const policy = evaluateDemoChallengeBatchEstablishmentPolicy(policyInput);
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
    challengeRef,
    currentlyEligible: currentBlockers.size === 0,
    blockerCodes: sortedCurrentBlockers(currentBlockers),
    currentBasis: policy.basis,
    targetLot: policy.targetLot
  };
}
