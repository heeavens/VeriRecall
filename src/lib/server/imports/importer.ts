import { Buffer } from 'node:buffer';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { parse } from 'csv-parse/sync';
import { readSheet } from 'read-excel-file/node';
import { z } from 'zod';

import * as schema from '../db/schema';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5_000;

type RecallDatabase = BetterSQLite3Database<typeof schema>;
type CellValue = string | number | boolean | Date | null;
type ImportRecord = Record<string, string>;

export interface RowError {
  row: number;
  field?: string;
  message: string;
}

export interface ImportSummary {
  fileName: string;
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  preview: Array<Record<string, string | number | null>>;
  errors: RowError[];
}

export type ImportResult =
  | { success: true; summary: ImportSummary }
  | { success: false; summary: ImportSummary };

interface ParsedTable {
  headers: string[];
  rows: Array<{ rowNumber: number; values: string[] }>;
}

interface ValidatedRows<T> {
  records: T[];
  preview: Array<Record<string, string | number | null>>;
  errors: RowError[];
  totalRows: number;
}

interface CatalogueRecord {
  rowNumber: number;
  sku: string;
  name: string;
  brand: string;
  ean: string | null;
  batch: string | null;
  supplierName: string | null;
  supplierEmail: string | null;
  category: string | null;
  stockQuantity: number;
}

interface PurchaseRecord {
  rowNumber: number;
  customerId: string;
  customerName: string | null;
  email: string | null;
  sku: string;
  batch: string | null;
  purchasedAt: string;
  quantity: number;
}

function isIsoDate(value: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value
    ) && !Number.isNaN(Date.parse(value))
  );
}

const catalogueHeaders = [
  'sku',
  'name',
  'brand',
  'ean',
  'batch',
  'supplier_name',
  'supplier_email',
  'category',
  'stock_quantity'
] as const;

const purchaseHeaders = [
  'customer_id',
  'customer_name',
  'email',
  'sku',
  'batch',
  'purchased_at',
  'quantity'
] as const;

const nullableText = (maximumLength: number) =>
  z
    .string()
    .trim()
    .max(maximumLength)
    .transform((value) => (value.length === 0 ? null : value));

