import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import {
  evaluateMatching,
  type MatchingEvaluation
} from '../evaluation/matching-evaluation';
import {
  assessHarm,
  harmScoreForLevel,
  type HarmAssessment,
  type HarmLevel
} from '../risk/harm';

export type IdentityOutcome =
  | 'confirmed'
  | 'high_confidence'
  | 'needs_review'
  | 'not_relevant';

export interface CatalogueMatchView {
  id: string;
  totalScore: number;
  nameScore: number;
  brandScore: number;
  eanScore: number;
  batchScore: number;
  hasHardConflict: boolean;
  explanation: string;
  status: (typeof schema.matches.$inferSelect)['status'];
  product: {
    id: string;
    sku: string;
    name: string;
    brand: string;
    ean: string | null;
    batch: string | null;
    category: string | null;
    supplierName: string | null;
    stockQuantity: number;
  };
}

export interface AlertFeedItem {
  id: string;
  source: (typeof schema.alerts.$inferSelect)['source'];
  sourceReference: string;
  productName: string;
  risk: string;
  publishedAt: string;
  status: (typeof schema.alerts.$inferSelect)['status'];
  identityOutcome: IdentityOutcome;
  harm: HarmAssessment;
  bestMatch: CatalogueMatchView | null;
}

export interface DashboardAttentionItem {
  id: string;
  kind: 'review' | 'approval' | 'case';
  label: string;
  title: string;
  description: string;
  meta: string;
  href: string;
  actionLabel: string;
  harmLevel: HarmLevel;
  harmScore: number;
  confidenceScore: number;
}

export interface DashboardView {
  counters: {
    waitingForReview: number;
    pendingApprovals: number;
    openCases: number;
    unfinishedCases: number;
  };
  archive: {
    total: number;
    confirmed: number;
    highConfidence: number;
    needsReview: number;
    notRelevant: number;
    lastImportedAt: string | null;
    catalogueProducts: number;
  };
  attention: DashboardAttentionItem[];
  alerts: AlertFeedItem[];
  evaluation: MatchingEvaluation;
}

function identityOutcome(
  status: AlertFeedItem['status'],
  bestMatch: CatalogueMatchView | null,
  confidenceThreshold: number
): IdentityOutcome {
  if (status === 'matched') return 'confirmed';
  if (status === 'not_relevant') return 'not_relevant';
  if (
    bestMatch &&
    bestMatch.totalScore >= confidenceThreshold &&
    !bestMatch.hasHardConflict
  ) {
    return 'high_confidence';
  }
  return 'needs_review';
}

function matchView(
  match: typeof schema.matches.$inferSelect,
  product: typeof schema.products.$inferSelect
): CatalogueMatchView {
  return {
    id: match.id,
    totalScore: match.totalScore,
    nameScore: match.nameScore,
    brandScore: match.brandScore,
    eanScore: match.eanScore,
    batchScore: match.batchScore,
    hasHardConflict: match.hasHardConflict,
    explanation: match.explanation,
    status: match.status,
    product: {
      id: product.id,
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      ean: product.ean,
      batch: product.batch,
      category: product.category,
      supplierName: product.supplierName,
      stockQuantity: product.stockQuantity
    }
  };
}

