import { randomUUID } from 'node:crypto';
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
import type { InvestigatorLlmClient } from '../llm/investigator-client';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import { recordInvestigationEvidence } from './evidence-registry';
import { requestInvestigationEvidence } from './evidence-requests';
import { getInvestigatorRecommendationInTransaction } from './investigator-ledger';
import {
  investigateNextStep,
  recordInvestigatorRecommendationEvent
} from './investigator';
import type { InvestigatorModelInputV1 } from './investigator-policy';
import { buildInvestigatorSnapshotInTransaction } from './investigator-snapshot';

const fixtures = loadDemoFixtures();
let directory: string;
let connection: ReturnType<typeof createDatabaseConnection>;

class MockInvestigator implements InvestigatorLlmClient {
  readonly provenance = {
    providerIdentifier: 'mock_provider',
    clientIdentifier: 'mock_investigator_v1',
    modelIdentifier: 'mock-model',
    promptPolicyVersion: 'v1'
  };
  calls = 0;
  constructor(
    private readonly output: (snapshot: InvestigatorModelInputV1) => unknown
  ) {}
  async recommendNextStep(snapshot: InvestigatorModelInputV1): Promise<unknown> {
    this.calls += 1;
    return this.output(snapshot);
  }
}

function setupGap() {
  const confirmed = confirmReviewMatch(connection.db, {
    matchId: '50000000-0000-4000-8000-000000000002',
    actorName: 'demo_operator'
  }, new Date('2026-09-12T09:00:00.000Z'), { mode: 'demo' });
  const snapshot = readCaseSnapshot(connection.db, confirmed.caseId)!;
  const questionRef = snapshot.investigation!.gaps[0].id;
  return { snapshot, questionRef };
}

