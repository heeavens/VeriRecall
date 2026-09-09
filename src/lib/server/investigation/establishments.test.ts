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

import { caseSnapshotSchema, type CaseSnapshot } from '../../contracts/recall';
import { createDatabaseConnection } from '../db/client';
import { loadDemoFixtures } from '../db/demo-fixtures';
import {
  clearDemoData,
  seedDemoData,
  type RecallDatabase
} from '../db/repositories';
import * as schema from '../db/schema';
import { getCaseHistory, readCaseSnapshot } from '../workflow/case-lifecycle';
import { confirmReviewMatch } from '../workflow/review';
import {
  batchContradictionRule,
  demoHumanAssessorIdentifier,
  recordInvestigationAssessment,
  type InvestigationAssessment,
  type RecordInvestigationAssessmentInput
} from './assessments';
import {
  recordInvestigationClaim,
  type InvestigationClaim
} from './claims';
import {
  projectEffectiveInvestigationAnalysis,
  readEffectiveInvestigationAnalysis,
  type EffectiveInvestigationAnalysis
} from './effective-analysis';
import {
  demoBatchEstablishmentPolicy,
  evaluateCurrentInvestigationEstablishment,
  evaluateDemoBatchEstablishmentPolicy,
  getInvestigationEstablishment,
  InvestigationEstablishmentError,
  listInvestigationEstablishments,
  recordInvestigationEstablishment,
  type RecordInvestigationEstablishmentInput
} from './establishments';
import {
  listInvestigationEvidence,
  recordInvestigationEvidence,
  type InvestigationEvidence,
  type RecordInvestigationEvidenceInput
} from './evidence-registry';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

const fixtures = loadDemoFixtures();
const gapMatchId = '50000000-0000-4000-8000-000000000002';
const context = { mode: 'demo' as const };
const establishmentCreatedAt = '2026-09-09T18:00:00.000Z';

let directory: string;
let databasePath: string;
let connection: TestConnection;
let sequence: number;

function nextDate(): Date {
  sequence += 1;
  return new Date(Date.UTC(2026, 8, 9, 11, 0, sequence));
}

function versionedGapCase(database: RecallDatabase = connection.db) {
  const match = fixtures.matches.find((candidate) => candidate.id === gapMatchId);
  const product = fixtures.products.find((candidate) => candidate.id === match?.productId);
  if (!match || !product?.ean) throw new Error('Expected the gap fixture product to have an EAN.');
  database.update(schema.alerts)
    .set({ ean: product.ean })
    .where(eq(schema.alerts.id, match.alertId))
    .run();
  database.update(schema.matches)
    .set({ hasHardConflict: false })
    .where(eq(schema.matches.id, gapMatchId))
    .run();
  const confirmed = confirmReviewMatch(
    database,
    { matchId: gapMatchId, actorName: demoHumanAssessorIdentifier },
    new Date('2026-09-09T10:00:00.000Z'),
    context
  );
  const snapshot = readCaseSnapshot(database, confirmed.caseId);
  const gap = snapshot?.investigation?.gaps.find((issue) => issue.code === 'BATCH_MISSING');
  if (!snapshot?.investigation || !gap) throw new Error('Expected a current BATCH_MISSING gap.');
  return { snapshot, gap };
}

interface EvidenceOptions {
  evidenceRef?: string;
  sourceKind?: RecordInvestigationEvidenceInput['sourceKind'];
  sourceIdentifier?: string;
  contentKind?: 'STRUCTURED' | 'LOCATOR';
  contentJson?: Extract<
    RecordInvestigationEvidenceInput,
    { contentKind: 'STRUCTURED' }
  >['contentJson'];
  integrityHash?: string;
  demo?: boolean;
  now?: Date;
}

function createEvidence(
  caseId: string,
  questionRef: string,
  label: string,
  options: EvidenceOptions = {},
  database: RecallDatabase = connection.db
): InvestigationEvidence {
  const contentKind = options.contentKind ?? 'STRUCTURED';
  const common = {
    evidenceRef: options.evidenceRef ?? `evidence:establishment:${label}`,
    caseId,
    questionRef,
    evidenceRequestId: null,
    sourceKind: options.sourceKind ?? 'EXTERNAL_PARTY',
    sourceIdentifier: options.sourceIdentifier ?? `source:${label}`,
    validAsOf: null,
    demo: options.demo ?? true
  } as const;
  const input: RecordInvestigationEvidenceInput = contentKind === 'STRUCTURED'
    ? {
        ...common,
        contentKind,
        contentJson: options.contentJson ?? { document: label, lot: 'MFT24' },
        contentLocator: null
      }
    : {
        ...common,
        contentKind,
        contentJson: null,
        contentLocator: `object-store:${label}`,
        integrityHash: options.integrityHash ?? 'a'.repeat(64)
      };
  return recordInvestigationEvidence(database, input, options.now ?? nextDate()).evidence;
}

interface ClaimOptions {
  claimRef?: string;
  originKind?: 'DETERMINISTIC_EXTRACTED' | 'AI_PROPOSED' | 'HUMAN_OBSERVED';
  supersedesClaimRef?: string | null;
  demo?: true;
  now?: Date;
}

function createClaim(
  snapshot: CaseSnapshot,
  questionRef: string,
  evidenceRefs: string[],
  lot = 'MFT24',
  options: ClaimOptions = {},
  database: RecallDatabase = connection.db
): InvestigationClaim {
  return recordInvestigationClaim(database, {
    claimRef: options.claimRef ?? randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    claimType: 'AFFECTED_BATCH_LOT',
    value: { lot },
    evidenceRefs,
    originKind: options.originKind ?? 'DETERMINISTIC_EXTRACTED',
    producerIdentifier: 'demo-batch-parser:v1',
    derivationMetadata: null,
    supersedesClaimRef: options.supersedesClaimRef ?? null,
    demo: options.demo ?? true
  }, context, options.now ?? nextDate()).claim;
}

