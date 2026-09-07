import { z } from 'zod';

export const CONTRACT_SCHEMA_VERSION = 1 as const;
const id = z.string().uuid();
const text = z.string().trim().min(1);
const timestamp = z.string().datetime();
const revision = z.number().int().positive();
const refs = z.array(text).refine((values) => new Set(values).size === values.length, 'Duplicate references');
export const knowledgeStatusSchema = z.enum(['KNOWN', 'UNKNOWN', 'PENDING', 'CONFLICTED', 'UNRESOLVED']);
export const taskStatusSchema = z.enum(['OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED', 'SUPERSEDED']);
export const humanDecisionStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'STALE']);
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type HumanDecisionStatus = z.infer<typeof humanDecisionStatusSchema>;

const traceabilityFields = {
  sourceRef: text,
  productId: id,
  lot: text.nullable(),
  occurredAt: timestamp,
  demo: z.boolean()
};
const traceabilityQuantity = z.number().int().nonnegative();
export const traceabilityRecordSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...traceabilityFields, type: z.literal('RECEIPT'), receiptRef: text, quantity: traceabilityQuantity }),
  z.strictObject({ ...traceabilityFields, type: z.literal('INVENTORY'), locationRef: text, quantity: traceabilityQuantity }),
  z.strictObject({ ...traceabilityFields, type: z.literal('SHIPMENT'), shipmentRef: text, destinationRef: text,
    quantity: traceabilityQuantity, status: z.enum(['IN_TRANSIT', 'DELIVERED', 'RETURNED']) }),
  z.strictObject({ ...traceabilityFields, type: z.literal('RETAILER_RESPONSE'), retailerRef: text, quantity: traceabilityQuantity }),
  z.strictObject({ ...traceabilityFields, type: z.literal('SALE'), saleRef: text, quantity: traceabilityQuantity }),
  z.strictObject({ ...traceabilityFields, type: z.literal('CONTAINMENT'), locationRef: text, quantity: traceabilityQuantity })
]);
export type TraceabilityRecord = z.infer<typeof traceabilityRecordSchema>;

export const issueSchema = z.strictObject({
  id: text,
  code: text,
  message: text,
  critical: z.boolean(),
  subjectRefs: refs.min(1),
  evidenceRefs: refs
});

const findingFields = {
  knowledgeStatus: knowledgeStatusSchema,
  evidenceRefs: refs,
  decisionRefs: refs
};
export const identitySchema = z.strictObject({
  ...findingFields,
  conclusion: z.enum(['MATCH', 'NO_MATCH', 'UNRESOLVED'])
}).superRefine((value, context) => {
  if (value.knowledgeStatus === 'KNOWN' && (value.conclusion === 'UNRESOLVED' || !value.evidenceRefs.length)) {
    context.addIssue({ code: 'custom', message: 'Known identity requires a conclusion and evidence' });
  }
  if (value.knowledgeStatus !== 'KNOWN' && value.conclusion !== 'UNRESOLVED') {
    context.addIssue({ code: 'custom', message: 'Uncertain identity cannot assert a factual match' });
  }
});
export const scopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...findingFields,
    kind: z.literal('BATCH_LOT'),
    lots: refs.min(1)
  }),
  z.strictObject({
    ...findingFields,
    knowledgeStatus: z.enum(['UNKNOWN', 'PENDING', 'CONFLICTED', 'UNRESOLVED']),
    kind: z.literal('UNRESOLVED'),
    reason: text
  })
]).superRefine((value, context) => {
  if (value.knowledgeStatus === 'KNOWN' && !value.evidenceRefs.length) {
    context.addIssue({ code: 'custom', message: 'Known scope requires evidence' });
  }
});

