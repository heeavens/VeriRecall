import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import { seedDemoData } from '../db/repositories';
import * as schema from '../db/schema';
import { getCaseHistory, readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import {
  batchContradictionRule,
  recordInvestigationAssessment,
  type InvestigationAssessment,
  type RecordInvestigationAssessmentInput
} from './assessments';
import {
  recordInvestigationClaim,
  type InvestigationClaim
} from './claims';
import {
  EffectiveAnalysisError,
  projectEffectiveInvestigationAnalysis,
  readEffectiveInvestigationAnalysis,
  type ProjectEffectiveInvestigationAnalysisInput
} from './effective-analysis';
import { recordInvestigationEvidence } from './evidence-registry';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const fixtures = loadDemoFixtures();
const gapMatchId = '50000000-0000-4000-8000-000000000002';
const context = { mode: 'demo' as const };

let directory: string;
let databasePath: string;
let connection: TestConnection;
let sequence: number;

function versionedGapCase() {
  const confirmed = confirmReviewMatch(
    connection.db,
    { matchId: gapMatchId, actorName: 'demo_operator' },
    new Date('2026-09-09T10:00:00.000Z'),
    context
  );
  const snapshot = readCaseSnapshot(connection.db, confirmed.caseId);
  const gap = snapshot?.investigation?.gaps.find((issue) => issue.code === 'BATCH_MISSING');
  if (!snapshot?.investigation || !gap) throw new Error('Expected a current BATCH_MISSING gap.');
  return { snapshot, gap };
}

function nextDate(): Date {
  sequence += 1;
  return new Date(Date.UTC(2026, 8, 9, 11, 0, sequence));
}

function createEvidence(caseId: string, questionRef: string, label: string = randomUUID()) {
  return recordInvestigationEvidence(connection.db, {
    evidenceRef: `evidence:effective-analysis:${label}`,
    caseId,
    questionRef,
    evidenceRequestId: null,
    sourceKind: 'EXTERNAL_PARTY',
    sourceIdentifier: `supplier:${label}`,
    validAsOf: null,
    contentKind: 'STRUCTURED',
    contentJson: { document: label },
    contentLocator: null,
    demo: true
  }, nextDate()).evidence;
}

function createClaim(
  snapshot: NonNullable<ReturnType<typeof readCaseSnapshot>>,
  questionRef: string,
  evidenceRefs: string[],
  lot: string,
  overrides: Partial<{
    claimRef: string;
    supersedesClaimRef: string | null;
    createdAt: Date;
  }> = {}
): InvestigationClaim {
  return recordInvestigationClaim(connection.db, {
    claimRef: overrides.claimRef ?? randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    claimType: 'AFFECTED_BATCH_LOT',
    value: { lot },
    evidenceRefs,
    originKind: 'DETERMINISTIC_EXTRACTED',
    producerIdentifier: 'test-batch-parser:v1',
    derivationMetadata: null,
    supersedesClaimRef: overrides.supersedesClaimRef ?? null,
    demo: true
  }, context, overrides.createdAt ?? nextDate()).claim;
}

function createAssessment(
  snapshot: NonNullable<ReturnType<typeof readCaseSnapshot>>,
  questionRef: string,
  evidenceRefs: string[],
  overrides: Partial<RecordInvestigationAssessmentInput> & {
    verdict: RecordInvestigationAssessmentInput['verdict'];
  },
  createdAt = nextDate()
): InvestigationAssessment {
  const input: RecordInvestigationAssessmentInput = {
    assessmentRef: overrides.assessmentRef ?? randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    verdict: overrides.verdict,
    targetClaimRef: overrides.targetClaimRef ?? null,
    evidenceRefs,
    relatedClaimRefs: overrides.relatedClaimRefs ?? [],
    assessorKind: overrides.assessorKind ?? 'HUMAN',
    assessorIdentifier: overrides.assessorIdentifier ?? null,
    ruleIdentifier: overrides.ruleIdentifier ?? null,
    ruleVersion: overrides.ruleVersion ?? null,
    rationale: overrides.rationale ?? 'Recorded analysis remains non-authoritative.',
    supersedesAssessmentRef: overrides.supersedesAssessmentRef ?? null,
    demo: true
  };
  return recordInvestigationAssessment(connection.db, input, context, createdAt).assessment;
}

function projectionInput(
  snapshot: NonNullable<ReturnType<typeof readCaseSnapshot>>,
  questionRef: string,
  claims: readonly InvestigationClaim[],
  assessments: readonly InvestigationAssessment[],
  overrides: Partial<ProjectEffectiveInvestigationAnalysisInput> = {}
): ProjectEffectiveInvestigationAnalysisInput {
  return {
    snapshot,
    questionRef,
    claims,
    assessments,
    caseRevisions: getCaseHistory(connection.db, snapshot.caseId).map((revision) => ({
      caseVersion: revision.caseVersion,
      materialRevision: revision.materialRevision
    })),
    ...overrides
  };
}

function expectProjectionError(action: () => unknown, code: EffectiveAnalysisError['code']) {
  try {
    action();
    throw new Error('Expected effective analysis projection to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(EffectiveAnalysisError);
    expect(error).toMatchObject({ code });
  }
}

function databaseState() {
  return {
    lifecycle: connection.db.select().from(schema.caseLifecycle).all(),
    revisions: connection.db.select().from(schema.caseRevisions).all(),
    commands: connection.db.select().from(schema.caseCommands).all(),
    requests: connection.db.select().from(schema.evidenceRequests).all(),
    evidence: connection.db.select().from(schema.investigationEvidence).all(),
    claims: connection.db.select().from(schema.investigationClaims).all(),
    assessments: connection.db.select().from(schema.investigationAssessments).all(),
    audit: connection.db.select().from(schema.auditEvents).all(),
    matches: connection.db.select().from(schema.matches).all(),
    alerts: connection.db.select().from(schema.alerts).all(),
    actionDrafts: connection.db.select().from(schema.actionDrafts).all(),
    caseItems: connection.db.select().from(schema.caseItems).all(),
    tasks: connection.db.select().from(schema.caseTasks).all(),
    traceability: connection.db.select().from(schema.traceabilityRecords).all()
  };
}

beforeEach(() => {
  sequence = 0;
  directory = mkdtempSync(join(tmpdir(), 'verirecall-effective-analysis-'));
  databasePath = join(directory, 'test.db');
  connection = createDatabaseConnection(databasePath);
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('effective investigation analysis', () => {
  it('projects empty history and requires the exact unique current BATCH_MISSING question', () => {
    const { snapshot, gap } = versionedGapCase();

    expect(readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id)).toMatchObject({
      caseId: snapshot.caseId,
      questionRef: gap.id,
      productId: snapshot.productId,
      activeClaims: [],
      structuralAssessmentHeads: [],
      materiallyCurrentAssessmentHeads: [],
      ambiguities: []
    });

    const missingGap = structuredClone(snapshot);
    missingGap.investigation!.gaps = [];
    expectProjectionError(
      () => projectEffectiveInvestigationAnalysis(
        projectionInput(missingGap, gap.id, [], [])
      ),
      'QUESTION_NOT_CURRENT'
    );

    const duplicateGap = structuredClone(snapshot);
    duplicateGap.investigation!.gaps.push(structuredClone(gap));
    expectProjectionError(
      () => projectEffectiveInvestigationAnalysis(
        projectionInput(duplicateGap, gap.id, [], [])
      ),
      'QUESTION_AMBIGUOUS'
    );
  });

  it('derives Claim heads structurally without collapsing equal or different lot values', () => {
    const { snapshot, gap } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'claim-heads');
    const first = createClaim(snapshot, gap.id, [evidence.evidenceRef], 'MFT24');
    const equivalent = createClaim(snapshot, gap.id, [evidence.evidenceRef], 'MFT-24');
    const different = createClaim(snapshot, gap.id, [evidence.evidenceRef], 'MFT25');

    const initiallyActive = readEffectiveInvestigationAnalysis(
      connection.db,
      snapshot.caseId,
      gap.id
    );
    expect(initiallyActive.activeClaims.map((claim) => claim.claimRef)).toEqual([
      first.claimRef,
      equivalent.claimRef,
      different.claimRef
    ]);

    const firstSuccessor = createClaim(
      snapshot,
      gap.id,
      [evidence.evidenceRef],
      'MFT24',
      { supersedesClaimRef: first.claimRef }
    );
    const secondSuccessor = createClaim(
      snapshot,
      gap.id,
      [evidence.evidenceRef],
      'MFT26',
      { supersedesClaimRef: first.claimRef }
    );
    const branched = readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id);

    expect(branched.inactiveClaimRefs).toEqual([first.claimRef]);
    expect(branched.activeClaims.map((claim) => claim.claimRef)).toEqual([
      equivalent.claimRef,
      different.claimRef,
      firstSuccessor.claimRef,
      secondSuccessor.claimRef
    ]);
  });

  it('keeps every structural Assessment branch and exposes simultaneous judgments', () => {
    const { snapshot, gap } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'assessment-branches');
    const claim = createClaim(snapshot, gap.id, [evidence.evidenceRef], 'MFT24');
    const original = createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      verdict: 'SUPPORTED',
      targetClaimRef: claim.claimRef
    });
    const rejected = createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      verdict: 'REJECTED',
      targetClaimRef: claim.claimRef,
      supersedesAssessmentRef: original.assessmentRef
    }, new Date('2026-09-09T18:00:00.000Z'));
    const supported = createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      verdict: 'SUPPORTED',
      targetClaimRef: claim.claimRef,
      supersedesAssessmentRef: original.assessmentRef
    }, new Date('2026-09-09T19:00:00.000Z'));

    const result = readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id);

    expect(result.structuralAssessmentHeads.map((item) => item.assessmentRef)).toEqual([
      rejected.assessmentRef,
      supported.assessmentRef
    ]);
    expect(result.materiallyCurrentAssessmentHeads.map((item) => item.assessmentRef)).toEqual([
      rejected.assessmentRef,
      supported.assessmentRef
    ]);
    expect(result.staleAssessments).toContainEqual({
      assessment: original,
      reasons: ['ASSESSMENT_SUPERSEDED']
    });
    expect(result.targetedAssessments).toContainEqual({
      claimRef: claim.claimRef,
      supportedAssessmentRefs: [supported.assessmentRef],
      insufficientAssessmentRefs: [],
      rejectedAssessmentRefs: [rejected.assessmentRef]
    });
    expect(result.ambiguities.map((issue) => issue.code)).toEqual([
      'ASSESSMENT_BRANCHING',
      'CLAIM_SUPPORTED_AND_REJECTED'
    ]);
  });

  it('makes a targeted Assessment inapplicable when its Claim is superseded without transfer', () => {
    const { snapshot, gap } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'claim-supersession');
    const original = createClaim(snapshot, gap.id, [evidence.evidenceRef], 'MFT24');
    const assessment = createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      verdict: 'SUPPORTED',
      targetClaimRef: original.claimRef
    });
    const equivalentSuccessor = createClaim(
      snapshot,
      gap.id,
      [evidence.evidenceRef],
      'MFT-24',
      { supersedesClaimRef: original.claimRef }
    );

    let result = readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id);
    expect(result.structuralAssessmentHeads).toContainEqual(assessment);
    expect(result.applicableAssessmentHeads).toEqual([]);
    expect(result.staleAssessments).toContainEqual({
      assessment,
      reasons: ['CLAIM_SUPERSEDED']
    });
    expect(result.targetedAssessments.find(
      (item) => item.claimRef === equivalentSuccessor.claimRef
    )?.supportedAssessmentRefs).toEqual([]);

    const successorAssessment = createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      verdict: 'SUPPORTED',
      targetClaimRef: equivalentSuccessor.claimRef
    });

    const differentSuccessor = createClaim(
      snapshot,
      gap.id,
      [evidence.evidenceRef],
      'MFT25',
      { supersedesClaimRef: equivalentSuccessor.claimRef }
    );
    result = readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id);
    expect(result.activeClaims.map((claim) => claim.claimRef)).toEqual([differentSuccessor.claimRef]);
    expect(result.applicableAssessmentHeads).toEqual([]);
    expect(result.staleAssessments).toContainEqual({
      assessment: successorAssessment,
      reasons: ['CLAIM_SUPERSEDED']
    });
  });

  it('invalidates a related-Claim contradiction if any Claim is superseded', () => {
    const { snapshot, gap } = versionedGapCase();
    const firstEvidence = createEvidence(snapshot.caseId, gap.id, 'contradiction-a');
    const secondEvidence = createEvidence(snapshot.caseId, gap.id, 'contradiction-b');
    const first = createClaim(snapshot, gap.id, [firstEvidence.evidenceRef], 'MFT24');
    const second = createClaim(snapshot, gap.id, [secondEvidence.evidenceRef], 'MFT25');
    const supported = createAssessment(snapshot, gap.id, [firstEvidence.evidenceRef], {
      verdict: 'SUPPORTED',
      targetClaimRef: first.claimRef
    });
    const contradiction = createAssessment(
      snapshot,
      gap.id,
      [firstEvidence.evidenceRef, secondEvidence.evidenceRef],
      {
        verdict: 'CONTRADICTED',
        relatedClaimRefs: [second.claimRef, first.claimRef],
        assessorKind: 'RULE',
        assessorIdentifier: 'batch-contradiction-detector',
        ruleIdentifier: batchContradictionRule.identifier,
        ruleVersion: batchContradictionRule.version
      }
    );

    let result = readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id);
    expect(result.activeContradictions).toEqual([{
      assessmentRef: contradiction.assessmentRef,
      relatedClaimRefs: [first.claimRef, second.claimRef].sort()
    }]);
    expect(result.ambiguities).toContainEqual({
      code: 'SUPPORTED_CLAIM_IN_CONTRADICTION',
      claimRefs: [first.claimRef],
      assessmentRefs: [supported.assessmentRef, contradiction.assessmentRef].sort()
    });

    createClaim(snapshot, gap.id, [secondEvidence.evidenceRef], 'MFT25', {
      supersedesClaimRef: second.claimRef
    });
    result = readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id);
    expect(result.activeContradictions).toEqual([]);
    expect(result.staleAssessments).toContainEqual({
      assessment: contradiction,
      reasons: ['CLAIM_SUPERSEDED']
    });
  });

  it('keeps question-level INSUFFICIENT applicable without inventing a Claim', () => {
    const { snapshot, gap } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'unreadable-invoice');
    const insufficient = createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      verdict: 'INSUFFICIENT'
    });

    const result = readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id);

    expect(result.activeClaims).toEqual([]);
    expect(result.applicableAssessmentHeads).toEqual([insufficient]);
    expect(result.materiallyCurrentAssessmentHeads).toEqual([insufficient]);
    expect(result.questionLevelInsufficientAssessmentRefs).toEqual([
      insufficient.assessmentRef
    ]);
  });

  it('separates material revision freshness from operational case version advancement', () => {
    const { snapshot, gap } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'material-basis');
    const claim = createClaim(snapshot, gap.id, [evidence.evidenceRef], 'MFT24');
    const assessment = createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      verdict: 'SUPPORTED',
      targetClaimRef: claim.claimRef
    });
    const basis = [{
      caseVersion: assessment.basisCaseVersion,
      materialRevision: snapshot.materialRevision
    }];
    const operationallyAdvanced = {
      ...structuredClone(snapshot),
      caseVersion: snapshot.caseVersion + 4
    };

    const current = projectEffectiveInvestigationAnalysis(projectionInput(
      operationallyAdvanced,
      gap.id,
      [claim],
      [assessment],
      { caseRevisions: basis }
    ));
    expect(current.materiallyCurrentAssessmentHeads).toEqual([assessment]);

    const nextMaterialRevision = snapshot.materialRevision! + 1;
    const materiallyAdvanced = {
      ...structuredClone(operationallyAdvanced),
      materialRevision: nextMaterialRevision,
      investigation: {
        ...structuredClone(snapshot.investigation!),
        materialRevision: nextMaterialRevision
      }
    };
    const stale = projectEffectiveInvestigationAnalysis(projectionInput(
      materiallyAdvanced,
      gap.id,
      [claim],
      [assessment],
      { caseRevisions: basis }
    ));
    expect(stale.applicableAssessmentHeads).toEqual([assessment]);
    expect(stale.materiallyCurrentAssessmentHeads).toEqual([]);
    expect(stale.staleAssessments[0].reasons).toEqual(['MATERIAL_REVISION_STALE']);

    const unresolved = projectEffectiveInvestigationAnalysis(projectionInput(
      operationallyAdvanced,
      gap.id,
      [claim],
      [assessment],
      { caseRevisions: [] }
    ));
    expect(unresolved.materiallyCurrentAssessmentHeads).toEqual([]);
    expect(unresolved.staleAssessments[0].reasons).toEqual(['BASIS_REVISION_UNRESOLVED']);

    const ambiguousBasis = projectEffectiveInvestigationAnalysis(projectionInput(
      operationallyAdvanced,
      gap.id,
      [claim],
      [assessment],
      { caseRevisions: [...basis, ...basis] }
    ));
    expect(ambiguousBasis.staleAssessments[0].reasons).toEqual([
      'BASIS_REVISION_UNRESOLVED'
    ]);
  });

  it('preserves compatible and incompatible active targeted analysis as separate records', () => {
    const { snapshot, gap } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'targeted-ambiguity');
    const claim = createClaim(snapshot, gap.id, [evidence.evidenceRef], 'MFT24');
    const firstSupported = createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      verdict: 'SUPPORTED', targetClaimRef: claim.claimRef
    });
    const insufficient = createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      verdict: 'INSUFFICIENT', targetClaimRef: claim.claimRef
    });
    const secondSupported = createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      verdict: 'SUPPORTED', targetClaimRef: claim.claimRef
    });

    const result = readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id);
    const targeted = result.targetedAssessments[0];

    expect(targeted.supportedAssessmentRefs).toEqual([
      firstSupported.assessmentRef,
      secondSupported.assessmentRef
    ]);
    expect(targeted.insufficientAssessmentRefs).toEqual([insufficient.assessmentRef]);
    expect(result.ambiguities).toContainEqual({
      code: 'CLAIM_SUPPORTED_AND_INSUFFICIENT',
      claimRefs: [claim.claimRef],
      assessmentRefs: [
        firstSupported.assessmentRef,
        insufficient.assessmentRef,
        secondSupported.assessmentRef
      ].sort()
    });
  });

  it('fails closed on malformed ownership or supersession graphs and exposes unsupported basis', () => {
    const { snapshot, gap } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'malformed');
    const first = createClaim(snapshot, gap.id, [evidence.evidenceRef], 'MFT24');
    const second = createClaim(snapshot, gap.id, [evidence.evidenceRef], 'MFT25');
    const assessment = createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      verdict: 'SUPPORTED', targetClaimRef: first.claimRef
    });

    expectProjectionError(
      () => projectEffectiveInvestigationAnalysis(projectionInput(
        snapshot,
        gap.id,
        [{ ...first, caseId: randomUUID() }],
        []
      )),
      'INVALID_CLAIM_STATE'
    );
    expectProjectionError(
      () => projectEffectiveInvestigationAnalysis(projectionInput(
        snapshot,
        gap.id,
        [first],
        [{ ...assessment, questionRef: 'another-question' }]
      )),
      'INVALID_ASSESSMENT_STATE'
    );
    expectProjectionError(
      () => projectEffectiveInvestigationAnalysis(projectionInput(
        snapshot,
        gap.id,
        [
          { ...first, supersedesClaimRef: second.claimRef },
          { ...second, supersedesClaimRef: first.claimRef }
        ],
        []
      )),
      'INVALID_SUPERSESSION_GRAPH'
    );
    const secondAssessmentRef = randomUUID();
    expectProjectionError(
      () => projectEffectiveInvestigationAnalysis(projectionInput(
        snapshot,
        gap.id,
        [first, second],
        [
          { ...assessment, supersedesAssessmentRef: secondAssessmentRef },
          {
            ...assessment,
            assessmentRef: secondAssessmentRef,
            supersedesAssessmentRef: assessment.assessmentRef
          }
        ]
      )),
      'INVALID_SUPERSESSION_GRAPH'
    );

    const missingBasis = {
      ...assessment,
      targetClaimRef: randomUUID()
    };
    const result = projectEffectiveInvestigationAnalysis(projectionInput(
      snapshot,
      gap.id,
      [first, second],
      [missingBasis]
    ));
    expect(result.structuralAssessmentHeads).toEqual([missingBasis]);
    expect(result.applicableAssessmentHeads).toEqual([]);
    expect(result.staleAssessments[0].reasons).toContain('UNSUPPORTED_CLAIM_BASIS');

    expectProjectionError(
      () => readEffectiveInvestigationAnalysis(connection.db, randomUUID(), gap.id),
      'VERSIONED_CASE_REQUIRED'
    );
  });

  it('is deterministically ordered, repeatable, read-only, and stable after reopening the database', () => {
    const { snapshot, gap } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'read-only');
    const laterInsertedFirst = createClaim(
      snapshot,
      gap.id,
      [evidence.evidenceRef],
      'MFT25',
      { createdAt: new Date('2026-09-09T17:00:00.000Z') }
    );
    const earlierInsertedSecond = createClaim(
      snapshot,
      gap.id,
      [evidence.evidenceRef],
      'MFT24',
      { createdAt: new Date('2026-09-09T16:00:00.000Z') }
    );
    createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      verdict: 'SUPPORTED', targetClaimRef: laterInsertedFirst.claimRef
    });
    const beforeSnapshot = structuredClone(readCaseSnapshot(connection.db, snapshot.caseId));
    const before = databaseState();

    const first = readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id);
    const second = readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id);

    expect(first).toEqual(second);
    expect(first.activeClaims.map((claim) => claim.claimRef)).toEqual([
      earlierInsertedSecond.claimRef,
      laterInsertedFirst.claimRef
    ]);
    expect(databaseState()).toEqual(before);
    expect(readCaseSnapshot(connection.db, snapshot.caseId)).toEqual(beforeSnapshot);

    connection.sqlite.close();
    connection = createDatabaseConnection(databasePath);
    const reopened = readEffectiveInvestigationAnalysis(connection.db, snapshot.caseId, gap.id);
    expect(reopened).toEqual(first);
    expect(databaseState()).toEqual(before);
  });
});
