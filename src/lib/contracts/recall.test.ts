import { describe, expect, it } from 'vitest';
import {
  caseSnapshotSchema, commandResultSchema, contractErrorSchema, humanDecisionSchema,
  investigationOutcomeSchema, quantitySchema, recallCommandSchema, scopeSchema, taskSchema
} from './recall';
import {
  acceptInvestigationExample, confirmedLotOutcome, contractFixtures, demoCaseId,
  makeUncalculatedSnapshot, unknownQuantity, unresolvedScopeOutcome
} from './recall.fixtures';

describe('shared recall contract v1', () => {
  it.each(contractFixtures)('validates $name without asserting uncalculated exposure', ({ outcome, snapshot }) => {
    expect(investigationOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(caseSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.exposure.received.value).toBeNull();
    expect(snapshot.closure.status).toBe('NOT_READY');
  });

  it('rejects unsupported versions, scopes and extra payload fields', () => {
    expect(investigationOutcomeSchema.safeParse({ ...confirmedLotOutcome, schemaVersion: 2 }).success).toBe(false);
    for (const kind of ['WHOLE_PRODUCT', 'DATE_RANGE', 'invented']) {
      expect(scopeSchema.safeParse({ ...confirmedLotOutcome.scope, kind }).success).toBe(false);
    }
    expect(investigationOutcomeSchema.safeParse({ ...confirmedLotOutcome, actorName: 'untrusted' }).success).toBe(false);
    expect(scopeSchema.safeParse({ ...confirmedLotOutcome.scope, lots: [] }).success).toBe(false);
    expect(scopeSchema.safeParse({ ...confirmedLotOutcome.scope, lots: ['L-2403', 'L-2403'] }).success).toBe(false);
  });

  it('keeps identity confirmation independent of missing scope and factual conflict', () => {
    expect(investigationOutcomeSchema.parse(unresolvedScopeOutcome).identity.conclusion).toBe('MATCH');
    expect(investigationOutcomeSchema.safeParse({ ...unresolvedScopeOutcome, knowledgeStatus: 'KNOWN' }).success).toBe(false);
    expect(investigationOutcomeSchema.safeParse({ ...confirmedLotOutcome, conflicts: unresolvedScopeOutcome.gaps }).success).toBe(false);
    expect(investigationOutcomeSchema.safeParse({ ...confirmedLotOutcome, evidenceRefs: [] }).success).toBe(false);
  });

  it('distinguishes measured zero from unknown and requires provenance', () => {
    expect(quantitySchema.parse(unknownQuantity).value).toBeNull();
    expect(quantitySchema.safeParse({ ...unknownQuantity, value: 0 }).success).toBe(false);
    const zero = { value: 0, unit: 'ITEM', knowledgeStatus: 'KNOWN', asOf: confirmedLotOutcome.updatedAt,
      sources: [{ sourceRef: 'demo:stock', sourceType: 'INVENTORY', asOf: confirmedLotOutcome.updatedAt, demo: true }] };
    expect(quantitySchema.parse(zero).value).toBe(0);
    for (const invalid of [{ ...zero, value: -1 }, { ...zero, value: 1.5 }, { ...zero, sources: [] }, { ...zero, unit: 'KG' }, { ...zero, asOf: null }]) {
      expect(quantitySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('rejects mismatched snapshot identity, revisions and contradictory closure', () => {
    const snapshot = makeUncalculatedSnapshot(confirmedLotOutcome);
    for (const invalid of [
      { ...snapshot, materialRevision: 2 }, { ...snapshot, productId: demoCaseId },
      { ...snapshot, stage: 'CLOSED' }, { ...snapshot, pendingDecisions: [{}] },
      { ...snapshot, closure: { status: 'READY_FOR_HUMAN_CLOSURE', blockers: [], decisionRef: null } },
      { ...snapshot, closure: { status: 'NOT_READY', blockers: [], decisionRef: null } }
    ]) expect(caseSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  it('requires concurrency and idempotency keys but never accepts a client actor', () => {
    expect(recallCommandSchema.parse(acceptInvestigationExample)).toEqual(acceptInvestigationExample);
    for (const invalid of [
      { ...acceptInvestigationExample, expectedCaseVersion: undefined },
      { ...acceptInvestigationExample, commandId: undefined },
      { ...acceptInvestigationExample, caseId: confirmedLotOutcome.productId },
      { ...acceptInvestigationExample, actorName: 'admin' }
    ]) expect(recallCommandSchema.safeParse(invalid).success).toBe(false);
  });

  it('validates action, result and closure command examples and rejects absent evidence', () => {
    const base = { schemaVersion: 1, caseId: demoCaseId, commandId: acceptInvestigationExample.commandId, expectedCaseVersion: 1 };
    const commands = [
      { ...base, type: 'DECIDE_ACTION', taskId: demoCaseId, decision: 'APPROVED', rationale: 'Approve demo hold request', evidenceRefs: [] },
      { ...base, type: 'DECIDE_ACTION', taskId: demoCaseId, decision: 'REJECTED', rationale: 'Wrong coverage', evidenceRefs: [] },
      { ...base, type: 'ATTACH_RESULT', taskId: demoCaseId, evidenceRefs: ['demo:hold-result'], summary: 'Demo warehouse receipt', demo: true },
      { ...base, type: 'REQUEST_CLOSURE', evidenceRefs: ['demo:closure-evidence'], rationale: 'Request final human closure' }
    ];
    for (const command of commands) expect(recallCommandSchema.safeParse(command).success).toBe(true);
    for (const command of commands.slice(2)) expect(recallCommandSchema.safeParse({ ...command, evidenceRefs: [] }).success).toBe(false);
  });

  it('does not confuse requested tasks, completed results and human decisions', () => {
    const task = { id: demoCaseId, rule: 'HOLD_STOCK', status: 'OPEN', title: 'Hold demo lot',
      targetRef: 'demo:warehouse', coverage: confirmedLotOutcome.scope, quantity: unknownQuantity,
      basisMaterialRevision: 1, reasonRefs: ['demo:scope'], blockedBy: [], priority: 'HIGH',
      priorityReason: 'Affected inventory', approvalRequired: true, decisionRefs: [],
      resultEvidenceRefs: [], requestStatus: 'REQUESTED', demo: true };
    expect(taskSchema.parse(task).status).toBe('OPEN');
    expect(taskSchema.safeParse({ ...task, status: 'COMPLETED' }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, status: 'APPROVED' }).success).toBe(false);
    const decision = { id: demoCaseId, type: 'APPROVE_ACTION', status: 'PENDING', subjectRef: demoCaseId,
      basisCaseVersion: 1, basisMaterialRevision: 1, coverage: confirmedLotOutcome.scope,
      evidenceRefs: [], rationale: 'Review hold', actorId: null, decidedAt: null, demo: true };
    expect(humanDecisionSchema.safeParse(decision).success).toBe(true);
    expect(humanDecisionSchema.safeParse({ ...decision, status: 'APPROVED' }).success).toBe(false);
  });

  it('validates success/replay and explicit conflict envelopes', () => {
    const error = { code: 'VERSION_CONFLICT', message: 'Refresh the case before retrying.', currentCaseVersion: 2, issueRefs: [] };
    expect(contractErrorSchema.parse(error).code).toBe('VERSION_CONFLICT');
    expect(contractErrorSchema.safeParse({ code: 'UNSUPPORTED_SCOPE', message: 'WHOLE_PRODUCT is not supported in schema v1.', currentCaseVersion: null, issueRefs: [] }).success).toBe(true);
    expect(contractErrorSchema.safeParse({ code: 'CLOSURE_BLOCKED', message: 'Exposure has not been calculated.', currentCaseVersion: 1, issueRefs: ['demo:exposure-missing'] }).success).toBe(true);
    expect(commandResultSchema.safeParse({ ok: false, error }).success).toBe(true);
    expect(commandResultSchema.safeParse({ ok: true, commandId: acceptInvestigationExample.commandId,
      replayed: true, appliedCaseVersion: 1, snapshot: makeUncalculatedSnapshot(confirmedLotOutcome) }).success).toBe(true);
  });
});
