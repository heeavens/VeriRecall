export const supportedGtinLengths = [8, 12, 13, 14] as const;

export type GtinValidationResult =
  | { valid: true; normalized: string }
  | { valid: false; normalized: string; reason: 'EMPTY' | 'NON_NUMERIC' | 'UNSUPPORTED_LENGTH' | 'INVALID_CHECK_DIGIT' };

export function normalizeGtin(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, '').trim();
}

export function validateGtin(value: string | null | undefined): GtinValidationResult {
  const normalized = normalizeGtin(value);
  if (!normalized) return { valid: false, normalized, reason: 'EMPTY' };
  if (!/^\d+$/.test(normalized)) {
    return { valid: false, normalized, reason: 'NON_NUMERIC' };
  }
  if (!supportedGtinLengths.includes(normalized.length as (typeof supportedGtinLengths)[number])) {
    return { valid: false, normalized, reason: 'UNSUPPORTED_LENGTH' };
  }

  let sum = 0;
  for (let index = normalized.length - 2, position = 1; index >= 0; index -= 1, position += 1) {
    sum += Number(normalized[index]) * (position % 2 === 1 ? 3 : 1);
  }
  const expected = (10 - (sum % 10)) % 10;
  if (expected !== Number(normalized.at(-1))) {
    return { valid: false, normalized, reason: 'INVALID_CHECK_DIGIT' };
  }
  return { valid: true, normalized };
}

export function isValidGtin(value: string | null | undefined): boolean {
  return validateGtin(value).valid;
}
