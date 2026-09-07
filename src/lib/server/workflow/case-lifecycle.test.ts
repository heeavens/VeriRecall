import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { caseSnapshotSchema, type InvestigationOutcome } from '../../contracts/recall';
import { confirmedLotOutcome, expandedLotOutcome, unresolvedScopeOutcome } from '../../contracts/recall.fixtures';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { getCasesView } from '../cases/queries';
import { CaseReportExporter } from '../exports/case-report';
import { closeRecallCase, completeCaseTask } from './case-actions';
import { confirmReviewMatch, rejectReviewMatch, requestMatchEvidence } from './review';
import { createRecallService, getCaseHistory, readCaseSnapshot, reserveInvestigationCase } from './case-lifecycle';

let directory: string;
let connection: ReturnType<typeof createDatabaseConnection>;
const context = { mode: 'demo' as const };
const fixtures = loadDemoFixtures();
const candidate = fixtures.matches.find((match) => !match.hasHardConflict)!;
const reservation = { alertId: candidate.alertId, productId: candidate.productId };

function reserve() {
  const result = reserveInvestigationCase(connection.db, reservation, context, new Date('2026-09-07T12:00:00Z'));
  if (!result.ok) throw new Error(result.error.message);
  return result.snapshot;
}
function command(caseId: string, outcome: InvestigationOutcome = confirmedLotOutcome, expectedCaseVersion = 1) {
  return { type: 'ACCEPT_INVESTIGATION' as const, schemaVersion: 1 as const, caseId,
    commandId: randomUUID(), expectedCaseVersion,
    outcome: { ...structuredClone(outcome), caseId, productId: candidate.productId } };
}
function counts() {
  return [schema.cases, schema.caseLifecycle, schema.caseRevisions, schema.caseCommands, schema.auditEvents]
    .map((table) => connection.db.select().from(table).all().length);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-lifecycle-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});
afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('persisted case lifecycle', () => {
  it('reserves one real case per alert and reads an unknown initial snapshot without side effects', async () => {
    const initial = reserve();
    const before = counts();
    expect(reserve()).toEqual(initial);
    expect(initial).toMatchObject({ caseVersion: 1, materialRevision: null, investigation: null, stage: 'INVESTIGATING' });
    expect(initial.exposure.received.value).toBeNull();
    const service = createRecallService(connection.db, context);
    expect(await service.getSnapshot({ schemaVersion: 1, caseId: initial.caseId })).toEqual({ ok: true, snapshot: initial });
    expect(counts()).toEqual(before);
    expect(getCasesView(connection.db)).toEqual(expect.arrayContaining([expect.objectContaining({ versioned: true })]));
  });

  it('saves the outcome, independent knowledge, server timestamp, history and audit atomically', async () => {
    const initial = reserve();
    const input = command(initial.caseId);
    const service = createRecallService(connection.db, context, () => new Date('2026-09-07T14:00:00Z'));
    const result = await service.execute(input);
    expect(result).toMatchObject({ ok: true, replayed: false, appliedCaseVersion: 2 });
    const snapshot = readCaseSnapshot(connection.db, initial.caseId)!;
    expect(caseSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({ caseVersion: 2, materialRevision: 1, stage: 'INVESTIGATING', updatedAt: '2026-09-07T14:00:00.000Z' });
    expect(snapshot.investigation).toEqual(input.outcome);
    expect(snapshot.closure).toMatchObject({ status: 'NOT_READY', blockers: expect.arrayContaining([expect.objectContaining({ code: 'SCOPE_UNCONFIRMED' })]) });
    expect(getCaseHistory(connection.db, initial.caseId)).toHaveLength(2);
    const event = connection.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.eventType, 'investigation_received')).get();
    expect(event?.actorName).toBe('demo_operator');
    expect(connection.db.select().from(schema.caseItems).all()).toHaveLength(0);
    expect(connection.db.select().from(schema.caseTasks).all()).toHaveLength(0);
  });

  it('preserves state, history and command replay after a new database connection', async () => {
    const initial = reserve();
    const input = command(initial.caseId);
    await createRecallService(connection.db, context).execute(input);
    const before = readCaseSnapshot(connection.db, initial.caseId);
    const history = getCaseHistory(connection.db, initial.caseId);
    const totals = counts();
    connection.sqlite.close();
    connection = createDatabaseConnection(join(directory, 'test.db'));
    expect(readCaseSnapshot(connection.db, initial.caseId)).toEqual(before);
    expect(getCaseHistory(connection.db, initial.caseId)).toEqual(history);
    expect(await createRecallService(connection.db, context).execute(input)).toMatchObject({ ok: true, replayed: true });
    expect(counts()).toEqual(totals);
  });

  it('replays an old event after newer data without rolling back the current snapshot', async () => {
    const initial = reserve();
    const service = createRecallService(connection.db, context);
    const first = command(initial.caseId);
    await service.execute(first);
    const expanded = command(initial.caseId, expandedLotOutcome, 2);
    expect(await service.execute(expanded)).toMatchObject({ ok: true, appliedCaseVersion: 3 });
    const before = counts();
    expect(await service.execute(first)).toMatchObject({ ok: true, replayed: true, appliedCaseVersion: 2, snapshot: { caseVersion: 3, materialRevision: 2 } });
    expect(counts()).toEqual(before);
    expect(getCaseHistory(connection.db, initial.caseId)[1].snapshot.investigation?.scope).toMatchObject({ lots: ['L-2403'] });
    expect(readCaseSnapshot(connection.db, initial.caseId)?.investigation?.scope).toMatchObject({ lots: ['L-2403', 'L-2404'] });
  });

  it('deduplicates equal outcomes with a new command ID and canonical object-key order', async () => {
    const initial = reserve();
    const service = createRecallService(connection.db, context);
    const first = command(initial.caseId);
    await service.execute(first);
    const before = counts();
    const reordered = Object.fromEntries(Object.entries(first).reverse());
    expect(await service.execute(reordered)).toMatchObject({ ok: true, replayed: true });
    expect(counts()).toEqual(before);
    const duplicate = { ...first, commandId: randomUUID(), expectedCaseVersion: 2 };
    expect(await service.execute(duplicate)).toMatchObject({ ok: true, replayed: true, appliedCaseVersion: 2 });
    expect(getCaseHistory(connection.db, initial.caseId)).toHaveLength(2);
    expect(connection.db.select().from(schema.caseCommands).all()).toHaveLength(2);
  });

  it('rejects stale case versions, older investigations and conflicting keys/revisions without partial writes', async () => {
    const initial = reserve();
    const service = createRecallService(connection.db, context);
    const first = command(initial.caseId);
    await service.execute(first);
    const sameRevisionChanged = command(initial.caseId, { ...confirmedLotOutcome, updatedAt: '2026-09-07T15:00:00Z' }, 2);
    const before = counts();
    expect(await service.execute(sameRevisionChanged)).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(await service.execute({ ...first, expectedCaseVersion: 2 })).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(await service.execute(command(initial.caseId, expandedLotOutcome, 1))).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(counts()).toEqual(before);
    await service.execute(command(initial.caseId, expandedLotOutcome, 2));
    const after = counts();
    expect(await service.execute(command(initial.caseId, confirmedLotOutcome, 3))).toMatchObject({ ok: false, error: { code: 'STALE_INVESTIGATION' } });
    expect(counts()).toEqual(after);
  });

  it('serializes two writers sharing an expected version using independent connections', async () => {
    const initial = reserve();
    const second = createDatabaseConnection(join(directory, 'test.db'));
    try {
      const results = await Promise.all([
        createRecallService(connection.db, context).execute(command(initial.caseId)),
        createRecallService(second.db, context).execute(command(initial.caseId, expandedLotOutcome))
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results).toContainEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'VERSION_CONFLICT' }) }));
      expect(getCaseHistory(connection.db, initial.caseId)).toHaveLength(2);
    } finally { second.sqlite.close(); }
  });

  it('rolls back state and history if the final command ledger insert fails', async () => {
    const initial = reserve();
    const before = counts();
    connection.sqlite.exec("CREATE TRIGGER reject_command BEFORE INSERT ON case_commands BEGIN SELECT RAISE(ABORT, 'test ledger failure'); END;");
    await expect(createRecallService(connection.db, context).execute(command(initial.caseId))).rejects.toThrow('test ledger failure');
    expect(counts()).toEqual(before);
    expect(readCaseSnapshot(connection.db, initial.caseId)).toEqual(initial);
  });

  it('retains gaps and conflicts despite references claiming human approval', async () => {
    const initial = reserve();
    const service = createRecallService(connection.db, context);
    await service.execute(command(initial.caseId, unresolvedScopeOutcome));
    const conflicted: InvestigationOutcome = { ...structuredClone(unresolvedScopeOutcome), materialRevision: 2,
      knowledgeStatus: 'CONFLICTED', conflicts: [{ id: 'demo:conflict', code: 'BATCH_CONFLICT', message: 'Conflicting labels', critical: true, subjectRefs: ['demo:labels'], evidenceRefs: [] }] };
    expect(await service.execute(command(initial.caseId, conflicted, 2))).toMatchObject({ ok: true, snapshot: {
      stage: 'INVESTIGATING', conflicts: conflicted.conflicts, uncertainties: conflicted.gaps,
      investigation: { identity: { conclusion: 'MATCH' }, scope: { kind: 'UNRESOLVED' } }
    } });
  });

  it('rejects foreign product/case data, unsupported payloads, live mode and unimplemented commands', async () => {
    const initial = reserve();
    const service = createRecallService(connection.db, context);
    const input = command(initial.caseId);
    const before = counts();
    expect(await service.execute({ ...input, outcome: { ...input.outcome, productId: randomUUID() } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await service.execute({ ...input, caseId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await service.execute(command(randomUUID()))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await service.execute({ ...input, schemaVersion: 2 })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SCHEMA_VERSION' } });
    expect(await service.execute({ ...input, outcome: { ...input.outcome, scope: { kind: 'WHOLE_PRODUCT' } } })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SCOPE' } });
    expect(await service.execute({ ...input, actorName: 'admin' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await service.execute({ ...input, outcome: { ...input.outcome, demo: false } })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await createRecallService(connection.db, { mode: 'disabled' }).execute(input)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await service.execute({ type: 'REQUEST_CLOSURE', schemaVersion: 1, caseId: initial.caseId, commandId: randomUUID(), expectedCaseVersion: 1, rationale: 'Close anyway', evidenceRefs: ['demo:note'] })).toMatchObject({ ok: false, error: { code: 'NOT_IMPLEMENTED' } });
    expect(counts()).toEqual(before);
  });

  it('does not silently convert a legacy case or reserve an unrelated product', () => {
    expect(reserveInvestigationCase(connection.db, { ...reservation, productId: randomUUID() }, context)).toMatchObject({ ok: false });
    const legacy = confirmReviewMatch(connection.db, { matchId: candidate.id, actorName: 'Herman' });
    const before = counts();
    expect(reserveInvestigationCase(connection.db, reservation, context)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    expect(readCaseSnapshot(connection.db, legacy.caseId)).toBeNull();
    expect(counts()).toEqual(before);
  });

  it('blocks direct legacy review, task, closure and misleading exports for managed cases', async () => {
    const initial = reserve();
    const before = counts();
    for (const action of [
      () => confirmReviewMatch(connection.db, { matchId: candidate.id, actorName: 'Herman' }),
      () => rejectReviewMatch(connection.db, { matchId: candidate.id, actorName: 'Herman' }),
      () => requestMatchEvidence(connection.db, { matchId: candidate.id, actorName: 'Herman', requestedEvidence: ['barcode_photo'] }),
      () => completeCaseTask(connection.db, { caseId: initial.caseId, taskId: randomUUID(), actorName: 'Herman' }),
      () => closeRecallCase(connection.db, { caseId: initial.caseId, actorName: 'Herman', closureNote: 'Attempt closure through old checklist.', evidenceReference: 'demo:note' })
    ]) expect(action).toThrow(/versioned/i);
    await expect(new CaseReportExporter(connection.db).exportCase(initial.caseId, 'csv')).rejects.toThrow(/not implemented/);
    expect(counts()).toEqual(before);
  });

  it('upgrades a populated 0001 database without changing legacy rows and reruns safely', () => {
    const legacyFolder = join(directory, 'legacy-migrations');
    mkdirSync(join(legacyFolder, 'meta'), { recursive: true });
    for (const file of ['0000_initial.sql', '0001_last_living_lightning.sql']) cpSync(join('drizzle', file), join(legacyFolder, file));
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 2);
    writeFileSync(join(legacyFolder, 'meta/_journal.json'), JSON.stringify(journal));
    const legacy = createDatabaseConnection(join(directory, 'legacy.db'));
    try {
      migrate(legacy.db, { migrationsFolder: legacyFolder });
      seedDemoData(legacy.db, fixtures);
      const before = legacy.db.select().from(schema.products).all();
      migrate(legacy.db, { migrationsFolder: resolve('drizzle') });
      migrate(legacy.db, { migrationsFolder: resolve('drizzle') });
      expect(legacy.db.select().from(schema.products).all()).toEqual(before);
      expect(legacy.db.select().from(schema.caseLifecycle).all()).toEqual([]);
      expect(legacy.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally { legacy.sqlite.close(); }
  });
});
