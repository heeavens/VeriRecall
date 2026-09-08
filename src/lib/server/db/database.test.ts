import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from './client';
import { loadDemoFixtures } from './demo-fixtures';
import { getDemoStateSummary, seedDemoData } from './repositories';
import { alerts, cases, products } from './schema';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

let temporaryDirectory: string;
let connection: TestConnection;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'recallops-db-test-'));
  connection = createDatabaseConnection(join(temporaryDirectory, 'recallops.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('Stage 1 database', () => {
  it('migrates every P0 table into a new empty database', () => {
    const tableNames = connection.sqlite
      .prepare("select name from sqlite_master where type = 'table'")
      .pluck()
      .all() as string[];

    expect(tableNames).toEqual(
      expect.arrayContaining([
        'settings',
        'products',
        'customers',
        'purchases',
        'alerts',
        'matches',
        'cases',
        'case_items',
        'case_tasks',
        'evidence_requests',
        'action_drafts',
        'audit_events',
        'case_lifecycle',
        'case_revisions',
        'case_commands',
        'investigation_evidence',
        'traceability_records'
      ])
    );

    const indexNames = connection.sqlite
      .prepare("select name from sqlite_master where type = 'index'")
      .pluck()
      .all() as string[];

    expect(indexNames).toEqual(
      expect.arrayContaining([
        'products_sku_unique',
        'customers_external_id_unique',
        'alerts_source_reference_unique',
        'cases_alert_id_unique',
        'products_ean_idx',
        'products_normalized_brand_idx',
        'matches_alert_id_idx',
        'cases_status_idx',
        'audit_events_case_id_idx',
        'case_items_case_product_batch_unique',
        'case_tasks_case_type_unique',
        'evidence_requests_case_question_created_idx',
        'investigation_evidence_case_idx',
        'traceability_records_source_unique',
        'traceability_records_case_idx'
      ])
    );
  });

  it('enforces evidence source, content and integrity constraints in SQLite', () => {
    const fixtures = loadDemoFixtures();
    seedDemoData(connection.db, fixtures);
    const caseId = '60000000-0000-4000-8000-000000000001';
    connection.db.insert(cases).values({
      id: caseId,
      caseNumber: 'CASE-EVIDENCE-CONSTRAINTS',
      alertId: fixtures.alerts[0].id,
      status: 'open',
      severity: 'high',
      openedAt: '2026-09-08T12:00:00.000Z',
      closedAt: null
    }).run();

    const requestInsert = connection.sqlite.prepare(`
      insert into evidence_requests (
        id, match_id, case_id, question_ref, requested_evidence,
        recipient, status, created_at, resolved_at
      ) values (?, ?, ?, ?, '["batch_label_photo"]', null, 'pending', ?, null)
    `);
    expect(() => requestInsert.run(
      '90000000-0000-4000-8000-000000000091',
      fixtures.matches[0].id,
      caseId,
      null,
      '2026-09-08T12:00:00.000Z'
    )).toThrow(/evidence_requests_versioned_question_check/);
    expect(() => requestInsert.run(
      '90000000-0000-4000-8000-000000000092',
      fixtures.matches[0].id,
      null,
      'demo:scope-gap:test',
      '2026-09-08T12:00:00.000Z'
    )).toThrow(/evidence_requests_versioned_question_check/);

    const insert = connection.sqlite.prepare(`
      insert into investigation_evidence (
        evidence_ref, case_id, question_ref, evidence_request_id,
        source_kind, source_identifier, received_at, valid_as_of,
        content_kind, content_json, content_locator, integrity_hash, demo
      ) values (?, ?, ?, null, ?, ?, ?, null, ?, ?, ?, ?, 1)
    `);
    const common = [
      caseId,
      'question:identity:ean',
      'source:constraint-test',
      '2026-09-08T12:00:00.000Z'
    ] as const;

    expect(() => insert.run(
      'evidence:invalid-source', common[0], common[1], 'AI_EXTRACTED', common[2], common[3],
      'STRUCTURED', '{}', null, 'a'.repeat(64)
    )).toThrow(/investigation_evidence_source_kind_check/);
    expect(() => insert.run(
      'evidence:invalid-content', common[0], common[1], 'REGULATOR', common[2], common[3],
      'STRUCTURED', null, 'object-store:\/\/unexpected', 'a'.repeat(64)
    )).toThrow(/investigation_evidence_content_check/);
    expect(() => insert.run(
      'evidence:invalid-hash', common[0], common[1], 'REGULATOR', common[2], common[3],
      'STRUCTURED', '{}', null, 'not-a-content-hash'
    )).toThrow(/investigation_evidence_integrity_hash_check/);
  });

  it('seeds deterministically and preserves all three demo scenarios', () => {
    const fixtures = loadDemoFixtures();

    seedDemoData(connection.db, fixtures);
    const firstSummary = getDemoStateSummary(connection.db);
    seedDemoData(connection.db, fixtures);
    const secondSummary = getDemoStateSummary(connection.db);

    expect(secondSummary).toEqual(firstSummary);
    expect(secondSummary).toEqual({
      settings: 1,
      products: 15,
      customers: 7,
      purchases: 8,
      alerts: 3,
      matches: 3,
      cases: 0,
      scenarios: {
        highConfidence: 1,
        uncertain: 1,
        notRelevant: 1
      }
    });

    const scenarios = connection.sqlite
      .prepare(
        `select alerts.status as alertStatus,
                matches.status as matchStatus,
                matches.has_hard_conflict as hasHardConflict,
                cases.id as caseId
           from alerts
           join matches on matches.alert_id = alerts.id
      left join cases on cases.alert_id = alerts.id
       order by alerts.status`
      )
      .all() as Array<{
      alertStatus: string;
      matchStatus: string;
      hasHardConflict: number;
      caseId: string | null;
    }>;

    expect(scenarios).toEqual([
      {
        alertStatus: 'needs_review',
        matchStatus: 'candidate',
        hasHardConflict: 0,
        caseId: null
      },
      {
        alertStatus: 'needs_review',
        matchStatus: 'candidate',
        hasHardConflict: 1,
        caseId: null
      },
      {
        alertStatus: 'not_relevant',
        matchStatus: 'candidate',
        hasHardConflict: 0,
        caseId: null
      }
    ]);
  });

  it('rejects duplicate product SKUs and source references', () => {
    const fixtures = loadDemoFixtures();
    seedDemoData(connection.db, fixtures);

    expect(() =>
      connection.db
        .insert(products)
        .values({
          ...fixtures.products[0],
          id: '10000000-0000-4000-8000-000000000099'
        })
        .run()
    ).toThrow(/UNIQUE constraint failed: products\.sku/);

    expect(() =>
      connection.db
        .insert(alerts)
        .values({
          ...fixtures.alerts[0],
          id: '40000000-0000-4000-8000-000000000099'
        })
        .run()
    ).toThrow(/UNIQUE constraint failed: alerts\.source, alerts\.source_reference/);

    expect(() =>
      connection.sqlite
        .prepare("update alerts set status = 'invalid_status' where id = ?")
        .run(fixtures.alerts[0].id)
    ).toThrow(/CHECK constraint failed: alerts_status_check/);
  });
});
