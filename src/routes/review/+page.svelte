<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';

  import Icon from '$lib/components/Icon.svelte';
  import WorkflowBreadcrumbs from '$lib/components/WorkflowBreadcrumbs.svelte';

  import type { PageProps } from './$types';

  type EvidenceType = 'barcode_photo' | 'supplier_invoice' | 'batch_label_photo';
  type DecisionType = 'confirm' | 'reject';

  let { data, form }: PageProps = $props();

  const actorName = 'Herman';
  let decisionOpen = $state<DecisionType | null>(null);
  let evidenceOpen = $state(false);
  let selectedEvidence = $state<EvidenceType[]>([]);
  let submitting = $state<'decision' | 'evidence' | null>(null);

  const enhanceDecision: SubmitFunction = () => {
    submitting = 'decision';
    return async ({ update }) => {
      try {
        await update();
      } finally {
        submitting = null;
        closeDecision();
      }
    };
  };

  const enhanceEvidence: SubmitFunction = () => {
    submitting = 'evidence';
    return async ({ update }) => {
      try {
        await update();
      } finally {
        submitting = null;
        closeEvidence();
      }
    };
  };

  const selected = $derived(data.selected);

  const evidenceOptions: Array<{
    type: EvidenceType;
    title: string;
    detail: string;
    icon: string;
  }> = [
    {
      type: 'barcode_photo',
      title: 'Barcode photo',
      detail: 'Confirm the identifier printed on the packaging.',
      icon: 'scan-barcode'
    },
    {
      type: 'supplier_invoice',
      title: 'Supplier invoice',
      detail: 'Verify the delivery, batch and affected quantity.',
      icon: 'file-text'
    },
    {
      type: 'batch_label_photo',
      title: 'Batch-label photo',
      detail: 'Confirm the exact affected lot number.',
      icon: 'camera'
    }
  ];

  function sourceLabel(source: 'safety_gate' | 'rasff'): string {
    return source === 'safety_gate' ? 'EU Safety Gate' : 'RASFF';
  }

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(new Date(value));
  }

  function matchLabel(matchId: string): string {
    return `MATCH-${matchId.slice(-6).toUpperCase()}`;
  }

  function matchStatusLabel(status: string): string {
    return status === 'awaiting_evidence' ? 'Evidence requested' : 'Needs review';
  }

  function signalToneLabel(tone: string): string {
    if (tone === 'positive') return 'Match';
    if (tone === 'conflict') return 'Conflict';
    if (tone === 'missing') return 'Missing';
    return 'Weak signal';
  }

  function uncertaintySummary(): string {
    if (!selected) return '';
    const hasConflict = selected.signals.some((signal) => signal.tone === 'conflict');
    const hasMissing = selected.signals.some((signal) => signal.tone === 'missing');
    if (hasConflict && hasMissing) {
      return 'A key identifier conflicts between the two records, and another identity value cannot be compared.';
    }
    if (hasConflict) {
      return 'A key identifier conflicts between the official warning and the catalogue record.';
    }
    if (hasMissing) {
      return 'One or more identity values are missing, so the records cannot be compared completely.';
    }
    return 'The available identity signals do not provide enough support for an automatic decision.';
  }

  function evidenceOption(type: EvidenceType) {
    return evidenceOptions.find((option) => option.type === type);
  }

  function openDecision(type: DecisionType): void {
    evidenceOpen = false;
    decisionOpen = type;
  }

  function closeDecision(): void {
    decisionOpen = null;
  }

  function openEvidence(): void {
    if (!selected || selected.match.status === 'awaiting_evidence') return;
    decisionOpen = null;
    selectedEvidence = [...selected.recommendedEvidence];
    evidenceOpen = true;
  }

  function closeEvidence(): void {
    evidenceOpen = false;
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    closeDecision();
    closeEvidence();
  }
</script>

<svelte:head>
  <title>Review Queue | Recall Agent</title>
  <meta
    name="description"
    content="Review uncertain catalogue matches and request specific supplier evidence."
  />
</svelte:head>

<svelte:window onkeydown={handleEscape} />

