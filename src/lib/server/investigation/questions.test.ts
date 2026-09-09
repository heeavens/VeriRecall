import { randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { count, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { caseSnapshotSchema, type CaseSnapshot } from '../../contracts/recall';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { clearDemoData, seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import {
  applyConfirmedReviewOutcomeInTransaction,
  readCaseSnapshot,
  reserveInvestigationCase
} from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import {
  EvidenceRegistryError,
  getInvestigationEvidence,
  recordInvestigationEvidence
} from './evidence-registry';
import {
  getInvestigationQuestion,
  InvestigationQuestionError,
  listInvestigationQuestions,
  readInvestigationQuestionContext,
  reconcileExistingInvestigationQuestions,
  registerCurrentInvestigationQuestion
} from './questions';
import { produceInvestigationOutcome } from './outcome-producer';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const missingBatchMatchId = '50000000-0000-4000-8000-000000000002';
const registeredAt = '2026-09-09T10:00:00.000Z';
const fixtures = loadDemoFixtures();
let directory: string;
let databasePath: string;
let connection: TestConnection;

function confirmGapCase() {
  const result = confirmReviewMatch(
    connection.db,
    { matchId: missingBatchMatchId, actorName: 'demo_operator' },
    new Date(registeredAt),
    { mode: 'demo' }
  );
  const snapshot = readCaseSnapshot(connection.db, result.caseId);
  const gap = snapshot?.investigation?.gaps.find((issue) => issue.code === 'BATCH_MISSING');
  if (!snapshot || !gap) throw new Error('Expected BATCH_MISSING fixture.');
  return { result, snapshot, gap };
}

function persistSnapshot(snapshot: CaseSnapshot): void {
  connection.db.update(schema.caseLifecycle).set({
    productId: snapshot.productId,
    caseVersion: snapshot.caseVersion,
    materialRevision: snapshot.materialRevision,
    snapshotJson: JSON.stringify(snapshot),
    updatedAt: snapshot.updatedAt
  }).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).run();
  connection.db.insert(schema.caseRevisions).values({
    id: randomUUID(),
    caseId: snapshot.caseId,
    caseVersion: snapshot.caseVersion,
    materialRevision: snapshot.materialRevision,
    snapshotJson: JSON.stringify(snapshot),
    actorId: 'test_fixture',
    createdAt: snapshot.updatedAt
  }).run();
}

function advanceOperationally(current: CaseSnapshot): CaseSnapshot {
  const advanced = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    updatedAt: '2026-09-09T11:00:00.000Z'
  });
  persistSnapshot(advanced);
  return advanced;
}

function removeCurrentGap(current: CaseSnapshot): CaseSnapshot {
  if (!current.investigation) throw new Error('Expected investigation outcome.');
  const evidenceRefs = current.investigation.evidenceRefs;
  const resolved = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    materialRevision: (current.materialRevision ?? 0) + 1,
    updatedAt: '2026-09-09T12:00:00.000Z',
    investigation: {
      ...current.investigation,
      materialRevision: current.investigation.materialRevision + 1,
      updatedAt: '2026-09-09T12:00:00.000Z',
      knowledgeStatus: 'KNOWN',
      identity: {
        ...current.investigation.identity,
        knowledgeStatus: 'KNOWN',
        conclusion: 'MATCH'
      },
      scope: {
        kind: 'BATCH_LOT',
        knowledgeStatus: 'KNOWN',
        lots: ['MFT24'],
        evidenceRefs: [evidenceRefs[0]],
        decisionRefs: []
      },
      gaps: [],
      conflicts: []
    },
    uncertainties: [],
    conflicts: []
  });
  persistSnapshot(resolved);
  return resolved;
}

