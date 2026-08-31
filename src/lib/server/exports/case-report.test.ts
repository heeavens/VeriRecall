import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import { auditEvents, products } from '../db/schema';
import { confirmReviewMatch } from '../workflow/review';
import {
  CaseReportError,
  CaseReportExporter,
  protectSpreadsheetValue
} from './case-report';

let temporaryDirectory: string;
let connection: ReturnType<typeof createDatabaseConnection>;
let caseId: string;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'recallops-report-test-'));
  connection = createDatabaseConnection(join(temporaryDirectory, 'recallops.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  const fixtures = loadDemoFixtures();
  seedDemoData(connection.db, fixtures);
  caseId = confirmReviewMatch(connection.db, {
    matchId: '50000000-0000-4000-8000-000000000001',
    actorName: 'Herman'
  }).caseId;
  const productId = fixtures.matches[0]?.productId ?? '';
  connection.db
    .update(products)
    .set({ name: '=HYPERLINK("https://invalid.test")' })
    .where(eq(products.id, productId))
    .run();
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('Stage 6 case reports', () => {
  it('protects all spreadsheet formula prefixes', () => {
    expect(['=1+1', '+SUM(A1)', '-2+3', '@IMPORT', '  =HIDDEN'].map(protectSpreadsheetValue)).toEqual([
      "'=1+1",
      "'+SUM(A1)",
      "'-2+3",
      "'@IMPORT",
      "'  =HIDDEN"
    ]);
    expect(protectSpreadsheetValue('Safe value')).toBe('Safe value');
  });

  it('exports a complete protected CSV and a loadable PDF', async () => {
    const generatedAt = '2026-08-29T10:00:00.000Z';
    const exporter = new CaseReportExporter(connection.db, () => generatedAt);

    const csvBytes = await exporter.exportCase(caseId, 'csv');
    const csv = new TextDecoder().decode(csvBytes);
    expect(csv).toContain('Case summary');
    expect(csv).toContain('Official alert');
    expect(csv).toContain('Decision');
    expect(csv).toContain('Affected products');
    expect(csv).toContain('Affected customers');
    expect(csv).toContain('Actions');
    expect(csv).toContain('Audit timeline');
    expect(csv).toContain("'=HYPERLINK");

    const pdfBytes = await exporter.exportCase(caseId, 'pdf');
    expect(new TextDecoder().decode(pdfBytes.slice(0, 8))).toContain('%PDF');
    const document = await PDFDocument.load(pdfBytes);
    expect(document.getPageCount()).toBeGreaterThan(0);
    expect(document.getTitle()).toContain('case report');

    const exportEvents = connection.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, 'report_exported'))
      .all();
    expect(exportEvents).toHaveLength(2);
    expect(exportEvents.map((event) => event.summary)).toEqual([
      expect.stringContaining('CSV'),
      expect.stringContaining('PDF')
    ]);
  });

  it('does not mutate audit history when export validation fails', async () => {
    const exporter = new CaseReportExporter(connection.db);
    const before = connection.db.select().from(auditEvents).all().length;

    await expect(exporter.exportCase('00000000-0000-4000-8000-000000000000', 'csv')).rejects.toBeInstanceOf(
      CaseReportError
    );
    expect(connection.db.select().from(auditEvents).all()).toHaveLength(before);
  });
});
