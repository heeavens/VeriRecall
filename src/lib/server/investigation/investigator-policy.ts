import { createHash } from 'node:crypto';

import { z } from 'zod';

import { investigationOutcomeSchema } from '../../contracts/recall';
import { evidenceTypes } from '../workflow/review';

export const investigatorSnapshotFormatVersion = 1 as const;
export const investigatorPolicy = {
  identifier: 'verirecall-constrained-investigator',
  version: 1,
  promptPolicyVersion: 'v1'
} as const;

export const investigatorLimits = {
  evidence: 64,
  requests: 64,
  claims: 128,
  assessments: 256,
  issues: 128,
  tasks: 64,
  memoryEvents: 128,
  freeText: 2_048,
  canonicalInputBytes: 65_536
} as const;

const referenceSchema = z.string().trim().min(1).max(500);
const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime();
const canonicalReferenceArraySchema = (item: z.ZodType<string> = referenceSchema) =>
  z.array(item).refine(
    (values) => new Set(values).size === values.length &&
      values.every((value, index) => index === 0 || values[index - 1] < value),
    'References must be unique and lexically ordered.'
  );

export const investigatorEpistemicClasses = [
  'AUTHORITATIVE_CURRENT_FACT',
  'AUTHORITATIVE_HISTORICAL_PROVENANCE',
  'CURRENT_CLAIM',
  'CURRENT_ASSESSMENT',
  'AI_PROPOSAL',
  'HUMAN_ASSESSMENT',
  'UNKNOWN',
  'PENDING_PROVEN',
  'CONFLICTED',
  'UNRESOLVED',
  'LEGACY_UNVERIFIED',
  'OPERATIONAL_STATE'
] as const;

const contextSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('OPEN_GAP') }),
  z.strictObject({
    kind: z.literal('OPEN_CHALLENGE'),
    challengeRef: uuidSchema,
    baseline: z.record(z.string(), z.json())
  }),
  z.strictObject({
    kind: z.literal('APPLIED_CHALLENGE_CONFLICT'),
    continuationChallengeRef: uuidSchema,
    sourceChallengeRef: uuidSchema,
    conflictApplicationRef: uuidSchema,
    baseline: z.record(z.string(), z.json())
  })
]);

const investigatorEvidenceSchema = z.strictObject({
  evidenceRef: referenceSchema,
  sourceKind: z.enum(['REGULATOR', 'INTERNAL', 'EXTERNAL_PARTY', 'HUMAN_OBSERVED']),
  contentKind: z.enum(['STRUCTURED', 'LOCATOR']),
  evidenceRequestId: uuidSchema.nullable(),
  receivedAt: timestampSchema,
  validAsOf: timestampSchema.nullable(),
  integrityHash: z.string().regex(/^[0-9a-f]{64}$/),
  relevance: z.enum([
    'OPEN_GAP',
    'CURRENT_CHALLENGE',
    'CURRENT_CONTINUATION',
    'INITIAL_BASELINE',
    'INHERITED_BASELINE',
    'AUTHORITATIVE_CONFLICT_BASELINE',
    'HISTORICAL'
  ]),
  epistemicClass: z.enum(investigatorEpistemicClasses)
});

const investigatorRequestSchema = z.strictObject({
  requestRef: uuidSchema,
  requestedEvidence: canonicalReferenceArraySchema(z.enum(evidenceTypes)).min(1),
  contextChallengeRef: uuidSchema.nullable(),
  linkedEvidenceRefs: canonicalReferenceArraySchema(),
  lifecycle: z.enum([
    'REQUEST_ATTEMPT_RECORDED',
    'RESPONSE_EVIDENCE_RECEIVED',
    'HISTORICAL'
  ]),
  createdAt: timestampSchema,
  epistemicClass: z.enum(investigatorEpistemicClasses)
});

const investigatorClaimSchema = z.strictObject({
  claimRef: uuidSchema,
  lot: z.string().trim().min(1).max(500),
  originKind: z.enum(['DETERMINISTIC_EXTRACTED', 'AI_PROPOSED', 'HUMAN_OBSERVED']),
  evidenceRefs: canonicalReferenceArraySchema().min(1),
  supersedesClaimRef: uuidSchema.nullable(),
  active: z.boolean(),
  partition: z.enum([
    'OPEN_GAP',
    'CURRENT_CHALLENGE',
    'CURRENT_CONTINUATION',
    'AUTHORITATIVE_HISTORICAL_PROVENANCE'
  ]),
  epistemicClass: z.enum(investigatorEpistemicClasses)
});

