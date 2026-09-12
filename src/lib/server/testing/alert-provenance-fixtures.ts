import { eq } from 'drizzle-orm';

import { normalizeAlert } from '../alerts/normalization';
import {
  recordAlertSourceObservationInTransaction,
  recordStructuredSourceAssertionsInTransaction,
  resolveAlertFactsInTransaction
} from '../alerts/alert-provenance';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { recordAlertMatchBasisInTransaction } from '../matching/match-basis';

/**
 * Rebuild an undecided synthetic match fixture against a new immutable source
 * observation. Production code must never delete or replace a Match Basis.
 */
export function rebaseUndecidedDemoMatchFixture(
  database: RecallDatabase,
  input: {
    matchId: string;
    sourceFields: Partial<Record<'productName' | 'brand' | 'ean' | 'batch' | 'category', string | null>>;
    observedAt: string;
  }
): void {
  database.transaction((transaction) => {
    const match = transaction.select().from(schema.matches).where(eq(schema.matches.id, input.matchId)).get();
    if (!match || match.status !== 'candidate') throw new Error('Only an undecided demo match fixture can be rebased.');
    const alert = transaction.select().from(schema.alerts).where(eq(schema.alerts.id, match.alertId)).get();
    const product = transaction.select().from(schema.products).where(eq(schema.products.id, match.productId)).get();
    const currentObservation = transaction
      .select()
      .from(schema.alertSourceObservations)
      .where(eq(schema.alertSourceObservations.alertId, match.alertId))
      .all()
      .find((candidate) => !transaction
        .select({ observationRef: schema.alertSourceObservations.observationRef })
        .from(schema.alertSourceObservations)
        .where(eq(schema.alertSourceObservations.predecessorObservationRef, candidate.observationRef))
        .get());
    if (!alert || !product || !currentObservation) throw new Error('Demo match fixture source provenance is missing.');
    const raw = JSON.parse(currentObservation.rawPayload) as Record<string, unknown>;
    Object.assign(raw, input.sourceFields);
    const rawPayload = JSON.stringify(raw);
    const sourceAlert = normalizeAlert(raw);
    const recorded = recordAlertSourceObservationInTransaction(transaction, {
      alertId: alert.id,
      source: {
        alert: sourceAlert,
        provider: currentObservation.provider,
        payloadFormat: 'application/json',
        rawPayload,
        observedAt: input.observedAt,
        demo: true
      }
    });
    recordStructuredSourceAssertionsInTransaction(transaction, {
      alertId: alert.id,
      observation: recorded.observation,
      rawPayload,
      createdAt: input.observedAt
    });
    const facts = resolveAlertFactsInTransaction(transaction, {
      alertId: alert.id,
      sourceObservationRef: recorded.observation.observationRef,
      purpose: 'DISCOVERY'
    });
    transaction.delete(schema.alertMatchBases).where(eq(schema.alertMatchBases.matchId, match.id)).run();
    recordAlertMatchBasisInTransaction(transaction, {
      matchId: match.id,
      alertId: alert.id,
      sourceObservationRef: recorded.observation.observationRef,
      catalogueProduct: product,
      discoveryAssertionRefs: facts.discovery.assertionRefs,
      authoritativeIdentityAssertionRefs: facts.authoritative.identityAssertionRefs,
      authoritativeScopeAssertionRefs: facts.authoritative.scopeAssertionRefs,
      explanation: {
        text: match.explanation,
        origin: 'DETERMINISTIC',
        generatorIdentifier: 'verirecall-test-fixture-match-explainer',
        generatorVersion: 'v1',
        modelIdentifier: null
      },
      createdAt: input.observedAt,
      demo: true
    });
  });
}
