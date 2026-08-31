import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import { getDashboardView } from './queries';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

let temporaryDirectory: string;
let connection: TestConnection;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'recallops-dashboard-test-'));
  connection = createDatabaseConnection(join(temporaryDirectory, 'recallops.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('dashboard view', () => {
  it('keeps a new workspace useful without claiming that monitoring has run', () => {
    expect(getDashboardView(connection.db)).toEqual({
      counters: {
        waitingForReview: 0,
        pendingApprovals: 0,
        openCases: 0,
        unfinishedCases: 0
      },
      archive: {
        total: 0,
        matched: 0,
        needsReview: 0,
        notRelevant: 0,
        lastImportedAt: null,
        catalogueProducts: 0
      },
      attention: [],
      alerts: []
    });
  });

  it('groups review, approval and containment work into the action queue', () => {
    const fixtures = loadDemoFixtures();
    seedDemoData(connection.db, fixtures);

    const dashboard = getDashboardView(connection.db);

    expect(dashboard.counters).toEqual({
      waitingForReview: 1,
      pendingApprovals: 3,
      openCases: 1,
      unfinishedCases: 1
    });
    expect(dashboard.archive).toEqual({
      total: 3,
      matched: 1,
      needsReview: 1,
      notRelevant: 1,
      lastImportedAt: fixtures.alerts[0].createdAt,
      catalogueProducts: fixtures.products.length
    });
    expect(dashboard.attention.map((item) => item.kind)).toEqual([
      'review',
      'approval',
      'case'
    ]);
    expect(dashboard.attention.find((item) => item.kind === 'review')).toMatchObject({
      href: '/review',
      actionLabel: 'Review match'
    });
    expect(dashboard.attention.find((item) => item.kind === 'approval')).toMatchObject({
      title: '3 approvals need a decision',
      meta: 'No external message has been sent.'
    });
    expect(dashboard.attention.find((item) => item.kind === 'case')).toMatchObject({
      actionLabel: 'Continue case'
    });
  });
});