const investigatorAssessmentSchema = z.strictObject({
  assessmentRef: uuidSchema,
  targetClaimRef: uuidSchema.nullable(),
  relatedClaimRefs: canonicalReferenceArraySchema(uuidSchema),
  evidenceRefs: canonicalReferenceArraySchema().min(1),
  verdict: z.enum(['SUPPORTED', 'INSUFFICIENT', 'REJECTED', 'CONTRADICTED']),
  assessorKind: z.enum(['RULE', 'HUMAN', 'AI']),
  basisCaseVersion: z.number().int().positive(),
  supersedesAssessmentRef: uuidSchema.nullable(),
  structuralHead: z.boolean(),
  materiallyCurrent: z.boolean(),
  staleReasons: canonicalReferenceArraySchema(),
  partition: z.enum([
    'OPEN_GAP',
    'CURRENT_CHALLENGE',
    'CURRENT_CONTINUATION',
    'AUTHORITATIVE_HISTORICAL_PROVENANCE'
  ]),
  epistemicClass: z.enum(investigatorEpistemicClasses)
});

const investigatorIssueSchema = z.strictObject({
  issueRef: referenceSchema,
  code: referenceSchema,
  kind: z.enum(['GAP', 'CONFLICT']),
  critical: z.boolean(),
  subjectRefs: canonicalReferenceArraySchema(),
  evidenceRefs: canonicalReferenceArraySchema(),
  epistemicClass: z.enum(investigatorEpistemicClasses)
});

const attributedAlertFactSchema = z.strictObject({
  assertionRef: referenceSchema,
  fieldKind: z.enum(['PRODUCT_NAME', 'BRAND', 'EAN_GTIN', 'BATCH_LOT', 'CATEGORY']),
  normalizedValue: z.string().trim().min(1).max(500),
  originKind: z.enum([
    'SOURCE_ASSERTED',
    'DETERMINISTIC_DERIVED',
    'AI_PROPOSAL',
    'HUMAN_CONFIRMED',
    'LEGACY_UNVERIFIED'
  ]),
  authorityCapable: z.boolean(),
  epistemicClass: z.enum(investigatorEpistemicClasses)
});

const investigatorEstablishmentSchema = z.strictObject({
  establishmentRef: uuidSchema,
  currentlyEligible: z.boolean(),
  blockerCodes: canonicalReferenceArraySchema()
});

const investigatorMemoryEventSchema = z.strictObject({
  recommendationRef: uuidSchema,
  actionKey: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  recommendationKind: z.enum([
    'REQUEST_EVIDENCE',
    'REVIEW_EXISTING_EVIDENCE',
    'FOLLOW_UP_RECORDED_REQUEST',
    'WAIT_FOR_PENDING_EVIDENCE',
    'ESCALATE_UNRESOLVED_TO_HUMAN',
    'NO_ACTION'
  ]),
  eventKind: z.enum(['DISMISSED', 'ACTED', 'PATH_EXHAUSTED']),
  supportingEvidenceRefs: canonicalReferenceArraySchema(),
  basisEvidenceRefs: canonicalReferenceArraySchema(),
  basisRequestRefs: canonicalReferenceArraySchema(uuidSchema),
  basisClaimRefs: canonicalReferenceArraySchema(uuidSchema),
  basisAssessmentRefs: canonicalReferenceArraySchema(uuidSchema),
  basisAlertAssertionRefs: canonicalReferenceArraySchema(),
  basisCaseVersion: z.number().int().positive(),
  basisMaterialRevision: z.number().int().positive()
});

const taskSummarySchema = z.strictObject({
  taskRef: referenceSchema,
  type: referenceSchema,
  status: referenceSchema
});

