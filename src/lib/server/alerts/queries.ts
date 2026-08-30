import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';

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
    matched: number;
    needsReview: number;
    notRelevant: number;
    lastImportedAt: string | null;
    catalogueProducts: number;
  };
  attention: DashboardAttentionItem[];
  alerts: AlertFeedItem[];
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
    feed.set(row.alert.id, {
      id: row.alert.id,
      source: row.alert.source,
      sourceReference: row.alert.sourceReference,
      productName: row.alert.productName,
      risk: row.alert.risk,
      publishedAt: row.alert.publishedAt,
      status: row.alert.status,
      bestMatch: row.match && row.product ? matchView(row.match, row.product) : null
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
    .filter((alert) => alert.status === 'needs_review')
    .map((alert) => ({
      id: `review-${alert.id}`,
      kind: 'review',
      label: 'Identity review',
      title: alert.productName,
      description: alert.bestMatch
        ? `Compare with ${alert.bestMatch.product.name} (${alert.bestMatch.product.sku}) before deciding.`
        : 'Review the official identifiers and decide whether this alert relates to your catalogue.',
      meta: `${alert.sourceReference} · ${alert.bestMatch ? `${alert.bestMatch.totalScore}% confidence` : 'No catalogue candidate'}`,
      href: '/review',
      actionLabel: 'Review match'
    }));
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
        title: `${draftCount} action draft${draftCount === 1 ? '' : 's'} await approval`,
        description: `${row.caseRecord.caseNumber} · ${row.alert.productName}`,
        meta: 'No external message has been sent.',
        href: `/actions?case=${row.caseRecord.id}`,
        actionLabel: 'Review drafts'
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
      actionLabel: pendingTasks > 0 ? 'Continue case' : 'Review case'
    });

    return items;
  });
  const statusCount = (status: (typeof schema.alerts.$inferSelect)['status']): number =>
    alerts.filter((alert) => alert.status === status).length;

  return {
    counters: {
      waitingForReview: statusCount('needs_review'),
      pendingApprovals: pendingDraftRows.length,
      openCases: unfinishedCaseRows.filter((row) => row.caseRecord.status === 'open').length,
      unfinishedCases: unfinishedCaseRows.length
    },
    archive: {
      total: alerts.length,
      matched: statusCount('matched'),
      needsReview: statusCount('needs_review'),
      notRelevant: statusCount('not_relevant'),
      lastImportedAt: rows[0]?.alert.createdAt ?? null,
      catalogueProducts:
        database.select({ value: count() }).from(schema.products).get()?.value ?? 0
    },
    attention: [...reviewAttention, ...caseAttention],
    alerts
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

  return { alert, candidates };
}
