<script lang="ts">
  let { data } = $props();

  const bestMatch = $derived(data.candidates[0] ?? null);

  function sourceLabel(source: string): string {
    return source === 'safety_gate' ? 'Safety Gate' : 'RASFF';
  }

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

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(new Date(value));
  }
</script>

<svelte:head><title>{data.alert.productName} | RecallOps AI</title></svelte:head>

<section aria-labelledby="alert-title">
  <a href="/dashboard" class="text-sm font-semibold text-blue-700 hover:underline">← Back to Alert Feed</a>

  <div class="mt-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
    <div class="max-w-3xl">
      <div class="flex flex-wrap items-center gap-2">
        <span class="rounded-md bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">{sourceLabel(data.alert.source)}</span>
        <span class={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusClass(data.alert.status)}`}>{statusLabel(data.alert.status)}</span>
      </div>
      <h1 id="alert-title" class="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{data.alert.productName}</h1>
      <p class="mt-2 text-sm text-slate-500">{data.alert.sourceReference} · Published {formatDate(data.alert.publishedAt)}</p>
    </div>
    <a class="btn btn-secondary" href={data.alert.sourceUrl} target="_blank" rel="noreferrer">View original alert ↗</a>
  </div>

  <div class="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
    <article class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/40">
      <p class="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase">Official alert</p>
      <div class="mt-5 flex flex-col gap-5 sm:flex-row">
        {#if data.alert.imageUrl}
          <div class="flex h-40 w-full shrink-0 items-center justify-center rounded-xl bg-slate-50 p-4 sm:w-44">
            <img class="max-h-full max-w-full" src={data.alert.imageUrl} alt="" />
          </div>
        {/if}
        <dl class="grid flex-1 grid-cols-[7rem_1fr] gap-x-4 gap-y-3 text-sm">
          <dt class="text-slate-500">Brand</dt><dd class="font-medium text-slate-800">{data.alert.brand ?? 'Not provided'}</dd>
          <dt class="text-slate-500">EAN</dt><dd class="font-mono text-xs text-slate-800">{data.alert.ean ?? 'Not provided'}</dd>
          <dt class="text-slate-500">Batch</dt><dd class="font-medium text-slate-800">{data.alert.batch ?? 'Not provided'}</dd>
          <dt class="text-slate-500">Category</dt><dd class="font-medium text-slate-800">{data.alert.category ?? 'Not provided'}</dd>
          <dt class="text-slate-500">Risk</dt><dd class="font-medium text-red-700">{data.alert.risk}</dd>
        </dl>
      </div>
      <div class="mt-6 border-t border-slate-100 pt-5">
        <h2 class="text-sm font-semibold text-slate-900">Risk description</h2>
        <p class="mt-2 text-sm leading-6 text-slate-600">{data.alert.description}</p>
      </div>
    </article>

    <article class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/40">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase">Best catalogue match</p>
          {#if bestMatch}
            <h2 class="mt-2 text-xl font-semibold text-slate-950">{bestMatch.product.name}</h2>
            <p class="mt-1 text-sm text-slate-500">{bestMatch.product.sku} · {bestMatch.product.brand}</p>
          {/if}
        </div>
        {#if bestMatch}
          <span class="rounded-xl bg-blue-50 px-3 py-2 text-xl font-semibold text-blue-700">{bestMatch.totalScore}%</span>
        {/if}
      </div>

      {#if bestMatch}
        <div class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded-xl bg-slate-50 p-3"><p class="text-xs text-slate-500">EAN</p><p class="mt-1 font-semibold text-slate-900">{bestMatch.eanScore} / 45</p></div>
          <div class="rounded-xl bg-slate-50 p-3"><p class="text-xs text-slate-500">Name</p><p class="mt-1 font-semibold text-slate-900">{bestMatch.nameScore} / 25</p></div>
          <div class="rounded-xl bg-slate-50 p-3"><p class="text-xs text-slate-500">Brand</p><p class="mt-1 font-semibold text-slate-900">{bestMatch.brandScore} / 20</p></div>
          <div class="rounded-xl bg-slate-50 p-3"><p class="text-xs text-slate-500">Batch</p><p class="mt-1 font-semibold text-slate-900">{bestMatch.batchScore} / 10</p></div>
        </div>
        {#if bestMatch.hasHardConflict}
          <p class="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">Hard identifier conflict detected. Human review is required.</p>
        {/if}
        <p class="mt-4 text-sm leading-6 text-slate-600">{bestMatch.explanation}</p>
        <dl class="mt-5 grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2 border-t border-slate-100 pt-5 text-sm">
          <dt class="text-slate-500">EAN</dt><dd class="font-mono text-xs text-slate-800">{bestMatch.product.ean ?? 'Not provided'}</dd>
          <dt class="text-slate-500">Batch</dt><dd class="text-slate-800">{bestMatch.product.batch ?? 'Not provided'}</dd>
          <dt class="text-slate-500">Supplier</dt><dd class="text-slate-800">{bestMatch.product.supplierName ?? 'Not provided'}</dd>
          <dt class="text-slate-500">Stock</dt><dd class="text-slate-800">{bestMatch.product.stockQuantity} units</dd>
        </dl>
      {:else}
        <p class="mt-6 text-sm text-slate-500">No catalogue products were available when this alert was processed.</p>
      {/if}
    </article>
  </div>

  {#if data.candidates.length > 1}
    <div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/40">
      <h2 class="text-base font-semibold text-slate-900">Top catalogue candidates</h2>
      <ol class="mt-4 divide-y divide-slate-100">
        {#each data.candidates as candidate, index}
          <li class="flex items-center justify-between gap-4 py-3">
            <div class="flex min-w-0 items-center gap-3">
              <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{index + 1}</span>
              <div class="min-w-0"><p class="truncate text-sm font-medium text-slate-900">{candidate.product.name}</p><p class="mt-0.5 text-xs text-slate-500">{candidate.product.sku}</p></div>
            </div>
            <span class="font-semibold text-slate-800">{candidate.totalScore}%</span>
          </li>
        {/each}
      </ol>
    </div>
  {/if}
</section>
