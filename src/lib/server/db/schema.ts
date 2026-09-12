import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex
} from 'drizzle-orm/sqlite-core';

import {
  actionStatuses,
  actionTypes,
  alertSourceNames,
  alertStatuses,
  caseStatuses,
  caseTaskStatuses,
  matchStatuses
} from '../../types/domain';

export const investigationEvidenceSourceKinds = [
  'REGULATOR',
  'INTERNAL',
  'EXTERNAL_PARTY',
  'HUMAN_OBSERVED'
] as const;

export const investigationEvidenceContentKinds = ['STRUCTURED', 'LOCATOR'] as const;

export const investigationClaimTypes = ['AFFECTED_BATCH_LOT'] as const;

export const investigationClaimOriginKinds = [
  'DETERMINISTIC_EXTRACTED',
  'AI_PROPOSED',
  'HUMAN_OBSERVED'
] as const;

export const investigationAssessmentVerdicts = [
  'SUPPORTED',
  'INSUFFICIENT',
  'REJECTED',
  'CONTRADICTED'
] as const;

export const investigationAssessmentAssessorKinds = ['RULE', 'HUMAN', 'AI'] as const;

export const investigationEstablishmentEvaluatorKinds = ['RULE'] as const;

export const investigationQuestionTypes = ['AFFECTED_BATCH_LOT'] as const;

export const investigationChallengeOpenedByKinds = ['HUMAN'] as const;

export const investigationChallengeConflictApplicationActorKinds = ['HUMAN'] as const;

export const investigationChallengeBatchApplicationActorKinds = ['HUMAN'] as const;

export const investigationEstablishedBatchApplicationActorKinds = ['HUMAN'] as const;

export const alertSourceObservationRecordKinds = ['RAW_SOURCE', 'LEGACY_SNAPSHOT'] as const;

export const alertFieldKinds = [
  'PRODUCT_NAME',
  'BRAND',
  'EAN_GTIN',
  'BATCH_LOT',
  'CATEGORY'
] as const;

export const alertFieldAssertionOriginKinds = [
  'SOURCE_ASSERTED',
  'DETERMINISTIC_DERIVED',
  'AI_PROPOSAL',
  'HUMAN_CONFIRMED',
  'LEGACY_UNVERIFIED'
] as const;

export const alertMatchExplanationOrigins = ['DETERMINISTIC', 'AI_GENERATED'] as const;

export const settings = sqliteTable(
  'settings',
  {
    id: text('id').primaryKey(),
    confidenceThreshold: integer('confidence_threshold').notNull().default(85),
    reviewFloor: integer('review_floor').notNull().default(55),
    onboardingCompleted: integer('onboarding_completed', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    check(
      'settings_confidence_threshold_check',
      sql`${table.confidenceThreshold} between 70 and 95`
    ),
    check('settings_review_floor_check', sql`${table.reviewFloor} between 0 and 100`),
    check('settings_onboarding_completed_check', sql`${table.onboardingCompleted} in (0, 1)`)
  ]
);

export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    brand: text('brand').notNull(),
    normalizedBrand: text('normalized_brand').notNull(),
    ean: text('ean'),
    batch: text('batch'),
    supplierName: text('supplier_name'),
    supplierEmail: text('supplier_email'),
    category: text('category'),
    stockQuantity: integer('stock_quantity').notNull().default(0),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    uniqueIndex('products_sku_unique').on(table.sku),
    index('products_ean_idx').on(table.ean),
    index('products_normalized_brand_idx').on(table.normalizedBrand),
    check('products_stock_quantity_check', sql`${table.stockQuantity} >= 0`)
  ]
);

export const customers = sqliteTable(
  'customers',
  {
    id: text('id').primaryKey(),
    externalId: text('external_id').notNull(),
    name: text('name'),
    email: text('email'),
    createdAt: text('created_at').notNull()
  },
  (table) => [uniqueIndex('customers_external_id_unique').on(table.externalId)]
);

export const purchases = sqliteTable('purchases', {
  id: text('id').primaryKey(),
  customerId: text('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  productId: text('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  batch: text('batch'),
  purchasedAt: text('purchased_at').notNull(),
  quantity: integer('quantity').notNull().default(1)
}, (table) => [check('purchases_quantity_check', sql`${table.quantity} > 0`)]);

export const alerts = sqliteTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    source: text('source', { enum: alertSourceNames }).notNull(),
    sourceReference: text('source_reference').notNull(),
    sourceUrl: text('source_url').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    risk: text('risk').notNull(),
    imageUrl: text('image_url'),
    brand: text('brand'),
    productName: text('product_name').notNull(),
    ean: text('ean'),
    batch: text('batch'),
    category: text('category'),
    publishedAt: text('published_at').notNull(),
    status: text('status', { enum: alertStatuses }).notNull(),
    rawJson: text('raw_json').notNull(),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    uniqueIndex('alerts_source_reference_unique').on(table.source, table.sourceReference),
    check('alerts_source_check', sql`${table.source} in ('safety_gate', 'rasff')`),
    check(
      'alerts_status_check',
      sql`${table.status} in ('matched', 'needs_review', 'not_relevant')`
    )
  ]
);

export const matches = sqliteTable(
  'matches',
  {
    id: text('id').primaryKey(),
    alertId: text('alert_id')
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    totalScore: integer('total_score').notNull(),
    nameScore: integer('name_score').notNull(),
    brandScore: integer('brand_score').notNull(),
    eanScore: integer('ean_score').notNull(),
    batchScore: integer('batch_score').notNull(),
    hasHardConflict: integer('has_hard_conflict', { mode: 'boolean' }).notNull().default(false),
    explanation: text('explanation').notNull(),
    status: text('status', { enum: matchStatuses }).notNull(),
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at')
  },
  (table) => [
    index('matches_alert_id_idx').on(table.alertId),
    check('matches_total_score_check', sql`${table.totalScore} between 0 and 100`),
    check('matches_name_score_check', sql`${table.nameScore} between 0 and 100`),
    check('matches_brand_score_check', sql`${table.brandScore} between 0 and 100`),
    check('matches_ean_score_check', sql`${table.eanScore} between 0 and 100`),
    check('matches_batch_score_check', sql`${table.batchScore} between 0 and 100`),
    check('matches_hard_conflict_check', sql`${table.hasHardConflict} in (0, 1)`),
    check(
      'matches_status_check',
      sql`${table.status} in ('candidate', 'confirmed', 'rejected', 'awaiting_evidence')`
    )
  ]
);

