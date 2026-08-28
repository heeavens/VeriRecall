import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getAlertDetail, getDashboardView } from '../alerts/queries';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { products, settings } from '../db/schema';
import { runMonitoringCycle } from './monitoring';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

let temporaryDirectory: string;
let connection: TestConnection;

function tableCount(tableName: string): number {
  const row = connection.sqlite.prepare(`select count(*) as value from ${tableName}`).get() as {
    value: number;
  };
  return row.value;
}

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'recallops-monitoring-test-'));
  connection = createDatabaseConnection(join(temporaryDirectory, 'recallops.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });

  const fixtures = loadDemoFixtures();
  connection.db.insert(settings).values(fixtures.settings).run();
  connection.db.insert(products).values(fixtures.products).run();
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('Stage 3 monitoring workflow', () => {
  it('imports and classifies all three scenarios with top-3 candidates', async () => {
    const summary = await runMonitoringCycle(connection.db);

    expect(summary).toEqual({ imported: 3, matched: 1, review: 1, ignored: 1 });
    expect(tableCount('alerts')).toBe(3);
    expect(tableCount('matches')).toBe(9);
    expect(tableCount('cases')).toBe(1);
    expect(tableCount('case_items')).toBe(1);

    const statuses = connection.sqlite
      .prepare('select status, count(*) as value from alerts group by status order by status')
      .all();
    expect(statuses).toEqual([
      { status: 'matched', value: 1 },
      { status: 'needs_review', value: 1 },
      { status: 'not_relevant', value: 1 }
    ]);

    const dashboard = getDashboardView(connection.db);
    expect(new Set(dashboard.alerts.map((item) => item.status))).toEqual(
      new Set(['matched', 'needs_review', 'not_relevant'])
    );
    expect(dashboard.counters.waitingForReview).toBe(1);
    expect(dashboard.counters.openCases).toBe(1);

    const matchedAlert = dashboard.alerts.find((item) => item.status === 'matched');
    expect(matchedAlert?.bestMatch?.product.sku).toBe('TOY-1042');
    const detail = matchedAlert ? getAlertDetail(connection.db, matchedAlert.id) : null;
    expect(detail?.candidates).toHaveLength(3);
    expect(detail?.candidates[0].product.sku).toBe('TOY-1042');
  });

  it('does not duplicate alerts, matches or cases on a repeated cycle', async () => {
    await runMonitoringCycle(connection.db);
    const firstCounts = {
      alerts: tableCount('alerts'),
      matches: tableCount('matches'),
      cases: tableCount('cases'),
      caseItems: tableCount('case_items'),
      auditEvents: tableCount('audit_events')
    };

    const repeatedSummary = await runMonitoringCycle(connection.db);

    expect(repeatedSummary).toEqual({ imported: 0, matched: 0, review: 0, ignored: 0 });
    expect({
      alerts: tableCount('alerts'),
      matches: tableCount('matches'),
      cases: tableCount('cases'),
      caseItems: tableCount('case_items'),
      auditEvents: tableCount('audit_events')
    }).toEqual(firstCounts);
  });
});