export function getDashboardView(database: RecallDatabase): DashboardView {
  const confidenceThreshold =
    database.select().from(schema.settings).get()?.confidenceThreshold ?? 85;
  const rows = database
    .select({ alert: schema.alerts, match: schema.matches, product: schema.products })
    .from(schema.alerts)
    .leftJoin(schema.matches, eq(schema.matches.alertId, schema.alerts.id))
    .leftJoin(schema.products, eq(schema.products.id, schema.matches.productId))
    .orderBy(desc(schema.alerts.createdAt), desc(schema.matches.totalScore), asc(schema.products.sku))
    .all();
  const feed = new Map<string, AlertFeedItem>();

  for (const row of rows) {
    if (feed.has(row.alert.id)) continue;
    const bestMatch = row.match && row.product ? matchView(row.match, row.product) : null;
    feed.set(row.alert.id, {
      id: row.alert.id,
      source: row.alert.source,
      sourceReference: row.alert.sourceReference,
      productName: row.alert.productName,
      risk: row.alert.risk,
      publishedAt: row.alert.publishedAt,
      status: row.alert.status,
      identityOutcome: identityOutcome(row.alert.status, bestMatch, confidenceThreshold),
      harm: assessHarm(row.alert),
      bestMatch
    });
  }

  const alerts = [...feed.values()];
  const unfinishedCaseRows = database
    .select({ caseRecord: schema.cases, alert: schema.alerts })
    .from(schema.cases)
    .innerJoin(schema.alerts, eq(schema.alerts.id, schema.cases.alertId))
    .where(ne(schema.cases.status, 'closed'))
    .orderBy(desc(schema.cases.openedAt))
    .all();
  const unfinishedCaseIds = unfinishedCaseRows.map((row) => row.caseRecord.id);
  const taskRows: Array<typeof schema.caseTasks.$inferSelect> = unfinishedCaseIds.length
    ? database
        .select()
        .from(schema.caseTasks)
        .where(inArray(schema.caseTasks.caseId, unfinishedCaseIds))
        .all()
    : [];
  const pendingDraftRows: Array<typeof schema.actionDrafts.$inferSelect> = unfinishedCaseIds.length
    ? database
        .select()
        .from(schema.actionDrafts)
        .where(
          and(
            inArray(schema.actionDrafts.caseId, unfinishedCaseIds),
            eq(schema.actionDrafts.status, 'draft')
          )
        )
        .all()
    : [];
  const reviewAttention: DashboardAttentionItem[] = alerts
    .filter((alert) =>
      alert.identityOutcome === 'high_confidence' || alert.identityOutcome === 'needs_review'
    )
    .map<DashboardAttentionItem>((alert) => ({
      id: `review-${alert.id}`,
      kind: 'review',
      label:
        alert.identityOutcome === 'high_confidence'
          ? 'High-confidence identity check'
          : 'Uncertain identity review',
      title: alert.productName,
      description: alert.bestMatch
        ? `Compare with ${alert.bestMatch.product.name} (${alert.bestMatch.product.sku}) before deciding.`
        : 'Review the attributed source identifiers and decide whether this alert relates to your catalogue.',
      meta: `${alert.sourceReference} · ${alert.harm.level} source-harm priority · ${alert.bestMatch ? `${alert.bestMatch.totalScore} match score` : 'No catalogue candidate'}`,
      href: '/review',
      actionLabel:
        alert.identityOutcome === 'high_confidence' ? 'Confirm identity' : 'Review match',
      harmLevel: alert.harm.level,
      harmScore: alert.harm.score,
      confidenceScore: alert.bestMatch?.totalScore ?? 0
    }))
    .sort(
      (left, right) =>
        right.harmScore - left.harmScore ||
        right.confidenceScore - left.confidenceScore
    );
  const caseAttention = unfinishedCaseRows.flatMap<DashboardAttentionItem>((row) => {
    const caseTasks = taskRows.filter((task) => task.caseId === row.caseRecord.id);
    const actionableTasks = caseTasks.filter((task) => task.status !== 'not_available');
    const pendingTasks = actionableTasks.filter((task) => task.status === 'pending').length;
    const draftCount = pendingDraftRows.filter((draft) => draft.caseId === row.caseRecord.id).length;
    const items: DashboardAttentionItem[] = [];

    if (draftCount > 0) {
      items.push({
        id: `approval-${row.caseRecord.id}`,
        kind: 'approval',
        label: 'Human approval',
        title: `${draftCount} approval${draftCount === 1 ? '' : 's'} need a decision`,
        description: `${row.caseRecord.caseNumber} · ${row.alert.productName}`,
        meta: 'No external message has been sent.',
        href: `/actions?case=${row.caseRecord.id}`,
        actionLabel: 'Open approvals',
        harmLevel: row.caseRecord.severity as HarmLevel,
        harmScore: harmScoreForLevel(row.caseRecord.severity),
        confidenceScore: 0
      });
    }

    items.push({
      id: `case-${row.caseRecord.id}`,
      kind: 'case',
      label: 'Containment case',
      title: `${row.caseRecord.caseNumber} · ${row.alert.productName}`,
      description:
        pendingTasks > 0
          ? `${pendingTasks} of ${actionableTasks.length} containment task${actionableTasks.length === 1 ? '' : 's'} still need action.`
          : 'Available containment tasks are complete. Review the evidence and case status.',
      meta: `${row.alert.sourceReference} · ${row.caseRecord.status === 'contained' ? 'Contained' : 'Open'}`,
      href: `/cases/${row.caseRecord.id}`,
      actionLabel: pendingTasks > 0 ? 'Continue case' : 'Review case',
      harmLevel: row.caseRecord.severity as HarmLevel,
      harmScore: harmScoreForLevel(row.caseRecord.severity),
      confidenceScore: 0
    });

    return items;
  });
  const outcomeCount = (outcome: IdentityOutcome): number =>
    alerts.filter((alert) => alert.identityOutcome === outcome).length;
  const attention = [...reviewAttention, ...caseAttention].sort(
    (left, right) =>
      right.harmScore - left.harmScore ||
      right.confidenceScore - left.confidenceScore
  );
  const evaluation = evaluateMatching(
    alerts.map((alert) => ({
      source: alert.source,
      sourceReference: alert.sourceReference,
      predictedSku: alert.bestMatch?.product.sku ?? null,
      relevant: alert.identityOutcome !== 'not_relevant'
    }))
  );

  return {
    counters: {
      waitingForReview: outcomeCount('high_confidence') + outcomeCount('needs_review'),
      pendingApprovals: pendingDraftRows.length,
      openCases: unfinishedCaseRows.filter((row) => row.caseRecord.status === 'open').length,
      unfinishedCases: unfinishedCaseRows.length
    },
    archive: {
      total: alerts.length,
      confirmed: outcomeCount('confirmed'),
      highConfidence: outcomeCount('high_confidence'),
      needsReview: outcomeCount('needs_review'),
      notRelevant: outcomeCount('not_relevant'),
      lastImportedAt: rows[0]?.alert.createdAt ?? null,
      catalogueProducts:
        database.select({ value: count() }).from(schema.products).get()?.value ?? 0
    },
    attention,
    alerts,
    evaluation
  };
}

export function getAlertDetail(database: RecallDatabase, alertId: string) {
  const alert = database.select().from(schema.alerts).where(eq(schema.alerts.id, alertId)).get();
  if (!alert) return null;

  const candidates = database
    .select({ match: schema.matches, product: schema.products })
    .from(schema.matches)
    .innerJoin(schema.products, eq(schema.products.id, schema.matches.productId))
    .where(eq(schema.matches.alertId, alertId))
    .orderBy(desc(schema.matches.totalScore), desc(schema.matches.eanScore), asc(schema.products.sku))
    .all()
    .map((row) => matchView(row.match, row.product));

  const confidenceThreshold =
    database.select().from(schema.settings).get()?.confidenceThreshold ?? 85;
  const bestMatch = candidates[0] ?? null;
  return {
    alert,
    candidates,
    confidenceThreshold,
    identityOutcome: identityOutcome(alert.status, bestMatch, confidenceThreshold),
    harm: assessHarm(alert)
  };
}
