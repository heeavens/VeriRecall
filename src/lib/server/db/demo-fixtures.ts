import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AlertStatus, AlertSourceName } from '../../types/domain';
import type {
  NewAlert,
  NewCustomer,
  NewProduct,
  NewPurchase,
  caseItems,
  cases,
  matches,
  settings
} from './schema';

type NewSetting = typeof settings.$inferInsert;
type NewMatch = typeof matches.$inferInsert;
type NewCase = typeof cases.$inferInsert;
type NewCaseItem = typeof caseItems.$inferInsert;

interface ProductFixture {
  id: string;
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

interface CustomerFixture {
  id: string;
  externalId: string;
  name: string | null;
  email: string | null;
}

interface AlertFixture {
  source: AlertSourceName;
  sourceReference: string;
  sourceUrl: string;
  title: string;
  description: string;
  risk: string;
  imageUrl: string | null;
  brand: string | null;
  productName: string;
  ean: string | null;
  batch: string | null;
  category: string | null;
  publishedAt: string;
}

export interface DemoFixtures {
  settings: NewSetting[];
  products: NewProduct[];
  customers: NewCustomer[];
  purchases: NewPurchase[];
  alerts: NewAlert[];
  matches: NewMatch[];
  cases: NewCase[];
  caseItems: NewCaseItem[];
}

const fixtureTimestamp = '2026-08-28T12:00:00.000Z';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, fixtureName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fixtureName} must contain JSON objects`);
  }

  return value;
}

function stringValue(
  source: Record<string, unknown>,
  field: string,
  fixtureName: string
): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fixtureName}.${field} must be a non-empty string`);
  }

  return value;
}

function nullableStringValue(
  source: Record<string, unknown>,
  field: string,
  fixtureName: string
): string | null {
  const value = source[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${fixtureName}.${field} must be a string or null`);
  }

  return value;
}

function positiveIntegerValue(
  source: Record<string, unknown>,
  field: string,
  fixtureName: string,
  allowZero = false
): number {
  const value = source[field];
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${fixtureName}.${field} must be an integer of at least ${minimum}`);
  }

  return value as number;
}

function readJson(fixturePath: string): unknown {
  const absolutePath = resolve(fixturePath);
  const contents = readFileSync(absolutePath, 'utf8');
  return JSON.parse(contents) as unknown;
}

function readJsonArray(fixturePath: string): unknown[] {
  const value = readJson(fixturePath);
  if (!Array.isArray(value)) {
    throw new Error(`${fixturePath} must contain a JSON array`);
  }

  return value;
}

function normalizeFixtureText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function loadProducts(): NewProduct[] {
  return readJsonArray('data/demo/products.json').map((value, index) => {
    const fixtureName = `products[${index}]`;
    const source = record(value, fixtureName);
    const name = stringValue(source, 'name', fixtureName);
    const brand = stringValue(source, 'brand', fixtureName);

    return {
      id: stringValue(source, 'id', fixtureName),
      sku: stringValue(source, 'sku', fixtureName),
      name,
      normalizedName: normalizeFixtureText(name),
      brand,
      normalizedBrand: normalizeFixtureText(brand),
      ean: nullableStringValue(source, 'ean', fixtureName),
      batch: nullableStringValue(source, 'batch', fixtureName),
      supplierName: nullableStringValue(source, 'supplierName', fixtureName),
      supplierEmail: nullableStringValue(source, 'supplierEmail', fixtureName),
      category: nullableStringValue(source, 'category', fixtureName),
      stockQuantity: positiveIntegerValue(source, 'stockQuantity', fixtureName, true),
      createdAt: fixtureTimestamp
    };
  });
}

function loadCustomers(): NewCustomer[] {
  return readJsonArray('data/demo/customers.json').map((value, index) => {
    const fixtureName = `customers[${index}]`;
    const source = record(value, fixtureName);

    return {
      id: stringValue(source, 'id', fixtureName),
      externalId: stringValue(source, 'externalId', fixtureName),
      name: nullableStringValue(source, 'name', fixtureName),
      email: nullableStringValue(source, 'email', fixtureName),
      createdAt: fixtureTimestamp
    };
  });
}

function loadPurchases(): NewPurchase[] {
  return readJsonArray('data/demo/purchases.json').map((value, index) => {
    const fixtureName = `purchases[${index}]`;
    const source = record(value, fixtureName);

    return {
      id: stringValue(source, 'id', fixtureName),
      customerId: stringValue(source, 'customerId', fixtureName),
      productId: stringValue(source, 'productId', fixtureName),
      batch: nullableStringValue(source, 'batch', fixtureName),
      purchasedAt: stringValue(source, 'purchasedAt', fixtureName),
      quantity: positiveIntegerValue(source, 'quantity', fixtureName)
    };
  });
}

