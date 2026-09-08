import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { count } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { readCaseSnapshot, reserveInvestigationCase } from '../workflow/case-lifecycle';
import {
  EvidenceRegistryError,
  getInvestigationEvidence,
  recordInvestigationEvidence,
  type RecordInvestigationEvidenceInput
} from './evidence-registry';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

let directory: string;
let databasePath: string;
let connection: TestConnection;

const fixtures = loadDemoFixtures();
const receivedAt = '2026-09-08T12:00:00.000Z';

function reserveCase(matchIndex = 0) {
  const match = fixtures.matches[matchIndex];
  const result = reserveInvestigationCase(
    connection.db,
    { alertId: match.alertId, productId: match.productId },
    { mode: 'demo' },
    new Date('2026-09-08T10:00:00.000Z')
  );
  if (!result.ok) throw new Error(result.error.message);
  return { match, snapshot: result.snapshot };
}

function structuredEvidence(
  caseId: string,
  overrides: Partial<RecordInvestigationEvidenceInput> = {}
): RecordInvestigationEvidenceInput {
  return {
    evidenceRef: 'evidence:regulator:alert-2026-001',
    caseId,
    questionRef: 'question:product-identity:ean',
    evidenceRequestId: null,
    sourceKind: 'REGULATOR',
    sourceIdentifier: 'safety-gate:alert-2026-001',
    validAsOf: '2026-09-07T00:00:00.000Z',
    contentKind: 'STRUCTURED',
    contentJson: {
      batch: 'MFT24',
      ean: '3073646035990'
    },
    contentLocator: null,
    demo: true,
    ...overrides
  } as RecordInvestigationEvidenceInput;
}

function record(input: RecordInvestigationEvidenceInput) {
  return recordInvestigationEvidence(connection.db, input, new Date(receivedAt));
}

function workflowCounts() {
  return [
    schema.caseLifecycle,
    schema.caseRevisions,
    schema.caseCommands,
    schema.auditEvents,
    schema.caseItems,
    schema.caseTasks,
    schema.actionDrafts,
    schema.traceabilityRecords
  ].map((table) => connection.db.select().from(table).all().length);
}