function expectQuestionError(action: () => unknown, code: InvestigationQuestionError['code']) {
  try {
    action();
    throw new Error('Expected question operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationQuestionError);
    expect(error).toMatchObject({ code });
  }
}

function expectEvidenceError(action: () => unknown, code: EvidenceRegistryError['code']) {
  try {
    action();
    throw new Error('Expected evidence operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceRegistryError);
    expect(error).toMatchObject({ code });
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-questions-'));
  databasePath = join(directory, 'test.db');
  connection = createDatabaseConnection(databasePath);
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('investigation question lineage', () => {
  it('registers the exact Review gap atomically with server-derived identity and origin', () => {
    const { snapshot, gap } = confirmGapCase();
    const question = getInvestigationQuestion(connection.db, snapshot.caseId, gap.id);

    expect(gap.id).toBe(`demo:scope-gap:${missingBatchMatchId}`);
    expect(question).toEqual({
      questionRef: gap.id,
      caseId: snapshot.caseId,
      subjectRef: snapshot.productId,
      questionType: 'AFFECTED_BATCH_LOT',
      originCaseVersion: snapshot.caseVersion,
      originMaterialRevision: snapshot.materialRevision,
      createdAt: registeredAt,
      demo: true
    });
    expect(connection.db.select({ value: count() }).from(schema.auditEvents).get()?.value)
      .toBeGreaterThan(0);
    expect(connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, 'investigation_question_registered')).all())
      .toEqual([]);
  });

  it('derives first authoritative appearance rather than a later operational version', () => {
    const { snapshot, gap } = confirmGapCase();
    connection.db.delete(schema.investigationQuestions).run();
    const advanced = advanceOperationally(snapshot);

    const result = registerCurrentInvestigationQuestion(connection.db, {
      caseId: advanced.caseId,
      questionRef: gap.id,
      expectedCaseVersion: advanced.caseVersion,
      demo: true
    }, { mode: 'demo' });

    expect(result.question).toMatchObject({
      originCaseVersion: snapshot.caseVersion,
      originMaterialRevision: snapshot.materialRevision,
      createdAt: registeredAt
    });
  });

  it('replays immutable lineage before freshness and rejects global reference reuse', () => {
    const { snapshot, gap } = confirmGapCase();
    const replay = registerCurrentInvestigationQuestion(connection.db, {
      caseId: snapshot.caseId,
      questionRef: gap.id,
      expectedCaseVersion: 999,
      demo: true
    }, { mode: 'demo' });
    expect(replay.replayed).toBe(true);

    const other = reserveInvestigationCase(
      connection.db,
      {
        alertId: fixtures.matches[0].alertId,
        productId: fixtures.matches[0].productId
      },
      { mode: 'demo' }
    );
    if (!other.ok) throw new Error(other.error.message);
    expectQuestionError(() => registerCurrentInvestigationQuestion(connection.db, {
      caseId: other.snapshot.caseId,
      questionRef: gap.id,
      expectedCaseVersion: other.snapshot.caseVersion,
      demo: true
    }, { mode: 'demo' }), 'QUESTION_CONFLICT');
  });

  it('rejects invented and duplicated current gap identities', () => {
    const { snapshot, gap } = confirmGapCase();
    connection.db.delete(schema.investigationQuestions).run();
    expectQuestionError(() => registerCurrentInvestigationQuestion(connection.db, {
      caseId: snapshot.caseId,
      questionRef: 'invented:batch-question',
      expectedCaseVersion: snapshot.caseVersion,
      demo: true
    }, { mode: 'demo' }), 'QUESTION_NOT_CURRENT');

    const duplicated = caseSnapshotSchema.parse({
      ...snapshot,
      caseVersion: snapshot.caseVersion + 1,
      updatedAt: '2026-09-09T11:30:00.000Z',
      investigation: {
        ...snapshot.investigation!,
        gaps: [gap, { ...gap }]
      }
    });
    persistSnapshot(duplicated);
    expectQuestionError(() => registerCurrentInvestigationQuestion(connection.db, {
      caseId: snapshot.caseId,
      questionRef: gap.id,
      expectedCaseVersion: duplicated.caseVersion,
      demo: true
    }, { mode: 'demo' }), 'QUESTION_AMBIGUOUS');
  });

  it('rejects a current same-reference Issue with the wrong code', () => {
    const { snapshot, gap } = confirmGapCase();
    connection.db.delete(schema.investigationQuestions).run();
    const wrongMeaning = caseSnapshotSchema.parse({
      ...snapshot,
      caseVersion: snapshot.caseVersion + 1,
      updatedAt: '2026-09-09T11:40:00.000Z',
      investigation: {
        ...snapshot.investigation!,
        gaps: [{ ...gap, code: 'EVIDENCE_MISSING' }]
      }
    });
    persistSnapshot(wrongMeaning);

    expectQuestionError(() => registerCurrentInvestigationQuestion(connection.db, {
      caseId: snapshot.caseId,
      questionRef: gap.id,
      expectedCaseVersion: wrongMeaning.caseVersion,
      demo: true
    }, { mode: 'demo' }), 'QUESTION_NOT_CURRENT');
  });

  it('rolls back Review state if immutable question ownership conflicts atomically', () => {
    const other = reserveInvestigationCase(
      connection.db,
      { alertId: fixtures.matches[0].alertId, productId: fixtures.matches[0].productId },
      { mode: 'demo' }
    );
    if (!other.ok) throw new Error(other.error.message);
    const questionRef = `demo:scope-gap:${missingBatchMatchId}`;
    connection.db.insert(schema.investigationQuestions).values({
      questionRef,
      caseId: other.snapshot.caseId,
      subjectRef: other.snapshot.productId,
      questionType: 'AFFECTED_BATCH_LOT',
      originCaseVersion: 1,
      originMaterialRevision: 1,
      createdAt: registeredAt,
      demo: true
    }).run();

    expect(() => confirmReviewMatch(
      connection.db,
      { matchId: missingBatchMatchId, actorName: 'demo_operator' },
      new Date(registeredAt),
      { mode: 'demo' }
    )).toThrow(InvestigationQuestionError);

    expect(connection.db.select().from(schema.matches)
      .where(eq(schema.matches.id, missingBatchMatchId)).get()?.status).toBe('candidate');
    expect(connection.db.select().from(schema.cases)
      .where(eq(schema.cases.alertId, fixtures.matches[1].alertId)).get()).toBeUndefined();
    expect(connection.db.select().from(schema.investigationQuestions).all()).toHaveLength(1);
  });

  it('exposes only OPEN_GAP or conservative NOT_CURRENT context', () => {
    const { snapshot, gap } = confirmGapCase();
    expect(readInvestigationQuestionContext(connection.db, snapshot.caseId, gap.id))
      .toMatchObject({ contextKind: 'OPEN_GAP' });

    const resolved = removeCurrentGap(snapshot);
    expect(readInvestigationQuestionContext(connection.db, snapshot.caseId, gap.id)).toEqual({
      question: getInvestigationQuestion(connection.db, snapshot.caseId, gap.id),
      contextKind: 'NOT_CURRENT',
      currentCaseVersion: resolved.caseVersion,
      currentMaterialRevision: resolved.materialRevision
    });
    expect(registerCurrentInvestigationQuestion(connection.db, {
      caseId: snapshot.caseId,
      questionRef: gap.id,
      expectedCaseVersion: 999,
      demo: true
    }, { mode: 'demo' }).replayed).toBe(true);
  });

  it('records direct late Evidence for registered lineage without recreating knowledge', () => {
    const { snapshot, gap } = confirmGapCase();
    const resolved = removeCurrentGap(snapshot);
    const beforeJson = connection.db.select({ snapshotJson: schema.caseLifecycle.snapshotJson })
      .from(schema.caseLifecycle).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).get()
      ?.snapshotJson;

    const recorded = recordInvestigationEvidence(connection.db, {
      evidenceRef: 'late:evidence:supplier-invoice',
      caseId: snapshot.caseId,
      questionRef: gap.id,
      evidenceRequestId: null,
      sourceKind: 'EXTERNAL_PARTY',
      sourceIdentifier: 'supplier:invoice:late',
      validAsOf: null,
      contentKind: 'STRUCTURED',
      contentJson: { lot: 'MFT25' },
      contentLocator: null,
      demo: true
    }, new Date('2026-09-09T13:00:00.000Z'));

    expect(recorded.evidence.questionRef).toBe(gap.id);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(resolved);
    expect(connection.db.select({ snapshotJson: schema.caseLifecycle.snapshotJson })
      .from(schema.caseLifecycle).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).get()
      ?.snapshotJson).toBe(beforeJson);
    expect(connection.db.select().from(schema.investigationClaims).all()).toEqual([]);
    expect(connection.db.select().from(schema.investigationAssessments).all()).toEqual([]);
    expect(resolved.investigation?.gaps).toEqual([]);
  });

  it('rejects invented and cross-case Question ownership for new Evidence', () => {
    const { snapshot, gap } = confirmGapCase();
    expectEvidenceError(() => recordInvestigationEvidence(connection.db, {
      evidenceRef: 'evidence:invented-question',
      caseId: snapshot.caseId,
      questionRef: 'invented:question',
      evidenceRequestId: null,
      sourceKind: 'INTERNAL',
      sourceIdentifier: 'internal:test',
      validAsOf: null,
      contentKind: 'STRUCTURED',
      contentJson: { lot: 'MFT24' },
      contentLocator: null,
      demo: true
    }), 'QUESTION_NOT_REGISTERED');

    const other = reserveInvestigationCase(
      connection.db,
      {
        alertId: fixtures.matches[0].alertId,
        productId: fixtures.matches[0].productId
      },
      { mode: 'demo' }
    );
    if (!other.ok) throw new Error(other.error.message);
    expectEvidenceError(() => recordInvestigationEvidence(connection.db, {
      evidenceRef: 'evidence:cross-case-question',
      caseId: other.snapshot.caseId,
      questionRef: gap.id,
      evidenceRequestId: null,
      sourceKind: 'INTERNAL',
      sourceIdentifier: 'internal:test',
      validAsOf: null,
      contentKind: 'STRUCTURED',
      contentJson: { lot: 'MFT24' },
      contentLocator: null,
      demo: true
    }), 'QUESTION_OWNERSHIP_MISMATCH');
  });

  it('reconciles only candidates proven by authoritative revisions and never scans Evidence', () => {
    const { snapshot, gap } = confirmGapCase();
    connection.db.delete(schema.investigationQuestions).run();
    connection.db.insert(schema.evidenceRequests).values({
      id: randomUUID(),
      matchId: missingBatchMatchId,
      caseId: snapshot.caseId,
      questionRef: gap.id,
      requestedEvidence: '["batch_label_photo"]',
      recipient: null,
      status: 'pending',
      createdAt: registeredAt,
      resolvedAt: null
    }).run();
    connection.db.insert(schema.investigationEvidence).values({
      evidenceRef: 'historical:arbitrary:evidence',
      caseId: snapshot.caseId,
      questionRef: 'historical:arbitrary:question',
      evidenceRequestId: null,
      sourceKind: 'INTERNAL',
      sourceIdentifier: 'historical:test',
      receivedAt: registeredAt,
      validAsOf: null,
      contentKind: 'STRUCTURED',
      contentJson: '{"lot":"OTHER"}',
      contentLocator: null,
      integrityHash: 'a'.repeat(64),
      demo: true
    }).run();

    const result = reconcileExistingInvestigationQuestions(connection.db);

    expect(result.registered).toEqual([`${snapshot.caseId}:${gap.id}`]);
    expect(getInvestigationQuestion(connection.db, snapshot.caseId, gap.id)).not.toBeNull();
    expect(getInvestigationQuestion(
      connection.db,
      snapshot.caseId,
      'historical:arbitrary:question'
    )).toBeNull();
    expect(getInvestigationEvidence(
      connection.db,
      snapshot.caseId,
      'historical:arbitrary:evidence'
    )).not.toBeNull();
  });

  it('leaves unverifiable versioned candidates unregistered', () => {
    const reserved = reserveInvestigationCase(
      connection.db,
      {
        alertId: fixtures.matches[0].alertId,
        productId: fixtures.matches[0].productId
      },
      { mode: 'demo' }
    );
    if (!reserved.ok) throw new Error(reserved.error.message);
    connection.db.insert(schema.evidenceRequests).values({
      id: randomUUID(),
      matchId: '50000000-0000-4000-8000-000000000001',
      caseId: reserved.snapshot.caseId,
      questionRef: 'unproven:question',
      requestedEvidence: '["supplier_invoice"]',
      recipient: null,
      status: 'pending',
      createdAt: registeredAt,
      resolvedAt: null
    }).run();

    const result = reconcileExistingInvestigationQuestions(connection.db);
    expect(result.unverified).toEqual([`${reserved.snapshot.caseId}:unproven:question`]);
    expect(listInvestigationQuestions(connection.db, reserved.snapshot.caseId)).toEqual([]);
  });

  it('fails reconciliation closed when a candidate product disagrees with case history', () => {
    const { snapshot, gap } = confirmGapCase();
    connection.db.delete(schema.investigationQuestions).run();
    connection.db.insert(schema.investigationClaims).values({
      claimRef: '92000000-0000-4000-8000-000000000090',
      caseId: snapshot.caseId,
      questionRef: gap.id,
      subjectRef: fixtures.matches[0].productId,
      claimType: 'AFFECTED_BATCH_LOT',
      valueJson: '{"lot":"MFT24"}',
      evidenceRefsJson: '["historical:evidence"]',
      originKind: 'HUMAN_OBSERVED',
      producerIdentifier: 'historical:test',
      derivationMetadataJson: null,
      supersedesClaimRef: null,
      createdAt: registeredAt,
      demo: true
    }).run();

    const result = reconcileExistingInvestigationQuestions(connection.db);
    expect(result.conflicts).toEqual([`${snapshot.caseId}:${gap.id}`]);
    expect(getInvestigationQuestion(connection.db, snapshot.caseId, gap.id)).toBeNull();
  });

  it('is case-scoped, deterministic, and immutable across database reopen', () => {
    const { snapshot, gap } = confirmGapCase();
    const initial = listInvestigationQuestions(connection.db, snapshot.caseId);
    connection.sqlite.close();
    connection = createDatabaseConnection(databasePath);

    expect(listInvestigationQuestions(connection.db, snapshot.caseId)).toEqual(initial);
    expect(getInvestigationQuestion(connection.db, randomUUID(), gap.id)).toBeNull();
  });

  it('clears Question rows after dependent investigation records during demo reset', () => {
    const { snapshot } = confirmGapCase();
    expect(listInvestigationQuestions(connection.db, snapshot.caseId)).toHaveLength(1);
    expect(() => clearDemoData(connection.db)).not.toThrow();
    expect(connection.db.select().from(schema.investigationQuestions).all()).toEqual([]);
    expect(connection.db.select().from(schema.cases).all()).toEqual([]);
  });

  it('upgrades populated 0008 additively, reconciles proven candidates, and reruns safely', () => {
    const preQuestionFolder = join(directory, 'pre-question-migrations');
    mkdirSync(join(preQuestionFolder, 'meta'), { recursive: true });
    for (const file of [
      '0000_initial.sql',
      '0001_last_living_lightning.sql',
      '0002_case_lifecycle.sql',
      '0003_traceability_exposure.sql',
      '0004_last_thunderbolt.sql',
      '0005_majestic_centennial.sql',
      '0006_cynical_rictor.sql',
      '0007_calm_captain_cross.sql',
      '0008_warm_zarek.sql'
    ]) cpSync(join('drizzle', file), join(preQuestionFolder, file));
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 9);
    writeFileSync(join(preQuestionFolder, 'meta/_journal.json'), JSON.stringify(journal));

    const existing = createDatabaseConnection(join(directory, 'populated-0008.db'));
    try {
      migrate(existing.db, { migrationsFolder: preQuestionFolder });
      seedDemoData(existing.db, fixtures);
      const match = fixtures.matches[1];
      const alert = fixtures.alerts.find((item) => item.id === match.alertId)!;
      const product = fixtures.products.find((item) => item.id === match.productId)!;
      const reserved = reserveInvestigationCase(
        existing.db,
        { alertId: alert.id, productId: product.id },
        { mode: 'demo' },
        new Date(registeredAt)
      );
      if (!reserved.ok) throw new Error(reserved.error.message);
      const outcome = produceInvestigationOutcome({
        caseId: reserved.snapshot.caseId,
        productId: product.id,
        matchId: match.id,
        materialRevision: 1,
        updatedAt: registeredAt,
        alertEan: alert.ean ?? null,
        catalogueEan: product.ean ?? null,
        alertBatch: alert.batch ?? null,
        catalogueBatch: product.batch ?? null,
        hasHardIdentityConflict: match.hasHardConflict ?? false,
        evidenceRefs: {
          alert: `demo:alert:${alert.id}`,
          catalogueProduct: `demo:catalogue:${product.id}`,
          match: `demo:match:${match.id}`,
          alertBatch: `demo:alert-batch:${alert.id}`,
          catalogueBatch: `demo:catalogue-batch:${product.id}`
        },
        decisionRefs: { review: `demo:review-decision:${match.id}` },
        demo: true
      });
      existing.db.update(schema.matches).set({
        status: 'confirmed',
        decidedAt: registeredAt
      }).where(eq(schema.matches.id, match.id)).run();
      const applied = applyConfirmedReviewOutcomeInTransaction(existing.db, {
        caseId: reserved.snapshot.caseId,
        productId: product.id,
        eventId: match.id,
        outcome
      }, { mode: 'demo' }, new Date(registeredAt));
      if (!applied.ok) throw new Error(applied.error.message);
      const gap = applied.snapshot.investigation?.gaps.find(
        (issue) => issue.code === 'BATCH_MISSING'
      );
      if (!gap) throw new Error('Expected historical BATCH_MISSING gap.');
      const requestId = randomUUID();
      existing.db.insert(schema.evidenceRequests).values({
        id: requestId,
        matchId: match.id,
        caseId: applied.snapshot.caseId,
        questionRef: gap.id,
        requestedEvidence: '["supplier_invoice"]',
        recipient: product.supplierEmail,
        status: 'pending',
        createdAt: registeredAt,
        resolvedAt: null
      }).run();
      const before = {
        snapshot: readCaseSnapshot(existing.db, applied.snapshot.caseId),
        request: existing.db.select().from(schema.evidenceRequests)
          .where(eq(schema.evidenceRequests.id, requestId)).get()
      };

      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      expect(existing.db.select().from(schema.investigationQuestions).all()).toEqual([]);
      expect(reconcileExistingInvestigationQuestions(existing.db).registered)
        .toEqual([`${applied.snapshot.caseId}:${gap.id}`]);
      expect({
        snapshot: readCaseSnapshot(existing.db, applied.snapshot.caseId),
        request: existing.db.select().from(schema.evidenceRequests)
          .where(eq(schema.evidenceRequests.id, requestId)).get()
      }).toEqual(before);
      expect(existing.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      existing.sqlite.close();
    }
  });
});
