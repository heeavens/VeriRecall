export const alertSourceNames = ['safety_gate', 'rasff'] as const;
export type AlertSourceName = (typeof alertSourceNames)[number];

export const alertStatuses = ['matched', 'needs_review', 'not_relevant'] as const;
export type AlertStatus = (typeof alertStatuses)[number];

export const matchStatuses = [
  'candidate',
  'confirmed',
  'rejected',
  'awaiting_evidence'
] as const;
export type MatchStatus = (typeof matchStatuses)[number];

export const caseStatuses = ['open', 'contained', 'closed'] as const;
export type CaseStatus = (typeof caseStatuses)[number];

export const actionTypes = ['block_sale', 'notify_supplier', 'notify_customers'] as const;
export type ActionType = (typeof actionTypes)[number];

export const actionStatuses = [
  'draft',
  'approved',
  'simulated_sent',
  'not_available'
] as const;
export type ActionStatus = (typeof actionStatuses)[number];

export const caseTaskStatuses = ['pending', 'completed', 'not_available'] as const;
export type CaseTaskStatus = (typeof caseTaskStatuses)[number];

export interface NormalizedAlert {
  source: AlertSourceName;
  sourceReference: string;
  sourceUrl: string;
  title: string;
  description: string;
  risk: string;
  productName: string;
  brand?: string;
  ean?: string;
  batch?: string;
  category?: string;
  publishedAt: string;
}

export interface AlertSourceRecord {
  alert: NormalizedAlert;
  provider: string;
  payloadFormat: 'application/json';
  rawPayload: string;
  sourceVersionIdentifier?: string;
  sourceUpdatedAt?: string;
  observedAt: string;
  demo: boolean;
}

export interface AlertProposalFields {
  productName?: string;
  brand?: string;
  ean?: string;
  batch?: string;
  category?: string;
}

export interface AlertProposalExtraction {
  proposals: AlertProposalFields;
  origin: 'AI_GENERATED' | 'NONE';
  extractorIdentifier: string;
  extractorVersion: string;
  modelIdentifier: string | null;
}

export interface MatchExplanation {
  text: string;
  origin: 'DETERMINISTIC' | 'AI_GENERATED';
  generatorIdentifier: string;
  generatorVersion: string;
  modelIdentifier: string | null;
}

export interface ScoreBreakdown {
  total: number;
  ean: number;
  name: number;
  brand: number;
  batch: number;
  hasHardConflict: boolean;
  reasons: string[];
  requestedEvidence: string[];
}

export interface AlertSource {
  readAlerts(): Promise<AlertSourceRecord[]>;
}

export interface FuzzyMatcher {
  ratio(left: string, right: string): number;
  tokenSetRatio(left: string, right: string): number;
}

export interface LlmClient {
  extractAlert(input: string): Promise<AlertProposalExtraction>;
  explainMatch(input: ScoreBreakdown): Promise<MatchExplanation>;
  draftAction(type: ActionType, context: Record<string, unknown>): Promise<string>;
}

export interface ReportExporter {
  exportCase(caseId: string, format: 'csv' | 'pdf'): Promise<Uint8Array>;
}
