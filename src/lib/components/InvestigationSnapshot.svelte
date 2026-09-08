<script lang="ts">
  import { untrack } from 'svelte';

  import Icon from '$lib/components/Icon.svelte';
  import WorkflowBreadcrumbs from '$lib/components/WorkflowBreadcrumbs.svelte';
  import {
    commandResultSchema,
    type CaseSnapshot,
    type RecallCommand,
    type TraceabilityRecord
  } from '$lib/contracts/recall';

  let { snapshot, history, caseNumber, productName }: {
    snapshot: CaseSnapshot;
    history: Array<{ caseVersion: number; materialRevision: number | null; createdAt: string; actorId: string }>;
    caseNumber: string;
    productName: string;
  } = $props();

  let currentSnapshot = $state(untrack(() => snapshot));
  let currentHistory = $state(untrack(() => [...history]));
  let busy = $state(false);
  let busyTaskId = $state<string | null>(null);
  let notice = $state<{ ok: boolean; message: string } | null>(null);
  let rationales = $state<Record<string, string>>({});
  let evidenceRefs = $state<Record<string, string>>({});
  let resultSummaries = $state<Record<string, string>>({});
  let closureRationale = $state('');
  let closureEvidence = $state(untrack(() => snapshot.tasks
    .filter((task) => task.blocking && task.status === 'COMPLETED')
    .flatMap((task) => task.resultEvidenceRefs)
    .join(', ')));
  const demoRecordedAt = new Date().toISOString();

  const positions = $derived([
    { label: 'Received from supplier', quantity: currentSnapshot.exposure.received },
    { label: 'Currently in warehouse', quantity: currentSnapshot.exposure.warehouse },
    { label: 'In transit', quantity: currentSnapshot.exposure.inTransit },
    { label: 'Reported by retailers', quantity: currentSnapshot.exposure.retailer },
    { label: 'Sold to customers', quantity: currentSnapshot.exposure.sold },
    { label: 'Location not explained', quantity: currentSnapshot.exposure.unaccounted }
  ]);
  const investigationReviews = $derived(currentSnapshot.pendingDecisions.filter((decision) =>
    decision.type === 'CONFIRM_IDENTITY' || decision.type === 'CONFIRM_SCOPE'
  ));
  const requiredClosureEvidence = $derived(currentSnapshot.tasks
    .filter((task) => task.blocking && task.status === 'COMPLETED')
    .flatMap((task) => task.resultEvidenceRefs));
  const reviewsApproved = $derived(
    investigationReviews.length === 0 &&
      ['CONFIRM_IDENTITY', 'CONFIRM_SCOPE'].every((type) => currentSnapshot.decisions.some((decision) =>
        decision.type === type && decision.status === 'APPROVED' &&
        decision.basisMaterialRevision === currentSnapshot.materialRevision
      ))
  );
  const exposureCalculated = $derived(currentSnapshot.exposure.status === 'CALCULATED');
  const activeTasks = $derived(currentSnapshot.tasks.filter((task) => active(task.status)));
  const completedDemoHold = $derived(currentSnapshot.tasks.some((task) =>
    task.type === 'HOLD_STOCK' && task.status === 'COMPLETED' &&
    task.sourceRefs.some((reference) => reference.startsWith(`demo:case-ui:${currentSnapshot.caseId}:`))
  ));
  const demoContainmentOutstanding = $derived(
    currentSnapshot.demo && exposureCalculated && completedDemoHold &&
    currentSnapshot.exposure.received.knowledgeStatus === 'KNOWN' &&
    (currentSnapshot.exposure.received.value ?? 0) > 0 &&
    (currentSnapshot.exposure.contained.knowledgeStatus !== 'KNOWN' ||
      (currentSnapshot.exposure.contained.value ?? 0) < (currentSnapshot.exposure.received.value ?? 0))
  );
  const currentAction = $derived(nextAction());

  function stageLabel(stage: CaseSnapshot['stage']): string {
    return {
      INVESTIGATING: 'Investigation in progress',
      RESPONDING: 'Response actions in progress',
      CONTAINED: 'Affected stock contained',
      CLOSURE_REVIEW: 'Ready for closure review',
      CLOSED: 'Case closed'
    }[stage];
  }

  function stageClass(stage: CaseSnapshot['stage']): string {
    if (stage === 'CLOSED' || stage === 'CONTAINED') return 'badge-green';
    if (stage === 'CLOSURE_REVIEW') return 'badge-purple';
    return 'badge-orange';
  }

  function knowledgeLabel(status: string): string {
    return {
      KNOWN: 'Confirmed from available records',
      UNKNOWN: 'No reliable data yet',
      PENDING: 'Waiting for evidence',
      CONFLICTED: 'Records conflict',
      UNRESOLVED: 'Not resolved'
    }[status] ?? status;
  }

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short'
    }).format(new Date(value));
  }

  function quantityLabel(quantity: typeof currentSnapshot.exposure.received): string {
    return quantity.knowledgeStatus === 'KNOWN'
      ? `${quantity.value} ${quantity.value === 1 ? 'item' : 'items'}`
      : knowledgeLabel(quantity.knowledgeStatus);
  }

  function active(status: string): boolean {
    return !['COMPLETED', 'CANCELLED', 'SUPERSEDED'].includes(status);
  }

  function coverageLabel(): string {
    const scope = currentSnapshot.investigation?.scope;
    if (!scope || scope.kind === 'UNRESOLVED') return 'The affected batch is not established yet';
    return scope.lots.length === 1 ? `Batch ${scope.lots[0]}` : `Batches ${scope.lots.join(', ')}`;
  }

  function evidenceLabel(reference: string): string {
    if (reference.includes('alert-batch')) return 'Batch shown in the safety warning';
    if (reference.includes('catalogue-batch')) return 'Batch stored in the product catalogue';
    if (reference.includes('alert:')) return 'Official safety warning';
    if (reference.includes('catalogue:')) return 'Internal catalogue record';
    if (reference.includes('match:')) return 'Product match comparison';
    return reference;
  }

  function reviewTitle(type: string): string {
    return type === 'CONFIRM_IDENTITY'
      ? 'Is this warning about the same product?'
      : 'Is this the correct affected batch?';
  }

  function reviewInstructions(type: string): string[] {
    return type === 'CONFIRM_IDENTITY'
      ? ['Compare the product name and brand.', 'Check the EAN / barcode when one is available.', 'Confirm only if the records describe the same item.']
      : ['Compare the batch in the warning with the catalogue record.', `Check that ${coverageLabel()} is the boundary you intend to act on.`, 'If the evidence disagrees or is incomplete, choose “Cannot confirm”.'];
  }

  function rationalePlaceholder(type: string): string {
    return type === 'CONFIRM_IDENTITY'
      ? 'Example: Product name, brand and EAN match the catalogue record.'
      : `Example: I compared the warning and catalogue; ${coverageLabel()} matches both.`;
  }

  function taskStatusLabel(status: string): string {
    return {
      OPEN: 'Ready to review',
      IN_PROGRESS: 'Waiting for a result',
      BLOCKED: 'Blocked',
      COMPLETED: 'Completed',
      CANCELLED: 'Cancelled',
      SUPERSEDED: 'Replaced by newer scope'
    }[status] ?? status;
  }

  function nextAction(): { title: string; detail: string; href: string | null } {
    const pending = investigationReviews[0];
    if (pending) return {
      title: pending.type === 'CONFIRM_IDENTITY' ? 'Confirm the product match' : 'Confirm the affected batch',
      detail: 'Review the evidence below, leave a short note about what you checked, then confirm or flag the issue.',
      href: '#review-step'
    };
    if (!reviewsApproved) return {
      title: 'Resolve the investigation decision',
      detail: 'A previous review did not approve the current product or batch boundary. More evidence is required.',
      href: '#closure-step'
    };
    if (!exposureCalculated) return {
      title: reviewsApproved ? 'Load the demo stock records' : 'Load stock and distribution evidence',
      detail: reviewsApproved
        ? 'Use the demonstration records below to continue this local case through a real exposure calculation.'
        : 'The system still needs receipts, current stock, shipments and sales. You are not expected to enter a guessed quantity here.',
      href: '#exposure-step'
    };
    if (demoContainmentOutstanding) return {
      title: 'Record the verified containment result',
      detail: 'The hold action is complete, but the stock record still needs evidence that all affected items were isolated.',
      href: '#exposure-step'
    };
    if (activeTasks.length) return {
      title: activeTasks[0].title,
      detail: 'Review the proposed action below. Approval, sending a demo request and confirming its result are separate steps.',
      href: '#tasks-step'
    };
    if (currentSnapshot.closure.status === 'READY_FOR_HUMAN_CLOSURE') return {
      title: 'Review and close this case',
      detail: 'All automated checks pass for the current version. Closure still needs your final reason and supporting evidence.',
      href: '#closure-step'
    };
    if (currentSnapshot.closure.status === 'CLOSED') return {
      title: 'No action required',
      detail: 'This case is closed. New material evidence can reopen it.',
      href: null
    };
    return {
      title: 'Review the remaining blockers',
      detail: 'The case cannot be closed until the items below are resolved.',
      href: '#closure-step'
    };
  }

  function stepState(step: number): 'done' | 'current' | 'waiting' {
    if (step === 1) return currentSnapshot.investigation ? 'done' : 'current';
    if (step === 2) return reviewsApproved ? 'done' : 'current';
    if (step === 3) return exposureCalculated ? 'done' : reviewsApproved ? 'current' : 'waiting';
    if (currentSnapshot.stage === 'CLOSED') return 'done';
    return exposureCalculated ? 'current' : 'waiting';
  }

  function setField(fields: Record<string, string>, taskId: string, event: Event): void {
    fields[taskId] = (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
  }

  async function executeTask(command: RecallCommand): Promise<void> {
    if (busy) return;
    busy = true;
    busyTaskId = 'taskId' in command ? command.taskId
      : 'decisionId' in command ? command.decisionId
        : command.type === 'REQUEST_CLOSURE' ? command.caseId : null;
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
        notice = { ok: false, message: 'The server returned an invalid case response.' };
        return;
      }
      if (!result.data.ok) {
        notice = { ok: false, message: result.data.error.message };
        return;
      }
      currentSnapshot = result.data.snapshot;
      if (command.type === 'ATTACH_RESULT' && !closureEvidence.trim()) {
        closureEvidence = command.evidenceRefs.join(', ');
      }
      if (!currentHistory.some((item) => item.caseVersion === currentSnapshot.caseVersion)) {
        currentHistory = [...currentHistory, {
          caseVersion: currentSnapshot.caseVersion,
          materialRevision: currentSnapshot.materialRevision,
          createdAt: currentSnapshot.updatedAt,
          actorId: 'demo_operator'
        }];
      }
      notice = { ok: true, message: command.type === 'CALCULATE_EXPOSURE'
        ? command.records.some((record) => record.type === 'CONTAINMENT')
          ? 'The demonstration containment evidence was saved and exposure was recalculated.'
          : 'The demonstration stock records were saved and exposure was calculated.'
        : command.type === 'DECIDE_INVESTIGATION'
          ? 'Your review was saved. The case has been updated with your decision.'
        : command.type === 'DECIDE_ACTION'
          ? 'Your decision was saved. No request has been sent yet.'
          : command.type === 'REQUEST_ACTION'
            ? 'The demo request was recorded. This action stays open until you attach the result.'
            : command.type === 'REQUEST_CLOSURE'
              ? 'The case was closed after checking the latest information.'
              : 'The result and its evidence were attached to the action.' };
    } catch {
      notice = { ok: false, message: 'The case update could not be completed. Please try again.' };
    } finally {
      busy = false;
      busyTaskId = null;
    }
  }

  function demoScopeLot(): string | null {
    const scope = currentSnapshot.investigation?.scope;
    return scope?.kind === 'BATCH_LOT' && scope.lots.length === 1 ? scope.lots[0] : null;
  }

  function loadDemoTraceability(): void {
    const lot = demoScopeLot();
    if (!currentSnapshot.demo || !reviewsApproved || !lot) {
      notice = { ok: false, message: 'Confirm one affected batch before loading the demonstration records.' };
      return;
    }
    const prefix = `demo:case-ui:${currentSnapshot.caseId}:r${currentSnapshot.materialRevision}:${encodeURIComponent(lot)}`;
    const productId = currentSnapshot.productId;
    const common = { productId, lot, occurredAt: demoRecordedAt, demo: true } as const;
    const records: TraceabilityRecord[] = [
      { ...common, type: 'RECEIPT', sourceRef: `${prefix}:receipt`, receiptRef: `DEMO-RECEIPT-${lot}`, quantity: 100 },
      { ...common, type: 'INVENTORY', sourceRef: `${prefix}:inventory`, locationRef: 'warehouse:DUB', quantity: 100 },
      { ...common, type: 'SHIPMENT', sourceRef: `${prefix}:shipment`, shipmentRef: `DEMO-SHIPMENT-${lot}`, destinationRef: 'retailer:DUB', quantity: 0, status: 'RETURNED' },
      { ...common, type: 'RETAILER_RESPONSE', sourceRef: `${prefix}:retailer`, retailerRef: 'retailer:DUB', quantity: 0 },
      { ...common, type: 'SALE', sourceRef: `${prefix}:sale`, saleRef: `DEMO-SALES-${lot}`, quantity: 0 }
    ];
    void executeTask({
      type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: currentSnapshot.caseId,
      commandId: crypto.randomUUID(), expectedCaseVersion: currentSnapshot.caseVersion, records
    });
  }

  function recordDemoContainment(): void {
    const lot = demoScopeLot();
    const quantity = currentSnapshot.exposure.received.value;
    if (!currentSnapshot.demo || !lot || currentSnapshot.exposure.received.knowledgeStatus !== 'KNOWN' || quantity === null) {
      notice = { ok: false, message: 'The affected total must be known before containment can be recorded.' };
      return;
    }
    const record: TraceabilityRecord = {
      type: 'CONTAINMENT',
      sourceRef: `demo:case-ui:${currentSnapshot.caseId}:r${currentSnapshot.materialRevision}:${encodeURIComponent(lot)}:containment`,
      productId: currentSnapshot.productId,
      lot,
      occurredAt: demoRecordedAt,
      demo: true,
      locationRef: 'warehouse:DUB',
      quantity
    };
    void executeTask({
      type: 'CALCULATE_EXPOSURE', schemaVersion: 1, caseId: currentSnapshot.caseId,
      commandId: crypto.randomUUID(), expectedCaseVersion: currentSnapshot.caseVersion, records: [record]
    });
  }

  function decide(taskId: string, decision: 'APPROVED' | 'REJECTED'): void {
    const rationale = rationales[taskId]?.trim();
    if (!rationale) {
      notice = { ok: false, message: 'Add a short note explaining your decision.' };
      return;
    }
    void executeTask({
      type: 'DECIDE_ACTION', schemaVersion: 1, caseId: currentSnapshot.caseId,
      commandId: crypto.randomUUID(), expectedCaseVersion: currentSnapshot.caseVersion,
      taskId, decision, rationale,
      evidenceRefs: currentSnapshot.tasks.find((task) => task.id === taskId)?.sourceRefs ?? [],
      demo: true
    });
  }

  function decideInvestigation(decisionId: string, result: 'APPROVED' | 'REJECTED'): void {
    const rationale = rationales[decisionId]?.trim();
    const pending = currentSnapshot.pendingDecisions.find((decision) => decision.id === decisionId);
    if (!rationale || !pending) {
      notice = { ok: false, message: 'Add a short note describing what you checked.' };
      return;
    }
    void executeTask({
      type: 'DECIDE_INVESTIGATION', schemaVersion: 1, caseId: currentSnapshot.caseId,
      commandId: crypto.randomUUID(), expectedCaseVersion: currentSnapshot.caseVersion,
      decisionId, decision: result, rationale, evidenceRefs: pending.evidenceRefs, demo: true
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
      notice = { ok: false, message: 'Describe the result and add its evidence reference.' };
      return;
    }
    void executeTask({
      type: 'ATTACH_RESULT', schemaVersion: 1, caseId: currentSnapshot.caseId,
      commandId: crypto.randomUUID(), expectedCaseVersion: currentSnapshot.caseVersion,
      taskId, evidenceRefs: [evidenceRef], summary, demo: true
    });
  }

  function closeCase(): void {
    const rationale = closureRationale.trim();
    const refs = closureEvidence.split(',').map((ref) => ref.trim()).filter(Boolean);
    if (!rationale || !refs.length) {
      notice = { ok: false, message: 'Explain why the case can close and provide existing result evidence.' };
      return;
    }
    void executeTask({
      type: 'REQUEST_CLOSURE', schemaVersion: 1, caseId: currentSnapshot.caseId,
      commandId: crypto.randomUUID(), expectedCaseVersion: currentSnapshot.caseVersion,
      rationale, evidenceRefs: refs, demo: true
    });
  }
</script>

<section class="investigation">
  <WorkflowBreadcrumbs items={[{ label: 'Cases', href: '/cases' }, { label: caseNumber }]} />

  <header class="case-heading">
    <div>
      <div class="case-heading__badges">
        <span class={`badge ${stageClass(currentSnapshot.stage)}`}>{stageLabel(currentSnapshot.stage)}</span>
        <span class="badge badge-gray">Demo case</span>
      </div>
      <h1>{caseNumber}</h1>
      <p class="product-name">{productName}</p>
      <p class="updated">Last updated {formatDate(currentSnapshot.updatedAt)}</p>
    </div>
    <a class="back-link" href="/cases"><Icon name="arrow-left" size={15} /> All cases</a>
  </header>

  <section class="next-action" aria-labelledby="next-action-title">
    <span class="next-action__icon"><Icon name="arrow-right" size={20} /></span>
    <div>
      <span class="eyebrow">What to do now</span>
      <h2 id="next-action-title">{currentAction.title}</h2>
      <p>{currentAction.detail}</p>
    </div>
    {#if currentAction.href}<a href={currentAction.href}>Go to this step</a>{/if}
  </section>

  {#if notice}
    <p class:notice--error={!notice.ok} class="notice" role="status">
      <Icon name={notice.ok ? 'circle-check-big' : 'triangle-alert'} size={17} />
      {notice.message}
    </p>
  {/if}

  <ol class="journey" aria-label="Case progress">
    {#each [
      { number: 1, title: 'Product matched', detail: 'The warning is linked to a catalogue item.' },
      { number: 2, title: 'Human review', detail: 'Confirm the product and affected batch.' },
      { number: 3, title: 'Affected stock', detail: 'Calculate where every affected item is.' },
      { number: 4, title: 'Actions and closure', detail: 'Complete actions and review closure.' }
    ] as step}
      <li class:journey__done={stepState(step.number) === 'done'} class:journey__current={stepState(step.number) === 'current'}>
        <span>{stepState(step.number) === 'done' ? '✓' : step.number}</span>
        <div><strong>{step.title}</strong><small>{step.detail}</small></div>
      </li>
    {/each}
  </ol>

  <article class="card section-card" id="review-step">
    <header class="section-heading">
      <span class="section-number">1</span>
      <div>
        <span class="eyebrow">Confirm what is affected</span>
        <h2>Review the investigation</h2>
        <p>The system found a likely match. A person must verify it before response work can rely on it.</p>
      </div>
    </header>

    <div class="finding-grid">
      <section>
        <span>Product identity</span>
        <strong>{currentSnapshot.investigation?.identity.conclusion === 'MATCH' ? 'Likely the same product' : 'Product match unresolved'}</strong>
        <small>{knowledgeLabel(currentSnapshot.investigation?.identity.knowledgeStatus ?? 'UNKNOWN')}</small>
      </section>
      <section>
        <span>Affected boundary</span>
        <strong>{coverageLabel()}</strong>
        <small>{knowledgeLabel(currentSnapshot.investigation?.scope.knowledgeStatus ?? 'UNKNOWN')}</small>
      </section>
    </div>

    {#if investigationReviews.length}
      <div class="decision-list">
        {#each investigationReviews as decision}
          <section class="review-decision">
            <header>
              <div>
                <span class="badge badge-orange">Your review is required</span>
                <h3>{reviewTitle(decision.type)}</h3>
              </div>
              <Icon name="file-text" size={22} />
            </header>

            <p class="review-intro">Use the checklist, then record what you verified. Confirming the boundary does not erase missing or conflicting facts.</p>
            <ul class="checklist">
              {#each reviewInstructions(decision.type) as instruction}
                <li><Icon name="check" size={14} /> {instruction}</li>
              {/each}
            </ul>

            {#if decision.uncertaintyRefs.length || decision.conflictRefs.length}
              <div class="warning-box">
                <Icon name="triangle-alert" size={17} />
                <div><strong>Evidence needs extra care</strong><p>This decision has {decision.uncertaintyRefs.length} unresolved uncertainty item(s) and {decision.conflictRefs.length} conflict(s).</p></div>
              </div>
            {/if}

            <details class="evidence-details">
              <summary>Evidence available for this decision</summary>
              <ul>{#each decision.evidenceRefs as reference}<li>{evidenceLabel(reference)}</li>{/each}</ul>
            </details>

            <label for={`rationale-${decision.id}`}>
              <span>What did you check?</span>
              <textarea
                id={`rationale-${decision.id}`}
                value={rationales[decision.id] ?? ''}
                oninput={(event) => setField(rationales, decision.id, event)}
                placeholder={rationalePlaceholder(decision.type)}
                rows="3"
              ></textarea>
              <small>A short plain-language note becomes part of the audit history.</small>
            </label>
            <div class="task-actions">
              <button class="btn btn-primary" type="button" disabled={busy} onclick={() => decideInvestigation(decision.id, 'APPROVED')}>
                {busyTaskId === decision.id ? 'Saving…' : decision.type === 'CONFIRM_IDENTITY' ? 'Confirm product match' : 'Confirm affected batch'}
              </button>
              <button class="btn btn-secondary" type="button" disabled={busy} onclick={() => decideInvestigation(decision.id, 'REJECTED')}>Cannot confirm</button>
            </div>
          </section>
        {/each}
      </div>
    {:else if reviewsApproved}
      <div class="success-box"><Icon name="circle-check-big" size={19} /><div><strong>Product and affected batch reviewed</strong><p>The current investigation boundary has human approval.</p></div></div>
    {:else}
      <div class="warning-box"><Icon name="triangle-alert" size={19} /><div><strong>The investigation still needs resolution</strong><p>A recorded decision did not approve the current boundary. Add better evidence before continuing.</p></div></div>
    {/if}
  </article>

  <article class="card section-card" id="exposure-step">
    <header class="section-heading">
      <span class="section-number">2</span>
      <div>
        <span class="eyebrow">Understand the impact</span>
        <h2>Where is the affected stock?</h2>
        <p>Receipts, warehouse stock, shipments, retailer reports and sales are reconciled without guessing.</p>
      </div>
    </header>

    {#if exposureCalculated}
      <dl class="positions">
        {#each positions as position}
          <div class:position--unknown={position.quantity.knowledgeStatus !== 'KNOWN'}>
            <dt>{position.label}</dt>
            <dd>{quantityLabel(position.quantity)}</dd>
            <small>{position.quantity.asOf ? `Current as of ${formatDate(position.quantity.asOf)}` : 'No reliable date available'}</small>
          </div>
        {/each}
      </dl>
      <p class="contained"><Icon name="shield-check" size={17} /> <strong>Confirmed contained:</strong> {quantityLabel(currentSnapshot.exposure.contained)}</p>
      {#if demoContainmentOutstanding}
        <div class="demo-step">
          <div>
            <span class="badge badge-purple">Local demo</span>
            <h3>Record the containment evidence</h3>
            <p>The hold task has a verified result. Save the matching warehouse containment record so the exposure calculation can prove that all {currentSnapshot.exposure.received.value} affected items are isolated.</p>
          </div>
          <button class="btn btn-primary" type="button" disabled={busy} onclick={recordDemoContainment}>
            {busy ? 'Saving…' : `Record ${currentSnapshot.exposure.received.value} contained items`}
          </button>
        </div>
      {/if}
      {#if currentSnapshot.exposure.gaps.length || currentSnapshot.exposure.conflicts.length}
        <div class="warning-box"><Icon name="triangle-alert" size={19} /><div><strong>Some stock is still not explained</strong><ul>{#each [...currentSnapshot.exposure.gaps, ...currentSnapshot.exposure.conflicts] as item}<li>{item.message}</li>{/each}</ul></div></div>
      {/if}
    {:else}
      <div class="empty-step">
        <span><Icon name="package" size={24} /></span>
        <div>
          <h3>Affected quantities have not been calculated yet</h3>
          <p>The prototype is waiting for stock and movement records. You do not need to type a number or treat missing data as zero.</p>
          <ul>
            <li>Supplier receipts for {coverageLabel()}</li>
            <li>Current warehouse and shipment records</li>
            <li>Retailer confirmations and recorded sales</li>
          </ul>
          <small>In the current demo, these records are loaded through the traceability demo/API before response tasks appear.</small>
          {#if currentSnapshot.demo && reviewsApproved && demoScopeLot()}
            <div class="demo-loader">
              <p><strong>Continue the local demo:</strong> load a synthetic receipt and current stock position for 100 items in {coverageLabel()}. This uses the real exposure service and creates a real hold-stock task. It does not contact an external system.</p>
              <button class="btn btn-primary" type="button" disabled={busy} onclick={loadDemoTraceability}>
                {busy ? 'Loading…' : 'Load demo stock records'}
              </button>
            </div>
          {:else}
            <p class="waiting-note"><strong>Finish the product and batch review above before stock records can be loaded.</strong></p>
          {/if}
        </div>
      </div>
    {/if}
  </article>

  <article class="card section-card" id="tasks-step">
    <header class="section-heading">
      <span class="section-number">3</span>
      <div>
        <span class="eyebrow">Respond safely</span>
        <h2>Required actions</h2>
        <p>Each action has three separate steps: approve it, record the demo request, then attach evidence of the result.</p>
      </div>
    </header>

    {#if currentSnapshot.tasks.length}
      <div class="task-list">
        {#each currentSnapshot.tasks as task}
          <section class:task-inactive={!active(task.status)} class="task-item">
            <header>
              <div><h3>{task.title}</h3><p>{task.priorityReason}</p></div>
              <span class={`badge ${task.status === 'COMPLETED' ? 'badge-green' : task.status === 'BLOCKED' ? 'badge-orange' : 'badge-gray'}`}>{taskStatusLabel(task.status)}</span>
            </header>
            <dl class="task-summary">
              <div><dt>Quantity</dt><dd>{quantityLabel(task.quantity)}</dd></div>
              <div><dt>Covers</dt><dd>{task.coverage.kind === 'BATCH_LOT' ? task.coverage.lots.join(', ') : task.coverage.reason}</dd></div>
              <div><dt>Approval</dt><dd>{task.approvalRequired ? (task.approvalStatus ?? 'PENDING').toLowerCase() : 'Not required'}</dd></div>
              <div><dt>Request</dt><dd>{task.requestStatus === 'REQUESTED' ? 'Recorded' : 'Not recorded'}</dd></div>
            </dl>
            {#if task.statusReason}<p class="status-reason">{task.statusReason}</p>{/if}
            <details class="evidence-details"><summary>Preview the prepared message</summary><p><strong>{task.draft.subject}</strong></p><pre>{task.draft.body}</pre></details>

            {#if task.approvalStatus === 'PENDING' && active(task.status)}
              <label for={`task-rationale-${task.id}`}><span>Why is this action appropriate?</span><textarea id={`task-rationale-${task.id}`} value={rationales[task.id] ?? ''} oninput={(event) => setField(rationales, task.id, event)} placeholder="Example: Current warehouse records show affected stock that must be held." rows="3"></textarea></label>
              <div class="task-actions">
                <button class="btn btn-primary" type="button" disabled={busy} onclick={() => decide(task.id, 'APPROVED')}>Approve action</button>
                <button class="btn btn-secondary" type="button" disabled={busy} onclick={() => decide(task.id, 'REJECTED')}>Reject action</button>
              </div>
            {:else if active(task.status) && task.requestStatus === 'NOT_REQUESTED'}
              <p class="action-help">Approval is recorded. The next click records a demo request; it does not contact an external system.</p>
              <button class="btn btn-primary" type="button" disabled={busy} onclick={() => requestAction(task.id)}>Record demo request</button>
            {:else if active(task.status) && task.requestStatus === 'REQUESTED'}
              <p class="action-help">The request is recorded, but the action is not complete until its result is verified.</p>
              <label for={`result-${task.id}`}><span>What result was confirmed?</span><input id={`result-${task.id}`} value={resultSummaries[task.id] ?? ''} oninput={(event) => setField(resultSummaries, task.id, event)} placeholder="Example: Warehouse confirmed that 17 items are isolated." /></label>
              <label for={`evidence-${task.id}`}><span>Evidence reference</span><input id={`evidence-${task.id}`} value={evidenceRefs[task.id] ?? ''} oninput={(event) => setField(evidenceRefs, task.id, event)} placeholder="demo:evidence:warehouse-confirmation" /><small>Use the reference for the document or record that proves the result.</small></label>
              <button class="btn btn-primary" type="button" disabled={busy} onclick={() => attachResult(task.id)}>Attach result and complete</button>
            {/if}
          </section>
        {/each}
      </div>
    {:else}
      <div class="empty-step compact"><span><Icon name="file-text" size={23} /></span><div><h3>No actions yet</h3><p>Actions are created after affected stock is calculated. This prevents the system from suggesting work based on guessed quantities.</p></div></div>
    {/if}
  </article>

  <article class="card section-card" id="closure-step">
    <header class="section-heading">
      <span class="section-number">4</span>
      <div>
        <span class="eyebrow">Finish the response</span>
        <h2>Closure check</h2>
        <p>The case can close only when the latest evidence, decisions and required actions all support it.</p>
      </div>
    </header>

    {#if currentSnapshot.closure.status === 'CLOSED'}
      <div class="success-box"><Icon name="shield-check" size={20} /><div><strong>This case is closed</strong><p>It was closed by a separate human decision. New material evidence can reopen it.</p></div></div>
    {:else if currentSnapshot.closure.status === 'READY_FOR_HUMAN_CLOSURE'}
      <div class="success-box"><Icon name="circle-check-big" size={20} /><div><strong>All readiness checks pass</strong><p>Review the current case once more and record why it can be closed.</p></div></div>
      {#if requiredClosureEvidence.length}<p class="required-evidence"><strong>Result evidence available:</strong> {requiredClosureEvidence.join(', ')}</p>{/if}
      <label for="closure-rationale"><span>Why can this case be closed?</span><textarea id="closure-rationale" bind:value={closureRationale} placeholder="Explain how the affected stock and required actions were verified." rows="3"></textarea></label>
      <label for="closure-evidence"><span>Evidence references used for closure</span><input id="closure-evidence" bind:value={closureEvidence} placeholder="demo:result:warehouse-confirmation" /><small>Use existing result references, separated by commas.</small></label>
      <button class="btn btn-primary" type="button" disabled={busy} onclick={closeCase}>Confirm closure for this version</button>
    {:else}
      <div class="blockers">
        <h3>Why this case cannot close yet</h3>
        <ul>
          {#each currentSnapshot.attentionItems as item}
            <li><span><Icon name="triangle-alert" size={16} /></span><div><strong>{item.message}</strong><small>Tracking code: {item.code}</small></div></li>
          {/each}
        </ul>
      </div>
    {/if}
  </article>

  <details class="technical card">
    <summary><Icon name="file-text" size={17} /> Technical details and audit history</summary>
    <div class="technical__body">
      <p>Case version {currentSnapshot.caseVersion} · Investigation revision {currentSnapshot.materialRevision ?? 'not received'}</p>
      <section>
        <h3>Recorded human decisions</h3>
        {#if currentSnapshot.decisions.length}
          <ol>{#each currentSnapshot.decisions as decision}<li><strong>{decision.type} · {decision.status}</strong><br />{decision.actorId ?? 'Not recorded'} ({decision.actorRole ?? 'No role'}) · {decision.decidedAt ? formatDate(decision.decidedAt) : 'No decision time'}<br />{decision.rationale}</li>{/each}</ol>
        {:else}<p>No human decision has been recorded yet.</p>{/if}
      </section>
      <section>
        <h3>Saved versions</h3>
        <ol>{#each currentHistory as revision}<li>Case v{revision.caseVersion} · Investigation {revision.materialRevision ?? 'not received'} · {formatDate(revision.createdAt)} · {revision.actorId}</li>{/each}</ol>
      </section>
      <a href={`/api/cases/${currentSnapshot.caseId}/snapshot`}>Open raw snapshot JSON</a>
    </div>
  </details>
</section>

<style>
  .investigation { max-width: 1120px; margin: 0 auto; padding: 28px 32px 72px; overflow-wrap: anywhere; }
  .case-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin: 24px 0; }
  .case-heading__badges { display: flex; gap: 8px; margin-bottom: 12px; }
  h1 { margin: 0; color: #17151c; font-size: clamp(28px, 4vw, 40px); line-height: 1; letter-spacing: -.04em; }
  .product-name { margin: 10px 0 0; color: #302b35; font-size: 18px; font-weight: 700; }
  .updated { margin: 6px 0 0; color: #716b7b; font-size: 12px; }
  .back-link { display: inline-flex; align-items: center; gap: 7px; color: #6330c8; font-size: 13px; font-weight: 700; text-decoration: none; }
  .next-action { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 16px; border: 1px solid #d8c7f6; border-radius: 16px; padding: 20px; background: linear-gradient(135deg, #f8f4ff, #fff); box-shadow: 0 8px 30px rgba(76, 50, 124, .08); }
  .next-action__icon { display: grid; width: 42px; height: 42px; place-items: center; border-radius: 12px; background: #7542dd; color: white; }
  .eyebrow { color: #7542dd; font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  .next-action h2 { margin: 3px 0 4px; font-size: 20px; }
  .next-action p { margin: 0; color: #5f5868; font-size: 13px; line-height: 1.55; }
  .next-action > a { border-radius: 9px; padding: 10px 13px; background: #7542dd; color: white; font-size: 12px; font-weight: 750; text-decoration: none; }
  .notice { display: flex; align-items: center; gap: 9px; margin: 14px 0 0; border-radius: 10px; padding: 12px 14px; background: #ecfdf3; color: #166534; font-size: 13px; font-weight: 650; }
  .notice--error { background: #fff1f2; color: #9f1239; }
  .journey { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; margin: 22px 0; padding: 0; overflow: hidden; border: 1px solid #eae4f2; border-radius: 14px; background: #eae4f2; list-style: none; }
  .journey li { display: flex; gap: 10px; min-height: 84px; padding: 15px; background: #fff; color: #8a8391; }
  .journey li > span { display: grid; flex: 0 0 auto; width: 25px; height: 25px; place-items: center; border: 1px solid #d8d1df; border-radius: 50%; font-size: 11px; font-weight: 800; }
  .journey div { display: grid; align-content: start; gap: 4px; }
  .journey strong { font-size: 12px; }
  .journey small { font-size: 10px; line-height: 1.4; }
  .journey__done { color: #217a4d !important; background: #f3fbf6 !important; }
  .journey__done > span { border-color: #2aa96b !important; background: #2aa96b; color: white; }
  .journey__current { color: #4d3485 !important; background: #faf7ff !important; }
  .journey__current > span { border-color: #7542dd !important; background: #7542dd; color: white; }
  .section-card { margin: 18px 0; padding: 26px; scroll-margin-top: 18px; }
  .section-heading { display: flex; gap: 14px; align-items: flex-start; border-bottom: 1px solid #eee9f2; padding-bottom: 18px; }
  .section-number { display: grid; flex: 0 0 auto; width: 32px; height: 32px; place-items: center; border-radius: 10px; background: #f1e9ff; color: #6330c8; font-size: 13px; font-weight: 800; }
  .section-heading h2 { margin: 3px 0 5px; font-size: 20px; letter-spacing: -.02em; }
  .section-heading p { margin: 0; color: #716b7b; font-size: 12px; line-height: 1.5; }
  .finding-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 18px 0; }
  .finding-grid section { display: grid; gap: 5px; border: 1px solid #e8e3ef; border-radius: 12px; padding: 15px; background: #fcfbfe; }
  .finding-grid span { color: #716b7b; font-size: 10px; font-weight: 750; text-transform: uppercase; }
  .finding-grid strong { font-size: 14px; }
  .finding-grid small { color: #4f7c62; font-size: 11px; }
  .decision-list, .task-list { display: grid; gap: 14px; margin-top: 18px; }
  .review-decision, .task-item { border: 1px solid #dcd4e5; border-radius: 14px; padding: 20px; }
  .review-decision > header, .task-item > header { display: flex; justify-content: space-between; gap: 14px; }
  .review-decision h3, .task-item h3, .empty-step h3, .blockers h3 { margin: 7px 0 0; font-size: 16px; }
  .review-intro { margin: 12px 0; color: #5f5868; font-size: 12px; line-height: 1.55; }
  .checklist { display: grid; gap: 8px; margin: 12px 0 16px; padding: 0; list-style: none; }
  .checklist li { display: flex; align-items: flex-start; gap: 8px; color: #3d3744; font-size: 12px; }
  .checklist li :global(svg) { margin-top: 2px; color: #2a8f5b; }
  .warning-box, .success-box { display: flex; gap: 11px; margin: 16px 0; border-radius: 11px; padding: 13px 14px; }
  .warning-box { background: #fff8e8; color: #795d24; }
  .success-box { background: #eefaf2; color: #1f6843; }
  .warning-box strong, .success-box strong { font-size: 12px; }
  .warning-box p, .success-box p { margin: 3px 0 0; font-size: 11px; line-height: 1.5; }
  .warning-box ul { margin: 6px 0 0; padding-left: 18px; font-size: 11px; }
  .evidence-details { margin: 14px 0; border-radius: 10px; background: #f6f4f8; padding: 11px 13px; }
  .evidence-details summary { cursor: pointer; font-size: 11px; font-weight: 750; }
  .evidence-details ul { margin: 9px 0 0; padding-left: 18px; color: #5f5868; font-size: 11px; }
  .evidence-details p, .evidence-details pre { color: #5f5868; font-size: 11px; white-space: pre-wrap; }
  label { display: grid; gap: 6px; margin: 15px 0; color: #302b35; font-size: 12px; font-weight: 700; }
  label small { color: #716b7b; font-size: 10px; font-weight: 500; }
  input, textarea { width: 100%; border: 1px solid #cfc7d8; border-radius: 9px; padding: 10px 11px; background: #fff; color: #17151c; font: inherit; font-weight: 500; resize: vertical; }
  input:focus, textarea:focus { outline: 3px solid #e4d3ff; border-color: #7542dd; }
  .task-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .positions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 18px 0; }
  .positions div { border: 1px solid #e8e3ef; border-radius: 12px; padding: 14px; }
  .positions dt { color: #716b7b; font-size: 10px; }
  .positions dd { margin: 6px 0; font-size: 17px; font-weight: 800; }
  .positions small { color: #716b7b; font-size: 9px; }
  .position--unknown { background: #fffaf0; }
  .contained { display: flex; align-items: center; gap: 7px; font-size: 12px; }
  .empty-step { display: flex; gap: 15px; margin-top: 18px; border: 1px dashed #cfc7d8; border-radius: 13px; padding: 20px; background: #fcfbfe; }
  .empty-step > span { display: grid; flex: 0 0 auto; width: 42px; height: 42px; place-items: center; border-radius: 11px; background: #f1e9ff; color: #6330c8; }
  .empty-step h3 { margin-top: 0; }
  .empty-step p, .empty-step li { color: #5f5868; font-size: 12px; line-height: 1.55; }
  .empty-step ul { margin: 10px 0; padding-left: 18px; }
  .empty-step small { color: #716b7b; font-size: 10px; }
  .empty-step.compact { align-items: center; }
  .empty-step.compact p { margin: 5px 0 0; }
  .demo-loader { display: grid; justify-items: start; gap: 10px; margin-top: 16px; border-top: 1px solid #e6dfec; padding-top: 16px; }
  .demo-loader p { margin: 0; }
  .waiting-note { margin: 14px 0 0 !important; color: #795d24 !important; }
  .demo-step { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-top: 16px; border: 1px solid #d8c7f6; border-radius: 12px; padding: 16px; background: #faf7ff; }
  .demo-step h3 { margin: 8px 0 5px; font-size: 14px; }
  .demo-step p { margin: 0; color: #5f5868; font-size: 11px; line-height: 1.5; }
  .demo-step button { flex: 0 0 auto; }
  .task-item > header p { margin: 5px 0 0; color: #716b7b; font-size: 11px; }
  .task-inactive { opacity: .7; }
  .task-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 15px 0; }
  .task-summary div { border-radius: 9px; padding: 10px; background: #f6f4f8; }
  .task-summary dt { color: #716b7b; font-size: 9px; text-transform: uppercase; }
  .task-summary dd { margin: 4px 0 0; font-size: 11px; font-weight: 700; }
  .status-reason, .action-help, .required-evidence { color: #5f5868; font-size: 11px; line-height: 1.5; }
  .blockers { margin-top: 18px; }
  .blockers h3 { margin-top: 0; }
  .blockers ul { display: grid; gap: 9px; padding: 0; list-style: none; }
  .blockers li { display: flex; gap: 10px; border-radius: 10px; padding: 12px; background: #fff8e8; color: #654f25; }
  .blockers li > span { margin-top: 1px; }
  .blockers strong { display: block; font-size: 11px; }
  .blockers small { display: block; margin-top: 3px; color: #8a7243; font-size: 9px; }
  .technical { margin-top: 18px; padding: 0; overflow: hidden; }
  .technical > summary { display: flex; align-items: center; gap: 9px; cursor: pointer; padding: 16px 18px; color: #5f5868; font-size: 12px; font-weight: 700; }
  .technical__body { border-top: 1px solid #eae4f2; padding: 18px; color: #5f5868; font-size: 11px; }
  .technical__body h3 { margin: 16px 0 8px; font-size: 13px; }
  .technical__body ol { display: grid; gap: 8px; padding-left: 20px; }
  .technical__body a { color: #6330c8; font-weight: 700; }
  @media (max-width: 800px) {
    .investigation { padding: 20px 18px 56px; }
    .journey { grid-template-columns: 1fr 1fr; }
    .positions { grid-template-columns: 1fr 1fr; }
    .task-summary { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 560px) {
    .case-heading { display: grid; }
    .next-action { grid-template-columns: auto 1fr; }
    .next-action > a { grid-column: 1 / -1; text-align: center; }
    .journey, .finding-grid, .positions { grid-template-columns: 1fr; }
    .section-card { padding: 18px; }
    .task-summary { grid-template-columns: 1fr; }
    .demo-step { align-items: stretch; flex-direction: column; }
  }
</style>
