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
  it('produces a known identity with known batch scope', () => {
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

  it('preserves a hard identity conflict without erasing known scope', () => {
    const outcome = produce({ hasHardIdentityConflict: true });

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
