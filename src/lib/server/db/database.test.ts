import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseConnection } from './client';
import { loadDemoFixtures } from './demo-fixtures';
import { getDemoStateSummary, seedDemoData } from './repositories';
import { alerts, cases, products } from './schema';

type TestConnection = ReturnType<typeof createDatabaseConnection>;

let temporaryDirectory: string;
let connection: TestConnection;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'recallops-db-test-'));
  connection = createDatabaseConnection(join(temporaryDirectory, 'recallops.db'));
  migrate(connection.db, { migrationsFolder: resolve('drizzle') });
});

afterEach(() => {
  connection.sqlite.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('Stage 1 database', () => {
  it('reruns the complete clean-database migration set without foreign-key violations', () => {
    expect(() => migrate(connection.db, { migrationsFolder: resolve('drizzle') })).not.toThrow();
    expect(connection.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('migrates every P0 table into a new empty database', () => {
    const tableNames = connection.sqlite
      .prepare("select name from sqlite_master where type = 'table'")
      .pluck()
      .all() as string[];

    expect(tableNames).toEqual(
      expect.arrayContaining([
        'settings',
        'products',
        'customers',
        'purchases',
        'alerts',
        'matches',
        'cases',
        'case_items',
        'case_tasks',
        'evidence_requests',
        'action_drafts',
        'audit_events',
        'case_lifecycle',
        'case_revisions',
        'case_commands',
        'investigation_evidence',
        'investigation_claims',
        'investigation_assessments',
        'investigation_establishments',
        'investigation_questions',
        'investigation_challenges',
        'investigation_challenge_requests',
        'investigation_challenge_claims',
        'investigation_challenge_assessments',
        'investigation_challenge_conflict_applications',
        'traceability_records'
      ])
    );

    const indexNames = connection.sqlite
      .prepare("select name from sqlite_master where type = 'index'")
      .pluck()
      .all() as string[];

    expect(indexNames).toEqual(
      expect.arrayContaining([
        'products_sku_unique',
        'customers_external_id_unique',
        'alerts_source_reference_unique',
        'cases_alert_id_unique',
        'products_ean_idx',
        'products_normalized_brand_idx',
        'matches_alert_id_idx',
        'cases_status_idx',
        'audit_events_case_id_idx',
        'case_items_case_product_batch_unique',
        'case_tasks_case_type_unique',
        'evidence_requests_case_question_created_idx',
        'investigation_evidence_case_idx',
        'investigation_claims_case_question_created_idx',
        'investigation_assessments_case_question_created_idx',
        'investigation_establishments_case_question_created_idx',
        'investigation_questions_case_created_idx',
        'investigation_challenges_case_question_material_unique',
        'investigation_challenges_case_question_created_idx',
        'investigation_challenge_requests_challenge_idx',
        'investigation_challenge_claims_challenge_idx',
        'investigation_challenge_assessments_challenge_idx',
        'investigation_challenge_conflict_applications_challenge_unique',
        'investigation_challenge_conflict_applications_result_revision_unique',
        'investigation_challenge_conflict_applications_case_question_created_idx',
        'traceability_records_source_unique',
        'traceability_records_case_idx'
      ])
    );
  });

  it('enforces evidence, claim and assessment constraints in SQLite', () => {
    const fixtures = loadDemoFixtures();
    seedDemoData(connection.db, fixtures);
    const caseId = '60000000-0000-4000-8000-000000000001';
    connection.db.insert(cases).values({
      id: caseId,
      caseNumber: 'CASE-EVIDENCE-CONSTRAINTS',
      alertId: fixtures.alerts[0].id,
      status: 'open',
      severity: 'high',
      openedAt: '2026-09-08T12:00:00.000Z',
      closedAt: null
    }).run();

    const requestInsert = connection.sqlite.prepare(`
      insert into evidence_requests (
        id, match_id, case_id, question_ref, requested_evidence,
        recipient, status, created_at, resolved_at
      ) values (?, ?, ?, ?, '["batch_label_photo"]', null, 'pending', ?, null)
    `);
    expect(() => requestInsert.run(
      '90000000-0000-4000-8000-000000000091',
      fixtures.matches[0].id,
      caseId,
      null,
      '2026-09-08T12:00:00.000Z'
    )).toThrow(/evidence_requests_versioned_question_check/);
    expect(() => requestInsert.run(
      '90000000-0000-4000-8000-000000000092',
      fixtures.matches[0].id,
      null,
      'demo:scope-gap:test',
      '2026-09-08T12:00:00.000Z'
    )).toThrow(/evidence_requests_versioned_question_check/);

    const insertQuestion = connection.sqlite.prepare(`
      insert into investigation_questions (
        question_ref, case_id, subject_ref, question_type,
        origin_case_version, origin_material_revision, created_at, demo
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const questionCreatedAt = '2026-09-08T11:00:00.000Z';
    expect(() => insertQuestion.run(
      ' ', caseId, fixtures.products[0].id, 'AFFECTED_BATCH_LOT',
      1, 1, questionCreatedAt, 1
    )).toThrow(/investigation_questions_question_ref_check/);
    expect(() => insertQuestion.run(
      'question:invalid-type', caseId, fixtures.products[0].id, 'PRODUCT_IDENTITY',
      1, 1, questionCreatedAt, 1
    )).toThrow(/investigation_questions_question_type_check/);
    expect(() => insertQuestion.run(
      'question:invalid-case-version', caseId, fixtures.products[0].id,
      'AFFECTED_BATCH_LOT', 0, 1, questionCreatedAt, 1
    )).toThrow(/investigation_questions_origin_case_version_check/);
    expect(() => insertQuestion.run(
      'question:invalid-material-revision', caseId, fixtures.products[0].id,
      'AFFECTED_BATCH_LOT', 1, 0, questionCreatedAt, 1
    )).toThrow(/investigation_questions_origin_material_revision_check/);
    expect(() => insertQuestion.run(
      'question:invalid-demo', caseId, fixtures.products[0].id,
      'AFFECTED_BATCH_LOT', 1, 1, questionCreatedAt, 2
    )).toThrow(/investigation_questions_demo_check/);

    const questionForeignKeys = connection.sqlite
      .prepare("pragma foreign_key_list('investigation_questions')")
      .all() as Array<{ from: string; table: string; on_delete: string }>;
    expect(questionForeignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'case_id', table: 'cases', on_delete: 'NO ACTION' }),
      expect.objectContaining({ from: 'subject_ref', table: 'products', on_delete: 'NO ACTION' })
    ]));

    const insert = connection.sqlite.prepare(`
      insert into investigation_evidence (
        evidence_ref, case_id, question_ref, evidence_request_id,
        source_kind, source_identifier, received_at, valid_as_of,
        content_kind, content_json, content_locator, integrity_hash, demo
      ) values (?, ?, ?, null, ?, ?, ?, null, ?, ?, ?, ?, 1)
    `);
    const common = [
      caseId,
      'question:identity:ean',
      'source:constraint-test',
      '2026-09-08T12:00:00.000Z'
    ] as const;

    expect(() => insert.run(
      'evidence:invalid-source', common[0], common[1], 'AI_EXTRACTED', common[2], common[3],
      'STRUCTURED', '{}', null, 'a'.repeat(64)
    )).toThrow(/investigation_evidence_source_kind_check/);
    expect(() => insert.run(
      'evidence:invalid-content', common[0], common[1], 'REGULATOR', common[2], common[3],
      'STRUCTURED', null, 'object-store:\/\/unexpected', 'a'.repeat(64)
    )).toThrow(/investigation_evidence_content_check/);
    expect(() => insert.run(
      'evidence:invalid-hash', common[0], common[1], 'REGULATOR', common[2], common[3],
      'STRUCTURED', '{}', null, 'not-a-content-hash'
    )).toThrow(/investigation_evidence_integrity_hash_check/);

    const insertClaim = connection.sqlite.prepare(`
      insert into investigation_claims (
        claim_ref, case_id, question_ref, subject_ref, claim_type,
        value_json, evidence_refs_json, origin_kind, producer_identifier,
        derivation_metadata_json, supersedes_claim_ref, created_at, demo
      ) values (?, ?, 'demo:scope-gap:test', ?, ?, '{"lot":"MFT24"}',
        '["evidence:test"]', ?, 'parser:test', null, null, ?, ?)
    `);
    expect(() => insertClaim.run(
      '92000000-0000-4000-8000-000000000091',
      caseId,
      fixtures.products[0].id,
      'IDENTITY',
      'DETERMINISTIC_EXTRACTED',
      '2026-09-08T12:00:00.000Z',
      1
    )).toThrow(/investigation_claims_claim_type_check/);
    expect(() => insertClaim.run(
      '92000000-0000-4000-8000-000000000092',
      caseId,
      fixtures.products[0].id,
      'AFFECTED_BATCH_LOT',
      'ESTABLISHED',
      '2026-09-08T12:00:00.000Z',
      1
    )).toThrow(/investigation_claims_origin_kind_check/);
    expect(() => insertClaim.run(
      '92000000-0000-4000-8000-000000000093',
      caseId,
      fixtures.products[0].id,
      'AFFECTED_BATCH_LOT',
      'HUMAN_OBSERVED',
      '2026-09-08T12:00:00.000Z',
      2
    )).toThrow(/investigation_claims_demo_check/);

    const validClaimRef = '92000000-0000-4000-8000-000000000094';
    insertClaim.run(
      validClaimRef,
      caseId,
      fixtures.products[0].id,
      'AFFECTED_BATCH_LOT',
      'HUMAN_OBSERVED',
      '2026-09-08T12:00:00.000Z',
      1
    );
    const insertAssessment = connection.sqlite.prepare(`
      insert into investigation_assessments (
        assessment_ref, case_id, question_ref, target_claim_ref, verdict,
        evidence_refs_json, related_claim_refs_json, assessor_kind,
        assessor_identifier, rule_identifier, rule_version, rationale,
        basis_case_version, supersedes_assessment_ref, created_at, demo
      ) values (?, ?, 'demo:scope-gap:test', ?, ?, '["evidence:test"]', '[]', ?,
        'assessor:test', ?, ?, 'Reviewed immutable evidence basis.', ?, null, ?, ?)
    `);
    const assessmentCreatedAt = '2026-09-08T13:00:00.000Z';
    expect(() => insertAssessment.run(
      '95000000-0000-4000-8000-000000000091', caseId, validClaimRef,
      'ESTABLISHED', 'HUMAN', null, null, 1, assessmentCreatedAt, 1
    )).toThrow(/investigation_assessments_verdict_check/);
    expect(() => insertAssessment.run(
      '95000000-0000-4000-8000-000000000092', caseId, validClaimRef,
      'SUPPORTED', 'SYSTEM', 'rule:test', 'v1', 1, assessmentCreatedAt, 1
    )).toThrow(/investigation_assessments_assessor_kind_check/);
    expect(() => insertAssessment.run(
      '95000000-0000-4000-8000-000000000093', caseId, validClaimRef,
      'SUPPORTED', 'HUMAN', 'rule:test', null, 1, assessmentCreatedAt, 1
    )).toThrow(/investigation_assessments_rule_pair_check/);
    expect(() => insertAssessment.run(
      '95000000-0000-4000-8000-000000000094', caseId, validClaimRef,
      'SUPPORTED', 'RULE', null, null, 1, assessmentCreatedAt, 1
    )).toThrow(/investigation_assessments_rule_required_check/);
    expect(() => insertAssessment.run(
      '95000000-0000-4000-8000-000000000095', caseId, validClaimRef,
      'SUPPORTED', 'HUMAN', null, null, 0, assessmentCreatedAt, 1
    )).toThrow(/investigation_assessments_basis_case_version_check/);
    expect(() => insertAssessment.run(
      '95000000-0000-4000-8000-000000000096', caseId, validClaimRef,
      'SUPPORTED', 'HUMAN', null, null, 1, assessmentCreatedAt, 2
    )).toThrow(/investigation_assessments_demo_check/);

    const claimForeignKeys = connection.sqlite
      .prepare("pragma foreign_key_list('investigation_claims')")
      .all() as Array<{ from: string; table: string; on_delete: string }>;
    expect(claimForeignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'case_id', table: 'cases', on_delete: 'NO ACTION' }),
      expect.objectContaining({ from: 'subject_ref', table: 'products', on_delete: 'NO ACTION' }),
      expect.objectContaining({
        from: 'supersedes_claim_ref',
        table: 'investigation_claims',
        on_delete: 'NO ACTION'
      })
    ]));

    const assessmentForeignKeys = connection.sqlite
      .prepare("pragma foreign_key_list('investigation_assessments')")
      .all() as Array<{ from: string; table: string; on_delete: string }>;
    expect(assessmentForeignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'case_id', table: 'cases', on_delete: 'NO ACTION' }),
      expect.objectContaining({
        from: 'target_claim_ref',
        table: 'investigation_claims',
        on_delete: 'NO ACTION'
      }),
      expect.objectContaining({
        from: 'supersedes_assessment_ref',
        table: 'investigation_assessments',
        on_delete: 'NO ACTION'
      })
    ]));

    const challengeAssociationForeignKeys = (
      table: string
    ): Array<{ from: string; table: string; on_delete: string }> => connection.sqlite
      .prepare(`pragma foreign_key_list('${table}')`)
      .all() as Array<{ from: string; table: string; on_delete: string }>;
    expect(challengeAssociationForeignKeys('investigation_challenge_requests')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'request_id', table: 'evidence_requests', on_delete: 'NO ACTION'
        }),
        expect.objectContaining({
          from: 'challenge_ref', table: 'investigation_challenges', on_delete: 'NO ACTION'
        })
      ])
    );
    expect(challengeAssociationForeignKeys('investigation_challenge_claims')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'claim_ref', table: 'investigation_claims', on_delete: 'NO ACTION'
        }),
        expect.objectContaining({
          from: 'challenge_ref', table: 'investigation_challenges', on_delete: 'NO ACTION'
        })
      ])
    );
    expect(challengeAssociationForeignKeys('investigation_challenge_assessments')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'assessment_ref', table: 'investigation_assessments', on_delete: 'NO ACTION'
        }),
        expect.objectContaining({
          from: 'challenge_ref', table: 'investigation_challenges', on_delete: 'NO ACTION'
        })
      ])
    );
    expect(challengeAssociationForeignKeys(
      'investigation_challenge_conflict_applications'
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: 'case_id', table: 'cases', on_delete: 'NO ACTION'
      }),
      expect.objectContaining({
        from: 'question_ref', table: 'investigation_questions', on_delete: 'NO ACTION'
      }),
      expect.objectContaining({
        from: 'challenge_ref', table: 'investigation_challenges', on_delete: 'NO ACTION'
      }),
      expect.objectContaining({
        from: 'source_revision_id', table: 'case_revisions', on_delete: 'NO ACTION'
      }),
      expect.objectContaining({
        from: 'resulting_revision_id', table: 'case_revisions', on_delete: 'NO ACTION'
      })
    ]));
    const applicationIndexes = connection.sqlite
      .prepare("pragma index_list('investigation_challenge_conflict_applications')")
      .all() as Array<{ name: string; unique: number }>;
    expect(applicationIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'investigation_challenge_conflict_applications_challenge_unique',
        unique: 1
      }),
      expect.objectContaining({
        name: 'investigation_challenge_conflict_applications_result_revision_unique',
        unique: 1
      })
    ]));

    const insertEstablishment = connection.sqlite.prepare(`
      insert into investigation_establishments (
        establishment_ref, case_id, question_ref, claim_ref,
        policy_identifier, policy_version, basis_claim_refs_json,
        basis_assessment_refs_json, basis_evidence_refs_json,
        evaluator_kind, evaluator_identifier, basis_case_version,
        basis_material_revision, created_at, demo
      ) values (?, ?, 'demo:scope-gap:test', ?, ?, ?, '["claim:test"]',
        '["assessment:test"]', '["evidence:test"]', ?, ?, ?, ?, ?, ?)
    `);
    const establishmentCreatedAt = '2026-09-08T14:00:00.000Z';
    expect(() => insertEstablishment.run(
      '96000000-0000-4000-8000-000000000091', caseId, validClaimRef,
      'policy:test', 'v1', 'AI', 'evaluator:test', 1, 1, establishmentCreatedAt, 1
    )).toThrow(/investigation_establishments_evaluator_kind_check/);
    expect(() => insertEstablishment.run(
      '96000000-0000-4000-8000-000000000092', caseId, validClaimRef,
      ' ', 'v1', 'RULE', 'evaluator:test', 1, 1, establishmentCreatedAt, 1
    )).toThrow(/investigation_establishments_policy_identifier_check/);
    expect(() => insertEstablishment.run(
      '96000000-0000-4000-8000-000000000093', caseId, validClaimRef,
      'policy:test', ' ', 'RULE', 'evaluator:test', 1, 1, establishmentCreatedAt, 1
    )).toThrow(/investigation_establishments_policy_version_check/);
    expect(() => insertEstablishment.run(
      '96000000-0000-4000-8000-000000000094', caseId, validClaimRef,
      'policy:test', 'v1', 'RULE', ' ', 1, 1, establishmentCreatedAt, 1
    )).toThrow(/investigation_establishments_evaluator_identifier_check/);
    expect(() => insertEstablishment.run(
      '96000000-0000-4000-8000-000000000095', caseId, validClaimRef,
      'policy:test', 'v1', 'RULE', 'evaluator:test', 0, 1, establishmentCreatedAt, 1
    )).toThrow(/investigation_establishments_basis_case_version_check/);
    expect(() => insertEstablishment.run(
      '96000000-0000-4000-8000-000000000096', caseId, validClaimRef,
      'policy:test', 'v1', 'RULE', 'evaluator:test', 1, 0, establishmentCreatedAt, 1
    )).toThrow(/investigation_establishments_basis_material_revision_check/);
    expect(() => insertEstablishment.run(
      '96000000-0000-4000-8000-000000000097', caseId, validClaimRef,
      'policy:test', 'v1', 'RULE', 'evaluator:test', 1, 1, establishmentCreatedAt, 0
    )).toThrow(/investigation_establishments_demo_check/);

    const establishmentForeignKeys = connection.sqlite
      .prepare("pragma foreign_key_list('investigation_establishments')")
      .all() as Array<{ from: string; table: string; on_delete: string }>;
    expect(establishmentForeignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'case_id', table: 'cases', on_delete: 'NO ACTION' }),
      expect.objectContaining({
        from: 'claim_ref',
        table: 'investigation_claims',
        on_delete: 'NO ACTION'
      })
    ]));
  });

  it('seeds deterministically and preserves all three demo scenarios', () => {
    const fixtures = loadDemoFixtures();

    seedDemoData(connection.db, fixtures);
    const firstSummary = getDemoStateSummary(connection.db);
    seedDemoData(connection.db, fixtures);
    const secondSummary = getDemoStateSummary(connection.db);

    expect(secondSummary).toEqual(firstSummary);
    expect(secondSummary).toEqual({
      settings: 1,
      products: 15,
      customers: 7,
      purchases: 8,
      alerts: 3,
      matches: 3,
      cases: 0,
      scenarios: {
        highConfidence: 1,
        uncertain: 1,
        notRelevant: 1
      }
    });

    const scenarios = connection.sqlite
      .prepare(
        `select alerts.status as alertStatus,
                matches.status as matchStatus,
                matches.has_hard_conflict as hasHardConflict,
                cases.id as caseId
           from alerts
           join matches on matches.alert_id = alerts.id
      left join cases on cases.alert_id = alerts.id
       order by alerts.status`
      )
      .all() as Array<{
      alertStatus: string;
      matchStatus: string;
      hasHardConflict: number;
      caseId: string | null;
    }>;

    expect(scenarios).toEqual([
      {
        alertStatus: 'needs_review',
        matchStatus: 'candidate',
        hasHardConflict: 0,
        caseId: null
      },
      {
        alertStatus: 'needs_review',
        matchStatus: 'candidate',
        hasHardConflict: 1,
        caseId: null
      },
      {
        alertStatus: 'not_relevant',
        matchStatus: 'candidate',
        hasHardConflict: 0,
        caseId: null
      }
    ]);
  });

  it('rejects duplicate product SKUs and source references', () => {
    const fixtures = loadDemoFixtures();
    seedDemoData(connection.db, fixtures);

    expect(() =>
      connection.db
        .insert(products)
        .values({
          ...fixtures.products[0],
          id: '10000000-0000-4000-8000-000000000099'
        })
        .run()
    ).toThrow(/UNIQUE constraint failed: products\.sku/);

    expect(() =>
      connection.db
        .insert(alerts)
        .values({
          ...fixtures.alerts[0],
          id: '40000000-0000-4000-8000-000000000099'
        })
        .run()
    ).toThrow(/UNIQUE constraint failed: alerts\.source, alerts\.source_reference/);

    expect(() =>
      connection.sqlite
        .prepare("update alerts set status = 'invalid_status' where id = ?")
        .run(fixtures.alerts[0].id)
    ).toThrow(/CHECK constraint failed: alerts_status_check/);
  });
});
