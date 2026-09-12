import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { CaseSnapshot } from '../../contracts/recall';
import {
  AlertProvenanceError,
  resolveAlertFactsInTransaction,
  type ResolvedAlertFacts
} from '../alerts/alert-provenance';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import {
  AlertMatchBasisError,
  readAlertMatchBasisInTransaction
} from '../matching/match-basis';
import {
  readCaseRevisionByCaseVersion,
  readCaseRevisionById,
  readCaseSnapshot
} from '../workflow/case-lifecycle';
import { listInvestigationAssessments } from './assessments';
import {
  assertAuthoritativeMaterialContinuityInTransaction,
  readInvestigationChallengeConflictApplicationResult
} from './authoritative-challenge-baseline';
import {
  classifyEvidenceForInvestigationChallenge,
  getInvestigationAssessmentChallengeRef,
  getInvestigationClaimChallengeRef,
  getInvestigationEstablishmentChallengeRef,
  getInvestigationRequestChallengeRef
} from './challenge-artifacts';
import {
  evaluateCurrentInvestigationChallengeBatchEstablishmentInTransaction
} from './challenge-batch-establishments';
import {
  InvestigationChallengeError,
  resolveCurrentInvestigationChallengeForRead,
  resolveCurrentInvestigationConflictContinuationForWrite,
  type CurrentInvestigationChallengeForWrite,
  type CurrentInvestigationConflictContinuationForWrite
} from './challenges';
import { listInvestigationClaims } from './claims';
import {
  readChallengeEffectiveInvestigationAnalysisInTransaction,
  readConflictContinuationEffectiveInvestigationAnalysisInTransaction,
  readEffectiveInvestigationAnalysisInTransaction,
  type EffectiveInvestigationAnalysis
} from './effective-analysis';
import {
  evaluateCurrentInvestigationEstablishmentInTransaction,
  listInvestigationEstablishments
} from './establishments';
import { listInvestigationEvidence } from './evidence-registry';
import { listInvestigatorMemoryEventsInTransaction } from './investigator-ledger';
import {
  assertInvestigatorSnapshotBounds,
  canonicalInvestigatorJson,
  canonicalInvestigatorRefs,
  deriveInvestigatorCapabilities,
  investigatorLimits,
  investigatorPolicy,
  investigatorSnapshotFormatVersion,
  investigatorSnapshotSchema,
  type InvestigatorSnapshot
} from './investigator-policy';
import { getInvestigationQuestion, type InvestigationQuestion } from './questions';

export type InvestigatorSnapshotErrorCode =
  | 'INVESTIGATOR_INVALID_INPUT'
  | 'INVESTIGATOR_CONTEXT_UNPROVEN'
  | 'INVESTIGATOR_CONTEXT_AMBIGUOUS'
  | 'INVESTIGATOR_CONTEXT_CORRUPT'
  | 'INVESTIGATOR_CONTEXT_TOO_LARGE';

export class InvestigatorSnapshotError extends Error {
  constructor(
    public readonly code: InvestigatorSnapshotErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvestigatorSnapshotError';
  }
}

export type CurrentInvestigatorPartition =
  | {
      kind: 'OPEN_GAP';
      snapshot: CaseSnapshot;
      question: InvestigationQuestion;
      analysis: EffectiveInvestigationAnalysis;
      authorization: null;
    }
  | {
      kind: 'OPEN_CHALLENGE';
      snapshot: CaseSnapshot;
      question: InvestigationQuestion;
      analysis: EffectiveInvestigationAnalysis;
      projectionClaimRefs: string[];
      projectionAssessmentRefs: string[];
      authorization: CurrentInvestigationChallengeForWrite;
    }
  | {
      kind: 'APPLIED_CHALLENGE_CONFLICT';
      snapshot: CaseSnapshot;
      question: InvestigationQuestion;
      analysis: EffectiveInvestigationAnalysis;
      projectionClaimRefs: string[];
      projectionAssessmentRefs: string[];
      authorization: CurrentInvestigationConflictContinuationForWrite;
    }
  | {
      kind: 'RESOLVED';
      snapshot: CaseSnapshot;
      question: InvestigationQuestion;
    }
  | {
      kind: 'CONTINUATION_REQUIRED';
      snapshot: CaseSnapshot;
      question: InvestigationQuestion;
      conflictApplicationRef: string;
    };

