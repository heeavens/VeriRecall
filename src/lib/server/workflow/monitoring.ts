import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import {
  type AlertSource,
  type AlertStatus,
  type FuzzyMatcher,
  type LlmClient
} from '../../types/domain';
import { normalizeAlert } from '../alerts/normalization';
import { alertReferenceKey, ArchiveAlertSource } from '../alerts/archive-source';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { LocalFuzzyMatcher } from '../matching/fuzzy-matcher';
import { classifyScore, findTopCandidates } from '../matching/scoring';
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
  const existingReferences = new Set(
    database
      .select({ source: schema.alerts.source, sourceReference: schema.alerts.sourceReference })
      .from(schema.alerts)
      .all()
      .map(alertReferenceKey)
  );
  const incomingAlerts = await source.getNewAlerts(existingReferences);
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

  for (const incomingAlert of incomingAlerts) {
    const extractedAlert = await llmClient.extractAlert(JSON.stringify(incomingAlert));
    const normalizedAlert = normalizeAlert(extractedAlert);
    const candidates = findTopCandidates(normalizedAlert, products, matcher);
    const bestCandidate = candidates[0];
    if (bestCandidate) {
      bestCandidate.explanation = await llmClient.explainMatch(bestCandidate.breakdown);
    }
    const classification = bestCandidate
      ? classifyScore(bestCandidate.breakdown, confidenceThreshold, reviewFloor)
      : 'not_relevant';
    const alertStatus: AlertStatus =
      classification === 'matched' ? 'needs_review' : classification;
    const harm = assessHarm(normalizedAlert);
    const result = database.transaction((transaction) => {
      const alreadyImported = transaction
        .select({ id: schema.alerts.id })
        .from(schema.alerts)
        .where(
          and(
            eq(schema.alerts.source, normalizedAlert.source),
            eq(schema.alerts.sourceReference, normalizedAlert.sourceReference)
          )
        )
        .get();
      if (alreadyImported) return null;

      const now = new Date().toISOString();
      const alertId = randomUUID();
      transaction
        .insert(schema.alerts)
        .values({
          id: alertId,
          ...normalizedAlert,
          brand: normalizedAlert.brand ?? null,
          ean: normalizedAlert.ean ?? null,
          batch: normalizedAlert.batch ?? null,
          category: normalizedAlert.category ?? null,
          imageUrl: null,
          status: alertStatus,
          rawJson: JSON.stringify(normalizedAlert),
          createdAt: now
        })
        .run();

      transaction
        .insert(schema.auditEvents)
        .values([
          {
            id: randomUUID(),
            alertId,
            eventType: 'alert_imported',
            actorType: 'agent',
            actorName: 'monitoring_agent',
            summary: `Imported ${normalizedAlert.source} alert ${normalizedAlert.sourceReference}.`,
            metadataJson: JSON.stringify({ sourceReference: normalizedAlert.sourceReference }),
            createdAt: now
          },
          {
            id: randomUUID(),
            alertId,
            eventType: 'fields_extracted',
            actorType: 'agent',
            actorName: 'extraction_adapter',
            summary: 'Extracted, validated and normalized archived alert fields.',
            metadataJson: JSON.stringify({ validation: 'zod', extractionMode: 'validated_adapter' }),
            createdAt: now
          }
        ])
        .run();

      candidates.forEach((candidate, index) => {
        const matchId = randomUUID();
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
            explanation: candidate.explanation,
            status: 'candidate',
            createdAt: now,
            decidedAt: null
          })
          .run();
        transaction
          .insert(schema.auditEvents)
          .values({
            id: randomUUID(),
            alertId,
            eventType: 'match_scored',
            actorType: 'agent',
            actorName: 'matching_agent',
            summary: `Ranked ${candidate.product.sku} at ${candidate.breakdown.total}% confidence.`,
            metadataJson: JSON.stringify({
              matchId,
              productId: candidate.product.id,
              rank: index + 1,
              threshold: confidenceThreshold,
              reviewFloor,
              harm,
              breakdown: candidate.breakdown,
              explanation: candidate.explanation
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
