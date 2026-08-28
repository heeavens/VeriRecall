import { count, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { loadDemoFixtures } from '../db/demo-fixtures';
import { replaceWithDemoData } from '../db/repositories';
import * as schema from '../db/schema';

type RecallDatabase = BetterSQLite3Database<typeof schema>;

const SETTINGS_ID = '00000000-0000-4000-8000-000000000001';

export interface SetupState {
  confidenceThreshold: number;
  onboardingCompleted: boolean;
  productCount: number;
  customerCount: number;
  purchaseCount: number;
}

function tableCount(database: RecallDatabase, table: typeof schema.products): number;
function tableCount(database: RecallDatabase, table: typeof schema.customers): number;
function tableCount(database: RecallDatabase, table: typeof schema.purchases): number;
function tableCount(
  database: RecallDatabase,
  table: typeof schema.products | typeof schema.customers | typeof schema.purchases
): number {
  return database.select({ value: count() }).from(table).get()?.value ?? 0;
}

export function getSetupState(database: RecallDatabase): SetupState {
  const setting = database.select().from(schema.settings).where(eq(schema.settings.id, SETTINGS_ID)).get();

  return {
    confidenceThreshold: setting?.confidenceThreshold ?? 85,
    onboardingCompleted: setting?.onboardingCompleted ?? false,
    productCount: tableCount(database, schema.products),
    customerCount: tableCount(database, schema.customers),
    purchaseCount: tableCount(database, schema.purchases)
  };
}

export function completeSetup(database: RecallDatabase, confidenceThreshold: number): void {
  const now = new Date().toISOString();
  database
    .insert(schema.settings)
    .values({
      id: SETTINGS_ID,
      confidenceThreshold,
      reviewFloor: 55,
      onboardingCompleted: true,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: schema.settings.id,
      set: {
        confidenceThreshold,
        reviewFloor: 55,
        onboardingCompleted: true,
        updatedAt: now
      }
    })
    .run();
}

export function useDemoData(database: RecallDatabase): void {
  replaceWithDemoData(database, loadDemoFixtures());
}
