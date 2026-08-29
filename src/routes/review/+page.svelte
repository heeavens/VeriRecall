<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  import type { PageProps } from './$types';

  type EvidenceType = 'barcode_photo' | 'supplier_invoice' | 'batch_label_photo';

  let { data, form }: PageProps = $props();

  let actorName = $state('Herman');
  let evidenceOpen = $state(false);
  let selectedEvidence = $state<EvidenceType[]>([]);

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
    return status === 'awaiting_evidence' ? 'Awaiting Evidence' : 'Needs Review';
  }

  function signalTextClass(tone: string): string {
    if (tone === 'positive') return 'text-[#2aa96b]';
    if (tone === 'conflict') return 'text-[#e14f55]';
    if (tone === 'missing') return 'text-[#df8b31]';
    return 'text-[#787280]';
  }

  function signalBarClass(tone: string): string {
    if (tone === 'positive') return 'bg-[#2aa96b]';
    if (tone === 'conflict') return 'bg-[#e14f55]';
    if (tone === 'missing') return 'bg-[#df8b31]';
    return 'bg-[#a9a3ae]';
  }

  function openEvidence(type?: EvidenceType): void {
    if (!selected) return;
    selectedEvidence = type ? [type] : [...selected.recommendedEvidence];
    evidenceOpen = true;
  }

  function closeEvidence(): void {
    evidenceOpen = false;
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key === 'Escape') closeEvidence();
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
  <div
    class={`mb-4 flex items-start gap-2 rounded-[10px] border px-3.5 py-3 text-[10px] ${form.success ? 'border-[#d7f2e3] bg-[#f4fcf7] text-[#268d5c]' : 'border-[#ffd9db] bg-[#fff8f8] text-[#a7353b]'}`}
    role="status"
  >
    <Icon name={form.success ? 'circle-check-big' : 'triangle-alert'} size={15} />
    <span class="leading-4">{form.message}</span>
    {#if form.success && form.kind === 'confirm' && form.caseId}
      <a class="ml-auto shrink-0 font-semibold underline" href={`/cases/${form.caseId}`}>Open case</a>
    {/if}
  </div>
{/if}

{#if selected}
  <section aria-labelledby="review-title">
    <nav class="mb-3 flex items-center gap-1.5 text-[10px] font-semibold text-violet-600" aria-label="Breadcrumb">
      <span>Review Queue</span>
      <span aria-hidden="true">→</span>
      <span>{matchLabel(selected.match.id)}</span>
    </nav>

    <div class="mb-5 flex items-start justify-between gap-5">
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <h1 id="review-title" class="text-[23px] font-bold tracking-[-.03em]">
            {selected.alert.productName}
          </h1>
          <span class={`badge ${selected.match.status === 'awaiting_evidence' ? 'badge-yellow' : 'badge-blue'}`}>
            {matchStatusLabel(selected.match.status)}
          </span>
          <span class="badge badge-red">{selected.alert.risk}</span>
        </div>
        <div class="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-[10px] text-muted">
          <span>Alert: <b class="text-ink">{selected.alert.sourceReference}</b></span>
          <span>Source: <b class="text-ink">{sourceLabel(selected.alert.source)}</b></span>
          <span>Published: <b class="text-ink">{formatDate(selected.alert.publishedAt)}</b></span>
          <span>Queue: <b class="text-ink">{data.selectedIndex + 1} of {data.items.length}</b></span>
        </div>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <form method="POST" action="?/reject">
          <input type="hidden" name="matchId" value={selected.match.id} />
          <input type="hidden" name="actorName" value={actorName} />
          <button class="btn btn-secondary" type="submit">
            <Icon name="x" size={16} />
            Reject Match
          </button>
        </form>
        <button
          class="btn btn-ghost"
          type="button"
          onclick={() => openEvidence()}
          disabled={selected.match.status === 'awaiting_evidence'}
        >
          <Icon name="file-text" size={16} />
          {selected.match.status === 'awaiting_evidence' ? 'Evidence Requested' : 'Request Evidence'}
        </button>
        <form method="POST" action="?/confirm">
          <input type="hidden" name="matchId" value={selected.match.id} />
          <input type="hidden" name="actorName" value={actorName} />
          <button class="btn btn-primary" type="submit">
            <Icon name="check" size={16} />
            Confirm Match
          </button>
        </form>
      </div>
    </div>

    <div class="grid grid-cols-12 gap-4">
      <div class="col-span-8 space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <article class="card overflow-hidden">
            <header class="flex min-h-16 items-center justify-between gap-3 border-b border-line bg-[#fffafb] px-4 py-3">
              <div>
                <span class="text-[9px] font-semibold tracking-[.14em] text-[#e14f55] uppercase">Official Alert</span>
                <h2 class="mt-1 text-[14px] font-bold">{sourceLabel(selected.alert.source)} Record</h2>
              </div>
              <span class="badge badge-red">{selected.alert.risk}</span>
            </header>
            <div class="p-4">
              <div class="mb-4 flex gap-3">
                <div class="grid h-20 w-24 shrink-0 place-items-center overflow-hidden rounded-lg bg-gradient-to-br from-[#f5e9fb] to-[#e2d2ff]">
                  {#if selected.alert.imageUrl}
                    <img
                      class="h-full w-full object-contain p-2"
                      src={selected.alert.imageUrl}
                      alt={`${selected.alert.productName} from the official alert`}
                    />
                  {:else}
                    <Icon name="triangle-alert" size={34} class="text-violet-600" />
                  {/if}
                </div>
                <div class="min-w-0">
                  <h3 class="text-[13px] font-bold">{selected.alert.productName}</h3>
                  <p class="mt-1 line-clamp-3 text-[9px] leading-4 text-muted">{selected.alert.description}</p>
                  <a
                    class="mt-2 inline-flex items-center gap-1 text-[9px] font-semibold text-violet-600 hover:underline"
                    href={selected.alert.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View official source
                    <Icon name="external-link" size={12} />
                  </a>
                </div>
              </div>
              <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-[10px]">
                <div><dt class="text-muted">Brand</dt><dd class="mt-1 font-semibold">{selected.alert.brand ?? 'Not provided'}</dd></div>
                <div><dt class="text-muted">Alert title</dt><dd class="mt-1 font-semibold">{selected.alert.title}</dd></div>
                <div><dt class="text-muted">EAN / GTIN</dt><dd class="mt-1 font-semibold">{selected.alert.ean ?? 'Not provided'}</dd></div>
                <div><dt class="text-muted">Batch / lot</dt><dd class="mt-1 font-semibold">{selected.alert.batch ?? 'Not provided'}</dd></div>
                <div><dt class="text-muted">Category</dt><dd class="mt-1 font-semibold">{selected.alert.category ?? 'Not provided'}</dd></div>
                <div><dt class="text-muted">Published</dt><dd class="mt-1 font-semibold">{formatDate(selected.alert.publishedAt)}</dd></div>
              </dl>
            </div>
          </article>

          <article class="card overflow-hidden">
            <header class="flex min-h-16 items-center justify-between gap-3 border-b border-line bg-violet-50 px-4 py-3">
              <div>
                <span class="text-[9px] font-semibold tracking-[.14em] text-violet-600 uppercase">Catalogue Candidate</span>
                <h2 class="mt-1 text-[14px] font-bold">Your Product Record</h2>
              </div>
              <span class="badge badge-purple">{selected.product.sku}</span>
            </header>
            <div class="p-4">
              <div class="mb-4 flex gap-3">
                <div class="grid h-20 w-24 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[#eee5ff] to-[#d1b8ff] text-violet-700">
                  <Icon name="package" size={34} />
                </div>
                <div class="min-w-0">
                  <h3 class="text-[13px] font-bold">{selected.product.name}</h3>
                  <p class="mt-1 text-[9px] leading-4 text-muted">
                    {selected.product.supplierName ?? 'Supplier not provided'}. {selected.product.stockQuantity} units currently registered.
                  </p>
                  <span class="mt-2 inline-flex text-[9px] font-semibold text-violet-600">
                    {selected.affectedPurchaseCount} affected purchase {selected.affectedPurchaseCount === 1 ? 'record' : 'records'}
                  </span>
                </div>
              </div>
              <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-[10px]">
                <div><dt class="text-muted">Brand</dt><dd class="mt-1 font-semibold">{selected.product.brand}</dd></div>
                <div><dt class="text-muted">Category</dt><dd class="mt-1 font-semibold">{selected.product.category ?? 'Not provided'}</dd></div>
                <div><dt class="text-muted">EAN / GTIN</dt><dd class={`mt-1 font-semibold ${selected.match.hasHardConflict ? 'text-[#e14f55]' : ''}`}>{selected.product.ean ?? 'Not provided'}</dd></div>
                <div><dt class="text-muted">Batch / lot</dt><dd class={`mt-1 font-semibold ${!selected.product.batch ? 'text-[#df8b31]' : ''}`}>{selected.product.batch ?? 'Missing'}</dd></div>
                <div><dt class="text-muted">Supplier</dt><dd class="mt-1 font-semibold">{selected.product.supplierName ?? 'Not provided'}</dd></div>
                <div><dt class="text-muted">Available stock</dt><dd class="mt-1 font-semibold">{selected.product.stockQuantity} units</dd></div>
              </dl>
            </div>
          </article>
        </div>

        <article class="card p-5">
          <div class="flex items-center justify-between gap-4">
            <div>
              <h2 class="text-[15px] font-bold">Score Breakdown</h2>
              <p class="mt-1 text-[10px] text-muted">Deterministic weighted identity comparison.</p>
            </div>
            <div class="text-right">
              <span class="text-[26px] font-bold text-violet-700">{selected.match.totalScore}%</span>
              <span class="ml-1 text-[10px] text-muted">confidence</span>
            </div>
          </div>
          <div class="mt-5 grid grid-cols-2 gap-x-8 gap-y-4">
            {#each selected.signals as signal}
              <div>
                <div class="mb-1.5 flex justify-between gap-3 text-[10px]">
                  <span class="font-semibold">{signal.label}</span>
                  <span class={signalTextClass(signal.tone)}>{signal.earned}/{signal.maximum}</span>
                </div>
                <div class="progress-track h-[6px]">
                  <div
                    class={`progress-value ${signalBarClass(signal.tone)}`}
                    style={`width:${Math.round((signal.earned / signal.maximum) * 100)}%`}
                  ></div>
                </div>
                <p class={`mt-1.5 text-[9px] ${signalTextClass(signal.tone)}`}>{signal.detail}</p>
              </div>
            {/each}
          </div>
        </article>

        <article class="card p-5">
          <div class="flex items-start gap-3">
            <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#ffedc9] text-[#bf7f19]">
              <Icon name="triangle-alert" size={16} />
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="text-[14px] font-bold">Why the agent is uncertain</h2>
              <p class="mt-1 text-[10px] leading-4 text-muted">{selected.match.explanation}</p>
            </div>
          </div>
          <div class="mt-4 grid grid-cols-2 gap-3">
            <div class="rounded-xl bg-[#f4fcf7] p-4">
              <h3 class="flex items-center gap-2 text-[10px] font-bold text-[#268d5c]">
                <Icon name="check" size={14} /> Positive signals
              </h3>
              <ul class="mt-2 space-y-1.5 text-[9px] leading-4 text-[#44735c]">
                {#each selected.positiveReasons as reason}
                  <li>• {reason}</li>
                {/each}
              </ul>
            </div>
            <div class="rounded-xl bg-[#fff9e9] p-4">
              <h3 class="flex items-center gap-2 text-[10px] font-bold text-[#a77026]">
                <Icon name="triangle-alert" size={14} /> Conflicting or missing
              </h3>
              <ul class="mt-2 space-y-1.5 text-[9px] leading-4 text-[#7b6848]">
                {#each selected.uncertaintyReasons as reason}
                  <li>• {reason}</li>
                {/each}
              </ul>
            </div>
          </div>
        </article>
      </div>

      <aside class="col-span-4 space-y-4">
        <article class="card p-4">
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-[14px] font-bold">Decision Summary</h2>
            <span class={`badge ${selected.match.status === 'awaiting_evidence' ? 'badge-yellow' : 'badge-blue'}`}>
              {matchStatusLabel(selected.match.status)}
            </span>
          </div>
          <div class="mt-4 rounded-xl bg-violet-50 p-4 text-center">
            <div
              class="mx-auto grid h-16 w-16 place-items-center rounded-full p-[7px]"
              style={`background:conic-gradient(#7542dd ${selected.match.totalScore}%,#e4d3ff 0)`}
            >
              <span class="grid h-full w-full place-items-center rounded-full bg-white text-[16px] font-bold text-violet-700">{selected.match.totalScore}%</span>
            </div>
            <p class="mt-2 text-[10px] font-semibold">Human decision required</p>
          </div>
          <dl class="mt-4 space-y-3 text-[10px]">
            <div class="flex justify-between"><dt class="text-muted">Automatic threshold</dt><dd class="font-semibold">{selected.threshold}%</dd></div>
            <div class="flex justify-between"><dt class="text-muted">Hard conflict</dt><dd class={`font-semibold ${selected.match.hasHardConflict ? 'text-[#e14f55]' : ''}`}>{selected.match.hasHardConflict ? 'Detected' : 'No'}</dd></div>
            <div class="flex justify-between"><dt class="text-muted">Potentially affected</dt><dd class="font-semibold">{selected.product.stockQuantity} units</dd></div>
            <div class="flex justify-between"><dt class="text-muted">Customer records</dt><dd class="font-semibold">{selected.affectedPurchaseCount}</dd></div>
          </dl>
          <label class="mt-4 block border-t border-line pt-4" for="reviewer-name">
            <span class="label">Reviewer name</span>
            <input id="reviewer-name" class="input-ui" bind:value={actorName} maxlength="80" />
          </label>
        </article>

        <article class="card p-4">
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-[14px] font-bold">Recommended Evidence</h2>
            {#if selected.evidenceRequest}
              <span class="text-[9px] font-semibold text-[#be8420]">Request pending</span>
            {/if}
          </div>
          <div class="mt-3 space-y-2">
            {#each evidenceOptions as option}
              <button
                class="flex w-full items-center gap-3 rounded-lg border border-line p-3 text-left transition hover:border-violet-200 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                onclick={() => openEvidence(option.type)}
                disabled={selected.match.status === 'awaiting_evidence'}
              >
                <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet-50 text-violet-600">
                  <Icon name={option.icon} size={16} />
                </span>
                <span class="min-w-0">
                  <b class="block text-[10px]">{option.title}</b>
                  <span class="text-[9px] text-muted">{option.detail}</span>
                </span>
                <Icon name="chevron-right" size={14} class="ml-auto shrink-0" />
              </button>
            {/each}
          </div>
          {#if selected.evidenceRequest}
            <p class="mt-3 rounded-lg bg-[#fff9e9] p-3 text-[9px] leading-4 text-[#7b6848]">
              Requested: {selected.evidenceRequest.requestedEvidence
                .map((type) => evidenceOptions.find((option) => option.type === type)?.title ?? type)
                .join(', ')}. The supplier draft remains unsent.
            </p>
          {/if}
        </article>

        <article class="card p-4">
          <div class="flex items-center justify-between">
            <h2 class="text-[14px] font-bold">Queue Navigation</h2>
            <span class="text-[9px] text-muted">{data.items.length} open</span>
          </div>
          <div class="mt-3 flex gap-2">
            {#if data.previousMatchId}
              <a class="btn btn-secondary flex-1" href={`/review?match=${data.previousMatchId}`}>
                <Icon name="chevron-left" size={14} /> Previous
              </a>
            {:else}
              <button class="btn btn-secondary flex-1" type="button" disabled>
                <Icon name="chevron-left" size={14} /> Previous
              </button>
            {/if}
            {#if data.nextMatchId}
              <a class="btn btn-secondary flex-1" href={`/review?match=${data.nextMatchId}`}>
                Next <Icon name="chevron-right" size={14} />
              </a>
            {:else}
              <button class="btn btn-secondary flex-1" type="button" disabled>
                Next <Icon name="chevron-right" size={14} />
              </button>
            {/if}
          </div>
        </article>
      </aside>
    </div>
  </section>
{:else}
  <section aria-labelledby="review-empty-title">
    <header class="mb-5">
      <h1 id="review-empty-title" class="text-[24px] font-bold tracking-[-.035em]">Review Queue</h1>
      <p class="mt-1 text-[12px] text-muted">Review uncertain catalogue matches before opening a recall case.</p>
    </header>
    <div class="card grid min-h-[430px] place-items-center p-8 text-center">
      <div class="max-w-[390px]">
        <span class="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#ecfbf3] text-[#2aa96b]">
          <Icon name="circle-check-big" size={20} />
        </span>
        <h2 class="mt-4 text-[16px] font-bold">Review queue is clear</h2>
        <p class="mt-2 text-[10px] leading-5 text-muted">
          There are no uncertain catalogue matches waiting for a human decision.
        </p>
        <a class="btn btn-ghost mt-5" href="/dashboard">Return to Overview</a>
      </div>
    </div>
  </section>
{/if}

{#if evidenceOpen && selected}
  <div class="modal-backdrop show">
    <button
      class="absolute inset-0 cursor-default"
      type="button"
      aria-label="Close evidence request"
      onclick={closeEvidence}
    ></button>
    <div
      class="modal-panel relative z-[1]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="evidence-title"
      tabindex="-1"
    >
      <form method="POST" action="?/requestEvidence">
        <input type="hidden" name="matchId" value={selected.match.id} />
        <input type="hidden" name="actorName" value={actorName} />
        <div class="flex items-start justify-between border-b border-line p-5">
          <div>
            <h2 id="evidence-title" class="text-[18px] font-bold">Request Supplier Evidence</h2>
            <p class="mt-1 text-[10px] text-muted">Resolve uncertainty without confirming the recall match.</p>
          </div>
          <button class="icon-button" type="button" aria-label="Close evidence request" onclick={closeEvidence}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div class="p-5">
          <div class="mb-5 flex items-center gap-3 rounded-xl bg-violet-50 p-3">
            <span class="grid h-10 w-10 place-items-center rounded-lg bg-white text-violet-600">
              <Icon name="package" size={20} />
            </span>
            <div>
              <b class="block text-[11px]">{selected.product.name}</b>
              <span class="text-[9px] text-muted">{matchLabel(selected.match.id)} · {selected.product.supplierName ?? 'Supplier not provided'}</span>
            </div>
            <span class="badge badge-red ml-auto">{selected.alert.risk}</span>
          </div>

          <fieldset>
            <legend class="label">Evidence types</legend>
            <div class="grid grid-cols-3 gap-3">
              {#each evidenceOptions as option}
                <label class="cursor-pointer rounded-xl border border-line p-3 transition hover:border-violet-200 hover:bg-violet-50">
                  <span class="flex items-start gap-2">
                    <input
                      class="mt-0.5 h-4 w-4 accent-[#7b49df]"
                      type="checkbox"
                      name="requestedEvidence"
                      value={option.type}
                      bind:group={selectedEvidence}
                    />
                    <span>
                      <b class="block text-[10px]">{option.title}</b>
                      <span class="mt-1 block text-[8px] leading-3 text-muted">{option.detail}</span>
                    </span>
                  </span>
                </label>
              {/each}
            </div>
          </fieldset>

          <div class="mt-4 grid grid-cols-2 gap-4">
            <label>
              <span class="label">Supplier</span>
              <input class="input-ui" value={selected.product.supplierName ?? 'Not provided'} disabled />
            </label>
            <label>
              <span class="label">Recipient</span>
              <input class="input-ui" value={selected.product.supplierEmail ?? 'Recipient required'} disabled />
            </label>
          </div>
          <div class="mt-4 rounded-xl border border-line bg-[#fdfbff] p-4 text-[10px] leading-5 text-[#5f5968]">
            The selected evidence will be saved as a supplier action <b>DRAFT — NOT SENT</b>.
            No external email provider is connected.
          </div>
        </div>

        <div class="flex items-center justify-between border-t border-line bg-[#fdfbff] px-5 py-4">
          <span class="flex items-center gap-2 text-[9px] text-muted">
            <Icon name="shield-check" size={16} class="text-violet-600" />
            Recipient and request are recorded in the audit log.
          </span>
          <div class="flex gap-2">
            <button class="btn btn-secondary" type="button" onclick={closeEvidence}>Cancel</button>
            <button class="btn btn-primary" type="submit" disabled={selectedEvidence.length === 0}>
              Confirm Request
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
{/if}
