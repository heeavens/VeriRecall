import { eq } from 'drizzle-orm';

import type { MatchExplanation } from '../../types/domain';
import {
  AlertProvenanceError,
  alertSemanticDigest,
  canonicalAlertRefs,
  resolveAlertFactsInTransaction,
  type ResolvedAlertFacts
} from '../alerts/alert-provenance';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';

export const ALERT_MATCHING_POLICY_IDENTIFIER = 'verirecall-alert-candidate-matching';
export const ALERT_MATCHING_POLICY_VERSION = 'v1';

export type AlertMatchBasis = typeof schema.alertMatchBases.$inferSelect;

export interface HydratedAlertMatchBasis {
  basis: AlertMatchBasis;
  match: typeof schema.matches.$inferSelect;
  facts: ResolvedAlertFacts;
  discoveryAssertionRefs: string[];
  authoritativeIdentityAssertionRefs: string[];
  authoritativeScopeAssertionRefs: string[];
}

interface CatalogueProductSnapshot {
  productId: string;
  sku: string;
  name: string;
  brand: string;
  ean: string | null;
  batch: string | null;
}

export class AlertMatchBasisError extends Error {
  constructor(
    public readonly code: 'MATCH_BASIS_MISSING' | 'MATCH_BASIS_INVALID' | 'MATCH_BASIS_STALE',
    message: string
  ) {
    super(message);
    this.name = 'AlertMatchBasisError';
  }
}

function parseCanonicalRefs(value: string, field: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error('invalid');
    }
    const refs = parsed as string[];
    if (JSON.stringify(refs) !== JSON.stringify(canonicalAlertRefs(refs))) throw new Error('invalid');
    return refs;
  } catch {
    throw new AlertMatchBasisError('MATCH_BASIS_INVALID', `${field} is not a canonical reference array.`);
  }
}

function digestPayload(
  match: typeof schema.matches.$inferSelect,
  basis: Omit<AlertMatchBasis, 'basisDigest' | 'createdAt'>
) {
  return {
    match: {
      id: match.id,
      alertId: match.alertId,
      productId: match.productId,
      totalScore: match.totalScore,
      nameScore: match.nameScore,
      brandScore: match.brandScore,
      eanScore: match.eanScore,
      batchScore: match.batchScore,
      hasHardConflict: match.hasHardConflict,
      explanation: match.explanation
    },
    basis: {
      matchId: basis.matchId,
      alertId: basis.alertId,
      sourceObservationRef: basis.sourceObservationRef,
      catalogueProductSnapshot: parseCatalogueProductSnapshot(basis.catalogueProductSnapshotJson),
      matchingPolicyIdentifier: basis.matchingPolicyIdentifier,
      matchingPolicyVersion: basis.matchingPolicyVersion,
      discoveryAssertionRefs: parseCanonicalRefs(
        basis.discoveryAssertionRefsJson,
        'discoveryAssertionRefs'
      ),
      authoritativeIdentityAssertionRefs: parseCanonicalRefs(
        basis.authoritativeIdentityAssertionRefsJson,
        'authoritativeIdentityAssertionRefs'
      ),
      authoritativeScopeAssertionRefs: parseCanonicalRefs(
        basis.authoritativeScopeAssertionRefsJson,
        'authoritativeScopeAssertionRefs'
      ),
      explanationOrigin: basis.explanationOrigin,
      explanationGeneratorIdentifier: basis.explanationGeneratorIdentifier,
      explanationGeneratorVersion: basis.explanationGeneratorVersion,
      explanationModelIdentifier: basis.explanationModelIdentifier,
      demo: basis.demo
    }
  };
}

function catalogueProductSnapshot(
  product: typeof schema.products.$inferSelect
): CatalogueProductSnapshot {
  return {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    ean: product.ean,
    batch: product.batch
  };
}

function parseCatalogueProductSnapshot(value: string): CatalogueProductSnapshot {
  try {
    const parsed = JSON.parse(value) as Partial<CatalogueProductSnapshot>;
    const keys = Object.keys(parsed).sort();
    if (
      JSON.stringify(keys) !== JSON.stringify(['batch', 'brand', 'ean', 'name', 'productId', 'sku']) ||
      typeof parsed.productId !== 'string' ||
      typeof parsed.sku !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.brand !== 'string' ||
      (parsed.ean !== null && typeof parsed.ean !== 'string') ||
      (parsed.batch !== null && typeof parsed.batch !== 'string')
    ) {
      throw new Error('invalid');
    }
    return parsed as CatalogueProductSnapshot;
  } catch {
    throw new AlertMatchBasisError(
      'MATCH_BASIS_INVALID',
      'Match basis catalogue product snapshot is malformed.'
    );
  }
}

