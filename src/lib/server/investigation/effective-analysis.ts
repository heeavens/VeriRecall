import { eq } from 'drizzle-orm';

import type { CaseSnapshot } from '../../contracts/recall';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import {
  listInvestigationAssessments,
  type InvestigationAssessment
} from './assessments';
import {
  classifyEvidenceForInvestigationChallenge,
  getInvestigationAssessmentChallengeRef,
  getInvestigationClaimChallengeRef,
  getInvestigationRequestChallengeRef,
  type ChallengeArtifactPartition
} from './challenge-artifacts';
import {
  getInvestigationChallenge,
  InvestigationChallengeError,
  listInvestigationChallenges,
  resolveCurrentInvestigationChallengeForRead,
  type CurrentInvestigationChallengeForRead
} from './challenges';
import {
  listInvestigationClaims,
  type InvestigationClaim
} from './claims';
import {
  assertInvestigationEvidenceRequestOwnership,
  listInvestigationEvidence,
  type InvestigationEvidence
} from './evidence-registry';
import { getCaseHistory, readCaseSnapshot } from '../workflow/case-lifecycle';

export type EffectiveAnalysisErrorCode =
  | 'VERSIONED_CASE_REQUIRED'
  | 'QUESTION_NOT_CURRENT'
  | 'QUESTION_AMBIGUOUS'
  | 'INVALID_CLAIM_STATE'
  | 'INVALID_ASSESSMENT_STATE'
  | 'INVALID_SUPERSESSION_GRAPH'
  | 'CHALLENGE_NOT_FOUND'
  | 'CHALLENGE_NOT_CURRENT'
  | 'QUESTION_OWNERSHIP_MISMATCH'
  | 'CHALLENGE_GRAPH_BOUNDARY_INVALID'
  | 'CHALLENGE_BASELINE_UNPROVEN';

export class EffectiveAnalysisError extends Error {
  constructor(
    public readonly code: EffectiveAnalysisErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'EffectiveAnalysisError';
  }
}

export type AssessmentStaleReason =
  | 'ASSESSMENT_SUPERSEDED'
  | 'CLAIM_SUPERSEDED'
  | 'MATERIAL_REVISION_STALE'
  | 'BASIS_REVISION_UNRESOLVED'
  | 'UNSUPPORTED_CLAIM_BASIS';

export type AnalysisAmbiguityCode =
  | 'CLAIM_SUPPORTED_AND_REJECTED'
  | 'CLAIM_SUPPORTED_AND_INSUFFICIENT'
  | 'SUPPORTED_CLAIM_IN_CONTRADICTION'
  | 'ASSESSMENT_BRANCHING';

export interface CaseRevisionBasis {
  caseVersion: number;
  materialRevision: number | null;
}

export interface ProjectEffectiveInvestigationAnalysisInput {
  snapshot: CaseSnapshot;
  questionRef: string;
  claims: readonly InvestigationClaim[];
  assessments: readonly InvestigationAssessment[];
  caseRevisions: readonly CaseRevisionBasis[];
}

export interface StaleAssessment {
  assessment: InvestigationAssessment;
  reasons: AssessmentStaleReason[];
}

export interface TargetedAssessmentState {
  claimRef: string;
  supportedAssessmentRefs: string[];
  insufficientAssessmentRefs: string[];
  rejectedAssessmentRefs: string[];
}

export interface ActiveContradictionGroup {
  assessmentRef: string;
  relatedClaimRefs: string[];
}

export interface AnalysisAmbiguity {
  code: AnalysisAmbiguityCode;
  claimRefs: string[];
  assessmentRefs: string[];
}

export interface EffectiveInvestigationAnalysis {
  caseId: string;
  questionRef: string;
  productId: string;
  currentCaseVersion: number;
  currentMaterialRevision: number;
  activeClaims: InvestigationClaim[];
  inactiveClaimRefs: string[];
  structuralAssessmentHeads: InvestigationAssessment[];
  applicableAssessmentHeads: InvestigationAssessment[];
  materiallyCurrentAssessmentHeads: InvestigationAssessment[];
  staleAssessments: StaleAssessment[];
  targetedAssessments: TargetedAssessmentState[];
  questionLevelInsufficientAssessmentRefs: string[];
  activeContradictions: ActiveContradictionGroup[];
  ambiguities: AnalysisAmbiguity[];
}

export interface ChallengeEffectiveInvestigationAnalysis {
  analysisContext: {
    kind: 'OPEN_CHALLENGE';
    challengeRef: string;
    challengedRevisionId: string;
    challengedMaterialRevision: number;
    currentCaseVersion: number;
    currentMaterialRevision: number;
  };
  projectionBasis: {
    claimRefs: string[];
    assessmentRefs: string[];
    referencedEvidenceRefs: string[];
  };
  analysis: EffectiveInvestigationAnalysis;
}

