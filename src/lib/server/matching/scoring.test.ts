import { describe, expect, it } from 'vitest';

import type { NormalizedAlert, ScoreBreakdown } from '../../types/domain';
import type { Product } from '../db/schema';
import { LocalFuzzyMatcher } from './fuzzy-matcher';
import { classifyScore, findTopCandidates, scoreCandidate } from './scoring';

const matcher = new LocalFuzzyMatcher();

const alert: NormalizedAlert = {
  source: 'safety_gate',
  sourceReference: 'TEST/001',
  sourceUrl: 'https://example.test/alert/1',
  title: 'Recall notice',
  description: 'Safety issue',
  risk: 'Injury',
  productName: 'Magnetic Construction Toy Set',
  brand: 'JC Toy',
  ean: '642 0650066050',
  batch: 'MFT-24',
  category: 'Toys',
  publishedAt: '2026-08-28T00:00:00.000Z'
};

const product: Product = {
  id: '10000000-0000-4000-8000-000000000001',
  sku: 'TOY-1042',
  name: 'Magnetic Construction Toy Set',
  normalizedName: 'magnetic construction toy set',
  brand: 'JC Toy',
  normalizedBrand: 'jc toy',
  ean: '6420650066050',
  batch: 'MFT 24',
  supplierName: 'Northstar Imports',
  supplierEmail: 'recalls@northstar.example.test',
  category: 'Toys',
  stockQuantity: 17,
  createdAt: '2026-08-28T00:00:00.000Z'
};

function boundaryScore(total: number): ScoreBreakdown {
  return {
    total,
    ean: 0,
    name: 25,
    brand: 20,
    batch: 10,
    hasHardConflict: false,
    reasons: [],
    requestedEvidence: []
  };
}

describe('Stage 3 matching score', () => {
  it('gives exact normalized identifiers a high-confidence score', () => {
    const score = scoreCandidate(alert, product, matcher);

    expect(score).toMatchObject({
      total: 100,
      ean: 45,
      name: 25,
      brand: 20,
      batch: 10,
      hasHardConflict: false
    });
    expect(classifyScore(score, 85, 55)).toBe('matched');
  });

  it('keeps a plain unattributed EAN disagreement discovery-only', () => {
    const score = scoreCandidate(
      { ...alert, batch: undefined },
      { ...product, ean: '3073646035993', batch: null },
      matcher
    );

    expect(score).toMatchObject({ total: 45, ean: 0, name: 25, brand: 20, batch: 0 });
    expect(score.hasHardConflict).toBe(false);
    expect(score.reasons).toContain(
      'Discovery-only EAN proposal differs from the catalogue record; no factual conflict is established.'
    );
    expect(score.requestedEvidence).toEqual(
      expect.arrayContaining(['barcode photo', 'supplier invoice', 'batch label photo'])
    );
    expect(classifyScore(score, 85, 55)).toBe('not_relevant');
  });

  it('does not renormalize weights when identifiers are missing', () => {
    const score = scoreCandidate(
      { ...alert, ean: undefined, batch: undefined },
      { ...product, ean: null, batch: null },
      matcher
    );

    expect(score.total).toBe(45);
    expect(score.ean).toBe(0);
    expect(score.batch).toBe(0);
    expect(score.total).not.toBe(100);
  });

  it.each([
    [54, 'not_relevant'],
    [55, 'needs_review'],
    [84, 'needs_review'],
    [85, 'matched']
  ] as const)('classifies the %i boundary as %s', (total, expected) => {
    expect(classifyScore(boundaryScore(total), 85, 55)).toBe(expected);
  });

  it('returns only the three highest-ranked catalogue candidates', () => {
    const candidates = findTopCandidates(
      alert,
      [
        { ...product, id: '4', sku: 'TOY-4', name: 'Wooden blocks', ean: '4' },
        { ...product, id: '3', sku: 'TOY-3', name: 'Magnetic Toy', ean: '3' },
        product,
        { ...product, id: '2', sku: 'TOY-2', name: 'Construction Toy Set', ean: '2' }
      ],
      matcher
    );

    expect(candidates).toHaveLength(3);
    expect(candidates[0].product.id).toBe(product.id);
    expect(candidates.map((candidate) => candidate.breakdown.total)).toEqual(
      [...candidates.map((candidate) => candidate.breakdown.total)].sort((a, b) => b - a)
    );
  });
});
