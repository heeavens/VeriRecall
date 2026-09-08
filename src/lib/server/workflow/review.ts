import { randomUUID } from 'node:crypto';

import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { produceInvestigationOutcome } from '../investigation/outcome-producer';
import { assessHarm, type HarmAssessment } from '../risk/harm';
import { applyConfirmedReviewOutcomeInTransaction, readCaseSnapshot, type LifecycleContext } from './case-lifecycle';
import { nextCaseNumber, severityForRisk } from './case-record';
import { ensureCaseResponseRecords } from './case-setup';
import { hasCaseLifecycle } from './lifecycle-boundary';

export const evidenceTypes = [
  'barcode_photo',
  'supplier_invoice',
  'batch_label_photo'
] as const;

export type EvidenceType = (typeof evidenceTypes)[number];

export interface ReviewQueueItem {
  alertId: string;
  matchId: string;
  source: (typeof schema.alerts.$inferSelect)['source'];
  sourceReference: string;
  productName: string;
  risk: string;
  candidateName: string;
  candidateSku: string;
  totalScore: number;
  hasHardConflict: boolean;
  isHighConfidence: boolean;
  harm: HarmAssessment;
  status: (typeof schema.matches.$inferSelect)['status'];
}

export interface ReviewSignal {
  label: string;
  detail: string;
  earned: number;
  maximum: number;
  tone: 'positive' | 'conflict' | 'missing' | 'weak';
}

export interface ReviewMatchView {
  alert: typeof schema.alerts.$inferSelect;
  match: typeof schema.matches.$inferSelect;
  product: typeof schema.products.$inferSelect;
  threshold: number;
  isHighConfidence: boolean;
  harm: HarmAssessment;
  affectedPurchaseCount: number;
  signals: ReviewSignal[];
  positiveReasons: string[];
  uncertaintyReasons: string[];
  recommendedEvidence: EvidenceType[];
  evidenceRequest: {
    id: string;
    status: string;
    requestedEvidence: EvidenceType[];
  } | null;
}

export interface ReviewQueueView {
  items: ReviewQueueItem[];
  selected: ReviewMatchView | null;
  selectedIndex: number;
  previousMatchId: string | null;
  nextMatchId: string | null;
}

export interface ReviewActorInput {
  matchId: string;
  actorName: string;
}

export interface RequestEvidenceInput extends ReviewActorInput {
  requestedEvidence: EvidenceType[];
}

export interface ConfirmMatchResult {
  matchId: string;
  caseId: string;
  caseNumber: string;
  changed: boolean;
  versioned: boolean;
  lifecycleChanged: boolean;
}

export type ReviewCaseMode = LifecycleContext | { mode: 'legacy' };

export const legacyReviewCaseMode: ReviewCaseMode = { mode: 'legacy' };

export interface RejectMatchResult {
  matchId: string;
  changed: boolean;
}

export interface RequestEvidenceResult {
  matchId: string;
  caseId: string;
  evidenceRequestId: string;
  draftId: string;
  changed: boolean;
}

type ReviewRecord = {
  alert: typeof schema.alerts.$inferSelect;
  match: typeof schema.matches.$inferSelect;
  product: typeof schema.products.$inferSelect;
};

type CaseRecord = typeof schema.cases.$inferSelect;

export class ReviewWorkflowError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_state' | 'invalid_evidence',
    message: string
  ) {
    super(message);
    this.name = 'ReviewWorkflowError';
  }
}

function reviewRecord(database: RecallDatabase, matchId: string): ReviewRecord {
  const record = database
    .select({ alert: schema.alerts, match: schema.matches, product: schema.products })
    .from(schema.matches)
    .innerJoin(schema.alerts, eq(schema.alerts.id, schema.matches.alertId))
    .innerJoin(schema.products, eq(schema.products.id, schema.matches.productId))
    .where(eq(schema.matches.id, matchId))
    .get();

  if (!record) {
    throw new ReviewWorkflowError('not_found', 'The catalogue match could not be found.');
  }

  return record;
}