type ActiveInvestigatorPartition = Exclude<
  CurrentInvestigatorPartition,
  { kind: 'RESOLVED' } | { kind: 'CONTINUATION_REQUIRED' }
>;

export type InactiveInvestigatorPartition =
  | Extract<CurrentInvestigatorPartition, { kind: 'RESOLVED' }>
  | Extract<CurrentInvestigatorPartition, { kind: 'CONTINUATION_REQUIRED' }>;

const selectorInputSchema = z.strictObject({
  caseId: z.string().uuid(),
  questionRef: z.string().trim().min(1).max(500)
});

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function containsOversizedText(value: unknown): boolean {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8') > investigatorLimits.freeText;
  }
  if (Array.isArray(value)) return value.some(containsOversizedText);
  return Boolean(value && typeof value === 'object' &&
    Object.values(value as Record<string, unknown>).some(containsOversizedText));
}

function mapContextFailure(error: unknown): never {
  if (error instanceof InvestigatorSnapshotError) throw error;
  if (error instanceof InvestigationChallengeError) {
    throw new InvestigatorSnapshotError(
      error.code.includes('AMBIGUOUS')
        ? 'INVESTIGATOR_CONTEXT_AMBIGUOUS'
        : error.code.includes('PROVENANCE_INVALID')
          ? 'INVESTIGATOR_CONTEXT_CORRUPT'
          : 'INVESTIGATOR_CONTEXT_UNPROVEN',
      error.message
    );
  }
  throw error;
}

function assertContinuationRequiredProvenance(
  database: RecallDatabase,
  snapshot: CaseSnapshot,
  question: InvestigationQuestion
): string {
  const candidates = database.select({
    applicationRef: schema.investigationChallengeConflictApplications.applicationRef
  }).from(schema.investigationChallengeConflictApplications).where(and(
    eq(schema.investigationChallengeConflictApplications.caseId, snapshot.caseId),
    eq(
      schema.investigationChallengeConflictApplications.resultingMaterialRevision,
      snapshot.materialRevision!
    )
  )).all();
  if (candidates.length > 1) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_AMBIGUOUS',
      'More than one applied conflict claims the current authoritative material state.'
    );
  }
  if (candidates.length === 0) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_UNPROVEN',
      'The authoritative conflict has no validated Challenge conflict application.'
    );
  }
  let hydrated: ReturnType<typeof readInvestigationChallengeConflictApplicationResult>;
  try {
    hydrated = readInvestigationChallengeConflictApplicationResult(
      database,
      snapshot.caseId,
      candidates[0].applicationRef
    );
  } catch {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_CORRUPT',
      'The applied conflict provenance is malformed or unsupported.'
    );
  }
  if (
    !hydrated || hydrated.application.questionRef !== question.questionRef ||
    hydrated.application.resultingMaterialRevision !== snapshot.materialRevision ||
    hydrated.application.resultingCaseVersion > snapshot.caseVersion
  ) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_CORRUPT',
      'The applied conflict result does not own the current Question material state.'
    );
  }
  const resultRevision = readCaseRevisionById(
    database,
    snapshot.caseId,
    hydrated.application.resultingRevisionId
  );
  if (!resultRevision || !sameValue(resultRevision.snapshot, hydrated.snapshot)) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_CORRUPT',
      'The applied conflict result revision is missing or divergent.'
    );
  }
  try {
    assertAuthoritativeMaterialContinuityInTransaction(
      database,
      resultRevision,
      snapshot.caseVersion
    );
  } catch {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_CORRUPT',
      'The current conflict no longer descends operationally from its applied result.'
    );
  }
  if (!sameValue(snapshot.investigation, hydrated.snapshot.investigation)) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_CORRUPT',
      'The current authoritative conflict differs from the applied conflict result.'
    );
  }
  return hydrated.application.applicationRef;
}

