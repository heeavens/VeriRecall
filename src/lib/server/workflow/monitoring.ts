import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import {
  type AlertProposalExtraction,
  type AlertSource,
  type AlertStatus,
  type FuzzyMatcher,
  type MatchExplanation,
  type LlmClient
} from '../../types/domain';
import { ArchiveAlertSource } from '../alerts/archive-source';
import {
  recordAiProposalAssertionsInTransaction,
  recordAlertSourceObservationInTransaction,
  recordStructuredSourceAssertionsInTransaction,
  resolveAlertFactsInTransaction,
  validateAlertProposalExtraction
} from '../alerts/alert-provenance';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { LocalFuzzyMatcher } from '../matching/fuzzy-matcher';
import { recordAlertMatchBasisInTransaction } from '../matching/match-basis';
import { classifyScore, explainScore, findTopCandidatesFromFacts } from '../matching/scoring';
import { createLlmClient } from '../llm/client';
import { assessHarm } from '../risk/harm';

export interface MonitoringCycleSummary {
  imported: number;
  highConfidence: number;
  review: number;
  ignored: number;
  durationMs: number;
}

export async function runMonitoringCycle(
  database: RecallDatabase,
  source: AlertSource = new ArchiveAlertSource(),
  matcher: FuzzyMatcher = new LocalFuzzyMatcher(),
  llmClient: LlmClient = createLlmClient()
): Promise<MonitoringCycleSummary> {
  const startedAt = performance.now();
  const incomingAlerts = await source.readAlerts();
  const products = database.select().from(schema.products).all();
  const setting = database.select().from(schema.settings).get();
  const confidenceThreshold = setting?.confidenceThreshold ?? 85;
  const reviewFloor = setting?.reviewFloor ?? 55;
  const summary: MonitoringCycleSummary = {
    imported: 0,
    highConfidence: 0,
    review: 0,
    ignored: 0,
    durationMs: 0
  };

  for (const incomingSource of incomingAlerts) {
    const sourceAlert = incomingSource.alert;
    const sourceState = database.transaction((transaction) => {
      let alert = transaction
        .select()
        .from(schema.alerts)
        .where(
          and(
            eq(schema.alerts.source, sourceAlert.source),
            eq(schema.alerts.sourceReference, sourceAlert.sourceReference)
          )
        )
        .get();
      const createdAt = new Date().toISOString();
      if (!alert) {
        const alertId = randomUUID();
        transaction.insert(schema.alerts).values({
          id: alertId,
          ...sourceAlert,
          brand: sourceAlert.brand ?? null,
          ean: sourceAlert.ean ?? null,
          batch: sourceAlert.batch ?? null,
          category: sourceAlert.category ?? null,
          imageUrl: null,
          status: 'needs_review',
          rawJson: incomingSource.rawPayload,
          createdAt
        }).run();
        alert = transaction.select().from(schema.alerts).where(eq(schema.alerts.id, alertId)).get();
      }
      if (!alert) throw new Error('The source alert could not be persisted.');
      const recorded = recordAlertSourceObservationInTransaction(transaction, {
        alertId: alert.id,
        source: incomingSource
      });
      if (!recorded.replayed) {
        transaction.update(schema.alerts).set({
          sourceUrl: sourceAlert.sourceUrl,
          title: sourceAlert.title,
          description: sourceAlert.description,
          risk: sourceAlert.risk,
          productName: sourceAlert.productName,
          brand: sourceAlert.brand ?? null,
          ean: sourceAlert.ean ?? null,
          batch: sourceAlert.batch ?? null,
          category: sourceAlert.category ?? null,
          publishedAt: sourceAlert.publishedAt,
          rawJson: incomingSource.rawPayload
        }).where(eq(schema.alerts.id, alert.id)).run();
      }
      const sourceAssertions = recordStructuredSourceAssertionsInTransaction(transaction, {
        alertId: alert.id,
        observation: recorded.observation,
        rawPayload: incomingSource.rawPayload,
        createdAt
      });
      const hasMatchBasis = Boolean(transaction
        .select({ matchId: schema.alertMatchBases.matchId })
        .from(schema.alertMatchBases)
        .where(eq(schema.alertMatchBases.sourceObservationRef, recorded.observation.observationRef))
        .get());
      if (!recorded.replayed) {
        transaction.insert(schema.auditEvents).values({
          id: randomUUID(),
          alertId: alert.id,
          eventType: 'source_observation_recorded',
          actorType: 'agent',
          actorName: 'monitoring_agent',
          summary: `Recorded immutable ${incomingSource.provider} source observation.`,
          metadataJson: JSON.stringify({
            observationRef: recorded.observation.observationRef,
            sourceVersionIdentifier: recorded.observation.sourceVersionIdentifier,
            contentSha256: recorded.observation.contentSha256,
            demo: recorded.observation.demo
          }),
          createdAt
        }).run();
      }
      return {
        alertId: alert.id,
        observation: recorded.observation,
        sourceAssertions,
        skip: recorded.replayed && hasMatchBasis
      };
    });
    if (sourceState.skip) continue;

    let extraction: AlertProposalExtraction;
    try {
      extraction = validateAlertProposalExtraction(
        await llmClient.extractAlert(incomingSource.rawPayload)
      );
    } catch {
      extraction = {
        proposals: {},
        origin: 'NONE',
        extractorIdentifier: 'failed-ai-extraction',
        extractorVersion: 'v1',
        modelIdentifier: null
      };
    }
    const facts = database.transaction((transaction) => {
      recordAiProposalAssertionsInTransaction(transaction, {
        alertId: sourceState.alertId,
        observation: sourceState.observation,
        extraction,
        sourceAssertionRefs: sourceState.sourceAssertions.map((item) => item.assertionRef),
        createdAt: new Date().toISOString()
      });
      return resolveAlertFactsInTransaction(transaction, {
        alertId: sourceState.alertId,
        sourceObservationRef: sourceState.observation.observationRef,
        purpose: 'DISCOVERY'
      });
    });
    const candidates = findTopCandidatesFromFacts(facts, products, matcher);
    const bestCandidate = candidates[0];
    const deterministicExplanation = (breakdown: (typeof candidates)[number]['breakdown']): MatchExplanation => ({
      text: explainScore(breakdown),
      origin: 'DETERMINISTIC',
      generatorIdentifier: 'verirecall-match-explainer',
      generatorVersion: 'v1',
      modelIdentifier: null
    });
    const explanations = new Map<string, MatchExplanation>();
    for (const candidate of candidates) {
      explanations.set(candidate.product.id, deterministicExplanation(candidate.breakdown));
    }
    if (bestCandidate) {
      try {
        explanations.set(bestCandidate.product.id, await llmClient.explainMatch(bestCandidate.breakdown));
      } catch {
        explanations.set(bestCandidate.product.id, deterministicExplanation(bestCandidate.breakdown));
      }
    }
    const classification = bestCandidate
      ? classifyScore(bestCandidate.breakdown, confidenceThreshold, reviewFloor)
      : 'not_relevant';
    const alertStatus: AlertStatus =
      classification === 'matched' ? 'needs_review' : classification;
    const harm = assessHarm(sourceAlert);
    const result = database.transaction((transaction) => {
      const now = new Date().toISOString();
      const alertId = sourceState.alertId;
      const stillMissingBasis = !transaction
        .select({ matchId: schema.alertMatchBases.matchId })
        .from(schema.alertMatchBases)
        .where(eq(schema.alertMatchBases.sourceObservationRef, sourceState.observation.observationRef))
        .get();
      if (!stillMissingBasis) return null;
      transaction.update(schema.alerts).set({ status: alertStatus }).where(eq(schema.alerts.id, alertId)).run();

      transaction
        .insert(schema.auditEvents)
        .values([
          {
            id: randomUUID(),
            alertId,
            eventType: 'alert_imported',
            actorType: 'agent',
            actorName: 'monitoring_agent',
            summary: `Processed ${sourceAlert.source} alert ${sourceAlert.sourceReference}.`,
            metadataJson: JSON.stringify({
              sourceReference: sourceAlert.sourceReference,
              observationRef: sourceState.observation.observationRef
            }),
            createdAt: now
          },
          {
            id: randomUUID(),
            alertId,
            eventType: 'fields_extracted',
            actorType: 'agent',
            actorName: 'extraction_adapter',
            summary: extraction.origin === 'AI_GENERATED'
              ? 'Stored validated AI extraction output as proposal-only assertions.'
              : 'No AI proposals were stored; structured source assertions remain available.',
            metadataJson: JSON.stringify({
              validation: 'strict_structured_output',
              extractionOrigin: extraction.origin,
              modelIdentifier: extraction.modelIdentifier
            }),
            createdAt: now
          }
        ])
        .run();

      candidates.forEach((candidate, index) => {
        const matchId = randomUUID();
        const explanation = explanations.get(candidate.product.id) ?? deterministicExplanation(candidate.breakdown);
        transaction
          .insert(schema.matches)
          .values({
            id: matchId,
            alertId,
            productId: candidate.product.id,
            totalScore: candidate.breakdown.total,
            nameScore: candidate.breakdown.name,
            brandScore: candidate.breakdown.brand,
            eanScore: candidate.breakdown.ean,
            batchScore: candidate.breakdown.batch,
            hasHardConflict: candidate.breakdown.hasHardConflict,
            explanation: explanation.text,
            status: 'candidate',
            createdAt: now,
            decidedAt: null
          })
          .run();
        recordAlertMatchBasisInTransaction(transaction, {
          matchId,
          alertId,
          sourceObservationRef: sourceState.observation.observationRef,
          catalogueProduct: candidate.product,
          discoveryAssertionRefs: candidate.provenance.discoveryAssertionRefs,
          authoritativeIdentityAssertionRefs: candidate.provenance.authoritativeIdentityAssertionRefs,
          authoritativeScopeAssertionRefs: candidate.provenance.authoritativeScopeAssertionRefs,
          explanation,
          createdAt: now,
          demo: sourceState.observation.demo
        });
        transaction
          .insert(schema.auditEvents)
          .values({
            id: randomUUID(),
            alertId,
            eventType: 'match_scored',
            actorType: 'agent',
            actorName: 'matching_agent',
            summary: `Ranked ${candidate.product.sku} with match score ${candidate.breakdown.total}.`,
            metadataJson: JSON.stringify({
              matchId,
              productId: candidate.product.id,
              rank: index + 1,
              threshold: confidenceThreshold,
              reviewFloor,
              harm,
              breakdown: candidate.breakdown,
              explanation: explanation.text,
              explanationOrigin: explanation.origin,
              observationRef: sourceState.observation.observationRef
            }),
            createdAt: now
          })
          .run();
      });

      transaction
        .insert(schema.auditEvents)
        .values({
          id: randomUUID(),
          alertId,
          eventType: alertStatus === 'needs_review' ? 'sent_to_review' : 'alert_not_relevant',
          actorType: 'agent',
          actorName: 'monitoring_agent',
          summary:
            classification === 'matched'
              ? 'Recommended a high-confidence candidate for mandatory human confirmation.'
              : alertStatus === 'needs_review'
                ? 'Sent the uncertain catalogue candidate to human review.'
                : 'Classified the alert as not relevant to the catalogue.',
          metadataJson: JSON.stringify({
            classification,
            bestScore: bestCandidate?.breakdown.total ?? null,
            threshold: confidenceThreshold,
            reviewFloor,
            harm
          }),
          createdAt: now
        })
        .run();

      return classification;
    });

    if (!result) continue;
    summary.imported += 1;
    if (result === 'matched') summary.highConfidence += 1;
    else if (result === 'needs_review') summary.review += 1;
    else summary.ignored += 1;
  }

  summary.durationMs = Math.max(1, Math.round(performance.now() - startedAt));
  return summary;
}
