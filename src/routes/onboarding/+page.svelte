<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';

  import FileUpload from '$lib/components/FileUpload.svelte';
  import ImportSummary from '$lib/components/ImportSummary.svelte';

  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();

  function initialStep(): number {
    return form?.kind === 'purchases' ? 2 : form?.kind === 'complete' ? 3 : 1;
  }

  function initialThreshold(): number {
    return data.confidenceThreshold;
  }

  let step = $state(initialStep());
  let threshold = $state(initialThreshold());
  let pendingAction = $state<'complete' | 'demo' | null>(null);

  function trackSubmission(action: 'complete' | 'demo'): SubmitFunction {
    return () => {
      pendingAction = action;
      return async ({ update }) => {
        try {
          await update();
        } finally {
          pendingAction = null;
        }
      };
    };
  }

  const enhanceComplete = trackSubmission('complete');
  const enhanceDemo = trackSubmission('demo');

  const steps = [
    { title: 'Catalogue', detail: 'CSV or Excel' },
    { title: 'Purchase Data', detail: 'Optional import' },
    { title: 'Review Rules', detail: 'Match threshold' },
    { title: 'Ready', detail: 'Launch dashboard' }
  ];
</script>

<svelte:head>
  <title>Workspace setup — Recall Agent</title>
  <meta name="description" content="Import product catalogue data and configure recall matching." />
</svelte:head>

