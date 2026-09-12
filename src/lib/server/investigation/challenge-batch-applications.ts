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
  readCaseSnapshot,
  type LifecycleContext,
  type StoredCaseRevision
} from '../workflow/case-lifecycle';
import {
  ChallengeBatchApplicationBasisError,
  readChallengeBatchApplicationBasisInTransaction
} from './challenge-batch-application-basis';
import {
  challengeBatchApplicationCommandPayload,
  getInvestigationChallengeBatchApplication,
  InvestigationChallengeBatchApplicationError,
  readInvestigationChallengeBatchApplicationResult,
  type InvestigationChallengeBatchApplication,
  type InvestigationChallengeBatchApplicationErrorCode
} from './authoritative-challenge-baseline';
import { demoHumanAssessorIdentifier } from './demo-context';

export {
  getInvestigationChallengeBatchApplication,
  InvestigationChallengeBatchApplicationError
} from './authoritative-challenge-baseline';
export type {
  InvestigationChallengeBatchApplication,
  InvestigationChallengeBatchApplicationErrorCode
} from './authoritative-challenge-baseline';

const opaqueReferenceSchema = z.string().min(1).max(500).refine(
  (value) => value.trim().length > 0,
  'References must contain a non-whitespace character.'
);
const rationaleSchema = z.string().trim().min(1).max(10_000);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

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

export type ApplyInvestigationChallengeBatchInput = z.infer<
  typeof applyInvestigationChallengeBatchInputSchema
>;

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

function deriveChallengeBatchOutcome(
  current: CaseSnapshot,
  applicationRef: string,
  appliedEvidenceRefs: readonly string[],
  appliedLot: string,
  updatedAt: string
): InvestigationOutcome {
  const investigation = current.investigation;
  const knownSource = investigation?.knowledgeStatus === 'KNOWN' &&
    investigation.scope.kind === 'BATCH_LOT' &&
    investigation.scope.knowledgeStatus === 'KNOWN' &&
    investigation.scope.lots.length === 1 &&
    investigation.gaps.length === 0 && investigation.conflicts.length === 0;
  const conflictContinuationSource = investigation?.knowledgeStatus === 'CONFLICTED' &&
    investigation.scope.kind === 'UNRESOLVED' &&
    investigation.scope.knowledgeStatus === 'CONFLICTED' &&
    investigation.gaps.length === 0 && investigation.conflicts.length === 1 &&
    investigation.conflicts[0].code === 'BATCH_CONFLICT';
  if (
    !investigation || current.materialRevision === null ||
    investigation.materialRevision !== current.materialRevision ||
    investigation.identity.knowledgeStatus !== 'KNOWN' ||
    investigation.identity.conclusion !== 'MATCH' ||
    (!knownSource && !conflictContinuationSource) ||
    !investigation.demo || appliedLot.length === 0
  ) {
    throw new InvestigationChallengeBatchApplicationError(
      'APPLICATION_NOT_ELIGIBLE',
      'The authoritative source is neither a clean known-batch state nor one exact applied conflict.'
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
      const historical = readInvestigationChallengeBatchApplicationResult(
        transaction,
        parsed.caseId,
        parsed.applicationRef
      );
      if (!historical) {
        throw new InvestigationChallengeBatchApplicationError(
          'APPLICATION_PROVENANCE_INVALID',
          'The historical Challenge batch application could not be reloaded.'
        );
      }
      return { application: historical.application, replayed: true, snapshot: historical.snapshot };
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
      commandPayloadJson: challengeBatchApplicationCommandPayload(command),
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
