<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import WorkflowBreadcrumbs from '$lib/components/WorkflowBreadcrumbs.svelte';

  import type { PageProps } from './$types';

  type AlertStatus = 'matched' | 'needs_review' | 'not_relevant';

  interface ScoreSignal {
    label: string;
    detail: string;
    earned: number;
    maximum: number;
    percentage: number;
    textClass: string;
    barClass: string;
  }

  let { data }: PageProps = $props();

  const bestMatch = $derived(data.candidates[0] ?? null);

  const scoreSignals = $derived(
    bestMatch
      ? [
          createScoreSignal('EAN / GTIN', bestMatch.eanScore, 45, {
            conflict: bestMatch.hasHardConflict,
            missing: !data.alert.ean || !bestMatch.product.ean
          }),
          createScoreSignal('Product name / model', bestMatch.nameScore, 25),
          createScoreSignal('Brand', bestMatch.brandScore, 20, {
            missing: !data.alert.brand
          }),
          createScoreSignal('Batch / lot', bestMatch.batchScore, 10, {
            missing: !data.alert.batch || !bestMatch.product.batch
          })
        ]
      : []
  );

  const reviewReason = $derived.by(() => {
    if (!bestMatch) return 'No catalogue candidate';
    if (bestMatch.hasHardConflict) return 'Hard identifier conflict';
    if (!data.alert.batch || !bestMatch.product.batch) return 'Missing batch evidence';
    if (!data.alert.ean || !bestMatch.product.ean) return 'Missing barcode evidence';
    if (data.alert.status === 'needs_review') return 'Score requires review';
    if (data.alert.status === 'matched') return 'Above configured threshold';
    return 'Below review floor';
  });

  function sourceLabel(source: string): string {
    return source === 'safety_gate' ? 'EU Safety Gate' : 'RASFF';
  }

  function statusLabel(status: AlertStatus): string {
    if (status === 'matched') return 'Confirmed match';
    if (status === 'needs_review') return 'Needs review';
    return 'Not relevant';
  }

  function statusClass(status: AlertStatus): string {
    if (status === 'matched') return 'bg-[#ecfbf3] text-[#2aa96b]';
    if (status === 'needs_review') return 'bg-[#edf4ff] text-[#4c80df]';
    return 'bg-[#f3f2f5] text-[#787280]';
  }

  function reviewOwner(status: AlertStatus): string {
    if (status === 'needs_review') return 'Unassigned';
    if (status === 'matched') return 'Confirmed by matching rules';
    return 'Not required';
  }

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(new Date(value));
  }

  function createScoreSignal(
    label: string,
    earned: number,
    maximum: number,
    options: { conflict?: boolean; missing?: boolean } = {}
  ): ScoreSignal {
    const percentage = Math.max(0, Math.min(100, Math.round((earned / maximum) * 100)));

    if (options.conflict) {
      return {
        label,
        detail: 'Identifier conflict',
        earned,
        maximum,
        percentage,
        textClass: 'text-[#e14f55]',
        barClass: 'bg-[#e14f55]'
      };
    }

    if (options.missing) {
      return {
        label,
        detail: 'Missing evidence',
        earned,
        maximum,
        percentage,
        textClass: 'text-[#df8b31]',
        barClass: 'bg-[#df8b31]'
      };
    }

    if (earned === maximum) {
      return {
        label,
        detail: 'Exact match',
        earned,
        maximum,
        percentage,
        textClass: 'text-[#2aa96b]',
        barClass: 'bg-[#2aa96b]'
      };
    }

    if (percentage >= 75) {
      return {
        label,
        detail: 'Strong match',
        earned,
        maximum,
        percentage,
        textClass: 'text-[#7542dd]',
        barClass: 'bg-[#8050e2]'
      };
    }

    if (percentage >= 45) {
      return {
        label,
        detail: 'Partial match',
        earned,
        maximum,
        percentage,
        textClass: 'text-[#df8b31]',
        barClass: 'bg-[#df8b31]'
      };
    }

    return {
      label,
      detail: 'Weak match',
      earned,
      maximum,
      percentage,
      textClass: 'text-[#e14f55]',
      barClass: 'bg-[#e14f55]'
    };
  }
</script>

<svelte:head>
  <title>{data.alert.productName} | Recall Agent</title>
</svelte:head>