const catalogueRowSchema = z.object({
  sku: z.string().trim().min(1, 'SKU is required').max(100, 'SKU must be 100 characters or fewer'),
  name: z
    .string()
    .trim()
    .min(1, 'Product name is required')
    .max(250, 'Product name must be 250 characters or fewer'),
  brand: z
    .string()
    .trim()
    .min(1, 'Brand is required')
    .max(120, 'Brand must be 120 characters or fewer'),
  ean: nullableText(32).refine(
    (value) => value === null || /^\d{8,18}$/.test(value),
    'EAN must contain 8 to 18 digits'
  ),
  batch: nullableText(100),
  supplier_name: nullableText(200),
  supplier_email: z
    .string()
    .trim()
    .max(254, 'Supplier email must be 254 characters or fewer')
    .refine((value) => value.length === 0 || z.string().email().safeParse(value).success, {
      message: 'Supplier email must be a valid email address'
    })
    .transform((value) => (value.length === 0 ? null : value)),
  category: nullableText(120),
  stock_quantity: z
    .string()
    .trim()
    .transform((value) => (value.length === 0 ? '0' : value))
    .refine((value) => /^\d+$/.test(value), 'Stock quantity must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(0).max(1_000_000_000))
});

const purchaseRowSchema = z.object({
  customer_id: z
    .string()
    .trim()
    .min(1, 'Customer ID is required')
    .max(100, 'Customer ID must be 100 characters or fewer'),
  customer_name: nullableText(200),
  email: z
    .string()
    .trim()
    .max(254, 'Customer email must be 254 characters or fewer')
    .refine((value) => value.length === 0 || z.string().email().safeParse(value).success, {
      message: 'Customer email must be a valid email address'
    })
    .transform((value) => (value.length === 0 ? null : value)),
  sku: z.string().trim().min(1, 'SKU is required').max(100, 'SKU must be 100 characters or fewer'),
  batch: nullableText(100),
  purchased_at: z
    .string()
    .trim()
    .min(1, 'Purchase date is required')
    .refine(isIsoDate, 'Purchase date must be a valid ISO date')
    .transform((value) => new Date(value).toISOString()),
  quantity: z
    .string()
    .trim()
    .transform((value) => (value.length === 0 ? '1' : value))
    .refine((value) => /^\d+$/.test(value), 'Quantity must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(1_000_000))
});

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function cellToString(value: CellValue | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).trim();
}

function emptySummary(fileName: string, message: string): ImportSummary {
  return {
    fileName,
    totalRows: 0,
    acceptedRows: 0,
    rejectedRows: 0,
    preview: [],
    errors: [{ row: 0, message }]
  };
}

function failedSummary(
  fileName: string,
  validation: ValidatedRows<unknown>,
  errors = validation.errors
): ImportSummary {
  return {
    fileName,
    totalRows: validation.totalRows,
    acceptedRows: 0,
    rejectedRows: validation.totalRows,
    preview: validation.preview,
    errors
  };
}

function successfulSummary(
  fileName: string,
  validation: ValidatedRows<unknown>
): ImportSummary {
  return {
    fileName,
    totalRows: validation.totalRows,
    acceptedRows: validation.totalRows,
    rejectedRows: 0,
    preview: validation.preview,
    errors: []
  };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function parseTable(file: File): Promise<ParsedTable | ImportSummary> {
  if (file.size === 0) {
    return emptySummary(file.name, 'The selected file is empty.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return emptySummary(file.name, 'File is larger than the 5 MB upload limit.');
  }

  const extension = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
  if (extension !== '.csv' && extension !== '.xlsx') {
    return emptySummary(file.name, 'Choose a CSV or XLSX file.');
  }

  let cells: CellValue[][];
  try {
    if (extension === '.csv') {
      const contents = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      cells = parse(contents, {
        bom: true,
        skip_empty_lines: true,
        relax_column_count: false
      }) as string[][];
    } else {
      cells = (await readSheet(Buffer.from(await file.arrayBuffer()))) as CellValue[][];
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The file could not be parsed.';
    return emptySummary(file.name, `The file could not be read: ${reason}`);
  }

  if (cells.length === 0) {
    return emptySummary(file.name, 'The file must include a header row.');
  }

  const headers = cells[0].map((value) => cellToString(value).toLowerCase());
  const rows = cells
    .slice(1)
    .map((values, index) => ({
      rowNumber: index + 2,
      values: values.map(cellToString)
    }))
    .filter((row) => row.values.some((value) => value.length > 0));

  if (rows.length > MAX_IMPORT_ROWS) {
    return {
      fileName: file.name,
      totalRows: rows.length,
      acceptedRows: 0,
      rejectedRows: rows.length,
      preview: [],
      errors: [
        {
          row: 0,
          message: `The file contains ${rows.length.toLocaleString('en')} rows; the limit is 5,000.`
        }
      ]
    };
  }

  return { headers, rows };
}

function validateHeaders(
  headers: string[],
  required: readonly string[],
  allowed: readonly string[]
): RowError[] {
  const errors: RowError[] = [];
  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
  const missing = required.filter((header) => !headers.includes(header));
  const unsupported = headers.filter((header) => !allowed.includes(header));

  if (headers.some((header) => header.length === 0)) {
    errors.push({ row: 1, message: 'Header names cannot be empty.' });
  }
  if (duplicates.length > 0) {
    errors.push({
      row: 1,
      message: `Duplicate headers: ${[...new Set(duplicates)].join(', ')}.`
    });
  }
  if (missing.length > 0) {
    errors.push({ row: 1, message: `Missing required headers: ${missing.join(', ')}.` });
  }
  if (unsupported.length > 0) {
    errors.push({
      row: 1,
      message: `Unsupported headers: ${unsupported.join(', ')}. Use: ${allowed.join(', ')}.`
    });
  }

  return errors;
}

function rowsAsRecords(table: ParsedTable, allowedHeaders: readonly string[]): Array<{
  rowNumber: number;
  record: ImportRecord;
}> {
  return table.rows.map((row) => {
    const record = Object.fromEntries(allowedHeaders.map((header) => [header, ''])) as ImportRecord;
    table.headers.forEach((header, index) => {
      if (allowedHeaders.includes(header)) {
        record[header] = row.values[index] ?? '';
      }
    });
    return { rowNumber: row.rowNumber, record };
  });
}

function zodErrors(rowNumber: number, error: z.ZodError): RowError[] {
  return error.issues.map((issue) => ({
    row: rowNumber,
    field: issue.path[0]?.toString(),
    message: issue.message
  }));
}

async function validateCatalogue(file: File): Promise<ValidatedRows<CatalogueRecord> | ImportSummary> {
  const table = await parseTable(file);
  if ('fileName' in table) {
    return table;
  }

  const headerErrors = validateHeaders(table.headers, ['sku', 'name', 'brand'], catalogueHeaders);
  if (headerErrors.length > 0) {
    return {
      fileName: file.name,
      totalRows: table.rows.length,
      acceptedRows: 0,
      rejectedRows: table.rows.length,
      preview: [],
      errors: headerErrors
    };
  }

  const records: CatalogueRecord[] = [];
  const preview: Array<Record<string, string | number | null>> = [];
  const errors: RowError[] = [];
  const skuRows = new Map<string, number[]>();

  for (const row of rowsAsRecords(table, catalogueHeaders)) {
    const parsed = catalogueRowSchema.safeParse(row.record);
    if (!parsed.success) {
      errors.push(...zodErrors(row.rowNumber, parsed.error));
      continue;
    }

    const value = parsed.data;
    const skuKey = value.sku.toLowerCase();
    skuRows.set(skuKey, [...(skuRows.get(skuKey) ?? []), row.rowNumber]);
    const record: CatalogueRecord = {
      rowNumber: row.rowNumber,
      sku: value.sku,
      name: value.name,
      brand: value.brand,
      ean: value.ean,
      batch: value.batch,
      supplierName: value.supplier_name,
      supplierEmail: value.supplier_email,
      category: value.category,
      stockQuantity: value.stock_quantity
    };
    records.push(record);
    if (preview.length < 5) {
      preview.push({
        sku: record.sku,
        name: record.name,
        brand: record.brand,
        ean: record.ean,
        batch: record.batch,
        stock_quantity: record.stockQuantity
      });
    }
  }

  for (const rows of skuRows.values()) {
    if (rows.length > 1) {
      const sku = records.find((record) => record.rowNumber === rows[0])?.sku ?? 'Unknown SKU';
      for (const row of rows) {
        errors.push({ row, field: 'sku', message: `Duplicate SKU "${sku}" appears on rows ${rows.join(', ')}.` });
      }
    }
  }

  return { records, preview, errors, totalRows: table.rows.length };
}

async function validatePurchases(file: File): Promise<ValidatedRows<PurchaseRecord> | ImportSummary> {
  const table = await parseTable(file);
  if ('fileName' in table) {
    return table;
  }

  const headerErrors = validateHeaders(
    table.headers,
    ['customer_id', 'sku', 'purchased_at'],
    purchaseHeaders
  );
  if (headerErrors.length > 0) {
    return {
      fileName: file.name,
      totalRows: table.rows.length,
      acceptedRows: 0,
      rejectedRows: table.rows.length,
      preview: [],
      errors: headerErrors
    };
  }

  const records: PurchaseRecord[] = [];
  const preview: Array<Record<string, string | number | null>> = [];
  const errors: RowError[] = [];
  for (const row of rowsAsRecords(table, purchaseHeaders)) {
    const parsed = purchaseRowSchema.safeParse(row.record);
    if (!parsed.success) {
      errors.push(...zodErrors(row.rowNumber, parsed.error));
      continue;
    }

    const value = parsed.data;
    const record: PurchaseRecord = {
      rowNumber: row.rowNumber,
      customerId: value.customer_id,
      customerName: value.customer_name,
      email: value.email,
      sku: value.sku,
      batch: value.batch,
      purchasedAt: value.purchased_at,
      quantity: value.quantity
    };
    records.push(record);
    if (preview.length < 5) {
      preview.push({
        customer_id: record.customerId,
        customer_name: record.customerName,
        email: record.email,
        sku: record.sku,
        batch: record.batch,
        purchased_at: record.purchasedAt.slice(0, 10)
      });
    }
  }

  return { records, preview, errors, totalRows: table.rows.length };
}

export async function importCatalogue(database: RecallDatabase, file: File): Promise<ImportResult> {
  const validation = await validateCatalogue(file);
  if ('fileName' in validation) {
    return { success: false, summary: validation };
  }
  if (validation.totalRows === 0) {
    return { success: false, summary: emptySummary(file.name, 'The file has no product rows.') };
  }

  const existingProducts = database.select({ sku: schema.products.sku }).from(schema.products).all();
  const existingSku = new Set(existingProducts.map((product) => product.sku.toLowerCase()));
  const databaseDuplicates = validation.records
    .filter((record) => existingSku.has(record.sku.toLowerCase()))
    .map((record) => ({
      row: record.rowNumber,
      field: 'sku',
      message: `SKU "${record.sku}" already exists in the catalogue.`
    }));
  const errors = [...validation.errors, ...databaseDuplicates];
  if (errors.length > 0) {
    return { success: false, summary: failedSummary(file.name, validation, errors) };
  }

  const createdAt = new Date().toISOString();
  database.transaction((transaction) => {
    const values = validation.records.map((record) => ({
          id: crypto.randomUUID(),
          sku: record.sku,
          name: record.name,
          normalizedName: normalizeText(record.name),
          brand: record.brand,
          normalizedBrand: normalizeText(record.brand),
          ean: record.ean,
          batch: record.batch,
          supplierName: record.supplierName,
          supplierEmail: record.supplierEmail,
          category: record.category,
          stockQuantity: record.stockQuantity,
          createdAt
        }));
    for (const batch of chunks(values, 200)) {
      transaction.insert(schema.products).values(batch).run();
    }
  });

  return { success: true, summary: successfulSummary(file.name, validation) };
}

export async function importPurchases(database: RecallDatabase, file: File): Promise<ImportResult> {
  const validation = await validatePurchases(file);
  if ('fileName' in validation) {
    return { success: false, summary: validation };
  }
  if (validation.totalRows === 0) {
    return { success: false, summary: emptySummary(file.name, 'The file has no purchase rows.') };
  }

  const productRows = database
    .select({ id: schema.products.id, sku: schema.products.sku })
    .from(schema.products)
    .all();
  const productsBySku = new Map(productRows.map((product) => [product.sku.toLowerCase(), product.id]));
  const unknownSkuErrors = validation.records
    .filter((record) => !productsBySku.has(record.sku.toLowerCase()))
    .map((record) => ({
      row: record.rowNumber,
      field: 'sku',
      message: `SKU "${record.sku}" was not found in the product catalogue.`
    }));
  const errors = [...validation.errors, ...unknownSkuErrors];
  if (errors.length > 0) {
    return { success: false, summary: failedSummary(file.name, validation, errors) };
  }

  const existingCustomers = database
    .select({ id: schema.customers.id, externalId: schema.customers.externalId })
    .from(schema.customers)
    .all();
  const customersByExternalId = new Map(
    existingCustomers.map((customer) => [customer.externalId, customer.id])
  );
  const newCustomers = new Map<
    string,
    { id: string; externalId: string; name: string | null; email: string | null }
  >();
  for (const record of validation.records) {
    if (!customersByExternalId.has(record.customerId) && !newCustomers.has(record.customerId)) {
      newCustomers.set(record.customerId, {
        id: crypto.randomUUID(),
        externalId: record.customerId,
        name: record.customerName,
        email: record.email
      });
    }
  }

  const createdAt = new Date().toISOString();
  database.transaction((transaction) => {
    if (newCustomers.size > 0) {
      const customerValues = [...newCustomers.values()].map((customer) => ({
            ...customer,
            createdAt
          }));
      for (const batch of chunks(customerValues, 500)) {
        transaction.insert(schema.customers).values(batch).run();
      }
    }

    const allCustomerIds = new Map(customersByExternalId);
    for (const customer of newCustomers.values()) {
      allCustomerIds.set(customer.externalId, customer.id);
    }
    const purchaseValues = validation.records.map((record) => ({
          id: crypto.randomUUID(),
          customerId: allCustomerIds.get(record.customerId)!,
          productId: productsBySku.get(record.sku.toLowerCase())!,
          batch: record.batch,
          purchasedAt: record.purchasedAt,
          quantity: record.quantity
        }));
    for (const batch of chunks(purchaseValues, 500)) {
      transaction.insert(schema.purchases).values(batch).run();
    }
  });

  return { success: true, summary: successfulSummary(file.name, validation) };
}
