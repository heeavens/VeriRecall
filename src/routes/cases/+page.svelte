<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import WorkflowBreadcrumbs from '$lib/components/WorkflowBreadcrumbs.svelte';

  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const openCount = $derived(
    data.cases.filter((item) => item.caseRecord.status === 'open').length
  );
  const pendingTaskCount = $derived(
    data.cases.reduce((total, item) => total + item.pendingTasks, 0)
  );
  const pendingApprovalCount = $derived(
    data.cases.reduce((total, item) => total + item.pendingApprovals, 0)
  );

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(new Date(value));
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

  function nextAction(item: (typeof data.cases)[number]): string {
    if (item.versioned && item.nextTaskLabel) return item.nextTaskLabel;
    if (item.versioned) return 'Review investigation and unresolved evidence';
    if (item.caseRecord.status === 'closed') return 'No further action required';
    if (item.nextTaskLabel) return item.nextTaskLabel;
    if (item.caseRecord.status === 'contained') return 'Review the record and close the case';
    return 'Review the incident record';
  }

  function affectedStock(item: (typeof data.cases)[number]): string {
    if (!item.versioned) return `${item.totalStock} units`;
    if (item.versionedExposure?.status === 'CALCULATED') {
      return item.versionedExposure.received === null
        ? 'Unknown — unresolved'
        : `${item.versionedExposure.received} affected units`;
    }
    return 'Unknown — not calculated';
  }
</script>

<svelte:head>
  <title>Cases | Recall Agent</title>
  <meta
    name="description"
    content="Work through recall containment tasks and maintain defensible incident records."
  />
</svelte:head>