<section aria-labelledby="alert-title">
  <WorkflowBreadcrumbs
    items={[{ label: 'Overview', href: '/dashboard' }, { label: 'Alert details' }, { label: data.alert.sourceReference }]}
  />

  <div class="mb-5 flex flex-col items-start justify-between gap-4 md:flex-row">
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <h1 id="alert-title" class="text-[23px] font-bold tracking-[-0.03em] text-[#17151c]">
          {data.alert.productName}
        </h1>
        <span class={`badge ${statusClass(data.alert.status)}`}>{statusLabel(data.alert.status)}</span>
        <span class="badge bg-[#fff0f0] text-[#e14f55]">{data.alert.risk}</span>
      </div>

      <div class="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-[10px] text-[#716b7b]">
        <span>Alert: <b class="text-[#17151c]">{data.alert.sourceReference}</b></span>
        <span>Source: <b class="text-[#17151c]">{sourceLabel(data.alert.source)}</b></span>
        <span>Published: <b class="text-[#17151c]">{formatDate(data.alert.publishedAt)}</b></span>
        <span>Reviewer: <b class="text-[#17151c]">{reviewOwner(data.alert.status)}</b></span>
      </div>
    </div>

    <a class="btn btn-secondary w-full self-start md:w-auto" href="/dashboard">
      <Icon name="arrow-left" size={15} />
      Back to Alert Feed
    </a>
  </div>

  <div class="grid grid-cols-1 gap-4 xl:grid-cols-12">
    <div class="space-y-4 xl:col-span-8">
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <article class="overflow-hidden rounded-[13px] border border-[#eae4f2] bg-white shadow-[0_1px_2px_rgba(40,24,65,0.025)]">
          <header class="flex min-h-16 items-center justify-between gap-3 border-b border-[#eae4f2] bg-[#fffafb] px-4 py-3">
            <div>
              <span class="text-[9px] font-semibold tracking-[0.14em] text-[#e14f55] uppercase">Official alert</span>
              <h2 class="mt-1 text-[14px] font-bold text-[#17151c]">{sourceLabel(data.alert.source)} record</h2>
            </div>
            <span class="badge max-w-[48%] bg-[#fff0f0] text-[#e14f55]">{data.alert.risk}</span>
          </header>

          <div class="p-4">
            <div class="mb-4 flex gap-3">
              <div class="grid h-20 w-24 shrink-0 place-items-center overflow-hidden rounded-lg bg-gradient-to-br from-[#f5e9fb] to-[#e2d2ff]">
                {#if data.alert.imageUrl}
                  <img
                    class="h-full w-full object-contain p-2"
                    src={data.alert.imageUrl}
                    alt={`${data.alert.productName} from the official alert`}
                  />
                {:else}
                  <Icon name="triangle-alert" size={34} class="text-[#7542dd]" />
                {/if}
              </div>
              <div class="min-w-0">
                <h3 class="text-[13px] font-bold text-[#17151c]">{data.alert.productName}</h3>
                <p class="mt-1 line-clamp-3 text-[9px] leading-4 text-[#716b7b]">{data.alert.description}</p>
                <a
                  class="mt-2 inline-flex items-center gap-1 text-[9px] font-semibold text-[#7542dd] hover:text-[#6330c8] hover:underline"
                  href={data.alert.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View official source
                  <Icon name="external-link" size={12} />
                </a>
              </div>
            </div>

            <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-[10px]">
              <div><dt class="text-[#716b7b]">Brand</dt><dd class="mt-1 font-semibold">{data.alert.brand ?? 'Not provided'}</dd></div>
              <div><dt class="text-[#716b7b]">Alert title</dt><dd class="mt-1 font-semibold">{data.alert.title}</dd></div>
              <div><dt class="text-[#716b7b]">EAN / GTIN</dt><dd class="mt-1 break-all font-semibold">{data.alert.ean ?? 'Not provided'}</dd></div>
              <div><dt class="text-[#716b7b]">Batch / lot</dt><dd class="mt-1 font-semibold">{data.alert.batch ?? 'Not provided'}</dd></div>
              <div><dt class="text-[#716b7b]">Category</dt><dd class="mt-1 font-semibold">{data.alert.category ?? 'Not provided'}</dd></div>
              <div><dt class="text-[#716b7b]">Published</dt><dd class="mt-1 font-semibold">{formatDate(data.alert.publishedAt)}</dd></div>
            </dl>
          </div>
        </article>

        <article class="overflow-hidden rounded-[13px] border border-[#eae4f2] bg-white shadow-[0_1px_2px_rgba(40,24,65,0.025)]">
          <header class="flex min-h-16 items-center justify-between gap-3 border-b border-[#eae4f2] bg-[#f8f4ff] px-4 py-3">
            <div>
              <span class="text-[9px] font-semibold tracking-[0.14em] text-[#7542dd] uppercase">Catalogue candidate</span>
              <h2 class="mt-1 text-[14px] font-bold text-[#17151c]">Your product record</h2>
            </div>
            {#if bestMatch}
              <span class="badge bg-[#f2eaff] text-[#7845dc]">{bestMatch.product.sku}</span>
            {/if}
          </header>

          <div class="p-4">
            {#if bestMatch}
              <div class="mb-4 flex gap-3">
                <div class="grid h-20 w-24 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[#eee5ff] to-[#d1b8ff] text-[#6330c8]">
                  <Icon name="package" size={34} />
                </div>
                <div class="min-w-0">
                  <h3 class="text-[13px] font-bold text-[#17151c]">{bestMatch.product.name}</h3>
                  <p class="mt-1 text-[9px] leading-4 text-[#716b7b]">
                    {bestMatch.product.supplierName ?? 'Supplier not provided'}. {bestMatch.product.stockQuantity} units currently registered.
                  </p>
                  <span class="mt-2 inline-flex items-center gap-1 text-[9px] font-semibold text-[#7542dd]">
                    Best of {data.candidates.length} candidates · {bestMatch.totalScore}%
                  </span>
                </div>
              </div>

              <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-[10px]">
                <div><dt class="text-[#716b7b]">Brand</dt><dd class="mt-1 font-semibold">{bestMatch.product.brand}</dd></div>
                <div><dt class="text-[#716b7b]">Category</dt><dd class="mt-1 font-semibold">{bestMatch.product.category ?? 'Not provided'}</dd></div>
                <div><dt class="text-[#716b7b]">EAN / GTIN</dt><dd class={`mt-1 break-all font-semibold ${bestMatch.hasHardConflict ? 'text-[#e14f55]' : ''}`}>{bestMatch.product.ean ?? 'Not provided'}</dd></div>
                <div><dt class="text-[#716b7b]">Batch / lot</dt><dd class={`mt-1 font-semibold ${!bestMatch.product.batch ? 'text-[#df8b31]' : ''}`}>{bestMatch.product.batch ?? 'Missing'}</dd></div>
                <div><dt class="text-[#716b7b]">Supplier</dt><dd class="mt-1 font-semibold">{bestMatch.product.supplierName ?? 'Not provided'}</dd></div>
                <div><dt class="text-[#716b7b]">Available stock</dt><dd class="mt-1 font-semibold">{bestMatch.product.stockQuantity} units</dd></div>
              </dl>
            {:else}
              <div class="grid min-h-64 place-items-center text-center">
                <div>
                  <span class="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-[#f3f2f5] text-[#787280]">
                    <Icon name="package" size={22} />
                  </span>
                  <h3 class="mt-3 text-[12px] font-bold">No catalogue candidate</h3>
                  <p class="mt-1 text-[9px] text-[#716b7b]">No products were available when this alert was processed.</p>
                </div>
              </div>
            {/if}
          </div>
        </article>
      </div>

      {#if bestMatch}
        <article class="rounded-[13px] border border-[#eae4f2] bg-white p-5 shadow-[0_1px_2px_rgba(40,24,65,0.025)]">
          <div class="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h2 class="text-[15px] font-bold text-[#17151c]">Match Explanation</h2>
              <p class="mt-1 text-[10px] text-[#716b7b]">Weighted identity comparison used by the matching engine.</p>
            </div>
            <div class="text-right">
              <span class="text-[26px] font-bold text-[#6330c8]">{bestMatch.totalScore}%</span>
              <span class="ml-1 text-[10px] text-[#716b7b]">confidence</span>
            </div>
          </div>

          <div class="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {#each scoreSignals as signal}
              <div>
                <div class="mb-1.5 flex justify-between gap-3 text-[10px]">
                  <span class="font-semibold">{signal.label}</span>
                  <span class={signal.textClass}>{signal.detail} · {signal.earned}/{signal.maximum}</span>
                </div>
                <div class="h-[6px] overflow-hidden rounded-full bg-[#eeeaf1]">
                  <div class={`h-full rounded-full ${signal.barClass}`} style={`width: ${signal.percentage}%`}></div>
                </div>
              </div>
            {/each}
          </div>

          <div class={`mt-5 flex items-start gap-3 rounded-xl border p-4 ${bestMatch.hasHardConflict || data.alert.status === 'needs_review' ? 'border-[#f5d8a7] bg-[#fffaf0]' : 'border-[#d7f2e3] bg-[#f4fcf7]'}`}>
            <span class={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${bestMatch.hasHardConflict || data.alert.status === 'needs_review' ? 'bg-[#ffedc9] text-[#bf7f19]' : 'bg-[#e1f7ea] text-[#2aa96b]'}`}>
              <Icon name="triangle-alert" size={16} />
            </span>
            <div>
              <b class="text-[11px]">
                {data.alert.status === 'needs_review' ? 'Human confirmation required' : data.alert.status === 'matched' ? 'Match classified automatically' : 'Candidate retained for traceability'}
              </b>
              <p class="mt-1 text-[10px] leading-4 text-[#7b6848]">{bestMatch.explanation}</p>
            </div>
          </div>
        </article>
      {/if}

      {#if data.candidates.length > 1}
        <article class="overflow-hidden rounded-[13px] border border-[#eae4f2] bg-white shadow-[0_1px_2px_rgba(40,24,65,0.025)]">
          <header class="flex items-center justify-between border-b border-[#eae4f2] px-4 py-3">
            <div>
              <h2 class="text-[14px] font-bold">Top catalogue candidates</h2>
              <p class="mt-1 text-[9px] text-[#716b7b]">The three highest-ranked records retained by monitoring.</p>
            </div>
            <span class="badge bg-[#f3f2f5] text-[#787280]">{data.candidates.length} records</span>
          </header>
          <ol class="divide-y divide-[#f0ecf4]">
            {#each data.candidates as candidate, index}
              <li class="flex items-center justify-between gap-4 px-4 py-3">
                <div class="flex min-w-0 items-center gap-3">
                  <span class={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${index === 0 ? 'bg-[#eadcff] text-[#6330c8]' : 'bg-[#f3f2f5] text-[#787280]'}`}>{index + 1}</span>
                  <div class="min-w-0">
                    <p class="truncate text-[10px] font-semibold text-[#302b35]">{candidate.product.name}</p>
                    <p class="mt-0.5 text-[9px] text-[#716b7b]">{candidate.product.sku} · {candidate.product.brand}</p>
                  </div>
                </div>
                <div class="text-right">
                  <b class="text-[12px] text-[#302b35]">{candidate.totalScore}%</b>
                  <span class="mt-0.5 block text-[8px] text-[#716b7b]">confidence</span>
                </div>
              </li>
            {/each}
          </ol>
        </article>
      {/if}
    </div>

    <aside class="space-y-4 xl:col-span-4">
      <article class="rounded-[13px] border border-[#eae4f2] bg-white p-4 shadow-[0_1px_2px_rgba(40,24,65,0.025)]">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-[14px] font-bold">Decision Summary</h2>
          <span class={`badge ${statusClass(data.alert.status)}`}>{statusLabel(data.alert.status)}</span>
        </div>

        {#if bestMatch}
          <div class="mt-4 rounded-xl bg-[#f8f4ff] p-4 text-center">
            <div
              class="mx-auto grid h-16 w-16 place-items-center rounded-full p-[7px]"
              style={`background: conic-gradient(#7542dd ${bestMatch.totalScore}%, #e4d3ff 0)`}
            >
              <span class="grid h-full w-full place-items-center rounded-full bg-white text-[16px] font-bold text-[#6330c8]">{bestMatch.totalScore}%</span>
            </div>
            <p class="mt-2 text-[10px] font-semibold">Best catalogue candidate</p>
          </div>

          <dl class="mt-4 space-y-3 text-[10px]">
            <div class="flex justify-between gap-4"><dt class="text-[#716b7b]">Classification</dt><dd class="text-right font-semibold">{statusLabel(data.alert.status)}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-[#716b7b]">Review reason</dt><dd class={`text-right font-semibold ${bestMatch.hasHardConflict ? 'text-[#e14f55]' : ''}`}>{reviewReason}</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-[#716b7b]">Potentially affected</dt><dd class="text-right font-semibold">{bestMatch.product.stockQuantity} units</dd></div>
            <div class="flex justify-between gap-4"><dt class="text-[#716b7b]">Candidates scored</dt><dd class="text-right font-semibold">{data.candidates.length}</dd></div>
          </dl>
        {:else}
          <p class="mt-4 rounded-xl bg-[#f3f2f5] p-4 text-[10px] leading-4 text-[#716b7b]">Monitoring did not retain a catalogue candidate for this alert.</p>
        {/if}

        {#if data.alert.status === 'needs_review'}
          <div class="mt-4 rounded-lg border border-[#e4d3ff] bg-[#f8f4ff] p-3 text-[9px] leading-4 text-[#716b7b]">
            <p>Human confirmation is required before this candidate can become a recall case.</p>
            {#if bestMatch}
              <a class="btn btn-primary mt-3 w-full" href={`/review?match=${bestMatch.id}`}>
                Open in Review Queue
                <Icon name="arrow-right" size={14} />
              </a>
            {/if}
          </div>
        {/if}
      </article>

      {#if bestMatch}
        <article class="rounded-[13px] border border-[#eae4f2] bg-white p-4 shadow-[0_1px_2px_rgba(40,24,65,0.025)]">
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-[14px] font-bold">Recommended Evidence</h2>
            <span class="text-[9px] font-semibold text-[#7542dd]">Read only</span>
          </div>
          <div class="mt-3 space-y-2">
            <div class="flex items-center gap-3 rounded-lg border border-[#eae4f2] p-3">
              <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#f8f4ff] text-[#7542dd]"><Icon name="camera" size={16} /></span>
              <span><b class="block text-[10px]">Batch-label photo</b><span class="text-[9px] text-[#716b7b]">{!data.alert.batch || !bestMatch.product.batch ? 'Resolve the missing affected lot number' : 'Reconfirm the affected lot number'}</span></span>
            </div>
            <div class="flex items-center gap-3 rounded-lg border border-[#eae4f2] p-3">
              <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#f8f4ff] text-[#7542dd]"><Icon name="file-text" size={16} /></span>
              <span><b class="block text-[10px]">Supplier invoice</b><span class="text-[9px] text-[#716b7b]">Verify delivery, batch and affected quantity</span></span>
            </div>
            <div class="flex items-center gap-3 rounded-lg border border-[#eae4f2] p-3">
              <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#f8f4ff] text-[#7542dd]"><Icon name="scan-barcode" size={16} /></span>
              <span><b class="block text-[10px]">Barcode photo</b><span class="text-[9px] text-[#716b7b]">{bestMatch.hasHardConflict ? 'Resolve the conflicting EAN identifiers' : 'Reconfirm the packaging identifier'}</span></span>
            </div>
          </div>
          <p class="mt-3 text-[9px] leading-4 text-[#716b7b]">These suggestions have not been requested or sent.</p>
        </article>

        <article class="rounded-[13px] border border-[#eae4f2] bg-white p-4 shadow-[0_1px_2px_rgba(40,24,65,0.025)]">
          <h2 class="text-[14px] font-bold">Catalogue Supplier</h2>
          <div class="mt-3 flex items-center gap-3">
            <span class="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-[#eee5ff] text-[#6330c8]"><Icon name="warehouse" size={20} /></span>
            <div class="min-w-0">
              <b class="block truncate text-[11px]">{bestMatch.product.supplierName ?? 'Supplier not provided'}</b>
              <p class="mt-1 text-[9px] text-[#716b7b]">Catalogue record · {bestMatch.product.sku}</p>
            </div>
          </div>
          <div class="mt-4 grid grid-cols-3 divide-x divide-[#eae4f2] text-center">
            <div class="px-1"><b class="block truncate text-[13px]">{bestMatch.product.sku}</b><span class="text-[8px] text-[#716b7b]">Internal SKU</span></div>
            <div class="px-1"><b class="block text-[15px]">{bestMatch.product.stockQuantity}</b><span class="text-[8px] text-[#716b7b]">Units in stock</span></div>
            <div class="px-1"><b class="block truncate text-[13px]">{bestMatch.product.category ?? '—'}</b><span class="text-[8px] text-[#716b7b]">Category</span></div>
          </div>
        </article>
      {/if}
    </aside>
  </div>
</section>
