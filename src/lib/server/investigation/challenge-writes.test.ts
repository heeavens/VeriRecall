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
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import {
  InvestigationAssessmentError,
  recordInvestigationAssessment
} from './assessments';
import {
  InvestigationClaimError,
  recordInvestigationClaim
} from './claims';
import {
  openInvestigationChallenge,
  readInvestigationChallengeContext,
  type InvestigationChallenge
} from './challenges';
import { recordInvestigationEvidence } from './evidence-registry';
import {
  InvestigationEvidenceRequestError,
  requestInvestigationEvidence
} from './evidence-requests';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const missingBatchMatchId = '50000000-0000-4000-8000-000000000002';
const gapAt = '2026-09-09T10:00:00.000Z';
const baselineAt = '2026-09-09T10:30:00.000Z';
const answerAt = '2026-09-09T12:00:00.000Z';
const lateAt = '2026-09-09T13:00:00.000Z';
const challengeAt = '2026-09-09T14:00:00.000Z';
const fixtures = loadDemoFixtures();
let directory: string;
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

function resolveGap(current: CaseSnapshot): CaseSnapshot {
  if (!current.investigation) throw new Error('Expected an investigation outcome.');
  const materialRevision = (current.materialRevision ?? 0) + 1;
  const resolved = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    materialRevision,
    updatedAt: answerAt,
    investigation: {
      ...current.investigation,
      materialRevision,
      updatedAt: answerAt,
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

function advanceOperationally(current: CaseSnapshot): CaseSnapshot {
  const advanced = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    updatedAt: '2026-09-09T16:00:00.000Z'
  });
  persistSnapshot(advanced);
  return advanced;
}

function advanceMaterially(current: CaseSnapshot): CaseSnapshot {
  if (!current.investigation || current.materialRevision === null) {
    throw new Error('Expected a material investigation.');
  }
  const materialRevision = current.materialRevision + 1;
  const advanced = caseSnapshotSchema.parse({
    ...current,
    caseVersion: current.caseVersion + 1,
    materialRevision,
    updatedAt: '2026-09-09T17:00:00.000Z',
    investigation: {
      ...current.investigation,
      materialRevision,
      updatedAt: '2026-09-09T17:00:00.000Z'
    }
  });
  persistSnapshot(advanced);
  return advanced;
}

function reopenGap(
  current: CaseSnapshot,
  gap: NonNullable<CaseSnapshot['investigation']>['gaps'][number]
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
    updatedAt: '2026-09-09T18:00:00.000Z',
    investigation: {
      ...current.investigation,
      materialRevision,
      updatedAt: '2026-09-09T18:00:00.000Z',
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
    uncertainties: [gap],
    conflicts: [],
    pendingDecisions: [],
    attentionItems: [],
    closure: {
      status: 'NOT_READY',
      blockers: [{
        id: `demo:blocker:investigation:${current.caseId}`,
        code: 'INVESTIGATION_UNRESOLVED',
        message: 'Resolve the current investigation before closure.',
        critical: true,
        subjectRefs: [current.productId],
        evidenceRefs: []
      }],
      decisionRef: null
    }
  });
  persistSnapshot(reopened);
  return reopened;
}

