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

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { caseSnapshotSchema, investigationOutcomeSchema, type CaseSnapshot } from '../../contracts/recall';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { clearDemoData, seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import { demoHumanAssessorIdentifier, recordInvestigationAssessment } from './assessments';
import { openInvestigationChallenge } from './challenges';
import { recordInvestigationClaim } from './claims';
import {
  applyInvestigationEstablishedBatch,
  getInvestigationEstablishedBatchApplication,
  InvestigationEstablishedBatchApplicationError
} from './established-batch-applications';
import {
  establishedBatchApplicationBasisFormatVersion,
  establishedBatchApplicationPolicy,
  readEstablishedBatchApplicationBasis,
  readEstablishedBatchApplicationBasisInTransaction
} from './established-batch-application-basis';
import {
  InvestigationEstablishmentError,
  recordInvestigationEstablishment
} from './establishments';
import { recordInvestigationEvidence } from './evidence-registry';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const fixtures = loadDemoFixtures();
const matchId = '50000000-0000-4000-8000-000000000002';
const context = { mode: 'demo' as const };
const applicationAt = '2026-09-10T14:00:00.000Z';
let directory: string;
let connection: TestConnection;

function recordEvidence(
  snapshot: CaseSnapshot,
  questionRef: string,
  evidenceRef: string,
  sourceKind: 'INTERNAL' | 'EXTERNAL_PARTY',
  receivedAt: string,
  lot = 'MFT-24'
) {
  return recordInvestigationEvidence(connection.db, {
    evidenceRef,
    caseId: snapshot.caseId,
    questionRef,
    evidenceRequestId: null,
    sourceKind,
    sourceIdentifier: `${sourceKind.toLowerCase()}:${evidenceRef}`,
    validAsOf: null,
    contentKind: 'STRUCTURED',
    contentJson: { lot, sourceKind, evidenceRef },
    contentLocator: null,
    demo: true
  }, new Date(receivedAt)).evidence;
}

function seedEligibleEstablishment() {
  const match = fixtures.matches.find((candidate) => candidate.id === matchId);
  const product = fixtures.products.find((candidate) => candidate.id === match?.productId);
  if (!match || !product?.ean) throw new Error('Expected a batch-gap fixture with an EAN.');
  connection.db.update(schema.alerts).set({ ean: product.ean })
    .where(eq(schema.alerts.id, match.alertId)).run();
  connection.db.update(schema.matches).set({ hasHardConflict: false })
    .where(eq(schema.matches.id, matchId)).run();
  const confirmed = confirmReviewMatch(
    connection.db,
    { matchId, actorName: demoHumanAssessorIdentifier },
    new Date('2026-09-10T10:00:00.000Z'),
    context
  );
  const snapshot = readCaseSnapshot(connection.db, confirmed.caseId);
  const questionRef = snapshot?.investigation?.gaps.find(
    (issue) => issue.code === 'BATCH_MISSING'
  )?.id;
  if (!snapshot?.investigation || !questionRef || snapshot.materialRevision === null) {
    throw new Error('Expected a versioned BATCH_MISSING fixture.');
  }
  const internal = recordEvidence(
    snapshot,
    questionRef,
    'evidence:established-application:internal',
    'INTERNAL',
    '2026-09-10T10:10:00.000Z'
  );
  const external = recordEvidence(
    snapshot,
    questionRef,
    'evidence:established-application:external',
    'EXTERNAL_PARTY',
    '2026-09-10T10:11:00.000Z'
  );
  const evidenceRefs = [external.evidenceRef, internal.evidenceRef];
  const claim = recordInvestigationClaim(connection.db, {
    claimRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    claimType: 'AFFECTED_BATCH_LOT',
    value: { lot: ' MFT-24 ' },
    evidenceRefs,
    originKind: 'DETERMINISTIC_EXTRACTED',
    producerIdentifier: 'demo-batch-parser:v1',
    derivationMetadata: null,
    supersedesClaimRef: null,
    demo: true
  }, context, new Date('2026-09-10T10:20:00.000Z')).claim;
  const assessment = recordInvestigationAssessment(connection.db, {
    assessmentRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    verdict: 'SUPPORTED',
    targetClaimRef: claim.claimRef,
    evidenceRefs,
    relatedClaimRefs: [],
    assessorKind: 'HUMAN',
    assessorIdentifier: null,
    ruleIdentifier: null,
    ruleVersion: null,
    rationale: 'Human reviewed the complete dual-source batch evidence.',
    supersedesAssessmentRef: null,
    demo: true
  }, context, new Date('2026-09-10T10:30:00.000Z')).assessment;
  let establishment;
  try {
    establishment = recordInvestigationEstablishment(connection.db, {
      establishmentRef: randomUUID(),
      caseId: snapshot.caseId,
      questionRef,
      claimRef: claim.claimRef,
      expectedCaseVersion: snapshot.caseVersion,
      expectedMaterialRevision: snapshot.materialRevision,
      demo: true
    }, context, new Date('2026-09-10T10:40:00.000Z')).establishment;
  } catch (error) {
    if (error instanceof InvestigationEstablishmentError) {
      throw new Error(`Establishment fixture blockers: ${error.blockerCodes.join(',')}`);
    }
    throw error;
  }
  const basis = readEstablishedBatchApplicationBasis(
    connection.db,
    snapshot.caseId,
    questionRef,
    establishment.establishmentRef
  );
  return { snapshot, questionRef, internal, external, claim, assessment, establishment, basis };
}

function applicationInput(seed: ReturnType<typeof seedEligibleEstablishment>) {
  return {
    applicationRef: randomUUID(),
    caseId: seed.snapshot.caseId,
    questionRef: seed.questionRef,
    establishmentRef: seed.establishment.establishmentRef,
    expectedCaseVersion: seed.snapshot.caseVersion,
    expectedMaterialRevision: seed.snapshot.materialRevision!,
    expectedApplicationBasisDigest: seed.basis.applicationBasisDigest,
    rationale: '  Reviewed the exact current established batch basis.  ',
    demo: true as const
  };
}

function expectApplicationError(
  action: () => unknown,
  code: InvestigationEstablishedBatchApplicationError['code']
): void {
  try {
    action();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationEstablishedBatchApplicationError);
    expect((error as InvestigationEstablishedBatchApplicationError).code).toBe(code);
  }
}