function parseAlert(value: unknown, fixtureName: string): AlertFixture {
  const source = record(value, fixtureName);
  const alertSource = stringValue(source, 'source', fixtureName);
  if (alertSource !== 'safety_gate' && alertSource !== 'rasff') {
    throw new Error(`${fixtureName}.source must be safety_gate or rasff`);
  }

  return {
    source: alertSource,
    sourceReference: stringValue(source, 'sourceReference', fixtureName),
    sourceUrl: stringValue(source, 'sourceUrl', fixtureName),
    title: stringValue(source, 'title', fixtureName),
    description: stringValue(source, 'description', fixtureName),
    risk: stringValue(source, 'risk', fixtureName),
    imageUrl: nullableStringValue(source, 'imageUrl', fixtureName),
    brand: nullableStringValue(source, 'brand', fixtureName),
    productName: stringValue(source, 'productName', fixtureName),
    ean: nullableStringValue(source, 'ean', fixtureName),
    batch: nullableStringValue(source, 'batch', fixtureName),
    category: nullableStringValue(source, 'category', fixtureName),
    publishedAt: stringValue(source, 'publishedAt', fixtureName)
  };
}

function loadAlert(
  fixturePath: string,
  id: string,
  status: AlertStatus
): NewAlert {
  const source = parseAlert(readJson(fixturePath), fixturePath);

  return {
    id,
    ...source,
    status,
    rawJson: JSON.stringify(source),
    createdAt: fixtureTimestamp
  };
}

export function loadDemoFixtures(): DemoFixtures {
  const products = loadProducts();
  const customers = loadCustomers();
  const purchases = loadPurchases();
  const alerts = [
    loadAlert(
      'data/alerts/high-confidence.json',
      '40000000-0000-4000-8000-000000000001',
      'matched'
    ),
    loadAlert(
      'data/alerts/uncertain.json',
      '40000000-0000-4000-8000-000000000002',
      'needs_review'
    ),
    loadAlert(
      'data/alerts/not-relevant.json',
      '40000000-0000-4000-8000-000000000003',
      'not_relevant'
    )
  ];

  return {
    settings: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        confidenceThreshold: 85,
        reviewFloor: 55,
        onboardingCompleted: true,
        createdAt: fixtureTimestamp,
        updatedAt: fixtureTimestamp
      }
    ],
    products,
    customers,
    purchases,
    alerts,
    matches: [
      {
        id: '50000000-0000-4000-8000-000000000001',
        alertId: alerts[0].id,
        productId: products[0].id,
        totalScore: 98,
        nameScore: 23,
        brandScore: 20,
        eanScore: 45,
        batchScore: 10,
        hasHardConflict: false,
        explanation:
          'The EAN, brand and batch match exactly, and the product names are strongly aligned.',
        status: 'confirmed',
        createdAt: fixtureTimestamp,
        decidedAt: fixtureTimestamp
      },
      {
        id: '50000000-0000-4000-8000-000000000002',
        alertId: alerts[1].id,
        productId: products[1].id,
        totalScore: 44,
        nameScore: 24,
        brandScore: 20,
        eanScore: 0,
        batchScore: 0,
        hasHardConflict: true,
        explanation:
          'Brand and product name are strong matches, but the EAN is different and the catalogue batch is missing. Request a barcode photo or supplier invoice before confirming this product.',
        status: 'candidate',
        createdAt: fixtureTimestamp,
        decidedAt: null
      },
      {
        id: '50000000-0000-4000-8000-000000000003',
        alertId: alerts[2].id,
        productId: products[10].id,
        totalScore: 3,
        nameScore: 3,
        brandScore: 0,
        eanScore: 0,
        batchScore: 0,
        hasHardConflict: false,
        explanation:
          'The alert describes smoked salmon, while the closest catalogue item is a prepared vegetable product from another category and its brand is not present in the alert.',
        status: 'candidate',
        createdAt: fixtureTimestamp,
        decidedAt: null
      }
    ],
    cases: [
      {
        id: '60000000-0000-4000-8000-000000000001',
        caseNumber: 'CASE-0001',
        alertId: alerts[0].id,
        status: 'open',
        severity: 'high',
        openedAt: fixtureTimestamp,
        closedAt: null
      }
    ],
    caseItems: [
      {
        id: '70000000-0000-4000-8000-000000000001',
        caseId: '60000000-0000-4000-8000-000000000001',
        productId: products[0].id,
        batch: 'MFT24',
        stockQuantity: 17
      }
    ]
  };
}
