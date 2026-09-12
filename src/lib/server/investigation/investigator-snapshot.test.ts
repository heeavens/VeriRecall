import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { caseSnapshotSchema, type CaseSnapshot } from '../../contracts/recall';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import { batchContradictionRule, recordInvestigationAssessment } from './assessments';
import { applyInvestigationChallengeConflict } from './challenge-conflict-applications';
import { readChallengeConflictApplicationBasis } from './challenge-conflict-basis';
import {
  openInvestigationChallenge,
  openInvestigationConflictContinuation
} from './challenges';
import { recordInvestigationClaim } from './claims';
import { recordInvestigationEvidence } from './evidence-registry';
import {
  buildInvestigatorSnapshotInTransaction,
  resolveCurrentInvestigatorPartitionInTransaction
} from './investigator-snapshot';
import { validateInvestigatorRecommendation } from './investigator-policy';

const matchId = '50000000-0000-4000-8000-000000000002';
const fixtures = loadDemoFixtures();
type Connection = ReturnType<typeof createDatabaseConnection>;
let directory: string;
let connection: Connection;

function gapCase() {
  const confirmed = confirmReviewMatch(
    connection.db,
    { matchId, actorName: 'demo_operator' },
    new Date('2026-09-12T09:00:00.000Z'),
    { mode: 'demo' }
  );
  const snapshot = readCaseSnapshot(connection.db, confirmed.caseId);
  const gap = snapshot?.investigation?.gaps.find((item) => item.code === 'BATCH_MISSING');
  if (!snapshot || !gap) throw new Error('Expected missing-batch demo case.');
  return { snapshot, questionRef: gap.id };
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

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-investigator-snapshot-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('Question-scoped Investigator snapshot', () => {
  it('builds an OPEN_GAP basis with attributed alert facts and no raw source payload', () => {
    const { snapshot, questionRef } = gapCase();
    const built = buildInvestigatorSnapshotInTransaction(connection.db, {
      caseId: snapshot.caseId,
      questionRef
    });
    if ('kind' in built) throw new Error('Expected active Investigator snapshot.');

    expect(built).toMatchObject({
      caseId: snapshot.caseId,
      productId: snapshot.productId,
      caseVersion: snapshot.caseVersion,
      materialRevision: snapshot.materialRevision,
      question: { questionRef, questionType: 'AFFECTED_BATCH_LOT' },
      context: { kind: 'OPEN_GAP' },
      authoritative: { epistemicClass: 'AUTHORITATIVE_CURRENT_FACT' }
    });
    expect(built.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueRef: questionRef, code: 'BATCH_MISSING' })
    ]));
    expect(built.alertFacts.authoritative.every((item) => item.authorityCapable)).toBe(true);
    expect(built.alertFacts.hypotheses.every((item) =>
      item.epistemicClass === 'AI_PROPOSAL' && !item.authorityCapable
    )).toBe(true);
    expect(JSON.stringify(built)).not.toContain('rawPayload');
    expect(JSON.stringify(built)).not.toContain('supplierEmail');
    expect(built.allowedCapabilities.some((item) =>
      item.kind === 'WAIT_FOR_PENDING_EVIDENCE'
    )).toBe(false);
  });

  it('includes complete Question Evidence metadata and detects an exact OPEN_CHALLENGE', () => {
    const { snapshot, questionRef } = gapCase();
    const materialRevision = (snapshot.materialRevision ?? 0) + 1;
    const resolved = caseSnapshotSchema.parse({
      ...snapshot,
      caseVersion: snapshot.caseVersion + 1,
      materialRevision,
      updatedAt: '2026-09-12T11:00:00.000Z',
      investigation: {
        ...snapshot.investigation!,
        materialRevision,
        updatedAt: '2026-09-12T11:00:00.000Z',
        knowledgeStatus: 'KNOWN',
        identity: {
          ...snapshot.investigation!.identity,
          knowledgeStatus: 'KNOWN',
          conclusion: 'MATCH'
        },
        scope: {
          kind: 'BATCH_LOT',
          knowledgeStatus: 'KNOWN',
          lots: ['MFT24'],
          evidenceRefs: snapshot.investigation!.evidenceRefs,
          decisionRefs: snapshot.investigation!.decisionRefs
        },
        gaps: [],
        conflicts: []
      },
      uncertainties: [],
      conflicts: []
    });
    persistSnapshot(resolved);
    recordInvestigationEvidence(connection.db, {
      evidenceRef: 'evidence:investigator:late',
      caseId: snapshot.caseId,
      questionRef,
      evidenceRequestId: null,
      sourceKind: 'EXTERNAL_PARTY',
      sourceIdentifier: 'supplier:document',
      validAsOf: null,
      contentKind: 'STRUCTURED',
      contentJson: { assertedLot: 'MFT25' },
      contentLocator: null,
      demo: true
    }, new Date('2026-09-12T11:30:00.000Z'));
    const opened = openInvestigationChallenge(connection.db, {
      challengeRef: randomUUID(),
      caseId: snapshot.caseId,
      questionRef,
      expectedCaseVersion: resolved.caseVersion,
      expectedMaterialRevision: materialRevision,
      triggerEvidenceRefs: ['evidence:investigator:late'],
      rationale: 'Late evidence requires a new review.',
      demo: true
    }, { mode: 'demo' }, new Date('2026-09-12T12:00:00.000Z'));

    const partition = resolveCurrentInvestigatorPartitionInTransaction(connection.db, {
      caseId: snapshot.caseId,
      questionRef
    });
    expect(partition.kind).toBe('OPEN_CHALLENGE');
    const built = buildInvestigatorSnapshotInTransaction(connection.db, {
      caseId: snapshot.caseId,
      questionRef
    });
    if ('kind' in built) throw new Error('Expected Challenge snapshot.');
    expect(built.context).toMatchObject({
      kind: 'OPEN_CHALLENGE',
      challengeRef: opened.challenge.challengeRef
    });
    expect(built.evidence.map((item) => item.evidenceRef)).toContain(
      'evidence:investigator:late'
    );
  });

  it('returns RESOLVED without inventing a new Question context', () => {
    const { snapshot, questionRef } = gapCase();
    const materialRevision = (snapshot.materialRevision ?? 0) + 1;
    const resolved = caseSnapshotSchema.parse({
      ...snapshot,
      caseVersion: snapshot.caseVersion + 1,
      materialRevision,
      updatedAt: '2026-09-12T11:00:00.000Z',
      investigation: {
        ...snapshot.investigation!,
        materialRevision,
        updatedAt: '2026-09-12T11:00:00.000Z',
        knowledgeStatus: 'KNOWN',
        identity: {
          ...snapshot.investigation!.identity,
          knowledgeStatus: 'KNOWN',
          conclusion: 'MATCH'
        },
        scope: {
          kind: 'BATCH_LOT', knowledgeStatus: 'KNOWN', lots: ['MFT24'],
          evidenceRefs: snapshot.investigation!.evidenceRefs,
          decisionRefs: snapshot.investigation!.decisionRefs
        },
        gaps: [], conflicts: []
      },
      uncertainties: [], conflicts: []
    });
    persistSnapshot(resolved);
    expect(buildInvestigatorSnapshotInTransaction(connection.db, {
      caseId: snapshot.caseId,
      questionRef
    })).toMatchObject({ kind: 'RESOLVED', snapshot: { caseVersion: resolved.caseVersion } });
  });

  it('selects CONTINUATION_REQUIRED then the exact applied-conflict continuation projection', () => {
    const { snapshot, questionRef } = gapCase();
    const baselineEvidenceRef = 'evidence:investigator:conflict:baseline';
    recordInvestigationEvidence(connection.db, {
      evidenceRef: baselineEvidenceRef,
      caseId: snapshot.caseId,
      questionRef,
      evidenceRequestId: null,
      sourceKind: 'EXTERNAL_PARTY',
      sourceIdentifier: 'supplier:baseline',
      validAsOf: null,
      contentKind: 'STRUCTURED',
      contentJson: { assertedLot: 'MFT24' },
      contentLocator: null,
      demo: true
    }, new Date('2026-09-12T09:15:00.000Z'));
    const baselineClaim = recordInvestigationClaim(connection.db, {
      claimRef: randomUUID(),
      caseId: snapshot.caseId,
      questionRef,
      expectedCaseVersion: snapshot.caseVersion,
      claimType: 'AFFECTED_BATCH_LOT',
      value: { lot: 'MFT24' },
      evidenceRefs: [baselineEvidenceRef],
      originKind: 'HUMAN_OBSERVED',
      producerIdentifier: 'demo_operator',
      derivationMetadata: null,
      supersedesClaimRef: null,
      demo: true
    }, { mode: 'demo' }, new Date('2026-09-12T09:20:00.000Z')).claim;
    recordInvestigationAssessment(connection.db, {
      assessmentRef: randomUUID(),
      caseId: snapshot.caseId,
      questionRef,
      expectedCaseVersion: snapshot.caseVersion,
      verdict: 'SUPPORTED',
      targetClaimRef: baselineClaim.claimRef,
      evidenceRefs: [baselineEvidenceRef],
      relatedClaimRefs: [],
      assessorKind: 'HUMAN',
      assessorIdentifier: null,
      ruleIdentifier: null,
      ruleVersion: null,
      rationale: 'The supplier baseline supports MFT24.',
      supersedesAssessmentRef: null,
      demo: true
    }, { mode: 'demo' }, new Date('2026-09-12T09:25:00.000Z'));

    const answerMaterialRevision = snapshot.materialRevision! + 1;
    const answered = caseSnapshotSchema.parse({
      ...snapshot,
      caseVersion: snapshot.caseVersion + 1,
      materialRevision: answerMaterialRevision,
      updatedAt: '2026-09-12T10:00:00.000Z',
      investigation: {
        ...snapshot.investigation!,
        materialRevision: answerMaterialRevision,
        updatedAt: '2026-09-12T10:00:00.000Z',
        knowledgeStatus: 'KNOWN',
        identity: {
          ...snapshot.investigation!.identity,
          knowledgeStatus: 'KNOWN',
          conclusion: 'MATCH'
        },
        scope: {
          kind: 'BATCH_LOT', knowledgeStatus: 'KNOWN', lots: ['MFT24'],
          evidenceRefs: snapshot.investigation!.evidenceRefs,
          decisionRefs: snapshot.investigation!.decisionRefs
        },
        gaps: [], conflicts: []
      },
      uncertainties: [], conflicts: []
    });
    persistSnapshot(answered);
    const lateEvidenceRef = 'evidence:investigator:conflict:late';
    recordInvestigationEvidence(connection.db, {
      evidenceRef: lateEvidenceRef,
      caseId: snapshot.caseId,
      questionRef,
      evidenceRequestId: null,
      sourceKind: 'EXTERNAL_PARTY',
      sourceIdentifier: 'supplier:late',
      validAsOf: null,
      contentKind: 'STRUCTURED',
      contentJson: { assertedLot: 'MFT25' },
      contentLocator: null,
      demo: true
    }, new Date('2026-09-12T10:30:00.000Z'));
    const sourceChallenge = openInvestigationChallenge(connection.db, {
      challengeRef: randomUUID(),
      caseId: snapshot.caseId,
      questionRef,
      expectedCaseVersion: answered.caseVersion,
      expectedMaterialRevision: answered.materialRevision!,
      triggerEvidenceRefs: [lateEvidenceRef],
      rationale: 'Late trusted evidence contradicts the known lot.',
      demo: true
    }, { mode: 'demo' }, new Date('2026-09-12T11:00:00.000Z')).challenge;
    const challengeClaim = recordInvestigationClaim(connection.db, {
      claimRef: randomUUID(),
      caseId: snapshot.caseId,
      questionRef,
      challengeRef: sourceChallenge.challengeRef,
      expectedCaseVersion: answered.caseVersion,
      expectedMaterialRevision: answered.materialRevision!,
      claimType: 'AFFECTED_BATCH_LOT',
      value: { lot: 'MFT25' },
      evidenceRefs: [lateEvidenceRef],
      originKind: 'HUMAN_OBSERVED',
      producerIdentifier: 'demo_operator',
      derivationMetadata: null,
      supersedesClaimRef: null,
      demo: true
    }, { mode: 'demo' }, new Date('2026-09-12T11:10:00.000Z')).claim;
    const contradiction = recordInvestigationAssessment(connection.db, {
      assessmentRef: randomUUID(),
      caseId: snapshot.caseId,
      questionRef,
      challengeRef: sourceChallenge.challengeRef,
      expectedCaseVersion: answered.caseVersion,
      expectedMaterialRevision: answered.materialRevision!,
      verdict: 'CONTRADICTED',
      targetClaimRef: null,
      evidenceRefs: [baselineEvidenceRef, lateEvidenceRef],
      relatedClaimRefs: [baselineClaim.claimRef, challengeClaim.claimRef],
      assessorKind: 'RULE',
      assessorIdentifier: 'batch-contradiction-rule',
      ruleIdentifier: batchContradictionRule.identifier,
      ruleVersion: batchContradictionRule.version,
      rationale: 'The trusted sources assert incompatible lots.',
      supersedesAssessmentRef: null,
      demo: true
    }, { mode: 'demo' }, new Date('2026-09-12T11:20:00.000Z')).assessment;
    const basis = readChallengeConflictApplicationBasis(
      connection.db,
      snapshot.caseId,
      questionRef,
      sourceChallenge.challengeRef
    );
    expect(basis.eligibility.eligible).toBe(true);
    const applied = applyInvestigationChallengeConflict(connection.db, {
      applicationRef: randomUUID(),
      caseId: snapshot.caseId,
      questionRef,
      challengeRef: sourceChallenge.challengeRef,
      expectedCaseVersion: answered.caseVersion,
      expectedMaterialRevision: answered.materialRevision!,
      expectedApplicationBasisDigest: basis.applicationBasisDigest,
      rationale: 'The human accepts the exact conflict as authoritative and unresolved.',
      demo: true
    }, { mode: 'demo' }, new Date('2026-09-12T11:30:00.000Z'));

    expect(resolveCurrentInvestigatorPartitionInTransaction(connection.db, {
      caseId: snapshot.caseId,
      questionRef
    })).toMatchObject({
      kind: 'CONTINUATION_REQUIRED',
      conflictApplicationRef: applied.application.applicationRef
    });
    const continuation = openInvestigationConflictContinuation(connection.db, {
      challengeRef: randomUUID(),
      caseId: snapshot.caseId,
      questionRef,
      expectedCaseVersion: applied.snapshot.caseVersion,
      expectedMaterialRevision: applied.snapshot.materialRevision!,
      rationale: 'Continue the investigation from the exact authoritative conflict.',
      demo: true
    }, { mode: 'demo' }, new Date('2026-09-12T12:00:00.000Z')).challenge;
    const built = buildInvestigatorSnapshotInTransaction(connection.db, {
      caseId: snapshot.caseId,
      questionRef
    });
    if ('kind' in built) throw new Error('Expected conflict-continuation snapshot.');
    expect(built.context).toMatchObject({
      kind: 'APPLIED_CHALLENGE_CONFLICT',
      continuationChallengeRef: continuation.challengeRef,
      sourceChallengeRef: sourceChallenge.challengeRef,
      conflictApplicationRef: applied.application.applicationRef
    });
    expect(built.claims.map((item) => item.claimRef)).toEqual(expect.arrayContaining([
      baselineClaim.claimRef, challengeClaim.claimRef
    ]));
    expect(built.assessments).toContainEqual(expect.objectContaining({
      assessmentRef: contradiction.assessmentRef,
      partition: 'AUTHORITATIVE_HISTORICAL_PROVENANCE',
      materiallyCurrent: false
    }));
    const requestCapability = built.allowedCapabilities.find((item) =>
      item.kind === 'REQUEST_EVIDENCE'
    );
    if (!requestCapability || requestCapability.kind !== 'REQUEST_EVIDENCE') {
      throw new Error('Expected a discriminating Evidence capability.');
    }
    expect(() => validateInvestigatorRecommendation(built, {
      schemaVersion: 1,
      recommendation: requestCapability,
      rationale: 'MFT24 is the correct affected lot, so request more evidence.',
      basedOn: {
        evidenceRefs: [baselineEvidenceRef, lateEvidenceRef],
        claimRefs: [baselineClaim.claimRef, challengeClaim.claimRef],
        assessmentRefs: [contradiction.assessmentRef],
        issueRefs: [questionRef],
        requestRefs: []
      },
      expectedInformationGain: 'Further evidence may discriminate the conflict.',
      limitations: ['The conflict remains authoritative.']
    })).toThrow(/may not select a winner/);
  });
});