export const cases = sqliteTable(
  'cases',
  {
    id: text('id').primaryKey(),
    caseNumber: text('case_number').notNull(),
    alertId: text('alert_id')
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    status: text('status', { enum: caseStatuses }).notNull(),
    severity: text('severity').notNull(),
    openedAt: text('opened_at').notNull(),
    closedAt: text('closed_at')
  },
  (table) => [
    uniqueIndex('cases_case_number_unique').on(table.caseNumber),
    uniqueIndex('cases_alert_id_unique').on(table.alertId),
    index('cases_status_idx').on(table.status),
    check('cases_status_check', sql`${table.status} in ('open', 'contained', 'closed')`)
  ]
);

export const caseItems = sqliteTable(
  'case_items',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    batch: text('batch').notNull(),
    stockQuantity: integer('stock_quantity').notNull()
  },
  (table) => [
    uniqueIndex('case_items_case_product_batch_unique').on(
      table.caseId,
      table.productId,
      table.batch
    ),
    check('case_items_stock_quantity_check', sql`${table.stockQuantity} >= 0`)
  ]
);

export const caseTasks = sqliteTable(
  'case_tasks',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    type: text('type', { enum: actionTypes }).notNull(),
    label: text('label').notNull(),
    status: text('status', { enum: caseTaskStatuses }).notNull(),
    completedBy: text('completed_by'),
    completedAt: text('completed_at')
  },
  (table) => [
    uniqueIndex('case_tasks_case_type_unique').on(table.caseId, table.type),
    check(
      'case_tasks_type_check',
      sql`${table.type} in ('block_sale', 'notify_supplier', 'notify_customers')`
    ),
    check(
      'case_tasks_status_check',
      sql`${table.status} in ('pending', 'completed', 'not_available')`
    )
  ]
);

export const evidenceRequests = sqliteTable('evidence_requests', {
  id: text('id').primaryKey(),
  matchId: text('match_id')
    .notNull()
    .references(() => matches.id, { onDelete: 'cascade' }),
  caseId: text('case_id').references(() => cases.id),
  questionRef: text('question_ref'),
  requestedEvidence: text('requested_evidence').notNull(),
  recipient: text('recipient'),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at')
}, (table) => [
  index('evidence_requests_case_question_created_idx').on(
    table.caseId,
    table.questionRef,
    table.createdAt
  ),
  check(
    'evidence_requests_versioned_question_check',
    sql`(${table.caseId} is null and ${table.questionRef} is null)
        or (${table.caseId} is not null and ${table.questionRef} is not null)`
  )
]);

export const investigationQuestions = sqliteTable(
  'investigation_questions',
  {
    questionRef: text('question_ref').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    subjectRef: text('subject_ref')
      .notNull()
      .references(() => products.id),
    questionType: text('question_type', { enum: investigationQuestionTypes }).notNull(),
    originCaseVersion: integer('origin_case_version').notNull(),
    originMaterialRevision: integer('origin_material_revision').notNull(),
    createdAt: text('created_at').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull()
  },
  (table) => [
    index('investigation_questions_case_created_idx').on(table.caseId, table.createdAt),
    check(
      'investigation_questions_question_ref_check',
      sql`length(trim(${table.questionRef})) > 0`
    ),
    check(
      'investigation_questions_question_type_check',
      sql`${table.questionType} = 'AFFECTED_BATCH_LOT'`
    ),
    check(
      'investigation_questions_origin_case_version_check',
      sql`${table.originCaseVersion} > 0`
    ),
    check(
      'investigation_questions_origin_material_revision_check',
      sql`${table.originMaterialRevision} > 0`
    ),
    check('investigation_questions_demo_check', sql`${table.demo} in (0, 1)`)
  ]
);

export const alertSourceObservations = sqliteTable(
  'alert_source_observations',
  {
    observationRef: text('observation_ref').primaryKey(),
    alertId: text('alert_id')
      .notNull()
      .references(() => alerts.id),
    recordKind: text('record_kind', { enum: alertSourceObservationRecordKinds }).notNull(),
    source: text('source', { enum: alertSourceNames }).notNull(),
    provider: text('provider').notNull(),
    sourceReference: text('source_reference').notNull(),
    sourceUrl: text('source_url').notNull(),
    sourceVersionIdentifier: text('source_version_identifier').notNull(),
    predecessorObservationRef: text('predecessor_observation_ref')
      .references((): AnySQLiteColumn => alertSourceObservations.observationRef),
    payloadFormat: text('payload_format').notNull(),
    rawPayload: text('raw_payload').notNull(),
    contentSha256: text('content_sha256').notNull(),
    publishedAt: text('published_at').notNull(),
    sourceUpdatedAt: text('source_updated_at'),
    observedAt: text('observed_at').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull()
  },
  (table) => [
    uniqueIndex('alert_source_observations_source_version_unique').on(
      table.source,
      table.sourceReference,
      table.sourceVersionIdentifier
    ),
    uniqueIndex('alert_source_observations_source_content_unique').on(
      table.source,
      table.sourceReference,
      table.contentSha256
    ),
    uniqueIndex('alert_source_observations_predecessor_unique').on(
      table.predecessorObservationRef
    ),
    index('alert_source_observations_alert_idx').on(table.alertId),
    check(
      'alert_source_observations_record_kind_check',
      sql`${table.recordKind} in ('RAW_SOURCE', 'LEGACY_SNAPSHOT')`
    ),
    check(
      'alert_source_observations_source_check',
      sql`${table.source} in ('safety_gate', 'rasff')`
    ),
    check(
      'alert_source_observations_nonblank_check',
      sql`length(trim(${table.provider})) > 0
          and length(trim(${table.sourceReference})) > 0
          and length(trim(${table.sourceUrl})) > 0
          and length(trim(${table.sourceVersionIdentifier})) > 0
          and length(trim(${table.payloadFormat})) > 0`
    ),
    check(
      'alert_source_observations_payload_size_check',
      sql`length(${table.rawPayload}) between 1 and 262144`
    ),
    check(
      'alert_source_observations_content_sha256_check',
      sql`length(${table.contentSha256}) = 64
          and ${table.contentSha256} not glob '*[^0-9a-f]*'`
    ),
    check(
      'alert_source_observations_not_self_parent_check',
      sql`${table.predecessorObservationRef} is null
          or ${table.predecessorObservationRef} <> ${table.observationRef}`
    ),
    check('alert_source_observations_demo_check', sql`${table.demo} in (0, 1)`)
  ]
);

