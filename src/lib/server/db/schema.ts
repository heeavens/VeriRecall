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
