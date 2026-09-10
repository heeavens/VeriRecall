import { createHash } from 'node:crypto';

import type { InvestigationOutcome } from '../../contracts/recall';
import { normalizeBatch } from '../alerts/normalization';
import type { RecallDatabase } from '../db/repositories';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { listInvestigationAssessments } from './assessments';
import { getInvestigationClaim, listInvestigationClaims } from './claims';
import {
  demoBatchEstablishmentPolicy,
  evaluateCurrentInvestigationEstablishmentInTransaction,
  type CurrentEstablishmentBlockerCode,
  type InvestigationEstablishment
} from './establishments';
import { listInvestigationEvidence } from './evidence-registry';
import { getInvestigationQuestion } from './questions';

export const establishedBatchApplicationBasisFormatVersion =
  'established-batch-application-basis/v1' as const;
export const establishedBatchApplicationPolicy = {
  identifier: 'demo-established-batch-human-application-policy',
  version: 'v1'
} as const;

export const establishedBatchApplicationBlockerCodes = [
  'VERSIONED_CASE_REQUIRED',
  'QUESTION_NOT_CURRENT',
  'QUESTION_OWNERSHIP_MISMATCH',
  'SCOPE_NOT_OPEN_GAP',
  'CLOSED_CASE_INCONSISTENT',
  'ESTABLISHMENT_NOT_CURRENTLY_ELIGIBLE',
  'ESTABLISHMENT_BASIS_MISMATCH',
  'TARGET_CLAIM_INVALID',
  'LOT_EMPTY',
  'OTHER_AUTHORITATIVE_UNCERTAINTY_PRESENT',
  'NOT_DEMO'
] as const;

export type EstablishedBatchApplicationBlockerCode =
  typeof establishedBatchApplicationBlockerCodes[number];

type Investigation = NonNullable<ReturnType<typeof readCaseSnapshot>>['investigation'];
type Issue = InvestigationOutcome['gaps'][number];

export interface EstablishedBatchApplicationBasis {
  basisFormatVersion: typeof establishedBatchApplicationBasisFormatVersion;
  applicationPolicyIdentifier: typeof establishedBatchApplicationPolicy.identifier;
  applicationPolicyVersion: typeof establishedBatchApplicationPolicy.version;
  caseId: string;
  productId: string;
  questionRef: string;
  establishmentRef: string;
  claimRef: string;
  currentCaseVersion: number;
  currentMaterialRevision: number;
  currentStage: CaseSnapshotStage;
  authoritativeContext: {
    knowledgeStatus: InvestigationOutcome['knowledgeStatus'];
    identity: NonNullable<Investigation>['identity'];
    scope: NonNullable<Investigation>['scope'];
    evidenceRefs: string[];
    decisionRefs: string[];
    questionIssue: Issue | null;
    gaps: InvestigationOutcome['gaps'];
    conflicts: InvestigationOutcome['conflicts'];
  };
  establishment: {
    policyIdentifier: string;
    policyVersion: string;
    evaluatorKind: 'RULE';
    evaluatorIdentifier: string;
    basisCaseVersion: number;
    basisMaterialRevision: number;
    basisClaimRefs: string[];
    basisAssessmentRefs: string[];
    basisEvidenceRefs: string[];
  };
  currentEvaluation: {
    currentlyEligible: boolean;
    blockerCodes: CurrentEstablishmentBlockerCode[];
    basis: {
      claimRefs: string[];
      assessmentRefs: string[];
      evidenceRefs: string[];
    } | null;
  };
  currentArtifactRefs: {
    claimRefs: string[];
    assessmentRefs: string[];
    evidenceRefs: string[];
  };
  targetClaim: {
    claimRef: string;
    claimType: 'AFFECTED_BATCH_LOT';
    originKind: 'DETERMINISTIC_EXTRACTED' | 'AI_PROPOSED' | 'HUMAN_OBSERVED';
    rawLot: string;
    normalizedLot: string;
    evidenceRefs: string[];
    demo: boolean;
  } | null;
  eligibility: {
    eligible: boolean;
    blockerCodes: EstablishedBatchApplicationBlockerCode[];
  };
  applicationBasisDigest: string;
}

type BasisWithoutDigest = Omit<EstablishedBatchApplicationBasis, 'applicationBasisDigest'>;
type CaseSnapshotStage = NonNullable<ReturnType<typeof readCaseSnapshot>>['stage'];

export type EstablishedBatchApplicationBasisErrorCode =
  | 'ESTABLISHMENT_NOT_FOUND'
  | 'APPLICATION_BASIS_INVALID';

