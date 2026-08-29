<script lang="ts">
  import { page } from '$app/state';

  import Icon from '$lib/components/Icon.svelte';

  const title = $derived(page.status === 404 ? 'Page not found' : 'This screen could not be loaded');
  const message = $derived(
    page.status === 404
      ? 'The requested demo record does not exist or is no longer available.'
      : (page.error?.message ?? 'An unexpected local error occurred. Your saved workflow data was not changed.')
  );
</script>

<svelte:head>
  <title>{page.status} | Recall Agent</title>
  <meta name="description" content="Recall Agent error state." />
</svelte:head>

<section class="card grid min-h-[520px] place-items-center p-8 text-center" aria-labelledby="error-title">
  <div class="max-w-[430px]">
    <span class="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#fff2f2] text-[#e14f55]">
      <Icon name="triangle-alert" size={24} />
    </span>
    <p class="mt-4 text-[10px] font-semibold tracking-[.14em] text-muted uppercase">Error {page.status}</p>
    <h1 id="error-title" class="mt-2 text-[22px] font-bold tracking-[-.03em]">{title}</h1>
    <p class="mt-2 text-[11px] leading-5 text-muted">{message}</p>
    <div class="mt-5 flex justify-center gap-2">
      <a class="btn btn-primary" href="/dashboard">
        <Icon name="layout-dashboard" size={15} /> Return to Overview
      </a>
      <button class="btn btn-secondary" type="button" onclick={() => window.location.reload()}>
        <Icon name="refresh-cw" size={15} /> Try Again
      </button>
    </div>
  </div>
</section>
