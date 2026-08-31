<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';

  import Icon from '$lib/components/Icon.svelte';
  import WorkflowBreadcrumbs from '$lib/components/WorkflowBreadcrumbs.svelte';

  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  let actorName = $state('Herman');
  let editActionId = $state<string | null>(null);
  let approveActionId = $state<string | null>(null);
  let editSubject = $state('');
  let editBody = $state('');
  let submitting = $state<'update' | 'approve' | null>(null);

  const enhanceUpdate: SubmitFunction = () => {
    submitting = 'update';
    return async ({ update }) => {
      try {
        await update();
      } finally {
        submitting = null;
        closeModals();
      }
    };
  };

  const enhanceApproval: SubmitFunction = () => {
    submitting = 'approve';
    return async ({ update }) => {
      try {
        await update();
      } finally {
        submitting = null;
        closeModals();
      }
    };
  };

  const editAction = $derived(data.actions.find((item) => item.draft.id === editActionId) ?? null);
  const approveAction = $derived(data.actions.find((item) => item.draft.id === approveActionId) ?? null);
  const pendingActions = $derived(data.actions.filter((item) => item.draft.status === 'draft'));
  const recordedActions = $derived(data.actions.filter((item) => item.draft.status !== 'draft'));

  function actionLabel(type: string): string {
    if (type === 'block_sale') return 'Block sale';
    if (type === 'notify_supplier') return 'Supplier notice';
    return 'Customer notice';
  }

  function actionDescription(type: string): string {
    if (type === 'block_sale') return 'Internal containment instruction';
    if (type === 'notify_supplier') return 'Recall notice for the product supplier';
    return 'Recall notice for affected customers';
  }

  function statusLabel(status: string): string {
    if (status === 'simulated_sent') return 'SIMULATED SEND';
    if (status === 'not_available') return 'NOT REQUIRED';
    return 'DRAFT — NOT SENT';
  }

  function statusClass(status: string): string {
    if (status === 'simulated_sent') return 'badge-green';
    if (status === 'not_available') return 'badge-gray';
    return 'badge-purple';
  }

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

  function openEdit(actionId: string): void {
    const selected = data.actions.find((item) => item.draft.id === actionId);
    if (!selected || selected.draft.status !== 'draft') return;
    editActionId = actionId;
    editSubject = selected.draft.subject;
    editBody = selected.draft.body;
  }

  function closeModals(): void {
    editActionId = null;
    approveActionId = null;
  }

  function closeOnEscape(event: KeyboardEvent): void {
    if (event.key === 'Escape') closeModals();
  }
</script>

<svelte:head>
  <title>Approvals | Recall Agent</title>
  <meta
    name="description"
    content="Review and approve simulated recall containment actions."
  />
</svelte:head>

<svelte:window onkeydown={closeOnEscape} />

