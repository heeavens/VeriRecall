import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import {
  canonicalInvestigatorJson,
  deriveInvestigatorCapabilities,
  investigatorDigest,
  parseInvestigatorModelOutput,
  validateInvestigatorRecommendation,
  type InvestigatorModelOutput,
  type InvestigatorSnapshot
} from './investigator-policy';
import { buildInvestigatorSnapshotInTransaction } from './investigator-snapshot';

const fixtures = loadDemoFixtures();
let directory: string;
let connection: ReturnType<typeof createDatabaseConnection>;
let snapshot: InvestigatorSnapshot;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-investigator-policy-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
  const confirmed = confirmReviewMatch(connection.db, {
    matchId: '50000000-0000-4000-8000-000000000002',
    actorName: 'demo_operator'
  }, new Date('2026-09-12T09:00:00.000Z'), { mode: 'demo' });
  const current = readCaseSnapshot(connection.db, confirmed.caseId)!;
  const questionRef = current.investigation!.gaps[0].id;
  const built = buildInvestigatorSnapshotInTransaction(connection.db, {
    caseId: current.caseId,
    questionRef
  });
  if ('kind' in built) throw new Error('Expected active snapshot.');
  snapshot = built;
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

function requestOutput(overrides: Partial<InvestigatorModelOutput> = {}): InvestigatorModelOutput {
  const issueRef = snapshot.issues[0].issueRef;
  return {
    schemaVersion: 1,
    recommendation: {
      kind: 'REQUEST_EVIDENCE',
      evidenceType: 'batch_label_photo',
      target: 'CURRENT_PRODUCT_SUPPLIER'
    },
    rationale: 'Request trusted batch-label evidence to resolve the recorded scope gap.',
    basedOn: {
      evidenceRefs: [], claimRefs: [], assessmentRefs: [], issueRefs: [issueRef], requestRefs: []
    },
    expectedInformationGain: 'A trusted label can establish or challenge the affected lot.',
    limitations: ['This recommendation does not establish any batch.'],
    ...overrides
  };
}

