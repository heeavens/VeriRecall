<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import Icon from '$lib/components/Icon.svelte';

  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let monitoring = $state(false);
  let monitorMessage = $state<string | null>(null);
  let monitorFailed = $state(false);
  let monitorNext = $state<{ href: string; label: string } | null>(null);

  type DashboardAlert = PageProps['data']['alerts'][number];
  type AttentionItem = PageProps['data']['attention'][number];

  const recentAlerts = $derived(data.alerts.slice(0, 4));
  const setupReady = $derived(page.url.searchParams.get('setup') === 'ready');

  function attentionIcon(kind: AttentionItem['kind']): string {
    if (kind === 'review') return 'scan-search';
    if (kind === 'approval') return 'shield-check';
    return 'briefcase-business';
  }

  function statusLabel(status: DashboardAlert['status']): string {
    if (status === 'matched') return 'Confirmed match';
    if (status === 'needs_review') return 'Needs review';
    return 'Not relevant';
  }

  function statusClass(status: DashboardAlert['status']): string {
    if (status === 'matched') return 'badge-green';
    if (status === 'needs_review') return 'badge-orange';
    return 'badge-gray';
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

  function formatDateTime(value: string): string {
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
    monitorNext = null;
    try {
      const response = await fetch('/api/monitor', { method: 'POST' });
      const result: unknown = await response.json();
      if (!response.ok || !isMonitoringResult(result)) throw new Error('Monitoring failed');
      monitorMessage = result.imported
        ? `Archive check complete: ${result.imported} new alert${result.imported === 1 ? '' : 's'}, ${result.matched} matched, ${result.review} for review and ${result.ignored} not relevant.`
        : 'Archive check complete. No new records were found in the local prototype archive.';
      await invalidateAll();
      monitorNext = result.review > 0 || data.counters.waitingForReview > 0
        ? { href: '/review', label: 'Open Review Queue' }
        : data.counters.pendingApprovals > 0
          ? { href: '/actions', label: 'Open Approvals' }
          : result.matched > 0 || data.counters.unfinishedCases > 0
            ? { href: '/cases', label: 'View Cases' }
            : { href: '/catalogue', label: 'Review Catalogue' };
    } catch {
      monitorFailed = true;
      monitorMessage = 'The archived alerts could not be checked. Please try again.';
    } finally {
      monitoring = false;
    }
  }
</script>

<svelte:head>
  <title>Overview | Recall Agent</title>
  <meta
    name="description"
    content="Review catalogue matches, pending approvals and active recall cases."
  />
</svelte:head>

<section aria-labelledby="overview-title">
  <header class="overview-heading">
    <div>
      <h1 id="overview-title">Product Recall Overview</h1>
      <p>Start with the items that need a person, then check the local alert archive when ready.</p>
    </div>
    <button id="archive-check" class="btn btn-primary" type="button" onclick={runMonitoring} disabled={monitoring} aria-busy={monitoring}>
      <Icon name="refresh-cw" size={16} class={monitoring ? 'animate-spin' : ''} />
      {monitoring ? 'Checking archive…' : 'Check archived alerts'}
    </button>
  </header>

  {#if setupReady}
    <div class="workspace-ready" role="status">
      <Icon name="circle-check-big" size={17} />
      <div>
        <strong>Workspace ready</strong>
        <span>Your catalogue is available and the archived prototype alerts are ready to review.</span>
      </div>
      <a href="/catalogue">Review Catalogue <Icon name="arrow-right" size={14} /></a>
    </div>
  {/if}

  {#if monitorMessage}
    <div class:monitor-notice--failed={monitorFailed} class="monitor-notice" role="status">
      <Icon name={monitorFailed ? 'triangle-alert' : 'circle-check-big'} size={17} />
      <span>{monitorMessage}</span>
      {#if monitorNext && !monitorFailed}
        <a href={monitorNext.href}>{monitorNext.label} <Icon name="arrow-right" size={14} /></a>
      {/if}
    </div>
  {/if}

  <div class="overview-priority-grid">
    <article class="card attention-panel">
      <header class="panel-heading">
        <div>
          <div class="panel-title-row">
            <h2>Needs your attention</h2>
            <span class="attention-count">{data.attention.length}</span>
          </div>
          <p>Manual decisions and containment work, ordered by the next action.</p>
        </div>
        <div class="attention-summary" aria-label="Pending work summary">
          <span><b>{data.counters.waitingForReview}</b> review</span>
          <span><b>{data.counters.pendingApprovals}</b> approvals</span>
          <span><b>{data.counters.unfinishedCases}</b> cases</span>
        </div>
      </header>

      {#if data.attention.length > 0}
        <div class="attention-list">
          {#each data.attention as item (item.id)}
            <a class={`attention-item attention-item--${item.kind}`} href={item.href}>
              <span class="attention-item__icon"><Icon name={attentionIcon(item.kind)} size={18} /></span>
              <span class="attention-item__content">
                <span class="attention-item__label">{item.label}</span>
                <strong>{item.title}</strong>
                <span class="attention-item__description">{item.description}</span>
                <small>{item.meta}</small>
              </span>
              <span class="attention-item__action">
                {item.actionLabel}
                <Icon name="arrow-right" size={15} />
              </span>
            </a>
          {/each}
        </div>
      {:else}
        <div class="attention-empty">
          <span><Icon name="circle-check-big" size={21} /></span>
          <h3>No manual actions are waiting</h3>
          <p>
            {data.archive.total > 0
              ? 'All current archive results have a recorded outcome. Check the archive again when you are ready.'
              : 'Upload or review your catalogue, then check the local archive for official alerts.'}
          </p>
          <a class="btn btn-secondary" href="/catalogue">Review catalogue</a>
        </div>
      {/if}
    </article>

    <aside class="card archive-panel" aria-labelledby="archive-title">
      <div class="archive-panel__eyebrow">
        <Icon name="archive-check" size={16} />
        Archived prototype input
      </div>
      <h2 id="archive-title">Current archive snapshot</h2>
      <p class="archive-panel__copy">
        Local Safety Gate and RASFF fixtures compared with {data.archive.catalogueProducts}
        catalogue product{data.archive.catalogueProducts === 1 ? '' : 's'}.
      </p>

      {#if data.archive.lastImportedAt}
        <dl class="archive-stats">
          <div>
            <dt>Records</dt>
            <dd>{data.archive.total}</dd>
          </div>
          <div>
            <dt>Confirmed</dt>
            <dd class="archive-stat--success">{data.archive.matched}</dd>
          </div>
          <div>
            <dt>For review</dt>
            <dd class="archive-stat--warning">{data.archive.needsReview}</dd>
          </div>
          <div>
            <dt>Not relevant</dt>
            <dd>{data.archive.notRelevant}</dd>
          </div>
        </dl>
        <p class="archive-timestamp">
          Last imported record set<br />
          <strong>{formatDateTime(data.archive.lastImportedAt)}</strong>
        </p>
      {:else}
        <div class="archive-not-checked">
          <Icon name="radio-tower" size={19} />
          <div>
            <strong>Archive not checked yet</strong>
            <span>Run the local prototype archive after your catalogue is ready.</span>
          </div>
        </div>
      {/if}

      <div class="archive-links">
        <a href="/catalogue">Open catalogue <Icon name="chevron-right" size={14} /></a>
        <a href="/cases">View cases <Icon name="chevron-right" size={14} /></a>
      </div>
    </aside>
  </div>

  <section class="latest-alerts" aria-labelledby="latest-alerts-title">
    <header class="latest-alerts__heading">
      <div>
        <h2 id="latest-alerts-title">Latest official alerts</h2>
        <p>Recent records from the local archive and their current catalogue outcome.</p>
      </div>
      <span>{recentAlerts.length} of {data.alerts.length} records</span>
    </header>

    <div class="card latest-alerts__card">
      {#if recentAlerts.length > 0}
        <div class="latest-alerts__list">
          {#each recentAlerts as alert (alert.id)}
            <a class="latest-alert" href={`/alerts/${alert.id}`}>
              <span class="latest-alert__icon"><Icon name="shield-alert" size={18} /></span>
              <span class="latest-alert__product">
                <strong>{alert.productName}</strong>
                <small>{sourceLabel(alert.source)} · {alert.sourceReference} · {formatDate(alert.publishedAt)}</small>
              </span>
              <span class="latest-alert__risk">
                <small>Official source risk</small>
                <strong>{alert.risk}</strong>
              </span>
              <span class="latest-alert__match">
                {#if alert.bestMatch}
                  <strong>{alert.bestMatch.product.name}</strong>
                  <small>{alert.bestMatch.product.sku} · {alert.bestMatch.totalScore}% confidence</small>
                {:else}
                  <strong>No catalogue candidate</strong>
                  <small>Open the record for details</small>
                {/if}
              </span>
              <span class={`badge ${statusClass(alert.status)}`}>{statusLabel(alert.status)}</span>
              <Icon name="chevron-right" size={16} class="latest-alert__arrow" />
            </a>
          {/each}
        </div>
      {:else}
        <div class="latest-alerts__empty">
          <span><Icon name="radio-tower" size={21} /></span>
          <h3>No archived alerts checked yet</h3>
          <p>The first archive check will compare official fixtures with your catalogue.</p>
        </div>
      {/if}
    </div>
  </section>
</section>

<style>
  .overview-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 18px;
  }

  .overview-heading h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -0.035em;
  }

  .overview-heading p {
    margin: 5px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .monitor-notice {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    margin-bottom: 14px;
    border: 1px solid #cdeedc;
    border-radius: 10px;
    background: #f4fcf7;
    padding: 12px 14px;
    color: #277c52;
    font-size: 12px;
    line-height: 1.5;
  }

  .workspace-ready {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
    border: 1px solid #cdeedc;
    border-radius: 10px;
    background: #f4fcf7;
    padding: 12px 14px;
    color: #277c52;
  }

  .workspace-ready strong,
  .workspace-ready span {
    display: block;
  }

  .workspace-ready strong {
    font-size: 10px;
  }

  .workspace-ready span {
    margin-top: 3px;
    color: #557164;
    font-size: 9px;
  }

  .workspace-ready > a {
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

  .monitor-notice--failed {
    border-color: #f1d5d7;
    background: #fff8f8;
    color: #a7353b;
  }

  .monitor-notice > span {
    min-width: 0;
  }

  .monitor-notice > a {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 5px;
    margin-left: auto;
    color: #6330c8;
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
  }

  .overview-priority-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.8fr) minmax(280px, 0.72fr);
    gap: 14px;
  }

  .attention-panel,
  .archive-panel {
    min-height: 390px;
  }

  .attention-panel {
    overflow: hidden;
  }

  .panel-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    border-bottom: 1px solid var(--line);
    padding: 17px 18px;
  }

  .panel-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .panel-heading h2,
  .archive-panel h2,
  .latest-alerts__heading h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.015em;
  }

  .panel-heading p,
  .latest-alerts__heading p {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }

  .attention-count {
    display: grid;
    min-width: 23px;
    height: 23px;
    place-items: center;
    border-radius: 999px;
    background: #f1e9ff;
    color: var(--violet-700);
    font-size: 10px;
    font-weight: 700;
  }

  .attention-summary {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--muted);
    font-size: 10px;
    white-space: nowrap;
  }

  .attention-summary b {
    margin-right: 2px;
    color: var(--ink);
    font-size: 12px;
  }

  .attention-list {
    display: grid;
  }

  .attention-item {
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    min-height: 100px;
    border-bottom: 1px solid #f0ecf4;
    padding: 14px 18px;
    transition: background 0.15s ease;
  }

  .attention-item:last-child {
    border-bottom: 0;
  }

  .attention-item:hover {
    background: #fcfaff;
  }

  .attention-item__icon {
    display: grid;
    width: 38px;
    height: 38px;
    place-items: center;
    border-radius: 10px;
    background: #fff6e9;
    color: #b46f22;
  }

  .attention-item--approval .attention-item__icon {
    background: #f1e9ff;
    color: var(--violet-700);
  }

  .attention-item--case .attention-item__icon {
    background: #edf4ff;
    color: #4675c9;
  }

  .attention-item__content {
    min-width: 0;
  }

  .attention-item__label,
  .attention-item__description,
  .attention-item__content small {
    display: block;
  }

  .attention-item__label {
    margin-bottom: 3px;
    color: var(--muted);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .attention-item__content strong {
    display: block;
    overflow: hidden;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attention-item__description {
    margin-top: 4px;
    overflow: hidden;
    color: #59535f;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attention-item__content small {
    margin-top: 4px;
    color: var(--muted);
    font-size: 10px;
  }

  .attention-item__action {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--violet-700);
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
  }

  .attention-empty,
  .latest-alerts__empty {
    display: grid;
    min-height: 310px;
    place-items: center;
    align-content: center;
    padding: 32px;
    text-align: center;
  }

  .attention-empty > span,
  .latest-alerts__empty > span {
    display: grid;
    width: 48px;
    height: 48px;
    place-items: center;
    border-radius: 999px;
    background: #ecfbf3;
    color: #2aa96b;
  }

  .attention-empty h3,
  .latest-alerts__empty h3 {
    margin: 13px 0 0;
    font-size: 15px;
  }

  .attention-empty p,
  .latest-alerts__empty p {
    max-width: 430px;
    margin: 6px 0 16px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.6;
  }

  .archive-panel {
    padding: 18px;
  }

  .archive-panel__eyebrow {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 12px;
    color: var(--violet-700);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .archive-panel__copy {
    margin: 7px 0 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.55;
  }

  .archive-stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 18px 0 0;
  }

  .archive-stats > div {
    border-radius: 9px;
    background: #f8f6fa;
    padding: 10px 11px;
  }

  .archive-stats dt {
    color: var(--muted);
    font-size: 9px;
  }

  .archive-stats dd {
    margin: 5px 0 0;
    font-size: 20px;
    font-weight: 700;
  }

  .archive-stats .archive-stat--success {
    color: #278c5c;
  }

  .archive-stats .archive-stat--warning {
    color: #a66b1b;
  }

  .archive-timestamp {
    margin: 14px 0 0;
    border-top: 1px solid var(--line);
    padding-top: 13px;
    color: var(--muted);
    font-size: 10px;
    line-height: 1.55;
  }

  .archive-timestamp strong {
    color: #4f4956;
  }

  .archive-not-checked {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: 18px;
    border-radius: 10px;
    background: #f8f6fa;
    padding: 13px;
    color: var(--muted);
  }

  .archive-not-checked strong,
  .archive-not-checked span {
    display: block;
  }

  .archive-not-checked strong {
    color: var(--ink);
    font-size: 11px;
  }

  .archive-not-checked span {
    margin-top: 4px;
    font-size: 10px;
    line-height: 1.5;
  }

  .archive-links {
    display: grid;
    gap: 8px;
    margin-top: 14px;
  }

  .archive-links a {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-top: 1px solid var(--line);
    padding-top: 10px;
    color: #5b5562;
    font-size: 11px;
    font-weight: 650;
  }

  .archive-links a:hover {
    color: var(--violet-700);
  }

  .latest-alerts {
    margin-top: 18px;
  }

  .latest-alerts__heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 9px;
  }

  .latest-alerts__heading > span {
    color: var(--muted);
    font-size: 10px;
  }

  .latest-alerts__card {
    overflow: hidden;
  }

  .latest-alerts__list {
    display: grid;
  }

  .latest-alert {
    display: grid;
    grid-template-columns: 34px minmax(180px, 1.15fr) minmax(150px, 0.8fr) minmax(190px, 1fr) auto 16px;
    align-items: center;
    gap: 12px;
    min-height: 78px;
    border-bottom: 1px solid #f0ecf4;
    padding: 12px 15px;
    transition: background 0.15s ease;
  }

  .latest-alert:last-child {
    border-bottom: 0;
  }

  .latest-alert:hover {
    background: #fcfaff;
  }

  .latest-alert__icon {
    display: grid;
    width: 34px;
    height: 34px;
    place-items: center;
    border-radius: 9px;
    background: #fff0f0;
    color: #c7454c;
  }

  .latest-alert__product,
  .latest-alert__risk,
  .latest-alert__match {
    min-width: 0;
  }

  .latest-alert__product strong,
  .latest-alert__risk strong,
  .latest-alert__match strong,
  .latest-alert__product small,
  .latest-alert__risk small,
  .latest-alert__match small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .latest-alert__product strong,
  .latest-alert__match strong {
    font-size: 11px;
  }

  .latest-alert__risk strong {
    margin-top: 3px;
    color: #8f3036;
    font-size: 10px;
  }

  .latest-alert small {
    margin-top: 4px;
    color: var(--muted);
    font-size: 9px;
  }

  .latest-alert__arrow {
    color: var(--muted);
  }

  .latest-alerts__empty {
    min-height: 245px;
  }

  .latest-alerts__empty > span {
    background: var(--violet-50);
    color: var(--violet-600);
  }

  @media (max-width: 960px) {
    .overview-priority-grid {
      grid-template-columns: 1fr;
    }

    .latest-alert {
      grid-template-columns: 34px minmax(180px, 1fr) minmax(170px, 1fr) auto 16px;
    }

    .latest-alert__risk {
      display: none;
    }
  }

  @media (max-width: 720px) {
    .overview-heading,
    .panel-heading,
    .latest-alerts__heading {
      align-items: stretch;
      flex-direction: column;
    }

    .attention-summary {
      flex-wrap: wrap;
    }

    .attention-item {
      grid-template-columns: 38px minmax(0, 1fr);
    }

    .attention-item__action {
      grid-column: 2;
    }

    .latest-alert {
      grid-template-columns: 34px minmax(0, 1fr) auto;
    }

    .latest-alert__match,
    .latest-alert__arrow {
      display: none;
    }

    .monitor-notice {
      flex-wrap: wrap;
    }

    .workspace-ready {
      align-items: flex-start;
      flex-wrap: wrap;
    }

    .workspace-ready > a {
      width: 100%;
      margin-left: 26px;
    }

    .monitor-notice > a {
      width: 100%;
      margin-left: 26px;
    }
  }
</style>
