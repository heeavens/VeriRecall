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

import { and, count, eq } from 'drizzle-orm';
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { caseSnapshotSchema, type CaseSnapshot } from '../../contracts/recall';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { clearDemoData, seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import {
  getCaseHistory,
  readCaseSnapshot
} from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import {
  InvestigationAssessmentError,
  recordInvestigationAssessment
} from './assessments';
import {
  getInvestigationChallenge,
  InvestigationChallengeError,
  listInvestigationChallenges,
  openInvestigationChallenge,
  readInvestigationChallengeContext,
  type OpenInvestigationChallengeInput
} from './challenges';
import { InvestigationClaimError, recordInvestigationClaim } from './claims';
import {
  EffectiveAnalysisError,
  readEffectiveInvestigationAnalysis
} from './effective-analysis';
import { recordInvestigationEvidence } from './evidence-registry';
import {
  InvestigationEvidenceRequestError,
  requestInvestigationEvidence
} from './evidence-requests';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const missingBatchMatchId = '50000000-0000-4000-8000-000000000002';
const gapAt = '2026-09-09T10:00:00.000Z';
const answerAt = '2026-09-09T12:00:00.000Z';
const lateAt = '2026-09-09T13:00:00.000Z';
const challengeAt = '2026-09-09T14:00:00.000Z';
const fixtures = loadDemoFixtures();
let directory: string;
let databasePath: string;
let connection: TestConnection;

function tableCount(table: AnySQLiteTable): number {
  return connection.db.select({ value: count() }).from(table).get()?.value ?? 0;
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

function confirmGapCase() {
  const result = confirmReviewMatch(
    connection.db,
    { matchId: missingBatchMatchId, actorName: 'demo_operator' },
    new Date(gapAt),
    { mode: 'demo' }
  );
  const snapshot = readCaseSnapshot(connection.db, result.caseId);
  const gap = snapshot?.investigation?.gaps.find((issue) => issue.code === 'BATCH_MISSING');
  if (!snapshot || !gap) throw new Error('Expected the BATCH_MISSING fixture.');
  return { snapshot, gap };
}

function resolveGap(current: CaseSnapshot, at = answerAt): CaseSnapshot {
  if (!current.investigation) throw new Error('Expected an investigation outcome.');
  const resolvedMaterialRevision = (current.materialRevision ?? 0) + 1;
  const resolved = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    materialRevision: resolvedMaterialRevision,
    updatedAt: at,
    investigation: {
      ...current.investigation,
      materialRevision: resolvedMaterialRevision,
      updatedAt: at,
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
        evidenceRefs: [current.investigation.evidenceRefs[0]],
        decisionRefs: current.investigation.decisionRefs
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

function advanceOperationally(current: CaseSnapshot, at = '2026-09-09T15:00:00.000Z') {
  const advanced = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    updatedAt: at
  });
  persistSnapshot(advanced);
  return advanced;
}

function reopenQuestion(
  current: CaseSnapshot,
  gap: NonNullable<CaseSnapshot['investigation']>['gaps'][number],
  at: string
): CaseSnapshot {
  if (!current.investigation || current.materialRevision === null) {
    throw new Error('Expected a material investigation.');
  }
  const materialRevision = current.materialRevision + 1;
  const reopened = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    materialRevision,
    stage: 'INVESTIGATING',
    updatedAt: at,
    investigation: {
      ...current.investigation,
      materialRevision,
      updatedAt: at,
      knowledgeStatus: 'UNRESOLVED',
      scope: {
        kind: 'UNRESOLVED',
        knowledgeStatus: 'UNKNOWN',
        reason: 'The affected batch requires re-investigation.',
        evidenceRefs: [],
        decisionRefs: []
      },
      gaps: [gap],
      conflicts: []
    },
    exposure: {
      ...current.exposure,
      status: 'NOT_CALCULATED',
      basisMaterialRevision: null,
      calculatedAt: null
    },
    uncertainties: [gap],
    conflicts: [],
    attentionItems: [],
    pendingDecisions: [],
    closure: { status: 'NOT_READY', blockers: [{
      id: `demo:blocker:investigation:${current.caseId}`,
      code: 'INVESTIGATION_UNRESOLVED',
      message: 'Resolve the current investigation before closure.',
      critical: true,
      subjectRefs: [current.productId],
      evidenceRefs: []
    }], decisionRef: null }
  });
  persistSnapshot(reopened);
  return reopened;
}

function recordEvidence(
  caseId: string,
  questionRef: string,
  evidenceRef: string,
  receivedAt: string,
  validAsOf: string | null = null
) {
  return recordInvestigationEvidence(connection.db, {
    evidenceRef,
    caseId,
    questionRef,
    evidenceRequestId: null,
    sourceKind: 'EXTERNAL_PARTY',
    sourceIdentifier: `supplier:${evidenceRef}`,
    validAsOf,
    contentKind: 'STRUCTURED',
    contentJson: { assertedLot: 'MFT25' },
    contentLocator: null,
    demo: true
  }, new Date(receivedAt));
}

