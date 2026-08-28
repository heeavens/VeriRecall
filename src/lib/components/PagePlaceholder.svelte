<script lang="ts">
  import Icon from './Icon.svelte';

  let {
    eyebrow,
    title,
    description
  }: { eyebrow: string; title: string; description: string } = $props();

  const icon = $derived(
    title === 'Review Queue'
      ? 'scan-search'
      : title === 'Action Drafts'
        ? 'send'
        : 'briefcase-business'
  );
</script>

<svelte:head>
  <title>{title} · Recall Agent</title>
  <meta name="description" content={description} />
</svelte:head>

<header class="mb-5">
  <h1 class="text-[24px] font-bold tracking-[-.035em]">{title}</h1>
  <p class="mt-1 text-[12px] text-muted">{description}</p>
</header>

<section class="card grid min-h-[430px] place-items-center p-8 text-center">
  <div class="max-w-[390px]">
    <span class="mx-auto grid h-12 w-12 place-items-center rounded-full bg-violet-100 text-violet-600" aria-hidden="true">
      <Icon name={icon} size={20} />
    </span>
    <p class="mt-4 text-[9px] font-semibold tracking-[.15em] text-violet-600 uppercase">{eyebrow}</p>
    <h2 class="mt-1.5 text-[16px] font-bold">Ready for the next workflow stage</h2>
    <p class="mt-2 text-[10px] leading-5 text-muted">
      This area becomes active in the next workflow stage. The current monitoring and matching
      features remain available from Overview.
    </p>
    <a class="btn btn-ghost mt-5" href="/dashboard">Return to Overview</a>
  </div>
</section>