const staleReasonOrder: AssessmentStaleReason[] = [
  'ASSESSMENT_SUPERSEDED',
  'CLAIM_SUPERSEDED',
  'MATERIAL_REVISION_STALE',
  'BASIS_REVISION_UNRESOLVED',
  'UNSUPPORTED_CLAIM_BASIS'
];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareClaim(left: InvestigationClaim, right: InvestigationClaim): number {
  return compareText(left.createdAt, right.createdAt) || compareText(left.claimRef, right.claimRef);
}

function compareAssessment(
  left: InvestigationAssessment,
  right: InvestigationAssessment
): number {
  return compareText(left.createdAt, right.createdAt) ||
    compareText(left.assessmentRef, right.assessmentRef);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function addReason(reasons: AssessmentStaleReason[], reason: AssessmentStaleReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function sortReasons(reasons: AssessmentStaleReason[]): AssessmentStaleReason[] {
  return reasons.sort((left, right) =>
    staleReasonOrder.indexOf(left) - staleReasonOrder.indexOf(right)
  );
}

function validateSupersessionGraph<T>(
  records: readonly T[],
  getId: (record: T) => string,
  getParentId: (record: T) => string | null,
  stateErrorCode: 'INVALID_CLAIM_STATE' | 'INVALID_ASSESSMENT_STATE'
): { recordsById: Map<string, T>; supersededIds: Set<string> } {
  const recordsById = new Map<string, T>();
  for (const record of records) {
    const id = getId(record);
    if (recordsById.has(id)) {
      throw new EffectiveAnalysisError(stateErrorCode, 'Analysis history contains a duplicate identifier.');
    }
    recordsById.set(id, record);
  }

  const supersededIds = new Set<string>();
  for (const record of records) {
    const id = getId(record);
    const parentId = getParentId(record);
    if (parentId === null) continue;
    if (parentId === id || !recordsById.has(parentId)) {
      throw new EffectiveAnalysisError(
        'INVALID_SUPERSESSION_GRAPH',
        'Analysis history contains a self-reference or dangling supersession reference.'
      );
    }
    supersededIds.add(parentId);
  }

  for (const record of records) {
    const visited = new Set<string>();
    let currentId: string | null = getId(record);
    while (currentId !== null) {
      if (visited.has(currentId)) {
        throw new EffectiveAnalysisError(
          'INVALID_SUPERSESSION_GRAPH',
          'Analysis history contains a supersession cycle.'
        );
      }
      visited.add(currentId);
      const current = recordsById.get(currentId);
      if (!current) break;
      currentId = getParentId(current);
    }
  }

  return { recordsById, supersededIds };
}

function assessmentClaimRefs(assessment: InvestigationAssessment): string[] | null {
  const related = assessment.relatedClaimRefs;
  const uniqueRelated = new Set(related).size === related.length;
  if (!uniqueRelated) return null;

  if (assessment.verdict === 'SUPPORTED' || assessment.verdict === 'REJECTED') {
    return assessment.targetClaimRef !== null && related.length === 0
      ? [assessment.targetClaimRef]
      : null;
  }
  if (assessment.verdict === 'INSUFFICIENT') {
    return related.length === 0
      ? assessment.targetClaimRef === null ? [] : [assessment.targetClaimRef]
      : null;
  }
  return assessment.targetClaimRef === null && related.length >= 2
    ? [...related]
    : null;
}

function validateCurrentQuestion(snapshot: CaseSnapshot, questionRef: string): number {
  if (!snapshot.investigation || snapshot.materialRevision === null) {
    throw new EffectiveAnalysisError(
      'VERSIONED_CASE_REQUIRED',
      'Effective analysis requires an authoritative versioned investigation.'
    );
  }
  const matchingGaps = snapshot.investigation.gaps.filter((gap) => gap.id === questionRef);
  if (matchingGaps.length > 1) {
    throw new EffectiveAnalysisError(
      'QUESTION_AMBIGUOUS',
      'The current investigation contains a duplicated gap identity.'
    );
  }
  if (matchingGaps.length === 0 || matchingGaps[0].code !== 'BATCH_MISSING') {
    throw new EffectiveAnalysisError(
      'QUESTION_NOT_CURRENT',
      'Effective analysis supports only an exact current BATCH_MISSING gap.'
    );
  }
  return snapshot.materialRevision;
}

function validateClaimOwnership(
  claims: readonly InvestigationClaim[],
  snapshot: CaseSnapshot,
  questionRef: string
): void {
  if (claims.some((claim) =>
    claim.caseId !== snapshot.caseId ||
    claim.questionRef !== questionRef ||
    claim.subjectRef !== snapshot.productId ||
    claim.claimType !== 'AFFECTED_BATCH_LOT'
  )) {
    throw new EffectiveAnalysisError(
      'INVALID_CLAIM_STATE',
      'Claim history is outside the authoritative case, question, product, or supported type.'
    );
  }
}

function validateAssessmentOwnership(
  assessments: readonly InvestigationAssessment[],
  snapshot: CaseSnapshot,
  questionRef: string
): void {
  if (assessments.some((assessment) =>
    assessment.caseId !== snapshot.caseId || assessment.questionRef !== questionRef
  )) {
    throw new EffectiveAnalysisError(
      'INVALID_ASSESSMENT_STATE',
      'Assessment history is outside the authoritative case or question.'
    );
  }
}

function basisMaterialRevision(
  caseRevisions: readonly CaseRevisionBasis[],
  basisCaseVersion: number
): number | null | undefined {
  const matches = caseRevisions.filter((revision) => revision.caseVersion === basisCaseVersion);
  return matches.length === 1 ? matches[0].materialRevision : undefined;
}

function branchAmbiguities(
  structuralHeads: readonly InvestigationAssessment[],
  assessmentsById: ReadonlyMap<string, InvestigationAssessment>
): AnalysisAmbiguity[] {
  const headsByAncestorBranch = new Map<string, Map<string, string[]>>();
  for (const head of structuralHeads) {
    let current: InvestigationAssessment | undefined = head;
    while (current && current.supersedesAssessmentRef !== null) {
      const ancestorRef = current.supersedesAssessmentRef;
      const branches = headsByAncestorBranch.get(ancestorRef) ?? new Map<string, string[]>();
      const headRefs = branches.get(current.assessmentRef) ?? [];
      headRefs.push(head.assessmentRef);
      branches.set(current.assessmentRef, headRefs);
      headsByAncestorBranch.set(ancestorRef, branches);
      current = assessmentsById.get(ancestorRef);
    }
  }

  return [...headsByAncestorBranch.entries()]
    .filter(([, branches]) => branches.size > 1)
    .map(([ancestorRef, branches]) => ({
      code: 'ASSESSMENT_BRANCHING' as const,
      claimRefs: [],
      assessmentRefs: sortedUnique([
        ancestorRef,
        ...[...branches.values()].flat()
      ])
    }));
}

function compareAmbiguity(left: AnalysisAmbiguity, right: AnalysisAmbiguity): number {
  return compareText(left.code, right.code) ||
    compareText(left.claimRefs.join('\u0000'), right.claimRefs.join('\u0000')) ||
    compareText(left.assessmentRefs.join('\u0000'), right.assessmentRefs.join('\u0000'));
}

function projectInvestigationGraph(
  input: ProjectEffectiveInvestigationAnalysisInput & { currentMaterialRevision: number }
): EffectiveInvestigationAnalysis {
  const currentMaterialRevision = input.currentMaterialRevision;
  validateClaimOwnership(input.claims, input.snapshot, input.questionRef);
  validateAssessmentOwnership(input.assessments, input.snapshot, input.questionRef);

  const claimGraph = validateSupersessionGraph(
    input.claims,
    (claim) => claim.claimRef,
    (claim) => claim.supersedesClaimRef,
    'INVALID_CLAIM_STATE'
  );
  const assessmentGraph = validateSupersessionGraph(
    input.assessments,
    (assessment) => assessment.assessmentRef,
    (assessment) => assessment.supersedesAssessmentRef,
    'INVALID_ASSESSMENT_STATE'
  );

  const activeClaims = input.claims
    .filter((claim) => !claimGraph.supersededIds.has(claim.claimRef))
    .slice()
    .sort(compareClaim);
  const activeClaimRefs = new Set(activeClaims.map((claim) => claim.claimRef));
  const inactiveClaimRefs = input.claims
    .filter((claim) => claimGraph.supersededIds.has(claim.claimRef))
    .map((claim) => claim.claimRef)
    .sort(compareText);

  const structuralAssessmentHeads = input.assessments
    .filter((assessment) => !assessmentGraph.supersededIds.has(assessment.assessmentRef))
    .slice()
    .sort(compareAssessment);
  const structuralHeadRefs = new Set(
    structuralAssessmentHeads.map((assessment) => assessment.assessmentRef)
  );
  const reasonsByAssessment = new Map<string, AssessmentStaleReason[]>();
  const applicableAssessmentHeads: InvestigationAssessment[] = [];
  const materiallyCurrentAssessmentHeads: InvestigationAssessment[] = [];

  for (const assessment of input.assessments) {
    const reasons: AssessmentStaleReason[] = [];
    if (!structuralHeadRefs.has(assessment.assessmentRef)) {
      addReason(reasons, 'ASSESSMENT_SUPERSEDED');
    }

    const claimRefs = assessmentClaimRefs(assessment);
    const claimBasis = claimRefs?.map((claimRef) => claimGraph.recordsById.get(claimRef));
    const validClaimBasis = claimRefs !== null && claimBasis?.every((claim) => claim !== undefined);
    if (!validClaimBasis) {
      addReason(reasons, 'UNSUPPORTED_CLAIM_BASIS');
    } else if (claimRefs.some((claimRef) => !activeClaimRefs.has(claimRef))) {
      addReason(reasons, 'CLAIM_SUPERSEDED');
    }

    const basisRevision = basisMaterialRevision(input.caseRevisions, assessment.basisCaseVersion);
    if (basisRevision === undefined) {
      addReason(reasons, 'BASIS_REVISION_UNRESOLVED');
    } else if (basisRevision !== currentMaterialRevision) {
      addReason(reasons, 'MATERIAL_REVISION_STALE');
    }

    sortReasons(reasons);
    reasonsByAssessment.set(assessment.assessmentRef, reasons);

    const structurallyCurrent = structuralHeadRefs.has(assessment.assessmentRef);
    const claimApplicable = !reasons.includes('UNSUPPORTED_CLAIM_BASIS') &&
      !reasons.includes('CLAIM_SUPERSEDED');
    if (structurallyCurrent && claimApplicable) {
      applicableAssessmentHeads.push(assessment);
      if (
        !reasons.includes('BASIS_REVISION_UNRESOLVED') &&
        !reasons.includes('MATERIAL_REVISION_STALE')
      ) {
        materiallyCurrentAssessmentHeads.push(assessment);
      }
    }
  }

  applicableAssessmentHeads.sort(compareAssessment);
  materiallyCurrentAssessmentHeads.sort(compareAssessment);
  const staleAssessments = input.assessments
    .filter((assessment) => (reasonsByAssessment.get(assessment.assessmentRef)?.length ?? 0) > 0)
    .slice()
    .sort(compareAssessment)
    .map((assessment) => ({
      assessment,
      reasons: reasonsByAssessment.get(assessment.assessmentRef)!
    }));

  const targetedAssessments = activeClaims.map((claim) => {
    const targeted = materiallyCurrentAssessmentHeads.filter(
      (assessment) => assessment.targetClaimRef === claim.claimRef
    );
    return {
      claimRef: claim.claimRef,
      supportedAssessmentRefs: targeted
        .filter((assessment) => assessment.verdict === 'SUPPORTED')
        .map((assessment) => assessment.assessmentRef),
      insufficientAssessmentRefs: targeted
        .filter((assessment) => assessment.verdict === 'INSUFFICIENT')
        .map((assessment) => assessment.assessmentRef),
      rejectedAssessmentRefs: targeted
        .filter((assessment) => assessment.verdict === 'REJECTED')
        .map((assessment) => assessment.assessmentRef)
    };
  });

  const questionLevelInsufficientAssessmentRefs = materiallyCurrentAssessmentHeads
    .filter((assessment) =>
      assessment.verdict === 'INSUFFICIENT' && assessment.targetClaimRef === null
    )
    .map((assessment) => assessment.assessmentRef);
  const activeContradictions = materiallyCurrentAssessmentHeads
    .filter((assessment) => assessment.verdict === 'CONTRADICTED')
    .map((assessment) => ({
      assessmentRef: assessment.assessmentRef,
      relatedClaimRefs: [...assessment.relatedClaimRefs].sort(compareText)
    }));

  const ambiguities: AnalysisAmbiguity[] = [];
  for (const targeted of targetedAssessments) {
    if (targeted.supportedAssessmentRefs.length > 0 && targeted.rejectedAssessmentRefs.length > 0) {
      ambiguities.push({
        code: 'CLAIM_SUPPORTED_AND_REJECTED',
        claimRefs: [targeted.claimRef],
        assessmentRefs: sortedUnique([
          ...targeted.supportedAssessmentRefs,
          ...targeted.rejectedAssessmentRefs
        ])
      });
    }
    if (
      targeted.supportedAssessmentRefs.length > 0 &&
      targeted.insufficientAssessmentRefs.length > 0
    ) {
      ambiguities.push({
        code: 'CLAIM_SUPPORTED_AND_INSUFFICIENT',
        claimRefs: [targeted.claimRef],
        assessmentRefs: sortedUnique([
          ...targeted.supportedAssessmentRefs,
          ...targeted.insufficientAssessmentRefs
        ])
      });
    }
  }
  for (const contradiction of activeContradictions) {
    const supportedInGroup = targetedAssessments.filter((targeted) =>
      contradiction.relatedClaimRefs.includes(targeted.claimRef) &&
      targeted.supportedAssessmentRefs.length > 0
    );
    if (supportedInGroup.length > 0) {
      ambiguities.push({
        code: 'SUPPORTED_CLAIM_IN_CONTRADICTION',
        claimRefs: supportedInGroup.map((targeted) => targeted.claimRef).sort(compareText),
        assessmentRefs: sortedUnique([
          contradiction.assessmentRef,
          ...supportedInGroup.flatMap((targeted) => targeted.supportedAssessmentRefs)
        ])
      });
    }
  }
  ambiguities.push(...branchAmbiguities(
    materiallyCurrentAssessmentHeads,
    assessmentGraph.recordsById
  ));
  ambiguities.sort(compareAmbiguity);

  return {
    caseId: input.snapshot.caseId,
    questionRef: input.questionRef,
    productId: input.snapshot.productId,
    currentCaseVersion: input.snapshot.caseVersion,
    currentMaterialRevision,
    activeClaims,
    inactiveClaimRefs,
    structuralAssessmentHeads,
    applicableAssessmentHeads,
    materiallyCurrentAssessmentHeads,
    staleAssessments,
    targetedAssessments,
    questionLevelInsufficientAssessmentRefs,
    activeContradictions,
    ambiguities
  };
}

export function projectEffectiveInvestigationAnalysis(
  input: ProjectEffectiveInvestigationAnalysisInput
): EffectiveInvestigationAnalysis {
  return projectInvestigationGraph({
    ...input,
    currentMaterialRevision: validateCurrentQuestion(input.snapshot, input.questionRef)
  });
}

function challengeBoundaryError(message: string): EffectiveAnalysisError {
  return new EffectiveAnalysisError('CHALLENGE_GRAPH_BOUNDARY_INVALID', message);
}

function resolveChallengeForAnalysis(
  database: RecallDatabase,
  caseId: string,
  questionRef: string,
  challengeRef: string
): CurrentInvestigationChallengeForRead {
  try {
    return resolveCurrentInvestigationChallengeForRead(database, {
      caseId,
      questionRef,
      challengeRef
    });
  } catch (error) {
    if (!(error instanceof InvestigationChallengeError)) throw error;
    if (error.code === 'CHALLENGE_NOT_FOUND' || error.code === 'INVALID_INPUT') {
      throw new EffectiveAnalysisError('CHALLENGE_NOT_FOUND', error.message);
    }
    if (error.code === 'QUESTION_OWNERSHIP_MISMATCH') {
      throw new EffectiveAnalysisError('QUESTION_OWNERSHIP_MISMATCH', error.message);
    }
    throw new EffectiveAnalysisError('CHALLENGE_NOT_CURRENT', error.message);
  }
}

function hasExactBatchGap(
  snapshot: CaseSnapshot,
  questionRef: string,
  subjectRef: string
): boolean {
  const gaps = snapshot.investigation?.gaps.filter((issue) => issue.id === questionRef) ?? [];
  const conflicts = snapshot.investigation?.conflicts.filter(
    (issue) => issue.id === questionRef
  ) ?? [];
  return gaps.length === 1 &&
    conflicts.length === 0 &&
    gaps[0].code === 'BATCH_MISSING' &&
    gaps[0].subjectRefs.length === 1 &&
    gaps[0].subjectRefs[0] === subjectRef;
}

function assertFirstCycleBaseline(
  database: RecallDatabase,
  authorization: CurrentInvestigationChallengeForRead,
  history: ReturnType<typeof getCaseHistory>
): void {
  const selected = authorization.challenge;
  const otherChallenges = listInvestigationChallenges(
    database,
    selected.caseId,
    selected.questionRef
  ).filter((challenge) => challenge.challengeRef !== selected.challengeRef);
  if (otherChallenges.some((challenge) =>
    challenge.openedCaseVersion <= selected.openedCaseVersion ||
    challenge.createdAt <= selected.createdAt
  )) {
    throw new EffectiveAnalysisError(
      'CHALLENGE_BASELINE_UNPROVEN',
      'Challenge analysis cannot inherit artifacts from an earlier re-review cycle.'
    );
  }

  const originRows = history.filter(
    (revision) => revision.caseVersion === authorization.question.originCaseVersion
  );
  const precedingRows = history.filter((revision) =>
    revision.caseVersion < authorization.challengedRevision.caseVersion &&
    revision.materialRevision !== null &&
    revision.materialRevision !== authorization.challengedRevision.materialRevision
  );
  const predecessor = precedingRows.at(-1);
  if (
    originRows.length !== 1 ||
    originRows[0].materialRevision !== authorization.question.originMaterialRevision ||
    originRows[0].createdAt !== authorization.question.createdAt ||
    !predecessor ||
    predecessor.caseVersion < authorization.question.originCaseVersion
  ) {
    throw new EffectiveAnalysisError(
      'CHALLENGE_BASELINE_UNPROVEN',
      'Authoritative history does not prove the unassociated investigation baseline.'
    );
  }

  const baselineRows = history.filter((revision) =>
    revision.caseVersion >= authorization.question.originCaseVersion &&
    revision.caseVersion <= predecessor.caseVersion
  );
  const expectedRowCount = predecessor.caseVersion -
    authorization.question.originCaseVersion + 1;
  if (
    baselineRows.length !== expectedRowCount ||
    baselineRows.some((revision, index) =>
      revision.caseVersion !== authorization.question.originCaseVersion + index ||
      revision.materialRevision === null ||
      revision.snapshot.caseId !== authorization.question.caseId ||
      revision.snapshot.productId !== authorization.question.subjectRef ||
      revision.snapshot.demo !== authorization.question.demo ||
      !hasExactBatchGap(
        revision.snapshot,
        authorization.question.questionRef,
        authorization.question.subjectRef
      )
    )
  ) {
    throw new EffectiveAnalysisError(
      'CHALLENGE_BASELINE_UNPROVEN',
      'The registered BATCH_MISSING lineage is not continuous through the pre-answer baseline.'
    );
  }
}

function validateArtifactAssociation(
  database: RecallDatabase,
  artifact: { caseId: string; questionRef: string; demo: boolean },
  partition: ChallengeArtifactPartition
): void {
  if (partition === null) return;
  const challenge = getInvestigationChallenge(database, artifact.caseId, partition);
  if (
    !challenge ||
    challenge.caseId !== artifact.caseId ||
    challenge.questionRef !== artifact.questionRef ||
    challenge.demo !== artifact.demo
  ) {
    throw challengeBoundaryError(
      'An investigation artifact has an invalid Challenge ownership association.'
    );
  }
}

function claimPartitions(
  database: RecallDatabase,
  claims: readonly InvestigationClaim[]
): Map<string, ChallengeArtifactPartition> {
  const partitions = new Map<string, ChallengeArtifactPartition>();
  for (const claim of claims) {
    const partition = getInvestigationClaimChallengeRef(database, claim.claimRef);
    validateArtifactAssociation(database, claim, partition);
    partitions.set(claim.claimRef, partition);
  }
  return partitions;
}

function assessmentPartitions(
  database: RecallDatabase,
  assessments: readonly InvestigationAssessment[]
): Map<string, ChallengeArtifactPartition> {
  const partitions = new Map<string, ChallengeArtifactPartition>();
  for (const assessment of assessments) {
    const partition = getInvestigationAssessmentChallengeRef(
      database,
      assessment.assessmentRef
    );
    validateArtifactAssociation(database, assessment, partition);
    partitions.set(assessment.assessmentRef, partition);
  }
  return partitions;
}

function assertSelectedChallengeAssociationsVisible(
  database: RecallDatabase,
  challengeRef: string,
  claims: readonly InvestigationClaim[],
  assessments: readonly InvestigationAssessment[]
): void {
  const visibleClaimRefs = new Set(claims.map((claim) => claim.claimRef));
  const associatedClaimRefs = database
    .select({ claimRef: schema.investigationChallengeClaims.claimRef })
    .from(schema.investigationChallengeClaims)
    .where(eq(schema.investigationChallengeClaims.challengeRef, challengeRef))
    .all();
  const visibleAssessmentRefs = new Set(
    assessments.map((assessment) => assessment.assessmentRef)
  );
  const associatedAssessmentRefs = database
    .select({ assessmentRef: schema.investigationChallengeAssessments.assessmentRef })
    .from(schema.investigationChallengeAssessments)
    .where(eq(schema.investigationChallengeAssessments.challengeRef, challengeRef))
    .all();
  if (
    associatedClaimRefs.some(({ claimRef }) => !visibleClaimRefs.has(claimRef)) ||
    associatedAssessmentRefs.some(
      ({ assessmentRef }) => !visibleAssessmentRefs.has(assessmentRef)
    )
  ) {
    throw challengeBoundaryError(
      'The selected Challenge contains an artifact outside its case or Question graph.'
    );
  }
}

function assertSameSupersessionPartitions<T>(
  records: readonly T[],
  partitions: ReadonlyMap<string, ChallengeArtifactPartition>,
  getId: (record: T) => string,
  getParentId: (record: T) => string | null
): void {
  for (const record of records) {
    const parentRef = getParentId(record);
    if (parentRef === null) continue;
    if (partitions.get(getId(record)) !== partitions.get(parentRef)) {
      throw challengeBoundaryError(
        'Investigation supersession crosses a baseline or Challenge partition boundary.'
      );
    }
  }
}

function rawAssessmentClaimRefs(assessment: InvestigationAssessment): string[] {
  return sortedUnique([
    ...(assessment.targetClaimRef === null ? [] : [assessment.targetClaimRef]),
    ...assessment.relatedClaimRefs
  ]);
}

function assertIncludedAssessmentClaimBoundaries(
  assessments: readonly InvestigationAssessment[],
  includedClaimRefs: ReadonlySet<string>,
  claimPartitionByRef: ReadonlyMap<string, ChallengeArtifactPartition>,
  assessmentPartitionByRef: ReadonlyMap<string, ChallengeArtifactPartition>,
  selectedChallengeRef: string
): void {
  for (const assessment of assessments) {
    const assessmentPartition = assessmentPartitionByRef.get(assessment.assessmentRef) ?? null;
    for (const claimRef of rawAssessmentClaimRefs(assessment)) {
      const claimPartition = claimPartitionByRef.get(claimRef);
      if (!includedClaimRefs.has(claimRef) || claimPartition === undefined) {
        throw challengeBoundaryError(
          'An included Assessment depends on a Claim outside the selected Challenge graph.'
        );
      }
      if (
        (assessmentPartition === null && claimPartition !== null) ||
        (assessmentPartition === selectedChallengeRef &&
          claimPartition !== null && claimPartition !== selectedChallengeRef)
      ) {
        throw challengeBoundaryError(
          'An included Assessment crosses its allowed Claim association boundary.'
        );
      }
    }
  }
}

function assertEvidenceRequestIntegrity(
  database: RecallDatabase,
  evidence: InvestigationEvidence
): ChallengeArtifactPartition {
  if (evidence.evidenceRequestId === null) return null;
  const request = database
    .select({
      caseId: schema.evidenceRequests.caseId,
      questionRef: schema.evidenceRequests.questionRef
    })
    .from(schema.evidenceRequests)
    .where(eq(schema.evidenceRequests.id, evidence.evidenceRequestId))
    .get();
  if (
    !request ||
    request.caseId === null ||
    request.questionRef === null ||
    request.caseId !== evidence.caseId ||
    request.questionRef !== evidence.questionRef
  ) {
    throw challengeBoundaryError(
      'Referenced Evidence does not have valid versioned request ownership.'
    );
  }
  try {
    assertInvestigationEvidenceRequestOwnership(
      database,
      evidence.caseId,
      evidence.questionRef,
      evidence.evidenceRequestId
    );
  } catch {
    throw challengeBoundaryError(
      'Referenced Evidence request ownership is inconsistent with the authoritative case product.'
    );
  }
  const partition = getInvestigationRequestChallengeRef(
    database,
    evidence.evidenceRequestId
  );
  validateArtifactAssociation(database, evidence, partition);
  return partition;
}

function assertArtifactEvidenceIntegrity(
  database: RecallDatabase,
  artifact: { evidenceRefs: readonly string[] },
  partition: ChallengeArtifactPartition,
  evidenceByRef: ReadonlyMap<string, InvestigationEvidence>,
  authorization: CurrentInvestigationChallengeForRead
): void {
  const evidence = artifact.evidenceRefs.map((evidenceRef) => {
    const item = evidenceByRef.get(evidenceRef);
    if (
      !item ||
      item.caseId !== authorization.challenge.caseId ||
      item.questionRef !== authorization.challenge.questionRef ||
      item.demo !== authorization.challenge.demo
    ) {
      throw challengeBoundaryError(
        'An included artifact references Evidence outside the permanent Question lineage.'
      );
    }
    return item;
  });

  if (partition === null) {
    if (evidence.some((item) => assertEvidenceRequestIntegrity(database, item) !== null)) {
      throw challengeBoundaryError(
        'An unassociated baseline artifact references Challenge-request Evidence.'
      );
    }
    return;
  }

  const relevance = evidence.map((item) => {
    assertEvidenceRequestIntegrity(database, item);
    return classifyEvidenceForInvestigationChallenge(database, item, authorization);
  });
  if (
    relevance.includes('OTHER_CHALLENGE') ||
    !relevance.includes('CHALLENGE_RELEVANT')
  ) {
    throw challengeBoundaryError(
      'A selected-Challenge artifact has invalid or exclusively cross-Challenge Evidence.'
    );
  }
}

/**
 * Build the current Challenge projection inside a transaction owned by the caller.
 * Structural/currentness failures retain the public Challenge projection error semantics.
 */
export function readChallengeEffectiveInvestigationAnalysisInTransaction(
  database: RecallDatabase,
  caseId: string,
  questionRef: string,
  challengeRef: string
): ChallengeEffectiveInvestigationAnalysis {
  const authorization = resolveChallengeForAnalysis(
    database,
    caseId,
    questionRef,
    challengeRef
  );
  const history = getCaseHistory(database, caseId);
  assertFirstCycleBaseline(database, authorization, history);

  const claims = listInvestigationClaims(database, caseId, questionRef);
  const assessments = listInvestigationAssessments(database, caseId, questionRef);
  assertSelectedChallengeAssociationsVisible(
    database,
    challengeRef,
    claims,
    assessments
  );
  validateClaimOwnership(claims, authorization.snapshot, questionRef);
  validateAssessmentOwnership(assessments, authorization.snapshot, questionRef);
  validateSupersessionGraph(
    claims,
    (claim) => claim.claimRef,
    (claim) => claim.supersedesClaimRef,
    'INVALID_CLAIM_STATE'
  );
  validateSupersessionGraph(
    assessments,
    (assessment) => assessment.assessmentRef,
    (assessment) => assessment.supersedesAssessmentRef,
    'INVALID_ASSESSMENT_STATE'
  );

  const claimPartitionByRef = claimPartitions(database, claims);
  const assessmentPartitionByRef = assessmentPartitions(database, assessments);
  assertSameSupersessionPartitions(
    claims,
    claimPartitionByRef,
    (claim) => claim.claimRef,
    (claim) => claim.supersedesClaimRef
  );
  assertSameSupersessionPartitions(
    assessments,
    assessmentPartitionByRef,
    (assessment) => assessment.assessmentRef,
    (assessment) => assessment.supersedesAssessmentRef
  );

  const includedClaims = claims.filter((claim) => {
    const partition = claimPartitionByRef.get(claim.claimRef) ?? null;
    return partition === null || partition === challengeRef;
  });
  const includedClaimRefs = new Set(includedClaims.map((claim) => claim.claimRef));
  const includedAssessments = assessments.filter((assessment) => {
    const partition = assessmentPartitionByRef.get(assessment.assessmentRef) ?? null;
    return partition === null || partition === challengeRef;
  });
  assertIncludedAssessmentClaimBoundaries(
    includedAssessments,
    includedClaimRefs,
    claimPartitionByRef,
    assessmentPartitionByRef,
    challengeRef
  );

  const evidence = listInvestigationEvidence(database, caseId, questionRef);
  const evidenceByRef = new Map(evidence.map((item) => [item.evidenceRef, item]));
  for (const claim of includedClaims) {
    assertArtifactEvidenceIntegrity(
      database,
      claim,
      claimPartitionByRef.get(claim.claimRef) ?? null,
      evidenceByRef,
      authorization
    );
  }
  for (const assessment of includedAssessments) {
    assertArtifactEvidenceIntegrity(
      database,
      assessment,
      assessmentPartitionByRef.get(assessment.assessmentRef) ?? null,
      evidenceByRef,
      authorization
    );
  }

  const analysis = projectInvestigationGraph({
    snapshot: authorization.snapshot,
    questionRef,
    claims: includedClaims,
    assessments: includedAssessments,
    caseRevisions: history.map((revision) => ({
      caseVersion: revision.caseVersion,
      materialRevision: revision.materialRevision
    })),
    currentMaterialRevision: authorization.challenge.challengedMaterialRevision
  });
  return {
    analysisContext: {
      kind: 'OPEN_CHALLENGE',
      challengeRef: authorization.challenge.challengeRef,
      challengedRevisionId: authorization.challenge.challengedRevisionId,
      challengedMaterialRevision: authorization.challenge.challengedMaterialRevision,
      currentCaseVersion: authorization.snapshot.caseVersion,
      currentMaterialRevision: authorization.snapshot.materialRevision!
    },
    projectionBasis: {
      claimRefs: includedClaims.map((claim) => claim.claimRef).sort(compareText),
      assessmentRefs: includedAssessments
        .map((assessment) => assessment.assessmentRef)
        .sort(compareText),
      referencedEvidenceRefs: sortedUnique([
        ...includedClaims.flatMap((claim) => claim.evidenceRefs),
        ...includedAssessments.flatMap((assessment) => assessment.evidenceRefs)
      ])
    },
    analysis
  };
}

export function readChallengeEffectiveInvestigationAnalysis(
  database: RecallDatabase,
  caseId: string,
  questionRef: string,
  challengeRef: string
): ChallengeEffectiveInvestigationAnalysis {
  return database.transaction((transaction) =>
    readChallengeEffectiveInvestigationAnalysisInTransaction(
      transaction,
      caseId,
      questionRef,
      challengeRef
    )
  );
}

export function readEffectiveInvestigationAnalysis(
  database: RecallDatabase,
  caseId: string,
  questionRef: string
): EffectiveInvestigationAnalysis {
  return database.transaction((transaction) => {
    const snapshot = readCaseSnapshot(transaction, caseId);
    if (!snapshot) {
      throw new EffectiveAnalysisError(
        'VERSIONED_CASE_REQUIRED',
        'Effective analysis requires an authoritative versioned investigation.'
      );
    }
    return projectEffectiveInvestigationAnalysis({
      snapshot,
      questionRef,
      claims: listInvestigationClaims(transaction, caseId, questionRef),
      assessments: listInvestigationAssessments(transaction, caseId, questionRef),
      caseRevisions: getCaseHistory(transaction, caseId).map((revision) => ({
        caseVersion: revision.caseVersion,
        materialRevision: revision.materialRevision
      }))
    });
  });
}
