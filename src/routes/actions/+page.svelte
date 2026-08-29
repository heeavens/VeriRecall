<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  let actorName = $state('Herman');
  let editActionId = $state<string | null>(null);
  let approveActionId = $state<string | null>(null);
  let editSubject = $state('');
  let editBody = $state('');

  const editAction = $derived(data.actions.find((item) => item.draft.id === editActionId) ?? null);
  const approveAction = $derived(data.actions.find((item) => item.draft.id === approveActionId) ?? null);
  const draftCount = $derived(data.actions.filter((item) => item.draft.status === 'draft').length);
  const sentCount = $derived(data.actions.filter((item) => item.draft.status === 'simulated_sent').length);
  const unavailableCount = $derived(data.actions.filter((item) => item.draft.status === 'not_available').length);

  function actionLabel(type: string): string {
    if (type === 'block_sale') return 'Block Sale';
    if (type === 'notify_supplier') return 'Supplier Notice';
    return 'Customer Notice';
  }

  function actionDescription(type: string): string {
    if (type === 'block_sale') return 'Internal containment instruction';
    if (type === 'notify_supplier') return 'Supplier recall communication';
    return 'Affected customer communication';
  }

  function statusLabel(status: string): string {
    if (status === 'simulated_sent') return 'SIMULATED SEND';
    if (status === 'not_available') return 'NOT AVAILABLE';
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
  <title>Action Drafts | Recall Agent</title>
  <meta name="description" content="Edit and manually approve simulated recall containment actions." />
</svelte:head>

<svelte:window onkeydown={closeOnEscape} />

{#if form?.message}
  <div
    class={`mb-4 flex items-start gap-2 rounded-[10px] border px-3.5 py-3 text-[10px] ${form.success ? 'border-[#d7f2e3] bg-[#f4fcf7] text-[#268d5c]' : 'border-[#ffd9db] bg-[#fff8f8] text-[#a7353b]'}`}
    role="status"
  >
    <Icon name={form.success ? 'circle-check-big' : 'triangle-alert'} size={15} />
    <span>{form.message}</span>
  </div>
{/if}

<section aria-labelledby="actions-title">
  <header class="mb-5 flex items-start justify-between gap-5">
    <div>
      <h1 id="actions-title" class="text-[24px] font-bold tracking-[-.035em]">Action Drafts</h1>
      <p class="mt-1 text-[12px] text-muted">Edit containment communications and require human approval before any simulated send.</p>
    </div>
    <div class="flex gap-2">
      <a class="btn btn-secondary" href="/cases"><Icon name="briefcase-business" size={15} /> All Cases</a>
      {#if data.actions[0]}
        <a class="btn btn-primary" href={`/cases/${data.actions[0].caseRecord.id}`}><Icon name="arrow-right" size={15} /> Open Case</a>
      {/if}
    </div>
  </header>

  <div class="grid grid-cols-12 gap-4">
    <div class="col-span-8 space-y-4">
      {#if data.actions.length > 0}
        {#each data.actions as item}
          <article class="card overflow-hidden">
            <header class="flex items-start justify-between gap-4 border-b border-line bg-[#fdfbff] px-5 py-4">
              <div class="flex items-start gap-3">
                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-violet-50 text-violet-600">
                  <Icon name={item.draft.type === 'block_sale' ? 'warehouse' : 'send'} size={17} />
                </span>
                <div>
                  <div class="flex flex-wrap items-center gap-2">
                    <h2 class="text-[14px] font-bold">{actionLabel(item.draft.type)}</h2>
                    <span class={`badge ${statusClass(item.draft.status)}`}>{statusLabel(item.draft.status)}</span>
                  </div>
                  <p class="mt-1 text-[9px] text-muted">{actionDescription(item.draft.type)} · <a class="font-semibold text-violet-600 hover:underline" href={`/cases/${item.caseRecord.id}`}>{item.caseRecord.caseNumber}</a></p>
                </div>
              </div>
              <span class="badge badge-red">{item.alert.risk}</span>
            </header>

            <div class="p-5">
              <div class="grid grid-cols-[110px_1fr] gap-x-4 gap-y-3 text-[10px]">
                <span class="text-muted">Recipient</span>
                <b class={item.draft.recipient ? '' : 'text-[#e14f55]'}>{item.draft.recipient ?? 'Recipient required'}</b>
                <span class="text-muted">Subject</span>
                <b>{item.draft.subject}</b>
                <span class="text-muted">Message</span>
                <p class="whitespace-pre-wrap leading-5 text-[#514b59]">{item.draft.body}</p>
              </div>

              {#if item.draft.status === 'draft'}
                <div class="mt-4 flex items-center justify-between gap-4 rounded-xl border border-[#e4d3ff] bg-[#f8f4ff] p-3">
                  <div class="flex items-center gap-2 text-[9px] text-violet-700">
                    <Icon name="shield-check" size={15} />
                    <span><b>DRAFT — NOT SENT.</b> Review content and recipient before approval.</span>
                  </div>
                  <div class="flex shrink-0 gap-2">
                    <button class="btn btn-secondary" type="button" onclick={() => openEdit(item.draft.id)}>Edit</button>
                    <button
                      class="btn btn-primary"
                      type="button"
                      onclick={() => (approveActionId = item.draft.id)}
                      disabled={item.draft.type !== 'block_sale' && !item.draft.recipient}
                    >
                      Approve & Send
                    </button>
                  </div>
                </div>
              {:else if item.draft.status === 'simulated_sent'}
                <div class="mt-4 flex items-center justify-between gap-4 rounded-xl border border-[#d7f2e3] bg-[#f4fcf7] p-3 text-[9px] text-[#268d5c]">
                  <span class="flex items-center gap-2"><Icon name="circle-check-big" size={15} /><b>SIMULATED SEND — no external provider contacted.</b></span>
                  <span>{item.draft.approvedBy} · {item.draft.approvedAt ? formatDate(item.draft.approvedAt) : ''}</span>
                </div>
              {:else}
                <div class="mt-4 rounded-xl bg-[#f3f2f5] p-3 text-[9px] text-muted">This action is not available because the case has no matching customer data.</div>
              {/if}
            </div>
          </article>
        {/each}
      {:else}
        <article class="card grid min-h-[430px] place-items-center p-8 text-center">
          <div class="max-w-[360px]">
            <span class="mx-auto grid h-12 w-12 place-items-center rounded-full bg-violet-50 text-violet-600"><Icon name="send" size={20} /></span>
            <h2 class="mt-4 text-[16px] font-bold">No action drafts</h2>
            <p class="mt-2 text-[10px] leading-5 text-muted">Drafts are created when a confirmed catalogue match opens a recall case.</p>
            <a class="btn btn-ghost mt-4" href="/cases">Return to Cases</a>
          </div>
        </article>
      {/if}
    </div>

    <aside class="col-span-4 space-y-4">
      <article class="card p-4">
        <h2 class="text-[14px] font-bold">Draft Summary</h2>
        <div class="mt-4 grid grid-cols-3 gap-2 text-center">
          <div class="rounded-xl bg-violet-50 p-3"><b class="block text-[20px] text-violet-700">{draftCount}</b><span class="text-[8px] text-muted">Not sent</span></div>
          <div class="rounded-xl bg-[#ecfbf3] p-3"><b class="block text-[20px] text-[#2aa96b]">{sentCount}</b><span class="text-[8px] text-muted">Simulated</span></div>
          <div class="rounded-xl bg-[#f3f2f5] p-3"><b class="block text-[20px] text-[#787280]">{unavailableCount}</b><span class="text-[8px] text-muted">Unavailable</span></div>
        </div>
        <label class="mt-4 block border-t border-line pt-4" for="action-actor-name">
          <span class="label">Approving reviewer</span>
          <input id="action-actor-name" class="input-ui" bind:value={actorName} maxlength="80" />
        </label>
      </article>

      <article class="rounded-[13px] border border-[#f5d8a7] bg-[#fffaf0] p-4">
        <div class="flex items-start gap-3 text-[#a77026]">
          <Icon name="triangle-alert" size={18} />
          <div>
            <h2 class="text-[12px] font-bold">Simulation only</h2>
            <p class="mt-1 text-[9px] leading-4">Approve & Send records human approval and a simulated-send audit event. It never contacts email, POS, ERP or inventory providers.</p>
          </div>
        </div>
      </article>

      <article class="card p-4">
        <h2 class="text-[13px] font-bold">Approval Sequence</h2>
        <ol class="mt-4 space-y-3">
          <li class="flex gap-3 text-[9px]"><span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-violet-50 font-bold text-violet-700">1</span><span><b class="block text-[10px]">Review and edit</b><span class="text-muted">Confirm recipient, subject and action content.</span></span></li>
          <li class="flex gap-3 text-[9px]"><span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-violet-50 font-bold text-violet-700">2</span><span><b class="block text-[10px]">Explicit confirmation</b><span class="text-muted">Enter the accountable reviewer name.</span></span></li>
          <li class="flex gap-3 text-[9px]"><span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-violet-50 font-bold text-violet-700">3</span><span><b class="block text-[10px]">Append audit events</b><span class="text-muted">Store approval and simulation timestamps.</span></span></li>
        </ol>
      </article>
    </aside>
  </div>
</section>

{#if editAction}
  <div class="modal-backdrop show">
    <button class="absolute inset-0 cursor-default" type="button" aria-label="Cancel draft editing" onclick={closeModals}></button>
    <div class="modal-panel relative z-[1]" role="dialog" aria-modal="true" aria-labelledby="edit-draft-title" tabindex="-1">
      <form method="POST" action="?/update">
        <input type="hidden" name="actionId" value={editAction.draft.id} />
        <input type="hidden" name="actorName" value={actorName} />
        <div class="flex items-start justify-between border-b border-line p-5">
          <div><h2 id="edit-draft-title" class="text-[18px] font-bold">Edit {actionLabel(editAction.draft.type)}</h2><p class="mt-1 text-[10px] text-muted">Changes are recorded in the append-only audit timeline.</p></div>
          <button class="icon-button" type="button" aria-label="Cancel draft editing" onclick={closeModals}><Icon name="x" size={16} /></button>
        </div>
        <div class="space-y-4 p-5">
          <label><span class="label">Recipient</span><input class="input-ui" value={editAction.draft.recipient ?? 'Recipient required'} disabled /></label>
          <label><span class="label">Subject</span><input class="input-ui" name="subject" bind:value={editSubject} maxlength="200" required /></label>
          <label><span class="label">Message</span><textarea class="input-ui" name="body" bind:value={editBody} maxlength="5000" required></textarea></label>
          <div class="rounded-xl bg-violet-50 p-3 text-[9px] text-violet-700"><b>DRAFT — NOT SENT.</b> Saving edits does not approve or send this action.</div>
        </div>
        <div class="flex justify-end gap-2 border-t border-line bg-[#fdfbff] px-5 py-4">
          <button class="btn btn-secondary" type="button" onclick={closeModals}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={!editSubject.trim() || !editBody.trim()}>Save Draft</button>
        </div>
      </form>
    </div>
  </div>
{/if}

{#if approveAction}
  <div class="modal-backdrop show">
    <button class="absolute inset-0 cursor-default" type="button" aria-label="Cancel action approval" onclick={closeModals}></button>
    <div class="modal-panel relative z-[1] max-w-[540px]" role="dialog" aria-modal="true" aria-labelledby="approve-action-title" tabindex="-1">
      <form method="POST" action="?/approve">
        <input type="hidden" name="actionId" value={approveAction.draft.id} />
        <input type="hidden" name="actorName" value={actorName} />
        <div class="flex items-start justify-between border-b border-line p-5">
          <div><h2 id="approve-action-title" class="text-[18px] font-bold">Approve {actionLabel(approveAction.draft.type)}?</h2><p class="mt-1 text-[10px] text-muted">Confirm a human-reviewed simulation for {approveAction.caseRecord.caseNumber}.</p></div>
          <button class="icon-button" type="button" aria-label="Cancel action approval" onclick={closeModals}><Icon name="x" size={16} /></button>
        </div>
        <div class="p-5">
          <div class="rounded-xl border border-[#f5d8a7] bg-[#fffaf0] p-4">
            <div class="flex gap-3 text-[#a77026]"><Icon name="triangle-alert" size={18} /><div><b class="block text-[11px]">No external send will occur</b><p class="mt-1 text-[9px] leading-4">This MVP records approval and marks the draft <b>SIMULATED SEND</b>. It does not contact an email, POS, ERP or inventory provider.</p></div></div>
          </div>
          <dl class="mt-4 grid grid-cols-[90px_1fr] gap-x-4 gap-y-3 text-[10px]">
            <dt class="text-muted">Recipient</dt><dd class="font-semibold">{approveAction.draft.recipient ?? 'Recipient required'}</dd>
            <dt class="text-muted">Subject</dt><dd class="font-semibold">{approveAction.draft.subject}</dd>
          </dl>
          <label class="mt-4 block"><span class="label">Approving reviewer</span><input class="input-ui" name="visibleActorName" bind:value={actorName} maxlength="80" required /></label>
        </div>
        <div class="flex justify-end gap-2 border-t border-line bg-[#fdfbff] px-5 py-4">
          <button class="btn btn-secondary" type="button" onclick={closeModals}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={!actorName.trim()}>Confirm Simulated Send</button>
        </div>
      </form>
    </div>
  </div>
{/if}