{#if form?.message}
  <div class:review-notice--error={!form.success} class="review-notice" role="status">
    <span class="review-notice__icon">
      <Icon name={form.success ? 'circle-check-big' : 'triangle-alert'} size={17} />
    </span>
    <span>{form.message}</span>
    {#if form.success && form.kind === 'confirm' && form.caseId}
      <a href={`/cases/${form.caseId}`}>Open case <Icon name="arrow-right" size={14} /></a>
    {:else if form.success && form.kind === 'evidence'}
      <a href="/actions">Open Approvals <Icon name="arrow-right" size={14} /></a>
    {:else if form.success && form.kind === 'reject'}
      <a href={selected ? '/review' : '/dashboard'}>
        {selected ? 'Review next match' : 'Return to Overview'}
        <Icon name="arrow-right" size={14} />
      </a>
    {/if}
  </div>
{/if}

<WorkflowBreadcrumbs items={[{ label: 'Overview', href: '/dashboard' }, { label: 'Review Queue' }]} />

{#if selected}
  <section aria-labelledby="review-title">
    <header class="review-heading">
      <div>
        <div class="review-heading__title">
          <h1 id="review-title">Review product identity</h1>
          <span
            class={`badge ${selected.match.status === 'awaiting_evidence' ? 'badge-yellow' : 'badge-orange'}`}
          >
            {matchStatusLabel(selected.match.status)}
          </span>
        </div>
        <p>Compare the official warning with your catalogue record before taking action.</p>
        <div class="review-heading__meta">
          <span>{sourceLabel(selected.alert.source)} · {selected.alert.sourceReference}</span>
          <span>Published {formatDate(selected.alert.publishedAt)}</span>
          <span class="review-heading__reference">Internal reference · {matchLabel(selected.match.id)}</span>
        </div>
      </div>

      {#if data.items.length > 1}
        <nav class="queue-switcher" aria-label="Review queue navigation">
          {#if data.previousMatchId}
            <a href={`/review?match=${data.previousMatchId}`} aria-label="Previous review item">
              <Icon name="chevron-left" size={15} />
            </a>
          {:else}
            <button type="button" disabled aria-label="No previous review item">
              <Icon name="chevron-left" size={15} />
            </button>
          {/if}
          <span>{data.selectedIndex + 1} of {data.items.length}</span>
          {#if data.nextMatchId}
            <a href={`/review?match=${data.nextMatchId}`} aria-label="Next review item">
              <Icon name="chevron-right" size={15} />
            </a>
          {:else}
            <button type="button" disabled aria-label="No next review item">
              <Icon name="chevron-right" size={15} />
            </button>
          {/if}
        </nav>
      {/if}
    </header>

    <article class="card confidence-context">
      <div class="confidence-context__score" aria-label={`${selected.match.totalScore}% match confidence`}>
        <strong>{selected.match.totalScore}%</strong>
        <span>match confidence</span>
      </div>
      <div class="confidence-context__copy">
        <span>Why this needs review</span>
        <h2>Identity is not certain enough for an automatic decision</h2>
        <p>{uncertaintySummary()}</p>
        <small>
          The score is below the {selected.threshold}% automatic threshold. Review the signals
          below and choose a human-controlled outcome. Match confidence measures product identity;
          the official risk describes potential harm if the source product is involved.
        </small>
      </div>
    </article>

    <div class="comparison-grid">
      <article class="card comparison-card comparison-card--official">
        <header>
          <div>
            <span>Official alert</span>
            <h2>{sourceLabel(selected.alert.source)} record</h2>
          </div>
          <span class="badge badge-red">{selected.alert.risk}</span>
        </header>
        <div class="comparison-card__body">
          <div class="record-summary">
            <div class="record-summary__image">
              {#if selected.alert.imageUrl}
                <img
                  src={selected.alert.imageUrl}
                  alt={`${selected.alert.productName} from the official alert`}
                />
              {:else}
                <Icon name="triangle-alert" size={30} />
              {/if}
            </div>
            <div>
              <h3>{selected.alert.productName}</h3>
              <p>{selected.alert.description}</p>
              <a href={selected.alert.sourceUrl} target="_blank" rel="noreferrer">
                View official source <Icon name="external-link" size={12} />
              </a>
            </div>
          </div>
          <dl class="record-fields">
            <div><dt>Brand</dt><dd>{selected.alert.brand ?? 'Not provided'}</dd></div>
            <div><dt>Category</dt><dd>{selected.alert.category ?? 'Not provided'}</dd></div>
            <div>
              <dt>EAN / GTIN</dt>
              <dd class:comparison-value--conflict={selected.match.hasHardConflict}>
                {selected.alert.ean ?? 'Not provided'}
              </dd>
            </div>
            <div><dt>Batch / lot</dt><dd>{selected.alert.batch ?? 'Not provided'}</dd></div>
          </dl>
        </div>
      </article>

      <article class="card comparison-card comparison-card--catalogue">
        <header>
          <div>
            <span>Catalogue candidate</span>
            <h2>Your product record</h2>
          </div>
          <span class="catalogue-sku">{selected.product.sku}</span>
        </header>
        <div class="comparison-card__body">
          <div class="record-summary">
            <div class="record-summary__image"><Icon name="package" size={30} /></div>
            <div>
              <h3>{selected.product.name}</h3>
              <p>
                {selected.product.supplierName ?? 'Supplier not provided'} ·
                {selected.product.stockQuantity} units in stock
              </p>
              <span>
                {selected.affectedPurchaseCount} customer purchase
                {selected.affectedPurchaseCount === 1 ? ' record' : ' records'}
              </span>
            </div>
          </div>
          <dl class="record-fields">
            <div><dt>Brand</dt><dd>{selected.product.brand}</dd></div>
            <div><dt>Category</dt><dd>{selected.product.category ?? 'Not provided'}</dd></div>
            <div>
              <dt>EAN / GTIN</dt>
              <dd class:comparison-value--conflict={selected.match.hasHardConflict}>
                {selected.product.ean ?? 'Not provided'}
              </dd>
            </div>
            <div>
              <dt>Batch / lot</dt>
              <dd class:comparison-value--missing={!selected.product.batch}>
                {selected.product.batch ?? 'Missing from catalogue'}
              </dd>
            </div>
          </dl>
        </div>
      </article>
    </div>

    <article class="card signal-panel">
      <header>
        <div>
          <h2>Identity signals</h2>
          <p>Green supports the match; red conflicts; amber means evidence is missing.</p>
        </div>
        <span>Weighted total: 100 points</span>
      </header>
      <div class="signal-grid">
        {#each selected.signals as signal}
          <div class={`signal-item signal-item--${signal.tone}`}>
            <div class="signal-item__heading">
              <span>{signalToneLabel(signal.tone)}</span>
              <strong>{signal.earned}/{signal.maximum}</strong>
            </div>
            <h3>{signal.label}</h3>
            <p>{signal.detail}</p>
            <div class="signal-track" aria-hidden="true">
              <span style={`width:${Math.round((signal.earned / signal.maximum) * 100)}%`}></span>
            </div>
          </div>
        {/each}
      </div>
    </article>

    <article class="card decision-panel">
      <header>
        <h2>Choose a human-controlled outcome</h2>
        <p>Reviewer: {actorName}. Every decision is recorded with a UTC timestamp.</p>
      </header>
      <div class="decision-grid">
        <section class="decision-option decision-option--reject">
          <span class="decision-option__icon"><Icon name="x" size={18} /></span>
          <h3>Not the same product</h3>
          <p>Marks this alert as not relevant to your catalogue. No recall case is created.</p>
          <button class="btn btn-danger" type="button" onclick={() => openDecision('reject')}>
            Reject match
          </button>
        </section>

        <section class="decision-option decision-option--evidence">
          <span class="decision-option__icon"><Icon name="file-text" size={18} /></span>
          <h3>{selected.evidenceRequest ? 'Evidence requested' : 'Identity still uncertain'}</h3>
          {#if selected.evidenceRequest}
            <p>The match stays in review. The supplier request is a draft and has not been sent.</p>
            <div class="evidence-chips" aria-label="Requested evidence">
              {#each selected.evidenceRequest.requestedEvidence as type}
                <span>{evidenceOption(type)?.title ?? type}</span>
              {/each}
            </div>
            <button class="btn btn-secondary" type="button" disabled>Request already recorded</button>
          {:else}
            <p>Creates an unsent supplier draft and keeps the product identity open for review.</p>
            <div class="evidence-chips" aria-label="Recommended evidence">
              {#each selected.recommendedEvidence as type}
                <span>{evidenceOption(type)?.title ?? type}</span>
              {/each}
            </div>
            <button class="btn btn-secondary" type="button" onclick={openEvidence}>
              Request evidence
            </button>
          {/if}
        </section>

        <section class="decision-option decision-option--confirm">
          <span class="decision-option__icon"><Icon name="check" size={18} /></span>
          <h3>Same product</h3>
          <p>Opens a case with affected stock, containment tasks and prepared actions awaiting approval.</p>
          <button class="btn btn-primary" type="button" onclick={() => openDecision('confirm')}>
            Confirm match
          </button>
        </section>
      </div>
    </article>
  </section>
{:else}
  <section aria-labelledby="review-empty-title">
    <header class="review-empty-heading">
      <h1 id="review-empty-title">Review Queue</h1>
      <p>Review uncertain catalogue matches before opening a recall case.</p>
    </header>
    <div class="card review-empty">
      <span><Icon name="circle-check-big" size={22} /></span>
      <h2>Review queue is clear</h2>
      <p>There are no uncertain catalogue matches waiting for a human decision.</p>
      <div class="review-empty__actions">
        <a class="btn btn-secondary" href="/catalogue">Review Catalogue</a>
        <a class="btn btn-primary" href="/dashboard">Return to Overview</a>
      </div>
    </div>
  </section>
{/if}

{#if decisionOpen && selected}
  <div class="modal-backdrop show">
    <button
      class="modal-dismiss"
      type="button"
      aria-label="Close decision confirmation"
      onclick={closeDecision}
    ></button>
    <div
      class="modal-panel decision-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="decision-dialog-title"
      tabindex="-1"
    >
      <header>
        <span class:decision-dialog__icon--reject={decisionOpen === 'reject'}>
          <Icon name={decisionOpen === 'confirm' ? 'check' : 'x'} size={20} />
        </span>
        <div>
          <h2 id="decision-dialog-title">
            {decisionOpen === 'confirm' ? 'Confirm this catalogue match?' : 'Reject this catalogue match?'}
          </h2>
          <p>This decision will be recorded as {actorName}.</p>
        </div>
        <button class="icon-button" type="button" aria-label="Close" onclick={closeDecision}>
          <Icon name="x" size={16} />
        </button>
      </header>
      <div class="decision-dialog__body">
        <div class="decision-dialog__records">
          <div><span>Official alert</span><strong>{selected.alert.productName}</strong></div>
          <Icon name="arrow-right" size={16} />
          <div><span>Catalogue product</span><strong>{selected.product.name}</strong></div>
        </div>
        <p class:decision-dialog__warning={decisionOpen === 'reject'}>
          {decisionOpen === 'confirm'
            ? 'A case will be opened or reused, affected stock will be added, and containment tasks plus actions awaiting approval will be prepared. Nothing is sent automatically.'
            : 'The alert will be marked not relevant to your catalogue and no new recall case will be created. This does not change the official source warning.'}
        </p>
      </div>
      <footer>
        <button class="btn btn-secondary" type="button" onclick={closeDecision}>Cancel</button>
        <form method="POST" action={decisionOpen === 'confirm' ? '?/confirm' : '?/reject'} use:enhance={enhanceDecision} aria-busy={submitting === 'decision'}>
          <input type="hidden" name="matchId" value={selected.match.id} />
          <input type="hidden" name="actorName" value={actorName} />
          <button class={decisionOpen === 'confirm' ? 'btn btn-primary' : 'btn btn-danger'} type="submit" disabled={submitting !== null}>
            {submitting === 'decision' ? 'Saving decision…' : decisionOpen === 'confirm' ? 'Confirm and open case' : 'Reject match'}
          </button>
        </form>
      </footer>
    </div>
  </div>
{/if}

{#if evidenceOpen && selected}
  <div class="modal-backdrop show">
    <button
      class="modal-dismiss"
      type="button"
      aria-label="Close evidence request"
      onclick={closeEvidence}
    ></button>
    <div
      class="modal-panel evidence-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="evidence-title"
      tabindex="-1"
    >
      <form method="POST" action="?/requestEvidence" use:enhance={enhanceEvidence} aria-busy={submitting === 'evidence'}>
        <input type="hidden" name="matchId" value={selected.match.id} />
        <input type="hidden" name="actorName" value={actorName} />
        <header>
          <div>
            <h2 id="evidence-title">Request supplier evidence</h2>
            <p>Keep the identity open without confirming a recall match.</p>
          </div>
          <button class="icon-button" type="button" aria-label="Close" onclick={closeEvidence}>
            <Icon name="x" size={16} />
          </button>
        </header>

        <div class="evidence-dialog__body">
          <div class="evidence-dialog__product">
            <span><Icon name="package" size={19} /></span>
            <div>
              <strong>{selected.product.name}</strong>
              <small>{selected.product.sku} · {selected.product.supplierName ?? 'Supplier not provided'}</small>
            </div>
          </div>

          <fieldset>
            <legend>Evidence to request</legend>
            <div class="evidence-options">
              {#each evidenceOptions as option}
                <label>
                  <input
                    type="checkbox"
                    name="requestedEvidence"
                    value={option.type}
                    bind:group={selectedEvidence}
                  />
                  <span><Icon name={option.icon} size={16} /></span>
                  <span>
                    <strong>{option.title}</strong>
                    <small>{option.detail}</small>
                  </span>
                </label>
              {/each}
            </div>
          </fieldset>

          <dl class="evidence-recipient">
            <div><dt>Supplier</dt><dd>{selected.product.supplierName ?? 'Not provided'}</dd></div>
            <div><dt>Recipient</dt><dd>{selected.product.supplierEmail ?? 'Recipient required'}</dd></div>
          </dl>

          <div class="evidence-safety">
            <span class="evidence-safety__icon"><Icon name="shield-check" size={17} /></span>
            <p>
              Confirming creates a supplier action <strong>DRAFT — NOT SENT</strong>. No external
              email provider is contacted.
            </p>
          </div>
        </div>

        <footer>
          <span>Recorded as {actorName}</span>
          <div>
            <button class="btn btn-secondary" type="button" onclick={closeEvidence}>Cancel</button>
            <button class="btn btn-primary" type="submit" disabled={selectedEvidence.length === 0 || submitting !== null}>
              {submitting === 'evidence' ? 'Creating draft…' : 'Create unsent draft'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  </div>
{/if}

<style>
  .review-notice {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    margin-bottom: 16px;
    border: 1px solid #cdeedc;
    border-radius: 10px;
    background: #f4fcf7;
    padding: 12px 14px;
    color: #277c52;
    font-size: 12px;
    line-height: 1.5;
  }

  .review-notice--error {
    border-color: #f1d5d7;
    background: #fff8f8;
    color: #a7353b;
  }

  .review-notice__icon {
    display: inline-flex;
    flex: 0 0 auto;
  }

  .review-notice a {
    display: inline-flex;
    margin-left: auto;
    align-items: center;
    gap: 5px;
    font-weight: 700;
    white-space: nowrap;
  }

  .review-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 16px;
  }

  .review-heading__title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 9px;
  }

  .review-heading h1,
  .review-empty-heading h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -0.035em;
  }

  .review-heading > div > p,
  .review-empty-heading p {
    margin: 5px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .review-heading__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    margin-top: 8px;
    color: #5f5968;
    font-size: 10px;
  }

  .review-heading__reference {
    color: #908a96;
  }

  .queue-switcher {
    display: flex;
    align-items: center;
    gap: 7px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: #fff;
    padding: 5px;
  }

  .queue-switcher a,
  .queue-switcher button {
    display: grid;
    width: 30px;
    height: 30px;
    place-items: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #625d69;
  }

  .queue-switcher a:hover {
    background: var(--violet-50);
    color: var(--violet-700);
  }

  .queue-switcher button:disabled {
    color: #c7c2ca;
  }

  .queue-switcher span {
    padding: 0 4px;
    color: var(--muted);
    font-size: 10px;
  }

  .confidence-context {
    display: grid;
    grid-template-columns: 150px minmax(0, 1fr);
    align-items: center;
    gap: 20px;
    margin-bottom: 14px;
    overflow: hidden;
  }

  .confidence-context__score {
    display: grid;
    min-height: 150px;
    place-content: center;
    background: #fff7e8;
    padding: 18px;
    color: #9a661c;
    text-align: center;
  }

  .confidence-context__score strong,
  .confidence-context__score span {
    display: block;
  }

  .confidence-context__score strong {
    font-size: 34px;
    letter-spacing: -0.04em;
    line-height: 1;
  }

  .confidence-context__score span {
    margin-top: 7px;
    font-size: 10px;
    font-weight: 650;
  }

  .confidence-context__copy {
    padding: 18px 20px 18px 0;
  }

  .confidence-context__copy > span {
    color: #9a661c;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  .confidence-context__copy h2 {
    margin: 4px 0 0;
    font-size: 16px;
  }

  .confidence-context__copy p {
    margin: 7px 0 0;
    color: #514b58;
    font-size: 12px;
    line-height: 1.55;
  }

  .confidence-context__copy small {
    display: block;
    margin-top: 7px;
    color: var(--muted);
    font-size: 10px;
    line-height: 1.5;
  }

  .comparison-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    margin-bottom: 14px;
  }

  .comparison-card {
    overflow: hidden;
  }

  .comparison-card > header {
    display: flex;
    min-height: 66px;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--line);
    padding: 12px 16px;
  }

  .comparison-card--official > header {
    background: #fffafb;
  }

  .comparison-card--catalogue > header {
    background: #faf8fd;
  }

  .comparison-card > header > div > span {
    color: var(--muted);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .comparison-card > header h2 {
    margin: 3px 0 0;
    font-size: 14px;
  }

  .catalogue-sku {
    border-radius: 6px;
    background: var(--violet-50);
    padding: 5px 8px;
    color: var(--violet-700);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 10px;
    font-weight: 700;
  }

  .comparison-card__body {
    padding: 16px;
  }

  .record-summary {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 13px;
    min-height: 92px;
  }

  .record-summary__image {
    display: grid;
    width: 88px;
    height: 82px;
    place-items: center;
    overflow: hidden;
    border-radius: 9px;
    background: #f4edf8;
    color: var(--violet-700);
  }

  .comparison-card--catalogue .record-summary__image {
    background: #eee6fb;
  }

  .record-summary__image img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    padding: 6px;
  }

  .record-summary h3 {
    margin: 0;
    font-size: 13px;
  }

  .record-summary p {
    display: -webkit-box;
    overflow: hidden;
    margin: 5px 0 0;
    color: var(--muted);
    font-size: 10px;
    line-height: 1.5;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  .record-summary a,
  .record-summary > div > span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 6px;
    color: var(--violet-700);
    font-size: 10px;
    font-weight: 650;
  }

  .record-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0;
    margin: 14px 0 0;
    border-top: 1px solid var(--line);
  }

  .record-fields > div {
    min-width: 0;
    border-bottom: 1px solid #f0ecf4;
    padding: 10px 8px 10px 0;
  }

  .record-fields > div:nth-child(odd) {
    border-right: 1px solid #f0ecf4;
    padding-right: 12px;
  }

  .record-fields > div:nth-child(even) {
    padding-left: 12px;
  }

  .record-fields dt {
    color: var(--muted);
    font-size: 9px;
  }

  .record-fields dd {
    overflow: hidden;
    margin: 4px 0 0;
    font-size: 11px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .record-fields dd.comparison-value--conflict {
    color: #b33c43;
  }

  .record-fields dd.comparison-value--missing {
    color: #9a661c;
  }

  .signal-panel,
  .decision-panel {
    margin-bottom: 14px;
    overflow: hidden;
  }

  .signal-panel > header,
  .decision-panel > header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid var(--line);
    padding: 15px 17px;
  }

  .signal-panel h2,
  .decision-panel h2 {
    margin: 0;
    font-size: 15px;
  }

  .signal-panel > header p,
  .decision-panel > header p {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 10px;
  }

  .signal-panel > header > span {
    color: var(--muted);
    font-size: 10px;
  }

  .signal-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    padding: 14px;
  }

  .signal-item {
    border: 1px solid #e7e3ea;
    border-top: 3px solid #aaa4ae;
    border-radius: 9px;
    background: #fbfafc;
    padding: 12px;
  }

  .signal-item--positive {
    border-color: #cdeedc;
    border-top-color: #2aa96b;
    background: #f7fcf9;
  }

  .signal-item--conflict {
    border-color: #f1d5d7;
    border-top-color: #e14f55;
    background: #fff9f9;
  }

  .signal-item--missing {
    border-color: #f2dfbd;
    border-top-color: #df8b31;
    background: #fffbf4;
  }

  .signal-item__heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .signal-item__heading span {
    color: var(--muted);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .signal-item__heading strong {
    font-size: 11px;
  }

  .signal-item h3 {
    margin: 10px 0 0;
    font-size: 12px;
  }

  .signal-item p {
    min-height: 32px;
    margin: 5px 0 0;
    color: #625c68;
    font-size: 9px;
    line-height: 1.45;
  }

  .signal-track {
    height: 4px;
    margin-top: 10px;
    overflow: hidden;
    border-radius: 999px;
    background: #e9e5eb;
  }

  .signal-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: #aaa4ae;
  }

  .signal-item--positive .signal-track span {
    background: #2aa96b;
  }

  .signal-item--conflict .signal-track span {
    background: #e14f55;
  }

  .signal-item--missing .signal-track span {
    background: #df8b31;
  }

  .decision-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .decision-option {
    display: flex;
    min-height: 225px;
    flex-direction: column;
    align-items: flex-start;
    border-right: 1px solid var(--line);
    padding: 17px;
  }

  .decision-option:last-child {
    border-right: 0;
  }

  .decision-option__icon {
    display: grid;
    width: 36px;
    height: 36px;
    place-items: center;
    border-radius: 9px;
    background: #f3f2f5;
    color: #716b7b;
  }

  .decision-option--reject .decision-option__icon {
    background: #fff0f0;
    color: #c7454c;
  }

  .decision-option--evidence .decision-option__icon {
    background: #fff7e8;
    color: #a66b1b;
  }

  .decision-option--confirm .decision-option__icon {
    background: #ecfbf3;
    color: #278c5c;
  }

  .decision-option h3 {
    margin: 11px 0 0;
    font-size: 13px;
  }

  .decision-option > p {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 10px;
    line-height: 1.55;
  }

  .decision-option > .btn {
    margin-top: auto;
  }

  .evidence-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin: 10px 0 14px;
  }

  .evidence-chips span {
    border-radius: 999px;
    background: #fff7e8;
    padding: 4px 7px;
    color: #8f641f;
    font-size: 8px;
    font-weight: 650;
  }

  .review-empty-heading {
    margin-bottom: 18px;
  }

  .review-empty {
    display: grid;
    min-height: 430px;
    place-items: center;
    align-content: center;
    padding: 32px;
    text-align: center;
  }

  .review-empty > span {
    display: grid;
    width: 50px;
    height: 50px;
    place-items: center;
    border-radius: 999px;
    background: #ecfbf3;
    color: #2aa96b;
  }

  .review-empty h2 {
    margin: 14px 0 0;
    font-size: 16px;
  }

  .review-empty p {
    margin: 7px 0 17px;
    color: var(--muted);
    font-size: 11px;
  }

  .modal-dismiss {
    position: absolute;
    inset: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }

  .decision-dialog,
  .evidence-dialog {
    position: relative;
    z-index: 1;
  }

  .decision-dialog {
    width: min(590px, 100%);
  }

  .decision-dialog > header,
  .evidence-dialog header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    border-bottom: 1px solid var(--line);
    padding: 18px;
  }

  .decision-dialog > header > span {
    display: grid;
    width: 38px;
    height: 38px;
    flex: 0 0 38px;
    place-items: center;
    border-radius: 10px;
    background: #ecfbf3;
    color: #278c5c;
  }

  .decision-dialog > header > span.decision-dialog__icon--reject {
    background: #fff0f0;
    color: #c7454c;
  }

  .decision-dialog header h2,
  .evidence-dialog header h2 {
    margin: 0;
    font-size: 17px;
  }

  .decision-dialog header p,
  .evidence-dialog header p {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 10px;
  }

  .decision-dialog header .icon-button,
  .evidence-dialog header .icon-button {
    margin-left: auto;
  }

  .decision-dialog__body,
  .evidence-dialog__body {
    padding: 18px;
  }

  .decision-dialog__records {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 12px;
    border-radius: 10px;
    background: #f8f6fa;
    padding: 13px;
  }

  .decision-dialog__records span,
  .decision-dialog__records strong {
    display: block;
  }

  .decision-dialog__records span {
    color: var(--muted);
    font-size: 9px;
  }

  .decision-dialog__records strong {
    margin-top: 4px;
    font-size: 11px;
  }

  .decision-dialog__body > p {
    margin: 13px 0 0;
    border: 1px solid #cdeedc;
    border-radius: 10px;
    background: #f4fcf7;
    padding: 12px;
    color: #277c52;
    font-size: 10px;
    line-height: 1.6;
  }

  .decision-dialog__body > p.decision-dialog__warning {
    border-color: #f1d5d7;
    background: #fff8f8;
    color: #8f3036;
  }

  .decision-dialog > footer,
  .evidence-dialog footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 9px;
    border-top: 1px solid var(--line);
    background: #fdfbff;
    padding: 14px 18px;
  }

  .evidence-dialog header {
    justify-content: space-between;
  }

  .evidence-dialog__product {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
    border-radius: 10px;
    background: #f8f6fa;
    padding: 12px;
  }

  .evidence-dialog__product > span {
    display: grid;
    width: 36px;
    height: 36px;
    place-items: center;
    border-radius: 8px;
    background: #fff;
    color: var(--violet-700);
  }

  .evidence-dialog__product strong,
  .evidence-dialog__product small {
    display: block;
  }

  .evidence-dialog__product strong {
    font-size: 11px;
  }

  .evidence-dialog__product small {
    margin-top: 3px;
    color: var(--muted);
    font-size: 9px;
  }

  .evidence-dialog fieldset {
    margin: 0;
    border: 0;
    padding: 0;
  }

  .evidence-dialog legend {
    margin-bottom: 8px;
    font-size: 11px;
    font-weight: 700;
  }

  .evidence-options {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .evidence-options label {
    display: grid;
    grid-template-columns: auto 28px minmax(0, 1fr);
    align-items: flex-start;
    gap: 7px;
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 10px;
    cursor: pointer;
  }

  .evidence-options label:has(input:checked) {
    border-color: #c9b3ee;
    background: var(--violet-50);
  }

  .evidence-options input {
    width: 14px;
    height: 14px;
    margin: 2px 0 0;
    accent-color: var(--primary);
  }

  .evidence-options label > span:nth-of-type(1) {
    display: grid;
    width: 28px;
    height: 28px;
    place-items: center;
    border-radius: 7px;
    background: #fff;
    color: var(--violet-700);
  }

  .evidence-options strong,
  .evidence-options small {
    display: block;
  }

  .evidence-options strong {
    font-size: 9px;
  }

  .evidence-options small {
    margin-top: 3px;
    color: var(--muted);
    font-size: 8px;
    line-height: 1.4;
  }

  .evidence-recipient {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 14px 0 0;
  }

  .evidence-recipient > div {
    border-radius: 9px;
    background: #f8f6fa;
    padding: 10px;
  }

  .evidence-recipient dt {
    color: var(--muted);
    font-size: 8px;
  }

  .evidence-recipient dd {
    overflow: hidden;
    margin: 4px 0 0;
    font-size: 10px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .evidence-safety {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    margin-top: 14px;
    border: 1px solid #f2dfbd;
    border-radius: 10px;
    background: #fffbf4;
    padding: 11px;
    color: #7b6848;
  }

  .evidence-safety__icon {
    display: inline-flex;
    flex: 0 0 auto;
  }

  .evidence-safety p {
    margin: 0;
    font-size: 9px;
    line-height: 1.55;
  }

  .evidence-dialog footer {
    justify-content: space-between;
  }

  .evidence-dialog footer > span {
    color: var(--muted);
    font-size: 9px;
  }

  .evidence-dialog footer > div {
    display: flex;
    gap: 8px;
  }

  .review-empty__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }

  @media (max-width: 980px) {
    .comparison-grid,
    .decision-grid {
      grid-template-columns: 1fr;
    }

    .decision-option {
      min-height: 190px;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }

    .decision-option:last-child {
      border-bottom: 0;
    }

    .signal-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    .review-heading,
    .signal-panel > header,
    .decision-panel > header {
      align-items: stretch;
      flex-direction: column;
    }

    .confidence-context {
      grid-template-columns: 1fr;
    }

    .confidence-context__score {
      min-height: 100px;
    }

    .confidence-context__copy {
      padding: 0 16px 16px;
    }

    .signal-grid,
    .evidence-options,
    .evidence-recipient {
      grid-template-columns: 1fr;
    }

    .decision-dialog footer,
    .evidence-dialog footer {
      align-items: stretch;
      flex-direction: column;
    }

    .decision-dialog footer form,
    .decision-dialog footer .btn,
    .evidence-dialog footer > div,
    .evidence-dialog footer .btn {
      width: 100%;
    }
  }
</style>
