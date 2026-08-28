import { count } from 'drizzle-orm';
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
    transaction.insert(schema.cases).values(fixtures.cases).onConflictDoNothing().run();
    transaction.insert(schema.caseItems).values(fixtures.caseItems).onConflictDoNothing().run();
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

  return {
    settings: database.select({ value: count() }).from(schema.settings).get()?.value ?? 0,
    products: database.select({ value: count() }).from(schema.products).get()?.value ?? 0,
    customers: database.select({ value: count() }).from(schema.customers).get()?.value ?? 0,
    purchases: database.select({ value: count() }).from(schema.purchases).get()?.value ?? 0,
    alerts: database.select({ value: count() }).from(schema.alerts).get()?.value ?? 0,
    matches: database.select({ value: count() }).from(schema.matches).get()?.value ?? 0,
    cases: database.select({ value: count() }).from(schema.cases).get()?.value ?? 0,
    scenarios: {
      highConfidence: statusCount('matched'),
      uncertain: statusCount('needs_review'),
      notRelevant: statusCount('not_relevant')
    }
  };
}

export function clearDemoData(database: RecallDatabase): void {
  database.transaction((transaction) => {
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
    transaction.insert(schema.cases).values(fixtures.cases).run();
    transaction.insert(schema.caseItems).values(fixtures.caseItems).run();
  });
}
