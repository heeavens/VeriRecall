import { asc, desc, eq } from 'drizzle-orm';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';

export interface CatalogueAlertLink {
  alertId: string;
  source: (typeof schema.alerts.$inferSelect)['source'];
  sourceReference: string;
  alertStatus: (typeof schema.alerts.$inferSelect)['status'];
  matchStatus: (typeof schema.matches.$inferSelect)['status'];
  totalScore: number;
}

export interface CatalogueCaseLink {
  caseId: string;
  caseNumber: string;
  status: (typeof schema.cases.$inferSelect)['status'];
  sourceReference: string;
}

export interface CatalogueProductView {
  product: typeof schema.products.$inferSelect;
  alerts: CatalogueAlertLink[];
  cases: CatalogueCaseLink[];
}

export interface CatalogueView {
  summary: {
    totalProducts: number;
    missingEan: number;
    missingBatch: number;
    missingAnyIdentifier: number;
  };
  products: CatalogueProductView[];
}

function isMissing(value: string | null): boolean {
  return value === null || value.trim().length === 0;
}

export function getCatalogueView(database: RecallDatabase): CatalogueView {
  const productRows = database
    .select()
    .from(schema.products)
    .orderBy(asc(schema.products.name), asc(schema.products.sku))
    .all();

  if (productRows.length === 0) {
    return {
      summary: {
        totalProducts: 0,
        missingEan: 0,
        missingBatch: 0,
        missingAnyIdentifier: 0
      },
      products: []
    };
  }

  const alertsByProduct = new Map<string, CatalogueAlertLink[]>();
  const casesByProduct = new Map<string, CatalogueCaseLink[]>();

  const matchRows = database
    .select({ match: schema.matches, alert: schema.alerts })
    .from(schema.matches)
    .innerJoin(schema.alerts, eq(schema.alerts.id, schema.matches.alertId))
    .orderBy(desc(schema.matches.totalScore), desc(schema.matches.createdAt))
    .all();

  for (const row of matchRows) {
    const links = alertsByProduct.get(row.match.productId) ?? [];
    links.push({
      alertId: row.alert.id,
      source: row.alert.source,
      sourceReference: row.alert.sourceReference,
      alertStatus: row.alert.status,
      matchStatus: row.match.status,
      totalScore: row.match.totalScore
    });
    alertsByProduct.set(row.match.productId, links);
  }

  const caseRows = database
    .select({
      item: schema.caseItems,
      caseRecord: schema.cases,
      alert: schema.alerts
    })
    .from(schema.caseItems)
    .innerJoin(schema.cases, eq(schema.cases.id, schema.caseItems.caseId))
    .innerJoin(schema.alerts, eq(schema.alerts.id, schema.cases.alertId))
    .orderBy(desc(schema.cases.openedAt))
    .all();

  for (const row of caseRows) {
    const links = casesByProduct.get(row.item.productId) ?? [];
    links.push({
      caseId: row.caseRecord.id,
      caseNumber: row.caseRecord.caseNumber,
      status: row.caseRecord.status,
      sourceReference: row.alert.sourceReference
    });
    casesByProduct.set(row.item.productId, links);
  }

  return {
    summary: {
      totalProducts: productRows.length,
      missingEan: productRows.filter((product) => isMissing(product.ean)).length,
      missingBatch: productRows.filter((product) => isMissing(product.batch)).length,
      missingAnyIdentifier: productRows.filter(
        (product) => isMissing(product.ean) || isMissing(product.batch)
      ).length
    },
    products: productRows.map((product) => ({
      product,
      alerts: alertsByProduct.get(product.id) ?? [],
      cases: casesByProduct.get(product.id) ?? []
    }))
  };
}
