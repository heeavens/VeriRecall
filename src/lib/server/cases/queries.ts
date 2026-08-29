import { asc, desc, eq, inArray } from 'drizzle-orm';

import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';

export interface CaseListItem {
  caseRecord: typeof schema.cases.$inferSelect;
  alert: typeof schema.alerts.$inferSelect;
  itemCount: number;
  totalStock: number;
  completedTasks: number;
  actionableTasks: number;
  draftCount: number;
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
      const items = database
        .select()
        .from(schema.caseItems)
        .where(eq(schema.caseItems.caseId, row.caseRecord.id))
        .all();
      const tasks = database
        .select({ status: schema.caseTasks.status })
        .from(schema.caseTasks)
        .where(eq(schema.caseTasks.caseId, row.caseRecord.id))
        .all();
      const drafts = database
        .select({ status: schema.actionDrafts.status })
        .from(schema.actionDrafts)
        .where(eq(schema.actionDrafts.caseId, row.caseRecord.id))
        .all();
      const actionableTasks = tasks.filter((task) => task.status !== 'not_available').length;
      return {
        ...row,
        itemCount: items.length,
        totalStock: items.reduce((total, item) => total + item.stockQuantity, 0),
        completedTasks: tasks.filter((task) => task.status === 'completed').length,
        actionableTasks,
        draftCount: drafts.length,
        simulatedCount: drafts.filter((draft) => draft.status === 'simulated_sent').length
      };
    })
    .filter((row) => row.itemCount > 0);
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
    actionableTasks
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

  return requestedCaseId
    ? query.where(eq(schema.actionDrafts.caseId, requestedCaseId)).all()
    : query.all();
}
