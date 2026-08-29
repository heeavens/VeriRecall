<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const openCount = $derived(data.cases.filter((item) => item.caseRecord.status === 'open').length);
  const containedCount = $derived(data.cases.filter((item) => item.caseRecord.status === 'contained').length);
  const closedCount = $derived(data.cases.filter((item) => item.caseRecord.status === 'closed').length);
  const totalStock = $derived(data.cases.reduce((total, item) => total + item.totalStock, 0));

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(new Date(value));
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
</script>

<svelte:head>
  <title>Recall Cases | Recall Agent</title>
  <meta name="description" content="Track recall containment tasks, drafts and defensible audit records." />
</svelte:head>

<section aria-labelledby="cases-title">
  <header class="mb-5 flex items-start justify-between gap-5">
    <div>
      <h1 id="cases-title" class="text-[24px] font-bold tracking-[-.035em]">Recall Cases</h1>
      <p class="mt-1 text-[12px] text-muted">Track confirmed incidents from first response through documented closure.</p>
    </div>
    <a class="btn btn-primary" href="/actions">
      <Icon name="send" size={15} />
      Review Action Drafts
    </a>
  </header>

  <div class="card mb-4 grid grid-cols-4 p-0">
    <div class="p-4">
      <span class="text-[9px] font-semibold tracking-[.13em] text-muted uppercase">Total cases</span>
      <div class="mt-2 text-[24px] font-bold">{data.cases.length}</div>
      <p class="mt-1 text-[9px] text-muted">Confirmed recall records</p>
    </div>
    <div class="metric-divider p-4">
      <span class="text-[9px] font-semibold tracking-[.13em] text-muted uppercase">Open</span>
      <div class="mt-2 text-[24px] font-bold text-[#df8b31]">{openCount}</div>
      <p class="mt-1 text-[9px] text-muted">Containment in progress</p>
    </div>
    <div class="metric-divider p-4">
      <span class="text-[9px] font-semibold tracking-[.13em] text-muted uppercase">Contained / closed</span>
      <div class="mt-2 text-[24px] font-bold text-violet-700">{containedCount + closedCount}</div>
      <p class="mt-1 text-[9px] text-muted">All checklist items resolved</p>
    </div>
    <div class="metric-divider p-4">
      <span class="text-[9px] font-semibold tracking-[.13em] text-muted uppercase">Affected stock</span>
      <div class="mt-2 text-[24px] font-bold">{totalStock}</div>
      <p class="mt-1 text-[9px] text-muted">Units across active records</p>
    </div>
  </div>

  <div class="grid grid-cols-12 gap-4">
    <article class="card col-span-9 overflow-hidden">
      <div class="flex items-center justify-between border-b border-line px-4 py-3.5">
        <div>
          <h2 class="text-[14px] font-bold">Incident Records</h2>
          <p class="mt-0.5 text-[9px] text-muted">Every case links affected inventory, people, actions and audit events.</p>
        </div>
        <span class="badge badge-gray">{data.cases.length} records</span>
      </div>

      {#if data.cases.length > 0}
        <div class="table-wrap m-4 mt-0 border-t-0">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:17%">Case</th>
                <th style="width:27%">Official alert</th>
                <th style="width:13%">Inventory</th>
                <th style="width:20%">Containment</th>
                <th style="width:13%">Actions</th>
                <th style="width:10%">Status</th>
              </tr>
            </thead>
            <tbody>
              {#each data.cases as item}
                <tr>
                  <td>
                    <a class="font-bold text-violet-700 hover:underline" href={`/cases/${item.caseRecord.id}`}>
                      {item.caseRecord.caseNumber}
                    </a>
                    <span class="mt-1 block text-[8px] text-muted">Opened {formatDate(item.caseRecord.openedAt)}</span>
                  </td>
                  <td>
                    <b class="block truncate text-[10px]">{item.alert.productName}</b>
                    <span class="mt-1 block text-[8px] text-muted">{item.alert.sourceReference} · {item.alert.risk}</span>
                  </td>
                  <td>
                    <b>{item.totalStock} units</b>
                    <span class="mt-1 block text-[8px] text-muted">{item.itemCount} affected SKU {item.itemCount === 1 ? 'record' : 'records'}</span>
                  </td>
                  <td>
                    <div class="mb-1.5 flex justify-between text-[8px]">
                      <span>{item.completedTasks}/{item.actionableTasks} complete</span>
                      <b>{item.actionableTasks === 0 ? 100 : Math.round((item.completedTasks / item.actionableTasks) * 100)}%</b>
                    </div>
                    <div class="progress-track">
                      <div
                        class="progress-value"
                        style={`width:${item.actionableTasks === 0 ? 100 : Math.round((item.completedTasks / item.actionableTasks) * 100)}%`}
                      ></div>
                    </div>
                  </td>
                  <td>
                    <b>{item.simulatedCount}/{item.draftCount}</b>
                    <span class="mt-1 block text-[8px] text-muted">simulated sends</span>
                  </td>
                  <td><span class={`badge ${statusClass(item.caseRecord.status)}`}>{statusLabel(item.caseRecord.status)}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="grid min-h-[330px] place-items-center p-8 text-center">
          <div class="max-w-[350px]">
            <span class="mx-auto grid h-12 w-12 place-items-center rounded-full bg-violet-50 text-violet-600">
              <Icon name="briefcase-business" size={20} />
            </span>
            <h3 class="mt-4 text-[15px] font-bold">No confirmed recall cases</h3>
            <p class="mt-2 text-[10px] leading-5 text-muted">A case will appear after a high-confidence or human-confirmed catalogue match.</p>
            <a class="btn btn-ghost mt-4" href="/review">Open Review Queue</a>
          </div>
        </div>
      {/if}
    </article>

    <aside class="col-span-3 space-y-4">
      <article class="card p-4">
        <h2 class="text-[13px] font-bold">Case Status</h2>
        <div class="mt-4 flex items-center justify-center gap-5">
          <div class="ring-chart h-[82px] w-[82px]" style={`background:conic-gradient(#8150e4 ${data.cases.length === 0 ? 0 : Math.round(((containedCount + closedCount) / data.cases.length) * 100)}%,#eae4f2 0)`}>
            <div class="ring-center text-[14px] font-bold">{data.cases.length === 0 ? 0 : Math.round(((containedCount + closedCount) / data.cases.length) * 100)}%</div>
          </div>
          <dl class="space-y-2 text-[9px]">
            <div class="flex items-center gap-2"><span class="h-2 w-2 rounded-full bg-[#df8b31]"></span><dt class="text-muted">Open</dt><dd class="ml-auto font-bold">{openCount}</dd></div>
            <div class="flex items-center gap-2"><span class="h-2 w-2 rounded-full bg-violet-600"></span><dt class="text-muted">Contained</dt><dd class="ml-auto font-bold">{containedCount}</dd></div>
            <div class="flex items-center gap-2"><span class="h-2 w-2 rounded-full bg-[#2aa96b]"></span><dt class="text-muted">Closed</dt><dd class="ml-auto font-bold">{closedCount}</dd></div>
          </dl>
        </div>
      </article>

      <article class="card p-4">
        <div class="flex items-center gap-2 text-violet-700">
          <Icon name="shield-check" size={16} />
          <h2 class="text-[12px] font-bold">Defensible Record</h2>
        </div>
        <p class="mt-2 text-[9px] leading-4 text-muted">Every manual action records its actor and UTC timestamp. Drafts remain unsent until explicit approval.</p>
      </article>

      {#if openCount > 0}
        <article class="rounded-[13px] border border-[#f5d8a7] bg-[#fffaf0] p-4">
          <div class="flex items-start gap-2 text-[#a77026]">
            <Icon name="triangle-alert" size={16} />
            <div>
              <h2 class="text-[11px] font-bold">Closure guard active</h2>
              <p class="mt-1 text-[9px] leading-4">Open cases cannot close until every available checklist task is completed.</p>
            </div>
          </div>
        </article>
      {/if}
    </aside>
  </div>
</section>