/** Select one exact Question-scoped partition without interpreting Claim/Assessment graphs. */
export function resolveCurrentInvestigatorPartitionInTransaction(
  database: RecallDatabase,
  input: { caseId: string; questionRef: string }
): CurrentInvestigatorPartition {
  const parsed = selectorInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_INVALID_INPUT',
      'Invalid Investigator Question context.'
    );
  }
  const snapshot = readCaseSnapshot(database, parsed.data.caseId);
  const question = getInvestigationQuestion(database, parsed.data.caseId, parsed.data.questionRef);
  if (
    !snapshot || snapshot.materialRevision === null || !snapshot.investigation || !question ||
    question.caseId !== snapshot.caseId || question.subjectRef !== snapshot.productId ||
    question.questionType !== 'AFFECTED_BATCH_LOT' || question.demo !== snapshot.demo
  ) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_UNPROVEN',
      'The Investigator requires an exact registered permanent Question and material state.'
    );
  }
  const currentRevision = readCaseRevisionByCaseVersion(
    database,
    snapshot.caseId,
    snapshot.caseVersion
  );
  if (!currentRevision || !sameValue(currentRevision.snapshot, snapshot)) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_CORRUPT',
      'The current lifecycle snapshot has no exact immutable revision.'
    );
  }
  const occurrences = [
    ...snapshot.investigation.gaps.filter((item) => item.id === question.questionRef),
    ...snapshot.investigation.conflicts.filter((item) => item.id === question.questionRef)
  ];
  if (occurrences.length > 1) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_AMBIGUOUS',
      'The current authoritative Outcome duplicates the permanent Question identity.'
    );
  }
  const challengeRows = database.select({
    challengeRef: schema.investigationChallenges.challengeRef
  }).from(schema.investigationChallenges).where(and(
    eq(schema.investigationChallenges.caseId, snapshot.caseId),
    eq(schema.investigationChallenges.questionRef, question.questionRef),
    eq(schema.investigationChallenges.challengedMaterialRevision, snapshot.materialRevision)
  )).all();
  if (challengeRows.length > 1) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_AMBIGUOUS',
      'The current material state has more than one investigation partition.'
    );
  }

  if (occurrences[0]?.code === 'BATCH_MISSING' &&
      snapshot.investigation.gaps.some((item) => item.id === question.questionRef)) {
    if (challengeRows.length !== 0) {
      throw new InvestigatorSnapshotError(
        'INVESTIGATOR_CONTEXT_CORRUPT',
        'An OPEN_GAP Question unexpectedly has a current Challenge partition.'
      );
    }
    return {
      kind: 'OPEN_GAP',
      snapshot,
      question,
      analysis: readEffectiveInvestigationAnalysisInTransaction(
        database,
        snapshot.caseId,
        question.questionRef
      ),
      authorization: null
    };
  }

  const isAppliedConflict =
    snapshot.investigation.knowledgeStatus === 'CONFLICTED' &&
    snapshot.investigation.scope.kind === 'UNRESOLVED' &&
    snapshot.investigation.scope.knowledgeStatus === 'CONFLICTED' &&
    occurrences.length === 1 && occurrences[0].code === 'BATCH_CONFLICT';
  if (isAppliedConflict) {
    if (challengeRows.length === 0) {
      return {
        kind: 'CONTINUATION_REQUIRED',
        snapshot,
        question,
        conflictApplicationRef: assertContinuationRequiredProvenance(database, snapshot, question)
      };
    }
    try {
      const authorization = resolveCurrentInvestigationConflictContinuationForWrite(database, {
        caseId: snapshot.caseId,
        questionRef: question.questionRef,
        challengeRef: challengeRows[0].challengeRef,
        expectedCaseVersion: snapshot.caseVersion,
        expectedMaterialRevision: snapshot.materialRevision,
        demo: true
      });
      const projected = readConflictContinuationEffectiveInvestigationAnalysisInTransaction(
        database,
        snapshot.caseId,
        question.questionRef,
        challengeRows[0].challengeRef
      );
      return {
        kind: 'APPLIED_CHALLENGE_CONFLICT',
        snapshot,
        question,
        analysis: projected.analysis,
        projectionClaimRefs: projected.projectionBasis.claimRefs,
        projectionAssessmentRefs: projected.projectionBasis.assessmentRefs,
        authorization
      };
    } catch (error) {
      return mapContextFailure(error);
    }
  }

  if (challengeRows.length === 1) {
    try {
      const authorization = resolveCurrentInvestigationChallengeForRead(database, {
        caseId: snapshot.caseId,
        questionRef: question.questionRef,
        challengeRef: challengeRows[0].challengeRef
      });
      const projected = readChallengeEffectiveInvestigationAnalysisInTransaction(
        database,
        snapshot.caseId,
        question.questionRef,
        challengeRows[0].challengeRef
      );
      return {
        kind: 'OPEN_CHALLENGE',
        snapshot,
        question,
        analysis: projected.analysis,
        projectionClaimRefs: projected.projectionBasis.claimRefs,
        projectionAssessmentRefs: projected.projectionBasis.assessmentRefs,
        authorization
      };
    } catch (error) {
      return mapContextFailure(error);
    }
  }

  if (occurrences.length === 0) return { kind: 'RESOLVED', snapshot, question };
  throw new InvestigatorSnapshotError(
    'INVESTIGATOR_CONTEXT_UNPROVEN',
    'The current Question state has no supported Investigation partition.'
  );
}

