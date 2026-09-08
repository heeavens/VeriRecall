import { describe, expect, it } from 'vitest';

import { investigationOutcomeSchema } from '../../contracts/recall';
import {
  produceInvestigationOutcome,
  type ProduceInvestigationOutcomeInput
} from './outcome-producer';

const baseInput = {
  caseId: '10000000-0000-4000-8000-000000000001',
  productId: '20000000-0000-4000-8000-000000000001',
  matchId: '30000000-0000-4000-8000-000000000001',
  materialRevision: 1,
  updatedAt: '2026-09-08T12:00:00.000Z',
  alertEan: '3073646035990',
  catalogueEan: '3073646035990',
  alertBatch: 'MFT24',
  catalogueBatch: 'MFT24',
  hasHardIdentityConflict: false,
  evidenceRefs: {
    alert: 'demo:alert:1',
    catalogueProduct: 'demo:catalogue:1',
    match: 'demo:match:1',
    alertBatch: 'demo:alert-batch:1',
    catalogueBatch: 'demo:catalogue-batch:1'
  },
  decisionRefs: {
    review: 'demo:review-decision:1'
  },
  demo: true
} satisfies ProduceInvestigationOutcomeInput;

function produce(
  overrides: Partial<ProduceInvestigationOutcomeInput> = {}
) {
  return produceInvestigationOutcome({ ...baseInput, ...overrides });
}

describe('InvestigationOutcome producer', () => {
  it('uses an exact non-empty EAN match as deterministic known identity evidence', () => {
    const outcome = produce();

    expect(outcome).toMatchObject({
      knowledgeStatus: 'KNOWN',
      identity: {
        knowledgeStatus: 'KNOWN',
        conclusion: 'MATCH'
      },
      scope: {
        kind: 'BATCH_LOT',
        knowledgeStatus: 'KNOWN',
        lots: ['MFT24']
      },
      gaps: [],
      conflicts: []
    });
    expect(investigationOutcomeSchema.parse(outcome)).toEqual(outcome);
  });

  it('uses the existing EAN normalization for equivalent persisted values', () => {
    const outcome = produce({ alertEan: ' 3073 6460 3599 0 ' });

    expect(outcome.identity).toMatchObject({
      knowledgeStatus: 'KNOWN',
      conclusion: 'MATCH'
    });
  });

  it.each([
    ['alert EAN', { alertEan: null }],
    ['catalogue EAN', { catalogueEan: null }],
    ['both EANs', { alertEan: null, catalogueEan: null }]
  ] as const)('keeps identity unknown when %s is missing despite Review confirmation', (_label, eans) => {
    const outcome = produce(eans);

    expect(outcome).toMatchObject({
      knowledgeStatus: 'UNRESOLVED',
      identity: {
        knowledgeStatus: 'UNKNOWN',
        conclusion: 'UNRESOLVED',
        decisionRefs: [baseInput.decisionRefs.review]
      },
      scope: {
        kind: 'BATCH_LOT',
        knowledgeStatus: 'KNOWN',
        lots: ['MFT24']
      }
    });
  });

  it.each([
    { alertBatch: null, catalogueBatch: 'MFT24' },
    { alertBatch: 'MFT24', catalogueBatch: null },
    { alertBatch: null, catalogueBatch: null }
  ])('keeps missing batch data unresolved without inventing a lot', (batches) => {
    const outcome = produce(batches);

    expect(outcome).toMatchObject({
      knowledgeStatus: 'UNRESOLVED',
      identity: {
        knowledgeStatus: 'KNOWN',
        conclusion: 'MATCH'
      },
      scope: {
        kind: 'UNRESOLVED',
        knowledgeStatus: 'UNKNOWN'
      },
      gaps: [expect.objectContaining({ code: 'BATCH_MISSING' })],
      conflicts: []
    });
    expect('lots' in outcome.scope).toBe(false);
  });

  it('preserves a batch conflict as conflicted scope and outcome', () => {
    const outcome = produce({ catalogueBatch: 'MFT25' });

    expect(outcome).toMatchObject({
      knowledgeStatus: 'CONFLICTED',
      identity: {
        knowledgeStatus: 'KNOWN',
        conclusion: 'MATCH'
      },
      scope: {
        kind: 'UNRESOLVED',
        knowledgeStatus: 'CONFLICTED'
      },
      gaps: [],
      conflicts: [expect.objectContaining({ code: 'BATCH_CONFLICT' })]
    });
  });

  it.each([
    ['differing persisted EANs', { catalogueEan: '3073646035991' }],
    ['the persisted hard-conflict flag', { hasHardIdentityConflict: true }]
  ] as const)('preserves %s as a hard identity conflict without erasing known scope', (_label, conflict) => {
    const outcome = produce(conflict);

    expect(outcome).toMatchObject({
      knowledgeStatus: 'CONFLICTED',
      identity: {
        knowledgeStatus: 'CONFLICTED',
        conclusion: 'UNRESOLVED'
      },
      scope: {
        kind: 'BATCH_LOT',
        knowledgeStatus: 'KNOWN',
        lots: ['MFT24']
      },
      conflicts: [expect.objectContaining({ code: 'EAN_CONFLICT' })]
    });
  });

  it.each([
    ['known', {}],
    ['unknown', { alertEan: null }],
    ['conflicted', { catalogueEan: '3073646035991' }]
  ] as const)('keeps the Review decision reference attached to %s identity', (_label, identity) => {
    const outcome = produce(identity);

    expect(outcome.identity.decisionRefs).toEqual([baseInput.decisionRefs.review]);
    expect(outcome.decisionRefs).toContain(baseInput.decisionRefs.review);
  });

  it('keeps nested evidence and decision references in the outcome-level sets', () => {
    const outcome = produce();

    expect(outcome.identity.evidenceRefs.every((ref) => outcome.evidenceRefs.includes(ref))).toBe(true);
    expect(outcome.scope.evidenceRefs.every((ref) => outcome.evidenceRefs.includes(ref))).toBe(true);
    expect(outcome.identity.decisionRefs.every((ref) => outcome.decisionRefs.includes(ref))).toBe(true);
    expect(outcome.scope.decisionRefs.every((ref) => outcome.decisionRefs.includes(ref))).toBe(true);
    expect(outcome.evidenceRefs).toEqual([
      baseInput.evidenceRefs.alert,
      baseInput.evidenceRefs.catalogueProduct,
      baseInput.evidenceRefs.match,
      baseInput.evidenceRefs.alertBatch,
      baseInput.evidenceRefs.catalogueBatch
    ]);
    expect(outcome.decisionRefs).toEqual([baseInput.decisionRefs.review]);
  });
});