export const investigatorCapabilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('REQUEST_EVIDENCE'),
    evidenceType: z.enum(evidenceTypes),
    target: z.literal('CURRENT_PRODUCT_SUPPLIER')
  }),
  z.strictObject({
    kind: z.literal('REVIEW_EXISTING_EVIDENCE'),
    evidenceRefs: canonicalReferenceArraySchema().min(1),
    claimRefs: canonicalReferenceArraySchema(uuidSchema)
  }),
  z.strictObject({
    kind: z.literal('FOLLOW_UP_RECORDED_REQUEST'),
    requestRef: uuidSchema
  }),
  z.strictObject({
    kind: z.literal('WAIT_FOR_PENDING_EVIDENCE'),
    pendingProcessRef: referenceSchema
  }),
  z.strictObject({
    kind: z.literal('ESCALATE_UNRESOLVED_TO_HUMAN'),
    issueRefs: canonicalReferenceArraySchema().min(1)
  }),
  z.strictObject({
    kind: z.literal('NO_ACTION'),
    reason: z.enum(['QUESTION_RESOLVED', 'AWAITING_HUMAN_AUTHORITY'])
  })
]);

export type InvestigatorCapability = z.infer<typeof investigatorCapabilitySchema>;

export const investigatorSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(investigatorSnapshotFormatVersion),
  policyIdentifier: z.literal(investigatorPolicy.identifier),
  policyVersion: z.literal(investigatorPolicy.version),
  caseId: uuidSchema,
  productId: uuidSchema,
  caseVersion: z.number().int().positive(),
  materialRevision: z.number().int().positive(),
  question: z.strictObject({
    questionRef: referenceSchema,
    questionType: z.literal('AFFECTED_BATCH_LOT'),
    subjectRef: uuidSchema
  }),
  context: contextSchema,
  authoritative: z.strictObject({
    outcome: investigationOutcomeSchema,
    epistemicClass: z.literal('AUTHORITATIVE_CURRENT_FACT'),
    provenanceRefs: canonicalReferenceArraySchema(),
    provenanceLimitations: canonicalReferenceArraySchema()
  }),
  evidence: z.array(investigatorEvidenceSchema).max(investigatorLimits.evidence),
  requests: z.array(investigatorRequestSchema).max(investigatorLimits.requests),
  claims: z.array(investigatorClaimSchema).max(investigatorLimits.claims),
  assessments: z.array(investigatorAssessmentSchema).max(investigatorLimits.assessments),
  issues: z.array(investigatorIssueSchema).max(investigatorLimits.issues),
  establishment: z.strictObject({
    evaluations: z.array(investigatorEstablishmentSchema),
    awaitingHumanAuthority: z.boolean()
  }),
  alertFacts: z.strictObject({
    sourceObservationRef: referenceSchema.nullable(),
    matchBasisDigest: z.string().nullable(),
    authoritative: z.array(attributedAlertFactSchema),
    hypotheses: z.array(attributedAlertFactSchema),
    unverified: z.array(attributedAlertFactSchema),
    blockers: canonicalReferenceArraySchema()
  }),
  memoryEvents: z.array(investigatorMemoryEventSchema).max(investigatorLimits.memoryEvents),
  operational: z.strictObject({
    stage: referenceSchema,
    exposureStatus: referenceSchema,
    closureStatus: referenceSchema,
    tasks: z.array(taskSummarySchema).max(investigatorLimits.tasks)
  }),
  allowedCapabilities: z.array(investigatorCapabilitySchema)
});

export type InvestigatorSnapshot = z.infer<typeof investigatorSnapshotSchema>;
export type InvestigatorModelInputV1 = InvestigatorSnapshot;

