import { randomUUID } from 'node:crypto';

import type { CaseSnapshot, TraceabilityRecord } from '../../contracts/recall';

type Task = CaseSnapshot['tasks'][number];
type Decision = CaseSnapshot['pendingDecisions'][number];
type TaskType = Task['type'];
type TaskRule = Task['rule'];
type Quantity = Task['quantity'];

const RETAILER_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;
const TASK_RULE_ORDER: TaskRule[] = [
  'AFFECTED_AVAILABLE_STOCK',
  'ACTIVE_SHIPMENT',
  'RECIPIENT_POSITION_UNKNOWN',
  'DISTRIBUTION_GAP',
  'SOLD_UNITS'
];

interface DesiredTask {
  type: TaskType;
  rule: TaskRule;
  title: string;
  targetRef: string;
  quantity: Quantity;
  reasonRefs: string[];
  sourceRefs: string[];
  blocking: boolean;
  priority: Task['priority'];
  priorityReason: string;
  approvalRequired: boolean;
}

function latestBy<T extends TraceabilityRecord>(records: T[], key: (record: T) => string): T[] {
  const latest = new Map<string, T>();
  for (const record of records) {
    const current = latest.get(key(record));
    if (!current || current.occurredAt < record.occurredAt ||
        (current.occurredAt === record.occurredAt && current.sourceRef < record.sourceRef)) {
      latest.set(key(record), record);
    }
  }
  return [...latest.values()];
}

function recordsOf<T extends TraceabilityRecord['type']>(records: TraceabilityRecord[], type: T) {
  return records.filter(
    (record): record is Extract<TraceabilityRecord, { type: T }> => record.type === type
  );
}

function quantity(record: TraceabilityRecord & { quantity: number }): Quantity {
  return {
    value: record.quantity,
    unit: 'ITEM',
    knowledgeStatus: 'KNOWN',
    sources: [{ sourceRef: record.sourceRef, sourceType: record.type, asOf: record.occurredAt, demo: record.demo }],
    asOf: record.occurredAt
  };
}

