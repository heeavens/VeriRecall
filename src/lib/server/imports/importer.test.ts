import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { count } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import writeExcelFile from 'write-excel-file/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from '../db/client';
import { customers, products, purchases, settings } from '../db/schema';
import { importCatalogue, importPurchases, MAX_UPLOAD_BYTES } from './importer';
import { completeSetup } from './setup';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

let temporaryDirectory: string;
let connection: TestConnection;

function csvFile(contents: string, name = 'catalogue.csv'): File {
  return new File([contents], name, { type: 'text/csv' });
}

function tableCount(table: typeof products): number;
function tableCount(table: typeof customers): number;
function tableCount(table: typeof purchases): number;
function tableCount(table: typeof settings): number;
function tableCount(
  table: typeof products | typeof customers | typeof purchases | typeof settings
): number {
  return connection.db.select({ value: count() }).from(table).get()?.value ?? 0;
}

async function xlsxFile(rows: Array<Array<string | number | null>>): Promise<File> {
  const buffer = await writeExcelFile(rows).toBuffer();
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return new File([bytes], 'catalogue.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'recallops-import-test-'));
  connection = createDatabaseConnection(join(temporaryDirectory, 'recallops.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('Stage 2 catalogue imports', () => {
  it('imports a valid CSV and returns the first five rows as preview', async () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      [
        `SKU-${index + 1}`,
        `Product ${index + 1}`,
        'Demo Brand',
        `53912345678${index + 10}`,
        `B-${index + 1}`,
        String(index)
      ].join(',')
    );
    const file = csvFile(`sku,name,brand,ean,batch,stock_quantity\n${rows.join('\n')}`);

    const result = await importCatalogue(connection.db, file);

    expect(result.success).toBe(true);
    expect(result.summary).toMatchObject({
      totalRows: 6,
      acceptedRows: 6,
      rejectedRows: 0
    });
    expect(result.summary.preview).toHaveLength(5);
    expect(tableCount(products)).toBe(6);
  });

  it('imports a valid XLSX catalogue', async () => {
    const file = await xlsxFile([
      ['sku', 'name', 'brand', 'ean', 'batch', 'stock_quantity'],
      ['XLSX-1', 'Spreadsheet Product', 'Sheet Brand', '5391234567890', 'LOT-1', 14],
      ['XLSX-2', 'Second Product', 'Sheet Brand', null, null, 0]
    ]);

    const result = await importCatalogue(connection.db, file);

    expect(result.success).toBe(true);
    expect(result.summary.acceptedRows).toBe(2);
    expect(connection.db.select().from(products).all()).toHaveLength(2);
  });

  it('reports missing headers without inserting rows', async () => {
    const result = await importCatalogue(
      connection.db,
      csvFile('product_code,name,brand\nSKU-1,Product,Brand')
    );

    expect(result.success).toBe(false);
    expect(result.summary.errors[0]?.message).toContain('Missing required headers: sku');
    expect(tableCount(products)).toBe(0);
  });

  it('reports every duplicate SKU row and rejects the whole file', async () => {
    const result = await importCatalogue(
      connection.db,
      csvFile('sku,name,brand\nDUP-1,First,Brand\ndup-1,Second,Brand')
    );

    expect(result.success).toBe(false);
    expect(result.summary.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 2, message: expect.stringContaining('rows 2, 3') }),
        expect.objectContaining({ row: 3, message: expect.stringContaining('rows 2, 3') })
      ])
    );
    expect(tableCount(products)).toBe(0);
  });

  it('does not leave a valid prefix behind when a later row is invalid', async () => {
    const result = await importCatalogue(
      connection.db,
      csvFile('sku,name,brand,stock_quantity\nOK-1,Valid,Brand,7\nBAD-2,,Brand,-1')
    );

    expect(result.success).toBe(false);
    expect(result.summary.acceptedRows).toBe(0);
    expect(result.summary.rejectedRows).toBe(2);
    expect(result.summary.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ row: 3, field: 'name' })])
    );
    expect(tableCount(products)).toBe(0);
  });

  it('enforces the 5 MB and 5,000 row limits', async () => {
    const oversized = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'large.csv');
    const tooManyRows = csvFile(
      `sku,name,brand\n${Array.from({ length: 5_001 }, (_, index) => `SKU-${index},Name,Brand`).join('\n')}`
    );

    const sizeResult = await importCatalogue(connection.db, oversized);
    const rowResult = await importCatalogue(connection.db, tooManyRows);

    expect(sizeResult.success).toBe(false);
    expect(sizeResult.summary.errors[0]?.message).toContain('5 MB');
    expect(rowResult.success).toBe(false);
    expect(rowResult.summary.errors[0]?.message).toContain('limit is 5,000');
    expect(tableCount(products)).toBe(0);
  });
});

describe('Stage 2 purchase imports and setup', () => {
  beforeEach(async () => {
    await importCatalogue(
      connection.db,
      csvFile('sku,name,brand,batch\nSKU-1,Product,Brand,BATCH-1')
    );
  });

  it('imports optional customer purchases and reuses a customer within the file', async () => {
    const file = csvFile(
      [
        'customer_id,customer_name,email,sku,batch,purchased_at,quantity',
        'C-1,Demo Customer,demo@example.test,SKU-1,BATCH-1,2026-08-10,1',
        'C-1,Demo Customer,demo@example.test,SKU-1,BATCH-1,2026-08-11,2'
      ].join('\n'),
      'purchases.csv'
    );

    const result = await importPurchases(connection.db, file);

    expect(result.success).toBe(true);
    expect(tableCount(customers)).toBe(1);
    expect(tableCount(purchases)).toBe(2);
  });

  it('rejects all purchase rows when any SKU is unknown', async () => {
    const file = csvFile(
      [
        'customer_id,sku,purchased_at',
        'C-1,SKU-1,2026-08-10',
        'C-2,MISSING-SKU,2026-08-11'
      ].join('\n'),
      'purchases.csv'
    );

    const result = await importPurchases(connection.db, file);

    expect(result.success).toBe(false);
    expect(result.summary.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ row: 3, message: expect.stringContaining('not found') })])
    );
    expect(tableCount(customers)).toBe(0);
    expect(tableCount(purchases)).toBe(0);
  });

  it('persists the selected confidence threshold and completes onboarding', () => {
    completeSetup(connection.db, 92);

    expect(connection.db.select().from(settings).get()).toMatchObject({
      confidenceThreshold: 92,
      reviewFloor: 55,
      onboardingCompleted: true
    });
  });
});
