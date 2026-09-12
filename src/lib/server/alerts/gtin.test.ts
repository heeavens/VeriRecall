import { describe, expect, it } from 'vitest';

import { loadDemoFixtures } from '../db/demo-fixtures';
import { normalizeGtin, validateGtin } from './gtin';

describe('GTIN validation', () => {
  it.each([
    ['96385074', 8],
    ['036000291452', 12],
    ['4006381333931', 13],
    ['10012345000017', 14]
  ])('accepts valid GTIN %s with length %i', (value) => {
    expect(validateGtin(value)).toEqual({ valid: true, normalized: value });
  });

  it('normalizes permitted whitespace without changing the raw source value', () => {
    expect(normalizeGtin(' 4006 3813 3393 1 ')).toBe('4006381333931');
    expect(validateGtin(' 4006 3813 3393 1 ').valid).toBe(true);
  });

  it.each([
    ['4006381333932', 'INVALID_CHECK_DIGIT'],
    ['123456789', 'UNSUPPORTED_LENGTH'],
    ['40063813X3931', 'NON_NUMERIC'],
    ['', 'EMPTY']
  ] as const)('rejects %s as %s', (value, reason) => {
    expect(validateGtin(value)).toMatchObject({ valid: false, reason });
  });

  it('keeps every authoritative synthetic demo GTIN check-digit valid', () => {
    const fixtures = loadDemoFixtures();
    const values = [
      ...fixtures.products.map((product) => product.ean),
      ...fixtures.alerts.map((alert) => alert.ean)
    ].filter((value): value is string => typeof value === 'string');

    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => validateGtin(value).valid)).toBe(true);
  });
});