function contextChallengeRef(
  partition: ActiveInvestigatorPartition
): string | null {
  return partition.authorization?.challenge.challengeRef ?? null;
}

function parseRequestedEvidence(value: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_CORRUPT',
      'An Evidence Request contains malformed requested evidence.'
    );
  }
  const parsed = z.array(z.enum(['barcode_photo', 'supplier_invoice', 'batch_label_photo']))
    .min(1).safeParse(raw);
  if (!parsed.success) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_CORRUPT',
      'An Evidence Request contains unsupported requested evidence.'
    );
  }
  return canonicalInvestigatorRefs(parsed.data);
}

function alertFactsForSnapshot(
  database: RecallDatabase,
  snapshot: CaseSnapshot
): InvestigatorSnapshot['alertFacts'] {
  const owningCase = database.select({ alertId: schema.cases.alertId })
    .from(schema.cases).where(eq(schema.cases.id, snapshot.caseId)).get();
  if (!owningCase) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_CORRUPT',
      'The versioned case has no owning alert.'
    );
  }
  const observationCount = database.select({
    observationRef: schema.alertSourceObservations.observationRef
  }).from(schema.alertSourceObservations)
    .where(eq(schema.alertSourceObservations.alertId, owningCase.alertId)).all().length;
  let facts: ResolvedAlertFacts;
  try {
    facts = resolveAlertFactsInTransaction(database, {
      alertId: owningCase.alertId,
      purpose: 'AUTHORITATIVE'
    });
  } catch (error) {
    if (observationCount === 0) {
      return {
        sourceObservationRef: null,
        matchBasisDigest: null,
        authoritative: [],
        hypotheses: [],
        unverified: [],
        blockers: ['LEGACY_UNVERIFIED']
      };
    }
    if (error instanceof AlertProvenanceError) {
      throw new InvestigatorSnapshotError(
        'INVESTIGATOR_CONTEXT_CORRUPT',
        `Alert provenance is invalid: ${error.code}.`
      );
    }
    throw error;
  }

  const confirmedMatches = database.select({ id: schema.matches.id })
    .from(schema.matches).where(and(
      eq(schema.matches.alertId, owningCase.alertId),
      eq(schema.matches.productId, snapshot.productId),
      eq(schema.matches.status, 'confirmed')
    )).all();
  if (confirmedMatches.length > 1) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_AMBIGUOUS',
      'The case has more than one confirmed Match Basis for its current product.'
    );
  }
  let matchBasisDigest: string | null = null;
  if (confirmedMatches.length === 1) {
    const rawBasis = database.select({ matchId: schema.alertMatchBases.matchId })
      .from(schema.alertMatchBases)
      .where(eq(schema.alertMatchBases.matchId, confirmedMatches[0].id)).get();
    if (rawBasis) {
      try {
        matchBasisDigest = readAlertMatchBasisInTransaction(
          database,
          confirmedMatches[0].id
        ).basis.basisDigest;
      } catch (error) {
        if (error instanceof AlertMatchBasisError) {
          throw new InvestigatorSnapshotError(
            'INVESTIGATOR_CONTEXT_CORRUPT',
            `The historical Match Basis is invalid: ${error.code}.`
          );
        }
        throw error;
      }
    }
  }
  const relevant = facts.assertions.filter((item) =>
    item.fieldKind === 'EAN_GTIN' || item.fieldKind === 'BATCH_LOT'
  );
  const identityRefs = new Set(facts.authoritative.identityAssertionRefs);
  const scopeRefs = new Set(facts.authoritative.scopeAssertionRefs);
  const mapFact = (item: (typeof relevant)[number], authorityCapable: boolean) => ({
    assertionRef: item.assertionRef,
    fieldKind: item.fieldKind,
    normalizedValue: item.normalizedValue,
    originKind: item.originKind,
    authorityCapable,
    epistemicClass: item.originKind === 'AI_PROPOSAL'
      ? 'AI_PROPOSAL' as const
      : item.originKind === 'LEGACY_UNVERIFIED'
        ? 'LEGACY_UNVERIFIED' as const
        : authorityCapable
          ? 'AUTHORITATIVE_CURRENT_FACT' as const
          : 'UNKNOWN' as const
  });
  return {
    sourceObservationRef: facts.sourceObservation.observationRef,
    matchBasisDigest,
    authoritative: relevant.filter((item) =>
      identityRefs.has(item.assertionRef) || scopeRefs.has(item.assertionRef)
    ).map((item) => mapFact(item, true)),
    hypotheses: relevant.filter((item) => item.originKind === 'AI_PROPOSAL')
      .map((item) => mapFact(item, false)),
    unverified: relevant.filter((item) => item.originKind === 'LEGACY_UNVERIFIED')
      .map((item) => mapFact(item, false)),
    blockers: canonicalInvestigatorRefs(facts.blockers)
  };
}