interface AssessmentOptions {
  assessmentRef?: string;
  verdict?: 'SUPPORTED' | 'INSUFFICIENT' | 'REJECTED' | 'CONTRADICTED';
  targetClaimRef?: string | null;
  relatedClaimRefs?: string[];
  assessorKind?: 'HUMAN' | 'RULE' | 'AI';
  supersedesAssessmentRef?: string | null;
  now?: Date;
}

function createAssessment(
  snapshot: CaseSnapshot,
  questionRef: string,
  evidenceRefs: string[],
  options: AssessmentOptions = {},
  database: RecallDatabase = connection.db
): InvestigationAssessment {
  const assessorKind = options.assessorKind ?? 'HUMAN';
  const verdict = options.verdict ?? 'SUPPORTED';
  const contradiction = verdict === 'CONTRADICTED';
  const input: RecordInvestigationAssessmentInput = {
    assessmentRef: options.assessmentRef ?? randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    expectedCaseVersion: snapshot.caseVersion,
    verdict,
    targetClaimRef: options.targetClaimRef ?? null,
    evidenceRefs,
    relatedClaimRefs: options.relatedClaimRefs ?? [],
    assessorKind,
    assessorIdentifier: assessorKind === 'HUMAN'
      ? null
      : assessorKind === 'AI' ? 'demo-ai-reviewer' : 'demo-rule-reviewer',
    ruleIdentifier: assessorKind === 'HUMAN' && !contradiction
      ? null
      : contradiction ? batchContradictionRule.identifier : 'demo-analysis-rule',
    ruleVersion: assessorKind === 'HUMAN' && !contradiction
      ? null
      : contradiction ? batchContradictionRule.version : 'v1',
    rationale: 'Reviewed the complete registered demo evidence basis.',
    supersedesAssessmentRef: options.supersedesAssessmentRef ?? null,
    demo: true
  };
  return recordInvestigationAssessment(
    database,
    input,
    context,
    options.now ?? nextDate()
  ).assessment;
}

function currentPolicyState(
  snapshot: CaseSnapshot,
  questionRef: string,
  targetClaimRef: string,
  database: RecallDatabase = connection.db
) {
  const analysis = readEffectiveInvestigationAnalysis(database, snapshot.caseId, questionRef);
  const evidence = listInvestigationEvidence(database, snapshot.caseId, questionRef);
  return {
    analysis,
    evidence,
    evaluation: evaluateDemoBatchEstablishmentPolicy({
      snapshot: readCaseSnapshot(database, snapshot.caseId)!,
      analysis,
      evidence,
      targetClaimRef
    })
  };
}

function eligibleScenario(
  externalKind: 'EXTERNAL_PARTY' | 'REGULATOR' = 'EXTERNAL_PARTY',
  database: RecallDatabase = connection.db
) {
  const { snapshot, gap } = versionedGapCase(database);
  const internal = createEvidence(snapshot.caseId, gap.id, 'internal', {
    sourceKind: 'INTERNAL',
    sourceIdentifier: 'internal:erp:invoice-001',
    contentJson: { system: 'erp', lot: 'MFT24' }
  }, database);
  const external = createEvidence(snapshot.caseId, gap.id, 'external', {
    sourceKind: externalKind,
    sourceIdentifier: `${externalKind.toLowerCase()}:batch-label-001`,
    contentJson: { document: 'batch-label', lot: 'MFT24' }
  }, database);
  const claim = createClaim(
    snapshot,
    gap.id,
    [external.evidenceRef, internal.evidenceRef],
    'MFT24',
    {},
    database
  );
  const review = createAssessment(
    snapshot,
    gap.id,
    [external.evidenceRef, internal.evidenceRef],
    { targetClaimRef: claim.claimRef },
    database
  );
  return { snapshot, gap, internal, external, claim, review };
}

function establishmentInput(
  snapshot: CaseSnapshot,
  questionRef: string,
  claimRef: string,
  overrides: Partial<RecordInvestigationEstablishmentInput> = {}
): RecordInvestigationEstablishmentInput {
  return {
    establishmentRef: randomUUID(),
    caseId: snapshot.caseId,
    questionRef,
    claimRef,
    expectedCaseVersion: snapshot.caseVersion,
    expectedMaterialRevision: snapshot.materialRevision!,
    demo: true,
    ...overrides
  };
}

