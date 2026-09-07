import type { CaseSnapshot, InvestigationOutcome, RecallCommand } from './recall';

// Synthetic contract examples; never import into the live workflow as fallback data.
export const demoCaseId = '10000000-0000-4000-8000-000000000017';
export const demoProductId = '20000000-0000-4000-8000-000000000017';
const updatedAt = '2026-09-07T12:00:00.000Z';
export const confirmedLotOutcome = {
  schemaVersion: 1,
  caseId: demoCaseId,
  productId: demoProductId,
  materialRevision: 1,
  updatedAt,
  knowledgeStatus: 'KNOWN',
  identity: { knowledgeStatus: 'KNOWN', conclusion: 'MATCH', evidenceRefs: ['demo:identity'], decisionRefs: ['demo:identity-decision'] },
  scope: { kind: 'BATCH_LOT', knowledgeStatus: 'KNOWN', lots: ['L-2403'], evidenceRefs: ['demo:scope'], decisionRefs: ['demo:scope-decision'] },
  evidenceRefs: ['demo:identity', 'demo:scope'],
  decisionRefs: ['demo:identity-decision', 'demo:scope-decision'],
  gaps: [],
  conflicts: [],
  demo: true
} satisfies InvestigationOutcome;
export const unresolvedScopeOutcome = {
  ...confirmedLotOutcome,
  knowledgeStatus: 'UNRESOLVED',
  scope: { kind: 'UNRESOLVED', knowledgeStatus: 'UNKNOWN', reason: 'The batch label is missing.', evidenceRefs: [], decisionRefs: [] },
  evidenceRefs: ['demo:identity'],
  decisionRefs: ['demo:identity-decision'],
  gaps: [{ id: 'demo:scope-gap', code: 'BATCH_MISSING', message: 'Obtain the batch label.', critical: true, subjectRefs: [demoProductId], evidenceRefs: [] }]
} satisfies InvestigationOutcome;
export const expandedLotOutcome = {
  ...confirmedLotOutcome,
  materialRevision: 2,
  updatedAt: '2026-09-07T13:00:00.000Z',
  scope: { ...confirmedLotOutcome.scope, lots: ['L-2403', 'L-2404'], evidenceRefs: ['demo:scope-expanded'], decisionRefs: ['demo:scope-expanded-decision'] },
  evidenceRefs: ['demo:identity', 'demo:scope-expanded'],
  decisionRefs: ['demo:identity-decision', 'demo:scope-expanded-decision']
} satisfies InvestigationOutcome;

export const unknownQuantity = { value: null, unit: 'ITEM', knowledgeStatus: 'UNKNOWN', sources: [], asOf: null } as const;
export function makeUncalculatedSnapshot(outcome: InvestigationOutcome, caseVersion = 1): CaseSnapshot {
  const unknown = () => ({ ...unknownQuantity, sources: [] });
  const blocker = { id: 'demo:exposure-missing', code: 'EXPOSURE_NOT_CALCULATED' as const, message: 'Exposure has not been calculated.', critical: true, subjectRefs: [outcome.caseId], evidenceRefs: [] };
  return {
    schemaVersion: 1, caseId: outcome.caseId, productId: outcome.productId,
    caseVersion, materialRevision: outcome.materialRevision, stage: 'INVESTIGATING',
    updatedAt: outcome.updatedAt, investigation: structuredClone(outcome),
    exposure: {
      status: 'NOT_CALCULATED', basisMaterialRevision: null, calculatedAt: null,
      received: unknown(), warehouse: unknown(), inTransit: unknown(), retailer: unknown(),
      sold: unknown(), unaccounted: unknown(), contained: unknown(), gaps: [], conflicts: []
    },
    tasks: [], uncertainties: structuredClone(outcome.gaps), conflicts: structuredClone(outcome.conflicts),
    attentionItems: [blocker], pendingDecisions: [],
    closure: { status: 'NOT_READY', blockers: [blocker], decisionRef: null }, demo: true
  };
}
export const contractFixtures = [
  { name: 'confirmed L-2403', outcome: confirmedLotOutcome, snapshot: makeUncalculatedSnapshot(confirmedLotOutcome) },
  { name: 'unknown scope (alternative initial case)', outcome: unresolvedScopeOutcome, snapshot: makeUncalculatedSnapshot(unresolvedScopeOutcome) },
  { name: 'expanded L-2403 + L-2404', outcome: expandedLotOutcome, snapshot: makeUncalculatedSnapshot(expandedLotOutcome, 2) }
];
export const acceptInvestigationExample = {
  type: 'ACCEPT_INVESTIGATION', schemaVersion: 1,
  caseId: demoCaseId, commandId: '30000000-0000-4000-8000-000000000001',
  expectedCaseVersion: 0, outcome: confirmedLotOutcome
} satisfies RecallCommand;