function assertPendingReview(record: ReviewRecord): void {
  const reviewableStatus =
    record.match.status === 'candidate' || record.match.status === 'awaiting_evidence';
  if (record.alert.status !== 'needs_review' || !reviewableStatus) {
    throw new ReviewWorkflowError(
      'invalid_state',
      'This match is not awaiting a human review decision.'
    );
  }
}

function uniqueEvidence(values: EvidenceType[]): EvidenceType[] {
  return evidenceTypes.filter((type) => values.includes(type));
}

function parseRequestedEvidence(value: string): EvidenceType[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return evidenceTypes.filter((type) => parsed.includes(type));
  } catch {
    return [];
  }
}

function scoreSignals(record: ReviewRecord): ReviewSignal[] {
  const { alert, match, product } = record;
  const eanTone: ReviewSignal['tone'] = match.hasHardConflict
    ? 'conflict'
    : !alert.ean || !product.ean
      ? 'missing'
      : match.eanScore === 45
        ? 'positive'
        : 'weak';
  const batchTone: ReviewSignal['tone'] = !alert.batch || !product.batch
    ? 'missing'
    : match.batchScore >= 8
      ? 'positive'
      : 'weak';

  return [
    {
      label: 'EAN / GTIN',
      detail:
        eanTone === 'conflict'
          ? `Alert ${alert.ean ?? 'missing'} conflicts with catalogue ${product.ean ?? 'missing'}`
          : eanTone === 'missing'
            ? 'An identifier is missing from one of the records'
            : eanTone === 'positive'
              ? 'Exact identifier match'
              : 'Identifiers do not provide a strong match',
      earned: match.eanScore,
      maximum: 45,
      tone: eanTone
    },
    {
      label: 'Product name / model',
      detail:
        match.nameScore >= 18
          ? 'Product names are strongly aligned'
          : 'Product names provide limited evidence',
      earned: match.nameScore,
      maximum: 25,
      tone: match.nameScore >= 18 ? 'positive' : 'weak'
    },
    {
      label: 'Brand',
      detail:
        match.brandScore >= 15
          ? 'Brand names are strongly aligned'
          : !alert.brand
            ? 'The official alert does not provide a brand'
            : 'Brand names provide limited evidence',
      earned: match.brandScore,
      maximum: 20,
      tone: match.brandScore >= 15 ? 'positive' : !alert.brand ? 'missing' : 'weak'
    },
    {
      label: 'Batch / lot',
      detail:
        batchTone === 'missing'
          ? 'The affected batch cannot be compared'
          : batchTone === 'positive'
            ? 'Batch values are strongly aligned'
            : 'Batch values provide limited evidence',
      earned: match.batchScore,
      maximum: 10,
      tone: batchTone
    }
  ];
}

function evidenceFor(record: ReviewRecord): EvidenceType[] {
  const recommended: EvidenceType[] = [];
  if (record.match.hasHardConflict || !record.alert.ean || !record.product.ean) {
    recommended.push('barcode_photo');
  }
  if (!record.alert.batch || !record.product.batch) {
    recommended.push('batch_label_photo');
  }
  if (recommended.length > 0 || record.alert.status === 'needs_review') {
    recommended.push('supplier_invoice');
  }
  return uniqueEvidence(recommended);
}

function evidenceLabel(type: EvidenceType): string {
  if (type === 'barcode_photo') return 'barcode photo';
  if (type === 'batch_label_photo') return 'batch-label photo';
  return 'supplier invoice';
}

function ensureCase(
  database: RecallDatabase,
  record: ReviewRecord,
  createdAt: string
): { caseRecord: CaseRecord; created: boolean } {
  const existing = database
    .select()
    .from(schema.cases)
    .where(eq(schema.cases.alertId, record.alert.id))
    .get();
  if (existing) return { caseRecord: existing, created: false };

  const caseRecord: CaseRecord = {
    id: randomUUID(),
    caseNumber: nextCaseNumber(database),
    alertId: record.alert.id,
    status: 'open',
    severity: severityForRisk(record.alert.risk, record.alert.description),
    openedAt: createdAt,
    closedAt: null
  };
  database.insert(schema.cases).values(caseRecord).run();
  return { caseRecord, created: true };
}