export const alertFieldAssertions = sqliteTable(
  'alert_field_assertions',
  {
    assertionRef: text('assertion_ref').primaryKey(),
    alertId: text('alert_id')
      .notNull()
      .references(() => alerts.id),
    sourceObservationRef: text('source_observation_ref')
      .notNull()
      .references(() => alertSourceObservations.observationRef),
    fieldKind: text('field_kind', { enum: alertFieldKinds }).notNull(),
    rawValue: text('raw_value').notNull(),
    normalizedValue: text('normalized_value').notNull(),
    originKind: text('origin_kind', { enum: alertFieldAssertionOriginKinds }).notNull(),
    sourceLocator: text('source_locator'),
    producerIdentifier: text('producer_identifier').notNull(),
    producerVersion: text('producer_version').notNull(),
    modelIdentifier: text('model_identifier'),
    basisAssertionRefsJson: text('basis_assertion_refs_json').notNull(),
    supportingEvidenceRefsJson: text('supporting_evidence_refs_json').notNull(),
    humanActorIdentifier: text('human_actor_identifier'),
    rationale: text('rationale'),
    semanticDigest: text('semantic_digest').notNull(),
    createdAt: text('created_at').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull()
  },
  (table) => [
    uniqueIndex('alert_field_assertions_semantic_digest_unique').on(table.semanticDigest),
    index('alert_field_assertions_alert_observation_idx').on(
      table.alertId,
      table.sourceObservationRef
    ),
    check(
      'alert_field_assertions_field_kind_check',
      sql`${table.fieldKind} in ('PRODUCT_NAME', 'BRAND', 'EAN_GTIN', 'BATCH_LOT', 'CATEGORY')`
    ),
    check(
      'alert_field_assertions_origin_kind_check',
      sql`${table.originKind} in ('SOURCE_ASSERTED', 'DETERMINISTIC_DERIVED', 'AI_PROPOSAL', 'HUMAN_CONFIRMED', 'LEGACY_UNVERIFIED')`
    ),
    check(
      'alert_field_assertions_value_check',
      sql`length(trim(${table.rawValue})) > 0 and length(trim(${table.normalizedValue})) > 0`
    ),
    check(
      'alert_field_assertions_producer_check',
      sql`length(trim(${table.producerIdentifier})) > 0
          and length(trim(${table.producerVersion})) > 0`
    ),
    check(
      'alert_field_assertions_origin_metadata_check',
      sql`(${table.originKind} = 'SOURCE_ASSERTED'
            and ${table.sourceLocator} is not null
            and ${table.modelIdentifier} is null
            and ${table.humanActorIdentifier} is null)
          or (${table.originKind} = 'DETERMINISTIC_DERIVED'
            and (${table.sourceLocator} is not null or ${table.basisAssertionRefsJson} <> '[]')
            and ${table.modelIdentifier} is null
            and ${table.humanActorIdentifier} is null)
          or (${table.originKind} = 'AI_PROPOSAL'
            and ${table.modelIdentifier} is not null
            and ${table.humanActorIdentifier} is null)
          or (${table.originKind} = 'HUMAN_CONFIRMED'
            and ${table.modelIdentifier} is null
            and ${table.humanActorIdentifier} is not null
            and ${table.rationale} is not null
            and ${table.supportingEvidenceRefsJson} <> '[]')
          or (${table.originKind} = 'LEGACY_UNVERIFIED'
            and ${table.modelIdentifier} is null
            and ${table.humanActorIdentifier} is null)`
    ),
    check(
      'alert_field_assertions_semantic_digest_check',
      sql`length(${table.semanticDigest}) = 71
          and substr(${table.semanticDigest}, 1, 7) = 'sha256:'
          and substr(${table.semanticDigest}, 8) not glob '*[^0-9a-f]*'`
    ),
    check('alert_field_assertions_demo_check', sql`${table.demo} in (0, 1)`)
  ]
);

export const alertMatchBases = sqliteTable(
  'alert_match_bases',
  {
    matchId: text('match_id')
      .primaryKey()
      .references(() => matches.id),
    alertId: text('alert_id')
      .notNull()
      .references(() => alerts.id),
    sourceObservationRef: text('source_observation_ref')
      .notNull()
      .references(() => alertSourceObservations.observationRef),
    catalogueProductSnapshotJson: text('catalogue_product_snapshot_json').notNull(),
    matchingPolicyIdentifier: text('matching_policy_identifier').notNull(),
    matchingPolicyVersion: text('matching_policy_version').notNull(),
    discoveryAssertionRefsJson: text('discovery_assertion_refs_json').notNull(),
    authoritativeIdentityAssertionRefsJson: text('authoritative_identity_assertion_refs_json').notNull(),
    authoritativeScopeAssertionRefsJson: text('authoritative_scope_assertion_refs_json').notNull(),
    explanationOrigin: text('explanation_origin', { enum: alertMatchExplanationOrigins }).notNull(),
    explanationGeneratorIdentifier: text('explanation_generator_identifier').notNull(),
    explanationGeneratorVersion: text('explanation_generator_version').notNull(),
    explanationModelIdentifier: text('explanation_model_identifier'),
    basisDigest: text('basis_digest').notNull(),
    createdAt: text('created_at').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull()
  },
  (table) => [
    index('alert_match_bases_alert_observation_idx').on(table.alertId, table.sourceObservationRef),
    check(
      'alert_match_bases_catalogue_snapshot_check',
      sql`json_valid(${table.catalogueProductSnapshotJson})`
    ),
    check(
      'alert_match_bases_policy_check',
      sql`length(trim(${table.matchingPolicyIdentifier})) > 0
          and length(trim(${table.matchingPolicyVersion})) > 0`
    ),
    check(
      'alert_match_bases_explanation_origin_check',
      sql`${table.explanationOrigin} in ('DETERMINISTIC', 'AI_GENERATED')`
    ),
    check(
      'alert_match_bases_explanation_metadata_check',
      sql`length(trim(${table.explanationGeneratorIdentifier})) > 0
          and length(trim(${table.explanationGeneratorVersion})) > 0
          and ((${table.explanationOrigin} = 'DETERMINISTIC' and ${table.explanationModelIdentifier} is null)
            or (${table.explanationOrigin} = 'AI_GENERATED' and ${table.explanationModelIdentifier} is not null))`
    ),
    check(
      'alert_match_bases_digest_check',
      sql`length(${table.basisDigest}) = 71
          and substr(${table.basisDigest}, 1, 7) = 'sha256:'
          and substr(${table.basisDigest}, 8) not glob '*[^0-9a-f]*'`
    ),
    check('alert_match_bases_demo_check', sql`${table.demo} in (0, 1)`)
  ]
);

