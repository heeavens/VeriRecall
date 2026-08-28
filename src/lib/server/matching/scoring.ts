import type { AlertStatus, FuzzyMatcher, NormalizedAlert, ScoreBreakdown } from '../../types/domain';
import type { Product } from '../db/schema';
import { normalizeBatch, normalizeEan, normalizeText } from '../alerts/normalization';

const EAN_WEIGHT = 45;
const NAME_WEIGHT = 25;
const BRAND_WEIGHT = 20;
const BATCH_WEIGHT = 10;
const STRONG_NAME_CONTRIBUTION = 18;
const STRONG_BRAND_CONTRIBUTION = 14;

export interface ScoredCandidate {
  product: Product;
  breakdown: ScoreBreakdown;
  explanation: string;
}

function weightedScore(ratio: number, weight: number): number {
  return Math.round((ratio / 100) * weight);
}

function addEvidence(target: string[], evidence: string): void {
  if (!target.includes(evidence)) target.push(evidence);
}

function scoreEan(
  alertValue: string | undefined,
  productValue: string | null,
  reasons: string[],
  evidence: string[]
): { ratio: number; hasHardConflict: boolean } {
  const alertEan = normalizeEan(alertValue);
  const productEan = normalizeEan(productValue);

  if (!alertEan && !productEan) {
    reasons.push('EAN is missing from both the alert and catalogue record.');
    addEvidence(evidence, 'barcode photo');
    return { ratio: 0, hasHardConflict: false };
  }
  if (!alertEan) {
    reasons.push('The official alert does not provide an EAN.');
    addEvidence(evidence, 'supplier invoice');
    return { ratio: 0, hasHardConflict: false };
  }
  if (!productEan) {
    reasons.push('The catalogue record does not provide an EAN.');
    addEvidence(evidence, 'barcode photo');
    return { ratio: 0, hasHardConflict: false };
  }
  if (alertEan === productEan) {
    reasons.push('EAN matches exactly.');
    return { ratio: 100, hasHardConflict: false };
  }

  reasons.push('EAN conflicts with the catalogue record.');
  addEvidence(evidence, 'barcode photo');
  addEvidence(evidence, 'supplier invoice');
  return { ratio: 0, hasHardConflict: true };
}

function scoreName(
  alertValue: string,
  productValue: string,
  matcher: FuzzyMatcher,
  reasons: string[]
): number {
  const ratio = matcher.tokenSetRatio(normalizeText(alertValue), normalizeText(productValue));
  if (ratio >= 90) reasons.push('Product name is a strong match.');
  else if (ratio >= 70) reasons.push('Product name is a possible match.');
  else reasons.push('Product name has low similarity.');
  return ratio;
}

function scoreBrand(
  alertValue: string | undefined,
  productValue: string,
  matcher: FuzzyMatcher,
  reasons: string[],
  evidence: string[]
): number {
  const alertBrand = normalizeText(alertValue);
  const productBrand = normalizeText(productValue);
  if (!alertBrand) {
    reasons.push('Brand is missing from the official alert.');
    addEvidence(evidence, 'supplier invoice');
    return 0;
  }

  const ratio = alertBrand === productBrand ? 100 : matcher.ratio(alertBrand, productBrand);
  if (ratio === 100) reasons.push('Brand matches exactly.');
  else if (ratio >= 75) reasons.push('Brand is a close fuzzy match.');
  else reasons.push('Brand does not match closely.');
  return ratio;
}

function scoreBatch(
  alertValue: string | undefined,
  productValue: string | null,
  matcher: FuzzyMatcher,
  reasons: string[],
  evidence: string[]
): number {
  const alertBatch = normalizeBatch(alertValue);
  const productBatch = normalizeBatch(productValue);

  if (!alertBatch || !productBatch) {
    reasons.push(
      !alertBatch && !productBatch
        ? 'Batch is missing from both records.'
        : !alertBatch
          ? 'Batch is missing from the official alert.'
          : 'Batch is missing from the catalogue record.'
    );
    addEvidence(evidence, 'batch label photo');
    return 0;
  }

  const ratio = alertBatch === productBatch ? 100 : matcher.ratio(alertBatch, productBatch);
  if (ratio === 100) reasons.push('Batch matches exactly.');
  else if (ratio >= 75) reasons.push('Batch is a close fuzzy match.');
  else reasons.push('Batch does not match closely.');
  return ratio;
}

export function scoreCandidate(
  alert: NormalizedAlert,
  product: Product,
  matcher: FuzzyMatcher
): ScoreBreakdown {
  const reasons: string[] = [];
  const requestedEvidence: string[] = [];
  const eanResult = scoreEan(alert.ean, product.ean, reasons, requestedEvidence);
  const nameRatio = scoreName(alert.productName, product.name, matcher, reasons);
  const brandRatio = scoreBrand(alert.brand, product.brand, matcher, reasons, requestedEvidence);
  const batchRatio = scoreBatch(alert.batch, product.batch, matcher, reasons, requestedEvidence);

  return {
    total: Math.round(
      (eanResult.ratio / 100) * EAN_WEIGHT +
        (nameRatio / 100) * NAME_WEIGHT +
        (brandRatio / 100) * BRAND_WEIGHT +
        (batchRatio / 100) * BATCH_WEIGHT
    ),
    ean: weightedScore(eanResult.ratio, EAN_WEIGHT),
    name: weightedScore(nameRatio, NAME_WEIGHT),
    brand: weightedScore(brandRatio, BRAND_WEIGHT),
    batch: weightedScore(batchRatio, BATCH_WEIGHT),
    hasHardConflict: eanResult.hasHardConflict,
    reasons,
    requestedEvidence
  };
}

function hasStrongDescriptiveMatch(score: ScoreBreakdown): boolean {
  return score.name >= STRONG_NAME_CONTRIBUTION && score.brand >= STRONG_BRAND_CONTRIBUTION;
}

export function classifyScore(
  score: ScoreBreakdown,
  confidenceThreshold: number,
  reviewFloor: number
): AlertStatus {
  if (score.total >= confidenceThreshold && !score.hasHardConflict) return 'matched';
  if (
    score.total >= reviewFloor ||
    score.ean === EAN_WEIGHT ||
    (score.hasHardConflict && hasStrongDescriptiveMatch(score))
  ) {
    return 'needs_review';
  }
  return 'not_relevant';
}

export function explainScore(score: ScoreBreakdown): string {
  const evidence = score.requestedEvidence.length
    ? `Requested evidence: ${score.requestedEvidence.join(', ')}.`
    : 'No additional matching evidence is required.';
  return `${score.reasons.join(' ')} ${evidence}`;
}

export function findTopCandidates(
  alert: NormalizedAlert,
  products: Product[],
  matcher: FuzzyMatcher,
  limit = 3
): ScoredCandidate[] {
  return products
    .map((product) => {
      const breakdown = scoreCandidate(alert, product, matcher);
      return { product, breakdown, explanation: explainScore(breakdown) };
    })
    .sort(
      (left, right) =>
        right.breakdown.total - left.breakdown.total ||
        right.breakdown.ean - left.breakdown.ean ||
        left.product.sku.localeCompare(right.product.sku)
    )
    .slice(0, Math.max(0, limit));
}