function requestRecommendation(snapshot: InvestigatorModelInputV1) {
  const issueRef = snapshot.issues[0].issueRef;
  return {
    schemaVersion: 1,
    recommendation: {
      kind: 'REQUEST_EVIDENCE',
      evidenceType: 'batch_label_photo',
      target: 'CURRENT_PRODUCT_SUPPLIER'
    },
    rationale: 'Request trusted batch-label evidence for the exact recorded scope gap.',
    basedOn: {
      evidenceRefs: [], claimRefs: [], assessmentRefs: [], issueRefs: [issueRef], requestRefs: []
    },
    expectedInformationGain: 'The requested label can discriminate the affected lot.',
    limitations: ['The recommendation does not establish a lot.']
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-investigator-service-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('constrained Investigator orchestration', () => {
  it('persists one immutable recommendation and replays the same basis without a model call', async () => {
    const { snapshot, questionRef } = setupGap();
    const client = new MockInvestigator(requestRecommendation);
    const input = {
      caseId: snapshot.caseId,
      questionRef,
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!
    };
    const first = await investigateNextStep(
      connection.db, input, client, { mode: 'demo' },
      new Date('2026-09-12T10:00:00.000Z')
    );
    const second = await investigateNextStep(connection.db, input, client, { mode: 'demo' });

    expect(first).toMatchObject({ kind: 'RECOMMENDATION', replayed: false });
    if (first.kind !== 'RECOMMENDATION') throw new Error('Expected recommendation.');
    expect(second).toMatchObject({
      kind: 'RECOMMENDATION', replayed: true,
      recommendation: { recommendationRef: first.recommendation.recommendationRef }
    });
    expect(client.calls).toBe(1);
    expect(connection.db.select({ value: count() })
      .from(schema.investigationInvestigatorRecommendations).get()?.value).toBe(1);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(snapshot);
  });

  it('returns one persisted winner when same-basis model calls race', async () => {
    const { snapshot, questionRef } = setupGap();
    let arrivals = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const client = new MockInvestigator(async (basis) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothArrived;
      return requestRecommendation(basis);
    });
    const input = {
      caseId: snapshot.caseId,
      questionRef,
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!
    };
    const results = await Promise.all([
      investigateNextStep(connection.db, input, client, { mode: 'demo' }),
      investigateNextStep(connection.db, input, client, { mode: 'demo' })
    ]);
    expect(client.calls).toBe(2);
    expect(results.map((item) => item.kind)).toEqual(['RECOMMENDATION', 'RECOMMENDATION']);
    const refs = results.map((item) =>
      item.kind === 'RECOMMENDATION' ? item.recommendation.recommendationRef : null
    );
    expect(new Set(refs).size).toBe(1);
    expect(results.filter((item) => item.kind === 'RECOMMENDATION' && item.replayed))
      .toHaveLength(1);
    expect(connection.db.select({ value: count() })
      .from(schema.investigationInvestigatorRecommendations).get()?.value).toBe(1);
  });

  it('detects a non-material Evidence write during the model call and persists nothing', async () => {
    const { snapshot, questionRef } = setupGap();
    const client = new MockInvestigator((basis) => {
      recordInvestigationEvidence(connection.db, {
        evidenceRef: 'evidence:arrived:during-model',
        caseId: snapshot.caseId,
        questionRef,
        evidenceRequestId: null,
        sourceKind: 'EXTERNAL_PARTY',
        sourceIdentifier: 'supplier:label',
        validAsOf: null,
        contentKind: 'STRUCTURED',
        contentJson: { assertedLot: 'MFT25' },
        contentLocator: null,
        demo: true
      }, new Date('2026-09-12T10:00:00.000Z'));
      return requestRecommendation(basis);
    });
    await expect(investigateNextStep(connection.db, {
      caseId: snapshot.caseId,
      questionRef,
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!
    }, client, { mode: 'demo' })).rejects.toMatchObject({ code: 'INVESTIGATOR_BASIS_STALE' });
    expect(connection.db.select({ value: count() })
      .from(schema.investigationInvestigatorRecommendations).get()?.value).toBe(0);
  });

  it('rejects invented model refs atomically', async () => {
    const { snapshot, questionRef } = setupGap();
    const client = new MockInvestigator((basis) => ({
      ...requestRecommendation(basis),
      basedOn: {
        evidenceRefs: ['invented:evidence'], claimRefs: [], assessmentRefs: [],
        issueRefs: [], requestRefs: []
      }
    }));
    await expect(investigateNextStep(connection.db, {
      caseId: snapshot.caseId, questionRef,
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!
    }, client, { mode: 'demo' })).rejects.toMatchObject({
      code: 'INVESTIGATOR_REFERENCE_INVALID'
    });
    expect(connection.db.select({ value: count() })
      .from(schema.investigationInvestigatorRecommendations).get()?.value).toBe(0);
  });

  it('records immutable HUMAN dismissal and acted audit events without changing truth', async () => {
    const { snapshot, questionRef } = setupGap();
    const firstClient = new MockInvestigator(requestRecommendation);
    const first = await investigateNextStep(connection.db, {
      caseId: snapshot.caseId, questionRef,
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!
    }, firstClient, { mode: 'demo' });
    if (first.kind !== 'RECOMMENDATION') throw new Error('Expected recommendation.');
    const before = readCaseSnapshot(connection.db, snapshot.caseId);
    const eventRef = randomUUID();
    const dismissed = recordInvestigatorRecommendationEvent(connection.db, {
      eventRef,
      recommendationRef: first.recommendation.recommendationRef,
      eventKind: 'DISMISSED',
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!,
      rationale: 'The operator selected a different supported path.',
      demo: true
    }, { mode: 'demo' }, new Date('2026-09-12T11:00:00.000Z'));
    expect(dismissed.event).toMatchObject({ actorKind: 'HUMAN', actorIdentifier: 'demo_operator' });
    expect(recordInvestigatorRecommendationEvent(connection.db, {
      eventRef,
      recommendationRef: first.recommendation.recommendationRef,
      eventKind: 'DISMISSED',
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!,
      rationale: 'The operator selected a different supported path.',
      demo: true
    }, { mode: 'demo' }).replayed).toBe(true);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(before);
  });

  it('links ACTED only to an exact current-partition human-created Evidence Request', async () => {
    const { snapshot, questionRef } = setupGap();
    const client = new MockInvestigator(requestRecommendation);
    const result = await investigateNextStep(connection.db, {
      caseId: snapshot.caseId, questionRef,
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!
    }, client, { mode: 'demo' }, new Date('2026-09-12T10:00:00.000Z'));
    if (result.kind !== 'RECOMMENDATION') throw new Error('Expected recommendation.');
    const requestId = randomUUID();
    requestInvestigationEvidence(connection.db, {
      requestId,
      caseId: snapshot.caseId,
      questionRef,
      expectedCaseVersion: snapshot.caseVersion,
      requestedEvidence: ['batch_label_photo'],
      demo: true
    }, { mode: 'demo' }, new Date('2026-09-12T10:30:00.000Z'));
    const event = recordInvestigatorRecommendationEvent(connection.db, {
      eventRef: randomUUID(),
      recommendationRef: result.recommendation.recommendationRef,
      eventKind: 'ACTED',
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!,
      linkedArtifact: { kind: 'EVIDENCE_REQUEST', ref: requestId },
      rationale: 'The operator recorded the recommended evidence request.',
      demo: true
    }, { mode: 'demo' });
    expect(event.event).toMatchObject({
      eventKind: 'ACTED', linkedArtifactKind: 'EVIDENCE_REQUEST', linkedArtifactRef: requestId
    });
  });

  it('requires current durable Evidence before a HUMAN can exhaust a recommendation path', async () => {
    const { snapshot, questionRef } = setupGap();
    recordInvestigationEvidence(connection.db, {
      evidenceRef: 'evidence:path:unavailable',
      caseId: snapshot.caseId,
      questionRef,
      evidenceRequestId: null,
      sourceKind: 'HUMAN_OBSERVED',
      sourceIdentifier: 'demo_operator',
      validAsOf: null,
      contentKind: 'STRUCTURED',
      contentJson: { sourceUnavailable: true },
      contentLocator: null,
      demo: true
    }, new Date('2026-09-12T09:30:00.000Z'));
    const client = new MockInvestigator(requestRecommendation);
    const result = await investigateNextStep(connection.db, {
      caseId: snapshot.caseId, questionRef,
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!
    }, client, { mode: 'demo' });
    if (result.kind !== 'RECOMMENDATION') throw new Error('Expected recommendation.');
    expect(() => recordInvestigatorRecommendationEvent(connection.db, {
      eventRef: randomUUID(),
      recommendationRef: result.recommendation.recommendationRef,
      eventKind: 'PATH_EXHAUSTED',
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!,
      linkedArtifact: null,
      supportingEvidenceRefs: ['invented:evidence'],
      rationale: 'The operator could not obtain the requested record.',
      demo: true
    }, { mode: 'demo' })).toThrow(/current durable supporting Evidence/);
    const exhausted = recordInvestigatorRecommendationEvent(connection.db, {
      eventRef: randomUUID(),
      recommendationRef: result.recommendation.recommendationRef,
      eventKind: 'PATH_EXHAUSTED',
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!,
      linkedArtifact: null,
      supportingEvidenceRefs: ['evidence:path:unavailable'],
      rationale: 'The operator recorded durable evidence that this path is unavailable.',
      demo: true
    }, { mode: 'demo' });
    expect(exhausted.event).toMatchObject({
      eventKind: 'PATH_EXHAUSTED', actorKind: 'HUMAN',
      supportingEvidenceRefs: ['evidence:path:unavailable']
    });
    expect(() => connection.db.update(schema.investigationInvestigatorRecommendationEvents)
      .set({ actorKind: 'AI' as 'HUMAN' }).run()).toThrow(/CHECK constraint failed/);
    const blocked = buildInvestigatorSnapshotInTransaction(connection.db, {
      caseId: snapshot.caseId,
      questionRef
    });
    if ('kind' in blocked) throw new Error('Expected active snapshot.');
    expect(blocked.allowedCapabilities).not.toContainEqual(expect.objectContaining({
      kind: 'REQUEST_EVIDENCE', evidenceType: 'batch_label_photo'
    }));
    recordInvestigationEvidence(connection.db, {
      evidenceRef: 'evidence:path:new-state',
      caseId: snapshot.caseId,
      questionRef,
      evidenceRequestId: null,
      sourceKind: 'EXTERNAL_PARTY',
      sourceIdentifier: 'supplier:new-state',
      validAsOf: null,
      contentKind: 'STRUCTURED',
      contentJson: { newlyAvailable: true },
      contentLocator: null,
      demo: true
    }, new Date('2026-09-12T11:00:00.000Z'));
    const reconsidered = buildInvestigatorSnapshotInTransaction(connection.db, {
      caseId: snapshot.caseId,
      questionRef
    });
    if ('kind' in reconsidered) throw new Error('Expected active snapshot.');
    expect(reconsidered.allowedCapabilities).toContainEqual(expect.objectContaining({
      kind: 'REQUEST_EVIDENCE', evidenceType: 'batch_label_photo'
    }));
  });

  it('fails closed when immutable recommendation digests are corrupted', async () => {
    const { snapshot, questionRef } = setupGap();
    const client = new MockInvestigator(requestRecommendation);
    const result = await investigateNextStep(connection.db, {
      caseId: snapshot.caseId, questionRef,
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!
    }, client, { mode: 'demo' });
    if (result.kind !== 'RECOMMENDATION') throw new Error('Expected recommendation.');
    connection.db.update(schema.investigationInvestigatorRecommendations).set({
      actionKey: `sha256:${'f'.repeat(64)}`
    }).run();
    expect(() => getInvestigatorRecommendationInTransaction(
      connection.db,
      result.recommendation.recommendationRef
    )).toThrow(/identity, digest, or provenance is invalid/);
  });

  it('maps an arbitrary client failure without leaking its raw error or persisting a row', async () => {
    const { snapshot, questionRef } = setupGap();
    const client = new MockInvestigator(() => {
      throw new Error('secret upstream response body');
    });
    const failure = await investigateNextStep(connection.db, {
      caseId: snapshot.caseId,
      questionRef,
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision!
    }, client, { mode: 'demo' }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'INVESTIGATOR_MODEL_ERROR' });
    expect(String(failure)).not.toContain('secret upstream response body');
    expect(connection.db.select({ value: count() })
      .from(schema.investigationInvestigatorRecommendations).get()?.value).toBe(0);
  });
});