export const investigationOutcomeSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  caseId: id,
  productId: id,
  materialRevision: revision,
  updatedAt: timestamp,
  knowledgeStatus: knowledgeStatusSchema,
  identity: identitySchema,
  scope: scopeSchema,
  evidenceRefs: refs,
  decisionRefs: refs,
  gaps: z.array(issueSchema),
  conflicts: z.array(issueSchema),
  demo: z.boolean()
}).superRefine((value, context) => {
  if (value.knowledgeStatus === 'KNOWN' && (
    value.identity.knowledgeStatus !== 'KNOWN' || value.scope.knowledgeStatus !== 'KNOWN' ||
    value.gaps.length || value.conflicts.length
  )) {
    context.addIssue({ code: 'custom', message: 'Known outcome cannot hide uncertainty or conflicts' });
  }
  if (value.conflicts.length && value.knowledgeStatus !== 'CONFLICTED') {
    context.addIssue({ code: 'custom', message: 'Conflicts require CONFLICTED outcome status' });
  }
  for (const finding of [value.identity, value.scope]) {
    if (finding.evidenceRefs.some((ref) => !value.evidenceRefs.includes(ref)) ||
        finding.decisionRefs.some((ref) => !value.decisionRefs.includes(ref))) {
      context.addIssue({ code: 'custom', message: 'Finding references must be included in outcome references' });
    }
  }
});
export type InvestigationOutcome = z.infer<typeof investigationOutcomeSchema>;

export const sourceSchema = z.strictObject({
  sourceRef: text,
  sourceType: z.enum(['RECEIPT', 'INVENTORY', 'SHIPMENT', 'RETAILER_RESPONSE', 'SALE', 'CONTAINMENT', 'DERIVED']),
  asOf: timestamp,
  demo: z.boolean()
});
export const quantitySchema = z.strictObject({
  value: z.number().int().nonnegative().nullable(),
  unit: z.literal('ITEM'),
  knowledgeStatus: knowledgeStatusSchema,
  sources: z.array(sourceSchema),
  asOf: timestamp.nullable()
}).superRefine((value, context) => {
  if (value.knowledgeStatus === 'KNOWN') {
    if (value.value === null || !value.sources.length || value.asOf === null) {
      context.addIssue({ code: 'custom', message: 'Known quantity requires value, sources and asOf' });
    }
  } else if (value.value !== null) {
    context.addIssue({ code: 'custom', message: 'Uncertain quantity must use null, never zero or an asserted total' });
  }
});
export const exposureSchema = z.strictObject({
  status: z.enum(['NOT_CALCULATED', 'CALCULATED']),
  basisMaterialRevision: revision.nullable(),
  calculatedAt: timestamp.nullable(),
  received: quantitySchema,
  warehouse: quantitySchema,
  inTransit: quantitySchema,
  retailer: quantitySchema,
  sold: quantitySchema,
  unaccounted: quantitySchema,
  contained: quantitySchema,
  gaps: z.array(issueSchema),
  conflicts: z.array(issueSchema)
}).superRefine((value, context) => {
  const quantities = [value.received, value.warehouse, value.inTransit, value.retailer, value.sold, value.unaccounted, value.contained];
  if (value.status === 'NOT_CALCULATED' && (value.calculatedAt !== null ||
      value.basisMaterialRevision !== null || quantities.some((q) => q.value !== null))) {
    context.addIssue({ code: 'custom', message: 'Uncalculated exposure cannot assert quantities or a calculation basis' });
  }
  if (value.status === 'CALCULATED' && (value.calculatedAt === null || value.basisMaterialRevision === null)) {
    context.addIssue({ code: 'custom', message: 'Calculated exposure requires timestamp and revision' });
  }
});

