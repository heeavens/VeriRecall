import { randomUUID } from 'node:crypto';

import { and, count, eq } from 'drizzle-orm';

import type { AlertSource, FuzzyMatcher, NormalizedAlert } from '../../types/domain';
import { normalizeAlert } from '../alerts/normalization';
import { alertReferenceKey, ArchiveAlertSource } from '../alerts/archive-source';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { LocalFuzzyMatcher } from '../matching/fuzzy-matcher';
import { classifyScore, findTopCandidates } from '../matching/scoring';

export interface MonitoringCycleSummary {
  imported: number;
  matched: number;
  review: number;
  ignored: number;
}

function nextCaseNumber(database: RecallDatabase): string {
  const caseCount = database.select({ value: count() }).from(schema.cases).get()?.value ?? 0;
  return `CASE-${String(caseCount + 1).padStart(4, '0')}`;
}

function severityFor(alert: NormalizedAlert): string {
  const risk = alert.risk.toLowerCase();
  return risk.includes('serious') || risk.includes('injur') || risk.includes('choking')
    ? 'high'
    : 'medium';
}

export async function runMonitoringCycle(
  database: RecallDatabase,
  source: AlertSource = new ArchiveAlertSource(),
  matcher: FuzzyMatcher = new LocalFuzzyMatcher()
): Promise<MonitoringCycleSummary> {
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
  const summary: MonitoringCycleSummary = { imported: 0, matched: 0, review: 0, ignored: 0 };

  for (const incomingAlert of incomingAlerts) {
    const normalizedAlert = normalizeAlert(incomingAlert);
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
      const candidates = findTopCandidates(normalizedAlert, products, matcher);
      const bestCandidate = candidates[0];
      const alertStatus = bestCandidate
        ? classifyScore(bestCandidate.breakdown, confidenceThreshold, reviewFloor)
        : 'not_relevant';

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
            actorName: 'deterministic_parser',
            summary: 'Validated and normalized archived alert fields.',
            metadataJson: JSON.stringify({ parser: 'deterministic', openAiUsed: false }),
            createdAt: now
          }
        ])
        .run();

      candidates.forEach((candidate, index) => {
        const isConfirmed = index === 0 && alertStatus === 'matched';
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
            status: isConfirmed ? 'confirmed' : 'candidate',
            createdAt: now,
            decidedAt: isConfirmed ? now : null
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
              breakdown: candidate.breakdown,
              explanation: candidate.explanation
            }),
            createdAt: now
          })
          .run();
      });

      if (alertStatus === 'matched' && bestCandidate) {
        const caseId = randomUUID();
        transaction
          .insert(schema.cases)
          .values({
            id: caseId,
            caseNumber: nextCaseNumber(transaction),
            alertId,
            status: 'open',
            severity: severityFor(normalizedAlert),
            openedAt: now,
            closedAt: null
          })
          .run();
        transaction
          .insert(schema.caseItems)
          .values({
            id: randomUUID(),
            caseId,
            productId: bestCandidate.product.id,
            batch: bestCandidate.product.batch ?? normalizedAlert.batch ?? 'Unknown',
            stockQuantity: bestCandidate.product.stockQuantity
          })
          .run();
        transaction
          .insert(schema.auditEvents)
          .values({
            id: randomUUID(),
            caseId,
            alertId,
            eventType: 'case_opened',
            actorType: 'agent',
            actorName: 'monitoring_agent',
            summary: `Opened a case for confirmed match ${bestCandidate.product.sku}.`,
            metadataJson: JSON.stringify({
              productId: bestCandidate.product.id,
              score: bestCandidate.breakdown.total,
              threshold: confidenceThreshold
            }),
            createdAt: now
          })
          .run();
      } else {
        transaction
          .insert(schema.auditEvents)
          .values({
            id: randomUUID(),
            alertId,
            eventType: alertStatus === 'needs_review' ? 'sent_to_review' : 'alert_not_relevant',
            actorType: 'agent',
            actorName: 'monitoring_agent',
            summary:
              alertStatus === 'needs_review'
                ? 'Sent the best catalogue candidate to human review.'
                : 'Classified the alert as not relevant to the catalogue.',
            metadataJson: JSON.stringify({
              bestScore: bestCandidate?.breakdown.total ?? null,
              threshold: confidenceThreshold,
              reviewFloor
            }),
            createdAt: now
          })
          .run();
      }

      return alertStatus;
    });

    if (!result) continue;
    summary.imported += 1;
    if (result === 'matched') summary.matched += 1;
    else if (result === 'needs_review') summary.review += 1;
    else summary.ignored += 1;
  }

  return summary;
}
