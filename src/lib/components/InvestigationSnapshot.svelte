<script lang="ts">
  import { untrack } from 'svelte';
  import { commandResultSchema, type CaseSnapshot, type RecallCommand } from '$lib/contracts/recall';
  let { snapshot, history, caseNumber }: {
    snapshot: CaseSnapshot;
    history: Array<{ caseVersion: number; materialRevision: number | null; createdAt: string; actorId: string }>;
    caseNumber: string;
  } = $props();

  let currentSnapshot = $state(untrack(() => snapshot));
  let currentHistory = $state(untrack(() => [...history]));
  let busyTaskId = $state<string | null>(null);
  let notice = $state<{ ok: boolean; message: string } | null>(null);
  let rationales = $state<Record<string, string>>({});
  let evidenceRefs = $state<Record<string, string>>({});
  let resultSummaries = $state<Record<string, string>>({});

  const positions = $derived([
    { label: 'Affected received total', quantity: currentSnapshot.exposure.received },
    { label: 'Warehouse', quantity: currentSnapshot.exposure.warehouse },
    { label: 'In transit', quantity: currentSnapshot.exposure.inTransit },
    { label: 'Retailer reported', quantity: currentSnapshot.exposure.retailer },
    { label: 'Sold', quantity: currentSnapshot.exposure.sold },
    { label: 'Unaccounted', quantity: currentSnapshot.exposure.unaccounted }
  ]);

  function quantityLabel(quantity: typeof currentSnapshot.exposure.received): string {
    return quantity.knowledgeStatus === 'KNOWN'
      ? `${quantity.value} ${quantity.unit}`
      : quantity.knowledgeStatus;
  }

  function active(status: string): boolean {
    return !['COMPLETED', 'CANCELLED', 'SUPERSEDED'].includes(status);
  }

  function setField(fields: Record<string, string>, taskId: string, event: Event): void {
    fields[taskId] = (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
  }

  async function executeTask(command: RecallCommand): Promise<void> {
    busyTaskId = 'taskId' in command ? command.taskId : null;
    notice = null;
    try {
      const response = await fetch(`/api/cases/${currentSnapshot.caseId}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command)
      });
      const payload: unknown = await response.json();
      const result = commandResultSchema.safeParse(payload);
      if (!result.success) {
        notice = { ok: false, message: 'The server returned an invalid task response.' };
        return;
      }
      if (!result.data.ok) {
        notice = { ok: false, message: result.data.error.message };
        return;
      }
      currentSnapshot = result.data.snapshot;
      if (!currentHistory.some((item) => item.caseVersion === currentSnapshot.caseVersion)) {
        currentHistory = [...currentHistory, {
          caseVersion: currentSnapshot.caseVersion,
          materialRevision: currentSnapshot.materialRevision,
          createdAt: currentSnapshot.updatedAt,
          actorId: 'demo_operator'
        }];
      }
      notice = { ok: true, message: command.type === 'DECIDE_ACTION'
        ? 'Decision recorded. No request or external action was performed.'
        : command.type === 'REQUEST_ACTION'
          ? 'Demo request recorded. The task remains open until result evidence is attached.'
          : 'Result evidence attached to the task.' };
    } catch {
      notice = { ok: false, message: 'The task command could not be completed.' };
    } finally {
      busyTaskId = null;
    }
  }

  function decide(taskId: string, decision: 'APPROVED' | 'REJECTED'): void {
    const rationale = rationales[taskId]?.trim();
    if (!rationale) {
      notice = { ok: false, message: 'Enter a rationale before recording the decision.' };
      return;
    }
    void executeTask({
      type: 'DECIDE_ACTION', schemaVersion: 1, caseId: currentSnapshot.caseId,
      commandId: crypto.randomUUID(), expectedCaseVersion: currentSnapshot.caseVersion,
      taskId, decision, rationale, evidenceRefs: []
    });
  }

  function requestAction(taskId: string): void {
    void executeTask({
      type: 'REQUEST_ACTION', schemaVersion: 1, caseId: currentSnapshot.caseId,
      commandId: crypto.randomUUID(), expectedCaseVersion: currentSnapshot.caseVersion,
      taskId, demo: true
    });
  }

  function attachResult(taskId: string): void {
    const evidenceRef = evidenceRefs[taskId]?.trim();
    const summary = resultSummaries[taskId]?.trim();
    if (!evidenceRef || !summary) {
      notice = { ok: false, message: 'Enter a result summary and evidence reference.' };
      return;
    }
    void executeTask({
      type: 'ATTACH_RESULT', schemaVersion: 1, caseId: currentSnapshot.caseId,
      commandId: crypto.randomUUID(), expectedCaseVersion: currentSnapshot.caseVersion,
      taskId, evidenceRefs: [evidenceRef], summary, demo: true
    });
  }
</script>

<section class="investigation">
  <a href="/cases">← Cases</a>
  <h1>{caseNumber}</h1>
  <p><span class="badge badge-orange">{currentSnapshot.stage}</span> <span class="badge badge-gray">DEMO ONLY</span></p>
  <p>Case version {currentSnapshot.caseVersion} · Investigation revision {currentSnapshot.materialRevision ?? 'Not received'} · Updated {currentSnapshot.updatedAt}</p>
  <article class="card">
    <h2>Investigation</h2>
    <p>Identity: {currentSnapshot.investigation?.identity.conclusion ?? 'UNRESOLVED'} · {currentSnapshot.investigation?.identity.knowledgeStatus ?? 'UNKNOWN'}</p>
    <p>Scope: {currentSnapshot.investigation?.scope.kind ?? 'UNRESOLVED'} · {currentSnapshot.investigation?.scope.knowledgeStatus ?? 'UNKNOWN'}</p>
    {#if currentSnapshot.investigation?.scope.kind === 'BATCH_LOT'}
      <p>Reported lots: {currentSnapshot.investigation.scope.lots.join(', ')}</p>
    {/if}
    <p>Identity and scope decisions have not been verified. This record does not authorize containment actions.</p>
  </article>
  <article class="card">
    <h2>Exposure</h2>
    {#if currentSnapshot.exposure.status === 'CALCULATED'}
      <p>Calculated from persisted source records for investigation revision {currentSnapshot.exposure.basisMaterialRevision}.</p>
      <dl class="positions">
        {#each positions as position}
          <div>
            <dt>{position.label}</dt>
            <dd>{quantityLabel(position.quantity)}</dd>
            <small>{position.quantity.asOf ?? 'No reliable as-of time'} · {position.quantity.sources.length} source(s)</small>
          </div>
        {/each}
      </dl>
      <p><strong>Contained:</strong> {quantityLabel(currentSnapshot.exposure.contained)}. Containment is a property of units and is not added to their location totals.</p>
      {#if currentSnapshot.exposure.gaps.length}
        <h3>Traceability gaps</h3>
        <ul>{#each currentSnapshot.exposure.gaps as item}<li><strong>{item.code}</strong>: {item.message}</li>{/each}</ul>
      {/if}
      {#if currentSnapshot.exposure.conflicts.length}
        <h3>Quantity conflicts</h3>
        <ul>{#each currentSnapshot.exposure.conflicts as item}<li><strong>{item.code}</strong>: {item.message}</li>{/each}</ul>
      {/if}
    {:else}
      <p>Unknown — not calculated. No affected quantity has been established.</p>
    {/if}
    <p>Task rules are recalculated from the current exposure. Completing a task does not remove its underlying exposure gap.</p>
  </article>
  <article class="card">
    <h2>Dynamic tasks</h2>
    <p>Approval, recording a demo request and attaching result evidence are separate steps. No email, inventory update or shipment action is performed here.</p>
    {#if notice}<p class:notice-error={!notice.ok} class="notice" role="status">{notice.message}</p>{/if}
    {#if currentSnapshot.tasks.length}
      <div class="task-list">
        {#each currentSnapshot.tasks as task}
          <section class:task-inactive={!active(task.status)} class="task-item">
            <header><div><strong>{task.title}</strong><small>{task.type} · {task.targetRef}</small></div><span class="badge badge-gray">{task.status}</span></header>
            <p>{quantityLabel(task.quantity)} · {task.priority}: {task.priorityReason}</p>
            <p><strong>Coverage:</strong> {task.coverage.kind === 'BATCH_LOT' ? task.coverage.lots.join(', ') : task.coverage.reason}</p>
            <p><strong>Basis:</strong> {task.sourceRefs.join(', ')}</p>
            <p><strong>Approval:</strong> {task.approvalRequired ? task.approvalStatus : 'NOT_REQUIRED'} · <strong>Request:</strong> {task.requestStatus}</p>
            {#if task.statusReason}<p><strong>Status reason:</strong> {task.statusReason}</p>{/if}
            <details><summary>Review draft</summary><p><strong>{task.draft.subject}</strong></p><pre>{task.draft.body}</pre></details>
            {#if task.approvalStatus === 'PENDING' && active(task.status)}
              <label>Decision rationale<input value={rationales[task.id] ?? ''} oninput={(event) => setField(rationales, task.id, event)} placeholder="Why is this action appropriate?" /></label>
              <div class="task-actions">
                <button type="button" disabled={busyTaskId !== null} onclick={() => decide(task.id, 'APPROVED')}>Approve</button>
                <button type="button" disabled={busyTaskId !== null} onclick={() => decide(task.id, 'REJECTED')}>Reject</button>
              </div>
            {:else if active(task.status) && task.requestStatus === 'NOT_REQUESTED'}
              <button type="button" disabled={busyTaskId !== null} onclick={() => requestAction(task.id)}>Record demo request</button>
            {:else if active(task.status) && task.requestStatus === 'REQUESTED'}
              <label>Result summary<input value={resultSummaries[task.id] ?? ''} oninput={(event) => setField(resultSummaries, task.id, event)} placeholder="What was confirmed?" /></label>
              <label>Evidence reference<input value={evidenceRefs[task.id] ?? ''} oninput={(event) => setField(evidenceRefs, task.id, event)} placeholder="demo:evidence:reference" /></label>
              <button type="button" disabled={busyTaskId !== null} onclick={() => attachResult(task.id)}>Attach result evidence</button>
            {/if}
          </section>
        {/each}
      </div>
    {:else}
      <p>No task rule currently has enough evidence to create a task.</p>
    {/if}
  </article>
  <article class="card">
    <h2>Requires review</h2>
    <p>Closure: {currentSnapshot.closure.status}</p>
    <ul>{#each currentSnapshot.attentionItems as item}<li><strong>{item.code}</strong>: {item.message}</li>{/each}</ul>
  </article>
  <article class="card">
    <h2>Saved history</h2>
    <ol>{#each currentHistory as revision}<li>Case v{revision.caseVersion} · Investigation {revision.materialRevision ?? 'not received'} · {revision.createdAt} · {revision.actorId}</li>{/each}</ol>
  </article>
  <a href={`/api/cases/${currentSnapshot.caseId}/snapshot`}>View snapshot JSON</a>
</section>

<style>
  .investigation { max-width: 1000px; margin: 0 auto; padding: 16px; overflow-wrap: anywhere; }
  h1 { font-size: 28px; margin: 16px 0; }
  h2 { font-size: 20px; margin-bottom: 12px; }
  h3 { font-size: 17px; margin: 20px 0 8px; }
  p, li { font-size: 16px; line-height: 1.6; }
  article { padding: 24px; margin: 20px 0; }
  ul, ol { padding-left: 24px; }
  .positions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
  .positions div { border: 1px solid #e8e3ef; border-radius: 10px; padding: 14px; }
  dt, small { color: #716b7b; }
  dd { margin: 6px 0; font-size: 20px; font-weight: 700; }
  .notice { border-radius: 8px; padding: 10px 12px; background: #ecfdf3; color: #166534; }
  .notice-error { background: #fff1f2; color: #9f1239; }
  .task-list { display: grid; gap: 14px; margin-top: 18px; }
  .task-item { border: 1px solid #e8e3ef; border-radius: 10px; padding: 16px; }
  .task-item header { display: flex; justify-content: space-between; gap: 12px; }
  .task-item header div { display: grid; gap: 4px; }
  .task-inactive { opacity: .72; }
  .task-actions { display: flex; gap: 8px; }
  .task-item label { display: grid; gap: 5px; margin: 12px 0; font-weight: 600; }
  .task-item input { width: 100%; border: 1px solid #cfc7d8; border-radius: 8px; padding: 9px 10px; font: inherit; }
  .task-item button { border: 1px solid #6750a4; border-radius: 8px; padding: 8px 12px; color: #4d3485; font-weight: 700; }
  .task-item button:disabled { opacity: .55; }
  details { margin: 12px 0; }
  summary { cursor: pointer; font-weight: 700; }
  pre { white-space: pre-wrap; font: inherit; color: #4d4655; }
  a { text-decoration: underline; }
  @media (max-width: 680px) { .positions { grid-template-columns: 1fr; } }
</style>
