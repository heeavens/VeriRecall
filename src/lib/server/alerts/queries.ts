import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';

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

export interface DashboardView {
  counters: {
    newAlertsToday: number;
    waitingForReview: number;
    openCases: number;
    closedThisMonth: number;
  };
  alerts: AlertFeedItem[];
}

function dateBounds(now: Date): { today: string; tomorrow: string; month: string; nextMonth: string } {
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    today: todayStart.toISOString(),
    tomorrow: tomorrowStart.toISOString(),
    month: monthStart.toISOString(),
    nextMonth: nextMonthStart.toISOString()
  };
}

function valueCount(rows: unknown[]): number {
  return rows.length;
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

export function getDashboardView(database: RecallDatabase, now = new Date()): DashboardView {
  const bounds = dateBounds(now);
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

  return {
    counters: {
      newAlertsToday: valueCount(
        database
          .select({ id: schema.alerts.id })
          .from(schema.alerts)
          .where(
            and(
              gte(schema.alerts.createdAt, bounds.today),
              lt(schema.alerts.createdAt, bounds.tomorrow)
            )
          )
          .all()
      ),
      waitingForReview: valueCount(
        database
          .select({ id: schema.alerts.id })
          .from(schema.alerts)
          .where(eq(schema.alerts.status, 'needs_review'))
          .all()
      ),
      openCases: valueCount(
        database
          .select({ id: schema.cases.id })
          .from(schema.cases)
          .where(eq(schema.cases.status, 'open'))
          .all()
      ),
      closedThisMonth: valueCount(
        database
          .select({ id: schema.cases.id, closedAt: schema.cases.closedAt })
          .from(schema.cases)
          .where(
            and(
              gte(schema.cases.closedAt, bounds.month),
              lt(schema.cases.closedAt, bounds.nextMonth)
            )
          )
          .all()
      )
    },
    alerts: [...feed.values()]
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