{#if form?.message}
  <div class:approval-notice--error={!form.success} class="approval-notice" role="status">
    <span><Icon name={form.success ? 'circle-check-big' : 'triangle-alert'} size={16} /></span>
    <p>{form.message}</p>
    {#if form.success && form.caseId}
      <a href={`/cases/${form.caseId}`}>Continue Case <Icon name="arrow-right" size={14} /></a>
    {/if}
  </div>
{/if}

<section class="approvals-page" aria-labelledby="approvals-title">
  <WorkflowBreadcrumbs items={[{ label: 'Cases', href: '/cases' }, { label: 'Approvals' }]} />

  <header class="approvals-heading">
    <div>
      <span class="eyebrow">Human decision point</span>
      <h1 id="approvals-title">Approvals</h1>
      <p>Review prepared containment actions and explicitly record each decision.</p>
    </div>
    <a class="btn btn-secondary" href="/cases">
      <Icon name="briefcase-business" size={15} /> All Cases
    </a>
  </header>

  <aside class="simulation-boundary" aria-label="Simulation boundary">
    <span><Icon name="shield-alert" size={19} /></span>
    <div>
      <strong>Nothing is sent automatically</strong>
      <p>Approval records a <b>SIMULATED SEND</b> with your name and timestamp. No email, POS, ERP or inventory provider is contacted.</p>
    </div>
  </aside>

  {#if data.actions.length > 0}
    <section class="approval-section" aria-labelledby="pending-approvals-title">
      <header class="approval-section__heading">
        <div>
          <h2 id="pending-approvals-title">Awaiting your decision</h2>
          <p>Check the recipient and content before recording approval.</p>
        </div>
        <span class:queue-count--active={pendingActions.length > 0} class="queue-count">
          {pendingActions.length} pending
        </span>
      </header>

      {#if pendingActions.length > 0}
        <div class="pending-list">
          {#each pendingActions as item}
            <article class="card approval-card">
              <header class="approval-card__heading">
                <span class="approval-card__icon">
                  <Icon name={item.draft.type === 'block_sale' ? 'warehouse' : 'send'} size={18} />
                </span>
                <div>
                  <div class="approval-card__title">
                    <h3>{actionLabel(item.draft.type)}</h3>
                    <span class="badge badge-purple">DRAFT — NOT SENT</span>
                  </div>
                  <p>{actionDescription(item.draft.type)}</p>
                </div>
                <div class="approval-card__case">
                  <a href={`/cases/${item.caseRecord.id}`}>{item.caseRecord.caseNumber}</a>
                  <span class="badge badge-red">{item.alert.risk}</span>
                </div>
              </header>

              <div class="approval-card__body">
                <dl class="approval-fields">
                  <div>
                    <dt>Recipient</dt>
                    <dd class:approval-fields__missing={!item.draft.recipient}>
                      {item.draft.recipient ?? 'Recipient required'}
                    </dd>
                  </div>
                  <div>
                    <dt>Subject</dt>
                    <dd>{item.draft.subject}</dd>
                  </div>
                  <div class="approval-fields__message">
                    <dt>Message</dt>
                    <dd>{item.draft.body}</dd>
                  </div>
                </dl>

                <div class="approval-card__actions">
                  <span>Prepared for {item.caseRecord.caseNumber}</span>
                  <div>
                    <button class="btn btn-secondary" type="button" onclick={() => openEdit(item.draft.id)}>
                      Edit Draft
                    </button>
                    <button
                      class="btn btn-primary"
                      type="button"
                      onclick={() => (approveActionId = item.draft.id)}
                      disabled={item.draft.type !== 'block_sale' && !item.draft.recipient}
                    >
                      Review & Approve
                    </button>
                  </div>
                </div>
              </div>
            </article>
          {/each}
        </div>
      {:else}
        <div class="card decisions-complete">
          <span><Icon name="circle-check-big" size={21} /></span>
          <div>
            <h3>All available drafts have a recorded outcome</h3>
            <p>Open a case below to continue containment or review the decisions retained in this queue.</p>
          </div>
        </div>
      {/if}
    </section>

    {#if recordedActions.length > 0}
      <section class="approval-section recorded-section" aria-labelledby="recorded-actions-title">
        <header class="approval-section__heading">
          <div>
            <h2 id="recorded-actions-title">Recorded decisions</h2>
            <p>Completed simulations and actions that were not required.</p>
          </div>
          <span class="queue-count">{recordedActions.length} recorded</span>
        </header>

        <div class="recorded-list">
          {#each recordedActions as item}
            <article class="recorded-row">
              <span class:recorded-row__icon--muted={item.draft.status === 'not_available'} class="recorded-row__icon">
                <Icon name={item.draft.status === 'simulated_sent' ? 'circle-check-big' : 'x'} size={17} />
              </span>
              <div class="recorded-row__identity">
                <h3>{actionLabel(item.draft.type)}</h3>
                <p><a href={`/cases/${item.caseRecord.id}`}>{item.caseRecord.caseNumber}</a> · {item.draft.recipient ?? 'No recipient available'}</p>
              </div>
              <span class={`badge ${statusClass(item.draft.status)}`}>{statusLabel(item.draft.status)}</span>
              <div class="recorded-row__result">
                {#if item.draft.status === 'simulated_sent'}
                  <strong>Simulation recorded</strong>
                  <span>{item.draft.approvedBy} · {item.draft.approvedAt ? formatDate(item.draft.approvedAt) : ''}</span>
                {:else}
                  <strong>No action required</strong>
                  <span>The case had no matching recipient data.</span>
                {/if}
              </div>
              <a class="recorded-row__open" href={`/cases/${item.caseRecord.id}`} aria-label={`Open ${item.caseRecord.caseNumber}`}>
                <Icon name="chevron-right" size={15} />
              </a>
            </article>
          {/each}
        </div>
      </section>
    {/if}
  {:else}
    <article class="card approvals-empty">
      <span><Icon name="shield-check" size={21} /></span>
      <h2>No approvals are waiting</h2>
      <p>Prepared actions appear here after a confirmed catalogue match opens a recall case.</p>
      <a class="btn btn-secondary" href="/cases">Return to Cases</a>
    </article>
  {/if}
</section>

{#if editAction}
  <div class="modal-backdrop show">
    <button class="absolute inset-0 cursor-default" type="button" aria-label="Cancel draft editing" onclick={closeModals}></button>
    <div class="modal-panel relative z-[1]" role="dialog" aria-modal="true" aria-labelledby="edit-draft-title" tabindex="-1">
      <form method="POST" action="?/update" use:enhance={enhanceUpdate} aria-busy={submitting === 'update'}>
        <input type="hidden" name="actionId" value={editAction.draft.id} />
        <input type="hidden" name="actorName" value={actorName} />
        <div class="modal-heading">
          <div>
            <span class="modal-eyebrow">Draft — not sent</span>
            <h2 id="edit-draft-title">Edit {actionLabel(editAction.draft.type)}</h2>
            <p>Saving changes records an edit in the case timeline.</p>
          </div>
          <button class="icon-button" type="button" aria-label="Cancel draft editing" onclick={closeModals}><Icon name="x" size={16} /></button>
        </div>
        <div class="modal-body">
          <label><span class="label">Recipient</span><input class="input-ui" value={editAction.draft.recipient ?? 'Recipient required'} disabled /></label>
          <label><span class="label">Subject</span><input class="input-ui" name="subject" bind:value={editSubject} maxlength="200" required /></label>
          <label><span class="label">Message</span><textarea class="input-ui" name="body" bind:value={editBody} maxlength="5000" required></textarea></label>
          <p class="acting-user">Editing as <b>{actorName}</b></p>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" type="button" onclick={closeModals}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={!editSubject.trim() || !editBody.trim() || submitting !== null}>
            {submitting === 'update' ? 'Saving draft…' : 'Save Draft'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

{#if approveAction}
  <div class="modal-backdrop show">
    <button class="absolute inset-0 cursor-default" type="button" aria-label="Cancel action approval" onclick={closeModals}></button>
    <div class="modal-panel relative z-[1] max-w-[540px]" role="dialog" aria-modal="true" aria-labelledby="approve-action-title" tabindex="-1">
      <form method="POST" action="?/approve" use:enhance={enhanceApproval} aria-busy={submitting === 'approve'}>
        <input type="hidden" name="actionId" value={approveAction.draft.id} />
        <input type="hidden" name="actorName" value={actorName} />
        <div class="modal-heading">
          <div>
            <span class="modal-eyebrow">Human confirmation</span>
            <h2 id="approve-action-title">Approve {actionLabel(approveAction.draft.type)}?</h2>
            <p>Confirm responsibility for this prepared action in {approveAction.caseRecord.caseNumber}.</p>
          </div>
          <button class="icon-button" type="button" aria-label="Cancel action approval" onclick={closeModals}><Icon name="x" size={16} /></button>
        </div>
        <div class="modal-body">
          <dl class="confirm-summary">
            <div><dt>Recipient</dt><dd>{approveAction.draft.recipient ?? 'Recipient required'}</dd></div>
            <div><dt>Subject</dt><dd>{approveAction.draft.subject}</dd></div>
            <div><dt>Recorded result</dt><dd>SIMULATED SEND</dd></div>
          </dl>
          <label>
            <span class="label">Approving reviewer</span>
            <input class="input-ui" name="visibleActorName" bind:value={actorName} maxlength="80" required />
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" type="button" onclick={closeModals}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={!actorName.trim() || submitting !== null}>
            {submitting === 'approve' ? 'Recording approval…' : 'Confirm Approval'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .approvals-page,
  .approval-notice {
    max-width: 1080px;
    margin-right: auto;
    margin-left: auto;
  }

  .approval-notice {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 15px;
    border: 1px solid #cfe8d8;
    border-radius: 10px;
    background: #f5fcf7;
    padding: 11px 13px;
    color: #237c50;
    font-size: 10px;
  }

  .approval-notice > span {
    display: grid;
    place-items: center;
  }

  .approval-notice p {
    margin: 0;
  }

  .approval-notice > a {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 5px;
    margin-left: auto;
    color: #6330c8;
    font-size: 9px;
    font-weight: 700;
    white-space: nowrap;
  }

  .approval-notice--error {
    border-color: #f1cfd1;
    background: #fff8f8;
    color: #a7353b;
  }

  .approvals-heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 18px;
  }

  .eyebrow,
  .modal-eyebrow {
    display: block;
    color: #7542dd;
    font-size: 8px;
    font-weight: 750;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .approvals-heading h1 {
    margin: 6px 0 0;
    font-size: 26px;
    font-weight: 750;
    letter-spacing: -0.035em;
    line-height: 1.1;
  }

  .approvals-heading p {
    margin: 7px 0 0;
    color: #716b7b;
    font-size: 11px;
    line-height: 1.5;
  }

  .simulation-boundary {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 23px;
    border: 1px solid #f0d3a2;
    border-radius: 12px;
    background: #fffaf1;
    padding: 13px 15px;
  }

  .simulation-boundary > span {
    display: grid;
    width: 36px;
    height: 36px;
    flex: 0 0 auto;
    place-items: center;
    border-radius: 9px;
    background: #fff0d8;
    color: #a76b18;
  }

  .simulation-boundary strong {
    font-size: 10px;
  }

  .simulation-boundary p {
    margin: 4px 0 0;
    color: #716b7b;
    font-size: 9px;
    line-height: 1.5;
  }

  .approval-section + .approval-section {
    margin-top: 28px;
  }

  .approval-section__heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 11px;
  }

  .approval-section__heading h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 750;
    letter-spacing: -0.015em;
  }

  .approval-section__heading p {
    margin: 4px 0 0;
    color: #716b7b;
    font-size: 9px;
  }

  .queue-count {
    border-radius: 999px;
    background: #f0edf3;
    padding: 5px 9px;
    color: #716b7b;
    font-size: 8px;
    font-weight: 700;
  }

  .queue-count--active {
    background: #f1e9ff;
    color: #6330c8;
  }

  .pending-list {
    display: grid;
    gap: 12px;
  }

  .approval-card {
    overflow: hidden;
  }

  .approval-card__heading {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid #eae4f2;
    background: #fdfbff;
  }

  .approval-card__icon {
    display: grid;
    width: 38px;
    height: 38px;
    place-items: center;
    border-radius: 9px;
    background: #f1e9ff;
    color: #6330c8;
  }

  .approval-card__title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
  }

  .approval-card__title h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 750;
  }

  .approval-card__heading p {
    margin: 4px 0 0;
    color: #716b7b;
    font-size: 8px;
  }

  .approval-card__case {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .approval-card__case a {
    color: #6330c8;
    font-size: 9px;
    font-weight: 700;
  }

  .approval-card__body {
    padding: 16px;
  }

  .approval-fields {
    display: grid;
    grid-template-columns: minmax(180px, 0.7fr) minmax(260px, 1.3fr);
    gap: 14px 26px;
    margin: 0;
  }

  .approval-fields__message {
    grid-column: 1 / -1;
  }

  .approval-fields dt {
    color: #716b7b;
    font-size: 8px;
    font-weight: 650;
  }

  .approval-fields dd {
    margin: 5px 0 0;
    font-size: 9px;
    font-weight: 650;
    line-height: 1.6;
  }

  .approval-fields__message dd {
    max-width: 850px;
    color: #514b59;
    font-weight: 450;
    white-space: pre-wrap;
  }

  .approval-fields__missing {
    color: #c44349;
  }

  .approval-card__actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    margin-top: 15px;
    padding-top: 13px;
    border-top: 1px solid #eee9f4;
  }

  .approval-card__actions > span {
    color: #716b7b;
    font-size: 8px;
  }

  .approval-card__actions > div {
    display: flex;
    gap: 7px;
  }

  .decisions-complete {
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 18px;
  }

  .decisions-complete > span {
    display: grid;
    width: 40px;
    height: 40px;
    flex: 0 0 auto;
    place-items: center;
    border-radius: 50%;
    background: #e2f5e9;
    color: #268d5c;
  }

  .decisions-complete h3 {
    margin: 0;
    font-size: 11px;
  }

  .decisions-complete p {
    margin: 4px 0 0;
    color: #716b7b;
    font-size: 9px;
  }

  .recorded-list {
    overflow: hidden;
    border: 1px solid #eae4f2;
    border-radius: 12px;
    background: white;
  }

  .recorded-row {
    display: grid;
    grid-template-columns: auto minmax(180px, 1fr) auto minmax(210px, 0.85fr) auto;
    align-items: center;
    gap: 12px;
    padding: 13px 15px;
  }

  .recorded-row + .recorded-row {
    border-top: 1px solid #eee9f4;
  }

  .recorded-row__icon {
    display: grid;
    width: 32px;
    height: 32px;
    place-items: center;
    border-radius: 50%;
    background: #e2f5e9;
    color: #268d5c;
  }

  .recorded-row__icon--muted {
    background: #f0edf3;
    color: #716b7b;
  }

  .recorded-row h3 {
    margin: 0;
    font-size: 10px;
  }

  .recorded-row p {
    overflow: hidden;
    margin: 4px 0 0;
    color: #716b7b;
    font-size: 8px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recorded-row p a {
    color: #6330c8;
    font-weight: 700;
  }

  .recorded-row__result strong,
  .recorded-row__result span {
    display: block;
  }

  .recorded-row__result strong {
    font-size: 9px;
  }

  .recorded-row__result span {
    margin-top: 3px;
    color: #716b7b;
    font-size: 8px;
  }

  .recorded-row__open {
    display: grid;
    width: 30px;
    height: 30px;
    place-items: center;
    border-radius: 7px;
    color: #716b7b;
  }

  .recorded-row__open:hover {
    background: #f1e9ff;
    color: #6330c8;
  }

  .approvals-empty {
    display: grid;
    min-height: 330px;
    place-items: center;
    align-content: center;
    padding: 32px;
    text-align: center;
  }

  .approvals-empty > span {
    display: grid;
    width: 48px;
    height: 48px;
    place-items: center;
    border-radius: 50%;
    background: #f1e9ff;
    color: #6330c8;
  }

  .approvals-empty h2 {
    margin: 15px 0 0;
    font-size: 15px;
  }

  .approvals-empty p {
    max-width: 360px;
    margin: 7px 0 16px;
    color: #716b7b;
    font-size: 10px;
    line-height: 1.5;
  }

  .modal-heading,
  .modal-actions {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 17px 19px;
  }

  .modal-heading {
    align-items: flex-start;
    border-bottom: 1px solid #eae4f2;
  }

  .modal-heading h2 {
    margin: 5px 0 0;
    font-size: 17px;
  }

  .modal-heading p {
    margin: 5px 0 0;
    color: #716b7b;
    font-size: 9px;
  }

  .modal-body {
    display: grid;
    gap: 15px;
    padding: 19px;
  }

  .modal-body textarea {
    min-height: 150px;
    resize: vertical;
  }

  .acting-user {
    margin: 0;
    color: #716b7b;
    font-size: 8px;
  }

  .confirm-summary {
    display: grid;
    gap: 10px;
    margin: 0;
    border: 1px solid #eae4f2;
    border-radius: 10px;
    padding: 13px;
  }

  .confirm-summary div {
    display: grid;
    grid-template-columns: 100px minmax(0, 1fr);
    gap: 12px;
  }

  .confirm-summary dt {
    color: #716b7b;
    font-size: 8px;
  }

  .confirm-summary dd {
    margin: 0;
    font-size: 9px;
    font-weight: 650;
  }

  .modal-actions {
    align-items: center;
    justify-content: flex-end;
    border-top: 1px solid #eae4f2;
    background: #fdfbff;
  }

  @media (max-width: 760px) {
    .approvals-heading {
      align-items: stretch;
      flex-direction: column;
    }

    .approval-card__heading {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .approval-card__case {
      grid-column: 2;
      justify-content: flex-start;
    }

    .approval-fields {
      grid-template-columns: 1fr;
    }

    .approval-fields__message {
      grid-column: 1;
    }

    .approval-card__actions {
      align-items: stretch;
      flex-direction: column;
    }

    .approval-card__actions > div,
    .approval-card__actions .btn {
      width: 100%;
    }

    .recorded-row {
      grid-template-columns: auto minmax(0, 1fr) auto;
    }

    .recorded-row > .badge,
    .recorded-row__result {
      grid-column: 2;
      justify-self: start;
    }

    .recorded-row__open {
      grid-column: 3;
      grid-row: 1 / span 3;
    }

    .approval-notice {
      align-items: flex-start;
      flex-wrap: wrap;
    }

    .approval-notice > a {
      width: 100%;
      margin-left: 26px;
    }
  }

  @media (max-width: 520px) {
    .simulation-boundary {
      align-items: flex-start;
    }

    .approval-section__heading {
      align-items: flex-start;
    }

    .approval-card__actions > div {
      flex-direction: column;
    }

    .confirm-summary div {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }
</style>
