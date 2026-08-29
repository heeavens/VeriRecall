<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Icon from '$lib/components/Icon.svelte';

  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let monitoring = $state(false);
  let monitorMessage = $state<string | null>(null);
  let monitorFailed = $state(false);

  type DashboardAlert = PageProps['data']['alerts'][number];

  interface TrendPoint {
    label: string;
    count: number;
    x: number;
    y: number;
  }

  const confirmedMatches = $derived(
    data.alerts.filter((alert) => alert.status === 'matched').length
  );
  const notRelevant = $derived(
    data.alerts.filter((alert) => alert.status === 'not_relevant').length
  );
  const hardConflicts = $derived(
    data.alerts.filter((alert) => alert.bestMatch?.hasHardConflict).length
  );
  const totalAlerts = $derived(data.alerts.length);
  const statusGradient = $derived(
    buildStatusGradient(totalAlerts, data.counters.waitingForReview, confirmedMatches)
  );
  const trendPoints = $derived(buildTrend(data.alerts));
  const trendLine = $derived(buildLinePath(trendPoints));
  const trendArea = $derived(buildAreaPath(trendPoints));
  const criticalAlerts = $derived(
    data.alerts.filter((alert) => isPriorityRisk(alert.risk)).slice(0, 3)
  );
  const recentAlerts = $derived(data.alerts.slice(0, 4));

  const metrics = $derived([
    {
      label: 'New Alerts Today',
      value: data.counters.newAlertsToday,
      detail: `${totalAlerts} official record${totalAlerts === 1 ? '' : 's'} in the feed`,
      detailClass: 'text-[#e14f55]',
      icon: 'radio-tower' as const
    },
    {
      label: 'Waiting for Review',
      value: data.counters.waitingForReview,
      detail: `${hardConflicts} hard conflict${hardConflicts === 1 ? '' : 's'}`,
      detailClass: 'text-muted',
      icon: 'scan-search' as const
    },
    {
      label: 'Confirmed Matches',
      value: confirmedMatches,
      detail: 'catalogue matches',
      detailClass: 'text-muted',
      icon: 'circle-check-big' as const
    },
    {
      label: 'Open Cases',
      value: data.counters.openCases,
      detail: 'active incident records',
      detailClass: 'text-[#df8b31]',
      icon: 'briefcase-business' as const
    },
    {
      label: 'Closed This Month',
      value: data.counters.closedThisMonth,
      detail: 'resolved this month',
      detailClass: 'text-[#2aa96b]',
      icon: 'archive-check' as const
    }
  ]);

  function statusLabel(status: DashboardAlert['status']): string {
    if (status === 'matched') return 'Confirmed';
    if (status === 'needs_review') return 'Needs Review';
    return 'Not Relevant';
  }

  function statusClass(status: DashboardAlert['status']): string {
    if (status === 'matched') return 'badge-green';
    if (status === 'needs_review') return 'badge-blue';
    return 'badge-gray';
  }

  function activityDotClass(status: DashboardAlert['status']): string {
    if (status === 'matched') return 'bg-[#2aa96b]';
    if (status === 'needs_review') return 'bg-[#8150e4]';
    return 'bg-[#a9a3ae]';
  }

  function progressClass(status: DashboardAlert['status']): string {
    if (status === 'matched') return 'bg-[#2aa96b]';
    if (status === 'needs_review') return 'bg-[#dc8f34]';
    return 'bg-[#a9a3ae]';
  }

  function sourceLabel(source: DashboardAlert['source']): string {
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

  function isPriorityRisk(risk: string): boolean {
    return /(serious|choking|injur|fire|shock|danger)/i.test(risk);
  }

  function riskClass(risk: string): string {
    return isPriorityRisk(risk) ? 'badge-red' : 'badge-orange';
  }

  function riskLabel(risk: string): string {
    return isPriorityRisk(risk) ? 'High' : 'Medium';
  }

  function buildStatusGradient(total: number, review: number, confirmed: number): string {
    if (total === 0) return 'conic-gradient(#ede3fb 0 100%)';
    const reviewEnd = (review / total) * 100;
    const confirmedEnd = reviewEnd + (confirmed / total) * 100;
    return `conic-gradient(#8150e4 0 ${reviewEnd}%, #50318d ${reviewEnd}% ${confirmedEnd}%, #ede3fb ${confirmedEnd}% 100%)`;
  }

  function buildTrend(alerts: DashboardAlert[]): TrendPoint[] {
    const validDates = alerts
      .map((alert) => new Date(alert.publishedAt))
      .filter((date) => !Number.isNaN(date.getTime()));
    const anchor = validDates.length
      ? new Date(Math.max(...validDates.map((date) => date.getTime())))
      : new Date();
    const months = Array.from({ length: 6 }, (_, index) => {
      const date = new Date(
        Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - (5 - index), 1)
      );
      const count = alerts.filter((alert) => {
        const published = new Date(alert.publishedAt);
        return (
          published.getUTCFullYear() === date.getUTCFullYear() &&
          published.getUTCMonth() === date.getUTCMonth()
        );
      }).length;
      return {
        label: new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(date),
        count
      };
    });
    const maximum = Math.max(1, ...months.map((month) => month.count));

    return months.map((month, index) => ({
      ...month,
      x: 34 + index * (476 / 5),
      y: 146 - (month.count / maximum) * 112
    }));
  }

  function buildLinePath(points: TrendPoint[]): string {
    return points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
      .join(' ');
  }

  function buildAreaPath(points: TrendPoint[]): string {
    if (points.length === 0) return '';
    const first = points[0];
    const last = points.at(-1);
    return last ? `${buildLinePath(points)} L ${last.x} 146 L ${first.x} 146 Z` : '';
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

<svelte:head>
  <title>Overview | Recall Agent</title>
  <meta
    name="description"
    content="Monitor official product alerts and catalogue matches requiring review."
  />
</svelte:head>

<section aria-labelledby="overview-title">
  <div class="mb-4 flex items-start justify-between gap-5">
    <div>
      <h1 id="overview-title" class="text-[24px] font-bold tracking-[-.035em]">
        Product Recall Overview
      </h1>
      <p class="mt-1 text-[12px] text-muted">
        Monitor official alerts and catalogue matches requiring your attention.
      </p>
    </div>
    <button class="btn btn-primary" type="button" onclick={runMonitoring} disabled={monitoring}>
      <Icon name="refresh-cw" size={16} class={monitoring ? 'animate-spin' : ''} />
      {monitoring ? 'Monitoring…' : 'Run Monitoring'}
    </button>
  </div>

  {#if monitorMessage}
    <div
      class={`mb-4 flex items-start gap-2 rounded-[10px] border px-3.5 py-3 text-[10px] ${monitorFailed ? 'border-[#ffd9db] bg-[#fff8f8] text-[#a7353b]' : 'border-[#d7f2e3] bg-[#f4fcf7] text-[#268d5c]'}`}
      role="status"
    >
      <Icon name={monitorFailed ? 'triangle-alert' : 'circle-check-big'} size={15} />
      <span class="leading-4">{monitorMessage}</span>
    </div>
  {/if}

  <div class="card metric-divider mb-4 grid grid-cols-5 overflow-hidden">
    {#each metrics as metric}
      <article class="p-4">
        <div class="flex items-center gap-2 text-[10px] font-semibold text-violet-600">
          <Icon name={metric.icon} size={16} class="text-[#58515f]" />
          {metric.label}
        </div>
        <p class="mt-2 text-[21px] font-bold">{metric.value}</p>
        <p class={`mt-1 text-[10px] ${metric.detailClass}`}>{metric.detail}</p>
      </article>
    {/each}
  </div>

  <div class="grid grid-cols-12 gap-4">
    <article class="card col-span-4 p-4">
      <div class="flex items-center justify-between gap-4">
        <h2 class="text-[15px] font-bold">Match Status Overview</h2>
        <a class="text-[10px] font-semibold text-violet-600 hover:text-violet-700" href="/review">
          View Queue
        </a>
      </div>
      <div class="mt-5 flex items-center justify-center gap-5">
        <div
          class="ring-chart h-[126px] w-[126px] shrink-0"
          style:background={statusGradient}
          aria-label={`${totalAlerts} alerts by match status`}
        >
          <div class="ring-center">
            <span class="text-[20px] font-bold">{totalAlerts}</span>
            <span class="text-[9px] text-muted">Total</span>
          </div>
        </div>
        <div class="space-y-2 text-[9px]">
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-sm bg-[#8150e4]"></span>
            <span class="w-[94px] text-muted">Needs Review</span>
            <b>{data.counters.waitingForReview}</b>
          </div>
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-sm bg-[#50318d]"></span>
            <span class="w-[94px] text-muted">Confirmed</span>
            <b>{confirmedMatches}</b>
          </div>
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-sm bg-[#ede3fb]"></span>
            <span class="w-[94px] text-muted">Not Relevant</span>
            <b>{notRelevant}</b>
          </div>
        </div>
      </div>
    </article>

    <article class="card col-span-5 p-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-[15px] font-bold">Alerts Processed</h2>
          <p class="mt-1 text-[9px] text-muted">Official alerts compared with your catalogue</p>
        </div>
        <span class="rounded-lg border border-line bg-white px-2.5 py-2 text-[9px] text-muted">
          Six-month archive
        </span>
      </div>
      <div class="mt-3 h-[148px] w-full">
        <svg
          viewBox="0 0 520 175"
          class="h-full w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label="Alerts processed by published month"
        >
          <defs>
            <linearGradient id="alerts-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#a982f0" stop-opacity=".26" />
              <stop offset="1" stop-color="#a982f0" stop-opacity="0" />
            </linearGradient>
          </defs>
          <g stroke="#eee9f3" stroke-width="1">
            <line x1="34" y1="20" x2="510" y2="20" />
            <line x1="34" y1="62" x2="510" y2="62" />
            <line x1="34" y1="104" x2="510" y2="104" />
            <line x1="34" y1="146" x2="510" y2="146" />
          </g>
          <path d={trendArea} fill="url(#alerts-area)" />
          <path
            d={trendLine}
            fill="none"
            stroke="#8b5be8"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          {#each trendPoints as point}
            <circle cx={point.x} cy={point.y} r="3.5" fill="#8b5be8">
              <title>{point.label}: {point.count} alerts</title>
            </circle>
            <text x={point.x} y="166" fill="#8d8795" font-size="10" text-anchor="middle">
              {point.label}
            </text>
          {/each}
        </svg>
      </div>
    </article>

    <article class="card col-span-3 p-4">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-[15px] font-bold">Critical Alerts</h2>
        <span class="text-[9px] font-semibold text-violet-600">{criticalAlerts.length} active</span>
      </div>
      {#if criticalAlerts.length === 0}
        <div class="grid min-h-[154px] place-items-center text-center">
          <p class="max-w-[180px] text-[10px] leading-5 text-muted">
            No priority risks are present in the current alert feed.
          </p>
        </div>
      {:else}
        <div class="mt-3 divide-y divide-[#f0ecf4]">
          {#each criticalAlerts as alert}
            <a
              class="group flex w-full items-start justify-between gap-3 py-2.5 text-left"
              href={`/alerts/${alert.id}`}
            >
              <span class="min-w-0">
                <b class="block truncate text-[10px] group-hover:text-violet-600">
                  {alert.risk}
                </b>
                <span class="mt-1 block truncate text-[9px] text-muted">
                  {sourceLabel(alert.source)} · {alert.bestMatch ? `${alert.bestMatch.totalScore}% candidate` : 'No candidate'}
                </span>
              </span>
              <Icon name="chevron-right" size={14} class="mt-0.5 shrink-0 text-muted" />
            </a>
          {/each}
        </div>
      {/if}
    </article>

    <div class="col-span-9 mt-1 min-w-0">
      <div class="mb-2.5 flex items-end justify-between gap-4">
        <div>
          <h2 class="text-[15px] font-bold">Alert Feed</h2>
          <p class="mt-1 text-[9px] text-muted">Latest official records and best catalogue candidates</p>
        </div>
        <span class="text-[9px] font-semibold text-muted">
          {data.alerts.length} alert{data.alerts.length === 1 ? '' : 's'}
        </span>
      </div>

      <div class="table-wrap">
        {#if data.alerts.length === 0}
          <div class="grid min-h-[236px] place-items-center px-6 text-center">
            <div>
              <span class="mx-auto grid h-10 w-10 place-items-center rounded-full bg-violet-50 text-violet-600">
                <Icon name="radio-tower" size={18} />
              </span>
              <p class="mt-3 text-[11px] font-semibold">No alerts have been imported</p>
              <p class="mt-1 text-[9px] text-muted">Run monitoring to process the local archive.</p>
            </div>
          </div>
        {:else}
          <div class="overflow-x-auto">
            <table class="data-table min-w-[850px]">
              <thead>
                <tr>
                  <th>Official Product</th>
                  <th>Catalogue Candidate</th>
                  <th class="w-[104px]">Source</th>
                  <th class="w-[118px]">Risk</th>
                  <th class="w-[92px]">Published</th>
                  <th class="w-[110px]">Confidence</th>
                  <th class="w-[112px]">Status</th>
                  <th class="w-[34px]"><span class="sr-only">Open alert</span></th>
                </tr>
              </thead>
              <tbody>
                {#each data.alerts as alert}
                  <tr>
                    <td>
                      <a
                        class="block truncate font-semibold text-[#302b35] hover:text-violet-600"
                        href={`/alerts/${alert.id}`}
                        title={alert.productName}
                      >
                        {alert.productName}
                      </a>
                      <span class="mt-1 block text-[8px] text-muted">{alert.sourceReference}</span>
                    </td>
                    <td>
                      {#if alert.bestMatch}
                        <span class="block truncate font-medium text-[#4d4853]" title={alert.bestMatch.product.name}>{alert.bestMatch.product.name}</span>
                        <span class="mt-1 block text-[8px] text-muted">{alert.bestMatch.product.sku}</span>
                      {:else}
                        <span class="text-muted">No catalogue candidates</span>
                      {/if}
                    </td>
                    <td>
                      <span class="font-medium text-[#4d4853]">{sourceLabel(alert.source)}</span>
                    </td>
                    <td>
                      <span class={`badge ${riskClass(alert.risk)}`} title={alert.risk}>{riskLabel(alert.risk)}</span>
                    </td>
                    <td class="whitespace-nowrap">{formatDate(alert.publishedAt)}</td>
                    <td>
                      {#if alert.bestMatch}
                        <div class="font-semibold">{alert.bestMatch.totalScore}%</div>
                        <div class="progress-track mt-1">
                          <div
                            class={`progress-value ${progressClass(alert.status)}`}
                            style:width={`${alert.bestMatch.totalScore}%`}
                          ></div>
                        </div>
                      {:else}
                        <span class="text-muted">—</span>
                      {/if}
                    </td>
                    <td><span class={`badge ${statusClass(alert.status)}`}>{statusLabel(alert.status)}</span></td>
                    <td>
                      <a
                        class="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-violet-50 hover:text-violet-600"
                        href={`/alerts/${alert.id}`}
                        aria-label={`Open ${alert.productName}`}
                      >
                        <Icon name="chevron-right" size={14} />
                      </a>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <div class="flex h-12 items-center border-t border-line px-3 text-[9px] text-muted">
            Showing {data.alerts.length} of {data.alerts.length} alerts
          </div>
        {/if}
      </div>
    </div>

    <article class="card col-span-3 mt-1 p-4">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-[15px] font-bold">Recent Activity</h2>
        <span class="text-[9px] font-semibold text-violet-600">Live feed</span>
      </div>
      {#if recentAlerts.length === 0}
        <p class="mt-4 text-[10px] leading-5 text-muted">
          Monitoring activity will appear after the first archive cycle.
        </p>
      {:else}
        <div class="mt-3 space-y-3">
          {#each recentAlerts as alert}
            <a class="group block" href={`/alerts/${alert.id}`}>
              <div class="flex items-start gap-2.5">
                <span class={`mt-1 h-2 w-2 shrink-0 rounded-full ${activityDotClass(alert.status)}`}></span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-start justify-between gap-2">
                    <b class="truncate text-[10px] group-hover:text-violet-600">
                      {statusLabel(alert.status)}
                    </b>
                    <span class="shrink-0 text-[8px] text-muted">{formatDate(alert.publishedAt)}</span>
                  </span>
                  <span class="mt-1 block truncate text-[9px] text-muted">
                    {alert.productName} · {alert.sourceReference}
                  </span>
                </span>
              </div>
            </a>
          {/each}
        </div>
      {/if}
    </article>
  </div>
</section>
