import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';

import type { ActionType } from '../../types/domain';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';

interface CaseSetupInput {
  caseId: string;
  actorType: 'agent' | 'human';
  actorName: string;
  createdAt: string;
  draftBodies?: Partial<Record<ActionType, string>>;
}

interface ActionDefinition {
  type: ActionType;
  label: string;
  recipient: string | null;
  subject: string;
  body: string;
  available: boolean;
}

export interface CaseSetupResult {
  tasksCreated: number;
  draftsCreated: number;
}

function affectedPurchases(
  database: RecallDatabase,
  itemRows: Array<{
    item: typeof schema.caseItems.$inferSelect;
    product: typeof schema.products.$inferSelect;
  }>
) {
  const productIds = [...new Set(itemRows.map((row) => row.product.id))];
  if (productIds.length === 0) return [];

  const batchesByProduct = new Map<string, Set<string>>();
  for (const row of itemRows) {
    const batches = batchesByProduct.get(row.product.id) ?? new Set<string>();
    batches.add(row.item.batch);
    batchesByProduct.set(row.product.id, batches);
  }

  return database
    .select({ purchase: schema.purchases, customer: schema.customers })
    .from(schema.purchases)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.purchases.customerId))
    .where(inArray(schema.purchases.productId, productIds))
    .all()
    .filter((row) => {
      const batches = batchesByProduct.get(row.purchase.productId);
      return (
        batches?.has('Unknown') ||
        row.purchase.batch === null ||
        (row.purchase.batch !== null && batches?.has(row.purchase.batch))
      );
    });
}

function actionDefinitions(
  caseNumber: string,
  sourceReference: string,
  itemRows: Array<{
    item: typeof schema.caseItems.$inferSelect;
    product: typeof schema.products.$inferSelect;
  }>,
  purchaseRows: ReturnType<typeof affectedPurchases>
): ActionDefinition[] {
  const primary = itemRows[0];
  if (!primary) return [];

  const productSummary = itemRows
    .map((row) => `${row.product.sku} batch ${row.item.batch}`)
    .join(', ');
  const stockQuantity = itemRows.reduce((total, row) => total + row.item.stockQuantity, 0);
  const customerEmails = [
    ...new Set(
      purchaseRows
        .map((row) => row.customer.email)
        .filter((email): email is string => Boolean(email))
    )
  ];
  const customerAvailable = purchaseRows.length > 0;

  return [
    {
      type: 'block_sale',
      label: 'Block sale for affected inventory',
      recipient: 'Internal inventory control',
      subject: `Sales hold: ${caseNumber} / ${primary.product.sku}`,
      body: `Place an immediate internal sales hold on ${productSummary}, covering ${stockQuantity} units. Confirm the inventory-control step before closing ${caseNumber}.`,
      available: true
    },
    {
      type: 'notify_supplier',
      label: 'Notify supplier',
      recipient: primary.product.supplierEmail,
      subject: `Recall action required: ${sourceReference} / ${primary.product.sku}`,
      body: `Please confirm receipt of this recall notice for ${productSummary}. Quarantine affected stock and provide your containment response for ${caseNumber}.`,
      available: true
    },
    {
      type: 'notify_customers',
      label: 'Notify affected customers',
      recipient:
        customerEmails.length > 0
          ? customerEmails.join(', ')
          : customerAvailable
            ? `${purchaseRows.length} customer record${purchaseRows.length === 1 ? '' : 's'} without email`
            : null,
      subject: `Important product recall: ${primary.product.name}`,
      body: customerAvailable
        ? `We are contacting you about ${productSummary}, linked to ${sourceReference}. Stop using the affected product and follow the return instructions in this notice.`
        : `No affected customer purchase records are available for ${productSummary}.`,
      available: customerAvailable
    }
  ];
}

export function ensureCaseResponseRecords(
  database: RecallDatabase,
  input: CaseSetupInput
): CaseSetupResult {
  const caseRecord = database
    .select({ caseRecord: schema.cases, alert: schema.alerts })
    .from(schema.cases)
    .innerJoin(schema.alerts, eq(schema.alerts.id, schema.cases.alertId))
    .where(eq(schema.cases.id, input.caseId))
    .get();
  if (!caseRecord) throw new Error('Cannot initialize actions for a missing case.');

  const itemRows = database
    .select({ item: schema.caseItems, product: schema.products })
    .from(schema.caseItems)
    .innerJoin(schema.products, eq(schema.products.id, schema.caseItems.productId))
    .where(eq(schema.caseItems.caseId, input.caseId))
    .all();
  if (itemRows.length === 0) throw new Error('Cannot initialize actions before a case item exists.');

  const definitions = actionDefinitions(
    caseRecord.caseRecord.caseNumber,
    caseRecord.alert.sourceReference,
    itemRows,
    affectedPurchases(database, itemRows)
  ).map((definition) => ({
    ...definition,
    body: input.draftBodies?.[definition.type]?.trim() || definition.body
  }));
  const existingTaskTypes = new Set(
    database
      .select({ type: schema.caseTasks.type })
      .from(schema.caseTasks)
      .where(eq(schema.caseTasks.caseId, input.caseId))
      .all()
      .map((row) => row.type)
  );
  const existingDraftTypes = new Set(
    database
      .select({ type: schema.actionDrafts.type })
      .from(schema.actionDrafts)
      .where(eq(schema.actionDrafts.caseId, input.caseId))
      .all()
      .map((row) => row.type)
  );
  let tasksCreated = 0;
  let draftsCreated = 0;

  for (const definition of definitions) {
    if (!existingTaskTypes.has(definition.type)) {
      database
        .insert(schema.caseTasks)
        .values({
          id: randomUUID(),
          caseId: input.caseId,
          type: definition.type,
          label: definition.label,
          status: definition.available ? 'pending' : 'not_available',
          completedBy: null,
          completedAt: null
        })
        .run();
      tasksCreated += 1;
    }

    if (!existingDraftTypes.has(definition.type)) {
      const draftId = randomUUID();
      const status = definition.available ? 'draft' : 'not_available';
      database
        .insert(schema.actionDrafts)
        .values({
          id: draftId,
          caseId: input.caseId,
          type: definition.type,
          recipient: definition.recipient,
          subject: definition.subject,
          body: definition.body,
          status,
          approvedBy: null,
          approvedAt: null,
          createdAt: input.createdAt
        })
        .run();
      database
        .insert(schema.auditEvents)
        .values({
          id: randomUUID(),
          caseId: input.caseId,
          alertId: caseRecord.alert.id,
          eventType: 'action_draft_created',
          actorType: input.actorType,
          actorName: input.actorName,
          summary: `Created ${definition.label.toLowerCase()} draft with status ${status}.`,
          metadataJson: JSON.stringify({
            draftId,
            type: definition.type,
            status,
            recipient: definition.recipient,
            subject: definition.subject,
            body: definition.body
          }),
          createdAt: input.createdAt
        })
        .run();
      draftsCreated += 1;
    }
  }

  return { tasksCreated, draftsCreated };
}
