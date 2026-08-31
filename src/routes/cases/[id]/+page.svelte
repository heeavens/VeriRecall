<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';

  import Icon from '$lib/components/Icon.svelte';
  import WorkflowBreadcrumbs from '$lib/components/WorkflowBreadcrumbs.svelte';

  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  let actorName = $state('Herman');
  let closeOpen = $state(false);
  let submittingTaskId = $state<string | null>(null);
  let closing = $state(false);

  const enhanceTask: SubmitFunction = ({ formData }) => {
    const taskId = formData.get('taskId');
    submittingTaskId = typeof taskId === 'string' ? taskId : null;
    return async ({ update }) => {
      try {
        await update();
      } finally {
        submittingTaskId = null;
      }
    };
  };

  const enhanceClose: SubmitFunction = () => {
    closing = true;
    return async ({ update }) => {
      try {
        await update();
      } finally {
        closing = false;
        closeOpen = false;
      }
    };
  };

  const canClose = $derived(
    data.tasks.length === 3 && data.tasks.every((task) => task.status !== 'pending')
  );
  const nextTask = $derived(data.tasks.find((task) => task.status === 'pending') ?? null);
  const nextDraft = $derived(
    nextTask ? data.drafts.find((draft) => draft.type === nextTask.type && draft.status === 'draft') ?? null : null
  );

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short'
    }).format(new Date(value));
  }

  function sourceLabel(source: string): string {
    return source === 'safety_gate' ? 'EU Safety Gate' : 'RASFF';
  }

  function statusLabel(status: string): string {
    if (status === 'contained') return 'Ready to close';
    if (status === 'closed') return 'Closed';
    return 'Containment required';
  }

  function statusClass(status: string): string {
    if (status === 'contained') return 'badge-purple';
    if (status === 'closed') return 'badge-green';
    return 'badge-orange';
  }

  function taskStatusLabel(status: string): string {
    if (status === 'completed') return 'Completed';
    if (status === 'not_available') return 'Not required';
    return 'Required';
  }

  function taskStatusClass(status: string): string {
    if (status === 'completed') return 'badge-green';
    if (status === 'not_available') return 'badge-gray';
    return 'badge-orange';
  }

  function taskDescription(type: string): string {
    if (type === 'block_sale') return 'Stop the affected stock from being sold while the recall is handled.';
    if (type === 'notify_supplier') return 'Record the supplier notification and request their containment response.';
    return 'Review the affected purchase records and notify the listed customers.';
  }

  function draftStatusLabel(status: string): string {
    if (status === 'simulated_sent') return 'SIMULATED SEND';
    if (status === 'not_available') return 'NOT REQUIRED';
    return 'DRAFT — NOT SENT';
  }

  function draftStatusClass(status: string): string {
    if (status === 'simulated_sent') return 'badge-green';
    if (status === 'not_available') return 'badge-gray';
    return 'badge-purple';
  }

  function actionLabel(type: string): string {
    if (type === 'block_sale') return 'Block sale';
    if (type === 'notify_supplier') return 'Supplier notice';
    return 'Customer notice';
  }

  function closeOnEscape(event: KeyboardEvent): void {
    if (event.key === 'Escape') closeOpen = false;
  }
</script>

<svelte:head>
  <title>{data.caseRecord.caseNumber} | Recall Agent</title>
  <meta name="description" content={`Containment and audit record for ${data.caseRecord.caseNumber}.`} />
</svelte:head>

<svelte:window onkeydown={closeOnEscape} />