function recordCaseOpened(
  database: RecallDatabase,
  record: ReviewRecord,
  caseRecord: CaseRecord,
  actorName: string,
  createdAt: string,
  reason: 'match_confirmed' | 'evidence_requested'
): void {
  database
    .insert(schema.auditEvents)
    .values({
      id: randomUUID(),
      caseId: caseRecord.id,
      alertId: record.alert.id,
      eventType: 'case_opened',
      actorType: 'human',
      actorName,
      summary: `Opened ${caseRecord.caseNumber} during human review.`,
      metadataJson: JSON.stringify({ matchId: record.match.id, reason }),
      createdAt
    })
    .run();
}

export function getReviewQueueView(
  database: RecallDatabase,
  requestedMatchId?: string | null
): ReviewQueueView {
  const threshold =
    database.select().from(schema.settings).get()?.confidenceThreshold ?? 85;
  const rows = database
    .select({ alert: schema.alerts, match: schema.matches, product: schema.products })
    .from(schema.matches)
    .innerJoin(schema.alerts, eq(schema.alerts.id, schema.matches.alertId))
    .innerJoin(schema.products, eq(schema.products.id, schema.matches.productId))
    .where(
      and(
        eq(schema.alerts.status, 'needs_review'),
        inArray(schema.matches.status, ['candidate', 'awaiting_evidence'])
      )
    )
    .orderBy(desc(schema.alerts.createdAt), desc(schema.matches.totalScore), asc(schema.products.sku))
    .all();
  const queue = new Map<string, ReviewQueueItem>();

  for (const row of rows) {
    if (queue.has(row.alert.id)) continue;
    queue.set(row.alert.id, {
      alertId: row.alert.id,
      matchId: row.match.id,
      source: row.alert.source,
      sourceReference: row.alert.sourceReference,
      productName: row.alert.productName,
      risk: row.alert.risk,
      candidateName: row.product.name,
      candidateSku: row.product.sku,
      totalScore: row.match.totalScore,
      hasHardConflict: row.match.hasHardConflict,
      isHighConfidence:
        row.match.totalScore >= threshold && !row.match.hasHardConflict,
      harm: assessHarm(row.alert),
      status: row.match.status
    });
  }

  const items = [...queue.values()].sort(
    (left, right) =>
      right.harm.score - left.harm.score || right.totalScore - left.totalScore
  );
  const requestedIndex = requestedMatchId
    ? items.findIndex((item) => item.matchId === requestedMatchId)
    : -1;
  const selectedIndex = requestedIndex >= 0 ? requestedIndex : items.length > 0 ? 0 : -1;
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : null;

  if (!selectedItem) {
    return {
      items,
      selected: null,
      selectedIndex,
      previousMatchId: null,
      nextMatchId: null
    };
  }

  const record = reviewRecord(database, selectedItem.matchId);
  const signals = scoreSignals(record);
  const evidenceRequest = database
    .select()
    .from(schema.evidenceRequests)
    .where(eq(schema.evidenceRequests.matchId, record.match.id))
    .orderBy(desc(schema.evidenceRequests.createdAt))
    .get();
  const affectedPurchaseCount =
    database
      .select({ value: count() })
      .from(schema.purchases)
      .where(eq(schema.purchases.productId, record.product.id))
      .get()?.value ?? 0;

  return {
    items,
    selected: {
      ...record,
      threshold,
      isHighConfidence:
        record.match.totalScore >= threshold && !record.match.hasHardConflict,
      harm: assessHarm(record.alert),
      affectedPurchaseCount,
      signals,
      positiveReasons: signals
        .filter((signal) => signal.tone === 'positive')
        .map((signal) => signal.detail),
      uncertaintyReasons: signals
        .filter((signal) => signal.tone !== 'positive')
        .map((signal) => signal.detail),
      recommendedEvidence: evidenceFor(record),
      evidenceRequest: evidenceRequest
        ? {
            id: evidenceRequest.id,
            status: evidenceRequest.status,
            requestedEvidence: parseRequestedEvidence(evidenceRequest.requestedEvidence)
          }
        : null
    },
    selectedIndex,
    previousMatchId: selectedIndex > 0 ? items[selectedIndex - 1].matchId : null,
    nextMatchId: selectedIndex < items.length - 1 ? items[selectedIndex + 1].matchId : null
  };
}