export const investigationEvidence = sqliteTable(
  'investigation_evidence',
  {
    evidenceRef: text('evidence_ref').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    questionRef: text('question_ref').notNull(),
    evidenceRequestId: text('evidence_request_id').references(() => evidenceRequests.id),
    sourceKind: text('source_kind', { enum: investigationEvidenceSourceKinds }).notNull(),
    sourceIdentifier: text('source_identifier').notNull(),
    receivedAt: text('received_at').notNull(),
    validAsOf: text('valid_as_of'),
    contentKind: text('content_kind', { enum: investigationEvidenceContentKinds }).notNull(),
    contentJson: text('content_json'),
    contentLocator: text('content_locator'),
    integrityHash: text('integrity_hash').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull()
  },
  (table) => [
    index('investigation_evidence_case_idx').on(table.caseId),
    check(
      'investigation_evidence_source_kind_check',
      sql`${table.sourceKind} in ('REGULATOR', 'INTERNAL', 'EXTERNAL_PARTY', 'HUMAN_OBSERVED')`
    ),
    check(
      'investigation_evidence_content_kind_check',
      sql`${table.contentKind} in ('STRUCTURED', 'LOCATOR')`
    ),
    check(
      'investigation_evidence_content_check',
      sql`(${table.contentKind} = 'STRUCTURED' and ${table.contentJson} is not null and ${table.contentLocator} is null)
          or (${table.contentKind} = 'LOCATOR' and ${table.contentJson} is null and ${table.contentLocator} is not null)`
    ),
    check(
      'investigation_evidence_integrity_hash_check',
      sql`length(${table.integrityHash}) = 64 and ${table.integrityHash} not glob '*[^0-9a-f]*'`
    ),
    check('investigation_evidence_demo_check', sql`${table.demo} in (0, 1)`)
  ]
);

export const investigationClaims = sqliteTable(
  'investigation_claims',
  {
    claimRef: text('claim_ref').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    questionRef: text('question_ref').notNull(),
    subjectRef: text('subject_ref')
      .notNull()
      .references(() => products.id),
    claimType: text('claim_type', { enum: investigationClaimTypes }).notNull(),
    valueJson: text('value_json').notNull(),
    evidenceRefsJson: text('evidence_refs_json').notNull(),
    originKind: text('origin_kind', { enum: investigationClaimOriginKinds }).notNull(),
    producerIdentifier: text('producer_identifier').notNull(),
    derivationMetadataJson: text('derivation_metadata_json'),
    supersedesClaimRef: text('supersedes_claim_ref')
      .references((): AnySQLiteColumn => investigationClaims.claimRef),
    createdAt: text('created_at').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull()
  },
  (table) => [
    index('investigation_claims_case_question_created_idx').on(
      table.caseId,
      table.questionRef,
      table.createdAt
    ),
    check(
      'investigation_claims_claim_type_check',
      sql`${table.claimType} in ('AFFECTED_BATCH_LOT')`
    ),
    check(
      'investigation_claims_origin_kind_check',
      sql`${table.originKind} in ('DETERMINISTIC_EXTRACTED', 'AI_PROPOSED', 'HUMAN_OBSERVED')`
    ),
    check('investigation_claims_demo_check', sql`${table.demo} in (0, 1)`)
  ]
);

export const investigationAssessments = sqliteTable(
  'investigation_assessments',
  {
    assessmentRef: text('assessment_ref').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    questionRef: text('question_ref').notNull(),
    targetClaimRef: text('target_claim_ref')
      .references(() => investigationClaims.claimRef),
    verdict: text('verdict', { enum: investigationAssessmentVerdicts }).notNull(),
    evidenceRefsJson: text('evidence_refs_json').notNull(),
    relatedClaimRefsJson: text('related_claim_refs_json').notNull(),
    assessorKind: text('assessor_kind', {
      enum: investigationAssessmentAssessorKinds
    }).notNull(),
    assessorIdentifier: text('assessor_identifier').notNull(),
    ruleIdentifier: text('rule_identifier'),
    ruleVersion: text('rule_version'),
    rationale: text('rationale').notNull(),
    basisCaseVersion: integer('basis_case_version').notNull(),
    supersedesAssessmentRef: text('supersedes_assessment_ref')
      .references((): AnySQLiteColumn => investigationAssessments.assessmentRef),
    createdAt: text('created_at').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull()
  },
  (table) => [
    index('investigation_assessments_case_question_created_idx').on(
      table.caseId,
      table.questionRef,
      table.createdAt
    ),
    check(
      'investigation_assessments_verdict_check',
      sql`${table.verdict} in ('SUPPORTED', 'INSUFFICIENT', 'REJECTED', 'CONTRADICTED')`
    ),
    check(
      'investigation_assessments_assessor_kind_check',
      sql`${table.assessorKind} in ('RULE', 'HUMAN', 'AI')`
    ),
    check(
      'investigation_assessments_rule_pair_check',
      sql`(${table.ruleIdentifier} is null and ${table.ruleVersion} is null)
          or (${table.ruleIdentifier} is not null and ${table.ruleVersion} is not null)`
    ),
    check(
      'investigation_assessments_rule_required_check',
      sql`${table.assessorKind} = 'HUMAN'
          or (${table.ruleIdentifier} is not null and ${table.ruleVersion} is not null)`
    ),
    check(
      'investigation_assessments_target_check',
      sql`(${table.verdict} in ('SUPPORTED', 'REJECTED') and ${table.targetClaimRef} is not null)
          or (${table.verdict} = 'INSUFFICIENT')
          or (${table.verdict} = 'CONTRADICTED' and ${table.targetClaimRef} is null)`
    ),
    check(
      'investigation_assessments_assessor_identifier_check',
      sql`length(trim(${table.assessorIdentifier})) > 0`
    ),
    check(
      'investigation_assessments_rationale_check',
      sql`length(trim(${table.rationale})) > 0`
    ),
    check(
      'investigation_assessments_basis_case_version_check',
      sql`${table.basisCaseVersion} > 0`
    ),
    check('investigation_assessments_demo_check', sql`${table.demo} in (0, 1)`)
  ]
);

