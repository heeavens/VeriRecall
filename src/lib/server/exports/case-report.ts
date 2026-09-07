import { randomUUID } from 'node:crypto';

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import type { ReportExporter } from '../../types/domain';
import { getCaseDetail, type CaseDetailView } from '../cases/queries';
import type { RecallDatabase } from '../db/repositories';
import * as schema from '../db/schema';
import { hasCaseLifecycle } from '../workflow/lifecycle-boundary';

type ReportFormat = 'csv' | 'pdf';
type ReportRow = [section: string, field: string, value: string, details: string];

export class CaseReportError extends Error {}

function text(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? 'Not provided' : String(value);
}

export function protectSpreadsheetValue(value: string): string {
  return /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
}

export function escapeCsvCell(value: string | number | null | undefined): string {
  const protectedValue = protectSpreadsheetValue(
    value === null || value === undefined ? 'Not provided' : String(value)
  );
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

function decisionSummary(detail: CaseDetailView): string {
  const decision = [...detail.timeline]
    .reverse()
    .find((event) => ['match_confirmed', 'match_rejected'].includes(event.eventType));
  if (decision) return `${decision.summary} (${decision.actorName}, ${decision.createdAt})`;
  if (detail.match?.status === 'confirmed') {
    return `Confirmed identity status recorded at ${detail.match.decidedAt ?? detail.match.createdAt}; decision event unavailable.`;
  }
  return text(detail.match?.status);
}

export function buildCaseReportRows(detail: CaseDetailView, generatedAt: string): ReportRow[] {
  const rows: ReportRow[] = [
    ['Case summary', 'Case number', detail.caseRecord.caseNumber, ''],
    ['Case summary', 'Status', detail.caseRecord.status, ''],
    ['Case summary', 'Official alert harm priority', detail.caseRecord.severity, ''],
    ['Case summary', 'Opened at', detail.caseRecord.openedAt, ''],
    ['Case summary', 'Closed at', text(detail.caseRecord.closedAt), ''],
    ['Case summary', 'Generated at', generatedAt, ''],
    ['Official alert', 'Reference', detail.alert.sourceReference, detail.alert.source],
    ['Official alert', 'URL', detail.alert.sourceUrl, ''],
    ['Official alert', 'Title', detail.alert.title, ''],
    ['Official alert', 'Product', detail.alert.productName, detail.alert.risk],
    ['Decision', 'Match status', text(detail.match?.status), decisionSummary(detail)],
    ['Decision', 'Total score', text(detail.match?.totalScore), detail.match?.explanation ?? ''],
    [
      'Decision',
      'Score breakdown',
      `EAN ${detail.match?.eanScore ?? 0}; name ${detail.match?.nameScore ?? 0}; brand ${detail.match?.brandScore ?? 0}; batch ${detail.match?.batchScore ?? 0}`,
      `Hard conflict: ${detail.match?.hasHardConflict ? 'yes' : 'no'}`
    ],
    ['Affected products', 'Total stock', String(detail.totalStock), `${detail.items.length} item(s)`],
    ['Affected customers', 'Count', String(detail.customers.length), '']
  ];

  if (detail.closureEvidence) {
    rows.push(
      ['Closure evidence', 'Reviewer note', detail.closureEvidence.note, ''],
      ['Closure evidence', 'Evidence reference', detail.closureEvidence.reference, ''],
      [
        'Closure evidence',
        'Recorded by',
        detail.closureEvidence.actorName,
        detail.closureEvidence.recordedAt
      ]
    );
  }

  for (const { item, product } of detail.items) {
    rows.push([
      'Affected products',
      product.sku,
      product.name,
      `Brand: ${product.brand}; batch: ${item.batch}; stock: ${item.stockQuantity}; EAN: ${text(product.ean)}`
    ]);
  }
  for (const customer of detail.customers) {
    rows.push([
      'Affected customers',
      customer.externalId,
      text(customer.name),
      `Email: ${text(customer.email)}; SKU: ${customer.sku}; batch: ${text(customer.batch)}; purchased: ${customer.purchasedAt}; quantity: ${customer.quantity}`
    ]);
  }
  for (const draft of detail.drafts) {
    rows.push([
      'Actions',
      draft.type,
      draft.status,
      `Recipient: ${text(draft.recipient)}; subject: ${draft.subject}; body: ${draft.body}; approved by: ${text(draft.approvedBy)}; approved at: ${text(draft.approvedAt)}`
    ]);
  }
  for (const event of detail.timeline) {
    rows.push([
      'Audit timeline',
      event.createdAt,
      event.summary,
      `Actor: ${event.actorType}/${event.actorName}; event: ${event.eventType}; metadata: ${event.metadataJson}`
    ]);
  }
  return rows;
}

export function buildCaseCsv(detail: CaseDetailView, generatedAt: string): Uint8Array {
  const rows: Array<ReportRow> = [
    ['Section', 'Field', 'Value', 'Details'],
    ...buildCaseReportRows(detail, generatedAt)
  ];
  const csv = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
  return new TextEncoder().encode(`\uFEFF${csv}\r\n`);
}

function pdfSafe(value: string): string {
  return value
    .replaceAll('—', '-')
    .replaceAll('–', '-')
    .replaceAll('’', "'")
    .replaceAll('“', '"')
    .replaceAll('”', '"')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?');
}

function wrapLine(value: string, width = 104): string[] {
  const words = pdfSafe(value).split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) line = next;
    else {
      if (line) lines.push(line);
      line = word.slice(0, width);
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export async function buildCasePdf(
  detail: CaseDetailView,
  generatedAt: string
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  document.setTitle(`${detail.caseRecord.caseNumber} case report`);
  document.setSubject('RecallOps complete case record');
  document.setCreationDate(new Date(generatedAt));

  let page = document.addPage([595.28, 841.89]);
  let y = 800;
  const margin = 44;
  const addLine = (line: string, isHeading = false): void => {
    for (const wrapped of wrapLine(line)) {
      if (y < 48) {
        page = document.addPage([595.28, 841.89]);
        y = 800;
      }
      page.drawText(wrapped, {
        x: margin,
        y,
        size: isHeading ? 11 : 8.5,
        font: isHeading ? bold : regular,
        color: isHeading ? rgb(0.39, 0.19, 0.78) : rgb(0.09, 0.08, 0.11)
      });
      y -= isHeading ? 18 : 12;
    }
  };

  addLine(`${detail.caseRecord.caseNumber} - Complete Case Report`, true);
  addLine(`Generated at ${generatedAt}`);
  y -= 8;
  let previousSection = '';
  for (const [section, field, value, details] of buildCaseReportRows(detail, generatedAt)) {
    if (section !== previousSection) {
      y -= 5;
      addLine(section, true);
      previousSection = section;
    }
    addLine(`${field}: ${value}${details ? ` | ${details}` : ''}`);
  }

  return document.save({ useObjectStreams: false });
}

export class CaseReportExporter implements ReportExporter {
  constructor(
    private readonly database: RecallDatabase,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async exportCase(caseId: string, format: ReportFormat): Promise<Uint8Array> {
    if (hasCaseLifecycle(this.database, caseId)) throw new CaseReportError('Versioned investigation reports are not implemented; read the case snapshot.');
    const detail = getCaseDetail(this.database, caseId);
    if (!detail) throw new CaseReportError('Recall case not found.');
    const generatedAt = this.now();
    const bytes =
      format === 'csv'
        ? buildCaseCsv(detail, generatedAt)
        : await buildCasePdf(detail, generatedAt);

    this.database.transaction((transaction) => {
      transaction
        .insert(schema.auditEvents)
        .values({
          id: randomUUID(),
          caseId,
          alertId: detail.alert.id,
          eventType: 'report_exported',
          actorType: 'human',
          actorName: 'demo_user',
          summary: `Exported the complete case report as ${format.toUpperCase()}.`,
          metadataJson: JSON.stringify({ format, generatedAt }),
          createdAt: generatedAt
        })
        .run();
    });
    return bytes;
  }
}
