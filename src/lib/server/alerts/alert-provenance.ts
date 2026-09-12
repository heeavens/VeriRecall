import { createHash, randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';

import type { AlertProposalExtraction, AlertSourceRecord } from '../../types/domain';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { normalizeAlert, normalizeBatch, normalizeText } from './normalization';
import { normalizeGtin, validateGtin } from './gtin';

export const ALERT_RAW_PAYLOAD_MAX_BYTES = 262_144;
export const ALERT_SOURCE_PARSER_IDENTIFIER = 'verirecall-structured-alert-parser';
export const ALERT_SOURCE_PARSER_VERSION = 'v1';
export const ALERT_LABELLED_GTIN_PARSER_IDENTIFIER = 'verirecall-labelled-gtin-parser';
export const ALERT_LABELLED_GTIN_PARSER_VERSION = 'v1';

export type AlertFieldKind = (typeof schema.alertFieldKinds)[number];
export type AlertAssertionOriginKind = (typeof schema.alertFieldAssertionOriginKinds)[number];
export type AlertFactPurpose = 'DISCOVERY' | 'AUTHORITATIVE';
export type AlertProvenanceBlocker =
  | 'AI_ONLY'
  | 'LEGACY_UNVERIFIED'
  | 'TRUSTED_CONFLICT'
  | 'INVALID_GTIN'
  | 'SOURCE_PROVENANCE_INVALID'
  | 'AMBIGUOUS_SOURCE_HEAD'
  | 'STALE_SOURCE_OBSERVATION';

export type AlertSourceObservation = typeof schema.alertSourceObservations.$inferSelect;
export type AlertFieldAssertion = typeof schema.alertFieldAssertions.$inferSelect;

const proposalFieldLimits = {
  productName: 500,
  brand: 300,
  ean: 64,
  batch: 200,
  category: 300
} as const;

export function validateAlertProposalExtraction(input: unknown): AlertProposalExtraction {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'AI proposal envelope is invalid.');
  }
  const envelope = input as Record<string, unknown>;
  const envelopeKeys = Object.keys(envelope).sort();
  if (JSON.stringify(envelopeKeys) !== JSON.stringify([
    'extractorIdentifier',
    'extractorVersion',
    'modelIdentifier',
    'origin',
    'proposals'
  ])) {
    throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'AI proposal envelope has unknown fields.');
  }
  if (
    !envelope.proposals ||
    typeof envelope.proposals !== 'object' ||
    Array.isArray(envelope.proposals) ||
    typeof envelope.extractorIdentifier !== 'string' ||
    !envelope.extractorIdentifier.trim() ||
    typeof envelope.extractorVersion !== 'string' ||
    !envelope.extractorVersion.trim()
  ) {
    throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'AI proposal metadata is invalid.');
  }
  const proposals = envelope.proposals as Record<string, unknown>;
  const allowedKeys = Object.keys(proposalFieldLimits);
  if (Object.keys(proposals).some((key) => !allowedKeys.includes(key))) {
    throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'AI proposal contains a forbidden field.');
  }
  const validatedProposals: AlertProposalExtraction['proposals'] = {};
  for (const key of allowedKeys as Array<keyof typeof proposalFieldLimits>) {
    const value = proposals[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > proposalFieldLimits[key]) {
      throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', `AI proposal ${key} is invalid.`);
    }
    validatedProposals[key] = value.trim();
  }
  if (envelope.origin === 'NONE') {
    if (Object.keys(validatedProposals).length !== 0 || envelope.modelIdentifier !== null) {
      throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'No-AI extraction cannot contain proposals.');
    }
  } else if (
    envelope.origin !== 'AI_GENERATED' ||
    typeof envelope.modelIdentifier !== 'string' ||
    !envelope.modelIdentifier.trim()
  ) {
    throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'AI proposal model provenance is invalid.');
  }
  return {
    proposals: validatedProposals,
    origin: envelope.origin,
    extractorIdentifier: envelope.extractorIdentifier.trim(),
    extractorVersion: envelope.extractorVersion.trim(),
    modelIdentifier: envelope.modelIdentifier === null ? null : envelope.modelIdentifier.trim()
  };
}

export interface ResolvedAlertValue {
  normalizedValue: string;
  rawValues: string[];
  assertionRefs: string[];
  originKinds: AlertAssertionOriginKind[];
}