function establishmentState(
  database: RecallDatabase,
  partition: ActiveInvestigatorPartition
): InvestigatorSnapshot['establishment'] {
  const currentChallengeRef = contextChallengeRef(partition);
  const evaluations = listInvestigationEstablishments(
    database,
    partition.snapshot.caseId,
    partition.question.questionRef
  ).flatMap((establishment) => {
    const associatedChallengeRef = getInvestigationEstablishmentChallengeRef(
      database,
      establishment.establishmentRef
    );
    if (associatedChallengeRef !== currentChallengeRef) return [];
    const evaluation = currentChallengeRef === null
      ? evaluateCurrentInvestigationEstablishmentInTransaction(
          database,
          partition.snapshot.caseId,
          establishment.establishmentRef
        )
      : evaluateCurrentInvestigationChallengeBatchEstablishmentInTransaction(
          database,
          partition.snapshot.caseId,
          establishment.establishmentRef
        );
    return evaluation ? [{
      establishmentRef: establishment.establishmentRef,
      currentlyEligible: evaluation.currentlyEligible,
      blockerCodes: canonicalInvestigatorRefs(evaluation.blockerCodes)
    }] : [];
  }).sort((left, right) => left.establishmentRef.localeCompare(right.establishmentRef));
  return {
    evaluations,
    awaitingHumanAuthority: evaluations.some((item) => item.currentlyEligible)
  };
}