function summedQuantity(records: Array<TraceabilityRecord & { quantity: number }>, calculatedAt: string): Quantity {
  const ordered = [...records].sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
  return {
    value: ordered.reduce((sum, record) => sum + record.quantity, 0),
    unit: 'ITEM',
    knowledgeStatus: 'KNOWN',
    sources: ordered.map((record) => ({
      sourceRef: record.sourceRef,
      sourceType: record.type,
      asOf: record.occurredAt,
      demo: record.demo
    })),
    asOf: ordered.reduce(
      (latest, record) => latest > record.occurredAt ? latest : record.occurredAt,
      records[0]?.occurredAt ?? calculatedAt
    )
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function coverageKey(coverage: Task['coverage']): string {
  return coverage.kind === 'BATCH_LOT'
    ? `BATCH_LOT:${[...coverage.lots].sort().join(',')}`
    : `UNRESOLVED:${coverage.knowledgeStatus}`;
}

function quantityKey(value: Quantity): string {
  return `${value.knowledgeStatus}:${value.value ?? 'null'}:${value.unit}`;
}

function equivalentKey(caseId: string, task: Pick<Task, 'rule' | 'targetRef' | 'coverage' | 'quantity'>): string {
  return [caseId, task.rule, task.targetRef, coverageKey(task.coverage), quantityKey(task.quantity)].join('|');
}

function approvalIsApplicable(snapshot: CaseSnapshot, task: Task): boolean {
  return task.decisionRefs.some((decisionRef) => snapshot.decisions.some((decision) =>
    decision.id === decisionRef && decision.type === 'APPROVE_ACTION' && decision.status === 'APPROVED' &&
    coverageKey(decision.coverage) === coverageKey(task.coverage) &&
    JSON.stringify([...decision.evidenceRefs].sort()) === JSON.stringify([...task.sourceRefs].sort())
  ));
}

function draftFor(task: DesiredTask, caseId: string, coverage: Task['coverage']): Task['draft'] {
  const lots = coverage.kind === 'BATCH_LOT' ? coverage.lots.join(', ') : 'unresolved scope';
  const sources = task.sourceRefs.join(', ');
  return {
    recipientRef: task.targetRef,
    subject: `[DEMO DRAFT] ${task.title}`,
    body: [
      'DEMO DRAFT — no external action has been performed.',
      `Case: ${caseId}. Coverage: ${lots}.`,
      `Basis sources: ${sources}.`,
      'Verify the scope and source records before use.'
    ].join('\n'),
    reviewRequired: true,
    sourceRefs: task.sourceRefs,
    demo: true
  };
}

function desiredTasks(snapshot: CaseSnapshot, records: TraceabilityRecord[]): DesiredTask[] {
  if (!snapshot.investigation || snapshot.investigation.scope.kind !== 'BATCH_LOT' ||
      snapshot.exposure.status !== 'CALCULATED') return [];
  const lots = new Set(snapshot.investigation.scope.lots);
  const affected = records.filter((record) =>
    record.productId === snapshot.productId && record.lot !== null && lots.has(record.lot)
  );
  const desired: DesiredTask[] = [];

  const inventory = latestBy(recordsOf(affected, 'INVENTORY'), (record) => `${record.locationRef}:${record.lot}`);
  const inventoryByLocation = new Map<string, typeof inventory>();
  for (const record of inventory) {
    const current = inventoryByLocation.get(record.locationRef) ?? [];
    current.push(record);
    inventoryByLocation.set(record.locationRef, current);
  }
  for (const [locationRef, locationRecords] of inventoryByLocation) {
    const position = summedQuantity(locationRecords, snapshot.exposure.calculatedAt!);
    if ((position.value ?? 0) <= 0) continue;
    const sourceRefs = unique(locationRecords.map((record) => record.sourceRef));
    desired.push({
      type: 'HOLD_STOCK', rule: 'AFFECTED_AVAILABLE_STOCK',
      title: `Hold affected stock at ${locationRef}`, targetRef: locationRef,
      quantity: position, reasonRefs: sourceRefs, sourceRefs,
      blocking: true, priority: 'CRITICAL',
      priorityReason: `${position.value} affected ITEM are currently available at this location.`,
      approvalRequired: true
    });
  }

  const shipments = latestBy(recordsOf(affected, 'SHIPMENT'), (record) => record.shipmentRef);
  for (const record of shipments.filter((item) => item.status === 'IN_TRANSIT' && item.quantity > 0)) {
    desired.push({
      type: 'INTERCEPT_SHIPMENT', rule: 'ACTIVE_SHIPMENT',
      title: `Intercept active shipment ${record.shipmentRef}`, targetRef: record.shipmentRef,
      quantity: quantity(record), reasonRefs: [record.sourceRef], sourceRefs: [record.sourceRef],
      blocking: true, priority: 'CRITICAL',
      priorityReason: `${record.quantity} affected ITEM remain in active transit.`,
      approvalRequired: true
    });
  }

  const responses = latestBy(recordsOf(affected, 'RETAILER_RESPONSE'), (record) => `${record.retailerRef}:${record.lot}`);
  const deliveriesByRetailer = new Map<string, typeof shipments>();
  for (const shipment of shipments.filter((item) => item.status === 'DELIVERED')) {
    const current = deliveriesByRetailer.get(shipment.destinationRef) ?? [];
    current.push(shipment);
    deliveriesByRetailer.set(shipment.destinationRef, current);
  }
  for (const [retailerRef, deliveries] of deliveriesByRetailer) {
    const relatedResponses = responses.filter((response) => response.retailerRef === retailerRef);
    const allCurrent = deliveries.every((delivery) => {
      const response = relatedResponses.find((item) => item.lot === delivery.lot);
      return response && response.occurredAt >= delivery.occurredAt &&
        Date.parse(snapshot.exposure.calculatedAt!) - Date.parse(response.occurredAt) <= RETAILER_FRESHNESS_MS;
    });
    if (allCurrent) continue;
    const sourceRefs = unique([
      ...deliveries.map((delivery) => delivery.sourceRef),
      ...relatedResponses.map((response) => response.sourceRef)
    ]);
    desired.push({
      type: 'REQUEST_RETAILER_CONFIRMATION', rule: 'RECIPIENT_POSITION_UNKNOWN',
      title: `Request current stock confirmation from ${retailerRef}`,
      targetRef: retailerRef,
      quantity: { value: null, unit: 'ITEM', knowledgeStatus: 'PENDING', sources: [], asOf: null },
      reasonRefs: sourceRefs, sourceRefs, blocking: true, priority: 'HIGH',
      priorityReason: 'Delivered affected stock has no current recipient position.',
      approvalRequired: true
    });
  }

  for (const issue of snapshot.exposure.gaps.filter((item) =>
    !['RETAILER_RESPONSE_NOT_CURRENT', 'RETAILER_RESPONSE_BATCH_UNKNOWN'].includes(item.code)
  )) {
    const sourceRefs = unique(issue.evidenceRefs.length
      ? issue.evidenceRefs
      : snapshot.exposure.received.sources.map((item) => item.sourceRef));
    if (!sourceRefs.length) continue;
    desired.push({
      type: 'INVESTIGATE_TRACEABILITY_GAP', rule: 'DISTRIBUTION_GAP',
      title: `Investigate ${issue.code.toLowerCase().replaceAll('_', ' ')}`,
      targetRef: issue.id,
      quantity: issue.code === 'TRACEABILITY_GAP' ? snapshot.exposure.unaccounted : {
        value: null, unit: 'ITEM', knowledgeStatus: 'UNKNOWN', sources: [], asOf: null
      },
      reasonRefs: [issue.id], sourceRefs, blocking: true, priority: 'CRITICAL',
      priorityReason: issue.message, approvalRequired: false
    });
  }

  if (snapshot.exposure.sold.knowledgeStatus === 'KNOWN' && (snapshot.exposure.sold.value ?? 0) > 0) {
    const sourceRefs = snapshot.exposure.sold.sources.map((item) => item.sourceRef);
    desired.push({
      type: 'PREPARE_COMMUNICATION', rule: 'SOLD_UNITS',
      title: 'Prepare communication for affected purchasers',
      targetRef: `customers:${snapshot.productId}`, quantity: snapshot.exposure.sold,
      reasonRefs: sourceRefs, sourceRefs, blocking: false, priority: 'HIGH',
      priorityReason: `${snapshot.exposure.sold.value} affected ITEM are recorded as sold.`,
      approvalRequired: true
    });
  }

  return desired.sort((left, right) => {
    const ruleOrder = TASK_RULE_ORDER.indexOf(left.rule) - TASK_RULE_ORDER.indexOf(right.rule);
    return ruleOrder || left.targetRef.localeCompare(right.targetRef);
  });
}

function pendingDecision(task: Task, snapshot: CaseSnapshot, idFactory: () => string): Decision {
  return {
    id: idFactory(), type: 'APPROVE_ACTION', status: 'PENDING', subjectRef: task.id,
    basisCaseVersion: snapshot.caseVersion,
    basisMaterialRevision: snapshot.materialRevision!, coverage: task.coverage,
    evidenceRefs: task.sourceRefs,
    uncertaintyRefs: snapshot.uncertainties.map((issue) => issue.id),
    conflictRefs: snapshot.conflicts.map((issue) => issue.id),
    consequence: `Approval permits recording a demo request for ${task.type}; it does not complete the task.`,
    rationale: `Review ${task.type} for ${task.targetRef} against the current coverage.`,
    actorId: null, actorRole: null, decidedAt: null, demo: true
  };
}

export interface TaskReconciliation {
  tasks: Task[];
  pendingDecisions: Decision[];
  changed: boolean;
}

export function reconcileDynamicTasks(
  snapshot: CaseSnapshot,
  records: TraceabilityRecord[],
  now: string,
  idFactory: () => string = randomUUID
): TaskReconciliation {
  const desired = desiredTasks(snapshot, records);
  const coverage = snapshot.investigation?.scope;
  if (!coverage || coverage.kind !== 'BATCH_LOT' || snapshot.materialRevision === null) {
    return { tasks: snapshot.tasks, pendingDecisions: snapshot.pendingDecisions, changed: false };
  }

  const candidates = new Map(
    snapshot.tasks
      .filter((task) => task.status !== 'SUPERSEDED')
      .map((task) => [equivalentKey(snapshot.caseId, task), task])
  );
  const priorPending = new Map(snapshot.pendingDecisions
    .filter((decision) => decision.type === 'APPROVE_ACTION')
    .map((decision) => [decision.subjectRef, decision]));
  const matched = new Set<string>();
  const active: Task[] = [];
  const decisions: Decision[] = snapshot.pendingDecisions.filter((decision) => decision.type !== 'APPROVE_ACTION');

  for (const item of desired) {
    const key = equivalentKey(snapshot.caseId, { ...item, coverage });
    const existing = candidates.get(key);
    let task: Task;
    if (existing) {
      matched.add(existing.id);
      task = {
        ...existing,
        type: item.type,
        rule: item.rule,
        title: item.title,
        coverage,
        quantity: item.quantity,
        basisMaterialRevision: snapshot.materialRevision,
        reasonRefs: item.reasonRefs,
        sourceRefs: item.sourceRefs,
        blocking: item.blocking,
        priority: item.priority,
        priorityReason: item.priorityReason,
        approvalRequired: item.approvalRequired,
        draft: draftFor(item, snapshot.caseId, coverage)
      };
    } else {
      const taskId = idFactory();
      task = {
        id: taskId, type: item.type, rule: item.rule,
        status: item.approvalRequired ? 'BLOCKED' : 'OPEN', statusReason: null,
        title: item.title, targetRef: item.targetRef, coverage, quantity: item.quantity,
        basisMaterialRevision: snapshot.materialRevision,
        reasonRefs: item.reasonRefs, sourceRefs: item.sourceRefs, blocking: item.blocking,
        blockedBy: [], priority: item.priority, priorityReason: item.priorityReason,
        approvalRequired: item.approvalRequired,
        approvalStatus: item.approvalRequired ? 'PENDING' : null,
        decisionRefs: [], resultEvidenceRefs: [], requestStatus: 'NOT_REQUESTED',
        draft: draftFor(item, snapshot.caseId, coverage), demo: true
      };
    }

    if (task.approvalRequired && task.approvalStatus === 'APPROVED' &&
        !['COMPLETED', 'CANCELLED', 'SUPERSEDED'].includes(task.status) &&
        !approvalIsApplicable(snapshot, task)) {
      task = { ...task, status: 'BLOCKED', approvalStatus: 'PENDING', blockedBy: [] };
    }

    if (task.approvalStatus === 'PENDING') {
      const previousDecision = priorPending.get(task.id);
      const decisionIsCurrent = previousDecision &&
        previousDecision.basisMaterialRevision === snapshot.materialRevision &&
        coverageKey(previousDecision.coverage) === coverageKey(coverage) &&
        JSON.stringify(previousDecision.evidenceRefs) === JSON.stringify(task.sourceRefs);
      const decision = decisionIsCurrent
        ? previousDecision
        : previousDecision
          ? {
              ...previousDecision,
              basisCaseVersion: snapshot.caseVersion,
              basisMaterialRevision: snapshot.materialRevision,
              coverage,
              evidenceRefs: task.sourceRefs,
              rationale: `Review ${task.type} for ${task.targetRef} against the current coverage.`
            }
          : pendingDecision(task, snapshot, idFactory);
      task = { ...task, status: 'BLOCKED', blockedBy: [decision.id] };
      decisions.push(decision);
    }
    active.push(task);
  }

  const historical = snapshot.tasks.map((task) => {
    if (matched.has(task.id) || task.status === 'SUPERSEDED') return task;
    return {
      ...task,
      status: 'SUPERSEDED' as const,
      statusReason: 'The rule trigger is no longer present in the current exposure.',
      approvalStatus: task.approvalStatus === null ? null : 'STALE' as const,
      decisionRefs: [...new Set([...task.decisionRefs, ...task.blockedBy])],
      blockedBy: []
    };
  }).filter((task) => !matched.has(task.id));

  const tasks = [...active, ...historical];
  const changed = JSON.stringify(tasks) !== JSON.stringify(snapshot.tasks) ||
    JSON.stringify(decisions) !== JSON.stringify(snapshot.pendingDecisions);
  return { tasks, pendingDecisions: decisions, changed };
}