export interface ResolvedAlertFacts {
  alertId: string;
  purpose: AlertFactPurpose;
  sourceObservation: AlertSourceObservation;
  sourceAlert: ReturnType<typeof normalizeAlert>;
  assertions: AlertFieldAssertion[];
  assertionsByField: Record<AlertFieldKind, AlertFieldAssertion[]>;
  discovery: {
    productName: ResolvedAlertValue | null;
    brand: ResolvedAlertValue | null;
    ean: ResolvedAlertValue | null;
    batch: ResolvedAlertValue | null;
    category: ResolvedAlertValue | null;
    assertionRefs: string[];
  };
  authoritative: {
    ean: ResolvedAlertValue | null;
    batch: ResolvedAlertValue | null;
    eanValues: ResolvedAlertValue[];
    batchValues: ResolvedAlertValue[];
    identityAssertionRefs: string[];
    scopeAssertionRefs: string[];
  };
  discoveryOnlyProposalRefs: string[];
  blockers: AlertProvenanceBlocker[];
}

export class AlertProvenanceError extends Error {
  constructor(
    public readonly code:
      | 'SOURCE_PROVENANCE_INVALID'
      | 'AMBIGUOUS_SOURCE_HEAD'
      | 'STALE_SOURCE_OBSERVATION'
      | 'ASSERTION_PROVENANCE_INVALID',
    message: string
  ) {
    super(message);
    this.name = 'AlertProvenanceError';
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalAlertRefs(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function alertSemanticDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

export function alertContentSha256(rawPayload: string): string {
  return createHash('sha256').update(rawPayload, 'utf8').digest('hex');
}

function normalizeFieldValue(fieldKind: AlertFieldKind, value: string): string {
  if (fieldKind === 'EAN_GTIN') return normalizeGtin(value);
  if (fieldKind === 'BATCH_LOT') return normalizeBatch(value);
  return normalizeText(value);
}

function parseCanonicalRefs(value: string, field: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', `${field} is not valid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', `${field} is not a reference array.`);
  }
  const refs = parsed as string[];
  const canonicalRefs = canonicalAlertRefs(refs);
  if (JSON.stringify(refs) !== JSON.stringify(canonicalRefs)) {
    throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', `${field} is not canonical.`);
  }
  return refs;
}

function assertionDigestPayload(assertion: AlertFieldAssertion) {
  return {
    alertId: assertion.alertId,
    sourceObservationRef: assertion.sourceObservationRef,
    fieldKind: assertion.fieldKind,
    rawValue: assertion.rawValue,
    normalizedValue: assertion.normalizedValue,
    originKind: assertion.originKind,
    sourceLocator: assertion.sourceLocator,
    producerIdentifier: assertion.producerIdentifier,
    producerVersion: assertion.producerVersion,
    modelIdentifier: assertion.modelIdentifier,
    basisAssertionRefs: parseCanonicalRefs(assertion.basisAssertionRefsJson, 'basisAssertionRefs'),
    supportingEvidenceRefs: parseCanonicalRefs(
      assertion.supportingEvidenceRefsJson,
      'supportingEvidenceRefs'
    ),
    humanActorIdentifier: assertion.humanActorIdentifier,
    rationale: assertion.rationale,
    demo: assertion.demo
  };
}

function validateAssertionMetadata(assertion: AlertFieldAssertion): void {
  if (
    !assertion.rawValue.trim() ||
    !assertion.normalizedValue.trim() ||
    !assertion.producerIdentifier.trim() ||
    !assertion.producerVersion.trim()
  ) {
    throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Assertion values must be nonblank.');
  }
  if (normalizeFieldValue(assertion.fieldKind, assertion.rawValue) !== assertion.normalizedValue) {
    throw new AlertProvenanceError(
      'ASSERTION_PROVENANCE_INVALID',
      `Assertion ${assertion.assertionRef} has a noncanonical normalized value.`
    );
  }
  const basisRefs = parseCanonicalRefs(assertion.basisAssertionRefsJson, 'basisAssertionRefs');
  const supportRefs = parseCanonicalRefs(
    assertion.supportingEvidenceRefsJson,
    'supportingEvidenceRefs'
  );
  if (assertion.originKind === 'SOURCE_ASSERTED') {
    if (
      !assertion.sourceLocator?.trim() ||
      assertion.modelIdentifier ||
      assertion.humanActorIdentifier ||
      basisRefs.length !== 0 ||
      supportRefs.length !== 0
    ) {
      throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Source assertion metadata is invalid.');
    }
  } else if (assertion.originKind === 'DETERMINISTIC_DERIVED') {
    if (
      (!assertion.sourceLocator?.trim() && basisRefs.length === 0) ||
      assertion.modelIdentifier ||
      assertion.humanActorIdentifier ||
      supportRefs.length !== 0
    ) {
      throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Deterministic assertion metadata is invalid.');
    }
  } else if (assertion.originKind === 'AI_PROPOSAL') {
    if (
      !assertion.modelIdentifier?.trim() ||
      assertion.humanActorIdentifier ||
      assertion.sourceLocator !== null ||
      supportRefs.length !== 0
    ) {
      throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'AI proposal metadata is invalid.');
    }
  } else if (assertion.originKind === 'HUMAN_CONFIRMED') {
    if (
      assertion.modelIdentifier ||
      !assertion.humanActorIdentifier?.trim() ||
      !assertion.rationale?.trim() ||
      supportRefs.length === 0
    ) {
      throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Human confirmation metadata is invalid.');
    }
  } else if (
    assertion.modelIdentifier ||
    assertion.humanActorIdentifier ||
    basisRefs.length !== 0 ||
    supportRefs.length !== 0
  ) {
    throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Legacy assertion metadata is invalid.');
  }