export function recordAlertMatchBasisInTransaction(
  database: RecallDatabase,
  input: {
    matchId: string;
    alertId: string;
    sourceObservationRef: string;
    catalogueProduct: typeof schema.products.$inferSelect;
    discoveryAssertionRefs: string[];
    authoritativeIdentityAssertionRefs: string[];
    authoritativeScopeAssertionRefs: string[];
    explanation: MatchExplanation;
    createdAt: string;
    demo: boolean;
  }
): AlertMatchBasis {
  const match = database.select().from(schema.matches).where(eq(schema.matches.id, input.matchId)).get();
  const currentProduct = match
    ? database.select().from(schema.products).where(eq(schema.products.id, match.productId)).get()
    : undefined;
  if (
    !match ||
    match.alertId !== input.alertId ||
    !currentProduct ||
    currentProduct.id !== input.catalogueProduct.id ||
    JSON.stringify(catalogueProductSnapshot(currentProduct)) !==
      JSON.stringify(catalogueProductSnapshot(input.catalogueProduct))
  ) {
    throw new AlertMatchBasisError('MATCH_BASIS_INVALID', 'Match is missing or belongs to another alert.');
  }
  const refs = {
    discoveryAssertionRefsJson: JSON.stringify(canonicalAlertRefs(input.discoveryAssertionRefs)),
    authoritativeIdentityAssertionRefsJson: JSON.stringify(
      canonicalAlertRefs(input.authoritativeIdentityAssertionRefs)
    ),
    authoritativeScopeAssertionRefsJson: JSON.stringify(
      canonicalAlertRefs(input.authoritativeScopeAssertionRefs)
    )
  };
  const semantic: Omit<AlertMatchBasis, 'basisDigest' | 'createdAt'> = {
    matchId: input.matchId,
    alertId: input.alertId,
    sourceObservationRef: input.sourceObservationRef,
    catalogueProductSnapshotJson: JSON.stringify(catalogueProductSnapshot(input.catalogueProduct)),
    matchingPolicyIdentifier: ALERT_MATCHING_POLICY_IDENTIFIER,
    matchingPolicyVersion: ALERT_MATCHING_POLICY_VERSION,
    ...refs,
    explanationOrigin: input.explanation.origin,
    explanationGeneratorIdentifier: input.explanation.generatorIdentifier,
    explanationGeneratorVersion: input.explanation.generatorVersion,
    explanationModelIdentifier: input.explanation.modelIdentifier,
    demo: input.demo
  };
  const basis: AlertMatchBasis = {
    ...semantic,
    basisDigest: alertSemanticDigest(digestPayload(match, semantic)),
    createdAt: input.createdAt
  };
  const existingBasis = database
    .select()
    .from(schema.alertMatchBases)
    .where(eq(schema.alertMatchBases.matchId, input.matchId))
    .get();
  if (existingBasis) {
    const hydrated = readAlertMatchBasisInTransaction(database, input.matchId);
    if (hydrated.basis.basisDigest !== basis.basisDigest) {
      throw new AlertMatchBasisError(
        'MATCH_BASIS_INVALID',
        'An immutable Match Basis already exists with different semantics.'
      );
    }
    return hydrated.basis;
  }
  database.insert(schema.alertMatchBases).values(basis).run();
  return basis;
}

