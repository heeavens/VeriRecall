import type {
  ActionType,
  LlmClient,
  NormalizedAlert,
  ScoreBreakdown
} from '../../types/domain';
import { normalizeAlert } from '../alerts/normalization';

function stringValue(context: Record<string, unknown>, key: string, fallback: string): string {
  const value = context[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numberValue(context: Record<string, unknown>, key: string): number {
  const value = context[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class FallbackLlmClient implements LlmClient {
  async extractAlert(input: string): Promise<NormalizedAlert> {
    return normalizeAlert(JSON.parse(input) as unknown);
  }

  async explainMatch(input: ScoreBreakdown): Promise<string> {
    const evidence = input.requestedEvidence.length
      ? `Requested evidence: ${input.requestedEvidence.join(', ')}.`
      : 'No additional matching evidence is required.';
    return `${input.reasons.join(' ')} ${evidence}`;
  }

  async draftAction(type: ActionType, context: Record<string, unknown>): Promise<string> {
    const sku = stringValue(context, 'sku', 'the affected product');
    const batch = stringValue(context, 'batch', 'unknown');
    const sourceReference = stringValue(context, 'sourceReference', 'the official recall');
    const stockQuantity = numberValue(context, 'stockQuantity');

    if (type === 'block_sale') {
      return `Place an immediate internal sales hold on ${sku}, batch ${batch}, covering ${stockQuantity} units. Record completion before closing the case.`;
    }
    if (type === 'notify_supplier') {
      return `Please confirm receipt of recall ${sourceReference} for ${sku}, batch ${batch}. Quarantine affected stock and provide your containment response.`;
    }
    return `We are contacting you about ${sku}, batch ${batch}, linked to ${sourceReference}. Stop using the affected product and follow the return instructions in this notice.`;
  }
}