export function deriveInvestigatorCapabilities(
  snapshot: Omit<InvestigatorSnapshot, 'allowedCapabilities'>
): InvestigatorCapability[] {
  if (snapshot.establishment.awaitingHumanAuthority) {
    return [{ kind: 'NO_ACTION', reason: 'AWAITING_HUMAN_AUTHORITY' }];
  }
  const capabilities: InvestigatorCapability[] = [];
  const currentStateRefs = {
    evidence: canonicalInvestigatorRefs(snapshot.evidence.map((item) => item.evidenceRef)),
    requests: canonicalInvestigatorRefs(snapshot.requests.map((item) => item.requestRef)),
    claims: canonicalInvestigatorRefs(snapshot.claims.map((item) => item.claimRef)),
    assessments: canonicalInvestigatorRefs(
      snapshot.assessments.map((item) => item.assessmentRef)
    ),
    alertAssertions: canonicalInvestigatorRefs([
      ...snapshot.alertFacts.authoritative,
      ...snapshot.alertFacts.hypotheses,
      ...snapshot.alertFacts.unverified
    ].map((item) => item.assertionRef))
  };
  const sameRefs = (left: readonly string[], right: readonly string[]) =>
    JSON.stringify(left) === JSON.stringify(right);
  const blockedActionKeys = new Set(snapshot.memoryEvents.filter((item) =>
    item.basisMaterialRevision === snapshot.materialRevision &&
    sameRefs(item.basisEvidenceRefs, currentStateRefs.evidence) &&
    sameRefs(item.basisRequestRefs, currentStateRefs.requests) &&
    sameRefs(item.basisClaimRefs, currentStateRefs.claims) &&
    sameRefs(item.basisAssessmentRefs, currentStateRefs.assessments) &&
    sameRefs(item.basisAlertAssertionRefs, currentStateRefs.alertAssertions)
  ).map((item) => item.actionKey));
  const currentRequests = snapshot.requests.filter((item) => item.lifecycle !== 'HISTORICAL');
  const attemptedEvidenceTypes = new Set(currentRequests.flatMap((item) => item.requestedEvidence));
  for (const evidenceType of evidenceTypes) {
    const recommendation: InvestigatorRecommendation = {
      kind: 'REQUEST_EVIDENCE',
      evidenceType,
      target: 'CURRENT_PRODUCT_SUPPLIER'
    };
    if (
      !attemptedEvidenceTypes.has(evidenceType) &&
      !blockedActionKeys.has(investigatorActionKey(snapshot.question.questionRef, recommendation))
    ) {
      capabilities.push(recommendation);
    }
  }
  for (const request of currentRequests.filter((item) => item.linkedEvidenceRefs.length === 0)) {
    const capability: InvestigatorCapability = {
      kind: 'FOLLOW_UP_RECORDED_REQUEST',
      requestRef: request.requestRef
    };
    if (!blockedActionKeys.has(investigatorActionKey(snapshot.question.questionRef, capability))) {
      capabilities.push(capability);
    }
  }

  const currentAssessmentEvidence = new Set(
    snapshot.assessments
      .filter((item) => item.materiallyCurrent)
      .flatMap((item) => item.evidenceRefs)
  );
  const reviewEvidenceRefs = canonicalInvestigatorRefs(
    snapshot.evidence
      .filter((item) => item.relevance !== 'HISTORICAL')
      .map((item) => item.evidenceRef)
      .filter((ref) => !currentAssessmentEvidence.has(ref))
  );
  if (reviewEvidenceRefs.length > 0) {
    const review: InvestigatorCapability = {
      kind: 'REVIEW_EXISTING_EVIDENCE',
      evidenceRefs: reviewEvidenceRefs,
      claimRefs: canonicalInvestigatorRefs(
        snapshot.claims.filter((item) => item.active).map((item) => item.claimRef)
      )
    };
    if (!blockedActionKeys.has(investigatorActionKey(snapshot.question.questionRef, review))) {
      capabilities.push(review);
    }
  }

  if (capabilities.length === 0 && snapshot.issues.length > 0) {
    capabilities.push({
      kind: 'ESCALATE_UNRESOLVED_TO_HUMAN',
      issueRefs: canonicalInvestigatorRefs(snapshot.issues.map((item) => item.issueRef))
    });
  }
  return capabilities;
}

export const investigatorRecommendationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('REQUEST_EVIDENCE'),
    evidenceType: z.enum(evidenceTypes),
    target: z.literal('CURRENT_PRODUCT_SUPPLIER')
  }),
  z.strictObject({
    kind: z.literal('REVIEW_EXISTING_EVIDENCE'),
    evidenceRefs: z.array(referenceSchema).min(1).max(64),
    claimRefs: z.array(uuidSchema).max(64)
  }),
  z.strictObject({
    kind: z.literal('FOLLOW_UP_RECORDED_REQUEST'),
    requestRef: uuidSchema
  }),
  z.strictObject({
    kind: z.literal('WAIT_FOR_PENDING_EVIDENCE'),
    pendingProcessRef: referenceSchema
  }),
  z.strictObject({
    kind: z.literal('ESCALATE_UNRESOLVED_TO_HUMAN'),
    issueRefs: z.array(referenceSchema).min(1).max(32)
  }),
  z.strictObject({
    kind: z.literal('NO_ACTION'),
    reason: z.enum(['QUESTION_RESOLVED', 'AWAITING_HUMAN_AUTHORITY'])
  })
]);