  const expectedDigest = alertSemanticDigest(assertionDigestPayload(assertion));
  if (assertion.semanticDigest !== expectedDigest) {
    throw new AlertProvenanceError(
      'ASSERTION_PROVENANCE_INVALID',
      `Assertion ${assertion.assertionRef} digest does not match its semantics.`
    );
  }
}

function validateAssertionSourceBinding(
  assertion: AlertFieldAssertion,
  observation: AlertSourceObservation
): void {
  if (assertion.originKind === 'SOURCE_ASSERTED') {
    if (
      assertion.producerIdentifier !== ALERT_SOURCE_PARSER_IDENTIFIER ||
      assertion.producerVersion !== ALERT_SOURCE_PARSER_VERSION
    ) {
      throw new AlertProvenanceError(
        'ASSERTION_PROVENANCE_INVALID',
        'Structured source provenance uses an unsupported parser policy.'
      );
    }
    const expectedSourceField: Record<AlertFieldKind, string> = {
      PRODUCT_NAME: 'productName',
      BRAND: 'brand',
      EAN_GTIN: 'ean',
      BATCH_LOT: 'batch',
      CATEGORY: 'category'
    };
    const pointer = `/${expectedSourceField[assertion.fieldKind]}`;
    if (assertion.sourceLocator !== pointer) {
      throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Structured source locator is not exact.');
    }
    const payload = JSON.parse(observation.rawPayload) as Record<string, unknown>;
    if (payload[expectedSourceField[assertion.fieldKind]] !== assertion.rawValue) {
      throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Source assertion does not match raw payload.');
    }
  }
  if (assertion.originKind === 'DETERMINISTIC_DERIVED' && assertion.sourceLocator) {
    const match = /^json-span:\/(title|description):(\d+):(\d+)$/.exec(assertion.sourceLocator ?? '');
    if (!match) {
      throw new AlertProvenanceError(
        'ASSERTION_PROVENANCE_INVALID',
        'Deterministic derivation requires an exact source span.'
      );
    }
    const payload = JSON.parse(observation.rawPayload) as Record<string, unknown>;
    const text = payload[match[1]];
    const start = Number(match[2]);
    const end = Number(match[3]);
    if (typeof text !== 'string' || text.slice(start, end) !== assertion.rawValue) {
      throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Deterministic source span is invalid.');
    }
    if (assertion.fieldKind !== 'EAN_GTIN') return;
    if (
      assertion.producerIdentifier !== ALERT_LABELLED_GTIN_PARSER_IDENTIFIER ||
      assertion.producerVersion !== ALERT_LABELLED_GTIN_PARSER_VERSION
    ) {
      throw new AlertProvenanceError(
        'ASSERTION_PROVENANCE_INVALID',
        'Deterministic GTIN provenance uses an unsupported parser policy.'
      );
    }
    const labelContext = text.slice(Math.max(0, start - 24), start).toLowerCase();
    if (!/(ean|gtin|barcode)\s*[:#-]?\s*$/.test(labelContext)) {
      throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Deterministic GTIN span is not explicitly labelled.');
    }
  }
}

function validateObservation(
  alert: typeof schema.alerts.$inferSelect,
  observation: AlertSourceObservation
): ReturnType<typeof normalizeAlert> {
  if (
    observation.alertId !== alert.id ||
    observation.source !== alert.source ||
    observation.sourceReference !== alert.sourceReference ||
    !observation.provider.trim() ||
    !observation.sourceUrl.trim() ||
    !observation.sourceVersionIdentifier.trim() ||
    !observation.payloadFormat.trim()
  ) {
    throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Source observation ownership is invalid.');
  }
  if (observation.provider === 'demo_archive' && !observation.demo) {
    throw new AlertProvenanceError(
      'SOURCE_PROVENANCE_INVALID',
      'Synthetic archive observations must remain explicitly demo provenance.'
    );
  }
  if (Buffer.byteLength(observation.rawPayload, 'utf8') > ALERT_RAW_PAYLOAD_MAX_BYTES) {
    throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Source payload exceeds the maximum size.');
  }
  const contentSha256 = alertContentSha256(observation.rawPayload);
  if (contentSha256 !== observation.contentSha256) {
    throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Source observation content hash is invalid.');
  }
  if (
    observation.sourceVersionIdentifier.startsWith('sha256:') &&
    observation.sourceVersionIdentifier !== `sha256:${contentSha256}`
  ) {
    throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Derived source version does not match content.');
  }
  if (observation.recordKind !== 'RAW_SOURCE' || observation.payloadFormat !== 'application/json') {
    throw new AlertProvenanceError(
      'SOURCE_PROVENANCE_INVALID',
      'Only raw JSON source observations can authorize a new decision.'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(observation.rawPayload);
  } catch {
    throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Source observation payload is invalid JSON.');
  }
  const sourceAlert = normalizeAlert(parsed);
  if (
    sourceAlert.source !== observation.source ||
    sourceAlert.sourceReference !== observation.sourceReference ||
    sourceAlert.sourceUrl !== observation.sourceUrl ||
    sourceAlert.publishedAt !== observation.publishedAt
  ) {
    throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Source payload identity disagrees with observation metadata.');
  }
  return sourceAlert;
}

function resolveObservationHead(
  database: RecallDatabase,
  alert: typeof schema.alerts.$inferSelect
): { head: AlertSourceObservation; sourceAlert: ReturnType<typeof normalizeAlert> } {
  const rows = database
    .select()
    .from(schema.alertSourceObservations)
    .where(eq(schema.alertSourceObservations.alertId, alert.id))
    .orderBy(asc(schema.alertSourceObservations.observedAt), asc(schema.alertSourceObservations.observationRef))
    .all();
  if (rows.length === 0) {
    throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Alert has no source observation.');
  }
  const byRef = new Map(rows.map((row) => [row.observationRef, row]));
  const childCounts = new Map<string, number>();
  const roots = rows.filter((row) => row.predecessorObservationRef === null);
  if (roots.length !== 1) {
    throw new AlertProvenanceError('AMBIGUOUS_SOURCE_HEAD', 'Source observation lineage must have one root.');
  }
  const root = roots[0];
  for (const row of rows) {
    validateObservation(alert, row);
    if (
      row.source !== root.source ||
      row.provider !== root.provider ||
      row.sourceReference !== root.sourceReference ||
      row.demo !== root.demo
    ) {
      throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Source observation lineage identity changed.');
    }
  }
  for (const row of rows) {
    if (!row.predecessorObservationRef) continue;
    const predecessor = byRef.get(row.predecessorObservationRef);
    if (!predecessor || predecessor.alertId !== row.alertId) {
      throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Source observation predecessor is missing or foreign.');
    }
    childCounts.set(row.predecessorObservationRef, (childCounts.get(row.predecessorObservationRef) ?? 0) + 1);
  }
  if ([...childCounts.values()].some((count) => count !== 1)) {
    throw new AlertProvenanceError('AMBIGUOUS_SOURCE_HEAD', 'Source observation lineage contains a fork.');
  }
  const heads = rows.filter((row) => !childCounts.has(row.observationRef));
  if (heads.length !== 1) {
    throw new AlertProvenanceError('AMBIGUOUS_SOURCE_HEAD', 'Source observation lineage must have one head.');
  }
  const visited = new Set<string>();
  let cursor: AlertSourceObservation | undefined = heads[0];
  while (cursor) {
    if (visited.has(cursor.observationRef)) {
      throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Source observation lineage contains a cycle.');
    }
    visited.add(cursor.observationRef);
    cursor = cursor.predecessorObservationRef ? byRef.get(cursor.predecessorObservationRef) : undefined;
  }
  if (visited.size !== rows.length || !visited.has(roots[0].observationRef)) {
    throw new AlertProvenanceError('AMBIGUOUS_SOURCE_HEAD', 'Source observation lineage is disconnected.');
  }
  return { head: heads[0], sourceAlert: validateObservation(alert, heads[0]) };
}

function valueFromAssertions(assertions: AlertFieldAssertion[]): ResolvedAlertValue | null {
  if (assertions.length === 0) return null;
  const values = [...new Set(assertions.map((item) => item.normalizedValue))];
  if (values.length !== 1) return null;
  return {
    normalizedValue: values[0],
    rawValues: [...new Set(assertions.map((item) => item.rawValue))].sort(),
    assertionRefs: canonicalAlertRefs(assertions.map((item) => item.assertionRef)),
    originKinds: [...new Set(assertions.map((item) => item.originKind))].sort()
  };
}

function valuesFromAssertions(assertions: AlertFieldAssertion[]): ResolvedAlertValue[] {
  const values = [...new Set(assertions.map((item) => item.normalizedValue))].sort();
  return values.flatMap((normalizedValue) => {
    const value = valueFromAssertions(
      assertions.filter((item) => item.normalizedValue === normalizedValue)
    );
    return value ? [value] : [];
  });
}

const discoveryOriginPriority: AlertAssertionOriginKind[] = [
  'HUMAN_CONFIRMED',
  'SOURCE_ASSERTED',
  'DETERMINISTIC_DERIVED',
  'AI_PROPOSAL',
  'LEGACY_UNVERIFIED'
];

function discoveryValue(assertions: AlertFieldAssertion[]): ResolvedAlertValue | null {
  for (const origin of discoveryOriginPriority) {
    const candidates = assertions.filter((item) => item.originKind === origin);
    const value = valueFromAssertions(candidates);
    if (value) return value;
  }
  return null;
}

function trustedForField(fieldKind: AlertFieldKind, assertion: AlertFieldAssertion): boolean {
  if (assertion.originKind === 'AI_PROPOSAL' || assertion.originKind === 'LEGACY_UNVERIFIED') {
    return false;
  }
  if (assertion.originKind === 'DETERMINISTIC_DERIVED') {
    return fieldKind === 'EAN_GTIN' && Boolean(assertion.sourceLocator?.trim());
  }
  return assertion.originKind === 'SOURCE_ASSERTED' || assertion.originKind === 'HUMAN_CONFIRMED';
}

export function resolveAlertFactsInTransaction(
  database: RecallDatabase,
  input: { alertId: string; sourceObservationRef?: string; purpose: AlertFactPurpose }
): ResolvedAlertFacts {
  const alert = database.select().from(schema.alerts).where(eq(schema.alerts.id, input.alertId)).get();
  if (!alert) {
    throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Alert could not be found.');
  }
  const resolvedHead = resolveObservationHead(database, alert);
  const selected = input.sourceObservationRef
    ? database
        .select()
        .from(schema.alertSourceObservations)
        .where(eq(schema.alertSourceObservations.observationRef, input.sourceObservationRef))
        .get()
    : resolvedHead.head;
  if (!selected || selected.alertId !== alert.id) {
    throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Selected source observation is missing or foreign.');
  }
  if (input.purpose === 'AUTHORITATIVE' && selected.observationRef !== resolvedHead.head.observationRef) {
    throw new AlertProvenanceError('STALE_SOURCE_OBSERVATION', 'The reviewed source observation is no longer current.');
  }
  const sourceAlert = validateObservation(alert, selected);
  const assertions = database
    .select()
    .from(schema.alertFieldAssertions)
    .where(eq(schema.alertFieldAssertions.sourceObservationRef, selected.observationRef))
    .orderBy(asc(schema.alertFieldAssertions.assertionRef))
    .all();
  for (const assertion of assertions) {
    if (assertion.alertId !== alert.id || assertion.demo !== selected.demo) {
      throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Assertion ownership or demo provenance is invalid.');
    }
    validateAssertionMetadata(assertion);
    validateAssertionSourceBinding(assertion, selected);
  }
  const byRef = new Map(assertions.map((assertion) => [assertion.assertionRef, assertion]));
  const visitedBasisRefs = new Set<string>();
  const activeBasisRefs = new Set<string>();
  const visitBasis = (assertion: AlertFieldAssertion): void => {
    if (activeBasisRefs.has(assertion.assertionRef)) {
      throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Assertion basis contains a cycle.');
    }
    if (visitedBasisRefs.has(assertion.assertionRef)) return;
    activeBasisRefs.add(assertion.assertionRef);
    for (const basisRef of parseCanonicalRefs(assertion.basisAssertionRefsJson, 'basisAssertionRefs')) {
      const basis = byRef.get(basisRef);
      if (!basis || basis.alertId !== alert.id || basis.sourceObservationRef !== selected.observationRef) {
        throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Assertion basis is missing or foreign.');
      }
      visitBasis(basis);
    }
    activeBasisRefs.delete(assertion.assertionRef);
    visitedBasisRefs.add(assertion.assertionRef);
  };
  for (const assertion of assertions) {
    visitBasis(assertion);
    if (assertion.originKind === 'HUMAN_CONFIRMED') {
      let hasIndependentValueSupport = false;
      for (const supportRef of parseCanonicalRefs(
        assertion.supportingEvidenceRefsJson,
        'supportingEvidenceRefs'
      )) {
        const support = byRef.get(supportRef);
        if (supportRef === assertion.assertionRef || (!support && supportRef !== selected.observationRef)) {
          throw new AlertProvenanceError(
            'ASSERTION_PROVENANCE_INVALID',
            'Human confirmation support is not durable alert provenance.'
          );
        }
        if (
          support &&
          (support.originKind === 'SOURCE_ASSERTED' ||
            (support.originKind === 'DETERMINISTIC_DERIVED' &&
              support.fieldKind === 'EAN_GTIN' &&
              Boolean(support.sourceLocator) &&
              support.producerIdentifier === ALERT_LABELLED_GTIN_PARSER_IDENTIFIER &&
              support.producerVersion === ALERT_LABELLED_GTIN_PARSER_VERSION)) &&
          support.fieldKind === assertion.fieldKind &&
          support.normalizedValue === assertion.normalizedValue
        ) {
          hasIndependentValueSupport = true;
        }
      }
      if (!hasIndependentValueSupport) {
        throw new AlertProvenanceError(
          'ASSERTION_PROVENANCE_INVALID',
          'Human confirmation requires independent, same-value durable support.'
        );
      }
    }
  }

  const assertionsByField = Object.fromEntries(
    schema.alertFieldKinds.map((kind) => [kind, assertions.filter((item) => item.fieldKind === kind)])
  ) as Record<AlertFieldKind, AlertFieldAssertion[]>;
  const blockers = new Set<AlertProvenanceBlocker>();

  const trustedEanAssertions = assertionsByField.EAN_GTIN.filter((item) => trustedForField('EAN_GTIN', item));
  const invalidTrustedEan = trustedEanAssertions.some((item) => !validateGtin(item.normalizedValue).valid);
  if (invalidTrustedEan) blockers.add('INVALID_GTIN');
  const validTrustedEans = trustedEanAssertions.filter((item) => validateGtin(item.normalizedValue).valid);
  if (new Set(validTrustedEans.map((item) => item.normalizedValue)).size > 1) blockers.add('TRUSTED_CONFLICT');

  const trustedBatchAssertions = assertionsByField.BATCH_LOT.filter(
    (item) => trustedForField('BATCH_LOT', item) && item.originKind !== 'DETERMINISTIC_DERIVED'
  );
  if (
    (assertionsByField.EAN_GTIN.some((item) => item.originKind === 'AI_PROPOSAL') &&
      trustedEanAssertions.length === 0) ||
    (assertionsByField.BATCH_LOT.some((item) => item.originKind === 'AI_PROPOSAL') &&
      trustedBatchAssertions.length === 0)
  ) blockers.add('AI_ONLY');
  if (
    (assertionsByField.EAN_GTIN.some((item) => item.originKind === 'LEGACY_UNVERIFIED') &&
      trustedEanAssertions.length === 0) ||
    (assertionsByField.BATCH_LOT.some((item) => item.originKind === 'LEGACY_UNVERIFIED') &&
      trustedBatchAssertions.length === 0)
  ) blockers.add('LEGACY_UNVERIFIED');
  if (new Set(trustedBatchAssertions.map((item) => item.normalizedValue)).size > 1) {
    blockers.add('TRUSTED_CONFLICT');
  }
  const ean = invalidTrustedEan || new Set(validTrustedEans.map((item) => item.normalizedValue)).size !== 1
    ? null
    : valueFromAssertions(validTrustedEans);
  const batch = new Set(trustedBatchAssertions.map((item) => item.normalizedValue)).size !== 1
    ? null
    : valueFromAssertions(trustedBatchAssertions);
  const discoveryValues = {
    productName: discoveryValue(assertionsByField.PRODUCT_NAME),
    brand: discoveryValue(assertionsByField.BRAND),
    ean: discoveryValue(assertionsByField.EAN_GTIN),
    batch: discoveryValue(assertionsByField.BATCH_LOT),
    category: discoveryValue(assertionsByField.CATEGORY)
  };
  const discoveryRefs = canonicalAlertRefs(
    Object.values(discoveryValues).flatMap((value) => value?.assertionRefs ?? [])
  );
  return {
    alertId: alert.id,
    purpose: input.purpose,
    sourceObservation: selected,
    sourceAlert,
    assertions,
    assertionsByField,
    discovery: { ...discoveryValues, assertionRefs: discoveryRefs },
    authoritative: {
      ean,
      batch,
      eanValues: invalidTrustedEan ? [] : valuesFromAssertions(validTrustedEans),
      batchValues: valuesFromAssertions(trustedBatchAssertions),
      identityAssertionRefs: invalidTrustedEan
        ? []
        : canonicalAlertRefs(validTrustedEans.map((item) => item.assertionRef)),
      scopeAssertionRefs: canonicalAlertRefs(
        trustedBatchAssertions.map((item) => item.assertionRef)
      )
    },
    discoveryOnlyProposalRefs: canonicalAlertRefs(
      assertions.filter((item) => item.originKind === 'AI_PROPOSAL').map((item) => item.assertionRef)
    ),
    blockers: [...blockers].sort()
  };
}

export function resolveAlertFacts(
  database: RecallDatabase,
  input: { alertId: string; sourceObservationRef?: string; purpose: AlertFactPurpose }
): ResolvedAlertFacts {
  return database.transaction((transaction) => resolveAlertFactsInTransaction(transaction, input));
}

export function recordAlertSourceObservationInTransaction(
  database: RecallDatabase,
  input: { alertId: string; source: AlertSourceRecord }
): { observation: AlertSourceObservation; replayed: boolean } {
  const alert = database.select().from(schema.alerts).where(eq(schema.alerts.id, input.alertId)).get();
  if (!alert) throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Alert must exist before its observation.');
  const rawBytes = Buffer.byteLength(input.source.rawPayload, 'utf8');
  if (rawBytes === 0 || rawBytes > ALERT_RAW_PAYLOAD_MAX_BYTES) {
    throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Source payload size is invalid.');
  }
  const parsed = normalizeAlert(JSON.parse(input.source.rawPayload) as unknown);
  if (canonical(parsed) !== canonical(input.source.alert)) {
    throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Source envelope does not match its raw payload.');
  }
  const contentSha256 = alertContentSha256(input.source.rawPayload);
  const sourceVersionIdentifier = input.source.sourceVersionIdentifier?.trim() || `sha256:${contentSha256}`;
  const existing = database
    .select()
    .from(schema.alertSourceObservations)
    .where(eq(schema.alertSourceObservations.alertId, input.alertId))
    .all();
  const replay = existing.find((row) =>
    row.sourceVersionIdentifier === sourceVersionIdentifier && row.contentSha256 === contentSha256
  );
  if (replay) {
    validateObservation(alert, replay);
    return { observation: replay, replayed: true };
  }
  if (existing.some((row) => row.sourceVersionIdentifier === sourceVersionIdentifier || row.contentSha256 === contentSha256)) {
    throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Source version and content identity disagree.');
  }
  const predecessor = existing.length ? resolveObservationHead(database, alert).head : null;
  const observation: typeof schema.alertSourceObservations.$inferInsert = {
    observationRef: randomUUID(),
    alertId: alert.id,
    recordKind: 'RAW_SOURCE',
    source: input.source.alert.source,
    provider: input.source.provider.trim(),
    sourceReference: input.source.alert.sourceReference,
    sourceUrl: input.source.alert.sourceUrl,
    sourceVersionIdentifier,
    predecessorObservationRef: predecessor?.observationRef ?? null,
    payloadFormat: input.source.payloadFormat,
    rawPayload: input.source.rawPayload,
    contentSha256,
    publishedAt: input.source.alert.publishedAt,
    sourceUpdatedAt: input.source.sourceUpdatedAt ?? null,
    observedAt: input.source.observedAt,
    demo: input.source.demo
  };
  database.insert(schema.alertSourceObservations).values(observation).run();
  const persisted = database
    .select()
    .from(schema.alertSourceObservations)
    .where(eq(schema.alertSourceObservations.observationRef, observation.observationRef))
    .get();
  if (!persisted) throw new AlertProvenanceError('SOURCE_PROVENANCE_INVALID', 'Source observation was not persisted.');
  validateObservation(alert, persisted);
  return { observation: persisted, replayed: false };
}

export interface AlertFieldAssertionInput {
  alertId: string;
  sourceObservationRef: string;
  fieldKind: AlertFieldKind;
  rawValue: string;
  originKind: AlertAssertionOriginKind;
  sourceLocator: string | null;
  producerIdentifier: string;
  producerVersion: string;
  modelIdentifier: string | null;
  basisAssertionRefs: string[];
  supportingEvidenceRefs?: string[];
  humanActorIdentifier?: string | null;
  rationale?: string | null;
  createdAt: string;
  demo: boolean;
}

export function buildAlertFieldAssertion(
  input: AlertFieldAssertionInput,
  assertionRef: string = randomUUID()
): typeof schema.alertFieldAssertions.$inferInsert {
  const basisAssertionRefs = canonicalAlertRefs(input.basisAssertionRefs);
  const supportingEvidenceRefs = canonicalAlertRefs(input.supportingEvidenceRefs ?? []);
  const normalizedValue = normalizeFieldValue(input.fieldKind, input.rawValue);
  const semantic = {
    alertId: input.alertId,
    sourceObservationRef: input.sourceObservationRef,
    fieldKind: input.fieldKind,
    rawValue: input.rawValue,
    normalizedValue,
    originKind: input.originKind,
    sourceLocator: input.sourceLocator,
    producerIdentifier: input.producerIdentifier,
    producerVersion: input.producerVersion,
    modelIdentifier: input.modelIdentifier,
    basisAssertionRefs,
    supportingEvidenceRefs,
    humanActorIdentifier: input.humanActorIdentifier ?? null,
    rationale: input.rationale ?? null,
    demo: input.demo
  };
  const semanticDigest = alertSemanticDigest(semantic);
  return {
    assertionRef,
    ...semantic,
    basisAssertionRefsJson: JSON.stringify(basisAssertionRefs),
    supportingEvidenceRefsJson: JSON.stringify(supportingEvidenceRefs),
    semanticDigest,
    createdAt: input.createdAt
  };
}

function recordAssertionInTransaction(
  database: RecallDatabase,
  input: AlertFieldAssertionInput
): AlertFieldAssertion {
  const row = buildAlertFieldAssertion(input);
  const existing = database
    .select()
    .from(schema.alertFieldAssertions)
    .where(eq(schema.alertFieldAssertions.semanticDigest, row.semanticDigest))
    .get();
  if (existing) {
    validateAssertionMetadata(existing);
    return existing;
  }
  database.insert(schema.alertFieldAssertions).values(row).onConflictDoNothing().run();
  const persisted = database
    .select()
    .from(schema.alertFieldAssertions)
    .where(eq(schema.alertFieldAssertions.semanticDigest, row.semanticDigest))
    .get();
  if (!persisted) throw new AlertProvenanceError('ASSERTION_PROVENANCE_INVALID', 'Assertion was not persisted.');
  validateAssertionMetadata(persisted);
  return persisted;
}

const sourceFieldMap = [
  ['productName', 'PRODUCT_NAME'],
  ['brand', 'BRAND'],
  ['ean', 'EAN_GTIN'],
  ['batch', 'BATCH_LOT'],
  ['category', 'CATEGORY']
] as const;

export function recordStructuredSourceAssertionsInTransaction(
  database: RecallDatabase,
  input: { alertId: string; observation: AlertSourceObservation; rawPayload: string; createdAt: string }
): AlertFieldAssertion[] {
  const raw = JSON.parse(input.rawPayload) as Record<string, unknown>;
  return sourceFieldMap.flatMap(([sourceField, fieldKind]) => {
    const value = raw[sourceField];
    if (typeof value !== 'string' || !value.trim()) return [];
    return [recordAssertionInTransaction(database, {
      alertId: input.alertId,
      sourceObservationRef: input.observation.observationRef,
      fieldKind,
      rawValue: value,
      originKind: 'SOURCE_ASSERTED',
      sourceLocator: `/${sourceField}`,
      producerIdentifier: ALERT_SOURCE_PARSER_IDENTIFIER,
      producerVersion: ALERT_SOURCE_PARSER_VERSION,
      modelIdentifier: null,
      basisAssertionRefs: [],
      createdAt: input.createdAt,
      demo: input.observation.demo
    })];
  });
}

export function recordAiProposalAssertionsInTransaction(
  database: RecallDatabase,
  input: {
    alertId: string;
    observation: AlertSourceObservation;
    extraction: AlertProposalExtraction;
    sourceAssertionRefs: string[];
    createdAt: string;
  }
): AlertFieldAssertion[] {
  const extraction = validateAlertProposalExtraction(input.extraction);
  if (extraction.origin === 'NONE') return [];
  const proposalFieldMap = [
    ['productName', 'PRODUCT_NAME'],
    ['brand', 'BRAND'],
    ['ean', 'EAN_GTIN'],
    ['batch', 'BATCH_LOT'],
    ['category', 'CATEGORY']
  ] as const;
  return proposalFieldMap.flatMap(([proposalField, fieldKind]) => {
    const value = extraction.proposals[proposalField];
    if (typeof value !== 'string' || !value.trim()) return [];
    return [recordAssertionInTransaction(database, {
      alertId: input.alertId,
      sourceObservationRef: input.observation.observationRef,
      fieldKind,
      rawValue: value,
      originKind: 'AI_PROPOSAL',
      sourceLocator: null,
      producerIdentifier: extraction.extractorIdentifier,
      producerVersion: extraction.extractorVersion,
      modelIdentifier: extraction.modelIdentifier,
      basisAssertionRefs: input.sourceAssertionRefs,
      createdAt: input.createdAt,
      demo: input.observation.demo
    })];
  });
}
