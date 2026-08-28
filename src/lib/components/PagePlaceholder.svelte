<script lang="ts">
  let {
    eyebrow,
    title,
    description
  }: { eyebrow: string; title: string; description: string } = $props();
</script>

<svelte:head>
  <title>{title} · RecallOps AI</title>
  <meta name="description" content={description} />
</svelte:head>

<header class="mb-8">
  <p class="mb-2 text-xs font-bold tracking-[0.16em] text-blue-700 uppercase">{eyebrow}</p>
  <h1 class="text-3xl font-semibold tracking-tight text-slate-950">{title}</h1>
  <p class="mt-3 max-w-2xl text-sm leading-6 text-slate-600">{description}</p>
</header>

<section class="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm shadow-slate-200/60">
  <div class="flex size-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" class="size-5" stroke="currentColor" stroke-width="1.8">
      <path d="M12 8v4m0 4h.01M4.9 19h14.2a2 2 0 0 0 1.73-3L13.73 3.7a2 2 0 0 0-3.46 0L3.17 16A2 2 0 0 0 4.9 19Z" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </div>
  <h2 class="mt-5 text-base font-semibold text-slate-900">Ready for the next workflow stage</h2>
  <p class="mt-2 max-w-xl text-sm leading-6 text-slate-500">
    This foundation route is connected and ready. Product recall data and actions will be added in their dedicated implementation stages.
  </p>
</section>
