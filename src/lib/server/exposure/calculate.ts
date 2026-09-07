import type { CaseSnapshot, TraceabilityRecord } from '../../contracts/recall';

type Exposure = CaseSnapshot['exposure'];
type Quantity = Exposure['received'];
type Issue = Exposure['gaps'][number];

const RETAILER_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

function latestBy<T extends TraceabilityRecord>(
  records: T[], key: (record: T) => string
): T[] {
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

function source(record: TraceabilityRecord): Quantity['sources'][number] {
  return {
    sourceRef: record.sourceRef,
    sourceType: record.type,
    asOf: record.occurredAt,
    demo: record.demo
  };
}

function known(records: TraceabilityRecord[], value: number, calculatedAt: string): Quantity {
  return {
    value,
    unit: 'ITEM',
    knowledgeStatus: 'KNOWN',
    sources: records.map(source),
    asOf: records.reduce(
      (latest, record) => latest > record.occurredAt ? latest : record.occurredAt,
      records[0]?.occurredAt ?? calculatedAt
    )
  };
}

function unknown(status: Quantity['knowledgeStatus'] = 'UNKNOWN'): Quantity {
  return { value: null, unit: 'ITEM', knowledgeStatus: status, sources: [], asOf: null };
}

function gap(
  caseId: string,
  code: string,
  message: string,
  subjectRefs: string[],
  evidenceRefs: string[] = []
): Issue {
  return {
    id: `${caseId}:${code.toLowerCase()}:${subjectRefs.join(':')}`,
    code,
    message,
    critical: true,
    subjectRefs,
    evidenceRefs
  };
}

function recordType<T extends TraceabilityRecord['type']>(
  records: TraceabilityRecord[], type: T
): Extract<TraceabilityRecord, { type: T }>[] {
  return records.filter(
    (record): record is Extract<TraceabilityRecord, { type: T }> => record.type === type
  );
}

export interface ExposureCalculationInput {
  caseId: string;
  productId: string;
  materialRevision: number;
  lots: string[];
  records: TraceabilityRecord[];
  calculatedAt: string;
}

export function calculateExposure(input: ExposureCalculationInput): Exposure {
  const lots = new Set(input.lots);
  const productRecords = input.records.filter((record) => record.productId === input.productId);
  const affected = productRecords.filter((record) => record.lot !== null && lots.has(record.lot));
  const ambiguous = productRecords.filter((record) => record.lot === null);
  const gaps: Issue[] = [];
  const conflicts: Issue[] = [];

  const receipts = recordType(affected, 'RECEIPT');
  const ambiguousReceipts = recordType(ambiguous, 'RECEIPT');
  let received = receipts.length ? known(receipts, receipts.reduce((sum, row) => sum + row.quantity, 0), input.calculatedAt) : unknown();
  if (!receipts.length || ambiguousReceipts.length) {
    received = unknown();
    gaps.push(gap(
      input.caseId,
      ambiguousReceipts.length ? 'RECEIPT_BATCH_UNKNOWN' : 'AFFECTED_TOTAL_UNKNOWN',
      ambiguousReceipts.length
        ? 'A receipt has no batch, so the affected received total cannot be established.'
        : 'No receipt establishes the affected total for the confirmed lots.',
      ambiguousReceipts.map((row) => row.sourceRef).concat(input.caseId),
      ambiguousReceipts.map((row) => row.sourceRef)
    ));
  }

  const inventory = latestBy(recordType(affected, 'INVENTORY'), (row) => `${row.locationRef}:${row.lot}`);
  const ambiguousInventory = recordType(ambiguous, 'INVENTORY');
  let warehouse = inventory.length
    ? known(inventory, inventory.reduce((sum, row) => sum + row.quantity, 0), input.calculatedAt)
    : unknown();
  if (!inventory.length || ambiguousInventory.length) {
    warehouse = unknown();
    gaps.push(gap(
      input.caseId,
      ambiguousInventory.length ? 'INVENTORY_BATCH_UNKNOWN' : 'WAREHOUSE_POSITION_UNKNOWN',
      ambiguousInventory.length
        ? 'An inventory observation has no batch, so affected warehouse stock is unresolved.'
        : 'No current inventory observation establishes affected warehouse stock.',
      ambiguousInventory.map((row) => row.sourceRef).concat(input.productId),
      ambiguousInventory.map((row) => row.sourceRef)
    ));
  }

  const shipments = latestBy(recordType(affected, 'SHIPMENT'), (row) => row.shipmentRef);
  const ambiguousShipments = recordType(ambiguous, 'SHIPMENT');
  let inTransit: Quantity;
  if (ambiguousShipments.length) {
    inTransit = unknown('UNRESOLVED');
    gaps.push(gap(
      input.caseId,
      'SHIPMENT_BATCH_UNKNOWN',
      'A shipment has no batch. It cannot be treated as unaffected or included as a known quantity.',
      ambiguousShipments.map((row) => row.shipmentRef),
      ambiguousShipments.map((row) => row.sourceRef)
    ));
  } else if (shipments.length) {
    const moving = shipments.filter((row) => row.status === 'IN_TRANSIT');
    inTransit = known(shipments, moving.reduce((sum, row) => sum + row.quantity, 0), input.calculatedAt);
  } else {
    inTransit = unknown();
    gaps.push(gap(
      input.caseId,
      'SHIPMENT_POSITION_UNKNOWN',
      'No shipment history establishes whether affected units are in transit.',
      [input.productId]
    ));
  }

  const deliveredRetailers = new Set(
    shipments.filter((row) => row.status === 'DELIVERED').map((row) => row.destinationRef)
  );
  const retailerResponses = latestBy(recordType(affected, 'RETAILER_RESPONSE'), (row) => `${row.retailerRef}:${row.lot}`);
  const ambiguousResponses = recordType(ambiguous, 'RETAILER_RESPONSE');
  const staleResponses = retailerResponses.filter(
    (row) => Date.parse(input.calculatedAt) - Date.parse(row.occurredAt) > RETAILER_FRESHNESS_MS
  );
  const staleAfterMovement = retailerResponses.filter((response) =>
    shipments.some((shipment) => shipment.destinationRef === response.retailerRef &&
      shipment.occurredAt > response.occurredAt)
  );
  const respondingRetailers = new Set(retailerResponses.map((row) => row.retailerRef));
  const missingRetailers = [...deliveredRetailers].filter((retailer) => !respondingRetailers.has(retailer));
  let retailer: Quantity;
  if (ambiguousResponses.length || staleResponses.length || staleAfterMovement.length || missingRetailers.length) {
    retailer = unknown(ambiguousResponses.length ? 'UNRESOLVED' : 'PENDING');
    gaps.push(gap(
      input.caseId,
      ambiguousResponses.length ? 'RETAILER_RESPONSE_BATCH_UNKNOWN' : 'RETAILER_RESPONSE_NOT_CURRENT',
      ambiguousResponses.length
        ? 'A retailer response has no batch and cannot establish affected stock.'
        : 'A delivered shipment lacks a current retailer stock response.',
      ambiguousResponses.map((row) => row.sourceRef)
        .concat(staleResponses.map((row) => row.retailerRef), staleAfterMovement.map((row) => row.retailerRef), missingRetailers),
      ambiguousResponses.concat(staleResponses, staleAfterMovement).map((row) => row.sourceRef)
    ));
  } else if (retailerResponses.length) {
    retailer = known(
      retailerResponses,
      retailerResponses.reduce((sum, row) => sum + row.quantity, 0),
      input.calculatedAt
    );
  } else {
    retailer = unknown();
    gaps.push(gap(
      input.caseId,
      'RETAILER_POSITION_UNKNOWN',
      'No current retailer response establishes affected stock.',
      [input.productId]
    ));
  }

  const sales = recordType(affected, 'SALE');
  const ambiguousSales = recordType(ambiguous, 'SALE');
  let sold = sales.length
    ? known(sales, sales.reduce((sum, row) => sum + row.quantity, 0), input.calculatedAt)
    : unknown();
  if (!sales.length || ambiguousSales.length) {
    sold = unknown(ambiguousSales.length ? 'UNRESOLVED' : 'UNKNOWN');
    gaps.push(gap(
      input.caseId,
      ambiguousSales.length ? 'SALE_BATCH_UNKNOWN' : 'SOLD_QUANTITY_UNKNOWN',
      ambiguousSales.length
        ? 'A sale record has no batch and cannot establish affected sold units.'
        : 'No sale records or explicit zero-sale confirmation establish sold units.',
      ambiguousSales.map((row) => row.sourceRef).concat(input.productId),
      ambiguousSales.map((row) => row.sourceRef)
    ));
  }

  const containment = latestBy(recordType(affected, 'CONTAINMENT'), (row) => `${row.locationRef}:${row.lot}`);
  const contained = containment.length
    ? known(containment, containment.reduce((sum, row) => sum + row.quantity, 0), input.calculatedAt)
    : unknown();

  const locations = [warehouse, inTransit, retailer, sold];
  let unaccounted = unknown();
  if (received.knowledgeStatus === 'KNOWN' && locations.every((quantity) => quantity.knowledgeStatus === 'KNOWN')) {
    const distributed = locations.reduce((sum, quantity) => sum + (quantity.value ?? 0), 0);
    const difference = (received.value ?? 0) - distributed;
    if (difference < 0) {
      unaccounted = unknown('CONFLICTED');
      conflicts.push(gap(
        input.caseId,
        'DISTRIBUTION_EXCEEDS_RECEIPTS',
        `Known locations total ${distributed} ITEM while affected receipts total ${received.value} ITEM; excess ${-difference} ITEM.`,
        [input.caseId],
        [...received.sources, ...locations.flatMap((quantity) => quantity.sources)].map((item) => item.sourceRef)
      ));
    } else {
      const basis = [...received.sources, ...locations.flatMap((quantity) => quantity.sources)];
      unaccounted = {
        value: difference,
        unit: 'ITEM',
        knowledgeStatus: 'KNOWN',
        sources: [{
          sourceRef: `derived:${input.caseId}:unaccounted:r${input.materialRevision}`,
          sourceType: 'DERIVED',
          asOf: input.calculatedAt,
          demo: basis.every((item) => item.demo)
        }],
        asOf: input.calculatedAt
      };
      if (difference > 0) {
        gaps.push(gap(
          input.caseId,
          'TRACEABILITY_GAP',
          `${difference} ITEM are not accounted for by current warehouse, transit, retailer and sale records.`,
          [input.caseId],
          basis.map((item) => item.sourceRef)
        ));
      }
    }
  }

  return {
    status: 'CALCULATED',
    basisMaterialRevision: input.materialRevision,
    calculatedAt: input.calculatedAt,
    received,
    warehouse,
    inTransit,
    retailer,
    sold,
    unaccounted,
    contained,
    gaps,
    conflicts
  };
}