export class EstablishedBatchApplicationBasisError extends Error {
  constructor(
    public readonly code: EstablishedBatchApplicationBasisErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'EstablishedBatchApplicationBasisError';
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameReferences(left: readonly string[], right: readonly string[]): boolean {
  const canonicalLeft = sortedUnique(left);
  const canonicalRight = sortedUnique(right);
  return canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestBasis(value: BasisWithoutDigest): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalIssue(issue: Issue): Issue {
  return {
    ...structuredClone(issue),
    subjectRefs: sortedUnique(issue.subjectRefs),
    evidenceRefs: sortedUnique(issue.evidenceRefs)
  };
}

function canonicalIssues(issues: readonly Issue[]): Issue[] {
  return issues.map(canonicalIssue).sort((left, right) =>
    compareText(left.id, right.id) || compareText(left.code, right.code)
  );
}

function canonicalIdentity(identity: NonNullable<Investigation>['identity']) {
  return {
    ...structuredClone(identity),
    evidenceRefs: sortedUnique(identity.evidenceRefs),
    decisionRefs: sortedUnique(identity.decisionRefs)
  };
}

function canonicalScope(scope: NonNullable<Investigation>['scope']) {
  return scope.kind === 'BATCH_LOT'
    ? {
        ...structuredClone(scope),
        lots: sortedUnique(scope.lots),
        evidenceRefs: sortedUnique(scope.evidenceRefs),
        decisionRefs: sortedUnique(scope.decisionRefs)
      }
    : {
        ...structuredClone(scope),
        evidenceRefs: sortedUnique(scope.evidenceRefs),
        decisionRefs: sortedUnique(scope.decisionRefs)
      };
}

function establishmentSummary(establishment: InvestigationEstablishment) {
  return {
    policyIdentifier: establishment.policyIdentifier,
    policyVersion: establishment.policyVersion,
    evaluatorKind: establishment.evaluatorKind,
    evaluatorIdentifier: establishment.evaluatorIdentifier,
    basisCaseVersion: establishment.basisCaseVersion,
    basisMaterialRevision: establishment.basisMaterialRevision,
    basisClaimRefs: sortedUnique(establishment.basisClaimRefs),
    basisAssessmentRefs: sortedUnique(establishment.basisAssessmentRefs),
    basisEvidenceRefs: sortedUnique(establishment.basisEvidenceRefs)
  };
}

/** Derive the HUMAN-reviewable Established Batch basis inside the caller's transaction. */
export function readEstablishedBatchApplicationBasisInTransaction(
  database: RecallDatabase,
  caseId: string,
  questionRef: string,
  establishmentRef: string
): EstablishedBatchApplicationBasis {
  const evaluation = evaluateCurrentInvestigationEstablishmentInTransaction(
    database,
    caseId,
    establishmentRef
  );
  if (!evaluation) {
    throw new EstablishedBatchApplicationBasisError(
      'ESTABLISHMENT_NOT_FOUND',
      'The requested investigation Establishment does not exist for this case.'
    );
  }
  const establishment = evaluation.establishment;
  if (establishment.questionRef !== questionRef) {
    throw new EstablishedBatchApplicationBasisError(
      'APPLICATION_BASIS_INVALID',
      'The Establishment does not belong to the requested permanent Question.'
    );
  }
  const snapshot = readCaseSnapshot(database, caseId);
  if (!snapshot?.investigation || snapshot.materialRevision === null) {
    throw new EstablishedBatchApplicationBasisError(
      'APPLICATION_BASIS_INVALID',
      'A current versioned InvestigationOutcome is required.'
    );
  }

  const question = getInvestigationQuestion(database, caseId, questionRef);
  const target = getInvestigationClaim(database, caseId, establishment.claimRef);
  const claims = listInvestigationClaims(database, caseId, questionRef);
  const assessments = listInvestigationAssessments(database, caseId, questionRef);
  const evidence = listInvestigationEvidence(database, caseId, questionRef);
  const questionIssues = snapshot.investigation.gaps.filter((issue) =>
    issue.id === questionRef &&
    issue.code === 'BATCH_MISSING' &&
    issue.subjectRefs.length === 1 &&
    issue.subjectRefs[0] === snapshot.productId
  );
  const blockers = new Set<EstablishedBatchApplicationBlockerCode>();
  if (questionIssues.length !== 1) blockers.add('QUESTION_NOT_CURRENT');
  if (
    !question ||
    question.questionType !== 'AFFECTED_BATCH_LOT' ||
    question.subjectRef !== snapshot.productId ||
    establishment.caseId !== caseId ||
    establishment.questionRef !== questionRef
  ) {
    blockers.add('QUESTION_OWNERSHIP_MISMATCH');
  }
  if (
    snapshot.investigation.identity.knowledgeStatus !== 'KNOWN' ||
    snapshot.investigation.identity.conclusion !== 'MATCH' ||
    snapshot.investigation.scope.kind !== 'UNRESOLVED' ||
    snapshot.investigation.scope.knowledgeStatus === 'CONFLICTED' ||
    snapshot.investigation.knowledgeStatus === 'CONFLICTED'
  ) {
    blockers.add('SCOPE_NOT_OPEN_GAP');
  }
  if (snapshot.stage === 'CLOSED') blockers.add('CLOSED_CASE_INCONSISTENT');
  if (!evaluation.currentlyEligible) {
    blockers.add('ESTABLISHMENT_NOT_CURRENTLY_ELIGIBLE');
  }
  if (
    !evaluation.currentBasis ||
    !sameReferences(evaluation.currentBasis.claimRefs, establishment.basisClaimRefs) ||
    !sameReferences(evaluation.currentBasis.assessmentRefs, establishment.basisAssessmentRefs) ||
    !sameReferences(evaluation.currentBasis.evidenceRefs, establishment.basisEvidenceRefs)
  ) {
    blockers.add('ESTABLISHMENT_BASIS_MISMATCH');
  }
  const targetValid = target &&
    target.questionRef === questionRef &&
    target.subjectRef === snapshot.productId &&
    target.claimType === 'AFFECTED_BATCH_LOT' &&
    target.originKind !== 'AI_PROPOSED' &&
    target.demo;
  if (!targetValid) blockers.add('TARGET_CLAIM_INVALID');
  const normalizedLot = target ? normalizeBatch(target.value.lot) : '';
  if (normalizedLot.length === 0) blockers.add('LOT_EMPTY');
  if (
    snapshot.investigation.gaps.length !== 1 ||
    snapshot.investigation.conflicts.length !== 0
  ) {
    blockers.add('OTHER_AUTHORITATIVE_UNCERTAINTY_PRESENT');
  }
  if (
    !snapshot.demo ||
    !question?.demo ||
    !establishment.demo ||
    !target?.demo ||
    claims.some((claim) => !claim.demo) ||
    assessments.some((assessment) => !assessment.demo) ||
    evidence.some((item) => !item.demo)
  ) {
    blockers.add('NOT_DEMO');
  }

  const basis: BasisWithoutDigest = {
    basisFormatVersion: establishedBatchApplicationBasisFormatVersion,
    applicationPolicyIdentifier: establishedBatchApplicationPolicy.identifier,
    applicationPolicyVersion: establishedBatchApplicationPolicy.version,
    caseId,
    productId: snapshot.productId,
    questionRef,
    establishmentRef,
    claimRef: establishment.claimRef,
    currentCaseVersion: snapshot.caseVersion,
    currentMaterialRevision: snapshot.materialRevision,
    currentStage: snapshot.stage,
    authoritativeContext: {
      knowledgeStatus: snapshot.investigation.knowledgeStatus,
      identity: canonicalIdentity(snapshot.investigation.identity),
      scope: canonicalScope(snapshot.investigation.scope),
      evidenceRefs: sortedUnique(snapshot.investigation.evidenceRefs),
      decisionRefs: sortedUnique(snapshot.investigation.decisionRefs),
      questionIssue: questionIssues.length === 1 ? canonicalIssue(questionIssues[0]) : null,
      gaps: canonicalIssues(snapshot.investigation.gaps),
      conflicts: canonicalIssues(snapshot.investigation.conflicts)
    },
    establishment: establishmentSummary(establishment),
    currentEvaluation: {
      currentlyEligible: evaluation.currentlyEligible,
      blockerCodes: [...evaluation.blockerCodes],
      basis: evaluation.currentBasis ? {
        claimRefs: sortedUnique(evaluation.currentBasis.claimRefs),
        assessmentRefs: sortedUnique(evaluation.currentBasis.assessmentRefs),
        evidenceRefs: sortedUnique(evaluation.currentBasis.evidenceRefs)
      } : null
    },
    currentArtifactRefs: {
      claimRefs: sortedUnique(claims.map((claim) => claim.claimRef)),
      assessmentRefs: sortedUnique(assessments.map((assessment) => assessment.assessmentRef)),
      evidenceRefs: sortedUnique(evidence.map((item) => item.evidenceRef))
    },
    targetClaim: target ? {
      claimRef: target.claimRef,
      claimType: target.claimType,
      originKind: target.originKind,
      rawLot: target.value.lot,
      normalizedLot,
      evidenceRefs: sortedUnique(target.evidenceRefs),
      demo: target.demo
    } : null,
    eligibility: {
      eligible: blockers.size === 0,
      blockerCodes: establishedBatchApplicationBlockerCodes.filter((code) => blockers.has(code))
    }
  };
  return { ...basis, applicationBasisDigest: digestBasis(basis) };
}

export function readEstablishedBatchApplicationBasis(
  database: RecallDatabase,
  caseId: string,
  questionRef: string,
  establishmentRef: string
): EstablishedBatchApplicationBasis {
  return database.transaction((transaction) =>
    readEstablishedBatchApplicationBasisInTransaction(
      transaction,
      caseId,
      questionRef,
      establishmentRef
    )
  );
}