function expectEstablishmentError(
  action: () => unknown,
  code: InvestigationEstablishmentError['code'],
  blocker?: string
) {
  try {
    action();
    throw new Error('Expected establishment operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationEstablishmentError);
    expect(error).toMatchObject({ code });
    if (blocker) {
      expect((error as InvestigationEstablishmentError).blockerCodes).toContain(blocker);
    }
  }
}

function tableCount(tableName: string): number {
  return connection.sqlite.prepare(`select count(*) from ${tableName}`).pluck().get() as number;
}

function protectedState(database: RecallDatabase = connection.db) {
  return {
    lifecycle: database.select().from(schema.caseLifecycle).all(),
    revisions: database.select().from(schema.caseRevisions).all(),
    commands: database.select().from(schema.caseCommands).all(),
    requests: database.select().from(schema.evidenceRequests).all(),
    evidence: database.select().from(schema.investigationEvidence).all(),
    claims: database.select().from(schema.investigationClaims).all(),
    assessments: database.select().from(schema.investigationAssessments).all(),
    matches: database.select().from(schema.matches).all(),
    alerts: database.select().from(schema.alerts).all(),
    drafts: database.select().from(schema.actionDrafts).all(),
    items: database.select().from(schema.caseItems).all(),
    tasks: database.select().from(schema.caseTasks).all(),
    traceability: database.select().from(schema.traceabilityRecords).all()
  };
}

function persistSnapshotRevision(snapshot: CaseSnapshot): CaseSnapshot {
  const validated = caseSnapshotSchema.parse(snapshot);
  connection.db.update(schema.caseLifecycle).set({
    caseVersion: validated.caseVersion,
    materialRevision: validated.materialRevision,
    snapshotJson: JSON.stringify(validated),
    updatedAt: validated.updatedAt
  }).where(eq(schema.caseLifecycle.caseId, validated.caseId)).run();
  connection.db.insert(schema.caseRevisions).values({
    id: randomUUID(),
    caseId: validated.caseId,
    caseVersion: validated.caseVersion,
    materialRevision: validated.materialRevision,
    snapshotJson: JSON.stringify(validated),
    actorId: demoHumanAssessorIdentifier,
    createdAt: validated.updatedAt
  }).run();
  return validated;
}

beforeEach(() => {
  sequence = 0;
  directory = mkdtempSync(join(tmpdir(), 'verirecall-establishments-'));
  databasePath = join(directory, 'test.db');
  connection = createDatabaseConnection(databasePath);
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
  seedDemoData(connection.db, fixtures);
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('demo batch establishment policy', () => {
  it('passes only the named server policy with complete INTERNAL + EXTERNAL_PARTY basis', () => {
    const scenario = eligibleScenario();
    const { analysis, evidence, evaluation } = currentPolicyState(
      scenario.snapshot,
      scenario.gap.id,
      scenario.claim.claimRef
    );

    expect(demoBatchEstablishmentPolicy).toEqual({
      policyIdentifier: 'demo-dual-source-human-reviewed-batch',
      policyVersion: 'v1',
      evaluatorKind: 'RULE',
      evaluatorIdentifier: 'demo-batch-establishment-policy-engine'
    });
    expect(evaluation).toEqual({
      eligible: true,
      blockerCodes: [],
      basis: {
        claimRefs: [scenario.claim.claimRef],
        assessmentRefs: [scenario.review.assessmentRef],
        evidenceRefs: [scenario.external.evidenceRef, scenario.internal.evidenceRef].sort()
      }
    });
    expect(analysis.activeClaims).toHaveLength(1);
    expect(evidence.map((item) => item.evidenceRef)).toEqual([
      scenario.internal.evidenceRef,
      scenario.external.evidenceRef
    ]);
    expect(listInvestigationEvidence(
      connection.db,
      scenario.snapshot.caseId,
      'question:not-this-one'
    )).toEqual([]);
    expect(listInvestigationEvidence(
      connection.db,
      randomUUID(),
      scenario.gap.id
    )).toEqual([]);
  });

  it('accepts INTERNAL + REGULATOR only as explicit demo diversity signals', () => {
    const scenario = eligibleScenario('REGULATOR');
    const result = currentPolicyState(
      scenario.snapshot,
      scenario.gap.id,
      scenario.claim.claimRef
    ).evaluation;

    expect(result.eligible).toBe(true);
    expect(demoBatchEstablishmentPolicy.policyIdentifier).toContain('demo');
    expect(demoBatchEstablishmentPolicy.policyIdentifier).not.toContain('authentic');
  });

  it('does not let SUPPORTED or a human review replace missing corroborating Evidence', () => {
    const { snapshot, gap } = versionedGapCase();
    const evidence = createEvidence(snapshot.caseId, gap.id, 'only-one', {
      sourceKind: 'INTERNAL'
    });
    const claim = createClaim(snapshot, gap.id, [evidence.evidenceRef]);
    createAssessment(snapshot, gap.id, [evidence.evidenceRef], {
      targetClaimRef: claim.claimRef
    });

    const evaluation = currentPolicyState(snapshot, gap.id, claim.claimRef).evaluation;
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.blockerCodes).toEqual(expect.arrayContaining([
      'INSUFFICIENT_STRUCTURED_EVIDENCE',
      'SOURCE_IDENTIFIER_DIVERSITY_MISSING',
      'INTEGRITY_HASH_DIVERSITY_MISSING',
      'SOURCE_CLASS_COMBINATION_MISSING'
    ]));
    expect(tableCount('investigation_establishments')).toBe(0);
  });

  it('requires two structured Claim Evidence items with distinct identifiers, hashes and classes', () => {
    const scenario = eligibleScenario();
    const state = currentPolicyState(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef);
    const [first, second] = state.evidence;

    const duplicateIdentifier = evaluateDemoBatchEstablishmentPolicy({
      snapshot: scenario.snapshot,
      analysis: state.analysis,
      evidence: [first, { ...second, sourceIdentifier: first.sourceIdentifier }],
      targetClaimRef: scenario.claim.claimRef
    });
    expect(duplicateIdentifier.blockerCodes).toContain(
      'SOURCE_IDENTIFIER_DIVERSITY_MISSING'
    );

    const duplicateHash = evaluateDemoBatchEstablishmentPolicy({
      snapshot: scenario.snapshot,
      analysis: state.analysis,
      evidence: [first, { ...second, integrityHash: first.integrityHash }],
      targetClaimRef: scenario.claim.claimRef
    });
    expect(duplicateHash.blockerCodes).toContain('INTEGRITY_HASH_DIVERSITY_MISSING');

    const externalOnly = evaluateDemoBatchEstablishmentPolicy({
      snapshot: scenario.snapshot,
      analysis: state.analysis,
      evidence: state.evidence.map((item) => ({ ...item, sourceKind: 'EXTERNAL_PARTY' })),
      targetClaimRef: scenario.claim.claimRef
    });
    expect(externalOnly.blockerCodes).toContain('SOURCE_CLASS_COMBINATION_MISSING');

    const oneStructured = evaluateDemoBatchEstablishmentPolicy({
      snapshot: scenario.snapshot,
      analysis: state.analysis,
      evidence: [
        first,
        {
          ...second,
          contentKind: 'LOCATOR',
          contentJson: null,
          contentLocator: 'object-store:second'
        } as InvestigationEvidence
      ],
      targetClaimRef: scenario.claim.claimRef
    });
    expect(oneStructured.blockerCodes).toContain('INSUFFICIENT_STRUCTURED_EVIDENCE');
  });

  it('rejects AI-proposed targets and does not treat AI Assessment as human review', () => {
    const { snapshot, gap } = versionedGapCase();
    const internal = createEvidence(snapshot.caseId, gap.id, 'ai-internal', {
      sourceKind: 'INTERNAL'
    });
    const external = createEvidence(snapshot.caseId, gap.id, 'ai-external');
    const claim = createClaim(
      snapshot,
      gap.id,
      [internal.evidenceRef, external.evidenceRef],
      'MFT24',
      { originKind: 'AI_PROPOSED' }
    );
    createAssessment(snapshot, gap.id, [internal.evidenceRef, external.evidenceRef], {
      targetClaimRef: claim.claimRef,
      assessorKind: 'AI'
    });

    const evaluation = currentPolicyState(snapshot, gap.id, claim.claimRef).evaluation;
    expect(evaluation.blockerCodes).toEqual(expect.arrayContaining([
      'AI_TARGET_UNSUPPORTED',
      'HUMAN_REVIEW_MISSING'
    ]));
  });

  it('requires one exact active target and never collapses equal-normalized or different Claims', () => {
    const scenario = eligibleScenario();
    const same = createClaim(
      scenario.snapshot,
      scenario.gap.id,
      [scenario.internal.evidenceRef, scenario.external.evidenceRef],
      'MFT-24'
    );
    let evaluation = currentPolicyState(
      scenario.snapshot,
      scenario.gap.id,
      scenario.claim.claimRef
    ).evaluation;
    expect(evaluation.blockerCodes).toContain('ACTIVE_CLAIM_AMBIGUOUS');
    expect(evaluation.basis.claimRefs).toEqual([scenario.claim.claimRef, same.claimRef].sort());

    createClaim(
      scenario.snapshot,
      scenario.gap.id,
      [scenario.internal.evidenceRef, scenario.external.evidenceRef],
      'MFT25'
    );
    evaluation = currentPolicyState(
      scenario.snapshot,
      scenario.gap.id,
      scenario.claim.claimRef
    ).evaluation;
    expect(evaluation.blockerCodes).toContain('ACTIVE_CLAIM_AMBIGUOUS');
  });

  it('rejects empty-normalized lots, non-demo state and non-matching identity', () => {
    const scenario = eligibleScenario();
    const state = currentPolicyState(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef);
    const base = {
      snapshot: scenario.snapshot,
      analysis: state.analysis,
      evidence: state.evidence,
      targetClaimRef: scenario.claim.claimRef
    };

    const emptyLotAnalysis = structuredClone(state.analysis);
    emptyLotAnalysis.activeClaims[0].value.lot = '---';
    expect(evaluateDemoBatchEstablishmentPolicy({
      ...base,
      analysis: emptyLotAnalysis
    }).blockerCodes).toContain('LOT_EMPTY');

    expect(evaluateDemoBatchEstablishmentPolicy({
      ...base,
      snapshot: { ...structuredClone(scenario.snapshot), demo: false }
    }).blockerCodes).toContain('NOT_DEMO');
    expect(evaluateDemoBatchEstablishmentPolicy({
      ...base,
      evidence: [{ ...state.evidence[0], demo: false }, state.evidence[1]]
    }).blockerCodes).toContain('NOT_DEMO');
    const nonDemoClaim = structuredClone(state.analysis);
    nonDemoClaim.activeClaims[0].demo = false;
    expect(evaluateDemoBatchEstablishmentPolicy({
      ...base,
      analysis: nonDemoClaim
    }).blockerCodes).toContain('NOT_DEMO');
    const nonDemoAssessment = structuredClone(state.analysis);
    nonDemoAssessment.structuralAssessmentHeads[0].demo = false;
    expect(evaluateDemoBatchEstablishmentPolicy({
      ...base,
      analysis: nonDemoAssessment
    }).blockerCodes).toContain('NOT_DEMO');

    for (const identity of [
      { knowledgeStatus: 'UNKNOWN', conclusion: 'UNRESOLVED' },
      { knowledgeStatus: 'CONFLICTED', conclusion: 'UNRESOLVED' },
      { knowledgeStatus: 'KNOWN', conclusion: 'NO_MATCH' }
    ] as const) {
      const snapshot = structuredClone(scenario.snapshot);
      snapshot.investigation!.identity = {
        ...snapshot.investigation!.identity,
        ...identity
      };
      expect(evaluateDemoBatchEstablishmentPolicy({
        ...base,
        snapshot
      }).blockerCodes).toContain('IDENTITY_NOT_KNOWN_MATCH');
    }
  });

  it('requires a current demo-operator review over the exact complete Evidence corpus', () => {
    const scenario = eligibleScenario();
    const state = currentPolicyState(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef);
    const withoutCurrentReview: EffectiveInvestigationAnalysis = {
      ...state.analysis,
      materiallyCurrentAssessmentHeads: []
    };
    expect(evaluateDemoBatchEstablishmentPolicy({
      snapshot: scenario.snapshot,
      analysis: withoutCurrentReview,
      evidence: state.evidence,
      targetClaimRef: scenario.claim.claimRef
    }).blockerCodes).toContain('HUMAN_REVIEW_NOT_CURRENT');

    const wrongOperator = structuredClone(state.analysis);
    wrongOperator.structuralAssessmentHeads[0].assessorIdentifier = 'caller-supplied-operator';
    wrongOperator.materiallyCurrentAssessmentHeads[0].assessorIdentifier =
      'caller-supplied-operator';
    expect(evaluateDemoBatchEstablishmentPolicy({
      snapshot: scenario.snapshot,
      analysis: wrongOperator,
      evidence: state.evidence,
      targetClaimRef: scenario.claim.claimRef
    }).blockerCodes).toContain('HUMAN_REVIEW_MISSING');

    createEvidence(scenario.snapshot.caseId, scenario.gap.id, 'unreviewed-third', {
      sourceKind: 'REGULATOR'
    });
    const expanded = currentPolicyState(
      scenario.snapshot,
      scenario.gap.id,
      scenario.claim.claimRef
    ).evaluation;
    expect(expanded.blockerCodes).toContain('HUMAN_REVIEW_INCOMPLETE');
  });

  it('blocks rejected, insufficient, contradiction and ambiguous current analysis', () => {
    const scenario = eligibleScenario();
    const refs = [scenario.internal.evidenceRef, scenario.external.evidenceRef];
    createAssessment(scenario.snapshot, scenario.gap.id, refs, {
      verdict: 'REJECTED',
      targetClaimRef: scenario.claim.claimRef
    });
    createAssessment(scenario.snapshot, scenario.gap.id, refs, {
      verdict: 'INSUFFICIENT',
      targetClaimRef: scenario.claim.claimRef
    });
    createAssessment(scenario.snapshot, scenario.gap.id, refs, {
      verdict: 'INSUFFICIENT',
      targetClaimRef: null
    });

    let evaluation = currentPolicyState(
      scenario.snapshot,
      scenario.gap.id,
      scenario.claim.claimRef
    ).evaluation;
    expect(evaluation.blockerCodes).toEqual(expect.arrayContaining([
      'TARGET_REJECTED',
      'TARGET_INSUFFICIENT',
      'QUESTION_INSUFFICIENT',
      'ANALYSIS_AMBIGUOUS'
    ]));

    const second = createClaim(
      scenario.snapshot,
      scenario.gap.id,
      refs,
      'MFT25'
    );
    createAssessment(scenario.snapshot, scenario.gap.id, refs, {
      verdict: 'CONTRADICTED',
      relatedClaimRefs: [scenario.claim.claimRef, second.claimRef],
      assessorKind: 'RULE'
    });
    evaluation = currentPolicyState(
      scenario.snapshot,
      scenario.gap.id,
      scenario.claim.claimRef
    ).evaluation;
    expect(evaluation.blockerCodes).toEqual(expect.arrayContaining([
      'ACTIVE_CLAIM_AMBIGUOUS',
      'ACTIVE_CONTRADICTION'
    ]));
  });
});

describe('investigation establishments', () => {
  it('persists the complete server-derived policy basis and only one chronology event', () => {
    const scenario = eligibleScenario();
    const input = establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef);
    const before = protectedState();
    const beforeSnapshot = structuredClone(readCaseSnapshot(connection.db, snapshotId(scenario)));
    const beforeAudit = tableCount('audit_events');

    const result = recordInvestigationEstablishment(
      connection.db,
      input,
      context,
      new Date(establishmentCreatedAt)
    );

    expect(result).toEqual({
      replayed: false,
      establishment: {
        establishmentRef: input.establishmentRef,
        caseId: scenario.snapshot.caseId,
        questionRef: scenario.gap.id,
        claimRef: scenario.claim.claimRef,
        ...demoBatchEstablishmentPolicy,
        basisClaimRefs: [scenario.claim.claimRef],
        basisAssessmentRefs: [scenario.review.assessmentRef],
        basisEvidenceRefs: [scenario.external.evidenceRef, scenario.internal.evidenceRef].sort(),
        basisCaseVersion: scenario.snapshot.caseVersion,
        basisMaterialRevision: scenario.snapshot.materialRevision,
        createdAt: establishmentCreatedAt,
        demo: true
      }
    });
    expect(protectedState()).toEqual(before);
    expect(readCaseSnapshot(connection.db, scenario.snapshot.caseId)).toEqual(beforeSnapshot);
    expect(tableCount('investigation_establishments')).toBe(1);
    expect(tableCount('audit_events')).toBe(beforeAudit + 1);
    const audit = connection.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, 'investigation_establishment_recorded')).get();
    expect(audit).toMatchObject({
      actorType: 'agent',
      actorName: demoBatchEstablishmentPolicy.evaluatorIdentifier
    });
    expect(JSON.parse(audit!.metadataJson)).toMatchObject({
      establishmentRef: input.establishmentRef,
      policyIdentifier: demoBatchEstablishmentPolicy.policyIdentifier,
      basisMaterialRevision: scenario.snapshot.materialRevision
    });
  });

  it('persists every structural Assessment head, including a stale head on a superseded Claim', () => {
    const { snapshot, gap } = versionedGapCase();
    const internal = createEvidence(snapshot.caseId, gap.id, 'basis-internal', {
      sourceKind: 'INTERNAL'
    });
    const external = createEvidence(snapshot.caseId, gap.id, 'basis-external');
    const evidenceRefs = [internal.evidenceRef, external.evidenceRef];
    const oldClaim = createClaim(snapshot, gap.id, evidenceRefs);
    const oldReview = createAssessment(snapshot, gap.id, evidenceRefs, {
      targetClaimRef: oldClaim.claimRef
    });
    const currentClaim = createClaim(snapshot, gap.id, evidenceRefs, 'MFT24', {
      supersedesClaimRef: oldClaim.claimRef
    });
    const currentReview = createAssessment(snapshot, gap.id, evidenceRefs, {
      targetClaimRef: currentClaim.claimRef
    });

    const analysis = readEffectiveInvestigationAnalysis(
      connection.db,
      snapshot.caseId,
      gap.id
    );
    expect(analysis.staleAssessments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assessment: expect.objectContaining({ assessmentRef: oldReview.assessmentRef }),
        reasons: expect.arrayContaining(['CLAIM_SUPERSEDED'])
      })
    ]));

    const recorded = recordInvestigationEstablishment(
      connection.db,
      establishmentInput(snapshot, gap.id, currentClaim.claimRef),
      context
    ).establishment;
    expect(recorded.basisClaimRefs).toEqual([currentClaim.claimRef]);
    expect(recorded.basisAssessmentRefs).toEqual([
      currentReview.assessmentRef,
      oldReview.assessmentRef
    ].sort());
  });

  it('rejects caller policy fields, stale versions and failed policy with zero writes', () => {
    const scenario = eligibleScenario();
    const base = establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef);
    const beforeAudit = tableCount('audit_events');

    expectEstablishmentError(() => recordInvestigationEstablishment(
      connection.db,
      { ...base, policyIdentifier: 'caller-policy' } as RecordInvestigationEstablishmentInput,
      context
    ), 'INVALID_INPUT');
    expectEstablishmentError(() => recordInvestigationEstablishment(
      connection.db,
      { ...base, establishmentRef: randomUUID() },
      { mode: 'disabled' }
    ), 'FORBIDDEN');
    expectEstablishmentError(() => recordInvestigationEstablishment(
      connection.db,
      { ...base, establishmentRef: randomUUID(), demo: false },
      context
    ), 'FORBIDDEN');
    expectEstablishmentError(() => recordInvestigationEstablishment(
      connection.db,
      { ...base, establishmentRef: randomUUID(), expectedCaseVersion: base.expectedCaseVersion + 1 },
      context
    ), 'STALE_CASE_VERSION');
    expectEstablishmentError(() => recordInvestigationEstablishment(
      connection.db,
      {
        ...base,
        establishmentRef: randomUUID(),
        expectedMaterialRevision: base.expectedMaterialRevision + 1
      },
      context
    ), 'STALE_MATERIAL_REVISION');

    createEvidence(scenario.snapshot.caseId, scenario.gap.id, 'policy-failure-third', {
      sourceKind: 'REGULATOR'
    });
    expectEstablishmentError(() => recordInvestigationEstablishment(
      connection.db,
      { ...base, establishmentRef: randomUUID() },
      context
    ), 'POLICY_NOT_SATISFIED', 'HUMAN_REVIEW_INCOMPLETE');
    expect(tableCount('investigation_establishments')).toBe(0);
    expect(tableCount('audit_events')).toBe(beforeAudit);
  });

  it('replays historical identity before freshness/policy checks and conflicts on changed identity', () => {
    const scenario = eligibleScenario();
    const input = establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef);
    const first = recordInvestigationEstablishment(connection.db, input, context);
    const auditCount = tableCount('audit_events');
    const advanced = structuredClone(scenario.snapshot);
    advanced.caseVersion += 1;
    advanced.updatedAt = '2026-09-09T20:00:00.000Z';
    advanced.investigation!.gaps = [];
    advanced.uncertainties = [];
    persistSnapshotRevision(advanced);

    expect(recordInvestigationEstablishment(connection.db, {
      ...input,
      expectedCaseVersion: 999,
      expectedMaterialRevision: 999
    }, context)).toEqual({ ...first, replayed: true });
    expect(tableCount('audit_events')).toBe(auditCount);

    for (const changed of [
      { questionRef: 'question:changed' },
      { claimRef: randomUUID() },
      { caseId: randomUUID() },
      { demo: false }
    ]) {
      expectEstablishmentError(() => recordInvestigationEstablishment(
        connection.db,
        { ...input, ...changed },
        context
      ), 'ESTABLISHMENT_CONFLICT');
    }
  });

  it('evaluates initial eligibility and invalidates history when a different Claim appears', () => {
    const scenario = eligibleScenario();
    const recorded = recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context
    ).establishment;
    expect(evaluateCurrentInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      recorded.establishmentRef
    )).toMatchObject({ currentlyEligible: true, blockerCodes: [] });

    createClaim(
      scenario.snapshot,
      scenario.gap.id,
      [scenario.internal.evidenceRef, scenario.external.evidenceRef],
      'MFT25'
    );
    const current = evaluateCurrentInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      recorded.establishmentRef
    );
    expect(current).toMatchObject({ currentlyEligible: false });
    expect(current!.blockerCodes).toEqual(expect.arrayContaining([
      'ACTIVE_CLAIM_AMBIGUOUS',
      'CLAIM_BASIS_CHANGED'
    ]));
    expect(getInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      recorded.establishmentRef
    )).toEqual(recorded);
  });

  it('does not transfer establishment through same-normalized Claim supersession', () => {
    const scenario = eligibleScenario();
    const recorded = recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context
    ).establishment;
    createClaim(
      scenario.snapshot,
      scenario.gap.id,
      [scenario.internal.evidenceRef, scenario.external.evidenceRef],
      'MFT-24',
      { supersedesClaimRef: scenario.claim.claimRef }
    );

    const current = evaluateCurrentInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      recorded.establishmentRef
    );
    expect(current).toMatchObject({ currentlyEligible: false });
    expect(current!.blockerCodes).toEqual(expect.arrayContaining([
      'TARGET_NOT_ACTIVE',
      'CLAIM_BASIS_CHANGED'
    ]));
    expectEstablishmentError(() => recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context
    ), 'POLICY_NOT_SATISFIED', 'TARGET_NOT_ACTIVE');
  });

  it('invalidates on new Evidence and requires a new complete human review before re-establishment', () => {
    const scenario = eligibleScenario();
    const first = recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context
    ).establishment;
    const third = createEvidence(scenario.snapshot.caseId, scenario.gap.id, 'third', {
      sourceKind: 'REGULATOR'
    });

    const current = evaluateCurrentInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      first.establishmentRef
    );
    expect(current).toMatchObject({ currentlyEligible: false });
    expect(current!.blockerCodes).toEqual(expect.arrayContaining([
      'HUMAN_REVIEW_INCOMPLETE',
      'EVIDENCE_BASIS_CHANGED'
    ]));
    expectEstablishmentError(() => recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context
    ), 'POLICY_NOT_SATISFIED', 'HUMAN_REVIEW_INCOMPLETE');

    createAssessment(
      scenario.snapshot,
      scenario.gap.id,
      [scenario.internal.evidenceRef, scenario.external.evidenceRef, third.evidenceRef],
      { targetClaimRef: scenario.claim.claimRef }
    );
    const second = recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context
    ).establishment;
    expect(second.basisEvidenceRefs).toContain(third.evidenceRef);
    expect(listInvestigationEstablishments(
      connection.db,
      scenario.snapshot.caseId,
      scenario.gap.id
    )).toHaveLength(2);
  });

  it('invalidates when Assessment heads change or a contradiction becomes active', () => {
    const scenario = eligibleScenario();
    const first = recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context
    ).establishment;
    createAssessment(
      scenario.snapshot,
      scenario.gap.id,
      [scenario.internal.evidenceRef, scenario.external.evidenceRef],
      {
        targetClaimRef: scenario.claim.claimRef,
        supersedesAssessmentRef: scenario.review.assessmentRef
      }
    );
    let current = evaluateCurrentInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      first.establishmentRef
    );
    expect(current!.blockerCodes).toContain('ASSESSMENT_BASIS_CHANGED');

    const secondClaim = createClaim(
      scenario.snapshot,
      scenario.gap.id,
      [scenario.internal.evidenceRef, scenario.external.evidenceRef],
      'MFT25'
    );
    createAssessment(
      scenario.snapshot,
      scenario.gap.id,
      [scenario.internal.evidenceRef, scenario.external.evidenceRef],
      {
        verdict: 'CONTRADICTED',
        relatedClaimRefs: [scenario.claim.claimRef, secondClaim.claimRef],
        assessorKind: 'RULE'
      }
    );
    current = evaluateCurrentInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      first.establishmentRef
    );
    expect(current!.blockerCodes).toEqual(expect.arrayContaining([
      'ACTIVE_CONTRADICTION',
      'CLAIM_BASIS_CHANGED',
      'ASSESSMENT_BASIS_CHANGED'
    ]));
  });

  it('does not invalidate solely for operational caseVersion advancement', () => {
    const scenario = eligibleScenario();
    const recorded = recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context
    ).establishment;
    const advanced = structuredClone(scenario.snapshot);
    advanced.caseVersion += 1;
    advanced.updatedAt = '2026-09-09T20:00:00.000Z';
    persistSnapshotRevision(advanced);

    expect(evaluateCurrentInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      recorded.establishmentRef
    )).toMatchObject({ currentlyEligible: true, blockerCodes: [] });
  });

  it('always invalidates when materialRevision changes and fails closed when the question disappears', () => {
    const scenario = eligibleScenario();
    const recorded = recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context
    ).establishment;
    const materiallyAdvanced = structuredClone(scenario.snapshot);
    materiallyAdvanced.caseVersion += 1;
    if (materiallyAdvanced.materialRevision === null) {
      throw new Error('Expected a material revision for the versioned case.');
    }
    materiallyAdvanced.materialRevision += 1;
    materiallyAdvanced.updatedAt = '2026-09-09T20:00:00.000Z';
    materiallyAdvanced.investigation!.materialRevision = materiallyAdvanced.materialRevision;
    persistSnapshotRevision(materiallyAdvanced);

    let current = evaluateCurrentInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      recorded.establishmentRef
    );
    expect(current).toMatchObject({ currentlyEligible: false });
    expect(current!.blockerCodes).toContain('MATERIAL_REVISION_CHANGED');

    const noQuestion = structuredClone(materiallyAdvanced);
    noQuestion.caseVersion += 1;
    noQuestion.updatedAt = '2026-09-09T21:00:00.000Z';
    noQuestion.investigation!.gaps = [];
    noQuestion.uncertainties = [];
    persistSnapshotRevision(noQuestion);
    current = evaluateCurrentInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      recorded.establishmentRef
    );
    expect(current).toMatchObject({ currentlyEligible: false, currentBasis: null });
    expect(current!.blockerCodes).toContain('QUESTION_NOT_CURRENT');
  });

  it('keeps multiple historical establishments case-scoped and deterministically ordered', () => {
    const scenario = eligibleScenario();
    const later = recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context,
      new Date('2026-09-09T19:00:00.000Z')
    ).establishment;
    const earlier = recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context,
      new Date('2026-09-09T18:00:00.000Z')
    ).establishment;

    expect(listInvestigationEstablishments(
      connection.db,
      scenario.snapshot.caseId,
      scenario.gap.id
    ).map((item) => item.establishmentRef)).toEqual([
      earlier.establishmentRef,
      later.establishmentRef
    ]);
    expect(getInvestigationEstablishment(
      connection.db,
      randomUUID(),
      earlier.establishmentRef
    )).toBeNull();
    expect(evaluateCurrentInvestigationEstablishment(
      connection.db,
      randomUUID(),
      earlier.establishmentRef
    )).toBeNull();
    expect(listInvestigationEstablishments(
      connection.db,
      randomUUID(),
      scenario.gap.id
    )).toEqual([]);
  });

  it('performs no writes during current evaluation and survives database reopen', () => {
    const scenario = eligibleScenario();
    const recorded = recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context
    ).establishment;
    const before = {
      protected: protectedState(),
      establishments: connection.db.select().from(schema.investigationEstablishments).all(),
      audit: connection.db.select().from(schema.auditEvents).all()
    };

    const first = evaluateCurrentInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      recorded.establishmentRef
    );
    const second = evaluateCurrentInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      recorded.establishmentRef
    );
    expect(second).toEqual(first);
    expect({
      protected: protectedState(),
      establishments: connection.db.select().from(schema.investigationEstablishments).all(),
      audit: connection.db.select().from(schema.auditEvents).all()
    }).toEqual(before);

    connection.sqlite.close();
    connection = createDatabaseConnection(databasePath);
    expect(getInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      recorded.establishmentRef
    )).toEqual(recorded);
    expect(evaluateCurrentInvestigationEstablishment(
      connection.db,
      scenario.snapshot.caseId,
      recorded.establishmentRef
    )).toEqual(first);
  });

  it('resets restrictive establishment history before Claims and Cases', () => {
    const scenario = eligibleScenario();
    recordInvestigationEstablishment(
      connection.db,
      establishmentInput(scenario.snapshot, scenario.gap.id, scenario.claim.claimRef),
      context
    );

    expect(() => clearDemoData(connection.db)).not.toThrow();
    expect(tableCount('investigation_establishments')).toBe(0);
    expect(tableCount('investigation_assessments')).toBe(0);
    expect(tableCount('investigation_claims')).toBe(0);
    expect(tableCount('cases')).toBe(0);
  });

  it('upgrades populated 0007 state additively, reruns safely and preserves foreign keys', () => {
    const preEstablishmentFolder = join(directory, 'pre-establishment-migrations');
    mkdirSync(join(preEstablishmentFolder, 'meta'), { recursive: true });
    for (const file of [
      '0000_initial.sql',
      '0001_last_living_lightning.sql',
      '0002_case_lifecycle.sql',
      '0003_traceability_exposure.sql',
      '0004_last_thunderbolt.sql',
      '0005_majestic_centennial.sql',
      '0006_cynical_rictor.sql',
      '0007_calm_captain_cross.sql'
    ]) cpSync(join('drizzle', file), join(preEstablishmentFolder, file));
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 8);
    writeFileSync(join(preEstablishmentFolder, 'meta/_journal.json'), JSON.stringify(journal));
    const existing = createDatabaseConnection(join(directory, 'populated-0007.db'));
    try {
      migrate(existing.db, { migrationsFolder: preEstablishmentFolder });
      seedDemoData(existing.db, fixtures);
      const caseId = '60000000-0000-4000-8000-000000000097';
      const questionRef = 'historical:pre-establishment:question';
      const requestId = '93000000-0000-4000-8000-000000000097';
      const evidenceRef = 'evidence:pre-establishment';
      const claimRef = '94000000-0000-4000-8000-000000000097';
      existing.db.insert(schema.cases).values({
        id: caseId,
        caseNumber: 'CASE-PRE-ESTABLISHMENT-097',
        alertId: fixtures.matches[1].alertId,
        status: 'open',
        severity: 'high',
        openedAt: '2026-09-09T10:00:00.000Z',
        closedAt: null
      }).run();
      existing.db.insert(schema.evidenceRequests).values({
        id: requestId,
        matchId: fixtures.matches[1].id,
        caseId,
        questionRef,
        requestedEvidence: '["supplier_invoice"]',
        recipient: null,
        status: 'pending',
        createdAt: '2026-09-09T11:00:00.000Z',
        resolvedAt: null
      }).run();
      existing.db.insert(schema.investigationEvidence).values({
        evidenceRef,
        caseId,
        questionRef,
        evidenceRequestId: requestId,
        sourceKind: 'EXTERNAL_PARTY',
        sourceIdentifier: 'supplier:pre-establishment',
        receivedAt: '2026-09-09T12:00:00.000Z',
        validAsOf: null,
        contentKind: 'STRUCTURED',
        contentJson: '{"assertedBatch":"MFT24"}',
        contentLocator: null,
        integrityHash: 'e'.repeat(64),
        demo: true
      }).run();
      existing.db.insert(schema.investigationClaims).values({
        claimRef,
        caseId,
        questionRef,
        subjectRef: fixtures.matches[1].productId,
        claimType: 'AFFECTED_BATCH_LOT',
        valueJson: '{"lot":"MFT24"}',
        evidenceRefsJson: JSON.stringify([evidenceRef]),
        originKind: 'DETERMINISTIC_EXTRACTED',
        producerIdentifier: 'historical:pre-establishment',
        derivationMetadataJson: null,
        supersedesClaimRef: null,
        createdAt: '2026-09-09T13:00:00.000Z',
        demo: true
      }).run();
      existing.db.insert(schema.investigationAssessments).values({
        assessmentRef: '95000000-0000-4000-8000-000000000097',
        caseId,
        questionRef,
        targetClaimRef: claimRef,
        verdict: 'SUPPORTED',
        evidenceRefsJson: JSON.stringify([evidenceRef]),
        relatedClaimRefsJson: '[]',
        assessorKind: 'HUMAN',
        assessorIdentifier: 'demo_operator',
        ruleIdentifier: null,
        ruleVersion: null,
        rationale: 'Historical reviewed evidence basis.',
        basisCaseVersion: 1,
        supersedesAssessmentRef: null,
        createdAt: '2026-09-09T14:00:00.000Z',
        demo: true
      }).run();
      const before = {
        evidence: existing.db.select().from(schema.investigationEvidence).all(),
        claims: existing.db.select().from(schema.investigationClaims).all(),
        assessments: existing.db.select().from(schema.investigationAssessments).all()
      };

      migrate(existing.db, { migrationsFolder: resolve('drizzle') });
      migrate(existing.db, { migrationsFolder: resolve('drizzle') });

      expect({
        evidence: existing.db.select().from(schema.investigationEvidence).all(),
        claims: existing.db.select().from(schema.investigationClaims).all(),
        assessments: existing.db.select().from(schema.investigationAssessments).all()
      }).toEqual(before);
      expect(existing.db.select().from(schema.investigationEstablishments).all()).toEqual([]);
      expect(existing.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      existing.sqlite.close();
    }
  });
});

function snapshotId(scenario: { snapshot: CaseSnapshot }): string {
  return scenario.snapshot.caseId;
}
