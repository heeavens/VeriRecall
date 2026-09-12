import {
  investigationOutcomeSchema,
  type InvestigationOutcome
} from '../../contracts/recall';
import { validateGtin } from '../alerts/gtin';
import { normalizeBatch } from '../alerts/normalization';

export interface TrustedAlertOutcomeValue {
  normalizedValue: string;
  assertionRefs: string[];
}

export interface ProduceInvestigationOutcomeInput {
  caseId: string;
  productId: string;
  matchId: string;
  materialRevision: number;
  updatedAt: string;
  trustedAlertFacts: {
    sourceObservationRef: string;
    eans: TrustedAlertOutcomeValue[];
    batches: TrustedAlertOutcomeValue[];
  };
  catalogueEan: string | null;
  catalogueBatch: string | null;
  provenanceRefs: {
    catalogueProduct: string;
    matchBasis: string;
  };
  decisionRefs: {
    review: string;
  };
  demo: boolean;
}

function canonicalRefs(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function produceInvestigationOutcome(
  input: ProduceInvestigationOutcomeInput
): InvestigationOutcome {
  const catalogueGtin = validateGtin(input.catalogueEan);
  for (const item of input.trustedAlertFacts.eans) {
    const validation = validateGtin(item.normalizedValue);
    if (
      !validation.valid ||
      validation.normalized !== item.normalizedValue ||
      item.assertionRefs.length === 0 ||
      item.assertionRefs.some((ref) => !ref.trim())
    ) {
      throw new Error('Trusted alert GTIN input is not valid attributed provenance.');
    }
  }
  if (!input.trustedAlertFacts.sourceObservationRef.trim()) {
    throw new Error('Trusted alert facts require an immutable source observation.');
  }
  for (const item of input.trustedAlertFacts.batches) {
    if (
      !normalizeBatch(item.normalizedValue) ||
      normalizeBatch(item.normalizedValue) !== item.normalizedValue ||
      item.assertionRefs.length === 0 ||
      item.assertionRefs.some((ref) => !ref.trim())
    ) {
      throw new Error('Trusted alert batch input is not valid attributed provenance.');
    }
  }
  const trustedEans = [...new Map(
    input.trustedAlertFacts.eans.map((item) => [item.normalizedValue, item])
  ).values()];
  const trustedBatches = [...new Map(
    input.trustedAlertFacts.batches.map((item) => [normalizeBatch(item.normalizedValue), item])
  ).values()].filter((item) => normalizeBatch(item.normalizedValue));
  const identityAssertionRefs = canonicalRefs(trustedEans.flatMap((item) => item.assertionRefs));
  const scopeAssertionRefs = canonicalRefs(trustedBatches.flatMap((item) => item.assertionRefs));
  const identityEvidence = canonicalRefs([
    input.trustedAlertFacts.sourceObservationRef,
    ...identityAssertionRefs,
    input.provenanceRefs.catalogueProduct,
    input.provenanceRefs.matchBasis
  ]);
  const catalogueEan = catalogueGtin.valid ? catalogueGtin.normalized : null;
  const hasComparableEans = trustedEans.length === 1 && Boolean(catalogueEan);
  const hasHardIdentityConflict = trustedEans.length > 1 || Boolean(
    hasComparableEans && trustedEans[0].normalizedValue !== catalogueEan
  );
  const hasDeterministicIdentityMatch = Boolean(
    hasComparableEans && trustedEans[0].normalizedValue === catalogueEan && !hasHardIdentityConflict
  );
  const identityConflict = hasHardIdentityConflict
    ? [{
        id: `demo:identity-conflict:${input.matchId}`,
        code: 'EAN_CONFLICT',
        message: 'Trusted alert and catalogue GTIN facts conflict; product confirmation does not erase this fact.',
        critical: true,
        subjectRefs: [input.productId],
        evidenceRefs: identityEvidence
      }]
    : [];

  const catalogueBatch = normalizeBatch(input.catalogueBatch);
  const batchesMatch = trustedBatches.length === 1 && Boolean(
    catalogueBatch && normalizeBatch(trustedBatches[0].normalizedValue) === catalogueBatch
  );
  const batchConflict = trustedBatches.length > 1 || Boolean(
    trustedBatches.length === 1 &&
    catalogueBatch &&
    normalizeBatch(trustedBatches[0].normalizedValue) !== catalogueBatch
  );
  const scopeEvidence = batchesMatch
    ? canonicalRefs([...scopeAssertionRefs, input.provenanceRefs.catalogueProduct])
    : [];
  const scopeIssue = batchesMatch
    ? []
    : [{
        id: `demo:scope-gap:${input.matchId}`,
        code: batchConflict ? 'BATCH_CONFLICT' : 'BATCH_MISSING',
        message: batchConflict
          ? 'Trusted alert and catalogue lot facts conflict.'
          : 'A trusted lot boundary is unavailable; obtain batch evidence before calculating exposure.',
        critical: true,
        subjectRefs: [input.productId],
        evidenceRefs: batchConflict
          ? canonicalRefs([
              input.trustedAlertFacts.sourceObservationRef,
              ...scopeAssertionRefs,
              input.provenanceRefs.catalogueProduct
            ])
          : []
      }];
  const conflicts = [...identityConflict, ...(batchConflict ? scopeIssue : [])];
  const gaps = batchConflict ? [] : scopeIssue;
  const evidenceRefs = canonicalRefs([
    ...identityEvidence,
    ...scopeEvidence,
    ...scopeIssue.flatMap((issue) => issue.evidenceRefs)
  ]);

  return investigationOutcomeSchema.parse({
    schemaVersion: 1,
    caseId: input.caseId,
    productId: input.productId,
    materialRevision: input.materialRevision,
    updatedAt: input.updatedAt,
    knowledgeStatus: conflicts.length
      ? 'CONFLICTED'
      : !hasDeterministicIdentityMatch || gaps.length
        ? 'UNRESOLVED'
        : 'KNOWN',
    identity: hasHardIdentityConflict
      ? {
          knowledgeStatus: 'CONFLICTED',
          conclusion: 'UNRESOLVED',
          evidenceRefs: identityEvidence,
          decisionRefs: [input.decisionRefs.review]
        }
      : hasDeterministicIdentityMatch
        ? {
            knowledgeStatus: 'KNOWN',
            conclusion: 'MATCH',
            evidenceRefs: identityEvidence,
            decisionRefs: [input.decisionRefs.review]
          }
        : {
            knowledgeStatus: 'UNKNOWN',
            conclusion: 'UNRESOLVED',
            evidenceRefs: identityEvidence,
            decisionRefs: [input.decisionRefs.review]
          },
    scope: batchesMatch
      ? {
          kind: 'BATCH_LOT',
          knowledgeStatus: 'KNOWN',
          lots: [input.catalogueBatch!.trim()],
          evidenceRefs: scopeEvidence,
          decisionRefs: []
        }
      : {
          kind: 'UNRESOLVED',
          knowledgeStatus: batchConflict ? 'CONFLICTED' : 'UNKNOWN',
          reason: scopeIssue[0].message,
          evidenceRefs: batchConflict ? scopeIssue[0].evidenceRefs : [],
          decisionRefs: []
        },
    evidenceRefs,
    decisionRefs: [input.decisionRefs.review],
    gaps,
    conflicts,
    demo: input.demo
  });
}
