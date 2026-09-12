import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';

import { confirmReviewMatch } from '../workflow/review';
import { createDatabaseConnection } from './client';
import { loadDemoFixtures } from './demo-fixtures';
import { clearDemoData, seedDemoData } from './repositories';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Commit 18 additive Investigator migration', () => {
  it('migrates an empty database with restrictive ledger ownership', () => {
    const directory = mkdtempSync(join(tmpdir(), 'verirecall-empty-0017-'));
    temporaryDirectories.push(directory);
    const connection = createDatabaseConnection(join(directory, 'empty.db'));
    try {
      migrate(connection.db, { migrationsFolder: resolve('drizzle') });
      const tables = connection.sqlite.prepare(
        "select name from sqlite_master where type = 'table' and name like 'investigation_investigator_%' order by name"
      ).all() as Array<{ name: string }>;
      expect(tables.map((item) => item.name)).toEqual([
        'investigation_investigator_recommendation_events',
        'investigation_investigator_recommendations'
      ]);
      expect(() => connection.sqlite.prepare(`
        insert into investigation_investigator_recommendation_events (
          event_ref, recommendation_ref, event_kind, linked_artifact_kind,
          linked_artifact_ref, supporting_evidence_refs_json, rationale, actor_kind,
          actor_identifier, basis_case_version, basis_material_revision, created_at, demo
        ) values (?, ?, 'DISMISSED', null, null, '[]', 'Human dismissal', 'HUMAN',
          'demo_operator', 1, 1, '2026-09-12T00:00:00.000Z', 1)
      `).run(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001'
      )).toThrow(/FOREIGN KEY constraint failed/);
      expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      connection.sqlite.close();
    }
  });

  it('migrates populated 0016 state without changing authority or inventing recommendations', () => {
    const directory = mkdtempSync(join(tmpdir(), 'verirecall-populated-0016-'));
    temporaryDirectories.push(directory);
    const priorMigrations = join(directory, 'drizzle-0016');
    mkdirSync(join(priorMigrations, 'meta'), { recursive: true });
    for (const fileName of readdirSync('drizzle').filter((name) =>
      /^\d{4}_.+\.sql$/.test(name) && name <= '0016_zzzz.sql'
    )) {
      cpSync(join('drizzle', fileName), join(priorMigrations, fileName));
    }
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: unknown[];
    };
    journal.entries = journal.entries.slice(0, 17);
    writeFileSync(join(priorMigrations, 'meta/_journal.json'), JSON.stringify(journal));

    const connection = createDatabaseConnection(join(directory, 'populated.db'));
    try {
      migrate(connection.db, { migrationsFolder: priorMigrations });
      const fixtures = loadDemoFixtures();
      seedDemoData(connection.db, fixtures);
      confirmReviewMatch(connection.db, {
        matchId: '50000000-0000-4000-8000-000000000002',
        actorName: 'demo_operator'
      }, new Date('2026-09-12T09:00:00.000Z'), { mode: 'demo' });
      const tables = [
        'alerts', 'alert_source_observations', 'alert_field_assertions', 'alert_match_bases',
        'cases', 'case_revisions', 'investigation_questions', 'investigation_evidence',
        'investigation_claims', 'investigation_assessments'
      ];
      const before = Object.fromEntries(tables.map((table) => [
        table,
        connection.sqlite.prepare(`select * from ${table} order by 1`).all()
      ]));

      migrate(connection.db, { migrationsFolder: resolve('drizzle') });

      const after = Object.fromEntries(tables.map((table) => [
        table,
        connection.sqlite.prepare(`select * from ${table} order by 1`).all()
      ]));
      expect(after).toEqual(before);
      expect(connection.sqlite.prepare(
        'select count(*) as value from investigation_investigator_recommendations'
      ).get()).toEqual({ value: 0 });
      expect(connection.sqlite.prepare(
        'select count(*) as value from investigation_investigator_recommendation_events'
      ).get()).toEqual({ value: 0 });
      const caseRow = connection.sqlite.prepare('select id from cases limit 1').get() as { id: string };
      const questionRow = connection.sqlite.prepare(
        'select question_ref as questionRef from investigation_questions limit 1'
      ).get() as { questionRef: string };
      const insertRecommendation = connection.sqlite.prepare(`
        insert into investigation_investigator_recommendations (
          recommendation_ref, case_id, question_ref, context_challenge_ref, context_kind,
          case_version, material_revision, snapshot_format_version, policy_identifier,
          policy_version, basis_json, basis_digest, recommendation_kind, recommendation_json,
          recommendation_digest, action_key, provider_identifier, client_identifier,
          model_identifier, prompt_policy_version, generated_at, demo
        ) values (?, ?, ?, ?, ?, 1, 1, 1, 'test-policy', 1, '{}', ?,
          'REQUEST_EVIDENCE', '{}', ?, ?, 'test-provider', 'test-client', 'test-model',
          'v1', '2026-09-12T10:00:00.000Z', 1)
      `);
      const digest = `sha256:${'a'.repeat(64)}`;
      expect(() => insertRecommendation.run(
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001', questionRow.questionRef,
        null, 'OPEN_GAP', digest, digest, digest
      )).toThrow(/FOREIGN KEY constraint failed/);
      expect(() => insertRecommendation.run(
        '10000000-0000-4000-8000-000000000002',
        caseRow.id, 'foreign:question', null, 'OPEN_GAP', digest, digest, digest
      )).toThrow(/FOREIGN KEY constraint failed/);
      expect(() => insertRecommendation.run(
        '10000000-0000-4000-8000-000000000003',
        caseRow.id, questionRow.questionRef, '30000000-0000-4000-8000-000000000001',
        'OPEN_CHALLENGE', digest, digest, digest
      )).toThrow(/FOREIGN KEY constraint failed/);
      expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);

      insertRecommendation.run(
        '10000000-0000-4000-8000-000000000004',
        caseRow.id, questionRow.questionRef, null, 'OPEN_GAP', digest, digest, digest
      );
      connection.sqlite.prepare(`
        insert into investigation_investigator_recommendation_events (
          event_ref, recommendation_ref, event_kind, linked_artifact_kind,
          linked_artifact_ref, supporting_evidence_refs_json, rationale, actor_kind,
          actor_identifier, basis_case_version, basis_material_revision, created_at, demo
        ) values (?, ?, 'DISMISSED', null, null, '[]', 'Human dismissal', 'HUMAN',
          'demo_operator', 1, 1, '2026-09-12T10:01:00.000Z', 1)
      `).run(
        '40000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000004'
      );
      expect(() => clearDemoData(connection.db)).not.toThrow();
      expect(connection.sqlite.prepare(
        'select count(*) as value from investigation_investigator_recommendations'
      ).get()).toEqual({ value: 0 });
    } finally {
      connection.sqlite.close();
    }
  });
});