export function readAlertMatchBasisInTransaction(
  database: RecallDatabase,
  matchId: string
): HydratedAlertMatchBasis {
  const match = database.select().from(schema.matches).where(eq(schema.matches.id, matchId)).get();
  const basis = database
    .select()
    .from(schema.alertMatchBases)
    .where(eq(schema.alertMatchBases.matchId, matchId))
    .get();
  if (!match || !basis) {
    throw new AlertMatchBasisError('MATCH_BASIS_MISSING', 'This match has no immutable provenance basis.');
  }
  if (
    basis.alertId !== match.alertId ||
    basis.matchingPolicyIdentifier !== ALERT_MATCHING_POLICY_IDENTIFIER ||
    basis.matchingPolicyVersion !== ALERT_MATCHING_POLICY_VERSION
  ) {
    throw new AlertMatchBasisError('MATCH_BASIS_INVALID', 'Match basis ownership or policy is invalid.');
  }
  const product = database
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, match.productId))
    .get();
  const persistedProductSnapshot = parseCatalogueProductSnapshot(
    basis.catalogueProductSnapshotJson
  );
  if (
    !product ||
    JSON.stringify(persistedProductSnapshot) !== JSON.stringify(catalogueProductSnapshot(product))
  ) {
    throw new AlertMatchBasisError(
      'MATCH_BASIS_STALE',
      'The catalogue product facts differ from the immutable Match Basis.'
    );
  }
  if (
    (basis.explanationOrigin === 'DETERMINISTIC' && basis.explanationModelIdentifier !== null) ||
    (basis.explanationOrigin === 'AI_GENERATED' && !basis.explanationModelIdentifier?.trim())
  ) {
    throw new AlertMatchBasisError('MATCH_BASIS_INVALID', 'Match explanation provenance is invalid.');
  }
  const basisForDigest: Omit<AlertMatchBasis, 'basisDigest' | 'createdAt'> = {
    matchId: basis.matchId,
    alertId: basis.alertId,
    sourceObservationRef: basis.sourceObservationRef,
    catalogueProductSnapshotJson: basis.catalogueProductSnapshotJson,
    matchingPolicyIdentifier: basis.matchingPolicyIdentifier,
    matchingPolicyVersion: basis.matchingPolicyVersion,
    discoveryAssertionRefsJson: basis.discoveryAssertionRefsJson,
    authoritativeIdentityAssertionRefsJson: basis.authoritativeIdentityAssertionRefsJson,
    authoritativeScopeAssertionRefsJson: basis.authoritativeScopeAssertionRefsJson,
    explanationOrigin: basis.explanationOrigin,
    explanationGeneratorIdentifier: basis.explanationGeneratorIdentifier,
    explanationGeneratorVersion: basis.explanationGeneratorVersion,
    explanationModelIdentifier: basis.explanationModelIdentifier,
    demo: basis.demo
  };
  const expectedDigest = alertSemanticDigest(digestPayload(match, basisForDigest));
  if (basis.basisDigest !== expectedDigest) {
    throw new AlertMatchBasisError('MATCH_BASIS_INVALID', 'Match basis digest does not match persisted semantics.');
  }
  let facts: ResolvedAlertFacts;
  try {
    facts = resolveAlertFactsInTransaction(database, {
      alertId: basis.alertId,
      sourceObservationRef: basis.sourceObservationRef,
      purpose: 'DISCOVERY'
    });
  } catch (error) {
    if (error instanceof AlertProvenanceError) {
      throw new AlertMatchBasisError('MATCH_BASIS_INVALID', error.message);
    }
    throw error;
  }
  const discoveryAssertionRefs = parseCanonicalRefs(
    basis.discoveryAssertionRefsJson,
    'discoveryAssertionRefs'
  );
  const authoritativeIdentityAssertionRefs = parseCanonicalRefs(
    basis.authoritativeIdentityAssertionRefsJson,
    'authoritativeIdentityAssertionRefs'
  );
  const authoritativeScopeAssertionRefs = parseCanonicalRefs(
    basis.authoritativeScopeAssertionRefsJson,
    'authoritativeScopeAssertionRefs'
  );
  const assertionByRef = new Map(facts.assertions.map((item) => [item.assertionRef, item]));
  for (const ref of canonicalAlertRefs([
    ...discoveryAssertionRefs,
    ...authoritativeIdentityAssertionRefs,
    ...authoritativeScopeAssertionRefs
  ])) {
    if (!assertionByRef.has(ref)) {
      throw new AlertMatchBasisError('MATCH_BASIS_INVALID', 'Match basis references a missing or foreign assertion.');
    }
  }
  if (basis.demo !== facts.sourceObservation.demo) {
    throw new AlertMatchBasisError('MATCH_BASIS_INVALID', 'Match basis demo provenance is invalid.');
  }
  if (JSON.stringify(discoveryAssertionRefs) !== JSON.stringify(facts.discovery.assertionRefs)) {
    throw new AlertMatchBasisError('MATCH_BASIS_INVALID', 'Match basis discovery facts are not exact.');
  }
  if (
    JSON.stringify(authoritativeIdentityAssertionRefs) !==
      JSON.stringify(facts.authoritative.identityAssertionRefs) ||
    JSON.stringify(authoritativeScopeAssertionRefs) !==
      JSON.stringify(facts.authoritative.scopeAssertionRefs)
  ) {
    throw new AlertMatchBasisError('MATCH_BASIS_INVALID', 'Match basis authoritative facts are not exact.');
  }
  return {
    basis,
    match,
    facts,
    discoveryAssertionRefs,
    authoritativeIdentityAssertionRefs,
    authoritativeScopeAssertionRefs
  };
}

export function assertAlertMatchBasisCurrentInTransaction(
  database: RecallDatabase,
  hydrated: HydratedAlertMatchBasis
): ResolvedAlertFacts {
  try {
    const current = resolveAlertFactsInTransaction(database, {
      alertId: hydrated.basis.alertId,
      sourceObservationRef: hydrated.basis.sourceObservationRef,
      purpose: 'AUTHORITATIVE'
    });
    if (
      JSON.stringify(current.authoritative.identityAssertionRefs) !==
        JSON.stringify(hydrated.authoritativeIdentityAssertionRefs) ||
      JSON.stringify(current.authoritative.scopeAssertionRefs) !==
        JSON.stringify(hydrated.authoritativeScopeAssertionRefs)
    ) {
      throw new AlertMatchBasisError('MATCH_BASIS_INVALID', 'Trusted facts changed after this match was scored.');
    }
    return current;
  } catch (error) {
    if (error instanceof AlertProvenanceError && error.code === 'STALE_SOURCE_OBSERVATION') {
      throw new AlertMatchBasisError('MATCH_BASIS_STALE', error.message);
    }
    throw error;
  }
}
