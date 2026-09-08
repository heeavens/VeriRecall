import {
  investigationOutcomeSchema,
  type InvestigationOutcome
} from '../../contracts/recall';
import { normalizeEan } from '../alerts/normalization';

export interface ProduceInvestigationOutcomeInput {
  caseId: string;
  productId: string;
  matchId: string;
  materialRevision: number;
  updatedAt: string;
  alertEan: string | null;
  catalogueEan: string | null;
  alertBatch: string | null;
  catalogueBatch: string | null;
  hasHardIdentityConflict: boolean;
  evidenceRefs: {
    alert: string;
    catalogueProduct: string;
    match: string;
    alertBatch: string;
    catalogueBatch: string;
  };
  decisionRefs: {
    review: string;
  };
  demo: boolean;
}

export function produceInvestigationOutcome(
  input: ProduceInvestigationOutcomeInput
): InvestigationOutcome {
  const identityEvidence = [
    input.evidenceRefs.alert,
    input.evidenceRefs.catalogueProduct,
    input.evidenceRefs.match
  ];
  const alertEan = normalizeEan(input.alertEan);
  const catalogueEan = normalizeEan(input.catalogueEan);
  const hasComparableEans = Boolean(alertEan && catalogueEan);
  const hasHardIdentityConflict = input.hasHardIdentityConflict || Boolean(
    hasComparableEans && alertEan !== catalogueEan
  );
  const hasDeterministicIdentityMatch = Boolean(
    hasComparableEans && alertEan === catalogueEan && !hasHardIdentityConflict
  );
  const identityConflict = hasHardIdentityConflict
    ? [{
        id: `demo:identity-conflict:${input.matchId}`,
        code: 'EAN_CONFLICT',
        message: 'The official warning and catalogue EAN values conflict; confirmation does not erase this fact.',
        critical: true,
        subjectRefs: [input.productId],
        evidenceRefs: [input.evidenceRefs.alert, input.evidenceRefs.catalogueProduct]
      }]
    : [];
  const batchesMatch = Boolean(
    input.alertBatch &&
    input.catalogueBatch &&
    input.alertBatch === input.catalogueBatch
  );
  const batchConflict = Boolean(
    input.alertBatch &&
    input.catalogueBatch &&
    input.alertBatch !== input.catalogueBatch
  );
  const scopeEvidence = batchesMatch
    ? [input.evidenceRefs.alertBatch, input.evidenceRefs.catalogueBatch]
    : [];
  const scopeGap = batchesMatch
    ? []
    : [{
        id: `demo:scope-gap:${input.matchId}`,
        code: batchConflict ? 'BATCH_CONFLICT' : 'BATCH_MISSING',
        message: batchConflict
          ? 'The official warning and catalogue lot values conflict.'
          : 'A confirmed lot boundary is unavailable; obtain batch evidence before calculating exposure.',
        critical: true,
        subjectRefs: [input.productId],
        evidenceRefs: batchConflict
          ? [input.evidenceRefs.alert, input.evidenceRefs.catalogueProduct]
          : []
      }];
  const conflicts = [
    ...identityConflict,
    ...(batchConflict ? scopeGap : [])
  ];
  const gaps = batchConflict ? [] : scopeGap;
  const evidenceRefs = [...new Set([...identityEvidence, ...scopeEvidence])];

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
          lots: [input.catalogueBatch!],
          evidenceRefs: scopeEvidence,
          decisionRefs: []
        }
      : {
          kind: 'UNRESOLVED',
          knowledgeStatus: batchConflict ? 'CONFLICTED' : 'UNKNOWN',
          reason: scopeGap[0].message,
          evidenceRefs: [],
          decisionRefs: []
        },
    evidenceRefs,
    decisionRefs: [input.decisionRefs.review],
    gaps,
    conflicts,
    demo: input.demo
  });
}