/** Build the complete bounded immutable Investigator basis inside the caller's transaction. */
export function buildInvestigatorSnapshotInTransaction(
  database: RecallDatabase,
  input: { caseId: string; questionRef: string }
): InvestigatorSnapshot | InactiveInvestigatorPartition {
  const partition = resolveCurrentInvestigatorPartitionInTransaction(database, input);
  if (partition.kind === 'RESOLVED' || partition.kind === 'CONTINUATION_REQUIRED') {
    return partition;
  }
  const currentChallengeRef = contextChallengeRef(partition);
  const allEvidence = listInvestigationEvidence(
    database,
    partition.snapshot.caseId,
    partition.question.questionRef
  );
  const evidence = allEvidence.map((item) => {
    let relevance: InvestigatorSnapshot['evidence'][number]['relevance'];
    if (partition.kind === 'OPEN_GAP') {
      relevance = 'OPEN_GAP';
    } else {
      const classified = classifyEvidenceForInvestigationChallenge(
        database,
        item,
        partition.authorization
      );
      relevance = classified === 'OTHER_CHALLENGE' ? 'HISTORICAL' : classified;
    }
    return {
      evidenceRef: item.evidenceRef,
      sourceKind: item.sourceKind,
      contentKind: item.contentKind,
      evidenceRequestId: item.evidenceRequestId,
      receivedAt: item.receivedAt,
      validAsOf: item.validAsOf,
      integrityHash: item.integrityHash,
      relevance,
      epistemicClass: relevance === 'AUTHORITATIVE_CONFLICT_BASELINE' ||
          relevance === 'INITIAL_BASELINE' || relevance === 'INHERITED_BASELINE'
        ? 'AUTHORITATIVE_HISTORICAL_PROVENANCE' as const
        : 'UNKNOWN' as const
    };
  }).sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef));

  const requestRows = database.select().from(schema.evidenceRequests).where(and(
    eq(schema.evidenceRequests.caseId, partition.snapshot.caseId),
    eq(schema.evidenceRequests.questionRef, partition.question.questionRef)
  )).orderBy(asc(schema.evidenceRequests.createdAt), asc(schema.evidenceRequests.id)).all();
  const requests = requestRows.map((row) => {
    if (row.status !== 'pending' || row.resolvedAt !== null) {
      throw new InvestigatorSnapshotError(
        'INVESTIGATOR_CONTEXT_CORRUPT',
        'A versioned Evidence Request has unsupported mutable lifecycle state.'
      );
    }
    const associatedChallengeRef = getInvestigationRequestChallengeRef(database, row.id);
    const linkedEvidenceRefs = canonicalInvestigatorRefs(
      allEvidence.filter((item) => item.evidenceRequestId === row.id)
        .map((item) => item.evidenceRef)
    );
    const belongsToCurrent = associatedChallengeRef === currentChallengeRef;
    return {
      requestRef: row.id,
      requestedEvidence: parseRequestedEvidence(row.requestedEvidence),
      contextChallengeRef: associatedChallengeRef,
      linkedEvidenceRefs,
      lifecycle: belongsToCurrent
        ? linkedEvidenceRefs.length > 0
          ? 'RESPONSE_EVIDENCE_RECEIVED' as const
          : 'REQUEST_ATTEMPT_RECORDED' as const
        : 'HISTORICAL' as const,
      createdAt: row.createdAt,
      epistemicClass: 'OPERATIONAL_STATE' as const
    };
  }).sort((left, right) => left.requestRef.localeCompare(right.requestRef));

  const allQuestionClaims = listInvestigationClaims(database, input.caseId, input.questionRef);
  const allQuestionAssessments = listInvestigationAssessments(
    database,
    input.caseId,
    input.questionRef
  );
  const allowedClaimRefs = partition.kind === 'OPEN_GAP'
    ? new Set(allQuestionClaims
        .filter((item) => getInvestigationClaimChallengeRef(database, item.claimRef) === null)
        .map((item) => item.claimRef))
    : new Set(partition.projectionClaimRefs);
  const allowedAssessmentRefs = partition.kind === 'OPEN_GAP'
    ? new Set(allQuestionAssessments
        .filter((item) => getInvestigationAssessmentChallengeRef(database, item.assessmentRef) === null)
        .map((item) => item.assessmentRef))
    : new Set(partition.projectionAssessmentRefs);
  if (
    partition.analysis.activeClaims.some((item) => !allowedClaimRefs.has(item.claimRef)) ||
    partition.analysis.structuralAssessmentHeads.some((item) =>
      !allowedAssessmentRefs.has(item.assessmentRef)
    )
  ) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_CORRUPT',
      'The effective analysis crosses the selected investigation partition.'
    );
  }
  const activeClaimRefs = new Set(partition.analysis.activeClaims.map((item) => item.claimRef));
  const structuralAssessmentRefs = new Set(
    partition.analysis.structuralAssessmentHeads.map((item) => item.assessmentRef)
  );
  const currentAssessmentRefs = new Set(
    partition.analysis.materiallyCurrentAssessmentHeads.map((item) => item.assessmentRef)
  );
  const staleReasonByAssessment = new Map(
    partition.analysis.staleAssessments.map((item) => [
      item.assessment.assessmentRef,
      canonicalInvestigatorRefs(item.reasons)
    ])
  );
  const claims = allQuestionClaims.filter((item) => allowedClaimRefs.has(item.claimRef))
    .map((item) => {
      const association = getInvestigationClaimChallengeRef(database, item.claimRef);
      const historical = currentChallengeRef !== association;
      return {
        claimRef: item.claimRef,
        lot: item.value.lot,
        originKind: item.originKind,
        evidenceRefs: canonicalInvestigatorRefs(item.evidenceRefs),
        supersedesClaimRef: item.supersedesClaimRef,
        active: activeClaimRefs.has(item.claimRef),
        partition: historical
          ? 'AUTHORITATIVE_HISTORICAL_PROVENANCE' as const
          : partition.kind === 'OPEN_GAP'
            ? 'OPEN_GAP' as const
            : partition.kind === 'OPEN_CHALLENGE'
              ? 'CURRENT_CHALLENGE' as const
              : 'CURRENT_CONTINUATION' as const,
        epistemicClass: item.originKind === 'AI_PROPOSED'
          ? 'AI_PROPOSAL' as const
          : historical
            ? 'AUTHORITATIVE_HISTORICAL_PROVENANCE' as const
            : 'CURRENT_CLAIM' as const
      };
    }).sort((left, right) => left.claimRef.localeCompare(right.claimRef));
  const assessments = allQuestionAssessments
    .filter((item) => allowedAssessmentRefs.has(item.assessmentRef))
    .map((item) => {
      const association = getInvestigationAssessmentChallengeRef(database, item.assessmentRef);
      const historical = currentChallengeRef !== association;
      return {
        assessmentRef: item.assessmentRef,
        targetClaimRef: item.targetClaimRef,
        relatedClaimRefs: canonicalInvestigatorRefs(item.relatedClaimRefs),
        evidenceRefs: canonicalInvestigatorRefs(item.evidenceRefs),
        verdict: item.verdict,
        assessorKind: item.assessorKind,
        basisCaseVersion: item.basisCaseVersion,
        supersedesAssessmentRef: item.supersedesAssessmentRef,
        structuralHead: structuralAssessmentRefs.has(item.assessmentRef),
        materiallyCurrent: currentAssessmentRefs.has(item.assessmentRef),
        staleReasons: staleReasonByAssessment.get(item.assessmentRef) ?? [],
        partition: historical
          ? 'AUTHORITATIVE_HISTORICAL_PROVENANCE' as const
          : partition.kind === 'OPEN_GAP'
            ? 'OPEN_GAP' as const
            : partition.kind === 'OPEN_CHALLENGE'
              ? 'CURRENT_CHALLENGE' as const
              : 'CURRENT_CONTINUATION' as const,
        epistemicClass: historical
          ? 'AUTHORITATIVE_HISTORICAL_PROVENANCE' as const
          : item.assessorKind === 'HUMAN'
            ? 'HUMAN_ASSESSMENT' as const
            : 'CURRENT_ASSESSMENT' as const
      };
    }).sort((left, right) => left.assessmentRef.localeCompare(right.assessmentRef));

  const issues = [
    ...partition.snapshot.investigation!.gaps
      .filter((item) => item.id === partition.question.questionRef)
      .map((item) => ({ item, kind: 'GAP' as const })),
    ...partition.snapshot.investigation!.conflicts
      .filter((item) => item.id === partition.question.questionRef)
      .map((item) => ({
      item,
      kind: 'CONFLICT' as const
    }))
  ].map(({ item, kind }) => ({
    issueRef: item.id,
    code: item.code,
    kind,
    critical: item.critical,
    subjectRefs: canonicalInvestigatorRefs(item.subjectRefs),
    evidenceRefs: canonicalInvestigatorRefs(item.evidenceRefs),
    epistemicClass: kind === 'CONFLICT'
      ? 'CONFLICTED' as const
      : partition.snapshot.investigation!.knowledgeStatus === 'UNRESOLVED'
        ? 'UNRESOLVED' as const
        : 'UNKNOWN' as const
  })).sort((left, right) => left.issueRef.localeCompare(right.issueRef));

  const memoryEvents = listInvestigatorMemoryEventsInTransaction(
    database,
    input.caseId,
    input.questionRef
  ).map((item) => ({
    recommendationRef: item.recommendationRef,
    actionKey: item.actionKey,
    recommendationKind: item.recommendationKind,
    eventKind: item.eventKind,
    supportingEvidenceRefs: item.supportingEvidenceRefs,
    basisEvidenceRefs: item.basisEvidenceRefs,
    basisRequestRefs: item.basisRequestRefs,
    basisClaimRefs: item.basisClaimRefs,
    basisAssessmentRefs: item.basisAssessmentRefs,
    basisAlertAssertionRefs: item.basisAlertAssertionRefs,
    basisCaseVersion: item.basisCaseVersion,
    basisMaterialRevision: item.basisMaterialRevision
  })).sort((left, right) => left.recommendationRef.localeCompare(right.recommendationRef) ||
    left.eventKind.localeCompare(right.eventKind));

  const establishment = establishmentState(database, partition);
  const alertFacts = alertFactsForSnapshot(database, partition.snapshot);
  const base = {
    schemaVersion: investigatorSnapshotFormatVersion,
    policyIdentifier: investigatorPolicy.identifier,
    policyVersion: investigatorPolicy.version,
    caseId: partition.snapshot.caseId,
    productId: partition.snapshot.productId,
    caseVersion: partition.snapshot.caseVersion,
    materialRevision: partition.snapshot.materialRevision!,
    question: {
      questionRef: partition.question.questionRef,
      questionType: partition.question.questionType,
      subjectRef: partition.question.subjectRef
    },
    context: partition.kind === 'OPEN_GAP'
      ? { kind: 'OPEN_GAP' as const }
      : partition.kind === 'OPEN_CHALLENGE'
        ? {
            kind: 'OPEN_CHALLENGE' as const,
            challengeRef: partition.authorization.challenge.challengeRef,
            baseline: z.record(z.string(), z.json()).parse(
              structuredClone(partition.authorization.authoritativeBaseline)
            )
          }
        : {
            kind: 'APPLIED_CHALLENGE_CONFLICT' as const,
            continuationChallengeRef: partition.authorization.challenge.challengeRef,
            sourceChallengeRef: partition.authorization.authoritativeBaseline.sourceChallengeRef,
            conflictApplicationRef:
              partition.authorization.authoritativeBaseline.conflictApplicationRef,
            baseline: z.record(z.string(), z.json()).parse(
              structuredClone(partition.authorization.authoritativeBaseline)
            )
          },
    authoritative: {
      outcome: structuredClone(partition.snapshot.investigation!),
      epistemicClass: 'AUTHORITATIVE_CURRENT_FACT' as const,
      provenanceRefs: canonicalInvestigatorRefs([
        ...partition.snapshot.investigation!.evidenceRefs,
        ...partition.snapshot.investigation!.decisionRefs
      ]),
      provenanceLimitations: alertFacts.sourceObservationRef === null
        ? ['LEGACY_ALERT_PROVENANCE_UNAVAILABLE'] : []
    },
    evidence,
    requests,
    claims,
    assessments,
    issues,
    establishment,
    alertFacts,
    memoryEvents,
    operational: {
      stage: partition.snapshot.stage,
      exposureStatus: partition.snapshot.exposure.status,
      closureStatus: partition.snapshot.closure.status,
      tasks: partition.snapshot.tasks.map((task) => ({
        taskRef: task.id,
        type: task.type,
        status: task.status
      })).sort((left, right) => left.taskRef.localeCompare(right.taskRef))
    }
  };
  const candidate = {
    ...base,
    allowedCapabilities: deriveInvestigatorCapabilities(base)
  };
  if (
    evidence.length > investigatorLimits.evidence ||
    requests.length > investigatorLimits.requests ||
    claims.length > investigatorLimits.claims ||
    assessments.length > investigatorLimits.assessments ||
    issues.length > investigatorLimits.issues ||
    memoryEvents.length > investigatorLimits.memoryEvents ||
    candidate.operational.tasks.length > investigatorLimits.tasks ||
    containsOversizedText(candidate) ||
    Buffer.byteLength(canonicalInvestigatorJson(candidate), 'utf8') >
      investigatorLimits.canonicalInputBytes
  ) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_TOO_LARGE',
      'The complete relevant investigation context exceeds safe model bounds.'
    );
  }
  const parsedSnapshot = investigatorSnapshotSchema.safeParse(candidate);
  if (!parsedSnapshot.success) {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_CORRUPT',
      'The complete relevant investigation context is structurally invalid.'
    );
  }
  const snapshot = parsedSnapshot.data;
  try {
    assertInvestigatorSnapshotBounds(snapshot);
  } catch {
    throw new InvestigatorSnapshotError(
      'INVESTIGATOR_CONTEXT_TOO_LARGE',
      'The complete relevant investigation context exceeds safe model bounds.'
    );
  }
  return snapshot;
}
