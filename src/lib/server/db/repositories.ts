import { count, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema';
import type { DemoFixtures } from './demo-fixtures';

export type RecallDatabase = BetterSQLite3Database<typeof schema>;

export interface DemoStateSummary {
  settings: number;
  products: number;
  customers: number;
  purchases: number;
  alerts: number;
  matches: number;
  cases: number;
  scenarios: {
    highConfidence: number;
    uncertain: number;
    notRelevant: number;
  };
}

export function seedDemoData(database: RecallDatabase, fixtures: DemoFixtures): void {
  database.transaction((transaction) => {
    transaction.insert(schema.settings).values(fixtures.settings).onConflictDoNothing().run();
    transaction.insert(schema.products).values(fixtures.products).onConflictDoNothing().run();
    transaction.insert(schema.customers).values(fixtures.customers).onConflictDoNothing().run();
    transaction.insert(schema.purchases).values(fixtures.purchases).onConflictDoNothing().run();
    transaction.insert(schema.alerts).values(fixtures.alerts).onConflictDoNothing().run();
    transaction.insert(schema.matches).values(fixtures.matches).onConflictDoNothing().run();
    if (fixtures.cases.length) {
      transaction.insert(schema.cases).values(fixtures.cases).onConflictDoNothing().run();
    }
    if (fixtures.caseItems.length) {
      transaction.insert(schema.caseItems).values(fixtures.caseItems).onConflictDoNothing().run();
    }
    if (fixtures.caseTasks.length) {
      transaction.insert(schema.caseTasks).values(fixtures.caseTasks).onConflictDoNothing().run();
    }
    if (fixtures.actionDrafts.length) {
      transaction.insert(schema.actionDrafts).values(fixtures.actionDrafts).onConflictDoNothing().run();
    }
    if (fixtures.auditEvents.length) {
      transaction.insert(schema.auditEvents).values(fixtures.auditEvents).onConflictDoNothing().run();
    }
  });
}

export function getDemoStateSummary(database: RecallDatabase): DemoStateSummary {
  const statusCounts = database
    .select({ status: schema.alerts.status, value: count() })
    .from(schema.alerts)
    .groupBy(schema.alerts.status)
    .all();

  const statusCount = (status: (typeof schema.alerts.$inferSelect)['status']): number =>
    statusCounts.find((row) => row.status === status)?.value ?? 0;
  const threshold = database.select().from(schema.settings).get()?.confidenceThreshold ?? 85;
  const reviewMatches = database
    .select({ alertId: schema.matches.alertId, match: schema.matches })
    .from(schema.matches)
    .innerJoin(schema.alerts, eq(schema.alerts.id, schema.matches.alertId))
    .where(eq(schema.alerts.status, 'needs_review'))
    .all();
  const bestReviewMatches = new Map<string, typeof schema.matches.$inferSelect>();
  for (const row of reviewMatches) {
    const current = bestReviewMatches.get(row.alertId);
    if (!current || row.match.totalScore > current.totalScore) {
      bestReviewMatches.set(row.alertId, row.match);
    }
  }
  const highConfidence = [...bestReviewMatches.values()].filter(
    (match) => match.totalScore >= threshold && !match.hasHardConflict
  ).length;

  return {
    settings: database.select({ value: count() }).from(schema.settings).get()?.value ?? 0,
    products: database.select({ value: count() }).from(schema.products).get()?.value ?? 0,
    customers: database.select({ value: count() }).from(schema.customers).get()?.value ?? 0,
    purchases: database.select({ value: count() }).from(schema.purchases).get()?.value ?? 0,
    alerts: database.select({ value: count() }).from(schema.alerts).get()?.value ?? 0,
    matches: database.select({ value: count() }).from(schema.matches).get()?.value ?? 0,
    cases: database.select({ value: count() }).from(schema.cases).get()?.value ?? 0,
    scenarios: {
      highConfidence,
      uncertain: statusCount('needs_review') - highConfidence,
      notRelevant: statusCount('not_relevant')
    }
  };
}

export function clearDemoData(database: RecallDatabase): void {
  database.transaction((transaction) => {
    transaction.delete(schema.investigationAssessments).run();
    transaction.delete(schema.investigationClaims).run();
    transaction.delete(schema.investigationEvidence).run();
    transaction.delete(schema.auditEvents).run();
    transaction.delete(schema.actionDrafts).run();
    transaction.delete(schema.evidenceRequests).run();
    transaction.delete(schema.caseTasks).run();
    transaction.delete(schema.caseItems).run();
    transaction.delete(schema.cases).run();
    transaction.delete(schema.matches).run();
    transaction.delete(schema.alerts).run();
    transaction.delete(schema.purchases).run();
    transaction.delete(schema.customers).run();
    transaction.delete(schema.products).run();
    transaction.delete(schema.settings).run();
  });
}

export function replaceWithDemoData(database: RecallDatabase, fixtures: DemoFixtures): void {
  database.transaction((transaction) => {
    transaction.delete(schema.investigationAssessments).run();
    transaction.delete(schema.investigationClaims).run();
    transaction.delete(schema.investigationEvidence).run();
    transaction.delete(schema.auditEvents).run();
    transaction.delete(schema.actionDrafts).run();
    transaction.delete(schema.evidenceRequests).run();
    transaction.delete(schema.caseTasks).run();
    transaction.delete(schema.caseItems).run();
    transaction.delete(schema.cases).run();
    transaction.delete(schema.matches).run();
    transaction.delete(schema.alerts).run();
    transaction.delete(schema.purchases).run();
    transaction.delete(schema.customers).run();
    transaction.delete(schema.products).run();
    transaction.delete(schema.settings).run();

    transaction.insert(schema.settings).values(fixtures.settings).run();
    transaction.insert(schema.products).values(fixtures.products).run();
    transaction.insert(schema.customers).values(fixtures.customers).run();
    transaction.insert(schema.purchases).values(fixtures.purchases).run();
    transaction.insert(schema.alerts).values(fixtures.alerts).run();
    transaction.insert(schema.matches).values(fixtures.matches).run();
    if (fixtures.cases.length) transaction.insert(schema.cases).values(fixtures.cases).run();
    if (fixtures.caseItems.length) {
      transaction.insert(schema.caseItems).values(fixtures.caseItems).run();
    }
    if (fixtures.caseTasks.length) {
      transaction.insert(schema.caseTasks).values(fixtures.caseTasks).run();
    }
    if (fixtures.actionDrafts.length) {
      transaction.insert(schema.actionDrafts).values(fixtures.actionDrafts).run();
    }
    if (fixtures.auditEvents.length) {
      transaction.insert(schema.auditEvents).values(fixtures.auditEvents).run();
    }
  });
}
