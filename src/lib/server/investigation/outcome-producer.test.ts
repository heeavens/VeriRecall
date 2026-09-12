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
  trustedAlertFacts: {
    sourceObservationRef: 'observation:1',
    eans: [{ normalizedValue: '4006381333931', assertionRefs: ['assertion:ean'] }],
    batches: [{ normalizedValue: 'mft24', assertionRefs: ['assertion:batch'] }]
  },
  catalogueEan: '4006381333931',
  catalogueBatch: 'MFT24',
  provenanceRefs: {
    catalogueProduct: '20000000-0000-4000-8000-000000000001',
    matchBasis: '30000000-0000-4000-8000-000000000001'
  },
  decisionRefs: { review: 'review-decision:1' },
  demo: true
} satisfies ProduceInvestigationOutcomeInput;

function produce(overrides: Partial<ProduceInvestigationOutcomeInput> = {}) {
  return produceInvestigationOutcome({ ...baseInput, ...overrides });
}

describe('InvestigationOutcome producer trusted-fact boundary', () => {
  it('uses an exact valid trusted GTIN and normalized batch as known evidence', () => {
    const outcome = produce();
    expect(outcome).toMatchObject({
      knowledgeStatus: 'KNOWN',
      identity: { knowledgeStatus: 'KNOWN', conclusion: 'MATCH' },
      scope: { kind: 'BATCH_LOT', knowledgeStatus: 'KNOWN', lots: ['MFT24'] },
      gaps: [],
      conflicts: []
    });
    expect(investigationOutcomeSchema.parse(outcome)).toEqual(outcome);
  });

  it('keeps identity unknown when the alert has no trusted GTIN', () => {
    const outcome = produce({
      trustedAlertFacts: { ...baseInput.trustedAlertFacts, eans: [] }
    });
    expect(outcome.identity).toMatchObject({ knowledgeStatus: 'UNKNOWN', conclusion: 'UNRESOLVED' });
  });

  it('does not accept an invalid catalogue GTIN as comparable identity', () => {
    const outcome = produce({ catalogueEan: '4006381333932' });
    expect(outcome.identity).toMatchObject({ knowledgeStatus: 'UNKNOWN', conclusion: 'UNRESOLVED' });
  });

  it('rejects an invalid value mislabeled as a trusted alert GTIN', () => {
    expect(() => produce({
      trustedAlertFacts: {
        ...baseInput.trustedAlertFacts,
        eans: [{ normalizedValue: '4006381333932', assertionRefs: ['assertion:invalid-ean'] }]
      }
    })).toThrow(/not valid attributed provenance/);
  });

  it('preserves trusted GTIN disagreement as a factual conflict', () => {
    const outcome = produce({ catalogueEan: '3073646035993' });
    expect(outcome.identity).toMatchObject({ knowledgeStatus: 'CONFLICTED', conclusion: 'UNRESOLVED' });
    expect(outcome.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'EAN_CONFLICT' })
    ]));
  });

  it('preserves conflicting trusted alert assertions', () => {
    const outcome = produce({
      trustedAlertFacts: {
        ...baseInput.trustedAlertFacts,
        eans: [
          ...baseInput.trustedAlertFacts.eans,
          { normalizedValue: '3073646035993', assertionRefs: ['assertion:ean:2'] }
        ]
      }
    });
    expect(outcome.identity.knowledgeStatus).toBe('CONFLICTED');
  });

  it('keeps an absent trusted batch unresolved and BATCH_MISSING reachable', () => {
    const outcome = produce({
      trustedAlertFacts: { ...baseInput.trustedAlertFacts, batches: [] }
    });
    expect(outcome.scope).toMatchObject({ kind: 'UNRESOLVED', knowledgeStatus: 'UNKNOWN' });
    expect(outcome.gaps).toEqual([expect.objectContaining({ code: 'BATCH_MISSING' })]);
  });

  it('preserves trusted batch disagreement as BATCH_CONFLICT', () => {
    const outcome = produce({ catalogueBatch: 'MFT25' });
    expect(outcome.scope).toMatchObject({ kind: 'UNRESOLVED', knowledgeStatus: 'CONFLICTED' });
    expect(outcome.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BATCH_CONFLICT' })
    ]));
  });

  it('carries immutable observation, assertion and match-basis refs', () => {
    const outcome = produce();
    expect(outcome.evidenceRefs).toEqual(expect.arrayContaining([
      'observation:1',
      'assertion:ean',
      'assertion:batch',
      baseInput.provenanceRefs.matchBasis,
      baseInput.provenanceRefs.catalogueProduct
    ]));
    expect(outcome.decisionRefs).toEqual([baseInput.decisionRefs.review]);
  });
});
