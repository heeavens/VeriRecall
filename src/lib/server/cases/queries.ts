import { asc, desc, eq, inArray } from 'drizzle-orm';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { readCaseSnapshot } from '../workflow/case-lifecycle';
import { hasCaseLifecycle } from '../workflow/lifecycle-boundary';

export interface CaseListItem {
  versioned: boolean;
  versionedExposure: { status: 'NOT_CALCULATED' | 'CALCULATED'; received: number | null } | null;
  caseRecord: typeof schema.cases.$inferSelect;
  alert: typeof schema.alerts.$inferSelect;
  itemCount: number;
  totalStock: number;
  completedTasks: number;
  actionableTasks: number;
  pendingTasks: number;
  nextTaskLabel: string | null;
  draftCount: number;
  pendingApprovals: number;
  simulatedCount: number;
}

export interface AffectedCustomer {
  id: string;
  externalId: string;
  name: string | null;
  email: string | null;
  productId: string;
  sku: string;
  batch: string | null;
  purchasedAt: string;
  quantity: number;
}

export interface CaseDetailView {
  caseRecord: typeof schema.cases.$inferSelect;
  alert: typeof schema.alerts.$inferSelect;
  match: typeof schema.matches.$inferSelect | null;
  items: Array<{
    item: typeof schema.caseItems.$inferSelect;
    product: typeof schema.products.$inferSelect;
  }>;
  customers: AffectedCustomer[];
  tasks: Array<typeof schema.caseTasks.$inferSelect>;
  drafts: Array<typeof schema.actionDrafts.$inferSelect>;
  timeline: Array<typeof schema.auditEvents.$inferSelect>;
  totalStock: number;
  completedTasks: number;
  actionableTasks: number;
  closureEvidence: {
    note: string;
    reference: string;
    actorName: string;
    recordedAt: string;
  } | null;
}

export interface ActionDraftView {
  draft: typeof schema.actionDrafts.$inferSelect;
  caseRecord: typeof schema.cases.$inferSelect;
  alert: typeof schema.alerts.$inferSelect;
}

const timelinePriority: Readonly<Record<string, number>> = {
  case_opened: 10,
  match_confirmed: 20,
  evidence_requested: 30,
  action_draft_created: 40,
  action_draft_edited: 50,
  action_draft_approved: 60,
  action_simulated_sent: 70,
  case_task_completed: 80,
  case_closed: 90
};

function affectedCustomers(
  database: RecallDatabase,
  items: CaseDetailView['items']
): AffectedCustomer[] {
  const productIds = [...new Set(items.map((row) => row.product.id))];
  if (productIds.length === 0) return [];

  const batchesByProduct = new Map<string, Set<string>>();
  for (const row of items) {
    const batches = batchesByProduct.get(row.product.id) ?? new Set<string>();
    batches.add(row.item.batch);
    batchesByProduct.set(row.product.id, batches);
  }

  return database
    .select({ purchase: schema.purchases, customer: schema.customers, product: schema.products })
    .from(schema.purchases)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.purchases.customerId))
    .innerJoin(schema.products, eq(schema.products.id, schema.purchases.productId))
    .where(inArray(schema.purchases.productId, productIds))
    .orderBy(desc(schema.purchases.purchasedAt))
    .all()
    .filter((row) => {
      const batches = batchesByProduct.get(row.purchase.productId);
      return (
        batches?.has('Unknown') ||
        row.purchase.batch === null ||
        (row.purchase.batch !== null && batches?.has(row.purchase.batch))
      );
    })
    .map((row) => ({
      id: row.customer.id,
      externalId: row.customer.externalId,
      name: row.customer.name,
      email: row.customer.email,
      productId: row.product.id,
      sku: row.product.sku,
      batch: row.purchase.batch,
      purchasedAt: row.purchase.purchasedAt,
      quantity: row.purchase.quantity
    }));
}

export function getCasesView(database: RecallDatabase): CaseListItem[] {
  return database
    .select({ caseRecord: schema.cases, alert: schema.alerts })
    .from(schema.cases)
    .innerJoin(schema.alerts, eq(schema.alerts.id, schema.cases.alertId))
    .orderBy(desc(schema.cases.openedAt))
    .all()
    .map((row) => {
      const versioned = hasCaseLifecycle(database, row.caseRecord.id);
      const lifecycleSnapshot = versioned ? readCaseSnapshot(database, row.caseRecord.id) : null;
      const items = database
        .select()
        .from(schema.caseItems)
        .where(eq(schema.caseItems.caseId, row.caseRecord.id))
        .all();
      const tasks = database
        .select({
          type: schema.caseTasks.type,
          label: schema.caseTasks.label,
          status: schema.caseTasks.status
        })
        .from(schema.caseTasks)
        .where(eq(schema.caseTasks.caseId, row.caseRecord.id))
        .all()
        .sort(
          (left, right) =>
            ['block_sale', 'notify_supplier', 'notify_customers'].indexOf(left.type) -
            ['block_sale', 'notify_supplier', 'notify_customers'].indexOf(right.type)
        );
      const drafts = database
        .select({ status: schema.actionDrafts.status })
        .from(schema.actionDrafts)
        .where(eq(schema.actionDrafts.caseId, row.caseRecord.id))
        .all();
      const actionableTasks = tasks.filter((task) => task.status !== 'not_available').length;
      const pendingTasks = tasks.filter((task) => task.status === 'pending');
      const lifecycleTasks = lifecycleSnapshot?.tasks.filter((task) =>
        !['CANCELLED', 'SUPERSEDED'].includes(task.status)
      ) ?? [];
      const pendingLifecycleTasks = lifecycleTasks.filter((task) => task.status !== 'COMPLETED');
      return {
        ...row,
        versioned,
        versionedExposure: lifecycleSnapshot ? {
          status: lifecycleSnapshot.exposure.status,
          received: lifecycleSnapshot.exposure.received.value
        } : null,
        itemCount: items.length,
        totalStock: items.reduce((total, item) => total + item.stockQuantity, 0),
        completedTasks: lifecycleSnapshot
          ? lifecycleTasks.filter((task) => task.status === 'COMPLETED').length
          : tasks.filter((task) => task.status === 'completed').length,
        actionableTasks: lifecycleSnapshot ? lifecycleTasks.length : actionableTasks,
        pendingTasks: lifecycleSnapshot ? pendingLifecycleTasks.length : pendingTasks.length,
        nextTaskLabel: lifecycleSnapshot
          ? pendingLifecycleTasks.find((task) => task.blocking)?.title ?? pendingLifecycleTasks[0]?.title ?? null
          : pendingTasks[0]?.label ?? null,
        draftCount: drafts.length,
        pendingApprovals: lifecycleSnapshot
          ? lifecycleSnapshot.pendingDecisions.filter((decision) => decision.type === 'APPROVE_ACTION').length
          : drafts.filter((draft) => draft.status === 'draft').length,
        simulatedCount: drafts.filter((draft) => draft.status === 'simulated_sent').length
      };
    })
    .filter((row) => row.itemCount > 0 || row.versioned);
}