function challengeInput(
  snapshot: CaseSnapshot,
  questionRef: string,
  triggerEvidenceRefs: string[],
  challengeRef = randomUUID()
): OpenInvestigationChallengeInput {
  if (snapshot.materialRevision === null) throw new Error('Expected a material revision.');
  return {
    challengeRef,
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    expectedMaterialRevision: snapshot.materialRevision,
    triggerEvidenceRefs,
    rationale: 'Late supplier evidence requires a factual re-review.',
    demo: true
  };
}

function expectChallengeError(
  action: () => unknown,
  code: InvestigationChallengeError['code']
): void {
  try {
    action();
    throw new Error('Expected Challenge operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationChallengeError);
    expect(error).toMatchObject({ code });
  }
}

function makeClosed(current: CaseSnapshot): CaseSnapshot {
  if (!current.investigation || current.materialRevision === null ||
      current.investigation.scope.kind !== 'BATCH_LOT') {
    throw new Error('Expected a resolved batch investigation.');
  }
  const at = '2026-09-09T12:30:00.000Z';
  const source = {
    sourceRef: 'demo:closed:derived',
    sourceType: 'DERIVED' as const,
    asOf: at,
    demo: true
  };
  const knownZero = {
    value: 0,
    unit: 'ITEM' as const,
    knowledgeStatus: 'KNOWN' as const,
    sources: [source],
    asOf: at
  };
  const coverage = current.investigation.scope;
  const decision = (id: string, type: 'CONFIRM_IDENTITY' | 'CONFIRM_SCOPE' | 'CLOSE_CASE') => ({
    id,
    type,
    status: 'APPROVED' as const,
    subjectRef: type === 'CLOSE_CASE' ? current.caseId : current.productId,
    basisCaseVersion: current.caseVersion + 1,
    basisMaterialRevision: current.materialRevision!,
    coverage,
    evidenceRefs: current.investigation!.evidenceRefs,
    uncertaintyRefs: [],
    conflictRefs: [],
    consequence: 'Trusted demo operator reviewed the current known batch basis.',
    rationale: 'Test-only closed-case fixture.',
    actorId: 'demo_operator',
    actorRole: 'CASE_MANAGER',
    decidedAt: at,
    demo: true
  });
  const closeDecisionId = randomUUID();
  return caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    stage: 'CLOSED',
    updatedAt: at,
    exposure: {
      status: 'CALCULATED',
      basisMaterialRevision: current.materialRevision,
      calculatedAt: at,
      received: knownZero,
      warehouse: knownZero,
      inTransit: knownZero,
      retailer: knownZero,
      sold: knownZero,
      unaccounted: knownZero,
      contained: knownZero,
      gaps: [],
      conflicts: []
    },
    tasks: [],
    uncertainties: [],
    conflicts: [],
    attentionItems: [],
    pendingDecisions: [],
    decisions: [
      decision(randomUUID(), 'CONFIRM_IDENTITY'),
      decision(randomUUID(), 'CONFIRM_SCOPE'),
      decision(closeDecisionId, 'CLOSE_CASE')
    ],
    closure: { status: 'CLOSED', blockers: [], decisionRef: closeDecisionId }
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-challenges-'));
  databasePath = join(directory, 'test.db');
  connection = createDatabaseConnection(databasePath);
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('resolved-question Challenges', () => {
  it('does not create a Challenge merely because late Evidence arrives', () => {
    const { snapshot, gap } = confirmGapCase();
    resolveGap(snapshot);
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:alone', lateAt);
    expect(connection.db.select().from(schema.investigationChallenges).all()).toEqual([]);
  });

  it('opens one immutable human Challenge from the complete late-Evidence corpus', () => {
    const { snapshot, gap } = confirmGapCase();
    recordEvidence(snapshot.caseId, gap.id, 'evidence:before', '2026-09-09T11:00:00.000Z');
    const resolved = resolveGap(snapshot);
    recordEvidence(
      snapshot.caseId,
      gap.id,
      'evidence:late:b',
      lateAt,
      '2024-01-01T00:00:00.000Z'
    );
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:a', '2026-09-09T13:30:00.000Z');
    const beforeSnapshot = connection.db.select({ value: schema.caseLifecycle.snapshotJson })
      .from(schema.caseLifecycle).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).get()
      ?.value;
    const before = {
      revisions: tableCount(schema.caseRevisions),
      commands: tableCount(schema.caseCommands),
      decisions: readCaseSnapshot(connection.db, snapshot.caseId)?.decisions.length,
      requests: tableCount(schema.evidenceRequests),
      claims: tableCount(schema.investigationClaims),
      assessments: tableCount(schema.investigationAssessments),
      establishments: tableCount(schema.investigationEstablishments),
      evidence: tableCount(schema.investigationEvidence),
      questions: tableCount(schema.investigationQuestions),
      tasks: tableCount(schema.caseTasks),
      traceability: tableCount(schema.traceabilityRecords),
      matches: tableCount(schema.matches),
      alerts: tableCount(schema.alerts),
      actionDrafts: tableCount(schema.actionDrafts),
      caseItems: tableCount(schema.caseItems)
    };
    const answerRevision = getCaseHistory(connection.db, snapshot.caseId)
      .find((revision) => revision.materialRevision === resolved.materialRevision)!;
    const answerRevisionId = connection.db.select({ id: schema.caseRevisions.id })
      .from(schema.caseRevisions)
      .where(and(
        eq(schema.caseRevisions.caseId, snapshot.caseId),
        eq(schema.caseRevisions.caseVersion, answerRevision.caseVersion)
      )).get()!.id;

    const result = openInvestigationChallenge(connection.db, challengeInput(
      resolved,
      gap.id,
      ['evidence:late:b', 'evidence:late:a', 'evidence:late:b']
    ), { mode: 'demo' }, new Date(challengeAt));

    expect(result).toEqual({
      challenge: {
        challengeRef: result.challenge.challengeRef,
        caseId: snapshot.caseId,
        questionRef: gap.id,
        challengedRevisionId: answerRevisionId,
        challengedMaterialRevision: resolved.materialRevision,
        openedCaseVersion: resolved.caseVersion,
        triggerEvidenceRefs: ['evidence:late:a', 'evidence:late:b'],
        openedByKind: 'HUMAN',
        openedByIdentifier: 'demo_operator',
        rationale: 'Late supplier evidence requires a factual re-review.',
        createdAt: challengeAt,
        demo: true
      },
      replayed: false
    });
    expect(readInvestigationChallengeContext(
      connection.db,
      snapshot.caseId,
      result.challenge.challengeRef
    )).toMatchObject({ contextKind: 'CURRENT', reasonCodes: [] });
    expect(connection.db.select({ value: schema.caseLifecycle.snapshotJson })
      .from(schema.caseLifecycle).where(eq(schema.caseLifecycle.caseId, snapshot.caseId)).get()
      ?.value).toBe(beforeSnapshot);
    expect({
      revisions: tableCount(schema.caseRevisions),
      commands: tableCount(schema.caseCommands),
      decisions: readCaseSnapshot(connection.db, snapshot.caseId)?.decisions.length,
      requests: tableCount(schema.evidenceRequests),
      claims: tableCount(schema.investigationClaims),
      assessments: tableCount(schema.investigationAssessments),
      establishments: tableCount(schema.investigationEstablishments),
      evidence: tableCount(schema.investigationEvidence),
      questions: tableCount(schema.investigationQuestions),
      tasks: tableCount(schema.caseTasks),
      traceability: tableCount(schema.traceabilityRecords),
      matches: tableCount(schema.matches),
      alerts: tableCount(schema.alerts),
      actionDrafts: tableCount(schema.actionDrafts),
      caseItems: tableCount(schema.caseItems)
    }).toEqual(before);
    const audits = connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, 'investigation_challenge_opened')).all();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: snapshot.caseId,
      eventType: 'investigation_challenge_opened',
      actorType: 'human',
      actorName: 'demo_operator',
      createdAt: challengeAt
    });
    expect(JSON.parse(audits[0].metadataJson)).toMatchObject({
      challengeRef: result.challenge.challengeRef,
      caseId: snapshot.caseId,
      questionRef: gap.id,
      challengedRevisionId: answerRevisionId,
      challengedMaterialRevision: resolved.materialRevision,
      openedCaseVersion: resolved.caseVersion,
      triggerEvidenceRefs: ['evidence:late:a', 'evidence:late:b'],
      openedByKind: 'HUMAN',
      openedByIdentifier: 'demo_operator',
      demo: true
    });
  });

  it('requires registered ownership and rejects current or unproven Questions', () => {
    const { snapshot, gap } = confirmGapCase();
    expectChallengeError(() => openInvestigationChallenge(connection.db, challengeInput(
      snapshot,
      gap.id,
      ['evidence:none']
    ), { mode: 'demo' }), 'QUESTION_OPEN');

    const resolved = resolveGap(snapshot);
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:ownership', lateAt);
    expectChallengeError(() => openInvestigationChallenge(connection.db, {
      ...challengeInput(resolved, gap.id, ['evidence:late:ownership']),
      questionRef: 'invented:question'
    }, { mode: 'demo' }), 'QUESTION_NOT_FOUND');
    expectChallengeError(() => openInvestigationChallenge(connection.db, {
      ...challengeInput(resolved, gap.id, ['evidence:late:ownership']),
      caseId: randomUUID()
    }, { mode: 'demo' }), 'QUESTION_NOT_FOUND');

    connection.db.update(schema.investigationQuestions)
      .set({ subjectRef: fixtures.products[0].id })
      .where(eq(schema.investigationQuestions.questionRef, gap.id)).run();
    expectChallengeError(() => openInvestigationChallenge(connection.db, challengeInput(
      resolved,
      gap.id,
      ['evidence:late:ownership']
    ), { mode: 'demo' }), 'QUESTION_OWNERSHIP_MISMATCH');
  });

  it('keeps Challenge authorization HUMAN/demo-only and server-owned', () => {
    const { snapshot, gap } = confirmGapCase();
    const resolved = resolveGap(snapshot);
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:actor', lateAt);
    const input = challengeInput(resolved, gap.id, ['evidence:late:actor']);
    expectChallengeError(() => openInvestigationChallenge(
      connection.db,
      input,
      { mode: 'disabled' }
    ), 'FORBIDDEN');
    expectChallengeError(() => openInvestigationChallenge(connection.db, {
      ...input,
      openedByKind: 'AI',
      openedByIdentifier: 'caller-selected'
    } as OpenInvestigationChallengeInput, { mode: 'demo' }), 'INVALID_INPUT');
    expectChallengeError(() => openInvestigationChallenge(connection.db, {
      ...input,
      demo: false
    }, { mode: 'demo' }), 'FORBIDDEN');
    expect(connection.db.select().from(schema.investigationChallenges).all()).toEqual([]);
  });

  it('requires a known MATCH identity and known nonempty batch answer', () => {
    const { snapshot, gap } = confirmGapCase();
    const resolved = resolveGap(snapshot);
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:answer', lateAt);
    const invalidStates = [
      {
        ...resolved.investigation!,
        knowledgeStatus: 'UNRESOLVED' as const,
        identity: {
          ...resolved.investigation!.identity,
          knowledgeStatus: 'UNKNOWN' as const,
          conclusion: 'UNRESOLVED' as const
        }
      },
      {
        ...resolved.investigation!,
        knowledgeStatus: 'UNRESOLVED' as const,
        scope: {
          kind: 'UNRESOLVED' as const,
          knowledgeStatus: 'UNKNOWN' as const,
          reason: 'No authoritative batch answer.',
          evidenceRefs: [],
          decisionRefs: []
        }
      }
    ];
    for (const [index, investigation] of invalidStates.entries()) {
      const changedMaterial = (resolved.materialRevision ?? 0) + index + 1;
      const changed = caseSnapshotSchema.parse({
        ...resolved,
        caseVersion: resolved.caseVersion + index + 1,
        materialRevision: changedMaterial,
        updatedAt: `2026-09-09T1${5 + index}:00:00.000Z`,
        investigation: {
          ...investigation,
          materialRevision: changedMaterial,
          updatedAt: `2026-09-09T1${5 + index}:00:00.000Z`
        }
      });
      persistSnapshot(changed);
      expectChallengeError(() => openInvestigationChallenge(connection.db, challengeInput(
        changed,
        gap.id,
        ['evidence:late:answer']
      ), { mode: 'demo' }), 'QUESTION_NOT_ANSWERED');
    }
    expect(caseSnapshotSchema.safeParse({
      ...resolved,
      investigation: {
        ...resolved.investigation!,
        scope: { ...resolved.investigation!.scope, lots: [' '] }
      }
    }).success).toBe(false);
  });

  it('fails closed when the immediately preceding material state answers another or ambiguous Question', () => {
    const first = confirmGapCase();
    const unrelated = {
      ...first.gap,
      id: 'demo:scope-gap:unrelated'
    };
    const unrelatedState = caseSnapshotSchema.parse({
      ...first.snapshot,
      caseVersion: first.snapshot.caseVersion + 1,
      updatedAt: '2026-09-09T11:00:00.000Z',
      investigation: {
        ...first.snapshot.investigation!,
        gaps: [unrelated]
      },
      uncertainties: [unrelated]
    });
    persistSnapshot(unrelatedState);
    const resolved = resolveGap(unrelatedState);
    recordEvidence(resolved.caseId, first.gap.id, 'evidence:late:unrelated', lateAt);
    expectChallengeError(() => openInvestigationChallenge(connection.db, challengeInput(
      resolved,
      first.gap.id,
      ['evidence:late:unrelated']
    ), { mode: 'demo' }), 'ANSWER_CONTINUITY_AMBIGUOUS');

    connection.db.delete(schema.caseRevisions)
      .where(eq(schema.caseRevisions.caseVersion, unrelatedState.caseVersion)).run();
    const ambiguous = caseSnapshotSchema.parse({
      ...first.snapshot,
      caseVersion: first.snapshot.caseVersion + 1,
      updatedAt: '2026-09-09T11:00:00.000Z',
      investigation: {
        ...first.snapshot.investigation!,
        gaps: [first.gap, unrelated]
      },
      uncertainties: [first.gap, unrelated]
    });
    persistSnapshot(ambiguous);
    connection.db.update(schema.caseLifecycle).set({
      productId: resolved.productId,
      caseVersion: resolved.caseVersion,
      materialRevision: resolved.materialRevision,
      snapshotJson: JSON.stringify(resolved),
      updatedAt: resolved.updatedAt
    }).where(eq(schema.caseLifecycle.caseId, resolved.caseId)).run();
    expectChallengeError(() => openInvestigationChallenge(connection.db, challengeInput(
      resolved,
      first.gap.id,
      ['evidence:late:unrelated']
    ), { mode: 'demo' }), 'ANSWER_CONTINUITY_AMBIGUOUS');
  });

  it('fails closed when the current answer is missing from authoritative revision history', () => {
    const { snapshot, gap } = confirmGapCase();
    const resolved = resolveGap(snapshot);
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:missing-history', lateAt);
    connection.db.delete(schema.caseRevisions).where(and(
      eq(schema.caseRevisions.caseId, snapshot.caseId),
      eq(schema.caseRevisions.caseVersion, resolved.caseVersion)
    )).run();

    expectChallengeError(() => openInvestigationChallenge(connection.db, challengeInput(
      resolved,
      gap.id,
      ['evidence:late:missing-history']
    ), { mode: 'demo' }), 'ANSWER_CONTINUITY_UNPROVEN');
  });

  it('checks both freshness dimensions before making writes', () => {
    const { snapshot, gap } = confirmGapCase();
    const resolved = resolveGap(snapshot);
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:freshness', lateAt);
    const input = challengeInput(resolved, gap.id, ['evidence:late:freshness']);
    expectChallengeError(() => openInvestigationChallenge(connection.db, {
      ...input,
      expectedCaseVersion: input.expectedCaseVersion - 1
    }, { mode: 'demo' }), 'STALE_CASE_VERSION');
    expectChallengeError(() => openInvestigationChallenge(connection.db, {
      ...input,
      expectedMaterialRevision: input.expectedMaterialRevision - 1
    }, { mode: 'demo' }), 'STALE_MATERIAL_REVISION');
    expect(connection.db.select().from(schema.investigationChallenges).all()).toEqual([]);
    expect(connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, 'investigation_challenge_opened')).all())
      .toEqual([]);
  });

  it('uses receipt time and requires the exact complete late-Evidence set', () => {
    const { snapshot, gap } = confirmGapCase();
    recordEvidence(snapshot.caseId, gap.id, 'evidence:before', '2026-09-09T11:59:59.999Z');
    const resolved = resolveGap(snapshot);
    recordEvidence(
      snapshot.caseId,
      gap.id,
      'evidence:equal',
      answerAt,
      '2030-01-01T00:00:00.000Z'
    );
    expectChallengeError(() => openInvestigationChallenge(connection.db, challengeInput(
      resolved,
      gap.id,
      ['evidence:equal']
    ), { mode: 'demo' }), 'LATE_EVIDENCE_REQUIRED');

    recordEvidence(
      snapshot.caseId,
      gap.id,
      'evidence:late:first',
      lateAt,
      '2020-01-01T00:00:00.000Z'
    );
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:second', '2026-09-09T13:30:00.000Z');
    const otherCaseId = randomUUID();
    connection.db.insert(schema.cases).values({
      id: otherCaseId,
      caseNumber: 'CASE-CROSS-EVIDENCE',
      alertId: fixtures.alerts[0].id,
      status: 'open',
      severity: 'high',
      openedAt: gapAt,
      closedAt: null
    }).run();
    connection.db.insert(schema.investigationEvidence).values({
      evidenceRef: 'evidence:other-case',
      caseId: otherCaseId,
      questionRef: 'other:question',
      evidenceRequestId: null,
      sourceKind: 'INTERNAL',
      sourceIdentifier: 'internal:other-case',
      receivedAt: lateAt,
      validAsOf: null,
      contentKind: 'STRUCTURED',
      contentJson: '{}',
      contentLocator: null,
      integrityHash: 'a'.repeat(64),
      demo: true
    }).run();
    expectChallengeError(() => openInvestigationChallenge(connection.db, challengeInput(
      resolved,
      gap.id,
      ['evidence:late:first']
    ), { mode: 'demo' }), 'TRIGGER_EVIDENCE_MISMATCH');
    expectChallengeError(() => openInvestigationChallenge(connection.db, challengeInput(
      resolved,
      gap.id,
      ['evidence:late:first', 'evidence:late:second', 'evidence:equal']
    ), { mode: 'demo' }), 'TRIGGER_EVIDENCE_MISMATCH');
    expectChallengeError(() => openInvestigationChallenge(connection.db, challengeInput(
      resolved,
      gap.id,
      ['evidence:late:first', 'evidence:late:second', 'evidence:other-case']
    ), { mode: 'demo' }), 'TRIGGER_EVIDENCE_MISMATCH');
  });

  it('is idempotent before freshness checks and rejects another ID for the same answer', () => {
    const { snapshot, gap } = confirmGapCase();
    const resolved = resolveGap(snapshot);
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:replay', lateAt);
    const challengeRef = randomUUID();
    const input = challengeInput(resolved, gap.id, ['evidence:late:replay'], challengeRef);
    const created = openInvestigationChallenge(
      connection.db,
      input,
      { mode: 'demo' },
      new Date(challengeAt)
    );
    const advanced = advanceOperationally(resolved);
    recordEvidence(snapshot.caseId, gap.id, 'evidence:later:after-open', '2026-09-09T16:00:00.000Z');

    const replay = openInvestigationChallenge(connection.db, {
      ...input,
      expectedCaseVersion: 999,
      expectedMaterialRevision: 999
    }, { mode: 'demo' });
    expect(replay).toEqual({ challenge: created.challenge, replayed: true });
    expect(readInvestigationChallengeContext(connection.db, snapshot.caseId, challengeRef))
      .toMatchObject({
        contextKind: 'CURRENT',
        currentCaseVersion: advanced.caseVersion,
        currentMaterialRevision: advanced.materialRevision
      });
    expect(getInvestigationChallenge(connection.db, snapshot.caseId, challengeRef)
      ?.triggerEvidenceRefs).toEqual(['evidence:late:replay']);
    expect(connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, 'investigation_challenge_opened')).all())
      .toHaveLength(1);

    expectChallengeError(() => openInvestigationChallenge(connection.db, {
      ...input,
      rationale: 'Changed immutable rationale.'
    }, { mode: 'demo' }), 'CHALLENGE_CONFLICT');
    expectChallengeError(() => openInvestigationChallenge(connection.db, {
      ...input,
      caseId: randomUUID()
    }, { mode: 'demo' }), 'CHALLENGE_CONFLICT');
    expectChallengeError(() => openInvestigationChallenge(connection.db, {
      ...input,
      questionRef: 'different:question'
    }, { mode: 'demo' }), 'CHALLENGE_CONFLICT');
    expectChallengeError(() => openInvestigationChallenge(connection.db, {
      ...input,
      triggerEvidenceRefs: ['different:evidence']
    }, { mode: 'demo' }), 'CHALLENGE_CONFLICT');
    expectChallengeError(() => openInvestigationChallenge(connection.db, {
      ...input,
      demo: false
    }, { mode: 'demo' }), 'CHALLENGE_CONFLICT');
    expectChallengeError(() => openInvestigationChallenge(connection.db, challengeInput(
      advanced,
      gap.id,
      ['evidence:late:replay'],
      randomUUID()
    ), { mode: 'demo' }), 'CHALLENGE_ALREADY_EXISTS');
  });

  it('allows one later Challenge after a new authoritative Question-answer cycle', () => {
    const { snapshot, gap } = confirmGapCase();
    const firstAnswer = resolveGap(snapshot);
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:cycle-one', lateAt);
    const first = openInvestigationChallenge(connection.db, challengeInput(
      firstAnswer,
      gap.id,
      ['evidence:late:cycle-one']
    ), { mode: 'demo' }, new Date(challengeAt)).challenge;

    const reopened = reopenQuestion(firstAnswer, gap, '2026-09-09T17:00:00.000Z');
    const secondAnswer = resolveGap(reopened, '2026-09-09T18:00:00.000Z');
    recordEvidence(
      snapshot.caseId,
      gap.id,
      'evidence:late:cycle-two',
      '2026-09-09T19:00:00.000Z'
    );
    const second = openInvestigationChallenge(connection.db, challengeInput(
      secondAnswer,
      gap.id,
      ['evidence:late:cycle-two']
    ), { mode: 'demo' }, new Date('2026-09-09T20:00:00.000Z')).challenge;

    expect(second.challengedMaterialRevision).toBe(secondAnswer.materialRevision);
    expect(second.challengedMaterialRevision).not.toBe(first.challengedMaterialRevision);
    expect(listInvestigationChallenges(connection.db, snapshot.caseId, gap.id)
      .map((challenge) => challenge.challengeRef))
      .toEqual([first.challengeRef, second.challengeRef]);
    expect(readInvestigationChallengeContext(connection.db, snapshot.caseId, first.challengeRef))
      .toMatchObject({ contextKind: 'HISTORICAL' });
    expect(readInvestigationChallengeContext(connection.db, snapshot.caseId, second.challengeRef))
      .toMatchObject({ contextKind: 'CURRENT' });
  });

  it('becomes historical only when authoritative answer context changes materially', () => {
    const { snapshot, gap } = confirmGapCase();
    const resolved = resolveGap(snapshot);
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:context', lateAt);
    const result = openInvestigationChallenge(connection.db, challengeInput(
      resolved,
      gap.id,
      ['evidence:late:context']
    ), { mode: 'demo' });
    const operational = advanceOperationally(resolved);
    expect(readInvestigationChallengeContext(
      connection.db,
      snapshot.caseId,
      result.challenge.challengeRef
    )).toMatchObject({ contextKind: 'CURRENT', currentCaseVersion: operational.caseVersion });

    const changedMaterialRevision = operational.materialRevision! + 1;
    const changed = caseSnapshotSchema.parse({
      ...operational,
      caseVersion: operational.caseVersion + 1,
      materialRevision: changedMaterialRevision,
      updatedAt: '2026-09-09T17:00:00.000Z',
      investigation: {
        ...operational.investigation!,
        materialRevision: changedMaterialRevision,
        updatedAt: '2026-09-09T17:00:00.000Z'
      }
    });
    persistSnapshot(changed);
    expect(readInvestigationChallengeContext(
      connection.db,
      snapshot.caseId,
      result.challenge.challengeRef
    )).toMatchObject({
      contextKind: 'HISTORICAL',
      reasonCodes: ['MATERIAL_REVISION_CHANGED']
    });
  });

  it('allows a CLOSED case Challenge without reopening or changing its stage', () => {
    const { snapshot, gap } = confirmGapCase();
    const resolved = resolveGap(snapshot);
    const closed = makeClosed(resolved);
    persistSnapshot(closed);
    connection.db.update(schema.cases).set({
      status: 'closed',
      closedAt: closed.updatedAt
    }).where(eq(schema.cases.id, closed.caseId)).run();
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:closed', lateAt);

    openInvestigationChallenge(connection.db, challengeInput(
      closed,
      gap.id,
      ['evidence:late:closed']
    ), { mode: 'demo' });

    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(closed);
    expect(connection.db.select().from(schema.cases)
      .where(eq(schema.cases.id, snapshot.caseId)).get()).toMatchObject({
      status: 'closed',
      closedAt: closed.updatedAt
    });
  });

  it('leaves every post-resolution analysis writer and projection OPEN_GAP-only', () => {
    const { snapshot, gap } = confirmGapCase();
    const resolved = resolveGap(snapshot);
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:still-blocked', lateAt);
    const evidenceRequest = () => requestInvestigationEvidence(connection.db, {
      requestId: randomUUID(),
      caseId: snapshot.caseId,
      questionRef: gap.id,
      expectedCaseVersion: resolved.caseVersion,
      requestedEvidence: ['supplier_invoice'],
      demo: true
    }, { mode: 'demo' });
    const claim = () => recordInvestigationClaim(connection.db, {
      claimRef: randomUUID(),
      caseId: snapshot.caseId,
      questionRef: gap.id,
      expectedCaseVersion: resolved.caseVersion,
      claimType: 'AFFECTED_BATCH_LOT',
      value: { lot: 'MFT25' },
      evidenceRefs: ['evidence:late:still-blocked'],
      originKind: 'HUMAN_OBSERVED',
      producerIdentifier: 'demo_operator',
      derivationMetadata: null,
      supersedesClaimRef: null,
      demo: true
    }, { mode: 'demo' });
    const assessment = () => recordInvestigationAssessment(connection.db, {
      assessmentRef: randomUUID(),
      caseId: snapshot.caseId,
      questionRef: gap.id,
      expectedCaseVersion: resolved.caseVersion,
      verdict: 'INSUFFICIENT',
      targetClaimRef: null,
      evidenceRefs: ['evidence:late:still-blocked'],
      relatedClaimRefs: [],
      assessorKind: 'HUMAN',
      assessorIdentifier: null,
      ruleIdentifier: null,
      ruleVersion: null,
      rationale: 'The late evidence remains unresolved.',
      supersedesAssessmentRef: null,
      demo: true
    }, { mode: 'demo' });

    for (const [action, errorType] of [
      [evidenceRequest, InvestigationEvidenceRequestError],
      [claim, InvestigationClaimError],
      [assessment, InvestigationAssessmentError],
      [
        () => readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id),
        EffectiveAnalysisError
      ]
    ] as const) {
      try {
        action();
        throw new Error('Expected the existing OPEN_GAP gate to reject this operation.');
      } catch (error) {
        expect(error).toBeInstanceOf(errorType);
        expect(error).toMatchObject({ code: 'QUESTION_NOT_CURRENT' });
      }
    }
    expect(connection.db.select().from(schema.evidenceRequests).all()).toEqual([]);
    expect(connection.db.select().from(schema.investigationClaims).all()).toEqual([]);
    expect(connection.db.select().from(schema.investigationAssessments).all()).toEqual([]);
  });

  it('enforces restrictive FKs, checks, and one-cycle uniqueness in SQLite', () => {
    const { snapshot, gap } = confirmGapCase();
    const resolved = resolveGap(snapshot);
    const revisionId = connection.db.select({ id: schema.caseRevisions.id })
      .from(schema.caseRevisions)
      .where(and(
        eq(schema.caseRevisions.caseId, snapshot.caseId),
        eq(schema.caseRevisions.caseVersion, resolved.caseVersion)
      )).get()!.id;
    const insert = connection.sqlite.prepare(`
      insert into investigation_challenges (
        challenge_ref, case_id, question_ref, challenged_revision_id,
        challenged_material_revision, opened_case_version,
        trigger_evidence_refs_json, opened_by_kind, opened_by_identifier,
        rationale, created_at, demo
      ) values (?, ?, ?, ?, ?, ?, '["evidence:test"]', ?, ?, ?, ?, ?)
    `);
    const common = [snapshot.caseId, gap.id, revisionId] as const;
    expect(() => insert.run(
      randomUUID(), ...common, 0, resolved.caseVersion, 'HUMAN', 'demo_operator',
      'Review.', challengeAt, 1
    )).toThrow(/investigation_challenges_material_revision_check/);
    expect(() => insert.run(
      randomUUID(), ...common, resolved.materialRevision, 0, 'HUMAN', 'demo_operator',
      'Review.', challengeAt, 1
    )).toThrow(/investigation_challenges_opened_case_version_check/);
    expect(() => insert.run(
      randomUUID(), ...common, resolved.materialRevision, resolved.caseVersion, 'AI',
      'demo_operator', 'Review.', challengeAt, 1
    )).toThrow(/investigation_challenges_opened_by_kind_check/);
    expect(() => insert.run(
      randomUUID(), ...common, resolved.materialRevision, resolved.caseVersion, 'HUMAN',
      ' ', 'Review.', challengeAt, 1
    )).toThrow(/investigation_challenges_opened_by_identifier_check/);
    expect(() => insert.run(
      randomUUID(), ...common, resolved.materialRevision, resolved.caseVersion, 'HUMAN',
      'demo_operator', ' ', challengeAt, 1
    )).toThrow(/investigation_challenges_rationale_check/);
    expect(() => insert.run(
      randomUUID(), ...common, resolved.materialRevision, resolved.caseVersion, 'HUMAN',
      'demo_operator', 'Review.', challengeAt, 0
    )).toThrow(/investigation_challenges_demo_check/);
    expect(() => insert.run(
      randomUUID(), snapshot.caseId, 'missing:question', revisionId,
      resolved.materialRevision, resolved.caseVersion, 'HUMAN', 'demo_operator',
      'Review.', challengeAt, 1
    )).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => insert.run(
      randomUUID(), snapshot.caseId, gap.id, randomUUID(),
      resolved.materialRevision, resolved.caseVersion, 'HUMAN', 'demo_operator',
      'Review.', challengeAt, 1
    )).toThrow(/FOREIGN KEY constraint failed/);

    insert.run(
      randomUUID(), ...common, resolved.materialRevision, resolved.caseVersion, 'HUMAN',
      'demo_operator', 'Review.', challengeAt, 1
    );
    expect(() => insert.run(
      randomUUID(), ...common, resolved.materialRevision, resolved.caseVersion, 'HUMAN',
      'demo_operator', 'Another review.', challengeAt, 1
    )).toThrow(/UNIQUE constraint failed/);
    const foreignKeys = connection.sqlite
      .prepare("pragma foreign_key_list('investigation_challenges')")
      .all() as Array<{ from: string; table: string; on_delete: string }>;
    expect(foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'case_id', table: 'cases', on_delete: 'NO ACTION' }),
      expect.objectContaining({
        from: 'question_ref', table: 'investigation_questions', on_delete: 'NO ACTION'
      }),
      expect.objectContaining({
        from: 'challenged_revision_id', table: 'case_revisions', on_delete: 'NO ACTION'
      })
    ]));
  });

  it('keeps reads case scoped, deterministic, persistent, and reset-safe', () => {
    const { snapshot, gap } = confirmGapCase();
    const resolved = resolveGap(snapshot);
    recordEvidence(snapshot.caseId, gap.id, 'evidence:late:persist', lateAt);
    const first = openInvestigationChallenge(connection.db, challengeInput(
      resolved,
      gap.id,
      ['evidence:late:persist']
    ), { mode: 'demo' }).challenge;
    const initial = listInvestigationChallenges(connection.db, snapshot.caseId, gap.id);
    expect(initial).toEqual([first]);
    expect(getInvestigationChallenge(connection.db, randomUUID(), first.challengeRef)).toBeNull();

    connection.sqlite.close();
    connection = createDatabaseConnection(databasePath);
    expect(listInvestigationChallenges(connection.db, snapshot.caseId, gap.id)).toEqual(initial);
    expect(() => clearDemoData(connection.db)).not.toThrow();
    expect(connection.db.select().from(schema.investigationChallenges).all()).toEqual([]);
    expect(connection.db.select().from(schema.investigationQuestions).all()).toEqual([]);
    expect(connection.db.select().from(schema.cases).all()).toEqual([]);
  });

  it('upgrades populated 0009 additively and reruns without changing prior data', () => {
    const preChallengeFolder = join(directory, 'pre-challenge-migrations');
    mkdirSync(join(preChallengeFolder, 'meta'), { recursive: true });
    for (const file of [
      '0000_initial.sql',
      '0001_last_living_lightning.sql',
      '0002_case_lifecycle.sql',
      '0003_traceability_exposure.sql',
      '0004_last_thunderbolt.sql',
      '0005_majestic_centennial.sql',
      '0006_cynical_rictor.sql',
      '0007_calm_captain_cross.sql',
      '0008_warm_zarek.sql',
      '0009_glamorous_celestials.sql'
    ]) cpSync(join('drizzle', file), join(preChallengeFolder, file));
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 10);
    writeFileSync(join(preChallengeFolder, 'meta/_journal.json'), JSON.stringify(journal));

    const existing = createDatabaseConnection(join(directory, 'populated-0009.db'));
    try {
      migrate(existing.db, { migrationsFolder: preChallengeFolder });
      seedDemoData(existing.db, fixtures);
      existing.db.insert(schema.cases).values({
        id: '60000000-0000-4000-8000-000000000099',
        caseNumber: 'CASE-PRE-CHALLENGE-099',
        alertId: fixtures.alerts[0].id,
        status: 'open',
        severity: 'high',
        openedAt: gapAt,
        closedAt: null
      }).run();
      const before = existing.db.select().from(schema.cases).all();

      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      expect(existing.db.select().from(schema.cases).all()).toEqual(before);
      expect(existing.db.select().from(schema.investigationChallenges).all()).toEqual([]);
      expect(existing.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      existing.sqlite.close();
    }
  });
});
