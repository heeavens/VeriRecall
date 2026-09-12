import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';

import { reserveInvestigationCase } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import { createDatabaseConnection } from './client';
import { loadDemoFixtures } from './demo-fixtures';
import { seedDemoData } from './repositories';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Commit 17 additive migration', () => {
  it('migrates an empty database and enforces restrictive provenance ownership', () => {
    const directory = mkdtempSync(join(tmpdir(), 'verirecall-empty-0016-'));
    temporaryDirectories.push(directory);
    const connection = createDatabaseConnection(join(directory, 'empty.db'));
    try {
      migrate(connection.db, { migrationsFolder: resolve('drizzle') });
      const tables = connection.sqlite.prepare(
        "select name from sqlite_master where type = 'table' and name like 'alert_%' order by name"
      ).all() as Array<{ name: string }>;
      expect(tables.map((item) => item.name)).toEqual(expect.arrayContaining([
        'alert_field_assertions',
        'alert_match_bases',
        'alert_source_observations'
      ]));
      expect(() => connection.sqlite.prepare(`
        insert into alert_source_observations (
          observation_ref, alert_id, record_kind, source, provider, source_reference,
          source_url, source_version_identifier, predecessor_observation_ref,
          payload_format, raw_payload, content_sha256, published_at, source_updated_at,
          observed_at, demo
        ) values (?, ?, 'RAW_SOURCE', 'safety_gate', 'demo_archive', 'FOREIGN',
          'https://example.test/foreign', 'sha256:test', null, 'application/json', '{}',
          ?, '2026-09-12T00:00:00.000Z', null, '2026-09-12T01:00:00.000Z', 1)
      `).run('demo:foreign-observation', '00000000-0000-4000-8000-000000000099', 'a'.repeat(64)))
        .toThrow(/FOREIGN KEY constraint failed/);
      expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      connection.sqlite.close();
    }
  });

  it('migrates a populated 0015 database without trusting or changing legacy business rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'verirecall-populated-0015-'));
    temporaryDirectories.push(directory);
    const priorMigrations = join(directory, 'drizzle-0015');
    mkdirSync(join(priorMigrations, 'meta'), { recursive: true });
    for (const fileName of readdirSync('drizzle').filter((name) => /^\d{4}_.+\.sql$/.test(name) && name <= '0015_zzzz.sql')) {
      cpSync(join('drizzle', fileName), join(priorMigrations, fileName));
    }
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: unknown[];
    };
    journal.entries = journal.entries.slice(0, 16);
    writeFileSync(join(priorMigrations, 'meta/_journal.json'), JSON.stringify(journal));

    const connection = createDatabaseConnection(join(directory, 'populated.db'));
    try {
      migrate(connection.db, { migrationsFolder: priorMigrations });
      const fixtures = loadDemoFixtures();
      seedDemoData(connection.db, fixtures);
      const reserved = reserveInvestigationCase(
        connection.db,
        { alertId: fixtures.alerts[0].id, productId: fixtures.products[0].id },
        { mode: 'demo' },
        new Date('2026-09-12T08:00:00.000Z')
      );
      if (!reserved.ok) throw new Error(reserved.error.message);
      const before = {
        alerts: connection.sqlite.prepare('select * from alerts order by id').all(),
        matches: connection.sqlite.prepare('select * from matches order by id').all(),
        cases: connection.sqlite.prepare('select * from cases order by id').all(),
        revisions: connection.sqlite.prepare('select * from case_revisions order by case_version').all()
      };

      migrate(connection.db, { migrationsFolder: resolve('drizzle') });

      expect({
        alerts: connection.sqlite.prepare('select * from alerts order by id').all(),
        matches: connection.sqlite.prepare('select * from matches order by id').all(),
        cases: connection.sqlite.prepare('select * from cases order by id').all(),
        revisions: connection.sqlite.prepare('select * from case_revisions order by case_version').all()
      }).toEqual(before);
      expect(connection.sqlite.prepare('select count(*) as value from alert_source_observations').get())
        .toEqual({ value: 0 });
      expect(connection.sqlite.prepare('select count(*) as value from alert_field_assertions').get())
        .toEqual({ value: 0 });
      expect(connection.sqlite.prepare('select count(*) as value from alert_match_bases').get())
        .toEqual({ value: 0 });
      expect(() => confirmReviewMatch(
        connection.db,
        { matchId: fixtures.matches[1].id, actorName: 'Herman' },
        new Date('2026-09-12T09:00:00.000Z'),
        { mode: 'demo' }
      )).toThrow(/no immutable provenance basis/);
      expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      connection.sqlite.close();
    }
  });
});
