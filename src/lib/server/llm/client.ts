import type {
  ActionType,
  AlertProposalExtraction,
  LlmClient,
  MatchExplanation,
  ScoreBreakdown
} from '../../types/domain';
import { FallbackLlmClient } from './fallback-client';
import { OpenAiLlmClient, ResponsesApiTransport } from './openai-client';

export class ResilientLlmClient implements LlmClient {
  constructor(
    private readonly primary: LlmClient,
    private readonly fallback: LlmClient
  ) {}

  async extractAlert(input: string): Promise<AlertProposalExtraction> {
    try {
      return await this.primary.extractAlert(input);
    } catch {
      return this.fallback.extractAlert(input);
    }
  }

  async explainMatch(input: ScoreBreakdown): Promise<MatchExplanation> {
    try {
      return await this.primary.explainMatch(input);
    } catch {
      return this.fallback.explainMatch(input);
    }
  }

  async draftAction(type: ActionType, context: Record<string, unknown>): Promise<string> {
    try {
      return await this.primary.draftAction(type, context);
    } catch {
      return this.fallback.draftAction(type, context);
    }
  }
}

interface LlmEnvironment {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}

export function createLlmClient(environment: LlmEnvironment = process.env): LlmClient {
  const fallback = new FallbackLlmClient();
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return fallback;

  const model = environment.OPENAI_MODEL?.trim();
  if (!model) return fallback;

  return new ResilientLlmClient(
    new OpenAiLlmClient(new ResponsesApiTransport(apiKey), { model }),
    fallback
  );
}