describe('constrained Investigator policy', () => {
  it('keeps WAIT disabled and derives stable semantic digests', () => {
    expect(deriveInvestigatorCapabilities(snapshot).some((item) =>
      item.kind === 'WAIT_FOR_PENDING_EVIDENCE'
    )).toBe(false);
    expect(investigatorDigest(snapshot)).toBe(investigatorDigest(JSON.parse(
      canonicalInvestigatorJson(snapshot)
    )));
  });

  it('accepts an allowed grounded request and canonicalizes its refs', () => {
    const issueRef = snapshot.issues[0].issueRef;
    const parsed = parseInvestigatorModelOutput(requestOutput({
      basedOn: {
        evidenceRefs: [], claimRefs: [], assessmentRefs: [],
        issueRefs: [issueRef, issueRef], requestRefs: []
      }
    }));
    expect(validateInvestigatorRecommendation(snapshot, parsed).basedOn.issueRefs)
      .toEqual([issueRef]);
  });

  it('validates every currently exposed non-request recommendation shape', () => {
    const evidenceRef = 'evidence:policy:existing';
    const reviewSnapshot: InvestigatorSnapshot = {
      ...snapshot,
      evidence: [{
        evidenceRef,
        sourceKind: 'EXTERNAL_PARTY',
        contentKind: 'STRUCTURED',
        evidenceRequestId: null,
        receivedAt: '2026-09-12T10:00:00.000Z',
        validAsOf: null,
        integrityHash: 'a'.repeat(64),
        relevance: 'OPEN_GAP',
        epistemicClass: 'UNKNOWN'
      }],
      allowedCapabilities: [{
        kind: 'REVIEW_EXISTING_EVIDENCE', evidenceRefs: [evidenceRef], claimRefs: []
      }]
    };
    expect(validateInvestigatorRecommendation(reviewSnapshot, {
      ...requestOutput(),
      recommendation: { kind: 'REVIEW_EXISTING_EVIDENCE', evidenceRefs: [evidenceRef], claimRefs: [] },
      basedOn: {
        evidenceRefs: [evidenceRef], claimRefs: [], assessmentRefs: [], issueRefs: [], requestRefs: []
      }
    }).recommendation.kind).toBe('REVIEW_EXISTING_EVIDENCE');

    const requestRef = randomUUID();
    const followSnapshot: InvestigatorSnapshot = {
      ...snapshot,
      requests: [{
        requestRef,
        requestedEvidence: ['batch_label_photo'],
        contextChallengeRef: null,
        linkedEvidenceRefs: [],
        lifecycle: 'REQUEST_ATTEMPT_RECORDED',
        createdAt: '2026-09-12T10:00:00.000Z',
        epistemicClass: 'OPERATIONAL_STATE'
      }],
      allowedCapabilities: [{ kind: 'FOLLOW_UP_RECORDED_REQUEST', requestRef }]
    };
    expect(validateInvestigatorRecommendation(followSnapshot, {
      ...requestOutput(),
      recommendation: { kind: 'FOLLOW_UP_RECORDED_REQUEST', requestRef },
      basedOn: {
        evidenceRefs: [], claimRefs: [], assessmentRefs: [], issueRefs: [], requestRefs: [requestRef]
      }
    }).recommendation.kind).toBe('FOLLOW_UP_RECORDED_REQUEST');

    const issueRef = snapshot.issues[0].issueRef;
    const escalationSnapshot: InvestigatorSnapshot = {
      ...snapshot,
      allowedCapabilities: [{ kind: 'ESCALATE_UNRESOLVED_TO_HUMAN', issueRefs: [issueRef] }]
    };
    expect(validateInvestigatorRecommendation(escalationSnapshot, {
      ...requestOutput(),
      recommendation: { kind: 'ESCALATE_UNRESOLVED_TO_HUMAN', issueRefs: [issueRef] },
      basedOn: {
        evidenceRefs: [], claimRefs: [], assessmentRefs: [], issueRefs: [issueRef], requestRefs: []
      },
      expectedInformationGain: null
    }).recommendation.kind).toBe('ESCALATE_UNRESOLVED_TO_HUMAN');

    const noActionSnapshot: InvestigatorSnapshot = {
      ...snapshot,
      establishment: { ...snapshot.establishment, awaitingHumanAuthority: true },
      allowedCapabilities: [{ kind: 'NO_ACTION', reason: 'AWAITING_HUMAN_AUTHORITY' }]
    };
    expect(validateInvestigatorRecommendation(noActionSnapshot, {
      ...requestOutput(),
      recommendation: { kind: 'NO_ACTION', reason: 'AWAITING_HUMAN_AUTHORITY' },
      basedOn: {
        evidenceRefs: [], claimRefs: [], assessmentRefs: [], issueRefs: [], requestRefs: []
      },
      expectedInformationGain: null
    }).recommendation.kind).toBe('NO_ACTION');
  });

  it('rejects invented refs, WAIT, arbitrary recipients, and disguised consequential commands', () => {
    expect(() => validateInvestigatorRecommendation(snapshot, requestOutput({
      basedOn: {
        evidenceRefs: ['invented:evidence'], claimRefs: [], assessmentRefs: [],
        issueRefs: [], requestRefs: []
      }
    }))).toThrow(/missing or excluded/);
    expect(() => validateInvestigatorRecommendation(snapshot, {
      ...requestOutput(),
      recommendation: { kind: 'WAIT_FOR_PENDING_EVIDENCE', pendingProcessRef: 'request:fake' }
    })).toThrow(/not permitted/);
    expect(() => parseInvestigatorModelOutput({
      ...requestOutput(),
      recommendation: {
        kind: 'REQUEST_EVIDENCE', evidenceType: 'batch_label_photo',
        target: 'supplier@example.test'
      }
    })).toThrow(/invalid structured/);
    expect(() => parseInvestigatorModelOutput({
      ...requestOutput(),
      recommendation: { kind: 'CLOSE_CASE' }
    })).toThrow(/invalid structured/);
    expect(() => validateInvestigatorRecommendation(snapshot, requestOutput({
      rationale: 'Email supplier@example.test and close the case.'
    }))).toThrow(/executable or consequential/);
  });

  it('never treats an AI-proposed lot mention as fact', () => {
    snapshot = {
      ...snapshot,
      alertFacts: {
        ...snapshot.alertFacts,
        hypotheses: [{
          assertionRef: 'assertion:ai:lot',
          fieldKind: 'BATCH_LOT',
          normalizedValue: 'MFT25',
          originKind: 'AI_PROPOSAL',
          authorityCapable: false,
          epistemicClass: 'AI_PROPOSAL'
        }]
      }
    };
    expect(() => validateInvestigatorRecommendation(snapshot, requestOutput({
      rationale: 'MFT25 is the affected batch, so request a label.'
    }))).toThrow(/unverified hypothesis/);
    expect(validateInvestigatorRecommendation(snapshot, requestOutput({
      rationale: 'MFT25 is only an unverified AI proposal; request trusted batch evidence.'
    })).recommendation.kind).toBe('REQUEST_EVIDENCE');
  });
});