const modelReferenceBasisSchema = z.strictObject({
  evidenceRefs: z.array(referenceSchema).max(64),
  claimRefs: z.array(uuidSchema).max(64),
  assessmentRefs: z.array(uuidSchema).max(64),
  issueRefs: z.array(referenceSchema).max(32),
  requestRefs: z.array(uuidSchema).max(32)
});

export const investigatorModelOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  recommendation: investigatorRecommendationSchema,
  rationale: z.string().trim().min(1).max(2_000),
  basedOn: modelReferenceBasisSchema,
  expectedInformationGain: z.string().trim().min(1).max(1_000).nullable(),
  limitations: z.array(z.string().trim().min(1).max(500)).max(10)
});

export type InvestigatorRecommendation = z.infer<typeof investigatorRecommendationSchema>;
export type InvestigatorModelOutput = z.infer<typeof investigatorModelOutputSchema>;

export type InvestigatorValidationErrorCode =
  | 'INVESTIGATOR_OUTPUT_INVALID'
  | 'INVESTIGATOR_REFERENCE_INVALID'
  | 'INVESTIGATOR_ACTION_FORBIDDEN';

export class InvestigatorValidationError extends Error {
  constructor(
    public readonly code: InvestigatorValidationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InvestigatorValidationError';
  }
}

export function canonicalInvestigatorJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInvestigatorJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalInvestigatorJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function investigatorDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalInvestigatorJson(value)).digest('hex')}`;
}

export function canonicalInvestigatorRefs(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function canonicalRecommendation(
  recommendation: InvestigatorRecommendation
): InvestigatorRecommendation {
  if (recommendation.kind === 'REVIEW_EXISTING_EVIDENCE') {
    return {
      ...recommendation,
      evidenceRefs: canonicalInvestigatorRefs(recommendation.evidenceRefs),
      claimRefs: canonicalInvestigatorRefs(recommendation.claimRefs)
    };
  }
  if (recommendation.kind === 'ESCALATE_UNRESOLVED_TO_HUMAN') {
    return { ...recommendation, issueRefs: canonicalInvestigatorRefs(recommendation.issueRefs) };
  }
  return recommendation;
}

export function parseInvestigatorModelOutput(value: unknown): InvestigatorModelOutput {
  const parsed = investigatorModelOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvestigatorValidationError(
      'INVESTIGATOR_OUTPUT_INVALID',
      'The Investigator returned an invalid structured recommendation.'
    );
  }
  return investigatorModelOutputSchema.parse({
    ...parsed.data,
    recommendation: canonicalRecommendation(parsed.data.recommendation),
    basedOn: {
      evidenceRefs: canonicalInvestigatorRefs(parsed.data.basedOn.evidenceRefs),
      claimRefs: canonicalInvestigatorRefs(parsed.data.basedOn.claimRefs),
      assessmentRefs: canonicalInvestigatorRefs(parsed.data.basedOn.assessmentRefs),
      issueRefs: canonicalInvestigatorRefs(parsed.data.basedOn.issueRefs),
      requestRefs: canonicalInvestigatorRefs(parsed.data.basedOn.requestRefs)
    },
    limitations: [...new Set(parsed.data.limitations.map((item) => item.trim()))]
  });
}

export function investigatorActionKey(
  questionRef: string,
  recommendation: InvestigatorRecommendation
): string {
  let semantic: unknown;
  switch (recommendation.kind) {
    case 'REQUEST_EVIDENCE':
      semantic = {
        kind: recommendation.kind,
        questionRef,
        evidenceType: recommendation.evidenceType,
        target: recommendation.target
      };
      break;
    case 'REVIEW_EXISTING_EVIDENCE':
      semantic = {
        kind: recommendation.kind,
        questionRef,
        evidenceRefs: canonicalInvestigatorRefs(recommendation.evidenceRefs),
        claimRefs: canonicalInvestigatorRefs(recommendation.claimRefs)
      };
      break;
    case 'FOLLOW_UP_RECORDED_REQUEST':
      semantic = { kind: recommendation.kind, questionRef, requestRef: recommendation.requestRef };
      break;
    case 'WAIT_FOR_PENDING_EVIDENCE':
      semantic = {
        kind: recommendation.kind,
        questionRef,
        pendingProcessRef: recommendation.pendingProcessRef
      };
      break;
    case 'ESCALATE_UNRESOLVED_TO_HUMAN':
      semantic = {
        kind: recommendation.kind,
        questionRef,
        issueRefs: canonicalInvestigatorRefs(recommendation.issueRefs)
      };
      break;
    case 'NO_ACTION':
      semantic = { kind: recommendation.kind, questionRef, reason: recommendation.reason };
  }
  return investigatorDigest(semantic);
}

function capabilityAllows(
  capability: InvestigatorCapability,
  recommendation: InvestigatorRecommendation
): boolean {
  if (capability.kind !== recommendation.kind) return false;
  switch (recommendation.kind) {
    case 'REQUEST_EVIDENCE':
      return capability.kind === 'REQUEST_EVIDENCE' &&
        capability.evidenceType === recommendation.evidenceType &&
        capability.target === recommendation.target;
    case 'REVIEW_EXISTING_EVIDENCE':
      return capability.kind === 'REVIEW_EXISTING_EVIDENCE' &&
        recommendation.evidenceRefs.every((ref) => capability.evidenceRefs.includes(ref)) &&
        recommendation.claimRefs.every((ref) => capability.claimRefs.includes(ref));
    case 'FOLLOW_UP_RECORDED_REQUEST':
      return capability.kind === 'FOLLOW_UP_RECORDED_REQUEST' &&
        capability.requestRef === recommendation.requestRef;
    case 'WAIT_FOR_PENDING_EVIDENCE':
      return capability.kind === 'WAIT_FOR_PENDING_EVIDENCE' &&
        capability.pendingProcessRef === recommendation.pendingProcessRef;
    case 'ESCALATE_UNRESOLVED_TO_HUMAN':
      return capability.kind === 'ESCALATE_UNRESOLVED_TO_HUMAN' &&
        recommendation.issueRefs.every((ref) => capability.issueRefs.includes(ref));
    case 'NO_ACTION':
      return capability.kind === 'NO_ACTION' && capability.reason === recommendation.reason;
  }
}

function containsDisguisedCommand(value: string): boolean {
  return /(?:^|[\n.!?]\s*)(?:close|reopen|send|email|notify|contact|hold|release|apply|establish|confirm|execute|run)\b/i.test(value) ||
    /\b(?:should|must|please|recommend(?:s|ed)?(?:\s+that)?(?:\s+the\s+operator|\s+you)?(?:\s+to)?)\s+(?:close|reopen|send|email|notify|contact|hold|release|apply|establish|confirm|execute|run)\b/i.test(value) ||
    /(?:https?:\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|```|\b(?:select|insert|update|delete|drop)\s+.+\b(?:from|into|set|table)\b)/i.test(value);
}