export const investigationEstablishments = sqliteTable(
  'investigation_establishments',
  {
    establishmentRef: text('establishment_ref').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    questionRef: text('question_ref').notNull(),
    claimRef: text('claim_ref')
      .notNull()
      .references(() => investigationClaims.claimRef),
    policyIdentifier: text('policy_identifier').notNull(),
    policyVersion: text('policy_version').notNull(),
    basisClaimRefsJson: text('basis_claim_refs_json').notNull(),
    basisAssessmentRefsJson: text('basis_assessment_refs_json').notNull(),
    basisEvidenceRefsJson: text('basis_evidence_refs_json').notNull(),
    evaluatorKind: text('evaluator_kind', {
      enum: investigationEstablishmentEvaluatorKinds
    }).notNull(),
    evaluatorIdentifier: text('evaluator_identifier').notNull(),
    basisCaseVersion: integer('basis_case_version').notNull(),
    basisMaterialRevision: integer('basis_material_revision').notNull(),
    createdAt: text('created_at').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull()
  },
  (table) => [
    index('investigation_establishments_case_question_created_idx').on(
      table.caseId,
      table.questionRef,
      table.createdAt
    ),
    check(
      'investigation_establishments_evaluator_kind_check',
      sql`${table.evaluatorKind} = 'RULE'`
    ),
    check(
      'investigation_establishments_policy_identifier_check',
      sql`length(trim(${table.policyIdentifier})) > 0`
    ),
    check(
      'investigation_establishments_policy_version_check',
      sql`length(trim(${table.policyVersion})) > 0`
    ),
    check(
      'investigation_establishments_evaluator_identifier_check',
      sql`length(trim(${table.evaluatorIdentifier})) > 0`
    ),
    check(
      'investigation_establishments_basis_case_version_check',
      sql`${table.basisCaseVersion} > 0`
    ),
    check(
      'investigation_establishments_basis_material_revision_check',
      sql`${table.basisMaterialRevision} > 0`
    ),
    check('investigation_establishments_demo_check', sql`${table.demo} = 1`)
  ]
);

export const actionDrafts = sqliteTable(
  'action_drafts',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    type: text('type', { enum: actionTypes }).notNull(),
    recipient: text('recipient'),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status', { enum: actionStatuses }).notNull(),
    approvedBy: text('approved_by'),
    approvedAt: text('approved_at'),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    check(
      'action_drafts_type_check',
      sql`${table.type} in ('block_sale', 'notify_supplier', 'notify_customers')`
    ),
    check(
      'action_drafts_status_check',
      sql`${table.status} in ('draft', 'approved', 'simulated_sent', 'not_available')`
    )
  ]
);

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id').references(() => cases.id, { onDelete: 'cascade' }),
    alertId: text('alert_id').references(() => alerts.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    actorType: text('actor_type').notNull(),
    actorName: text('actor_name').notNull(),
    summary: text('summary').notNull(),
    metadataJson: text('metadata_json').notNull(),
    createdAt: text('created_at').notNull()
  },
  (table) => [index('audit_events_case_id_idx').on(table.caseId)]
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type Purchase = typeof purchases.$inferSelect;
export type NewPurchase = typeof purchases.$inferInsert;
export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;