<section class="cases-page" aria-labelledby="cases-title">
  <WorkflowBreadcrumbs items={[{ label: 'Overview', href: '/dashboard' }, { label: 'Cases' }]} />
  <header class="cases-heading">
    <div>
      <span class="eyebrow">Incident response</span>
      <h1 id="cases-title">Cases</h1>
      <p>Complete urgent containment work before documenting case closure.</p>
    </div>
    <a class="btn btn-primary" href="/actions">
      <Icon name="shield-check" size={15} />
      Open Approvals
    </a>
  </header>

  <div class="case-summary" aria-label="Case workload summary">
    <div>
      <span>Open cases</span>
      <strong>{openCount}</strong>
      <small>Active incident records</small>
    </div>
    <div class:case-summary__urgent={pendingTaskCount > 0}>
      <span>Containment tasks</span>
      <strong>{pendingTaskCount}</strong>
      <small>{pendingTaskCount === 1 ? 'Task still requires action' : 'Tasks still require action'}</small>
    </div>
    <div>
      <span>Awaiting approval</span>
      <strong>{pendingApprovalCount}</strong>
      <small>Human decisions required</small>
    </div>
  </div>

  <article class="card case-register">
    <header class="case-register__heading">
      <div>
        <h2>Incident records</h2>
        <p>Cases with unfinished work appear with their next required action.</p>
      </div>
      <span>{data.cases.length} {data.cases.length === 1 ? 'case' : 'cases'}</span>
    </header>

    {#if data.cases.length > 0}
      <div class="case-list">
        {#each data.cases as item}
          <article class:case-row--closed={item.caseRecord.status === 'closed'} class="case-row">
            <div class={`case-row__marker case-row__marker--${item.caseRecord.status}`} aria-hidden="true"></div>

            <div class="case-row__identity">
              <div class="case-row__title">
                <a href={`/cases/${item.caseRecord.id}`}>{item.caseRecord.caseNumber}</a>
                <span class={`badge ${statusClass(item.caseRecord.status)}`}>
                  {item.versioned ? 'Investigating' : statusLabel(item.caseRecord.status)}
                </span>
              </div>
              <strong>{item.alert.productName}</strong>
              <span>{item.alert.sourceReference} · Opened {formatDate(item.caseRecord.openedAt)}</span>
            </div>

            <dl class="case-row__scope">
              <div>
                <dt>Affected stock</dt>
                <dd>{affectedStock(item)}</dd>
              </div>
              <div>
                <dt>Affected SKUs</dt>
                <dd>{item.versioned ? 'Scope requires review' : `${item.itemCount} affected SKU records`}</dd>
              </div>
              <div>
                <dt>Progress</dt>
                <dd>{item.completedTasks}/{item.actionableTasks} tasks complete</dd>
              </div>
            </dl>

            <div class="case-row__next">
              <span>Next required action</span>
              <strong>{nextAction(item)}</strong>
              {#if item.pendingApprovals > 0}
                <small>{item.pendingApprovals} {item.pendingApprovals === 1 ? 'draft needs' : 'drafts need'} a human decision</small>
              {:else if item.caseRecord.status === 'closed'}
                <small>Record retained for audit</small>
              {:else}
                <small>Open the case to continue</small>
              {/if}
            </div>

            <a class="case-row__open" href={`/cases/${item.caseRecord.id}`} aria-label={`Open ${item.caseRecord.caseNumber}`}>
              <span>Open case</span>
              <Icon name="arrow-right" size={15} />
            </a>
          </article>
        {/each}
      </div>
    {:else}
      <div class="case-empty">
        <span><Icon name="briefcase-business" size={21} /></span>
        <h2>No Cases yet</h2>
        <p>Cases appear after investigation begins or a person confirms a catalogue match.</p>
        <a class="btn btn-secondary" href="/review">Open Review Queue</a>
      </div>
    {/if}
  </article>

  <p class="record-note">
    <Icon name="shield-check" size={15} />
    Every task, approval and closure decision is retained with its actor and UTC timestamp.
  </p>
</section>

<style>
  .cases-page {
    max-width: 1180px;
    margin: 0 auto;
  }

  .cases-heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 22px;
  }

  .eyebrow {
    display: block;
    margin-bottom: 7px;
    color: #7542dd;
    font-size: 9px;
    font-weight: 750;
    letter-spacing: 0.13em;
    text-transform: uppercase;
  }

  .cases-heading h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 750;
    letter-spacing: -0.035em;
    line-height: 1.1;
  }

  .cases-heading p {
    margin: 7px 0 0;
    color: #716b7b;
    font-size: 11px;
    line-height: 1.55;
  }

  .case-summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    overflow: hidden;
    margin-bottom: 16px;
    border: 1px solid #eae4f2;
    border-radius: 13px;
    background: white;
  }

  .case-summary > div {
    position: relative;
    min-width: 0;
    padding: 17px 19px;
  }

  .case-summary > div + div {
    border-left: 1px solid #eae4f2;
  }

  .case-summary span,
  .case-summary small {
    display: block;
  }

  .case-summary span {
    color: #716b7b;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  .case-summary strong {
    display: block;
    margin-top: 8px;
    font-size: 24px;
    letter-spacing: -0.04em;
    line-height: 1;
  }

  .case-summary small {
    margin-top: 7px;
    color: #716b7b;
    font-size: 9px;
  }

  .case-summary__urgent::before {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    height: 3px;
    background: #df8b31;
    content: '';
  }

  .case-summary__urgent strong {
    color: #b56e20;
  }

  .case-register {
    overflow: hidden;
  }

  .case-register__heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    padding: 16px 18px;
    border-bottom: 1px solid #eae4f2;
  }

  .case-register__heading h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 750;
  }

  .case-register__heading p {
    margin: 3px 0 0;
    color: #716b7b;
    font-size: 9px;
  }

  .case-register__heading > span {
    color: #716b7b;
    font-size: 9px;
    font-weight: 650;
  }

  .case-list {
    display: grid;
  }

  .case-row {
    display: grid;
    grid-template-columns: 4px minmax(190px, 1.25fr) minmax(240px, 1.4fr) minmax(190px, 1fr) auto;
    align-items: center;
    gap: 18px;
    min-width: 0;
    padding: 17px 18px 17px 0;
  }

  .case-row + .case-row {
    border-top: 1px solid #eee9f4;
  }

  .case-row--closed {
    background: #fdfcfe;
  }

  .case-row__marker {
    align-self: stretch;
    border-radius: 0 4px 4px 0;
    background: #df8b31;
  }

  .case-row__marker--contained {
    background: #7542dd;
  }

  .case-row__marker--closed {
    background: #2aa96b;
  }

  .case-row__identity,
  .case-row__next {
    min-width: 0;
  }

  .case-row__title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .case-row__title a {
    color: #6330c8;
    font-size: 11px;
    font-weight: 750;
  }

  .case-row__title a:hover {
    text-decoration: underline;
  }

  .case-row__identity > strong {
    display: block;
    overflow: hidden;
    margin-top: 7px;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .case-row__identity > span {
    display: block;
    margin-top: 4px;
    color: #716b7b;
    font-size: 8px;
  }

  .case-row__scope {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
    margin: 0;
  }

  .case-row__scope div {
    min-width: 0;
  }

  .case-row__scope dt,
  .case-row__next > span {
    color: #716b7b;
    font-size: 8px;
  }

  .case-row__scope dd {
    overflow: hidden;
    margin: 5px 0 0;
    font-size: 9px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .case-row__next {
    padding-left: 16px;
    border-left: 1px solid #eee9f4;
  }

  .case-row__next strong,
  .case-row__next small {
    display: block;
  }

  .case-row__next strong {
    margin-top: 5px;
    font-size: 10px;
    line-height: 1.4;
  }

  .case-row__next small {
    margin-top: 4px;
    color: #716b7b;
    font-size: 8px;
    line-height: 1.4;
  }

  .case-row__open {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 34px;
    border: 1px solid #ded6e9;
    border-radius: 8px;
    padding: 0 10px;
    background: white;
    font-size: 9px;
    font-weight: 700;
  }

  .case-row__open:hover {
    border-color: #c9b8e8;
    color: #6330c8;
  }

  .case-empty {
    display: grid;
    min-height: 330px;
    place-items: center;
    align-content: center;
    padding: 32px;
    text-align: center;
  }

  .case-empty > span {
    display: grid;
    width: 48px;
    height: 48px;
    place-items: center;
    border-radius: 50%;
    background: #f1e9ff;
    color: #6330c8;
  }

  .case-empty h2 {
    margin: 15px 0 0;
    font-size: 15px;
  }

  .case-empty p {
    max-width: 350px;
    margin: 7px 0 16px;
    color: #716b7b;
    font-size: 10px;
    line-height: 1.55;
  }

  .record-note {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    margin: 13px 0 0;
    color: #716b7b;
    font-size: 9px;
  }

  .record-note :global(svg) {
    color: #7542dd;
  }

  @media (max-width: 1080px) {
    .case-row {
      grid-template-columns: 4px minmax(210px, 1.2fr) minmax(210px, 1fr) minmax(180px, 1fr) auto;
    }

    .case-row__scope {
      grid-template-columns: 1fr;
      gap: 7px;
    }

    .case-row__scope div {
      display: flex;
      justify-content: space-between;
      gap: 10px;
    }

    .case-row__scope dd {
      margin-top: 0;
    }
  }

  @media (max-width: 820px) {
    .case-row {
      grid-template-columns: 4px minmax(0, 1fr) auto;
      align-items: start;
    }

    .case-row__scope,
    .case-row__next {
      grid-column: 2 / -1;
    }

    .case-row__scope {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .case-row__scope div {
      display: block;
    }

    .case-row__scope dd {
      margin-top: 5px;
    }

    .case-row__next {
      padding: 12px 0 0;
      border-top: 1px solid #eee9f4;
      border-left: 0;
    }

    .case-row__open span {
      display: none;
    }
  }

  @media (max-width: 620px) {
    .cases-heading {
      align-items: stretch;
      flex-direction: column;
    }

    .cases-heading .btn {
      width: 100%;
    }

    .case-summary {
      grid-template-columns: 1fr;
    }

    .case-summary > div + div {
      border-top: 1px solid #eae4f2;
      border-left: 0;
    }

    .case-row__scope {
      grid-template-columns: 1fr;
    }

    .record-note {
      align-items: flex-start;
      text-align: left;
    }
  }
</style>