function makeClosed(current: CaseSnapshot): CaseSnapshot {
  if (!current.investigation || current.materialRevision === null ||
      current.investigation.scope.kind !== 'BATCH_LOT') {
    throw new Error('Expected a resolved batch investigation.');
  }
  const at = '2026-09-09T15:00:00.000Z';
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

function evidence(
  caseId: string,
  questionRef: string,
  evidenceRef: string,
  receivedAt: string,
  evidenceRequestId: string | null = null,
  validAsOf: string | null = null
) {
  return recordInvestigationEvidence(connection.db, {
    evidenceRef,
    caseId,
    questionRef,
    evidenceRequestId,
    sourceKind: 'EXTERNAL_PARTY',
    sourceIdentifier: `supplier:${evidenceRef}`,
    validAsOf,
    contentKind: 'STRUCTURED',
    contentJson: { assertedLot: 'MFT25' },
    contentLocator: null,
    demo: true
  }, new Date(receivedAt));
}

function openChallengeInput(
  snapshot: CaseSnapshot,
  questionRef: string,
  triggerEvidenceRef: string
) {
  if (snapshot.materialRevision === null) throw new Error('Expected material revision.');
  return {
    challengeRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    expectedMaterialRevision: snapshot.materialRevision,
    triggerEvidenceRefs: [triggerEvidenceRef],
    rationale: 'Late supplier evidence requires re-review.',
    demo: true as const
  };
}

function openGapClaimInput(
  snapshot: CaseSnapshot,
  questionRef: string,
  evidenceRefs: string[],
  claimRef = randomUUID(),
  lot = 'MFT24',
  supersedesClaimRef: string | null = null
) {
  return {
    claimRef,
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    claimType: 'AFFECTED_BATCH_LOT' as const,
    value: { lot },
    evidenceRefs,
    originKind: 'HUMAN_OBSERVED' as const,
    producerIdentifier: 'demo_operator',
    derivationMetadata: null,
    supersedesClaimRef,
    demo: true as const
  };
}

function challengeClaimInput(
  snapshot: CaseSnapshot,
  questionRef: string,
  challengeRef: string,
  evidenceRefs: string[],
  claimRef = randomUUID(),
  lot = 'MFT25',
  supersedesClaimRef: string | null = null
) {
  if (snapshot.materialRevision === null) throw new Error('Expected material revision.');
  return {
    ...openGapClaimInput(
      snapshot,
      questionRef,
      evidenceRefs,
      claimRef,
      lot,
      supersedesClaimRef
    ),
    challengeRef,
    expectedMaterialRevision: snapshot.materialRevision
  };
}

function humanAssessmentInput(
  snapshot: CaseSnapshot,
  questionRef: string,
  targetClaimRef: string | null,
  evidenceRefs: string[],
  assessmentRef = randomUUID(),
  supersedesAssessmentRef: string | null = null
) {
  return {
    assessmentRef,
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    verdict: 'SUPPORTED' as const,
    targetClaimRef,
    evidenceRefs,
    relatedClaimRefs: [],
    assessorKind: 'HUMAN' as const,
    assessorIdentifier: null,
    ruleIdentifier: null,
    ruleVersion: null,
    rationale: 'Reviewed the registered Evidence against this assertion.',
    supersedesAssessmentRef,
    demo: true as const
  };
}

function challengeAssessmentInput(
  snapshot: CaseSnapshot,
  questionRef: string,
  challengeRef: string,
  targetClaimRef: string | null,
  evidenceRefs: string[],
  assessmentRef = randomUUID(),
  supersedesAssessmentRef: string | null = null
) {
  if (snapshot.materialRevision === null) throw new Error('Expected material revision.');
  return {
    ...humanAssessmentInput(
      snapshot,
      questionRef,
      targetClaimRef,
      evidenceRefs,
      assessmentRef,
      supersedesAssessmentRef
    ),
    challengeRef,
    expectedMaterialRevision: snapshot.materialRevision
  };
}

function seedAnsweredChallenge() {
  const { snapshot: gapSnapshot, gap } = confirmGapCase();
  const baselineEvidenceRef = `demo:evidence:${randomUUID()}`;
  evidence(gapSnapshot.caseId, gap.id, baselineEvidenceRef, baselineAt);
  const baselineClaim = recordInvestigationClaim(
    connection.db,
    openGapClaimInput(gapSnapshot, gap.id, [baselineEvidenceRef]),
    { mode: 'demo' },
    new Date('2026-09-09T10:40:00.000Z')
  ).claim;
  const baselineAssessment = recordInvestigationAssessment(
    connection.db,
    humanAssessmentInput(gapSnapshot, gap.id, baselineClaim.claimRef, [baselineEvidenceRef]),
    { mode: 'demo' },
    new Date('2026-09-09T10:50:00.000Z')
  ).assessment;
  const answered = resolveGap(gapSnapshot);
  const lateEvidenceRef = `demo:evidence:${randomUUID()}`;
  evidence(answered.caseId, gap.id, lateEvidenceRef, lateAt, null, '2025-01-01T00:00:00.000Z');
  const challenge = openInvestigationChallenge(
    connection.db,
    openChallengeInput(answered, gap.id, lateEvidenceRef),
    { mode: 'demo' },
    new Date(challengeAt)
  ).challenge;
  return {
    gapSnapshot,
    answered,
    gap,
    challenge,
    baselineEvidenceRef,
    lateEvidenceRef,
    baselineClaim,
    baselineAssessment
  };
}

function seedOtherChallengeEvidence(
  answered: CaseSnapshot,
  questionRef: string,
  currentChallenge: InvestigationChallenge
): { challengeRef: string; evidenceRef: string } {
  const challengeRef = randomUUID();
  connection.db.insert(schema.investigationChallenges).values({
    challengeRef,
    caseId: answered.caseId,
    questionRef,
    challengedRevisionId: currentChallenge.challengedRevisionId,
    challengedMaterialRevision: currentChallenge.challengedMaterialRevision + 100,
    openedCaseVersion: answered.caseVersion,
    triggerEvidenceRefsJson: JSON.stringify(currentChallenge.triggerEvidenceRefs),
    openedByKind: 'HUMAN',
    openedByIdentifier: 'demo_operator',
    rationale: 'Structurally valid other-cycle fixture.',
    createdAt: '2026-09-09T14:30:00.000Z',
    demo: true
  }).run();
  const requestId = randomUUID();
  connection.db.insert(schema.evidenceRequests).values({
    id: requestId,
    matchId: missingBatchMatchId,
    caseId: answered.caseId,
    questionRef,
    requestedEvidence: JSON.stringify(['supplier_invoice']),
    recipient: null,
    status: 'pending',
    createdAt: '2026-09-09T14:40:00.000Z',
    resolvedAt: null
  }).run();
  connection.db.insert(schema.investigationChallengeRequests).values({
    requestId,
    challengeRef
  }).run();
  const evidenceRef = `demo:evidence:${randomUUID()}`;
  evidence(
    answered.caseId,
    questionRef,
    evidenceRef,
    '2026-09-09T14:50:00.000Z',
    requestId
  );
  return { challengeRef, evidenceRef };
}

function expectRequestError(action: () => unknown, code: InvestigationEvidenceRequestError['code']) {
  expect(action).toThrow(expect.objectContaining({ code }));
}

function expectClaimError(action: () => unknown, code: InvestigationClaimError['code']) {
  expect(action).toThrow(expect.objectContaining({ code }));
}

function expectAssessmentError(action: () => unknown, code: InvestigationAssessmentError['code']) {
  expect(action).toThrow(expect.objectContaining({ code }));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-challenge-writes-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('Challenge-scoped investigation writes', () => {
  it('preserves OPEN_GAP request, Claim and Assessment behavior without associations', () => {
    const { snapshot, gap } = confirmGapCase();
    const requestId = randomUUID();
    const request = requestInvestigationEvidence(connection.db, {
      requestId,
      caseId: snapshot.caseId,
      questionRef: gap.id,
      expectedCaseVersion: snapshot.caseVersion,
      requestedEvidence: ['batch_label_photo'],
      demo: true
    }, { mode: 'demo' }).request;
    const evidenceRef = `demo:evidence:${randomUUID()}`;
    evidence(snapshot.caseId, gap.id, evidenceRef, baselineAt, requestId);
    const claim = recordInvestigationClaim(
      connection.db,
      openGapClaimInput(snapshot, gap.id, [evidenceRef]),
      { mode: 'demo' }
    ).claim;
    recordInvestigationAssessment(
      connection.db,
      humanAssessmentInput(snapshot, gap.id, claim.claimRef, [evidenceRef]),
      { mode: 'demo' }
    );

    expect(request).toMatchObject({ status: 'pending', resolvedAt: null });
    expect(tableCount(schema.investigationChallengeRequests)).toBe(0);
    expect(tableCount(schema.investigationChallengeClaims)).toBe(0);
    expect(tableCount(schema.investigationChallengeAssessments)).toBe(0);
    expect(() => seedDemoData(connection.db, fixtures)).not.toThrow();
  });

  it('never retroactively attaches existing OPEN_GAP artifacts to a Challenge', () => {
    const { snapshot, gap } = confirmGapCase();
    const requestId = randomUUID();
    const openRequest = {
      requestId,
      caseId: snapshot.caseId,
      questionRef: gap.id,
      expectedCaseVersion: snapshot.caseVersion,
      requestedEvidence: ['supplier_invoice'] as Array<'supplier_invoice'>,
      demo: true as const
    };
    requestInvestigationEvidence(connection.db, openRequest, { mode: 'demo' });
    const baselineEvidenceRef = `demo:evidence:${randomUUID()}`;
    evidence(snapshot.caseId, gap.id, baselineEvidenceRef, baselineAt, requestId);
    const openClaim = openGapClaimInput(snapshot, gap.id, [baselineEvidenceRef]);
    recordInvestigationClaim(connection.db, openClaim, { mode: 'demo' });
    const openAssessment = humanAssessmentInput(
      snapshot,
      gap.id,
      openClaim.claimRef,
      [baselineEvidenceRef]
    );
    recordInvestigationAssessment(connection.db, openAssessment, { mode: 'demo' });

    const answered = resolveGap(snapshot);
    const lateEvidenceRef = `demo:evidence:${randomUUID()}`;
    evidence(answered.caseId, gap.id, lateEvidenceRef, lateAt);
    const challenge = openInvestigationChallenge(
      connection.db,
      openChallengeInput(answered, gap.id, lateEvidenceRef),
      { mode: 'demo' },
      new Date(challengeAt)
    ).challenge;
    const challengeFields = {
      challengeRef: challenge.challengeRef,
      expectedMaterialRevision: answered.materialRevision!
    };

    expectRequestError(() => requestInvestigationEvidence(connection.db, {
      ...openRequest,
      ...challengeFields
    }, { mode: 'demo' }), 'CHALLENGE_ASSOCIATION_CONFLICT');
    expectClaimError(() => recordInvestigationClaim(connection.db, {
      ...openClaim,
      ...challengeFields
    }, { mode: 'demo' }), 'CHALLENGE_ASSOCIATION_CONFLICT');
    expectAssessmentError(() => recordInvestigationAssessment(connection.db, {
      ...openAssessment,
      ...challengeFields
    }, { mode: 'demo' }), 'CHALLENGE_ASSOCIATION_CONFLICT');
    expect(tableCount(schema.investigationChallengeRequests)).toBe(0);
    expect(tableCount(schema.investigationChallengeClaims)).toBe(0);
    expect(tableCount(schema.investigationChallengeAssessments)).toBe(0);
  });

  it('records a Challenge Request atomically and enforces replay association semantics', () => {
    const { answered, gap, challenge } = seedAnsweredChallenge();
    const requestId = randomUUID();
    const input = {
      requestId,
      caseId: answered.caseId,
      questionRef: gap.id,
      challengeRef: challenge.challengeRef,
      expectedCaseVersion: answered.caseVersion,
      expectedMaterialRevision: answered.materialRevision!,
      requestedEvidence: [
        'supplier_invoice',
        'batch_label_photo',
        'supplier_invoice'
      ] as Array<'supplier_invoice' | 'batch_label_photo'>,
      demo: true as const
    };
    const beforeSnapshot = JSON.stringify(readCaseSnapshot(connection.db, answered.caseId));
    const beforeAudit = tableCount(schema.auditEvents);
    const result = requestInvestigationEvidence(connection.db, input, { mode: 'demo' });

    expect(result).toMatchObject({ replayed: false, request: {
      matchId: missingBatchMatchId,
      status: 'pending',
      resolvedAt: null,
      requestedEvidence: ['supplier_invoice', 'batch_label_photo']
    } });
    expect(connection.db.select().from(schema.investigationChallengeRequests).get()).toEqual({
      requestId,
      challengeRef: challenge.challengeRef
    });
    expect(tableCount(schema.auditEvents)).toBe(beforeAudit + 1);
    expect(JSON.stringify(readCaseSnapshot(connection.db, answered.caseId))).toBe(beforeSnapshot);

    const advanced = advanceOperationally(answered);
    expect(readInvestigationChallengeContext(
      connection.db,
      answered.caseId,
      challenge.challengeRef
    )?.contextKind).toBe('CURRENT');
    expect(requestInvestigationEvidence(connection.db, input, { mode: 'demo' })).toMatchObject({
      replayed: true
    });
    expect(tableCount(schema.auditEvents)).toBe(beforeAudit + 1);

    expectRequestError(() => requestInvestigationEvidence(connection.db, {
      requestId,
      caseId: answered.caseId,
      questionRef: gap.id,
      expectedCaseVersion: advanced.caseVersion,
      requestedEvidence: ['batch_label_photo', 'supplier_invoice'],
      demo: true
    }, { mode: 'demo' }), 'CHALLENGE_ASSOCIATION_CONFLICT');
    expectRequestError(() => requestInvestigationEvidence(connection.db, {
      ...input,
      challengeRef: randomUUID()
    }, { mode: 'demo' }), 'CHALLENGE_ASSOCIATION_CONFLICT');
    expectRequestError(() => requestInvestigationEvidence(connection.db, {
      requestId: randomUUID(),
      caseId: answered.caseId,
      questionRef: gap.id,
      challengeRef: challenge.challengeRef,
      expectedCaseVersion: advanced.caseVersion,
      requestedEvidence: ['batch_label_photo'],
      demo: true
    } as never, { mode: 'demo' }), 'INVALID_INPUT');

    const responseEvidenceRef = `demo:evidence:${randomUUID()}`;
    const received = evidence(
      answered.caseId,
      gap.id,
      responseEvidenceRef,
      '2026-09-09T16:30:00.000Z',
      requestId
    ).evidence;
    expect(received).not.toHaveProperty('challengeRef');
    expect(connection.db.select().from(schema.investigationChallengeRequests)
      .where(eq(schema.investigationChallengeRequests.requestId, requestId)).get())
      .toMatchObject({ challengeRef: challenge.challengeRef });
  });

  it('records untrusted Challenge Claims from relevant Evidence and isolates partitions', () => {
    const {
      answered, gap, challenge, baselineEvidenceRef, lateEvidenceRef, baselineClaim
    } = seedAnsweredChallenge();
    const beforeSnapshot = JSON.stringify(readCaseSnapshot(connection.db, answered.caseId));
    const beforeAudit = tableCount(schema.auditEvents);
    const claimInput = challengeClaimInput(
      answered,
      gap.id,
      challenge.challengeRef,
      [baselineEvidenceRef, lateEvidenceRef]
    );
    const result = recordInvestigationClaim(connection.db, claimInput, { mode: 'demo' });

    expect(result.claim).not.toHaveProperty('trusted');
    expect(result.claim).not.toHaveProperty('knowledgeStatus');
    expect(connection.db.select().from(schema.investigationChallengeClaims)
      .where(eq(schema.investigationChallengeClaims.claimRef, result.claim.claimRef)).get())
      .toEqual({ claimRef: result.claim.claimRef, challengeRef: challenge.challengeRef });
    expect(tableCount(schema.auditEvents)).toBe(beforeAudit + 1);
    expect(JSON.stringify(readCaseSnapshot(connection.db, answered.caseId))).toBe(beforeSnapshot);

    expectClaimError(() => recordInvestigationClaim(
      connection.db,
      challengeClaimInput(
        answered,
        gap.id,
        challenge.challengeRef,
        [baselineEvidenceRef]
      ),
      { mode: 'demo' }
    ), 'CHALLENGE_EVIDENCE_REQUIRED');
    const otherCycle = seedOtherChallengeEvidence(answered, gap.id, challenge);
    expectClaimError(() => recordInvestigationClaim(
      connection.db,
      challengeClaimInput(
        answered,
        gap.id,
        challenge.challengeRef,
        [lateEvidenceRef, otherCycle.evidenceRef]
      ),
      { mode: 'demo' }
    ), 'EVIDENCE_CHALLENGE_MISMATCH');
    expectClaimError(() => recordInvestigationClaim(
      connection.db,
      challengeClaimInput(
        answered,
        gap.id,
        challenge.challengeRef,
        [lateEvidenceRef],
        randomUUID(),
        'MFT25 corrected',
        baselineClaim.claimRef
      ),
      { mode: 'demo' }
    ), 'SUPERSESSION_MISMATCH');

    const successor = recordInvestigationClaim(
      connection.db,
      challengeClaimInput(
        answered,
        gap.id,
        challenge.challengeRef,
        [lateEvidenceRef],
        randomUUID(),
        'MFT25 corrected',
        result.claim.claimRef
      ),
      { mode: 'demo' }
    ).claim;
    expect(successor.supersedesClaimRef).toBe(result.claim.claimRef);

    const replayAfterAdvance = advanceOperationally(answered);
    expect(recordInvestigationClaim(connection.db, claimInput, { mode: 'demo' })).toMatchObject({
      replayed: true
    });
    expectClaimError(() => recordInvestigationClaim(
      connection.db,
      openGapClaimInput(
        replayAfterAdvance,
        gap.id,
        [baselineEvidenceRef, lateEvidenceRef],
        claimInput.claimRef,
        claimInput.value.lot
      ),
      { mode: 'demo' }
    ), 'CHALLENGE_ASSOCIATION_CONFLICT');
  });

  it('records Challenge Assessments across baseline and selected-Challenge Claims only', () => {
    const {
      answered,
      gap,
      challenge,
      baselineEvidenceRef,
      lateEvidenceRef,
      baselineClaim,
      baselineAssessment
    } = seedAnsweredChallenge();
    const challengeClaim = recordInvestigationClaim(
      connection.db,
      challengeClaimInput(answered, gap.id, challenge.challengeRef, [lateEvidenceRef]),
      { mode: 'demo' }
    ).claim;
    const contradictionInput = {
      ...challengeAssessmentInput(
        answered,
        gap.id,
        challenge.challengeRef,
        null,
        [baselineEvidenceRef, lateEvidenceRef]
      ),
      verdict: 'CONTRADICTED' as const,
      relatedClaimRefs: [challengeClaim.claimRef, baselineClaim.claimRef],
      rationale: 'The baseline and late Evidence assert incompatible lots.'
    };
    const beforeSnapshot = JSON.stringify(readCaseSnapshot(connection.db, answered.caseId));
    const contradiction = recordInvestigationAssessment(
      connection.db,
      contradictionInput,
      { mode: 'demo' }
    ).assessment;
    expect(contradiction.relatedClaimRefs).toEqual(
      [baselineClaim.claimRef, challengeClaim.claimRef].sort()
    );
    expect(connection.db.select().from(schema.investigationChallengeAssessments)
      .where(eq(
        schema.investigationChallengeAssessments.assessmentRef,
        contradiction.assessmentRef
      )).get()).toEqual({
      assessmentRef: contradiction.assessmentRef,
      challengeRef: challenge.challengeRef
    });

    const baselineReview = recordInvestigationAssessment(
      connection.db,
      challengeAssessmentInput(
        answered,
        gap.id,
        challenge.challengeRef,
        baselineClaim.claimRef,
        [baselineEvidenceRef, lateEvidenceRef]
      ),
      { mode: 'demo' }
    ).assessment;
    expect(baselineReview.targetClaimRef).toBe(baselineClaim.claimRef);

    const insufficient = recordInvestigationAssessment(connection.db, {
      ...challengeAssessmentInput(
        answered,
        gap.id,
        challenge.challengeRef,
        null,
        [lateEvidenceRef]
      ),
      verdict: 'INSUFFICIENT' as const,
      rationale: 'The late document did not yield another usable assertion.'
    }, { mode: 'demo' }).assessment;
    expect(insufficient.targetClaimRef).toBeNull();
    expect(insufficient.relatedClaimRefs).toEqual([]);

    expectAssessmentError(() => recordInvestigationAssessment(
      connection.db,
      challengeAssessmentInput(
        answered,
        gap.id,
        challenge.challengeRef,
        baselineClaim.claimRef,
        [baselineEvidenceRef, lateEvidenceRef],
        randomUUID(),
        baselineAssessment.assessmentRef
      ),
      { mode: 'demo' }
    ), 'SUPERSESSION_MISMATCH');

    const successor = recordInvestigationAssessment(connection.db, {
      ...contradictionInput,
      assessmentRef: randomUUID(),
      supersedesAssessmentRef: contradiction.assessmentRef,
      rationale: 'Re-ran the deterministic comparison over the same immutable basis.'
    }, { mode: 'demo' }).assessment;
    expect(successor.supersedesAssessmentRef).toBe(contradiction.assessmentRef);
    const otherCycle = seedOtherChallengeEvidence(answered, gap.id, challenge);
    const otherClaimRef = randomUUID();
    connection.db.insert(schema.investigationClaims).values({
      claimRef: otherClaimRef,
      caseId: answered.caseId,
      questionRef: gap.id,
      subjectRef: answered.productId,
      claimType: 'AFFECTED_BATCH_LOT',
      valueJson: JSON.stringify({ lot: 'MFT26' }),
      evidenceRefsJson: JSON.stringify([lateEvidenceRef]),
      originKind: 'HUMAN_OBSERVED',
      producerIdentifier: 'test_fixture',
      derivationMetadataJson: null,
      supersedesClaimRef: null,
      createdAt: '2026-09-09T14:55:00.000Z',
      demo: true
    }).run();
    connection.db.insert(schema.investigationChallengeClaims).values({
      claimRef: otherClaimRef,
      challengeRef: otherCycle.challengeRef
    }).run();
    expectAssessmentError(() => recordInvestigationAssessment(
      connection.db,
      challengeAssessmentInput(
        answered,
        gap.id,
        challenge.challengeRef,
        otherClaimRef,
        [lateEvidenceRef]
      ),
      { mode: 'demo' }
    ), 'CLAIM_CHALLENGE_MISMATCH');

    expect(JSON.stringify(readCaseSnapshot(connection.db, answered.caseId))).toBe(beforeSnapshot);
    const auditBeforeReplay = tableCount(schema.auditEvents);
    advanceOperationally(answered);
    expect(recordInvestigationAssessment(
      connection.db,
      contradictionInput,
      { mode: 'demo' }
    )).toMatchObject({ replayed: true });
    expect(tableCount(schema.auditEvents)).toBe(auditBeforeReplay);
  });

  it('rejects reverse supersession from a later OPEN_GAP into a Challenge partition', () => {
    const { answered, gap, challenge, baselineEvidenceRef, lateEvidenceRef } =
      seedAnsweredChallenge();
    const challengeClaim = recordInvestigationClaim(
      connection.db,
      challengeClaimInput(answered, gap.id, challenge.challengeRef, [lateEvidenceRef]),
      { mode: 'demo' }
    ).claim;
    const challengeAssessment = recordInvestigationAssessment(
      connection.db,
      challengeAssessmentInput(
        answered,
        gap.id,
        challenge.challengeRef,
        challengeClaim.claimRef,
        [lateEvidenceRef]
      ),
      { mode: 'demo' }
    ).assessment;
    const reopened = reopenGap(answered, gap);

    expectAssessmentError(() => recordInvestigationAssessment(
      connection.db,
      humanAssessmentInput(
        reopened,
        gap.id,
        challengeClaim.claimRef,
        [lateEvidenceRef]
      ),
      { mode: 'demo' }
    ), 'CLAIM_CHALLENGE_MISMATCH');

    expectClaimError(() => recordInvestigationClaim(
      connection.db,
      openGapClaimInput(
        reopened,
        gap.id,
        [baselineEvidenceRef],
        randomUUID(),
        'MFT27',
        challengeClaim.claimRef
      ),
      { mode: 'demo' }
    ), 'SUPERSESSION_MISMATCH');
    const reopenedClaim = recordInvestigationClaim(
      connection.db,
      openGapClaimInput(
        reopened,
        gap.id,
        [baselineEvidenceRef],
        randomUUID(),
        'MFT27'
      ),
      { mode: 'demo' }
    ).claim;
    expectAssessmentError(() => recordInvestigationAssessment(
      connection.db,
      humanAssessmentInput(
        reopened,
        gap.id,
        reopenedClaim.claimRef,
        [baselineEvidenceRef],
        randomUUID(),
        challengeAssessment.assessmentRef
      ),
      { mode: 'demo' }
    ), 'SUPERSESSION_MISMATCH');
  });

  it('rejects partial OPEN_CHALLENGE input shapes in every writer', () => {
    const { answered, gap, challenge, lateEvidenceRef } = seedAnsweredChallenge();
    expectRequestError(() => requestInvestigationEvidence(connection.db, {
      requestId: randomUUID(),
      caseId: answered.caseId,
      questionRef: gap.id,
      challengeRef: challenge.challengeRef,
      expectedCaseVersion: answered.caseVersion,
      requestedEvidence: ['supplier_invoice'],
      demo: true
    } as never, { mode: 'demo' }), 'INVALID_INPUT');
    expectClaimError(() => recordInvestigationClaim(connection.db, {
      ...openGapClaimInput(answered, gap.id, [lateEvidenceRef]),
      expectedMaterialRevision: answered.materialRevision
    } as never, { mode: 'demo' }), 'INVALID_INPUT');
    expectAssessmentError(() => recordInvestigationAssessment(connection.db, {
      ...humanAssessmentInput(answered, gap.id, null, [lateEvidenceRef]),
      challengeRef: challenge.challengeRef
    } as never, { mode: 'demo' }), 'INVALID_INPUT');
  });

  it('rejects stale, historical and malformed Challenge authorization without writes', () => {
    const { answered, gap, challenge, lateEvidenceRef } = seedAnsweredChallenge();
    const initialRequests = tableCount(schema.evidenceRequests);
    const initialClaims = tableCount(schema.investigationClaims);
    const initialAssessments = tableCount(schema.investigationAssessments);
    expectRequestError(() => requestInvestigationEvidence(connection.db, {
      requestId: randomUUID(),
      caseId: answered.caseId,
      questionRef: gap.id,
      challengeRef: randomUUID(),
      expectedCaseVersion: answered.caseVersion,
      expectedMaterialRevision: answered.materialRevision!,
      requestedEvidence: ['batch_label_photo'],
      demo: true
    }, { mode: 'demo' }), 'CHALLENGE_NOT_CURRENT');
    const staleCaseClaim = challengeClaimInput(
      answered,
      gap.id,
      challenge.challengeRef,
      [lateEvidenceRef]
    );
    staleCaseClaim.expectedCaseVersion -= 1;
    expectClaimError(() => recordInvestigationClaim(
      connection.db,
      staleCaseClaim,
      { mode: 'demo' }
    ), 'STALE_CASE_VERSION');

    const staleMaterialAssessment = {
      ...challengeAssessmentInput(
        answered,
        gap.id,
        challenge.challengeRef,
        null,
        [lateEvidenceRef]
      ),
      verdict: 'INSUFFICIENT' as const,
      expectedMaterialRevision: answered.materialRevision! - 1
    };
    expectAssessmentError(() => recordInvestigationAssessment(
      connection.db,
      staleMaterialAssessment,
      { mode: 'demo' }
    ), 'STALE_MATERIAL_REVISION');

    const historical = advanceMaterially(answered);
    expectRequestError(() => requestInvestigationEvidence(connection.db, {
      requestId: randomUUID(),
      caseId: answered.caseId,
      questionRef: gap.id,
      challengeRef: challenge.challengeRef,
      expectedCaseVersion: historical.caseVersion,
      expectedMaterialRevision: historical.materialRevision!,
      requestedEvidence: ['batch_label_photo'],
      demo: true
    }, { mode: 'demo' }), 'CHALLENGE_NOT_CURRENT');

    expect(tableCount(schema.evidenceRequests)).toBe(initialRequests);
    expect(tableCount(schema.investigationClaims)).toBe(initialClaims);
    expect(tableCount(schema.investigationAssessments)).toBe(initialAssessments);
    expect(tableCount(schema.investigationChallengeRequests)).toBe(0);
    expect(tableCount(schema.investigationChallengeClaims)).toBe(0);
    expect(tableCount(schema.investigationChallengeAssessments)).toBe(0);
  });

  it('allows all factual Challenge writes while CLOSED without reopening the case', () => {
    const { answered, gap, challenge, lateEvidenceRef } = seedAnsweredChallenge();
    const closed = makeClosed(answered);
    persistSnapshot(closed);
    const request = requestInvestigationEvidence(connection.db, {
      requestId: randomUUID(),
      caseId: closed.caseId,
      questionRef: gap.id,
      challengeRef: challenge.challengeRef,
      expectedCaseVersion: closed.caseVersion,
      expectedMaterialRevision: closed.materialRevision!,
      requestedEvidence: ['supplier_invoice'],
      demo: true
    }, { mode: 'demo' }).request;
    const claim = recordInvestigationClaim(
      connection.db,
      challengeClaimInput(closed, gap.id, challenge.challengeRef, [lateEvidenceRef]),
      { mode: 'demo' }
    ).claim;
    recordInvestigationAssessment(
      connection.db,
      challengeAssessmentInput(
        closed,
        gap.id,
        challenge.challengeRef,
        claim.claimRef,
        [lateEvidenceRef]
      ),
      { mode: 'demo' }
    );

    expect(request.status).toBe('pending');
    const after = readCaseSnapshot(connection.db, closed.caseId);
    expect(after).toEqual(closed);
    expect(after?.stage).toBe('CLOSED');
  });

  it('rolls back each artifact and audit when its association insert fails', () => {
    const { answered, gap, challenge, lateEvidenceRef } = seedAnsweredChallenge();
    const beforeAudit = tableCount(schema.auditEvents);
    const requestId = randomUUID();
    connection.sqlite.exec(`
      create trigger fail_challenge_request_association
      before insert on investigation_challenge_requests
      begin select raise(abort, 'forced request association failure'); end
    `);
    expect(() => requestInvestigationEvidence(connection.db, {
      requestId,
      caseId: answered.caseId,
      questionRef: gap.id,
      challengeRef: challenge.challengeRef,
      expectedCaseVersion: answered.caseVersion,
      expectedMaterialRevision: answered.materialRevision!,
      requestedEvidence: ['batch_label_photo'],
      demo: true
    }, { mode: 'demo' })).toThrow(/forced request association failure/);
    expect(connection.db.select().from(schema.evidenceRequests)
      .where(eq(schema.evidenceRequests.id, requestId)).get()).toBeUndefined();
    connection.sqlite.exec('drop trigger fail_challenge_request_association');

    const claimRef = randomUUID();
    connection.sqlite.exec(`
      create trigger fail_challenge_claim_association
      before insert on investigation_challenge_claims
      begin select raise(abort, 'forced claim association failure'); end
    `);
    expect(() => recordInvestigationClaim(
      connection.db,
      challengeClaimInput(
        answered,
        gap.id,
        challenge.challengeRef,
        [lateEvidenceRef],
        claimRef
      ),
      { mode: 'demo' }
    )).toThrow(/forced claim association failure/);
    expect(connection.db.select().from(schema.investigationClaims)
      .where(eq(schema.investigationClaims.claimRef, claimRef)).get()).toBeUndefined();
    connection.sqlite.exec('drop trigger fail_challenge_claim_association');

    const claim = recordInvestigationClaim(
      connection.db,
      challengeClaimInput(answered, gap.id, challenge.challengeRef, [lateEvidenceRef]),
      { mode: 'demo' }
    ).claim;
    const auditAfterClaim = tableCount(schema.auditEvents);
    const assessmentRef = randomUUID();
    connection.sqlite.exec(`
      create trigger fail_challenge_assessment_association
      before insert on investigation_challenge_assessments
      begin select raise(abort, 'forced assessment association failure'); end
    `);
    expect(() => recordInvestigationAssessment(
      connection.db,
      challengeAssessmentInput(
        answered,
        gap.id,
        challenge.challengeRef,
        claim.claimRef,
        [lateEvidenceRef],
        assessmentRef
      ),
      { mode: 'demo' }
    )).toThrow(/forced assessment association failure/);
    expect(connection.db.select().from(schema.investigationAssessments)
      .where(eq(schema.investigationAssessments.assessmentRef, assessmentRef)).get())
      .toBeUndefined();
    expect(tableCount(schema.auditEvents)).toBe(auditAfterClaim);
    expect(auditAfterClaim).toBe(beforeAudit + 1);
  });

  it('keeps restrictive associations persistent, unique, and reset-safe', () => {
    const { answered, gap, challenge, lateEvidenceRef } = seedAnsweredChallenge();
    const requestId = randomUUID();
    requestInvestigationEvidence(connection.db, {
      requestId,
      caseId: answered.caseId,
      questionRef: gap.id,
      challengeRef: challenge.challengeRef,
      expectedCaseVersion: answered.caseVersion,
      expectedMaterialRevision: answered.materialRevision!,
      requestedEvidence: ['batch_label_photo'],
      demo: true
    }, { mode: 'demo' });
    const claim = recordInvestigationClaim(
      connection.db,
      challengeClaimInput(answered, gap.id, challenge.challengeRef, [lateEvidenceRef]),
      { mode: 'demo' }
    ).claim;
    const assessment = recordInvestigationAssessment(
      connection.db,
      challengeAssessmentInput(
        answered,
        gap.id,
        challenge.challengeRef,
        claim.claimRef,
        [lateEvidenceRef]
      ),
      { mode: 'demo' }
    ).assessment;

    expect(() => connection.db.insert(schema.investigationChallengeRequests).values({
      requestId: randomUUID(), challengeRef: challenge.challengeRef
    }).run()).toThrow(/FOREIGN KEY/);
    expect(() => connection.db.insert(schema.investigationChallengeClaims).values({
      claimRef: randomUUID(), challengeRef: challenge.challengeRef
    }).run()).toThrow(/FOREIGN KEY/);
    expect(() => connection.db.insert(schema.investigationChallengeAssessments).values({
      assessmentRef: randomUUID(), challengeRef: challenge.challengeRef
    }).run()).toThrow(/FOREIGN KEY/);
    expect(() => connection.db.insert(schema.investigationChallengeClaims).values({
      claimRef: claim.claimRef, challengeRef: challenge.challengeRef
    }).run()).toThrow(/UNIQUE/);
    expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);

    connection.sqlite.close();
    connection = createDatabaseConnection(join(directory, 'test.db'));
    expect(connection.db.select().from(schema.investigationChallengeRequests).get())
      .toMatchObject({ requestId, challengeRef: challenge.challengeRef });
    expect(connection.db.select().from(schema.investigationChallengeClaims).get())
      .toMatchObject({ claimRef: claim.claimRef, challengeRef: challenge.challengeRef });
    expect(connection.db.select().from(schema.investigationChallengeAssessments).get())
      .toMatchObject({ assessmentRef: assessment.assessmentRef, challengeRef: challenge.challengeRef });
    expect(() => clearDemoData(connection.db)).not.toThrow();
    expect(tableCount(schema.investigationChallengeRequests)).toBe(0);
    expect(tableCount(schema.investigationChallengeClaims)).toBe(0);
    expect(tableCount(schema.investigationChallengeAssessments)).toBe(0);
  });

  it('upgrades a populated 0010 database additively and reruns safely', () => {
    const preAssociationFolder = join(directory, 'pre-association-migrations');
    mkdirSync(join(preAssociationFolder, 'meta'), { recursive: true });
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
      '0009_glamorous_celestials.sql',
      '0010_lying_hellcat.sql'
    ]) cpSync(join('drizzle', file), join(preAssociationFolder, file));
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 11);
    writeFileSync(join(preAssociationFolder, 'meta/_journal.json'), JSON.stringify(journal));

    const existing = createDatabaseConnection(join(directory, 'populated-0010.db'));
    try {
      migrate(existing.db, { migrationsFolder: preAssociationFolder });
      seedDemoData(existing.db, fixtures);
      const caseId = randomUUID();
      const requestId = randomUUID();
      existing.db.insert(schema.cases).values({
        id: caseId,
        caseNumber: 'CASE-PRE-ASSOCIATIONS',
        alertId: fixtures.alerts[0].id,
        status: 'open',
        severity: 'high',
        openedAt: gapAt,
        closedAt: null
      }).run();
      existing.db.insert(schema.evidenceRequests).values({
        id: requestId,
        matchId: fixtures.matches[0].id,
        caseId: null,
        questionRef: null,
        requestedEvidence: JSON.stringify(['supplier_invoice']),
        recipient: null,
        status: 'pending',
        createdAt: gapAt,
        resolvedAt: null
      }).run();
      const before = existing.db.select().from(schema.evidenceRequests).all();

      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      expect(existing.db.select().from(schema.evidenceRequests).all()).toEqual(before);
      expect(existing.db.select().from(schema.investigationChallengeRequests).all()).toEqual([]);
      expect(existing.db.select().from(schema.investigationChallengeClaims).all()).toEqual([]);
      expect(existing.db.select().from(schema.investigationChallengeAssessments).all()).toEqual([]);
      expect(existing.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      existing.sqlite.close();
    }
  });
});