function assertReviewCaseCompatible(
  database: RecallDatabase,
  alertId: string,
  productId: string,
  versioned: boolean
): void {
  const existing = database.select().from(schema.cases).where(eq(schema.cases.alertId, alertId)).get();
  if (existing && hasCaseLifecycle(database, existing.id)) {
    const snapshot = readCaseSnapshot(database, existing.id);
    if (!versioned || snapshot?.productId !== productId) {
      throw new ReviewWorkflowError('invalid_state', 'This alert uses a different versioned investigation case.');
    }
  }
}

function assertLegacyReview(database: RecallDatabase, alertId: string): void {
  const existing = database.select().from(schema.cases).where(eq(schema.cases.alertId, alertId)).get();
  if (existing && hasCaseLifecycle(database, existing.id)) {
    throw new ReviewWorkflowError('invalid_state', 'This alert uses a versioned investigation case; use its case commands.');
  }
}

export function confirmReviewMatch(
  database: RecallDatabase,
  input: ReviewActorInput,
  now: Date,
  caseMode: ReviewCaseMode
): ConfirmMatchResult {
  if (caseMode.mode === 'disabled') {
    throw new ReviewWorkflowError('invalid_state', 'Versioned review integration requires explicit local demo mode.');
  }
  const versioned = caseMode.mode === 'demo';
  return database.transaction((transaction) => {
    let lifecycleChanged = false;
    const record = reviewRecord(transaction, input.matchId);
    assertReviewCaseCompatible(transaction, record.alert.id, record.product.id, versioned);
    if (record.match.status === 'rejected') {
      throw new ReviewWorkflowError('invalid_state', 'A rejected match cannot be confirmed.');
    }
    if (record.match.status !== 'confirmed') assertPendingReview(record);

    const createdAt = now.toISOString();
    const ensuredCase = ensureCase(transaction, record, createdAt);
    const batch = record.product.batch ?? record.alert.batch ?? 'Unknown';
    const existingItem = transaction
      .select({ id: schema.caseItems.id })
      .from(schema.caseItems)
      .where(
        and(
          eq(schema.caseItems.caseId, ensuredCase.caseRecord.id),
          eq(schema.caseItems.productId, record.product.id),
          eq(schema.caseItems.batch, batch)
        )
      )
      .get();

    if (!existingItem) {
      transaction
        .insert(schema.caseItems)
        .values({
          id: randomUUID(),
          caseId: ensuredCase.caseRecord.id,
          productId: record.product.id,
          batch,
          stockQuantity: record.product.stockQuantity
        })
        .run();
    }

    if (ensuredCase.created) {
      recordCaseOpened(
        transaction,
        record,
        ensuredCase.caseRecord,
        input.actorName,
        createdAt,
        'match_confirmed'
      );
    }

    const changed = record.match.status !== 'confirmed';
    if (changed) {
      transaction
        .update(schema.matches)
        .set({ status: 'confirmed', decidedAt: createdAt })
        .where(eq(schema.matches.id, record.match.id))
        .run();
      transaction
        .update(schema.alerts)
        .set({ status: 'matched' })
        .where(eq(schema.alerts.id, record.alert.id))
        .run();
      transaction
        .insert(schema.auditEvents)
        .values({
          id: randomUUID(),
          caseId: ensuredCase.caseRecord.id,
          alertId: record.alert.id,
          eventType: 'match_confirmed',
          actorType: 'human',
          actorName: input.actorName,
          summary: `Confirmed ${record.product.sku} as a catalogue match.`,
          metadataJson: JSON.stringify({
            matchId: record.match.id,
            productId: record.product.id,
            score: record.match.totalScore
          }),
          createdAt
        })
        .run();
    }
    if (versioned) {
      const outcome = produceInvestigationOutcome({
        caseId: ensuredCase.caseRecord.id,
        productId: record.product.id,
        matchId: record.match.id,
        materialRevision: 1,
        updatedAt: record.match.decidedAt ?? createdAt,
        alertBatch: record.alert.batch,
        catalogueBatch: record.product.batch,
        hasHardIdentityConflict: record.match.hasHardConflict,
        evidenceRefs: {
          alert: `demo:alert:${record.alert.id}`,
          catalogueProduct: `demo:catalogue:${record.product.id}`,
          match: `demo:match:${record.match.id}`,
          alertBatch: `demo:alert-batch:${record.alert.id}`,
          catalogueBatch: `demo:catalogue-batch:${record.product.id}`
        },
        decisionRefs: {
          review: `demo:review-decision:${record.match.id}`
        },
        demo: true
      });
      const integrated = applyConfirmedReviewOutcomeInTransaction(transaction, {
        caseId: ensuredCase.caseRecord.id,
        productId: record.product.id,
        eventId: record.match.id,
        outcome
      }, caseMode, new Date(outcome.updatedAt));
      if (!integrated.ok) {
        throw new ReviewWorkflowError('invalid_state', integrated.error.message);
      }
      lifecycleChanged = !integrated.replayed;
    } else {
      ensureCaseResponseRecords(transaction, {
        caseId: ensuredCase.caseRecord.id,
        actorType: 'human',
        actorName: input.actorName,
        createdAt
      });
    }

    return {
      matchId: record.match.id,
      caseId: ensuredCase.caseRecord.id,
      caseNumber: ensuredCase.caseRecord.caseNumber,
      changed,
      versioned,
      lifecycleChanged
    };
  });
}

