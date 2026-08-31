import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import { confirmReviewMatch } from '../workflow/review';
import { getCatalogueView } from './queries';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

let temporaryDirectory: string;
let connection: TestConnection;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'recallops-catalogue-test-'));
  connection = createDatabaseConnection(join(temporaryDirectory, 'recallops.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('catalogue view', () => {
  it('returns an empty data-quality summary for a new workspace', () => {
    expect(getCatalogueView(connection.db)).toEqual({
      summary: {
        totalProducts: 0,
        missingEan: 0,
        missingBatch: 0,
        missingAnyIdentifier: 0
      },
      products: []
    });
  });

  it('summarises imported identifiers and links products to alerts and cases', () => {
    const fixtures = loadDemoFixtures();
    seedDemoData(connection.db, fixtures);
    confirmReviewMatch(connection.db, {
      matchId: '50000000-0000-4000-8000-000000000001',
      actorName: 'Herman'
    });

    const view = getCatalogueView(connection.db);
    const confirmedProductId = fixtures.matches[0].productId;
    const uncertainMatch = fixtures.matches.find((match) => match.hasHardConflict);
    const irrelevantMatch = fixtures.matches.find(
      (match) => match.alertId === fixtures.alerts.find((alert) => alert.status === 'not_relevant')?.id
    );

    expect(view.summary).toEqual({
      totalProducts: fixtures.products.length,
      missingEan: fixtures.products.filter((product) => product.ean === null).length,
      missingBatch: fixtures.products.filter((product) => product.batch === null).length,
      missingAnyIdentifier: fixtures.products.filter(
        (product) => product.ean === null || product.batch === null
      ).length
    });

    expect(view.products.find((item) => item.product.id === confirmedProductId)?.cases[0]).toMatchObject({
      caseNumber: 'CASE-0001',
      status: 'open',
      sourceReference: fixtures.alerts[0].sourceReference
    });
    expect(
      view.products.find((item) => item.product.id === uncertainMatch?.productId)?.alerts[0]
    ).toMatchObject({
      alertStatus: 'needs_review',
      matchStatus: 'candidate',
      totalScore: 44
    });
    expect(
      view.products.find((item) => item.product.id === irrelevantMatch?.productId)?.alerts[0]
    ).toMatchObject({
      alertStatus: 'not_relevant',
      totalScore: 3
    });
  });
});
