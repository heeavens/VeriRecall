<script lang="ts">
  import { invalidateAll } from '$app/navigation';

  let { data } = $props();
  let monitoring = $state(false);
  let monitorMessage = $state<string | null>(null);
  let monitorFailed = $state(false);

  const cards = $derived([
    { label: 'New alerts today', value: data.counters.newAlertsToday, tone: 'blue' },
    { label: 'Waiting for review', value: data.counters.waitingForReview, tone: 'amber' },
    { label: 'Open cases', value: data.counters.openCases, tone: 'red' },
    { label: 'Closed this month', value: data.counters.closedThisMonth, tone: 'green' }
  ]);

  function statusLabel(status: string): string {
    if (status === 'matched') return 'Confirmed match';
    if (status === 'needs_review') return 'Needs review';
    return 'Not relevant';
  }

  function statusClass(status: string): string {
    if (status === 'matched') return 'bg-emerald-50 text-emerald-700 ring-emerald-600/15';
    if (status === 'needs_review') return 'bg-amber-50 text-amber-700 ring-amber-600/20';
    return 'bg-slate-100 text-slate-600 ring-slate-500/15';
  }

  function sourceLabel(source: string): string {
    return source === 'safety_gate' ? 'Safety Gate' : 'RASFF';
  }

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(new Date(value));
  }

  function isMonitoringResult(
    value: unknown
  ): value is { imported: number; matched: number; review: number; ignored: number } {
    if (typeof value !== 'object' || value === null) return false;
    const result = value as Record<string, unknown>;
    return ['imported', 'matched', 'review', 'ignored'].every(
      (key) => typeof result[key] === 'number'
    );
  }

  async function runMonitoring(): Promise<void> {
    monitoring = true;
    monitorMessage = null;
    monitorFailed = false;
    try {
      const response = await fetch('/api/monitor', { method: 'POST' });
      const result: unknown = await response.json();
      if (!response.ok || !isMonitoringResult(result)) throw new Error('Monitoring failed');
      monitorMessage = result.imported
        ? `Imported ${result.imported} alert${result.imported === 1 ? '' : 's'}: ${result.matched} matched, ${result.review} for review, ${result.ignored} not relevant.`
        : 'Monitoring is up to date. No new archived alerts were found.';
      await invalidateAll();
    } catch {
      monitorFailed = true;
      monitorMessage = 'Monitoring could not be completed. Please try again.';
    } finally {
      monitoring = false;
    }
  }
</script>

<svelte:head><title>Overview | RecallOps AI</title></svelte:head>

<section aria-labelledby="overview-title">
  <div class="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <p class="text-xs font-semibold tracking-[0.16em] text-blue-600 uppercase">Workspace overview</p>
      <h1 id="overview-title" class="mt-2 text-3xl font-semibold tracking-tight text-slate-950">Recall monitoring</h1>
      <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Local archive alerts are matched against your catalogue with deterministic scoring.</p>
    </div>
    <button class="btn btn-primary" type="button" onclick={runMonitoring} disabled={monitoring}>
      {monitoring ? 'Monitoring…' : 'Run monitoring'}
    </button>
  </div>

  {#if monitorMessage}
    <p class={`mt-4 rounded-xl border px-4 py-3 text-sm ${monitorFailed ? 'border-red-200 bg-red-50 text-red-700' : 'border-blue-200 bg-blue-50 text-blue-700'}`} role="status">
      {monitorMessage}
    </p>
  {/if}

  <div class="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
    {#each cards as card}
      <article class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/40">
        <div class={`flex size-9 items-center justify-center rounded-xl ${card.tone === 'blue' ? 'bg-blue-50 text-blue-600' : card.tone === 'amber' ? 'bg-amber-50 text-amber-600' : card.tone === 'red' ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`} aria-hidden="true">
          <span class="size-2 rounded-full bg-current"></span>
        </div>
        <p class="mt-5 text-3xl font-semibold tracking-tight text-slate-950">{card.value}</p>
        <p class="mt-1 text-sm text-slate-500">{card.label}</p>
      </article>
    {/each}
  </div>

  <div class="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/40">
    <div class="flex items-center justify-between border-b border-slate-200 px-5 py-4 sm:px-6">
      <div>
        <h2 class="text-base font-semibold text-slate-900">Alert Feed</h2>
        <p class="mt-0.5 text-xs text-slate-500">Latest official records and their best catalogue candidates</p>
      </div>
      <span class="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{data.alerts.length} alerts</span>
    </div>

    {#if data.alerts.length === 0}
      <div class="px-6 py-14 text-center">
        <p class="text-sm font-medium text-slate-700">No alerts have been imported.</p>
        <p class="mt-1 text-sm text-slate-500">Run monitoring to process the local archive.</p>
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full min-w-[900px] border-collapse text-left">
          <thead class="bg-slate-50/80 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
            <tr>
              <th class="px-6 py-3">Alert product</th>
              <th class="px-4 py-3">Source</th>
              <th class="px-4 py-3">Risk</th>
              <th class="px-4 py-3">Published</th>
              <th class="px-4 py-3">Best catalogue match</th>
              <th class="px-4 py-3">Confidence</th>
              <th class="px-6 py-3">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            {#each data.alerts as alert}
              <tr class="transition hover:bg-slate-50/70">
                <td class="px-6 py-4">
                  <a class="font-semibold text-slate-900 hover:text-blue-700 hover:underline" href={`/alerts/${alert.id}`}>{alert.productName}</a>
                  <p class="mt-1 text-xs text-slate-500">{alert.sourceReference}</p>
                </td>
                <td class="px-4 py-4"><span class="rounded-md bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">{sourceLabel(alert.source)}</span></td>
                <td class="max-w-48 px-4 py-4 text-sm text-red-700">{alert.risk}</td>
                <td class="px-4 py-4 text-sm whitespace-nowrap text-slate-600">{formatDate(alert.publishedAt)}</td>
                <td class="px-4 py-4">
                  {#if alert.bestMatch}
                    <p class="text-sm font-medium text-slate-800">{alert.bestMatch.product.name}</p>
                    <p class="mt-1 text-xs text-slate-500">{alert.bestMatch.product.sku}</p>
                  {:else}
                    <span class="text-sm text-slate-400">No catalogue candidates</span>
                  {/if}
                </td>
                <td class="px-4 py-4 text-sm font-semibold text-slate-800">{alert.bestMatch ? `${alert.bestMatch.totalScore}%` : '—'}</td>
                <td class="px-6 py-4"><span class={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusClass(alert.status)}`}>{statusLabel(alert.status)}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</section>