{#if form?.message}
  <div
    class={`case-notice ${form.success ? '' : 'case-notice--error'}`}
    role="status"
  >
    <Icon name={form.success ? 'circle-check-big' : 'triangle-alert'} size={16} />
    <span>{form.message}</span>
    {#if form.success && form.kind === 'task' && canClose}
      <button type="button" onclick={() => (closeOpen = true)}>Review Closure <Icon name="arrow-right" size={14} /></button>
    {:else if form.success && form.kind === 'close'}
      <a href={`/api/cases/${data.caseRecord.id}/export.pdf`}>Export Record <Icon name="download" size={14} /></a>
    {/if}
  </div>
{/if}

<section class="case-page" aria-labelledby="case-title">
  <WorkflowBreadcrumbs
    items={[{ label: 'Cases', href: '/cases' }, { label: data.caseRecord.caseNumber }]}
  />

  <header class="case-heading">
    <div class="case-heading__main">
      <div class="case-heading__title">
        <h1 id="case-title">{data.caseRecord.caseNumber}</h1>
        <span class={`badge ${statusClass(data.caseRecord.status)}`}>{statusLabel(data.caseRecord.status)}</span>
        <span class="badge badge-red">{data.caseRecord.severity} severity</span>
      </div>
      <h2>{data.alert.productName}</h2>
      <div class="case-heading__meta">
        <span>{sourceLabel(data.alert.source)} · {data.alert.sourceReference}</span>
        <span>Opened {formatDate(data.caseRecord.openedAt)}</span>
        <a href={data.alert.sourceUrl} target="_blank" rel="noreferrer">
          Official notice <Icon name="external-link" size={12} />
        </a>
      </div>
    </div>
    <div class="case-heading__exports" aria-label="Export incident record">
      <a class="btn btn-secondary" href={`/api/cases/${data.caseRecord.id}/export.csv`}>
        <Icon name="download" size={14} /> CSV
      </a>
      <a class="btn btn-secondary" href={`/api/cases/${data.caseRecord.id}/export.pdf`}>
        <Icon name="file-text" size={14} /> PDF
      </a>
    </div>
  </header>

  <article
    class:next-step--complete={data.caseRecord.status === 'closed'}
    class:next-step--ready={data.caseRecord.status !== 'closed' && canClose}
    class="next-step"
  >
    <span class="next-step__icon">
      <Icon
        name={data.caseRecord.status === 'closed' || canClose ? 'shield-check' : 'shield-alert'}
        size={21}
      />
    </span>
    <div class="next-step__copy">
      <span>{data.caseRecord.status === 'closed' ? 'Case complete' : 'Next required action'}</span>
      {#if data.caseRecord.status === 'closed'}
        <h2>Containment is complete and the incident record is closed</h2>
        <p>Review the timeline or export the record if evidence is required.</p>
      {:else if canClose}
        <h2>Review the record and close the case</h2>
        <p>Every available containment task is complete. Closure still requires your confirmation.</p>
      {:else if nextTask}
        <h2>{nextTask.label}</h2>
        <p>{taskDescription(nextTask.type)}</p>
      {/if}
    </div>
    {#if data.caseRecord.status !== 'closed' && canClose}
      <button class="btn btn-primary" type="button" onclick={() => (closeOpen = true)}>
        Close Case
      </button>
    {:else if nextDraft}
      <a class="btn btn-primary" href={`/actions?case=${data.caseRecord.id}`}>
        Review Draft <Icon name="arrow-right" size={14} />
      </a>
    {:else if data.caseRecord.status !== 'closed'}
      <a class="btn btn-secondary" href="#containment">View Task</a>
    {/if}
  </article>

  <div class="case-flow">
    <article class="card case-section containment" id="containment">
      <header class="section-heading">
        <div class="section-heading__number">1</div>
        <div>
          <span>Do first</span>
          <h2>Containment tasks</h2>
          <p>Complete every available task before this case can be closed.</p>
        </div>
        <div class="containment__progress">
          <strong>{data.completedTasks}/{data.actionableTasks}</strong>
          <span>complete</span>
        </div>
      </header>

      <div class="containment__track" aria-label={`${data.completedTasks} of ${data.actionableTasks} tasks complete`}>
        <span style={`width:${data.actionableTasks === 0 ? 100 : Math.round((data.completedTasks / data.actionableTasks) * 100)}%`}></span>
      </div>

      <div class="task-grid">
        {#each data.tasks as task, index}
          <section class:task-card--complete={task.status !== 'pending'} class="task-card">
            <header>
              <span class="task-card__step">
                {#if task.status === 'completed'}
                  <Icon name="check" size={15} />
                {:else}
                  {index + 1}
                {/if}
              </span>
              <span class={`badge ${taskStatusClass(task.status)}`}>{taskStatusLabel(task.status)}</span>
            </header>
            <h3>{task.label}</h3>
            <p>{taskDescription(task.type)}</p>
            {#if task.completedBy && task.completedAt}
              <small>{task.completedBy} · {formatDate(task.completedAt)}</small>
            {:else if task.status === 'not_available'}
              <small>No matching customer data was available.</small>
            {/if}
            {#if task.status === 'pending' && data.caseRecord.status !== 'closed'}
              <form method="POST" action="?/completeTask" use:enhance={enhanceTask} aria-busy={submittingTaskId === task.id}>
                <input type="hidden" name="taskId" value={task.id} />
                <input type="hidden" name="actorName" value={actorName} />
                <button class="btn btn-secondary" type="submit" disabled={submittingTaskId !== null || closing}>
                  {submittingTaskId === task.id ? 'Saving…' : 'Mark Complete'}
                </button>
              </form>
            {/if}
          </section>
        {/each}
      </div>

      {#if data.caseRecord.status !== 'closed'}
        <label class="reviewer-field" for="case-actor-name">
          <span>Actions recorded as</span>
          <input id="case-actor-name" class="input-ui" bind:value={actorName} maxlength="80" />
        </label>
      {/if}
    </article>

    <article class="card case-section products-section">
      <header class="section-heading">
        <div class="section-heading__number">2</div>
        <div>
          <span>Affected scope</span>
          <h2>Products and stock</h2>
          <p>Confirmed catalogue items included in this incident.</p>
        </div>
        <strong class="section-total">{data.totalStock} units</strong>
      </header>

      <div class="product-list">
        {#each data.items as row}
          <section class="product-row">
            <span class="product-row__icon"><Icon name="package" size={19} /></span>
            <div class="product-row__identity">
              <h3>{row.product.name}</h3>
              <p>{row.product.sku} · {row.product.brand}</p>
            </div>
            <dl>
              <div><dt>Affected batch</dt><dd>{row.item.batch}</dd></div>
              <div><dt>Stock</dt><dd>{row.item.stockQuantity} units</dd></div>
              <div><dt>EAN / GTIN</dt><dd>{row.product.ean ?? 'Not provided'}</dd></div>
              <div><dt>Supplier</dt><dd>{row.product.supplierName ?? 'Not provided'}</dd></div>
            </dl>
          </section>
        {/each}
      </div>
    </article>

    <article class="card case-section customers-section">
      <header class="section-heading">
        <div class="section-heading__number">3</div>
        <div>
          <span>Affected scope</span>
          <h2>Customers</h2>
          <p>Purchase records matching the affected SKU and batch.</p>
        </div>
        <strong class="section-total">{data.customers.length} records</strong>
      </header>

      {#if data.customers.length > 0}
        <div class="customer-table">
          <table>
            <thead>
              <tr><th>Customer</th><th>Contact</th><th>SKU / batch</th><th>Purchased</th><th>Qty</th></tr>
            </thead>
            <tbody>
              {#each data.customers as customer}
                <tr>
                  <td><strong>{customer.name ?? customer.externalId}</strong><small>{customer.externalId}</small></td>
                  <td>{customer.email ?? 'Email unavailable'}</td>
                  <td><strong>{customer.sku}</strong><small>{customer.batch ?? 'Batch not recorded'}</small></td>
                  <td>{formatDate(customer.purchasedAt)}</td>
                  <td>{customer.quantity}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="section-empty">
          <Icon name="circle-check-big" size={18} />
          <div><strong>No affected customer records</strong><p>Customer notification is marked not required for this case.</p></div>
        </div>
      {/if}
    </article>

    <article class="card case-section approvals-section">
      <header class="section-heading">
        <div class="section-heading__number">4</div>
        <div>
          <span>Human decision</span>
          <h2>Approvals</h2>
          <p>Review prepared actions before recording a simulated send.</p>
        </div>
        <a class="btn btn-secondary" href={`/actions?case=${data.caseRecord.id}`}>
          Open Approvals <Icon name="arrow-right" size={14} />
        </a>
      </header>

      <div class="draft-list">
        {#each data.drafts as draft}
          <section class="draft-row">
            <span class="draft-row__icon">
              <Icon name={draft.type === 'block_sale' ? 'warehouse' : 'send'} size={17} />
            </span>
            <div>
              <h3>{actionLabel(draft.type)}</h3>
              <p>{draft.recipient ?? 'Recipient not available'}</p>
            </div>
            <span class={`badge ${draftStatusClass(draft.status)}`}>{draftStatusLabel(draft.status)}</span>
            {#if draft.approvedBy && draft.approvedAt}
              <small>{draft.approvedBy} · {formatDate(draft.approvedAt)}</small>
            {:else}
              <small>{draft.subject}</small>
            {/if}
          </section>
        {/each}
      </div>
    </article>

    <article class="card case-section timeline-section">
      <header class="section-heading">
        <div class="section-heading__number">5</div>
        <div>
          <span>Defensible record</span>
          <h2>Case timeline</h2>
          <p>Append-only history of agent activity and human decisions.</p>
        </div>
        <strong class="section-total">{data.timeline.length} events</strong>
      </header>

      {#if data.timeline.length > 0}
        <ol class="audit-list">
          {#each data.timeline as event}
            <li>
              <span class:timeline-actor--human={event.actorType === 'human'} class="timeline-actor">
                <Icon name={event.actorType === 'human' ? 'check' : 'sparkles'} size={14} />
              </span>
              <div class="audit-list__copy">
                <div><strong>{event.summary}</strong><span class={`badge ${event.actorType === 'human' ? 'badge-purple' : 'badge-blue'}`}>{event.actorType}</span></div>
                <p>{event.actorName} · {event.eventType.replaceAll('_', ' ')}</p>
              </div>
              <time datetime={event.createdAt}>{formatDate(event.createdAt)}</time>
            </li>
          {/each}
        </ol>
      {:else}
        <div class="section-empty"><p>No audit events have been recorded for this case.</p></div>
      {/if}
    </article>
  </div>
</section>

{#if closeOpen}
  <div class="modal-backdrop show">
    <button class="absolute inset-0 cursor-default" type="button" aria-label="Cancel case closure" onclick={() => (closeOpen = false)}></button>
    <div class="modal-panel relative z-[1] max-w-[520px]" role="dialog" aria-modal="true" aria-labelledby="close-case-title" tabindex="-1">
      <form method="POST" action="?/close" use:enhance={enhanceClose} aria-busy={closing}>
        <input type="hidden" name="actorName" value={actorName} />
        <div class="modal-heading">
          <div>
            <h2 id="close-case-title">Close {data.caseRecord.caseNumber}?</h2>
            <p>This decision becomes part of the permanent incident record.</p>
          </div>
          <button class="icon-button" type="button" aria-label="Cancel case closure" onclick={() => (closeOpen = false)}><Icon name="x" size={16} /></button>
        </div>
        <div class="modal-body">
          <div class="closure-ready">
            <Icon name="shield-check" size={18} />
            <div><strong>Containment checklist complete</strong><p>Closure records your name and the current UTC timestamp.</p></div>
          </div>
          <label>
            <span class="label">Closing reviewer</span>
            <input class="input-ui" name="visibleActorName" bind:value={actorName} maxlength="80" required />
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" type="button" onclick={() => (closeOpen = false)}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={!canClose || !actorName.trim() || closing}>
            {closing ? 'Closing case…' : 'Confirm Closure'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .case-page {
    max-width: 1120px;
    margin: 0 auto;
  }

  .case-notice {
    display: flex;
    max-width: 1120px;
    align-items: center;
    gap: 9px;
    margin: 0 auto 16px;
    border: 1px solid #cfead9;
    border-radius: 10px;
    background: #f5fcf7;
    padding: 11px 13px;
    color: #237c50;
    font-size: 10px;
  }

  .case-notice--error {
    border-color: #f1cfd1;
    background: #fff8f8;
    color: #a7353b;
  }

  .case-notice > a,
  .case-notice > button {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 5px;
    margin-left: auto;
    border: 0;
    background: transparent;
    padding: 0;
    color: #6330c8;
    font-size: 9px;
    font-weight: 700;
    white-space: nowrap;
  }

  .case-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 18px;
  }

  .case-heading__main {
    min-width: 0;
  }

  .case-heading__title,
  .case-heading__meta,
  .case-heading__exports {
    display: flex;
    align-items: center;
  }

  .case-heading__title {
    flex-wrap: wrap;
    gap: 8px;
  }

  .case-heading h1 {
    margin: 0;
    font-size: 25px;
    font-weight: 750;
    letter-spacing: -0.035em;
  }

  .case-heading h2 {
    overflow: hidden;
    margin: 8px 0 0;
    font-size: 13px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .case-heading__meta {
    flex-wrap: wrap;
    gap: 5px 18px;
    margin-top: 7px;
    color: #716b7b;
    font-size: 9px;
  }

  .case-heading__meta a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: #6330c8;
    font-weight: 650;
  }

  .case-heading__exports {
    flex: 0 0 auto;
    gap: 7px;
  }

  .next-step {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 15px;
    margin-bottom: 16px;
    border: 1px solid #f0d3a2;
    border-radius: 13px;
    background: #fffaf1;
    padding: 15px 16px;
  }

  .next-step--ready {
    border-color: #d9cdf1;
    background: #faf7ff;
  }

  .next-step--complete {
    border-color: #cfe8d8;
    background: #f5fcf7;
  }

  .next-step__icon {
    display: grid;
    width: 40px;
    height: 40px;
    place-items: center;
    border-radius: 10px;
    background: #fff0d8;
    color: #b9771c;
  }

  .next-step--ready .next-step__icon {
    background: #eee5ff;
    color: #6330c8;
  }

  .next-step--complete .next-step__icon {
    background: #e2f5e9;
    color: #268d5c;
  }

  .next-step__copy > span,
  .section-heading > div:nth-child(2) > span {
    color: #8b621f;
    font-size: 8px;
    font-weight: 750;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  .next-step--ready .next-step__copy > span,
  .next-step--complete .next-step__copy > span {
    color: #6330c8;
  }

  .next-step__copy h2 {
    margin: 4px 0 0;
    font-size: 13px;
    font-weight: 750;
  }

  .next-step__copy p {
    margin: 3px 0 0;
    color: #716b7b;
    font-size: 9px;
    line-height: 1.5;
  }

  .case-flow {
    display: grid;
    gap: 16px;
  }

  .case-section {
    overflow: hidden;
  }

  .section-heading {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 15px 17px;
    border-bottom: 1px solid #eae4f2;
  }

  .section-heading__number {
    display: grid;
    width: 27px;
    height: 27px;
    place-items: center;
    border-radius: 8px;
    background: #f1e9ff;
    color: #6330c8;
    font-size: 9px;
    font-weight: 750;
  }

  .section-heading > div:nth-child(2) > span {
    color: #7542dd;
  }

  .section-heading h2 {
    margin: 3px 0 0;
    font-size: 14px;
    font-weight: 750;
  }

  .section-heading p {
    margin: 3px 0 0;
    color: #716b7b;
    font-size: 9px;
  }

  .section-total,
  .containment__progress strong {
    font-size: 12px;
    font-weight: 750;
  }

  .containment__progress {
    text-align: right;
  }

  .containment__progress strong,
  .containment__progress span {
    display: block;
  }

  .containment__progress strong {
    color: #6330c8;
  }

  .containment__progress span {
    margin-top: 2px;
    color: #716b7b;
    font-size: 8px;
  }

  .containment__track {
    height: 3px;
    background: #eee9f4;
  }

  .containment__track span {
    display: block;
    height: 100%;
    border-radius: 0 3px 3px 0;
    background: #7542dd;
  }

  .task-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    padding: 16px;
  }

  .task-card {
    display: flex;
    min-width: 0;
    min-height: 195px;
    flex-direction: column;
    border: 1px solid #e6deef;
    border-radius: 11px;
    padding: 13px;
  }

  .task-card--complete {
    background: #fdfcfe;
  }

  .task-card header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .task-card__step {
    display: grid;
    width: 28px;
    height: 28px;
    place-items: center;
    border-radius: 50%;
    background: #fff0d8;
    color: #a76b18;
    font-size: 9px;
    font-weight: 750;
  }

  .task-card--complete .task-card__step {
    background: #e2f5e9;
    color: #268d5c;
  }

  .task-card h3 {
    margin: 13px 0 0;
    font-size: 11px;
    font-weight: 750;
  }

  .task-card p {
    margin: 6px 0 0;
    color: #716b7b;
    font-size: 9px;
    line-height: 1.55;
  }

  .task-card small {
    display: block;
    margin-top: auto;
    padding-top: 12px;
    color: #716b7b;
    font-size: 8px;
    line-height: 1.4;
  }

  .task-card form {
    margin-top: auto;
    padding-top: 14px;
  }

  .task-card form .btn {
    width: 100%;
  }

  .reviewer-field {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding: 0 16px 16px;
    color: #716b7b;
    font-size: 8px;
  }

  .reviewer-field .input-ui {
    width: 170px;
    min-height: 34px;
  }

  .product-list,
  .draft-list {
    display: grid;
  }

  .product-row {
    display: grid;
    grid-template-columns: auto minmax(180px, 0.85fr) minmax(360px, 1.7fr);
    align-items: center;
    gap: 13px;
    padding: 16px 17px;
  }

  .product-row + .product-row,
  .draft-row + .draft-row {
    border-top: 1px solid #eee9f4;
  }

  .product-row__icon,
  .draft-row__icon {
    display: grid;
    width: 37px;
    height: 37px;
    place-items: center;
    border-radius: 9px;
    background: #f1e9ff;
    color: #6330c8;
  }

  .product-row__identity {
    min-width: 0;
  }

  .product-row h3,
  .draft-row h3 {
    margin: 0;
    font-size: 10px;
    font-weight: 750;
  }

  .product-row p,
  .draft-row p {
    margin: 4px 0 0;
    color: #716b7b;
    font-size: 8px;
  }

  .product-row dl {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
    margin: 0;
  }

  .product-row dt {
    color: #716b7b;
    font-size: 8px;
  }

  .product-row dd {
    overflow: hidden;
    margin: 5px 0 0;
    font-size: 9px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .customer-table {
    overflow-x: auto;
  }

  .customer-table table {
    width: 100%;
    border-collapse: collapse;
    font-size: 9px;
  }

  .customer-table th {
    background: #fdfbff;
    color: #716b7b;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-align: left;
    text-transform: uppercase;
  }

  .customer-table th,
  .customer-table td {
    padding: 11px 17px;
    border-bottom: 1px solid #eee9f4;
  }

  .customer-table tr:last-child td {
    border-bottom: 0;
  }

  .customer-table td strong,
  .customer-table td small {
    display: block;
  }

  .customer-table td small {
    margin-top: 3px;
    color: #716b7b;
    font-size: 8px;
  }

  .section-empty {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 16px;
    border-radius: 10px;
    background: #f5faf7;
    padding: 14px;
    color: #268d5c;
    font-size: 9px;
  }

  .section-empty p {
    margin: 3px 0 0;
    color: #716b7b;
  }

  .draft-row {
    display: grid;
    grid-template-columns: auto minmax(170px, 0.75fr) auto minmax(240px, 1.2fr);
    align-items: center;
    gap: 13px;
    padding: 13px 17px;
  }

  .draft-row > small {
    overflow: hidden;
    color: #716b7b;
    font-size: 8px;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .audit-list {
    margin: 0;
    padding: 0 17px;
    list-style: none;
  }

  .audit-list li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 13px 0;
  }

  .audit-list li + li {
    border-top: 1px solid #eee9f4;
  }

  .timeline-actor {
    display: grid;
    width: 31px;
    height: 31px;
    place-items: center;
    border-radius: 50%;
    background: #edf4ff;
    color: #4c80df;
  }

  .timeline-actor--human {
    background: #f1e9ff;
    color: #6330c8;
  }

  .audit-list__copy {
    min-width: 0;
  }

  .audit-list__copy > div {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
  }

  .audit-list__copy strong {
    font-size: 9px;
  }

  .audit-list__copy p {
    margin: 4px 0 0;
    color: #716b7b;
    font-size: 8px;
  }

  .audit-list time {
    color: #716b7b;
    font-size: 8px;
    white-space: nowrap;
  }

  .modal-heading,
  .modal-actions {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 17px 19px;
  }

  .modal-heading {
    border-bottom: 1px solid #eae4f2;
  }

  .modal-heading h2 {
    margin: 0;
    font-size: 17px;
  }

  .modal-heading p {
    margin: 5px 0 0;
    color: #716b7b;
    font-size: 9px;
  }

  .modal-body {
    display: grid;
    gap: 16px;
    padding: 19px;
  }

  .closure-ready {
    display: flex;
    gap: 10px;
    border: 1px solid #cfe8d8;
    border-radius: 10px;
    background: #f5fcf7;
    padding: 13px;
    color: #268d5c;
  }

  .closure-ready strong {
    font-size: 10px;
  }

  .closure-ready p {
    margin: 4px 0 0;
    color: #527060;
    font-size: 9px;
  }

  .modal-actions {
    justify-content: flex-end;
    border-top: 1px solid #eae4f2;
    background: #fdfbff;
  }

  @media (max-width: 900px) {
    .task-grid {
      grid-template-columns: 1fr;
    }

    .task-card {
      min-height: 0;
    }

    .task-card small,
    .task-card form {
      margin-top: 12px;
    }

    .product-row {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .product-row dl {
      grid-column: 2;
    }

    .draft-row {
      grid-template-columns: auto minmax(0, 1fr) auto;
    }

    .draft-row > small {
      grid-column: 2 / -1;
      text-align: left;
    }
  }

  @media (max-width: 680px) {
    .case-heading,
    .case-heading__exports {
      align-items: stretch;
      flex-direction: column;
    }

    .case-heading__exports {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }

    .next-step {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .next-step .btn {
      grid-column: 1 / -1;
      width: 100%;
    }

    .section-heading {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .section-heading > :last-child {
      grid-column: 2;
      justify-self: start;
      margin-top: 5px;
    }

    .product-row dl {
      grid-template-columns: 1fr 1fr;
    }

    .draft-row {
      align-items: start;
      grid-template-columns: auto minmax(0, 1fr);
    }

    .draft-row > .badge,
    .draft-row > small {
      grid-column: 2;
      justify-self: start;
    }

    .reviewer-field {
      align-items: stretch;
      flex-direction: column;
    }

    .reviewer-field .input-ui {
      width: 100%;
    }

    .audit-list li {
      align-items: start;
      grid-template-columns: auto minmax(0, 1fr);
    }

    .audit-list time {
      grid-column: 2;
    }

    .case-notice {
      align-items: flex-start;
      flex-wrap: wrap;
    }

    .case-notice > a,
    .case-notice > button {
      width: 100%;
      margin-left: 25px;
    }
  }
</style>