function state(caseId: string) {
  return {
    caseRecord: connection.db.select().from(schema.cases)
      .where(eq(schema.cases.id, caseId)).get(),
    snapshot: readCaseSnapshot(connection.db, caseId),
    revisions: connection.db.select().from(schema.caseRevisions)
      .where(eq(schema.caseRevisions.caseId, caseId)).all(),
    commands: connection.db.select().from(schema.caseCommands)
      .where(eq(schema.caseCommands.caseId, caseId)).all(),
    audit: connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.caseId, caseId)).all(),
    decisions: readCaseSnapshot(connection.db, caseId)?.decisions,
    tasks: readCaseSnapshot(connection.db, caseId)?.tasks,
    exposure: readCaseSnapshot(connection.db, caseId)?.exposure,
    closure: readCaseSnapshot(connection.db, caseId)?.closure,
    traceability: connection.db.select().from(schema.traceabilityRecords)
      .where(eq(schema.traceabilityRecords.caseId, caseId)).all(),
    applications: connection.db.select().from(schema.investigationEstablishedBatchApplications)
      .where(eq(schema.investigationEstablishedBatchApplications.caseId, caseId)).all()
  };
}

function persistOperationalRevision(snapshot: CaseSnapshot): CaseSnapshot {
  const updated = caseSnapshotSchema.parse({
    ...snapshot,
    caseVersion: snapshot.caseVersion + 1,
    updatedAt: '2026-09-10T15:00:00.000Z'
  });
  connection.db.update(schema.caseLifecycle).set({
    caseVersion: updated.caseVersion,
    materialRevision: updated.materialRevision,
    snapshotJson: JSON.stringify(updated),
    updatedAt: updated.updatedAt
  }).where(eq(schema.caseLifecycle.caseId, updated.caseId)).run();
  connection.db.insert(schema.caseRevisions).values({
    id: randomUUID(),
    caseId: updated.caseId,
    caseVersion: updated.caseVersion,
    materialRevision: updated.materialRevision,
    snapshotJson: JSON.stringify(updated),
    actorId: 'test_fixture',
    createdAt: updated.updatedAt
  }).run();
  return updated;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verirecall-established-batch-application-'));
  connection = createDatabaseConnection(join(directory, 'test.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('established batch application basis', () => {
  it('is deterministic, canonical, policy-versioned, and transaction-compatible', () => {
    const seed = seedEligibleEstablishment();
    const beforeRead = state(seed.snapshot.caseId);
    const again = readEstablishedBatchApplicationBasis(
      connection.db,
      seed.snapshot.caseId,
      seed.questionRef,
      seed.establishment.establishmentRef
    );
    const nested = connection.db.transaction((transaction) =>
      readEstablishedBatchApplicationBasisInTransaction(
        transaction,
        seed.snapshot.caseId,
        seed.questionRef,
        seed.establishment.establishmentRef
      ),
    { behavior: 'immediate' });

    expect(again).toEqual(seed.basis);
    expect(nested).toEqual(seed.basis);
    expect(seed.basis).toMatchObject({
      basisFormatVersion: establishedBatchApplicationBasisFormatVersion,
      applicationPolicyIdentifier: establishedBatchApplicationPolicy.identifier,
      applicationPolicyVersion: establishedBatchApplicationPolicy.version,
      caseId: seed.snapshot.caseId,
      questionRef: seed.questionRef,
      establishmentRef: seed.establishment.establishmentRef,
      claimRef: seed.claim.claimRef,
      targetClaim: {
        rawLot: ' MFT-24 ',
        normalizedLot: 'mft24'
      },
      eligibility: { eligible: true, blockerCodes: [] }
    });
    expect(seed.basis.currentArtifactRefs).toEqual({
      claimRefs: [seed.claim.claimRef],
      assessmentRefs: [seed.assessment.assessmentRef],
      evidenceRefs: [seed.external.evidenceRef, seed.internal.evidenceRef].sort()
    });
    expect(seed.basis.applicationBasisDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(state(seed.snapshot.caseId)).toEqual(beforeRead);
  });

  it('fingerprints new unreviewed artifacts without changing lifecycle versions', () => {
    const seed = seedEligibleEstablishment();
    const before = readCaseSnapshot(connection.db, seed.snapshot.caseId)!;
    recordEvidence(
      seed.snapshot,
      seed.questionRef,
      'evidence:established-application:unreviewed',
      'EXTERNAL_PARTY',
      '2026-09-10T11:00:00.000Z'
    );
    const after = readEstablishedBatchApplicationBasis(
      connection.db,
      seed.snapshot.caseId,
      seed.questionRef,
      seed.establishment.establishmentRef
    );

    expect(after.applicationBasisDigest).not.toBe(seed.basis.applicationBasisDigest);
    expect(after.currentArtifactRefs.evidenceRefs).toContain(
      'evidence:established-application:unreviewed'
    );
    expect(after.currentEvaluation.blockerCodes).toContain('EVIDENCE_BASIS_CHANGED');
    expect(after.eligibility).toEqual({
      eligible: false,
      blockerCodes: ['ESTABLISHMENT_NOT_CURRENTLY_ELIGIBLE', 'ESTABLISHMENT_BASIS_MISMATCH']
    });
    expect(readCaseSnapshot(connection.db, seed.snapshot.caseId)).toEqual(before);
  });

  it('fingerprints Claim and Assessment supersession without lifecycle version changes', () => {
    const seed = seedEligibleEstablishment();
    const claim = recordInvestigationClaim(connection.db, {
      claimRef: randomUUID(),
      caseId: seed.snapshot.caseId,
      questionRef: seed.questionRef,
      expectedCaseVersion: seed.snapshot.caseVersion,
      claimType: 'AFFECTED_BATCH_LOT',
      value: { lot: 'MFT24' },
      evidenceRefs: [seed.external.evidenceRef, seed.internal.evidenceRef],
      originKind: 'DETERMINISTIC_EXTRACTED',
      producerIdentifier: 'demo-batch-parser:v2',
      derivationMetadata: null,
      supersedesClaimRef: seed.claim.claimRef,
      demo: true
    }, context).claim;
    const afterClaim = readEstablishedBatchApplicationBasis(
      connection.db,
      seed.snapshot.caseId,
      seed.questionRef,
      seed.establishment.establishmentRef
    );
    recordInvestigationAssessment(connection.db, {
      assessmentRef: randomUUID(),
      caseId: seed.snapshot.caseId,
      questionRef: seed.questionRef,
      expectedCaseVersion: seed.snapshot.caseVersion,
      verdict: 'SUPPORTED',
      targetClaimRef: seed.claim.claimRef,
      evidenceRefs: [seed.external.evidenceRef, seed.internal.evidenceRef],
      relatedClaimRefs: [],
      assessorKind: 'HUMAN',
      assessorIdentifier: null,
      ruleIdentifier: null,
      ruleVersion: null,
      rationale: 'Reviewed the superseding Claim over the complete corpus.',
      supersedesAssessmentRef: seed.assessment.assessmentRef,
      demo: true
    }, context).assessment;
    const afterAssessment = readEstablishedBatchApplicationBasis(
      connection.db,
      seed.snapshot.caseId,
      seed.questionRef,
      seed.establishment.establishmentRef
    );

    expect(afterClaim.applicationBasisDigest).not.toBe(seed.basis.applicationBasisDigest);
    expect(afterAssessment.applicationBasisDigest).not.toBe(afterClaim.applicationBasisDigest);
    expect(afterAssessment.currentArtifactRefs.claimRefs).toContain(claim.claimRef);
    expect(afterAssessment.currentArtifactRefs.assessmentRefs).toHaveLength(2);
    expect(readCaseSnapshot(connection.db, seed.snapshot.caseId)?.caseVersion)
      .toBe(seed.snapshot.caseVersion);
  });

  it('blocks aggregate KNOWN promotion when unrelated authoritative uncertainty remains', () => {
    const seed = seedEligibleEstablishment();
    const unrelated = {
      id: 'issue:unrelated-disposition',
      code: 'EVIDENCE_MISSING',
      message: 'Unrelated disposition evidence remains missing.',
      critical: false,
      subjectRefs: [seed.snapshot.productId],
      evidenceRefs: []
    };
    const changed = caseSnapshotSchema.parse({
      ...seed.snapshot,
      investigation: {
        ...seed.snapshot.investigation!,
        gaps: [...seed.snapshot.investigation!.gaps, unrelated]
      },
      uncertainties: [...seed.snapshot.uncertainties, unrelated]
    });
    const snapshotJson = JSON.stringify(changed);
    connection.db.update(schema.caseLifecycle).set({ snapshotJson })
      .where(eq(schema.caseLifecycle.caseId, changed.caseId)).run();
    connection.db.update(schema.caseRevisions).set({ snapshotJson })
      .where(eq(schema.caseRevisions.caseId, changed.caseId)).run();

    const basis = readEstablishedBatchApplicationBasis(
      connection.db,
      seed.snapshot.caseId,
      seed.questionRef,
      seed.establishment.establishmentRef
    );
    expect(basis.eligibility).toEqual({
      eligible: false,
      blockerCodes: ['OTHER_AUTHORITATIVE_UNCERTAINTY_PRESENT']
    });
    expect(basis.applicationBasisDigest).not.toBe(seed.basis.applicationBasisDigest);
  });
});

describe('HUMAN established batch authoritative application', () => {
  it('derives one KNOWN normalized lot and immutable source/result provenance atomically', () => {
    const seed = seedEligibleEstablishment();
    const input = applicationInput(seed);
    const before = state(seed.snapshot.caseId);
    const result = applyInvestigationEstablishedBatch(
      connection.db,
      input,
      context,
      new Date(applicationAt)
    );

    expect(result.replayed).toBe(false);
    expect(result.snapshot.caseVersion).toBe(seed.snapshot.caseVersion + 1);
    expect(result.snapshot.materialRevision).toBe(seed.snapshot.materialRevision! + 1);
    expect(investigationOutcomeSchema.parse(result.snapshot.investigation)).toMatchObject({
      knowledgeStatus: 'KNOWN',
      identity: seed.snapshot.investigation!.identity,
      scope: {
        kind: 'BATCH_LOT',
        lots: ['mft24'],
        knowledgeStatus: 'KNOWN',
        evidenceRefs: [seed.external.evidenceRef, seed.internal.evidenceRef].sort(),
        decisionRefs: [input.applicationRef]
      },
      gaps: [],
      conflicts: []
    });
    expect(result.snapshot.investigation?.decisionRefs).toContain(input.applicationRef);
    expect(result.snapshot.decisions.some((decision) => decision.id === input.applicationRef))
      .toBe(false);
    expect(result.snapshot.investigation?.evidenceRefs).not.toContain(seed.claim.claimRef);
    expect(result.snapshot.investigation?.evidenceRefs).not.toContain(seed.assessment.assessmentRef);
    expect(result.snapshot.investigation?.evidenceRefs)
      .not.toContain(seed.establishment.establishmentRef);
    expect(result.snapshot.investigation?.evidenceRefs).not.toContain(seed.questionRef);
    expect(result.snapshot.investigation?.evidenceRefs).not.toContain(input.applicationRef);
    expect(result.application).toMatchObject({
      applicationRef: input.applicationRef,
      establishmentRef: seed.establishment.establishmentRef,
      claimRef: seed.claim.claimRef,
      appliedLot: 'mft24',
      actorKind: 'HUMAN',
      actorIdentifier: demoHumanAssessorIdentifier,
      rationale: 'Reviewed the exact current established batch basis.',
      sourceCaseVersion: seed.snapshot.caseVersion,
      sourceMaterialRevision: seed.snapshot.materialRevision,
      resultingCaseVersion: seed.snapshot.caseVersion + 1,
      resultingMaterialRevision: seed.snapshot.materialRevision! + 1
    });
    expect(result.application.reviewedClaimRefs).toEqual([seed.claim.claimRef]);
    expect(result.application.reviewedAssessmentRefs).toEqual([seed.assessment.assessmentRef]);
    expect(result.application.reviewedEvidenceRefs).toEqual(
      [seed.external.evidenceRef, seed.internal.evidenceRef].sort()
    );
    expect(result.application.appliedEvidenceRefs).toEqual(
      [seed.external.evidenceRef, seed.internal.evidenceRef].sort()
    );
    expect(result.application.sourceRevisionId).toBe(before.revisions.at(-1)?.id);
    expect(result.application.resultingRevisionId).not.toBe(result.application.sourceRevisionId);
    expect(getInvestigationEstablishedBatchApplication(
      connection.db,
      seed.snapshot.caseId,
      input.applicationRef
    )).toEqual(result.application);
    expect(state(seed.snapshot.caseId).revisions).toHaveLength(before.revisions.length + 1);
    expect(state(seed.snapshot.caseId).commands).toHaveLength(before.commands.length + 1);
    expect(state(seed.snapshot.caseId).audit).toHaveLength(before.audit.length + 1);
    const command = state(seed.snapshot.caseId).commands.find(
      (item) => item.commandId === input.applicationRef
    )!;
    expect(JSON.parse(command.payloadJson)).toEqual({
      operation: 'APPLY_INVESTIGATION_ESTABLISHED_BATCH',
      applicationRef: input.applicationRef,
      caseId: seed.snapshot.caseId,
      questionRef: seed.questionRef,
      establishmentRef: seed.establishment.establishmentRef,
      applicationBasisDigest: seed.basis.applicationBasisDigest,
      sourceCaseVersion: seed.snapshot.caseVersion,
      sourceMaterialRevision: seed.snapshot.materialRevision
    });
    const audit = state(seed.snapshot.caseId).audit.find(
      (item) => item.eventType === 'investigation_established_batch_applied'
    )!;
    expect(audit.eventType).toBe('investigation_established_batch_applied');
    expect(JSON.parse(audit.metadataJson)).toMatchObject({
      applicationRef: input.applicationRef,
      establishmentRef: seed.establishment.establishmentRef,
      claimRef: seed.claim.claimRef,
      appliedLot: 'mft24',
      sourceRevisionId: result.application.sourceRevisionId,
      resultingRevisionId: result.application.resultingRevisionId,
      reopened: false
    });
  });

  it('rejects caller authority fields, disabled mode, stale versions, and stale basis', () => {
    const seed = seedEligibleEstablishment();
    const input = applicationInput(seed);
    const before = state(seed.snapshot.caseId);
    expectApplicationError(
      () => applyInvestigationEstablishedBatch(connection.db, { ...input, lot: 'MFT99' }, context),
      'INVALID_INPUT'
    );
    expectApplicationError(
      () => applyInvestigationEstablishedBatch(connection.db, input, { mode: 'disabled' }),
      'FORBIDDEN'
    );
    expectApplicationError(
      () => applyInvestigationEstablishedBatch(connection.db, {
        ...input,
        expectedCaseVersion: input.expectedCaseVersion + 1
      }, context),
      'STALE_CASE_VERSION'
    );
    expectApplicationError(
      () => applyInvestigationEstablishedBatch(connection.db, {
        ...input,
        expectedMaterialRevision: input.expectedMaterialRevision + 1
      }, context),
      'STALE_MATERIAL_REVISION'
    );
    recordEvidence(
      seed.snapshot,
      seed.questionRef,
      'evidence:established-application:drift',
      'EXTERNAL_PARTY',
      '2026-09-10T11:00:00.000Z'
    );
    expectApplicationError(
      () => applyInvestigationEstablishedBatch(connection.db, input, context),
      'STALE_APPLICATION_BASIS'
    );
    const driftedBasis = readEstablishedBatchApplicationBasis(
      connection.db,
      seed.snapshot.caseId,
      seed.questionRef,
      seed.establishment.establishmentRef
    );
    expectApplicationError(
      () => applyInvestigationEstablishedBatch(connection.db, {
        ...input,
        expectedApplicationBasisDigest: driftedBasis.applicationBasisDigest
      }, context),
      'APPLICATION_NOT_ELIGIBLE'
    );
    expect(state(seed.snapshot.caseId)).toMatchObject({
      snapshot: before.snapshot,
      revisions: before.revisions,
      commands: before.commands,
      applications: []
    });
  });

  it('requires a current eligible Establishment and exact ownership', () => {
    const seed = seedEligibleEstablishment();
    const input = applicationInput(seed);
    expectApplicationError(
      () => applyInvestigationEstablishedBatch(connection.db, {
        ...input,
        establishmentRef: randomUUID()
      }, context),
      'ESTABLISHMENT_NOT_FOUND'
    );
    expectApplicationError(
      () => applyInvestigationEstablishedBatch(connection.db, {
        ...input,
        questionRef: 'question:not-the-establishment-question'
      }, context),
      'APPLICATION_NOT_ELIGIBLE'
    );
  });

  it('requires re-review after an operational version change even when eligibility survives', () => {
    const seed = seedEligibleEstablishment();
    const advanced = persistOperationalRevision(seed.snapshot);
    const refreshedBasis = readEstablishedBatchApplicationBasis(
      connection.db,
      advanced.caseId,
      seed.questionRef,
      seed.establishment.establishmentRef
    );
    expect(refreshedBasis.eligibility.eligible).toBe(true);
    expect(refreshedBasis.applicationBasisDigest).not.toBe(seed.basis.applicationBasisDigest);
    expectApplicationError(
      () => applyInvestigationEstablishedBatch(connection.db, {
        ...applicationInput(seed),
        expectedCaseVersion: advanced.caseVersion,
        expectedMaterialRevision: advanced.materialRevision!,
        expectedApplicationBasisDigest: seed.basis.applicationBasisDigest
      }, context),
      'STALE_APPLICATION_BASIS'
    );
    expect(applyInvestigationEstablishedBatch(connection.db, {
      ...applicationInput(seed),
      expectedCaseVersion: advanced.caseVersion,
      expectedMaterialRevision: advanced.materialRevision!,
      expectedApplicationBasisDigest: refreshedBasis.applicationBasisDigest
    }, context).snapshot.materialRevision).toBe(advanced.materialRevision! + 1);
  });

  it('fails closed when its applicationRef already names an unrelated command', () => {
    const seed = seedEligibleEstablishment();
    const input = applicationInput(seed);
    connection.db.insert(schema.caseCommands).values({
      id: randomUUID(),
      caseId: seed.snapshot.caseId,
      commandId: input.applicationRef,
      payloadJson: JSON.stringify({ operation: 'UNRELATED_TEST_COMMAND' }),
      appliedCaseVersion: seed.snapshot.caseVersion,
      createdAt: '2026-09-10T11:30:00.000Z'
    }).run();
    expectApplicationError(
      () => applyInvestigationEstablishedBatch(connection.db, input, context),
      'COMMAND_ID_CONFLICT'
    );
    expect(connection.db.select().from(schema.investigationEstablishedBatchApplications).all())
      .toEqual([]);
  });

  it('replays from the exact resulting revision and prevents identity movement', () => {
    const seed = seedEligibleEstablishment();
    const input = applicationInput(seed);
    const applied = applyInvestigationEstablishedBatch(connection.db, input, context);
    const later = persistOperationalRevision(applied.snapshot);
    const beforeReplay = state(seed.snapshot.caseId);
    const replay = applyInvestigationEstablishedBatch(connection.db, {
      ...input,
      expectedCaseVersion: 999,
      expectedMaterialRevision: 999,
      expectedApplicationBasisDigest: `sha256:${'f'.repeat(64)}`
    }, context);
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot).toEqual(applied.snapshot);
    expect(replay.snapshot).not.toEqual(later);
    expect(state(seed.snapshot.caseId)).toEqual(beforeReplay);

    expectApplicationError(
      () => applyInvestigationEstablishedBatch(connection.db, {
        ...input,
        rationale: 'Different authorization semantics.'
      }, context),
      'APPLICATION_CONFLICT'
    );
    expectApplicationError(
      () => applyInvestigationEstablishedBatch(connection.db, {
        ...input,
        applicationRef: randomUUID(),
        expectedCaseVersion: later.caseVersion,
        expectedMaterialRevision: later.materialRevision!
      }, context),
      'ESTABLISHMENT_ALREADY_APPLIED'
    );
  });

  it('rolls back the lifecycle revision, command, audit, and downstream snapshot on row failure', () => {
    const seed = seedEligibleEstablishment();
    const input = applicationInput(seed);
    const before = state(seed.snapshot.caseId);
    connection.sqlite.exec(`
      create trigger force_established_batch_application_failure
      before insert on investigation_established_batch_applications
      begin
        select raise(abort, 'forced application-row failure');
      end
    `);
    expect(() => applyInvestigationEstablishedBatch(connection.db, input, context)).toThrow(
      'forced application-row failure'
    );
    expect(state(seed.snapshot.caseId)).toEqual(before);
  });

  it('leaves no application or lifecycle mutation when revision persistence fails', () => {
    const seed = seedEligibleEstablishment();
    const input = applicationInput(seed);
    const before = state(seed.snapshot.caseId);
    connection.sqlite.exec(`
      create trigger force_established_batch_revision_failure
      before insert on case_revisions
      begin
        select raise(abort, 'forced revision failure');
      end
    `);
    expect(() => applyInvestigationEstablishedBatch(connection.db, input, context)).toThrow(
      'forced revision failure'
    );
    expect(state(seed.snapshot.caseId)).toEqual(before);
  });

  it('fails closed when persisted application provenance no longer matches its Claim/result', () => {
    const seed = seedEligibleEstablishment();
    const input = applicationInput(seed);
    applyInvestigationEstablishedBatch(connection.db, input, context);
    connection.sqlite.prepare(`
      update investigation_established_batch_applications
      set applied_lot = 'differentlot'
      where application_ref = ?
    `).run(input.applicationRef);
    expectApplicationError(
      () => getInvestigationEstablishedBatchApplication(
        connection.db,
        seed.snapshot.caseId,
        input.applicationRef
      ),
      'APPLICATION_PROVENANCE_INVALID'
    );
  });

  it('retains permanent investigation history and preserves the first late-Evidence Challenge seam', () => {
    const seed = seedEligibleEstablishment();
    const input = applicationInput(seed);
    const applied = applyInvestigationEstablishedBatch(
      connection.db,
      input,
      context,
      new Date(applicationAt)
    );
    recordEvidence(
      applied.snapshot,
      seed.questionRef,
      'evidence:established-application:late',
      'EXTERNAL_PARTY',
      '2026-09-10T14:30:00.000Z',
      'MFT25'
    );
    const challenge = openInvestigationChallenge(connection.db, {
      challengeRef: randomUUID(),
      caseId: applied.snapshot.caseId,
      questionRef: seed.questionRef,
      expectedCaseVersion: applied.snapshot.caseVersion,
      expectedMaterialRevision: applied.snapshot.materialRevision!,
      triggerEvidenceRefs: ['evidence:established-application:late'],
      rationale: 'Late evidence requires re-review of the established answer.',
      demo: true
    }, context, new Date('2026-09-10T14:40:00.000Z')).challenge;

    expect(challenge.challengedMaterialRevision).toBe(applied.snapshot.materialRevision);
    expect(connection.db.select().from(schema.investigationQuestions).where(eq(
      schema.investigationQuestions.questionRef,
      seed.questionRef
    )).get()).toBeTruthy();
    expect(connection.db.select().from(schema.investigationClaims).where(eq(
      schema.investigationClaims.claimRef,
      seed.claim.claimRef
    )).get()).toBeTruthy();
    expect(connection.db.select().from(schema.investigationEstablishments).where(eq(
      schema.investigationEstablishments.establishmentRef,
      seed.establishment.establishmentRef
    )).get()).toBeTruthy();
  });

  it('persists across reopen and reset deletes provenance before restrictive parents', () => {
    const seed = seedEligibleEstablishment();
    const input = applicationInput(seed);
    applyInvestigationEstablishedBatch(connection.db, input, context);
    const databasePath = connection.sqlite.name;
    connection.sqlite.close();
    connection = createDatabaseConnection(databasePath);
    expect(getInvestigationEstablishedBatchApplication(
      connection.db,
      seed.snapshot.caseId,
      input.applicationRef
    )).not.toBeNull();
    expect(() => clearDemoData(connection.db)).not.toThrow();
    expect(connection.db.select().from(schema.investigationEstablishedBatchApplications).all())
      .toEqual([]);
  });

  it('enforces restrictive ownership, uniqueness, version, actor, demo, digest, and lot checks', () => {
    const seed = seedEligibleEstablishment();
    const input = applicationInput(seed);
    const secondEstablishment = recordInvestigationEstablishment(connection.db, {
      establishmentRef: randomUUID(),
      caseId: seed.snapshot.caseId,
      questionRef: seed.questionRef,
      claimRef: seed.claim.claimRef,
      expectedCaseVersion: seed.snapshot.caseVersion,
      expectedMaterialRevision: seed.snapshot.materialRevision!,
      demo: true
    }, context).establishment;
    applyInvestigationEstablishedBatch(connection.db, input, context);
    const table = 'investigation_established_batch_applications';
    expect(() => connection.sqlite.prepare(
      `update ${table} set establishment_ref = ? where application_ref = ?`
    ).run(randomUUID(), input.applicationRef)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => connection.sqlite.prepare(
      `update ${table} set source_case_version = 0 where application_ref = ?`
    ).run(input.applicationRef)).toThrow(/source_case_version_check/);
    expect(() => connection.sqlite.prepare(
      `update ${table} set resulting_material_revision = source_material_revision + 2
       where application_ref = ?`
    ).run(input.applicationRef)).toThrow(/material_revision_step_check/);
    expect(() => connection.sqlite.prepare(
      `update ${table} set actor_kind = 'RULE' where application_ref = ?`
    ).run(input.applicationRef)).toThrow(/actor_kind_check/);
    expect(() => connection.sqlite.prepare(
      `update ${table} set demo = 0 where application_ref = ?`
    ).run(input.applicationRef)).toThrow(/demo_check/);
    expect(() => connection.sqlite.prepare(
      `update ${table} set basis_digest = ? where application_ref = ?`
    ).run(`sha256:${'A'.repeat(64)}`, input.applicationRef)).toThrow(/basis_digest_check/);
    expect(() => connection.sqlite.prepare(
      `update ${table} set applied_lot = ' ' where application_ref = ?`
    ).run(input.applicationRef)).toThrow(/applied_lot_check/);

    const row = connection.db.select().from(schema.investigationEstablishedBatchApplications)
      .where(eq(schema.investigationEstablishedBatchApplications.applicationRef, input.applicationRef))
      .get()!;
    expect(() => connection.db.insert(schema.investigationEstablishedBatchApplications).values({
      ...row,
      applicationRef: randomUUID(),
      resultingRevisionId: row.sourceRevisionId
    }).run()).toThrow(/UNIQUE constraint failed/);
    expect(() => connection.db.insert(schema.investigationEstablishedBatchApplications).values({
      ...row,
      applicationRef: randomUUID(),
      establishmentRef: secondEstablishment.establishmentRef
    }).run()).toThrow(/UNIQUE constraint failed/);
    expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('upgrades populated 0012 state additively, preserves data, and reruns safely', () => {
    const preApplicationFolder = join(directory, 'pre-established-application-migrations');
    mkdirSync(join(preApplicationFolder, 'meta'), { recursive: true });
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
      '0010_lying_hellcat.sql',
      '0011_confused_hannibal_king.sql',
      '0012_stiff_squadron_supreme.sql'
    ]) cpSync(join('drizzle', file), join(preApplicationFolder, file));
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 13);
    writeFileSync(
      join(preApplicationFolder, 'meta/_journal.json'),
      JSON.stringify(journal)
    );
    const existing = createDatabaseConnection(join(directory, 'populated-0012.db'));
    try {
      migrate(existing.db, { migrationsFolder: preApplicationFolder });
      seedDemoData(existing.db, fixtures);
      expect(existing.sqlite.prepare(
        "select name from sqlite_master where type = 'table' and name = ?"
      ).get('investigation_established_batch_applications')).toBeUndefined();
      const productsBefore = existing.db.select().from(schema.products).all();
      const alertsBefore = existing.db.select().from(schema.alerts).all();
      const matchesBefore = existing.db.select().from(schema.matches).all();

      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      expect(existing.db.select().from(schema.products).all()).toEqual(productsBefore);
      expect(existing.db.select().from(schema.alerts).all()).toEqual(alertsBefore);
      expect(existing.db.select().from(schema.matches).all()).toEqual(matchesBefore);
      expect(existing.db.select().from(schema.investigationEstablishedBatchApplications).all())
        .toEqual([]);
      expect(existing.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      existing.sqlite.close();
    }
  });

});