export const taskSchema = z.strictObject({
  id: id,
  rule: z.enum(['HOLD_STOCK', 'INTERCEPT_SHIPMENT', 'REQUEST_RETAILER_CONFIRMATION', 'INVESTIGATE_TRACEABILITY_GAP', 'PREPARE_COMMUNICATION']),
  status: taskStatusSchema,
  title: text,
  targetRef: text,
  coverage: scopeSchema,
  quantity: quantitySchema,
  basisMaterialRevision: revision,
  reasonRefs: refs.min(1),
  blockedBy: refs,
  priority: z.enum(['CRITICAL', 'HIGH', 'NORMAL']),
  priorityReason: text,
  approvalRequired: z.boolean(),
  decisionRefs: refs,
  resultEvidenceRefs: refs,
  requestStatus: z.enum(['NOT_REQUESTED', 'REQUESTED']),
  demo: z.boolean()
}).superRefine((value, context) => {
  if (value.status === 'COMPLETED' && !value.resultEvidenceRefs.length) {
    context.addIssue({ code: 'custom', message: 'Completion requires result evidence; a request is insufficient' });
  }
});
export const humanDecisionSchema = z.strictObject({
  id: id,
  type: z.enum(['CONFIRM_IDENTITY', 'CONFIRM_SCOPE', 'APPROVE_ACTION', 'CLOSE_CASE']),
  status: humanDecisionStatusSchema,
  subjectRef: text,
  basisCaseVersion: revision,
  basisMaterialRevision: revision,
  coverage: scopeSchema,
  evidenceRefs: refs,
  rationale: text,
  actorId: text.nullable(),
  decidedAt: timestamp.nullable(),
  demo: z.boolean()
}).superRefine((value, context) => {
  if (value.status === 'PENDING' ? value.actorId !== null || value.decidedAt !== null :
      value.actorId === null || value.decidedAt === null) {
    context.addIssue({ code: 'custom', message: 'Pending decisions have no actor/time; recorded decisions require both' });
  }
});
const blockerSchema = issueSchema.extend({
  code: z.enum(['INVESTIGATION_UNRESOLVED', 'SCOPE_UNCONFIRMED', 'EXPOSURE_NOT_CALCULATED', 'EXPOSURE_STALE', 'CRITICAL_TASK_PENDING', 'ACTIVE_TRANSIT', 'TRACEABILITY_GAP', 'QUANTITY_CONFLICT', 'EVIDENCE_MISSING', 'APPROVAL_STALE'])
});
export const closureSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('NOT_READY'), blockers: z.array(blockerSchema).min(1), decisionRef: z.null() }),
  z.strictObject({ status: z.literal('READY_FOR_HUMAN_CLOSURE'), blockers: z.array(blockerSchema).length(0), decisionRef: z.null() }),
  z.strictObject({ status: z.literal('CLOSED'), blockers: z.array(blockerSchema).length(0), decisionRef: text })
]);
export const caseSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  caseId: id,
  productId: id,
  caseVersion: revision,
  materialRevision: revision.nullable(),
  stage: z.enum(['INVESTIGATING', 'RESPONDING', 'CONTAINED', 'CLOSURE_REVIEW', 'CLOSED']),
  updatedAt: timestamp,
  investigation: investigationOutcomeSchema.nullable(),
  exposure: exposureSchema,
  tasks: z.array(taskSchema),
  uncertainties: z.array(issueSchema),
  conflicts: z.array(issueSchema),
  attentionItems: z.array(issueSchema),
  pendingDecisions: z.array(humanDecisionSchema),
  closure: closureSchema,
  demo: z.boolean()
}).superRefine((value, context) => {
  const outcome = value.investigation;
  if (outcome ? outcome.caseId !== value.caseId || outcome.productId !== value.productId ||
      outcome.materialRevision !== value.materialRevision : value.materialRevision !== null) {
    context.addIssue({ code: 'custom', message: 'Snapshot must reference its own investigation and revision' });
  }
  if (value.pendingDecisions.some((decision) => decision.status !== 'PENDING')) {
    context.addIssue({ code: 'custom', message: 'pendingDecisions may contain only pending records' });
  }
  if ((value.stage === 'CLOSED') !== (value.closure.status === 'CLOSED')) {
    context.addIssue({ code: 'custom', message: 'Closed stage and closure result must agree' });
  }
  if (value.closure.status !== 'NOT_READY' && (
    !outcome || outcome.knowledgeStatus !== 'KNOWN' || outcome.identity.conclusion !== 'MATCH' ||
    !outcome.identity.decisionRefs.length || !outcome.scope.decisionRefs.length ||
    value.exposure.status !== 'CALCULATED' || value.exposure.basisMaterialRevision !== value.materialRevision ||
    value.uncertainties.some((issue) => issue.critical) || value.conflicts.length ||
    value.exposure.gaps.some((issue) => issue.critical) || value.exposure.conflicts.length ||
    value.exposure.inTransit.value !== 0 || value.exposure.unaccounted.value !== 0 ||
    value.tasks.some((task) => task.priority === 'CRITICAL' && !['COMPLETED', 'CANCELLED', 'SUPERSEDED'].includes(task.status))
  )) {
    context.addIssue({ code: 'custom', message: 'Closure cannot claim readiness with unresolved or stale prerequisites' });
  }
});
export type CaseSnapshot = z.infer<typeof caseSnapshotSchema>;

