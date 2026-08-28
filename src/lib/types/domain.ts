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
