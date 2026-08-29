<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  let actorName = $state('Herman');
  let closeOpen = $state(false);

  const canClose = $derived(
    data.tasks.length === 3 && data.tasks.every((task) => task.status !== 'pending')
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
    if (status === 'contained') return 'Contained';
    if (status === 'closed') return 'Closed';
    return 'Open';
  }

  function statusClass(status: string): string {
    if (status === 'contained') return 'badge-purple';
    if (status === 'closed') return 'badge-green';
    return 'badge-orange';
  }

  function taskStatusLabel(status: string): string {
    if (status === 'completed') return 'Completed';
    if (status === 'not_available') return 'Not available';
    return 'Pending';
  }

  function taskStatusClass(status: string): string {
    if (status === 'completed') return 'badge-green';
    if (status === 'not_available') return 'badge-gray';
    return 'badge-yellow';
  }

  function draftStatusLabel(status: string): string {
    if (status === 'simulated_sent') return 'SIMULATED SEND';
    if (status === 'not_available') return 'NOT AVAILABLE';
    return 'DRAFT — NOT SENT';
  }

  function draftStatusClass(status: string): string {
    if (status === 'simulated_sent') return 'badge-green';
    if (status === 'not_available') return 'badge-gray';
    return 'badge-purple';
  }

  function actionLabel(type: string): string {
    if (type === 'block_sale') return 'Block Sale';
    if (type === 'notify_supplier') return 'Supplier Notice';
    return 'Customer Notice';
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
    class={`mb-4 flex items-start gap-2 rounded-[10px] border px-3.5 py-3 text-[10px] ${form.success ? 'border-[#d7f2e3] bg-[#f4fcf7] text-[#268d5c]' : 'border-[#ffd9db] bg-[#fff8f8] text-[#a7353b]'}`}
    role="status"
  >
    <Icon name={form.success ? 'circle-check-big' : 'triangle-alert'} size={15} />
    <span>{form.message}</span>
  </div>
{/if}

<section aria-labelledby="case-title">
  <nav class="mb-3 flex items-center gap-1.5 text-[10px] font-semibold text-violet-600" aria-label="Breadcrumb">
    <a href="/cases">Recall Cases</a>
    <span aria-hidden="true">→</span>
    <span>{data.caseRecord.caseNumber}</span>
  </nav>

  <header class="mb-5 flex items-start justify-between gap-5">
    <div>
      <div class="flex flex-wrap items-center gap-2">
        <h1 id="case-title" class="text-[23px] font-bold tracking-[-.03em]">{data.caseRecord.caseNumber}</h1>
        <span class={`badge ${statusClass(data.caseRecord.status)}`}>{statusLabel(data.caseRecord.status)}</span>
        <span class="badge badge-red">{data.caseRecord.severity} severity</span>
      </div>
      <div class="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-[10px] text-muted">
        <span>Alert: <b class="text-ink">{data.alert.sourceReference}</b></span>
        <span>Source: <b class="text-ink">{sourceLabel(data.alert.source)}</b></span>
        <span>Opened: <b class="text-ink">{formatDate(data.caseRecord.openedAt)}</b></span>
        <span>Reviewer: <b class="text-ink">{actorName}</b></span>
      </div>
    </div>
    <div class="flex shrink-0 gap-2">
      <a class="btn btn-secondary" href={`/actions?case=${data.caseRecord.id}`}>
        <Icon name="send" size={15} /> Action Drafts
      </a>
      {#if data.caseRecord.status !== 'closed'}
        <button class="btn btn-primary" type="button" onclick={() => (closeOpen = true)}>
          <Icon name="shield-check" size={15} /> Close Case
        </button>
      {/if}
    </div>
  </header>

  <div class="grid grid-cols-12 gap-4">
    <div class="col-span-5 space-y-4">
      <article class="card p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-[14px] font-bold">Affected Products</h2>
            <p class="mt-0.5 text-[9px] text-muted">Confirmed catalogue items included in this incident.</p>
          </div>
          <span class="badge badge-red">{data.totalStock} units</span>
        </div>
        <div class="mt-4 space-y-3">
          {#each data.items as row}
            <div class="rounded-xl border border-line p-3">
              <div class="flex gap-3">
                <span class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-violet-50 text-violet-600">
                  <Icon name="package" size={19} />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <b class="block text-[11px]">{row.product.name}</b>
                      <span class="mt-0.5 block text-[9px] text-muted">{row.product.sku} · {row.product.brand}</span>
                    </div>
                    <b class="shrink-0 text-[11px]">{row.item.stockQuantity} units</b>
                  </div>
                  <dl class="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-[9px]">
                    <div><dt class="text-muted">Affected batch</dt><dd class="mt-0.5 font-semibold">{row.item.batch}</dd></div>
                    <div><dt class="text-muted">EAN / GTIN</dt><dd class="mt-0.5 font-semibold">{row.product.ean ?? 'Not provided'}</dd></div>
                    <div><dt class="text-muted">Supplier</dt><dd class="mt-0.5 font-semibold">{row.product.supplierName ?? 'Not provided'}</dd></div>
                    <div><dt class="text-muted">Category</dt><dd class="mt-0.5 font-semibold">{row.product.category ?? 'Not provided'}</dd></div>
                  </dl>
                </div>
              </div>
            </div>
          {/each}
        </div>
      </article>

      <article class="card overflow-hidden">
        <div class="flex items-center justify-between border-b border-line px-4 py-3.5">
          <div>
            <h2 class="text-[14px] font-bold">Affected Customers</h2>
            <p class="mt-0.5 text-[9px] text-muted">Purchase records matching the affected SKU and batch.</p>
          </div>
          <span class="badge badge-blue">{data.customers.length} records</span>
        </div>
        {#if data.customers.length > 0}
          <div class="table-wrap m-4 mt-0 border-t-0">
            <table class="data-table">
              <thead><tr><th>Customer</th><th>SKU / batch</th><th>Purchased</th><th>Qty</th></tr></thead>
              <tbody>
                {#each data.customers as customer}
                  <tr>
                    <td><b>{customer.name ?? customer.externalId}</b><span class="mt-1 block text-[8px] text-muted">{customer.email ?? 'Email unavailable'}</span></td>
                    <td>{customer.sku}<span class="mt-1 block text-[8px] text-muted">{customer.batch ?? 'Batch not recorded'}</span></td>
                    <td>{formatDate(customer.purchasedAt)}</td>
                    <td>{customer.quantity}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="m-4 rounded-xl bg-[#f3f2f5] p-4 text-[9px] leading-4 text-muted">No affected customer purchase records are available. The customer-notification task is marked not available.</p>
        {/if}
      </article>

      <article class="card p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-[14px] font-bold">Audit Timeline</h2>
            <p class="mt-0.5 text-[9px] text-muted">Append-only record of agent and human decisions.</p>
          </div>
          <span class="badge badge-gray">{data.timeline.length} events</span>
        </div>
        {#if data.timeline.length > 0}
          <div class="timeline mt-5">
            <div class="timeline-line"></div>
            {#each data.timeline as event}
              <div class="timeline-step pb-4">
                <span class={`timeline-dot ${event.actorType === 'human' ? 'bg-violet-100 text-violet-700' : 'bg-[#edf4ff] text-[#4c80df]'}`}>
                  <Icon name={event.actorType === 'human' ? 'check' : 'sparkles'} size={14} />
                </span>
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <div class="flex items-center gap-2">
                      <b class="text-[10px]">{event.summary}</b>
                      <span class={`badge ${event.actorType === 'human' ? 'badge-purple' : 'badge-blue'}`}>{event.actorType}</span>
                    </div>
                    <p class="mt-1 text-[9px] text-muted">{event.actorName} · {event.eventType.replaceAll('_', ' ')}</p>
                  </div>
                  <time class="shrink-0 text-[8px] text-muted" datetime={event.createdAt}>{formatDate(event.createdAt)}</time>
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <p class="mt-4 rounded-xl bg-[#f3f2f5] p-4 text-[9px] text-muted">No audit events have been recorded for this case.</p>
        {/if}
      </article>
    </div>

    <div class="col-span-3 space-y-4">
      <article class="card p-4">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-[14px] font-bold">Containment Checklist</h2>
          <span class="text-[10px] font-bold text-violet-700">{data.completedTasks}/{data.actionableTasks}</span>
        </div>
        <div class="progress-track mt-3">
          <div class="progress-value" style={`width:${data.actionableTasks === 0 ? 100 : Math.round((data.completedTasks / data.actionableTasks) * 100)}%`}></div>
        </div>
        <label class="mt-4 block border-t border-line pt-4" for="case-actor-name">
          <span class="label">Acting reviewer</span>
          <input id="case-actor-name" class="input-ui" bind:value={actorName} maxlength="80" />
        </label>
        <div class="mt-4 space-y-3">
          {#each data.tasks as task, index}
            <div class="rounded-xl border border-line p-3">
              <div class="flex items-start gap-2.5">
                <span class={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${task.status === 'completed' ? 'bg-[#e1f7ea] text-[#2aa96b]' : task.status === 'not_available' ? 'bg-[#f3f2f5] text-[#787280]' : 'bg-[#fff0d8] text-[#be8420]'}`}>
                  {#if task.status === 'completed'}<Icon name="check" size={14} />{:else}<span class="text-[9px] font-bold">{index + 1}</span>{/if}
                </span>
                <div class="min-w-0 flex-1">
                  <b class="block text-[10px]">{task.label}</b>
                  <span class={`badge mt-2 ${taskStatusClass(task.status)}`}>{taskStatusLabel(task.status)}</span>
                  {#if task.completedBy && task.completedAt}
                    <p class="mt-2 text-[8px] leading-3 text-muted">{task.completedBy} · {formatDate(task.completedAt)}</p>
                  {/if}
                </div>
              </div>
              {#if task.status === 'pending' && data.caseRecord.status !== 'closed'}
                <form class="mt-3" method="POST" action="?/completeTask">
                  <input type="hidden" name="taskId" value={task.id} />
                  <input type="hidden" name="actorName" value={actorName} />
                  <button class="btn btn-secondary w-full" type="submit">Mark Complete</button>
                </form>
              {/if}
            </div>
          {/each}
        </div>
      </article>

      <article class="rounded-[13px] border border-[#f5d8a7] bg-[#fffaf0] p-4">
        <div class="flex gap-2 text-[#a77026]">
          <Icon name="shield-alert" size={17} />
          <div>
            <h2 class="text-[11px] font-bold">Closure safety check</h2>
            <p class="mt-1 text-[9px] leading-4">{canClose ? 'All available tasks are complete. The case can be closed with confirmation.' : 'Closure is blocked while an available containment task remains pending.'}</p>
          </div>
        </div>
      </article>
    </div>

    <aside class="col-span-4 space-y-4">
      <article class="card p-4">
        <h2 class="text-[14px] font-bold">Case Snapshot</h2>
        <dl class="mt-4 space-y-3 text-[10px]">
          <div class="flex justify-between gap-4"><dt class="text-muted">Official reference</dt><dd class="text-right font-semibold">{data.alert.sourceReference}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Alert product</dt><dd class="text-right font-semibold">{data.alert.productName}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Match confidence</dt><dd class="text-right font-semibold">{data.match?.totalScore ?? 0}%</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Affected stock</dt><dd class="text-right font-semibold">{data.totalStock} units</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Customer records</dt><dd class="text-right font-semibold">{data.customers.length}</dd></div>
        </dl>
        <a class="btn btn-ghost mt-4 w-full" href={data.alert.sourceUrl} target="_blank" rel="noreferrer">
          Official Source <Icon name="external-link" size={13} />
        </a>
      </article>

      <article class="card p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-[14px] font-bold">Manual Actions</h2>
            <p class="mt-0.5 text-[9px] text-muted">No external side effect occurs before approval.</p>
          </div>
          <a class="text-[9px] font-semibold text-violet-600 hover:underline" href={`/actions?case=${data.caseRecord.id}`}>Open all</a>
        </div>
        <div class="mt-4 space-y-3">
          {#each data.drafts as draft}
            <div class="rounded-xl border border-line p-3">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <b class="block text-[10px]">{actionLabel(draft.type)}</b>
                  <span class="mt-1 block text-[8px] text-muted">{draft.recipient ?? 'Recipient required'}</span>
                </div>
                <span class={`badge ${draftStatusClass(draft.status)}`}>{draftStatusLabel(draft.status)}</span>
              </div>
              <p class="mt-3 line-clamp-2 text-[9px] leading-4 text-muted">{draft.subject}</p>
              {#if draft.approvedBy && draft.approvedAt}
                <p class="mt-2 text-[8px] text-[#268d5c]">{draft.approvedBy} · {formatDate(draft.approvedAt)}</p>
              {/if}
            </div>
          {/each}
        </div>
        <a class="btn btn-primary mt-4 w-full" href={`/actions?case=${data.caseRecord.id}`}>
          Review & Approve <Icon name="arrow-right" size={14} />
        </a>
      </article>
    </aside>
  </div>
</section>

{#if closeOpen}
  <div class="modal-backdrop show">
    <button class="absolute inset-0 cursor-default" type="button" aria-label="Cancel case closure" onclick={() => (closeOpen = false)}></button>
    <div class="modal-panel relative z-[1] max-w-[520px]" role="dialog" aria-modal="true" aria-labelledby="close-case-title" tabindex="-1">
      <form method="POST" action="?/close">
        <input type="hidden" name="actorName" value={actorName} />
        <div class="flex items-start justify-between border-b border-line p-5">
          <div>
            <h2 id="close-case-title" class="text-[18px] font-bold">Close {data.caseRecord.caseNumber}?</h2>
            <p class="mt-1 text-[10px] text-muted">Closure is permanent in the append-only incident record.</p>
          </div>
          <button class="icon-button" type="button" aria-label="Cancel case closure" onclick={() => (closeOpen = false)}><Icon name="x" size={16} /></button>
        </div>
        <div class="p-5">
          <div class={`rounded-xl border p-4 ${canClose ? 'border-[#d7f2e3] bg-[#f4fcf7]' : 'border-[#f5d8a7] bg-[#fffaf0]'}`}>
            <div class="flex gap-3">
              <Icon name={canClose ? 'shield-check' : 'triangle-alert'} size={18} class={canClose ? 'text-[#2aa96b]' : 'text-[#be8420]'} />
              <div>
                <b class="block text-[11px]">{canClose ? 'Containment checklist complete' : 'Case closure blocked'}</b>
                <p class="mt-1 text-[9px] leading-4 text-muted">{canClose ? 'Closing will record your name and the current UTC timestamp.' : 'Complete every available checklist task before closing this case.'}</p>
              </div>
            </div>
          </div>
          <label class="mt-4 block">
            <span class="label">Closing reviewer</span>
            <input class="input-ui" name="visibleActorName" bind:value={actorName} maxlength="80" />
          </label>
        </div>
        <div class="flex justify-end gap-2 border-t border-line bg-[#fdfbff] px-5 py-4">
          <button class="btn btn-secondary" type="button" onclick={() => (closeOpen = false)}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={!canClose || !actorName.trim()}>Confirm Closure</button>
        </div>
      </form>
    </div>
  </div>
{/if}