const mutationFields = {
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  caseId: id,
  commandId: id,
  expectedCaseVersion: z.number().int().nonnegative()
};
export const recallCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...mutationFields, type: z.literal('ACCEPT_INVESTIGATION'), outcome: investigationOutcomeSchema }),
  z.strictObject({ ...mutationFields, type: z.literal('CALCULATE_EXPOSURE'), records: z.array(traceabilityRecordSchema).min(1)
    .refine((records) => new Set(records.map((record) => record.sourceRef)).size === records.length, 'Duplicate source references') }),
  z.strictObject({ ...mutationFields, type: z.literal('DECIDE_ACTION'), taskId: id, decision: z.enum(['APPROVED', 'REJECTED']), rationale: text, evidenceRefs: refs }),
  z.strictObject({ ...mutationFields, type: z.literal('ATTACH_RESULT'), taskId: id, evidenceRefs: refs.min(1), summary: text, demo: z.boolean() }),
  z.strictObject({ ...mutationFields, type: z.literal('REQUEST_CLOSURE'), rationale: text, evidenceRefs: refs.min(1) })
]).superRefine((value, context) => {
  if (value.type === 'ACCEPT_INVESTIGATION' && value.caseId !== value.outcome.caseId) {
    context.addIssue({ code: 'custom', message: 'Command and outcome caseId must agree' });
  }
  if (value.type !== 'ACCEPT_INVESTIGATION' && value.expectedCaseVersion === 0) {
    context.addIssue({ code: 'custom', message: 'Only initial ingestion may expect version zero' });
  }
});
export const getSnapshotQuerySchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION), caseId: id
});
export type RecallCommand = z.infer<typeof recallCommandSchema>;
export type GetSnapshotQuery = z.infer<typeof getSnapshotQuerySchema>;
export const contractErrorSchema = z.strictObject({
  code: z.enum(['INVALID_INPUT', 'UNSUPPORTED_SCHEMA_VERSION', 'UNSUPPORTED_SCOPE', 'NOT_FOUND', 'FORBIDDEN', 'VERSION_CONFLICT', 'STALE_INVESTIGATION', 'IDEMPOTENCY_CONFLICT', 'INVALID_STATE', 'EVIDENCE_REQUIRED', 'CLOSURE_BLOCKED', 'NOT_IMPLEMENTED']),
  message: text,
  currentCaseVersion: revision.nullable(),
  issueRefs: refs
});
export const commandResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), commandId: id, replayed: z.boolean(), appliedCaseVersion: revision, snapshot: caseSnapshotSchema }),
  z.strictObject({ ok: z.literal(false), error: contractErrorSchema })
]);
export const snapshotResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), snapshot: caseSnapshotSchema }),
  z.strictObject({ ok: z.literal(false), error: contractErrorSchema })
]);
export type ContractError = z.infer<typeof contractErrorSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type SnapshotResult = z.infer<typeof snapshotResultSchema>;

// Contract only: implementations must authenticate and transact on the server.
export interface RecallService {
  execute(command: RecallCommand): Promise<CommandResult>;
  getSnapshot(query: GetSnapshotQuery): Promise<SnapshotResult>;
}
