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
        confirmed: 0,
        highConfidence: 0,
        needsReview: 0,
        notRelevant: 0,
        lastImportedAt: null,
        catalogueProducts: 0
      },
      attention: [],
      alerts: [],
      evaluation: {
        sampleSize: 0,
        labeledRelevant: 0,
        predictedRelevant: 0,
        truePositives: 0,
        falsePositives: 0,
        falseNegatives: 0,
        precision: null,
        recall: null
      }
    });
  });

  it('groups review, approval and containment work into the action queue', () => {
    const fixtures = loadDemoFixtures();
    seedDemoData(connection.db, fixtures);

    const dashboard = getDashboardView(connection.db);

    expect(dashboard.counters).toEqual({
      waitingForReview: 2,
      pendingApprovals: 0,
      openCases: 0,
      unfinishedCases: 0
    });
    expect(dashboard.archive).toEqual({
      total: 3,
      confirmed: 0,
      highConfidence: 1,
      needsReview: 1,
      notRelevant: 1,
      lastImportedAt: fixtures.alerts[0].createdAt,
      catalogueProducts: fixtures.products.length
    });
    expect(dashboard.attention.map((item) => item.kind)).toEqual(['review', 'review']);
    expect(dashboard.attention.find((item) => item.actionLabel === 'Confirm identity')).toMatchObject({
      href: '/review',
      label: 'High-confidence identity check'
    });
    expect(dashboard.evaluation).toMatchObject({
      precision: 100,
      recall: 100,
      truePositives: 2,
      falsePositives: 0,
      falseNegatives: 0
    });
  });
});