function allBasedOnRefs(output: InvestigatorModelOutput): string[] {
  return [
    ...output.basedOn.evidenceRefs,
    ...output.basedOn.claimRefs,
    ...output.basedOn.assessmentRefs,
    ...output.basedOn.issueRefs,
    ...output.basedOn.requestRefs
  ];
}

export function validateInvestigatorRecommendation(
  snapshotInput: InvestigatorSnapshot,
  outputInput: InvestigatorModelOutput
): InvestigatorModelOutput {
  const snapshot = investigatorSnapshotSchema.parse(snapshotInput);
  const output = parseInvestigatorModelOutput(outputInput);
  const evidenceRefs = new Set(snapshot.evidence.map((item) => item.evidenceRef));
  const claimRefs = new Set(snapshot.claims.map((item) => item.claimRef));
  const assessmentRefs = new Set(snapshot.assessments.map((item) => item.assessmentRef));
  const issueRefs = new Set(snapshot.issues.map((item) => item.issueRef));
  const requestRefs = new Set(snapshot.requests.map((item) => item.requestRef));
  if (
    output.basedOn.evidenceRefs.some((ref) => !evidenceRefs.has(ref)) ||
    output.basedOn.claimRefs.some((ref) => !claimRefs.has(ref)) ||
    output.basedOn.assessmentRefs.some((ref) => !assessmentRefs.has(ref)) ||
    output.basedOn.issueRefs.some((ref) => !issueRefs.has(ref)) ||
    output.basedOn.requestRefs.some((ref) => !requestRefs.has(ref))
  ) {
    throw new InvestigatorValidationError(
      'INVESTIGATOR_REFERENCE_INVALID',
      'The recommendation cites a missing or excluded investigation reference.'
    );
  }
  if (!snapshot.allowedCapabilities.some((item) => capabilityAllows(item, output.recommendation))) {
    throw new InvestigatorValidationError(
      'INVESTIGATOR_ACTION_FORBIDDEN',
      'The recommendation is not permitted by the current investigation capabilities.'
    );
  }
  if (output.recommendation.kind !== 'NO_ACTION' && allBasedOnRefs(output).length === 0) {
    throw new InvestigatorValidationError(
      'INVESTIGATOR_REFERENCE_INVALID',
      'A recommendation must cite its exact investigation basis.'
    );
  }
  if (output.recommendation.kind === 'REVIEW_EXISTING_EVIDENCE') {
    if (
      output.recommendation.evidenceRefs.some((ref) => !output.basedOn.evidenceRefs.includes(ref)) ||
      output.recommendation.claimRefs.some((ref) => !output.basedOn.claimRefs.includes(ref))
    ) {
      throw new InvestigatorValidationError(
        'INVESTIGATOR_REFERENCE_INVALID',
        'Evidence-review targets must also appear in the grounded reference basis.'
      );
    }
  }
  if (
    output.recommendation.kind === 'FOLLOW_UP_RECORDED_REQUEST' &&
    !output.basedOn.requestRefs.includes(output.recommendation.requestRef)
  ) {
    throw new InvestigatorValidationError(
      'INVESTIGATOR_REFERENCE_INVALID',
      'A follow-up recommendation must cite the exact recorded request.'
    );
  }
  if (
    output.recommendation.kind === 'ESCALATE_UNRESOLVED_TO_HUMAN' &&
    output.recommendation.issueRefs.some((ref) => !output.basedOn.issueRefs.includes(ref))
  ) {
    throw new InvestigatorValidationError(
      'INVESTIGATOR_REFERENCE_INVALID',
      'An escalation must cite each exact unresolved issue.'
    );
  }
  const prose = [output.rationale, output.expectedInformationGain ?? '', ...output.limitations]
    .join('\n');
  if ([output.rationale, output.expectedInformationGain ?? '', ...output.limitations]
    .some(containsDisguisedCommand)) {
    throw new InvestigatorValidationError(
      'INVESTIGATOR_ACTION_FORBIDDEN',
      'Recommendation prose contains an executable or consequential instruction.'
    );
  }

  for (const value of snapshot.alertFacts.hypotheses.map((item) => item.normalizedValue)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(escaped, 'i').test(prose) && (
      !/(proposal|hypothesis|unverified|not confirmed|not established|non-authoritative)/i
        .test(prose) ||
      new RegExp(
        `${escaped}\\s+(?:is|=)\\s+(?:the\\s+)?(?:true|correct|winning|affected|established|confirmed)\\b`,
        'i'
      ).test(prose)
    )) {
      throw new InvestigatorValidationError(
        'INVESTIGATOR_ACTION_FORBIDDEN',
        'An AI-proposed value may be mentioned only as an explicitly unverified hypothesis.'
      );
    }
  }
  if (snapshot.authoritative.outcome.knowledgeStatus === 'CONFLICTED') {
    const lots = snapshot.claims.filter((item) => item.active).map((item) => item.lot);
    if (lots.some((lot) => {
      const escaped = lot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(
        `\\b(?:choose|select|confirm|establish|accept)\\s+(?:batch\\s+|lot\\s+)?${escaped}\\b|` +
        `${escaped}\\s+(?:is|=)\\s+(?:the\\s+)?(?:true|correct|winning|affected|established|confirmed)\\b|` +
        `\\b(?:true|correct|winning|affected|established|confirmed)\\s+(?:batch\\s+|lot\\s+)?${escaped}\\b`,
        'i'
      ).test(prose);
    })) {
      throw new InvestigatorValidationError(
        'INVESTIGATOR_ACTION_FORBIDDEN',
        'The Investigator may not select a winner while conflict is authoritative.'
      );
    }
  }
  return output;
}

export function assertInvestigatorSnapshotBounds(snapshot: InvestigatorSnapshot): void {
  const parsed = investigatorSnapshotSchema.safeParse(snapshot);
  if (!parsed.success || Buffer.byteLength(canonicalInvestigatorJson(snapshot), 'utf8') >
      investigatorLimits.canonicalInputBytes) {
    throw new Error('INVESTIGATOR_CONTEXT_TOO_LARGE');
  }
}