export function rejectReviewMatch(
  database: RecallDatabase,
  input: ReviewActorInput,
  now = new Date()
): RejectMatchResult {
  return database.transaction((transaction) => {
    const record = reviewRecord(transaction, input.matchId);
    assertLegacyReview(transaction, record.alert.id);
    if (record.match.status === 'confirmed') {
      throw new ReviewWorkflowError('invalid_state', 'A confirmed match cannot be rejected.');
    }
    if (record.match.status === 'rejected') {
      return { matchId: record.match.id, changed: false };
    }
    assertPendingReview(record);

    const decidedAt = now.toISOString();
    const existingCase = transaction
      .select({ id: schema.cases.id })
      .from(schema.cases)
      .where(eq(schema.cases.alertId, record.alert.id))
      .get();
    transaction
      .update(schema.matches)
      .set({ status: 'rejected', decidedAt })
      .where(eq(schema.matches.id, record.match.id))
      .run();
    transaction
      .update(schema.alerts)
      .set({ status: 'not_relevant' })
      .where(eq(schema.alerts.id, record.alert.id))
      .run();
    transaction
      .insert(schema.auditEvents)
      .values({
        id: randomUUID(),
        caseId: existingCase?.id ?? null,
        alertId: record.alert.id,
        eventType: 'match_rejected',
        actorType: 'human',
        actorName: input.actorName,
        summary: `Rejected ${record.product.sku} as a catalogue match.`,
        metadataJson: JSON.stringify({
          matchId: record.match.id,
          productId: record.product.id,
          score: record.match.totalScore
        }),
        createdAt: decidedAt
      })
      .run();

    return { matchId: record.match.id, changed: true };
  });
}