function expectRegistryError(action: () => unknown, code: EvidenceRegistryError['code']) {
  try {
    action();
    throw new Error('Expected evidence registry operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceRegistryError);
    expect(error).toMatchObject({ code });
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-evidence-registry-'));
  databasePath = join(directory, 'test.db');
  connection = createDatabaseConnection(databasePath);
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('investigation evidence registry', () => {
  it('persists structured evidence with immutable provenance and a server-calculated hash', () => {
    const { snapshot } = reserveCase();
    const input = structuredEvidence(snapshot.caseId);
    const expectedHash = createHash('sha256')
      .update('{"batch":"MFT24","ean":"3073646035990"}')
      .digest('hex');

    const result = record(input);

    expect(result).toEqual({
      evidence: {
        ...input,
        receivedAt,
        integrityHash: expectedHash
      },
      replayed: false
    });
    expect(getInvestigationEvidence(connection.db, snapshot.caseId, input.evidenceRef)).toEqual(
      result.evidence
    );
  });

  it('preserves an unknown valid-as-of time as null', () => {
    const { snapshot } = reserveCase();
    const input = structuredEvidence(snapshot.caseId, { validAsOf: null });

    record(input);

    expect(getInvestigationEvidence(connection.db, snapshot.caseId, input.evidenceRef)?.validAsOf)
      .toBeNull();
  });

  it('returns an exact replay without inserting a duplicate', () => {
    const { snapshot } = reserveCase();
    const input = structuredEvidence(snapshot.caseId);
    const first = record(input);
    const replay = record(input);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ evidence: first.evidence, replayed: true });
    expect(connection.db.select({ value: count() }).from(schema.investigationEvidence).get()?.value)
      .toBe(1);
  });

  it('rejects reuse of an evidence reference with different content', () => {
    const { snapshot } = reserveCase();
    const input = structuredEvidence(snapshot.caseId);
    record(input);

    expectRegistryError(
      () => record(structuredEvidence(snapshot.caseId, {
        contentJson: { batch: 'DIFFERENT', ean: '3073646035990' }
      })),
      'EVIDENCE_CONFLICT'
    );
  });

  it('rejects reuse of an evidence reference with different provenance metadata', () => {
    const { snapshot } = reserveCase();
    const input = structuredEvidence(snapshot.caseId);
    record(input);

    expectRegistryError(
      () => record(structuredEvidence(snapshot.caseId, {
        sourceIdentifier: 'safety-gate:another-alert'
      })),
      'EVIDENCE_CONFLICT'
    );
  });

  it('does not resolve evidence through another case', () => {
    const first = reserveCase(0);
    const second = reserveCase(1);
    const input = structuredEvidence(first.snapshot.caseId);
    record(input);

    expect(getInvestigationEvidence(connection.db, second.snapshot.caseId, input.evidenceRef))
      .toBeNull();
  });

  it('rejects an unknown case and a nonexistent evidence request', () => {
    const { snapshot } = reserveCase();

    expectRegistryError(
      () => record(structuredEvidence(randomUUID())),
      'CASE_NOT_FOUND'
    );
    expectRegistryError(
      () => record(structuredEvidence(snapshot.caseId, {
        evidenceRequestId: randomUUID()
      })),
      'EVIDENCE_REQUEST_NOT_FOUND'
    );
  });

  it('accepts only an evidence request related to the same case through its match', () => {
    const first = reserveCase(0);
    const second = reserveCase(1);
    const firstRequestId = randomUUID();
    const secondRequestId = randomUUID();
    connection.db.insert(schema.evidenceRequests).values([
      {
        id: firstRequestId,
        matchId: first.match.id,
        requestedEvidence: '["barcode_photo"]',
        recipient: null,
        status: 'pending',
        createdAt: receivedAt,
        resolvedAt: null
      },
      {
        id: secondRequestId,
        matchId: second.match.id,
        requestedEvidence: '["barcode_photo"]',
        recipient: null,
        status: 'pending',
        createdAt: receivedAt,
        resolvedAt: null
      }
    ]).run();

    expect(record(structuredEvidence(first.snapshot.caseId, {
      evidenceRequestId: firstRequestId
    }))).toMatchObject({ replayed: false, evidence: { evidenceRequestId: firstRequestId } });
    expectRegistryError(
      () => record(structuredEvidence(first.snapshot.caseId, {
        evidenceRef: 'evidence:external:wrong-case-request',
        evidenceRequestId: secondRequestId,
        sourceKind: 'EXTERNAL_PARTY',
        sourceIdentifier: 'supplier:wrong-case'
      })),
      'EVIDENCE_REQUEST_CASE_MISMATCH'
    );
  });

  it('records locator evidence only with the caller-provided content hash', () => {
    const { snapshot } = reserveCase();
    const hash = 'a'.repeat(64);
    const input: RecordInvestigationEvidenceInput = {
      evidenceRef: 'evidence:external:document-001',
      caseId: snapshot.caseId,
      questionRef: 'question:product-identity:barcode-photo',
      evidenceRequestId: null,
      sourceKind: 'EXTERNAL_PARTY',
      sourceIdentifier: 'supplier:document-001',
      validAsOf: null,
      contentKind: 'LOCATOR',
      contentJson: null,
      contentLocator: 'object-store://investigation/document-001',
      integrityHash: hash,
      demo: true
    };

    expect(record(input).evidence).toEqual({ ...input, receivedAt });
  });

  it('leaves the authoritative case snapshot byte-for-byte unchanged', () => {
    const { snapshot } = reserveCase();
    const before = readCaseSnapshot(connection.db, snapshot.caseId);
    const beforeWorkflowCounts = workflowCounts();

    record(structuredEvidence(snapshot.caseId));

    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(before);
    expect(workflowCounts()).toEqual(beforeWorkflowCounts);
  });

  it('survives closing and reopening the database', () => {
    const { snapshot } = reserveCase();
    const input = structuredEvidence(snapshot.caseId);
    const recorded = record(input).evidence;
    connection.sqlite.close();
    connection = createDatabaseConnection(databasePath);

    expect(getInvestigationEvidence(connection.db, snapshot.caseId, input.evidenceRef))
      .toEqual(recorded);
  });
});