// Versioned block B state is separate from the legacy checklist projection.
export const caseLifecycle = sqliteTable('case_lifecycle', {
  caseId: text('case_id').primaryKey().references(() => cases.id, { onDelete: 'cascade' }),
  productId: text('product_id').notNull().references(() => products.id),
  caseVersion: integer('case_version').notNull(),
  materialRevision: integer('material_revision'),
  snapshotJson: text('snapshot_json').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [
  check('case_lifecycle_version_check', sql`${table.caseVersion} > 0`),
  check('case_lifecycle_revision_check', sql`${table.materialRevision} is null or ${table.materialRevision} > 0`)
]);

export const caseRevisions = sqliteTable('case_revisions', {
  id: text('id').primaryKey(),
  caseId: text('case_id').notNull().references(() => caseLifecycle.caseId, { onDelete: 'cascade' }),
  caseVersion: integer('case_version').notNull(),
  materialRevision: integer('material_revision'),
  snapshotJson: text('snapshot_json').notNull(),
  actorId: text('actor_id').notNull(),
  createdAt: text('created_at').notNull()
}, (table) => [
  uniqueIndex('case_revisions_version_unique').on(table.caseId, table.caseVersion),
  index('case_revisions_material_idx').on(table.caseId, table.materialRevision)
]);

export const investigationChallenges = sqliteTable(
  'investigation_challenges',
  {
    challengeRef: text('challenge_ref').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    questionRef: text('question_ref')
      .notNull()
      .references(() => investigationQuestions.questionRef),
    challengedRevisionId: text('challenged_revision_id')
      .notNull()
      .references(() => caseRevisions.id),
    challengedMaterialRevision: integer('challenged_material_revision').notNull(),
    openedCaseVersion: integer('opened_case_version').notNull(),
    triggerEvidenceRefsJson: text('trigger_evidence_refs_json').notNull(),
    openedByKind: text('opened_by_kind', {
      enum: investigationChallengeOpenedByKinds
    }).notNull(),
    openedByIdentifier: text('opened_by_identifier').notNull(),
    rationale: text('rationale').notNull(),
    createdAt: text('created_at').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull()
  },
  (table) => [
    uniqueIndex('investigation_challenges_case_question_material_unique').on(
      table.caseId,
      table.questionRef,
      table.challengedMaterialRevision
    ),
    index('investigation_challenges_case_question_created_idx').on(
      table.caseId,
      table.questionRef,
      table.createdAt
    ),
    check(
      'investigation_challenges_material_revision_check',
      sql`${table.challengedMaterialRevision} > 0`
    ),
    check(
      'investigation_challenges_opened_case_version_check',
      sql`${table.openedCaseVersion} > 0`
    ),
    check(
      'investigation_challenges_opened_by_kind_check',
      sql`${table.openedByKind} = 'HUMAN'`
    ),
    check(
      'investigation_challenges_opened_by_identifier_check',
      sql`length(trim(${table.openedByIdentifier})) > 0`
    ),
    check(
      'investigation_challenges_rationale_check',
      sql`length(trim(${table.rationale})) > 0`
    ),
    check('investigation_challenges_demo_check', sql`${table.demo} = 1`)
  ]
);

export const investigationChallengeRequests = sqliteTable(
  'investigation_challenge_requests',
  {
    requestId: text('request_id')
      .primaryKey()
      .references(() => evidenceRequests.id),
    challengeRef: text('challenge_ref')
      .notNull()
      .references(() => investigationChallenges.challengeRef)
  },
  (table) => [
    index('investigation_challenge_requests_challenge_idx').on(table.challengeRef)
  ]
);

export const investigationChallengeClaims = sqliteTable(
  'investigation_challenge_claims',
  {
    claimRef: text('claim_ref')
      .primaryKey()
      .references(() => investigationClaims.claimRef),
    challengeRef: text('challenge_ref')
      .notNull()
      .references(() => investigationChallenges.challengeRef)
  },
  (table) => [
    index('investigation_challenge_claims_challenge_idx').on(table.challengeRef)
  ]
);

export const investigationChallengeAssessments = sqliteTable(
  'investigation_challenge_assessments',
  {
    assessmentRef: text('assessment_ref')
      .primaryKey()
      .references(() => investigationAssessments.assessmentRef),
    challengeRef: text('challenge_ref')
      .notNull()
      .references(() => investigationChallenges.challengeRef)
  },
  (table) => [
    index('investigation_challenge_assessments_challenge_idx').on(table.challengeRef)
  ]
);

export const investigationChallengeEstablishments = sqliteTable(
  'investigation_challenge_establishments',
  {
    establishmentRef: text('establishment_ref')
      .primaryKey()
      .references(() => investigationEstablishments.establishmentRef),
    challengeRef: text('challenge_ref')
      .notNull()
      .references(() => investigationChallenges.challengeRef)
  },
  (table) => [
    index('investigation_challenge_establishments_challenge_idx').on(table.challengeRef)
  ]
);

export const investigationChallengeConflictApplications = sqliteTable(
  'investigation_challenge_conflict_applications',
  {
    applicationRef: text('application_ref').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    questionRef: text('question_ref')
      .notNull()
      .references(() => investigationQuestions.questionRef),
    challengeRef: text('challenge_ref')
      .notNull()
      .references(() => investigationChallenges.challengeRef),
    policyIdentifier: text('policy_identifier').notNull(),
    policyVersion: text('policy_version').notNull(),
    basisFormatVersion: text('basis_format_version').notNull(),
    basisDigest: text('basis_digest').notNull(),
    reviewedClaimRefsJson: text('reviewed_claim_refs_json').notNull(),
    reviewedAssessmentRefsJson: text('reviewed_assessment_refs_json').notNull(),
    completeEvidenceRefsJson: text('complete_evidence_refs_json').notNull(),
    appliedClaimRefsJson: text('applied_claim_refs_json').notNull(),
    appliedAssessmentRefsJson: text('applied_assessment_refs_json').notNull(),
    appliedEvidenceRefsJson: text('applied_evidence_refs_json').notNull(),
    sourceRevisionId: text('source_revision_id')
      .notNull()
      .references(() => caseRevisions.id),
    sourceCaseVersion: integer('source_case_version').notNull(),
    sourceMaterialRevision: integer('source_material_revision').notNull(),
    resultingRevisionId: text('resulting_revision_id')
      .notNull()
      .references(() => caseRevisions.id),
    resultingCaseVersion: integer('resulting_case_version').notNull(),
    resultingMaterialRevision: integer('resulting_material_revision').notNull(),
    actorKind: text('actor_kind', {
      enum: investigationChallengeConflictApplicationActorKinds
    }).notNull(),
    actorIdentifier: text('actor_identifier').notNull(),
    rationale: text('rationale').notNull(),
    createdAt: text('created_at').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull()
  },
  (table) => [
    uniqueIndex('investigation_challenge_conflict_applications_challenge_unique')
      .on(table.challengeRef),
    uniqueIndex('investigation_challenge_conflict_applications_result_revision_unique')
      .on(table.resultingRevisionId),
    index('investigation_challenge_conflict_applications_case_question_created_idx')
      .on(table.caseId, table.questionRef, table.createdAt),
    check(
      'investigation_challenge_conflict_applications_source_case_version_check',
      sql`${table.sourceCaseVersion} > 0`
    ),
    check(
      'investigation_challenge_conflict_applications_source_material_revision_check',
      sql`${table.sourceMaterialRevision} > 0`
    ),
    check(
      'investigation_challenge_conflict_applications_resulting_case_version_check',
      sql`${table.resultingCaseVersion} > 0`
    ),
    check(
      'investigation_challenge_conflict_applications_resulting_material_revision_check',
      sql`${table.resultingMaterialRevision} > 0`
    ),
    check(
      'investigation_challenge_conflict_applications_case_version_step_check',
      sql`${table.resultingCaseVersion} = ${table.sourceCaseVersion} + 1`
    ),
    check(
      'investigation_challenge_conflict_applications_material_revision_step_check',
      sql`${table.resultingMaterialRevision} = ${table.sourceMaterialRevision} + 1`
    ),
    check(
      'investigation_challenge_conflict_applications_actor_kind_check',
      sql`${table.actorKind} = 'HUMAN'`
    ),
    check(
      'investigation_challenge_conflict_applications_actor_identifier_check',
      sql`length(trim(${table.actorIdentifier})) > 0`
    ),
    check(
      'investigation_challenge_conflict_applications_rationale_check',
      sql`length(trim(${table.rationale})) > 0`
    ),
    check(
      'investigation_challenge_conflict_applications_policy_identifier_check',
      sql`length(trim(${table.policyIdentifier})) > 0`
    ),
    check(
      'investigation_challenge_conflict_applications_policy_version_check',
      sql`length(trim(${table.policyVersion})) > 0`
    ),
    check(
      'investigation_challenge_conflict_applications_basis_format_version_check',
      sql`length(trim(${table.basisFormatVersion})) > 0`
    ),
    check(
      'investigation_challenge_conflict_applications_basis_digest_check',
      sql`length(${table.basisDigest}) = 71
          and substr(${table.basisDigest}, 1, 7) = 'sha256:'
          and substr(${table.basisDigest}, 8) not glob '*[^0-9a-f]*'`
    ),
    check(
      'investigation_challenge_conflict_applications_demo_check',
      sql`${table.demo} = 1`
    )
  ]
);

export const investigationChallengeBatchApplications = sqliteTable(
  'investigation_challenge_batch_applications',
  {
    applicationRef: text('application_ref').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    questionRef: text('question_ref')
      .notNull()
      .references(() => investigationQuestions.questionRef),
    challengeRef: text('challenge_ref')
      .notNull()
      .references(() => investigationChallenges.challengeRef),
    establishmentRef: text('establishment_ref')
      .notNull()
      .references(() => investigationChallengeEstablishments.establishmentRef),
    claimRef: text('claim_ref')
      .notNull()
      .references(() => investigationClaims.claimRef),
    applicationPolicyIdentifier: text('application_policy_identifier').notNull(),
    applicationPolicyVersion: text('application_policy_version').notNull(),
    basisFormatVersion: text('basis_format_version').notNull(),
    basisDigest: text('basis_digest').notNull(),
    reviewedClaimRefsJson: text('reviewed_claim_refs_json').notNull(),
    reviewedAssessmentRefsJson: text('reviewed_assessment_refs_json').notNull(),
    reviewedEvidenceRefsJson: text('reviewed_evidence_refs_json').notNull(),
    appliedAssessmentRefsJson: text('applied_assessment_refs_json').notNull(),
    appliedEvidenceRefsJson: text('applied_evidence_refs_json').notNull(),
    appliedLot: text('applied_lot').notNull(),
    resultBaselineClaimRefsJson: text('result_baseline_claim_refs_json').notNull(),
    resultBaselineAssessmentRefsJson: text('result_baseline_assessment_refs_json').notNull(),
    resultBaselineEvidenceRefsJson: text('result_baseline_evidence_refs_json').notNull(),
    sourceRevisionId: text('source_revision_id')
      .notNull()
      .references(() => caseRevisions.id),
    sourceCaseVersion: integer('source_case_version').notNull(),
    sourceMaterialRevision: integer('source_material_revision').notNull(),
    resultingRevisionId: text('resulting_revision_id')
      .notNull()
      .references(() => caseRevisions.id),
    resultingCaseVersion: integer('resulting_case_version').notNull(),
    resultingMaterialRevision: integer('resulting_material_revision').notNull(),
    actorKind: text('actor_kind', {
      enum: investigationChallengeBatchApplicationActorKinds
    }).notNull(),
    actorIdentifier: text('actor_identifier').notNull(),
    rationale: text('rationale').notNull(),
    createdAt: text('created_at').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull()
  },
  (table) => [
    uniqueIndex('investigation_challenge_batch_applications_challenge_unique')
      .on(table.challengeRef),
    uniqueIndex('investigation_challenge_batch_applications_establishment_unique')
      .on(table.establishmentRef),
    uniqueIndex('investigation_challenge_batch_applications_result_revision_unique')
      .on(table.resultingRevisionId),
    index('investigation_challenge_batch_applications_case_question_created_idx')
      .on(table.caseId, table.questionRef, table.createdAt),
    check(
      'investigation_challenge_batch_applications_source_case_version_check',
      sql`${table.sourceCaseVersion} > 0`
    ),
    check(
      'investigation_challenge_batch_applications_source_material_revision_check',
      sql`${table.sourceMaterialRevision} > 0`
    ),
    check(
      'investigation_challenge_batch_applications_resulting_case_version_check',
      sql`${table.resultingCaseVersion} > 0`
    ),
    check(
      'investigation_challenge_batch_applications_resulting_material_revision_check',
      sql`${table.resultingMaterialRevision} > 0`
    ),
    check(
      'investigation_challenge_batch_applications_case_version_step_check',
      sql`${table.resultingCaseVersion} = ${table.sourceCaseVersion} + 1`
    ),
    check(
      'investigation_challenge_batch_applications_material_revision_step_check',
      sql`${table.resultingMaterialRevision} = ${table.sourceMaterialRevision} + 1`
    ),
    check(
      'investigation_challenge_batch_applications_actor_kind_check',
      sql`${table.actorKind} = 'HUMAN'`
    ),
    check(
      'investigation_challenge_batch_applications_actor_identifier_check',
      sql`length(trim(${table.actorIdentifier})) > 0`
    ),
    check(
      'investigation_challenge_batch_applications_rationale_check',
      sql`length(trim(${table.rationale})) > 0`
    ),
    check(
      'investigation_challenge_batch_applications_policy_identifier_check',
      sql`length(trim(${table.applicationPolicyIdentifier})) > 0`
    ),
    check(
      'investigation_challenge_batch_applications_policy_version_check',
      sql`length(trim(${table.applicationPolicyVersion})) > 0`
    ),
    check(
      'investigation_challenge_batch_applications_basis_format_version_check',
      sql`length(trim(${table.basisFormatVersion})) > 0`
    ),
    check(
      'investigation_challenge_batch_applications_basis_digest_check',
      sql`length(${table.basisDigest}) = 71
          and substr(${table.basisDigest}, 1, 7) = 'sha256:'
          and substr(${table.basisDigest}, 8) not glob '*[^0-9a-f]*'`
    ),
    check(
      'investigation_challenge_batch_applications_applied_lot_check',
      sql`length(trim(${table.appliedLot})) > 0`
    ),
    check(
      'investigation_challenge_batch_applications_demo_check',
      sql`${table.demo} = 1`
    )
  ]
);

export const investigationEstablishedBatchApplications = sqliteTable(
  'investigation_established_batch_applications',
  {
    applicationRef: text('application_ref').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    questionRef: text('question_ref')
      .notNull()
      .references(() => investigationQuestions.questionRef),
    establishmentRef: text('establishment_ref')
      .notNull()
      .references(() => investigationEstablishments.establishmentRef),
    claimRef: text('claim_ref')
      .notNull()
      .references(() => investigationClaims.claimRef),
    applicationPolicyIdentifier: text('application_policy_identifier').notNull(),
    applicationPolicyVersion: text('application_policy_version').notNull(),
    basisFormatVersion: text('basis_format_version').notNull(),
    basisDigest: text('basis_digest').notNull(),
    reviewedClaimRefsJson: text('reviewed_claim_refs_json').notNull(),
    reviewedAssessmentRefsJson: text('reviewed_assessment_refs_json').notNull(),
    reviewedEvidenceRefsJson: text('reviewed_evidence_refs_json').notNull(),
    appliedEvidenceRefsJson: text('applied_evidence_refs_json').notNull(),
    appliedLot: text('applied_lot').notNull(),
    sourceRevisionId: text('source_revision_id')
      .notNull()
      .references(() => caseRevisions.id),
    sourceCaseVersion: integer('source_case_version').notNull(),
    sourceMaterialRevision: integer('source_material_revision').notNull(),
    resultingRevisionId: text('resulting_revision_id')
      .notNull()
      .references(() => caseRevisions.id),
    resultingCaseVersion: integer('resulting_case_version').notNull(),
    resultingMaterialRevision: integer('resulting_material_revision').notNull(),
    actorKind: text('actor_kind', {
      enum: investigationEstablishedBatchApplicationActorKinds
    }).notNull(),
    actorIdentifier: text('actor_identifier').notNull(),
    rationale: text('rationale').notNull(),
    createdAt: text('created_at').notNull(),
    demo: integer('demo', { mode: 'boolean' }).notNull()
  },
  (table) => [
    uniqueIndex('investigation_established_batch_applications_establishment_unique')
      .on(table.establishmentRef),
    uniqueIndex('investigation_established_batch_applications_result_revision_unique')
      .on(table.resultingRevisionId),
    index('investigation_established_batch_applications_case_question_created_idx')
      .on(table.caseId, table.questionRef, table.createdAt),
    check(
      'investigation_established_batch_applications_source_case_version_check',
      sql`${table.sourceCaseVersion} > 0`
    ),
    check(
      'investigation_established_batch_applications_source_material_revision_check',
      sql`${table.sourceMaterialRevision} > 0`
    ),
    check(
      'investigation_established_batch_applications_resulting_case_version_check',
      sql`${table.resultingCaseVersion} > 0`
    ),
    check(
      'investigation_established_batch_applications_resulting_material_revision_check',
      sql`${table.resultingMaterialRevision} > 0`
    ),
    check(
      'investigation_established_batch_applications_case_version_step_check',
      sql`${table.resultingCaseVersion} = ${table.sourceCaseVersion} + 1`
    ),
    check(
      'investigation_established_batch_applications_material_revision_step_check',
      sql`${table.resultingMaterialRevision} = ${table.sourceMaterialRevision} + 1`
    ),
    check(
      'investigation_established_batch_applications_actor_kind_check',
      sql`${table.actorKind} = 'HUMAN'`
    ),
    check(
      'investigation_established_batch_applications_actor_identifier_check',
      sql`length(trim(${table.actorIdentifier})) > 0`
    ),
    check(
      'investigation_established_batch_applications_rationale_check',
      sql`length(trim(${table.rationale})) > 0`
    ),
    check(
      'investigation_established_batch_applications_policy_identifier_check',
      sql`length(trim(${table.applicationPolicyIdentifier})) > 0`
    ),
    check(
      'investigation_established_batch_applications_policy_version_check',
      sql`length(trim(${table.applicationPolicyVersion})) > 0`
    ),
    check(
      'investigation_established_batch_applications_basis_format_version_check',
      sql`length(trim(${table.basisFormatVersion})) > 0`
    ),
    check(
      'investigation_established_batch_applications_basis_digest_check',
      sql`length(${table.basisDigest}) = 71
          and substr(${table.basisDigest}, 1, 7) = 'sha256:'
          and substr(${table.basisDigest}, 8) not glob '*[^0-9a-f]*'`
    ),
    check(
      'investigation_established_batch_applications_applied_lot_check',
      sql`length(trim(${table.appliedLot})) > 0`
    ),
    check(
      'investigation_established_batch_applications_demo_check',
      sql`${table.demo} = 1`
    )
  ]
);

export const caseCommands = sqliteTable('case_commands', {
  id: text('id').primaryKey(),
  caseId: text('case_id').notNull().references(() => caseLifecycle.caseId, { onDelete: 'cascade' }),
  commandId: text('command_id').notNull(),
  payloadJson: text('payload_json').notNull(),
  appliedCaseVersion: integer('applied_case_version').notNull(),
  createdAt: text('created_at').notNull()
}, (table) => [uniqueIndex('case_commands_key_unique').on(table.caseId, table.commandId)]);

export const traceabilityRecords = sqliteTable('traceability_records', {
  id: text('id').primaryKey(),
  caseId: text('case_id').notNull().references(() => caseLifecycle.caseId, { onDelete: 'cascade' }),
  sourceRef: text('source_ref').notNull(),
  recordType: text('record_type').notNull(),
  payloadJson: text('payload_json').notNull(),
  occurredAt: text('occurred_at').notNull(),
  createdAt: text('created_at').notNull()
}, (table) => [
  uniqueIndex('traceability_records_source_unique').on(table.caseId, table.sourceRef),
  index('traceability_records_case_idx').on(table.caseId)
]);