export function getCaseDetail(database: RecallDatabase, caseId: string): CaseDetailView | null {
  const record = database
    .select({ caseRecord: schema.cases, alert: schema.alerts })
    .from(schema.cases)
    .innerJoin(schema.alerts, eq(schema.alerts.id, schema.cases.alertId))
    .where(eq(schema.cases.id, caseId))
    .get();
  if (!record) return null;

  const items = database
    .select({ item: schema.caseItems, product: schema.products })
    .from(schema.caseItems)
    .innerJoin(schema.products, eq(schema.products.id, schema.caseItems.productId))
    .where(eq(schema.caseItems.caseId, caseId))
    .all();
  const tasks = database
    .select()
    .from(schema.caseTasks)
    .where(eq(schema.caseTasks.caseId, caseId))
    .all()
    .sort((left, right) =>
      ['block_sale', 'notify_supplier', 'notify_customers'].indexOf(left.type) -
      ['block_sale', 'notify_supplier', 'notify_customers'].indexOf(right.type)
    );
  const drafts = database
    .select()
    .from(schema.actionDrafts)
    .where(eq(schema.actionDrafts.caseId, caseId))
    .orderBy(asc(schema.actionDrafts.createdAt))
    .all();
  const timeline = database
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.caseId, caseId))
    .orderBy(asc(schema.auditEvents.createdAt))
    .all()
    .sort((left, right) => {
      const timeOrder = left.createdAt.localeCompare(right.createdAt);
      if (timeOrder !== 0) return timeOrder;
      return (timelinePriority[left.eventType] ?? 50) - (timelinePriority[right.eventType] ?? 50);
    });
  const match = database
    .select()
    .from(schema.matches)
    .where(eq(schema.matches.alertId, record.alert.id))
    .orderBy(desc(schema.matches.totalScore))
    .get() ?? null;
  const actionableTasks = tasks.filter((task) => task.status !== 'not_available').length;
  const closureEvent = [...timeline].reverse().find((event) => event.eventType === 'case_closed');
  let closureEvidence: CaseDetailView['closureEvidence'] = null;
  if (closureEvent) {
    try {
      const metadata = JSON.parse(closureEvent.metadataJson) as {
        closureNote?: unknown;
        evidenceReference?: unknown;
      };
      if (typeof metadata.closureNote === 'string' && typeof metadata.evidenceReference === 'string') {
        closureEvidence = {
          note: metadata.closureNote,
          reference: metadata.evidenceReference,
          actorName: closureEvent.actorName,
          recordedAt: closureEvent.createdAt
        };
      }
    } catch {
      closureEvidence = null;
    }
  }

  return {
    ...record,
    match,
    items,
    customers: affectedCustomers(database, items),
    tasks,
    drafts,
    timeline,
    totalStock: items.reduce((total, row) => total + row.item.stockQuantity, 0),
    completedTasks: tasks.filter((task) => task.status === 'completed').length,
    actionableTasks,
    closureEvidence
  };
}

export function getActionDraftsView(
  database: RecallDatabase,
  requestedCaseId?: string | null
): ActionDraftView[] {
  const query = database
    .select({ draft: schema.actionDrafts, caseRecord: schema.cases, alert: schema.alerts })
    .from(schema.actionDrafts)
    .innerJoin(schema.cases, eq(schema.cases.id, schema.actionDrafts.caseId))
    .innerJoin(schema.alerts, eq(schema.alerts.id, schema.cases.alertId))
    .orderBy(desc(schema.actionDrafts.createdAt));

  const actions = requestedCaseId
    ? query.where(eq(schema.actionDrafts.caseId, requestedCaseId)).all()
    : query.all();

  return actions.sort((left, right) => {
    const statusPriority = (status: string): number => {
      if (status === 'draft') return 0;
      if (status === 'not_available') return 2;
      return 1;
    };
    return statusPriority(left.draft.status) - statusPriority(right.draft.status);
  });
}