export function requestMatchEvidence(
  database: RecallDatabase,
  input: RequestEvidenceInput,
  now = new Date()
): RequestEvidenceResult {
  const requestedEvidence = uniqueEvidence(input.requestedEvidence);
  if (requestedEvidence.length === 0) {
    throw new ReviewWorkflowError(
      'invalid_evidence',
      'Choose at least one evidence type before confirming the request.'
    );
  }

  return database.transaction((transaction) => {
    const record = reviewRecord(transaction, input.matchId);
    assertLegacyReview(transaction, record.alert.id);
    if (record.match.status === 'confirmed' || record.match.status === 'rejected') {
      throw new ReviewWorkflowError(
        'invalid_state',
        'Evidence cannot be requested for a decided match.'
      );
    }
    assertPendingReview(record);

    const existingRequest = transaction
      .select()
      .from(schema.evidenceRequests)
      .where(eq(schema.evidenceRequests.matchId, record.match.id))
      .orderBy(desc(schema.evidenceRequests.createdAt))
      .get();
    const existingCase = transaction
      .select()
      .from(schema.cases)
      .where(eq(schema.cases.alertId, record.alert.id))
      .get();
    const draftSubject = `Evidence request: ${record.alert.sourceReference} / ${record.product.sku}`;
    const existingDraft = existingCase
      ? transaction
          .select()
          .from(schema.actionDrafts)
          .where(
            and(
              eq(schema.actionDrafts.caseId, existingCase.id),
              eq(schema.actionDrafts.type, 'notify_supplier'),
              eq(schema.actionDrafts.subject, draftSubject)
            )
          )
          .get()
      : null;

    if (existingRequest && existingCase && existingDraft) {
      return {
        matchId: record.match.id,
        caseId: existingCase.id,
        evidenceRequestId: existingRequest.id,
        draftId: existingDraft.id,
        changed: false
      };
    }

    const createdAt = now.toISOString();
    const ensuredCase = ensureCase(transaction, record, createdAt);
    if (ensuredCase.created) {
      recordCaseOpened(
        transaction,
        record,
        ensuredCase.caseRecord,
        input.actorName,
        createdAt,
        'evidence_requested'
      );
    }

    const evidenceRequestId = randomUUID();
    const draftId = randomUUID();
    const evidenceList = requestedEvidence.map(evidenceLabel).join(', ');
    const draftBody = `Please provide ${evidenceList} for ${record.product.sku} so we can resolve catalogue match ${record.match.id}. This draft has not been sent.`;
    transaction
      .insert(schema.evidenceRequests)
      .values({
        id: evidenceRequestId,
        matchId: record.match.id,
        requestedEvidence: JSON.stringify(requestedEvidence),
        recipient: record.product.supplierEmail,
        status: 'pending',
        createdAt,
        resolvedAt: null
      })
      .run();
    transaction
      .insert(schema.actionDrafts)
      .values({
        id: draftId,
        caseId: ensuredCase.caseRecord.id,
        type: 'notify_supplier',
        recipient: record.product.supplierEmail,
        subject: draftSubject,
        body: draftBody,
        status: 'draft',
        approvedBy: null,
        approvedAt: null,
        createdAt
      })
      .run();
    transaction
      .update(schema.matches)
      .set({ status: 'awaiting_evidence' })
      .where(eq(schema.matches.id, record.match.id))
      .run();
    transaction
      .insert(schema.auditEvents)
      .values([
        {
          id: randomUUID(),
          caseId: ensuredCase.caseRecord.id,
          alertId: record.alert.id,
          eventType: 'evidence_requested',
          actorType: 'human',
          actorName: input.actorName,
          summary: `Requested supplier evidence for ${record.product.sku}.`,
          metadataJson: JSON.stringify({
            matchId: record.match.id,
            evidenceRequestId,
            draftId,
            requestedEvidence
          }),
          createdAt
        },
        {
          id: randomUUID(),
          caseId: ensuredCase.caseRecord.id,
          alertId: record.alert.id,
          eventType: 'action_draft_created',
          actorType: 'human',
          actorName: input.actorName,
          summary: 'Created notify supplier evidence draft with status draft.',
          metadataJson: JSON.stringify({
            draftId,
            type: 'notify_supplier',
            status: 'draft',
            recipient: record.product.supplierEmail,
            subject: draftSubject,
            body: draftBody
          }),
          createdAt
        }
      ])
      .run();

    return {
      matchId: record.match.id,
      caseId: ensuredCase.caseRecord.id,
      evidenceRequestId,
      draftId,
      changed: true
    };
  });
}
