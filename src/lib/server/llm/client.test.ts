import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ActionType,
  AlertProposalExtraction,
  LlmClient,
  MatchExplanation,
  ScoreBreakdown
} from '../../types/domain';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { products, settings } from '../db/schema';
import { runMonitoringCycle } from '../workflow/monitoring';
import { createLlmClient, ResilientLlmClient } from './client';
import { FallbackLlmClient } from './fallback-client';
import {
  OpenAiLlmClient,
  type OpenAiResponseTransport,
  type OpenAiStructuredRequest
} from './openai-client';

class StubTransport implements OpenAiResponseTransport {
  readonly requests: OpenAiStructuredRequest[] = [];

  constructor(private readonly output: unknown) {}

  async generate(request: OpenAiStructuredRequest): Promise<unknown> {
    this.requests.push(request);
    if (this.output instanceof Error) throw this.output;
    return this.output;
  }
}

class FailingLlmClient implements LlmClient {
  async extractAlert(): Promise<AlertProposalExtraction> {
    throw new Error('mock API unavailable');
  }

  async explainMatch(): Promise<MatchExplanation> {
    throw new Error('mock API unavailable');
  }

  async draftAction(): Promise<string> {
    throw new Error('mock API unavailable');
  }
}

const breakdown: ScoreBreakdown = {
  total: 64,
  ean: 0,
  name: 24,
  brand: 20,
  batch: 10,
  hasHardConflict: true,
  reasons: ['Brand matches exactly.', 'EAN conflicts with the catalogue record.'],
  requestedEvidence: ['barcode photo']
};

let temporaryDirectory: string;
let connection: ReturnType<typeof createDatabaseConnection>;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'recallops-llm-test-'));
  connection = createDatabaseConnection(join(temporaryDirectory, 'recallops.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  const fixtures = loadDemoFixtures();
  connection.db.insert(settings).values(fixtures.settings).run();
  connection.db.insert(products).values(fixtures.products).run();
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('Stage 6 LLM clients', () => {
  it('validates structured alert extraction before returning domain data', async () => {
    const transport = new StubTransport({
      productName: 'Test product',
      brand: null,
      ean: ' 5391234567890 ',
      batch: null,
      category: 'Toys',
    });
    const client = new OpenAiLlmClient(transport, { model: 'gpt-test' });

    const alert = await client.extractAlert('untrusted source text');

    expect(alert).toMatchObject({
      origin: 'AI_GENERATED',
      modelIdentifier: 'gpt-test',
      proposals: { ean: '5391234567890' }
    });
    expect(alert.proposals.brand).toBeUndefined();
    expect(transport.requests[0]).toMatchObject({
      schemaName: 'recall_alert_proposals',
      store: false
    });
  });

  it('rejects proposal output that attempts to replace immutable source identity', async () => {
    const transport = new StubTransport({
      productName: 'Test product',
      brand: null,
      ean: null,
      batch: null,
      category: null,
      sourceUrl: 'https://attacker.example/replacement'
    });
    const client = new OpenAiLlmClient(transport, { model: 'gpt-test' });

    await expect(client.extractAlert('{"title":"untrusted"}')).rejects.toThrow();
  });

  it('runs the complete monitoring workflow with an empty API key', async () => {
    const client = createLlmClient({ OPENAI_API_KEY: '', OPENAI_MODEL: 'gpt-test' });

    expect(client).toBeInstanceOf(FallbackLlmClient);
    await expect(runMonitoringCycle(connection.db, undefined, undefined, client)).resolves.toMatchObject({
      imported: 3,
      highConfidence: 1,
      review: 1,
      ignored: 1
    });
  });

  it('continues the workflow when every primary API request fails', async () => {
    const client = new ResilientLlmClient(new FailingLlmClient(), new FallbackLlmClient());

    await expect(runMonitoringCycle(connection.db, undefined, undefined, client)).resolves.toMatchObject({
      imported: 3,
      highConfidence: 1,
      review: 1,
      ignored: 1
    });
  });

  it('rejects malformed structured output and uses the deterministic explanation', async () => {
    const transport = new StubTransport({ explanation: 42 });
    const primary = new OpenAiLlmClient(transport, { model: 'gpt-test', timeoutMs: 1_234 });
    const client = new ResilientLlmClient(primary, new FallbackLlmClient());

    const explanation = await client.explainMatch(breakdown);

    expect(explanation.text).toContain('Brand matches exactly.');
    expect(explanation.text).toContain('Requested evidence: barcode photo.');
    expect(explanation.origin).toBe('DETERMINISTIC');
    expect(transport.requests[0]).toMatchObject({
      model: 'gpt-test',
      schemaName: 'match_explanation',
      store: false,
      timeoutMs: 1_234
    });
  });

  it('removes customer and recipient data before drafting', async () => {
    const transport = new StubTransport({ body: 'Safe draft body.' });
    const client = new OpenAiLlmClient(transport, { model: 'gpt-test' });
    const context: Record<string, unknown> = {
      sku: 'TOY-1042',
      batch: 'BJ-24-08A',
      affectedCustomerCount: 3,
      customerEmails: ['customer@example.test'],
      supplierEmail: 'supplier@example.test',
      customers: [{ email: 'hidden@example.test' }]
    };

    await expect(client.draftAction('notify_customers' satisfies ActionType, context)).resolves.toBe(
      'Safe draft body.'
    );
    const payload = transport.requests[0]?.input ?? '';
    expect(payload).toContain('TOY-1042');
    expect(payload).toContain('affectedCustomerCount');
    expect(payload).not.toContain('customer@example.test');
    expect(payload).not.toContain('supplier@example.test');
    expect(payload).not.toContain('hidden@example.test');
  });
});