<div class="setup-page min-h-screen p-6">
  <div class="setup-panel mx-auto overflow-hidden rounded-2xl bg-white">
    <div class="grid min-h-[510px] grid-cols-[215px_minmax(0,1fr)]">
      <aside class="setup-sidebar p-6 text-white">
        <a href="/dashboard" class="flex items-center gap-2" aria-label="Recall Agent dashboard">
          <span class="relative block h-7 w-7" aria-hidden="true">
            <span class="absolute top-1 left-1 h-5 w-4 -rotate-6 rounded bg-[#8452e7]"></span>
            <span class="absolute top-0 left-2.5 h-5 w-4 rotate-6 rounded bg-[#b284ff]"></span>
          </span>
          <b class="text-[14px]">Recall Agent</b>
        </a>
        <p class="mt-6 text-[10px] leading-5 text-[#cfc2e6]">
          Prepare the local demo workspace and matching rules.
        </p>

        <ol class="mt-8 space-y-5">
          {#each steps as item, index}
            <li class:opacity-50={step < index + 1} class="flex gap-3">
              <span
                class:active-step={step >= index + 1}
                class="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[#736287] text-[9px] font-bold"
              >
                {index + 1}
              </span>
              <span>
                <b class="block text-[10px]">{item.title}</b>
                <small class="text-[8px] text-[#a99aba]">{item.detail}</small>
              </span>
            </li>
          {/each}
        </ol>

        <div class="mt-auto border-t border-[#403352] pt-5 text-[9px] leading-4 text-[#b8abc9]">
          <div class="flex items-center gap-2 font-semibold text-[#ddccf5]">
            <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M12 3 5 6v5c0 4.5 2.8 8 7 10 4.2-2 7-5.5 7-10V6l-7-3Zm-3 8 2 2 4-4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            Safe import
          </div>
          <p class="mt-1.5">An invalid file never adds incomplete catalogue or purchase records.</p>
        </div>
      </aside>

      <main class="flex min-w-0 flex-col p-6 sm:p-7">
        <div class="flex items-start justify-between gap-5">
          <div>
            <span class="text-[9px] font-semibold tracking-[.15em] text-[#7542dd] uppercase">Workspace setup</span>
            {#if step === 1}
              <h1 class="mt-1 text-[20px] font-bold tracking-[-.02em]">Import your product catalogue</h1>
              <p class="mt-1 text-[10px] text-[#716b7b]">Upload CSV or Excel data to create catalogue records.</p>
            {:else if step === 2}
              <h1 class="mt-1 text-[20px] font-bold tracking-[-.02em]">Add customer purchase data</h1>
              <p class="mt-1 text-[10px] text-[#716b7b]">Optional data helps identify affected customers during containment.</p>
            {:else}
              <h1 class="mt-1 text-[20px] font-bold tracking-[-.02em]">Set matching confidence</h1>
              <p class="mt-1 text-[10px] text-[#716b7b]">Choose when candidates require human review.</p>
            {/if}
          </div>
          <a href="/dashboard" class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[#716b7b] hover:bg-[#f8f4ff]" aria-label="Close setup">
            <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="m7 7 10 10M17 7 7 17" stroke-linecap="round" />
            </svg>
          </a>
        </div>

        <div class="mt-6 flex-1">
          {#if step === 1}
            <FileUpload
              id="catalogue-file"
              title="Drag and drop your catalogue"
              description="CSV or XLSX · up to 5 MB · required: sku, name, brand"
              action="?/uploadCatalog"
              buttonLabel="Upload & validate"
            />

            {#if form?.kind === 'catalogue' && form.summary}
              <ImportSummary summary={form.summary} title="Catalogue import summary" />
              <div class="catalogue-quality" aria-label="Imported catalogue quality">
                <div><span>Catalogue products</span><strong>{data.productCount.toLocaleString('en')}</strong></div>
                <div><span>Missing EAN / GTIN</span><strong>{data.missingEanCount.toLocaleString('en')}</strong></div>
                <div><span>Missing batch</span><strong>{data.missingBatchCount.toLocaleString('en')}</strong></div>
              </div>
            {:else if form?.kind === 'catalogue' && form.message}
              <p class="form-error" role="alert">{form.message}</p>
            {:else if data.productCount > 0}
              <div class="mt-4 flex items-center gap-3 rounded-lg border border-[#d7f2e3] bg-[#f4fcf7] p-3">
                <span class="grid h-8 w-8 place-items-center rounded-full bg-[#e1f7ea] text-[#2aa96b]">
                  <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 12 4 4 8-9" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </span>
                <span>
                  <b class="block text-[10px]">Catalogue ready</b>
                  <small class="text-[8px] text-[#716b7b]">
                    {data.productCount.toLocaleString('en')} products · {data.missingEanCount.toLocaleString('en')} missing EAN · {data.missingBatchCount.toLocaleString('en')} missing batch
                  </small>
                </span>
              </div>
            {/if}
          {:else if step === 2}
            <FileUpload
              id="purchase-file"
              title="Drag and drop customer purchases"
              description="CSV or XLSX · up to 5 MB · required: customer_id, sku, purchased_at"
              action="?/uploadCustomers"
              buttonLabel="Upload & validate"
            />

            {#if form?.kind === 'purchases' && form.summary}
              <ImportSummary summary={form.summary} title="Purchase import summary" />
            {:else if form?.kind === 'purchases' && form.message}
              <p class="form-error" role="alert">{form.message}</p>
            {/if}

            <div class="mt-4 grid grid-cols-2 gap-3">
              <div class="rounded-lg bg-[#f8f4ff] p-3">
                <span class="text-[9px] text-[#716b7b]">Customers</span>
                <b class="mt-1 block text-[18px]">{data.customerCount.toLocaleString('en')}</b>
              </div>
              <div class="rounded-lg bg-[#f8f4ff] p-3">
                <span class="text-[9px] text-[#716b7b]">Purchases</span>
                <b class="mt-1 block text-[18px]">{data.purchaseCount.toLocaleString('en')}</b>
              </div>
            </div>
          {:else}
            <form method="POST" action="?/complete" use:enhance={enhanceComplete} aria-busy={pendingAction === 'complete'}>
              <div class="rounded-xl border border-[#eae4f2] p-5">
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <b class="block text-[12px]">Confidence threshold</b>
                    <span class="mt-1 block text-[9px] text-[#716b7b]">Automatic matches must meet or exceed this score.</span>
                  </div>
                  <output for="confidenceThreshold" class="rounded-md bg-[#f1e9ff] px-2 py-1 text-[11px] font-bold text-[#6330c8]">{threshold}%</output>
                </div>
                <input
                  id="confidenceThreshold"
                  name="confidenceThreshold"
                  type="range"
                  min="70"
                  max="95"
                  step="1"
                  bind:value={threshold}
                  class="threshold-range mt-5 w-full"
                />
                <div class="mt-2 flex justify-between text-[9px] text-[#716b7b]"><span>70%</span><span>95%</span></div>
                <p class="mt-5 rounded-lg bg-[#fff9e9] p-3 text-[9px] leading-4 text-[#7b6848]">
                  Candidates between 55% and {threshold}%, plus every hard identifier conflict, will enter the Review Queue.
                </p>
              </div>

              <div class="mt-4 flex items-center justify-between rounded-xl border border-[#eae4f2] p-4 text-[10px]">
                <span>
                  <b class="block">Workspace data</b>
                  <span class="mt-1 block text-[#716b7b]">{data.productCount.toLocaleString('en')} products · {data.purchaseCount.toLocaleString('en')} purchases</span>
                </span>
                <span class="badge badge-green">Ready</span>
              </div>

              {#if form?.kind === 'complete' && form.message}
                <p class="form-error" role="alert">{form.message}</p>
              {/if}

              <div class="mt-5 flex justify-end">
                <button type="submit" class="btn btn-primary" disabled={pendingAction !== null}>
                  {pendingAction === 'complete' ? 'Preparing workspace…' : 'Complete setup & check alerts'}
                  <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </button>
              </div>
            </form>
          {/if}
        </div>

        {#if step < 3}
          <div class="mt-5 flex items-center justify-between border-t border-[#eee9f4] pt-4">
            {#if step === 1}
              <form method="POST" action="?/useDemoData" use:enhance={enhanceDemo} aria-busy={pendingAction === 'demo'}>
                <button type="submit" disabled={pendingAction !== null} class="text-[10px] font-semibold text-[#7542dd] hover:text-[#6330c8] disabled:opacity-50">
                  {pendingAction === 'demo' ? 'Preparing demo…' : 'Use demo data'}
                </button>
              </form>
            {:else}
              <button type="button" class="btn btn-secondary" onclick={() => (step = 1)}>
                <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m15 5-7 7 7 7" stroke-linecap="round" stroke-linejoin="round" /></svg>
                Back
              </button>
            {/if}
            <button
              type="button"
              class="btn btn-primary"
              disabled={step === 1 && data.productCount === 0}
              onclick={() => (step += 1)}
            >
              {step === 2 ? 'Skip or continue' : 'Continue'}
              <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </div>
        {:else}
          <div class="mt-5 flex items-center justify-between border-t border-[#eee9f4] pt-4">
            <button type="button" class="btn btn-secondary" onclick={() => (step = 2)}>
              <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m15 5-7 7 7 7" stroke-linecap="round" stroke-linejoin="round" /></svg>
              Back
            </button>
            <form method="POST" action="?/useDemoData" use:enhance={enhanceDemo} aria-busy={pendingAction === 'demo'}>
              <button type="submit" disabled={pendingAction !== null} class="text-[10px] font-semibold text-[#7542dd] hover:text-[#6330c8] disabled:opacity-50">
                {pendingAction === 'demo' ? 'Preparing demo…' : 'Use demo data instead'}
              </button>
            </form>
          </div>
        {/if}
      </main>
    </div>
  </div>
</div>

<style>
  .setup-page {
    display: grid;
    place-items: center;
    background:
      linear-gradient(rgba(24, 18, 31, 0.38), rgba(24, 18, 31, 0.38)),
      radial-gradient(circle at 75% 20%, #f8f4ff 0, #fcfbfe 42%, #f5f1f8 100%);
    backdrop-filter: blur(3px);
  }

  .setup-panel {
    width: min(880px, 100%);
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    box-shadow: 0 28px 80px rgba(38, 22, 60, 0.24);
  }

  .setup-sidebar {
    display: flex;
    flex-direction: column;
    background: #211833;
  }

  .active-step {
    border-color: #8452e7;
    background: #8452e7;
  }

  .form-error {
    margin-top: 12px;
    border: 1px solid #ffd9db;
    border-radius: 10px;
    background: #fff8f8;
    padding: 11px 12px;
    color: #a7353b;
    font-size: 10px;
  }

  .threshold-range {
    accent-color: #7b49df;
  }

  .catalogue-quality {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-top: 12px;
  }

  .catalogue-quality > div {
    border-radius: 9px;
    background: #f8f4ff;
    padding: 10px 11px;
  }

  .catalogue-quality span,
  .catalogue-quality strong {
    display: block;
  }

  .catalogue-quality span {
    color: #716b7b;
    font-size: 8px;
  }

  .catalogue-quality strong {
    margin-top: 5px;
    font-size: 16px;
  }

  @media (max-width: 720px) {
    .setup-page {
      display: block;
      min-height: 100vh;
      padding: 0;
    }

    .setup-panel {
      width: 100%;
      min-height: 100vh;
      max-height: none;
      border-radius: 0;
    }

    .setup-panel > :global(div) {
      min-height: 100vh;
      grid-template-columns: 1fr;
      grid-template-rows: max-content minmax(0, 1fr);
    }

    .setup-sidebar {
      min-height: 0;
      padding: 18px;
    }

    .setup-sidebar > :global(p),
    .setup-sidebar > :global(div:last-child),
    .setup-sidebar :global(small) {
      display: none;
    }

    .setup-sidebar :global(ol) {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-top: 18px;
    }

    .setup-sidebar :global(li) {
      align-items: center;
      flex-direction: column;
      gap: 5px;
      margin-top: 0 !important;
      text-align: center;
    }
  }

  @media (max-width: 460px) {
    .setup-sidebar :global(li b) {
      display: none;
    }

    .catalogue-quality {
      grid-template-columns: 1fr;
    }
  }

</style>
