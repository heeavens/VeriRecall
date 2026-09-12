import type { InvestigatorModelInputV1 } from '../investigation/investigator-policy';
import {
  InvestigatorLlmClientError,
  OpenAiInvestigatorLlmClient,
  createInvestigatorLlmClient
} from './investigator-client';
import type { OpenAiResponseTransport, OpenAiStructuredRequest } from './openai-client';

import { describe, expect, it } from 'vitest';

const snapshot = {
  schemaVersion: 1,
  policyIdentifier: 'verirecall-constrained-investigator',
  policyVersion: 1,
  caseId: '10000000-0000-4000-8000-000000000001',
  productId: '20000000-0000-4000-8000-000000000001',
  caseVersion: 2,
  materialRevision: 1,
  question: {
    questionRef: 'question:batch',
    questionType: 'AFFECTED_BATCH_LOT',
    subjectRef: '20000000-0000-4000-8000-000000000001'
  },
  context: { kind: 'OPEN_GAP' },
  authoritative: {
    outcome: {
      kind: 'INVESTIGATION_OUTCOME', schemaVersion: 1, caseId: '10000000-0000-4000-8000-000000000001',
      productId: '20000000-0000-4000-8000-000000000001', materialRevision: 1,
      knowledgeStatus: 'UNRESOLVED',
      identity: { knowledgeStatus: 'KNOWN', conclusion: 'MATCH', productId: '20000000-0000-4000-8000-000000000001', evidenceRefs: [], decisionRefs: [] },
      scope: { kind: 'UNRESOLVED', knowledgeStatus: 'UNKNOWN', reason: 'Batch missing.', evidenceRefs: [], decisionRefs: [] },
      gaps: [{ id: 'question:batch', code: 'BATCH_MISSING', message: 'Batch missing.', critical: true, subjectRefs: [], evidenceRefs: [] }],
      conflicts: [], evidenceRefs: [], decisionRefs: [], updatedAt: '2026-09-12T00:00:00.000Z', demo: true
    },
    epistemicClass: 'AUTHORITATIVE_CURRENT_FACT', provenanceRefs: [], provenanceLimitations: []
  },
  evidence: [], requests: [], claims: [], assessments: [],
  issues: [{ issueRef: 'question:batch', code: 'BATCH_MISSING', kind: 'GAP', critical: true, subjectRefs: [], evidenceRefs: [], epistemicClass: 'UNRESOLVED' }],
  establishment: { evaluations: [], awaitingHumanAuthority: false },
  alertFacts: { sourceObservationRef: null, matchBasisDigest: null, authoritative: [], hypotheses: [], unverified: [], blockers: ['LEGACY_UNVERIFIED'] },
  memoryEvents: [],
  operational: { stage: 'INVESTIGATING', exposureStatus: 'NOT_CALCULATED', closureStatus: 'NOT_READY', tasks: [] },
  allowedCapabilities: [{ kind: 'REQUEST_EVIDENCE', evidenceType: 'batch_label_photo', target: 'CURRENT_PRODUCT_SUPPLIER' }]
} as InvestigatorModelInputV1;

const validOutput = {
  schemaVersion: 1,
  recommendation: { kind: 'REQUEST_EVIDENCE', evidenceType: 'batch_label_photo', target: 'CURRENT_PRODUCT_SUPPLIER' },
  rationale: 'Request trusted batch-label evidence for the current gap.',
  basedOn: { evidenceRefs: [], claimRefs: [], assessmentRefs: [], issueRefs: ['question:batch'], requestRefs: [] },
  expectedInformationGain: 'The label may establish the affected batch.',
  limitations: ['This is advisory only.']
};

class Transport implements OpenAiResponseTransport {
  request: OpenAiStructuredRequest | null = null;
  constructor(private readonly response: unknown, private readonly failure?: Error) {}
  async generate(request: OpenAiStructuredRequest): Promise<unknown> {
    this.request = request;
    if (this.failure) throw this.failure;
    return this.response;
  }
}

describe('Investigator LLM client', () => {
  it('uses strict structured output with no tools and server-owned prompt/model metadata', async () => {
    const transport = new Transport(validOutput);
    const client = new OpenAiInvestigatorLlmClient(transport, { model: 'gpt-test' });
    await expect(client.recommendNextStep(snapshot)).resolves.toEqual(validOutput);
    expect(transport.request).toMatchObject({
      model: 'gpt-test', store: false,
      schemaName: 'verirecall_investigator_recommendation_v1'
    });
    expect(transport.request).not.toHaveProperty('tools');
    expect(transport.request?.instructions).toContain('untrusted DATA');
    expect(transport.request?.input).not.toContain('supplier@example');
  });

  it('returns typed unavailable rather than a fabricated fallback when configuration is absent', async () => {
    const client = createInvestigatorLlmClient({ OPENAI_API_KEY: '', OPENAI_MODEL: 'gpt-test' });
    await expect(client.recommendNextStep(snapshot)).rejects.toMatchObject({
      code: 'INVESTIGATOR_UNAVAILABLE'
    });
  });

  it('maps refusal, timeout, malformed output, and transport failure without leaking bodies', async () => {
    const refusal = new OpenAiInvestigatorLlmClient(new Transport(null), { model: 'gpt-test' });
    await expect(refusal.recommendNextStep(snapshot)).rejects.toMatchObject({
      code: 'INVESTIGATOR_REFUSAL'
    });
    const timeoutError = Object.assign(new Error('secret transport detail'), { name: 'AbortError' });
    const timeout = new OpenAiInvestigatorLlmClient(
      new Transport(null, timeoutError), { model: 'gpt-test' }
    );
    await expect(timeout.recommendNextStep(snapshot)).rejects.toMatchObject({
      code: 'INVESTIGATOR_TIMEOUT', message: 'The Investigator model timed out.'
    });
    const malformed = new OpenAiInvestigatorLlmClient(
      new Transport({ recommendation: { kind: 'CLOSE_CASE' } }), { model: 'gpt-test' }
    );
    await expect(malformed.recommendNextStep(snapshot)).rejects.toMatchObject({
      code: 'INVESTIGATOR_OUTPUT_INVALID'
    });
    const failure = new OpenAiInvestigatorLlmClient(
      new Transport(null, new Error('api-key-value')), { model: 'gpt-test' }
    );
    try {
      await failure.recommendNextStep(snapshot);
      throw new Error('Expected model failure.');
    } catch (error) {
      expect(error).toBeInstanceOf(InvestigatorLlmClientError);
      expect(error).toMatchObject({
        code: 'INVESTIGATOR_MODEL_ERROR', message: 'The Investigator model request failed.'
      });
      expect((error as Error).message).not.toContain('api-key-value');
    }
  });
});
