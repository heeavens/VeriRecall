<script lang="ts">
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';

  import '../app.css';

  let { children }: { children: Snippet } = $props();

  const navigation = [
    { label: 'Overview', href: '/dashboard', icon: 'overview' },
    { label: 'Review Queue', href: '/review', icon: 'review' },
    { label: 'Cases', href: '/cases', icon: 'cases' },
    { label: 'Action Drafts', href: '/actions', icon: 'actions' }
  ] as const;

  function isActive(href: string): boolean {
    return page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
  }
</script>

<div class="min-h-screen lg:grid lg:grid-cols-[17rem_1fr]">
  <aside class="border-b border-slate-200 bg-slate-950 px-5 py-5 text-white lg:sticky lg:top-0 lg:h-screen lg:border-r lg:border-b-0 lg:px-6 lg:py-7">
    <a href="/dashboard" class="flex items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-400" aria-label="RecallOps AI overview">
      <span class="flex size-9 items-center justify-center rounded-xl bg-blue-500 shadow-lg shadow-blue-950/40" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" class="size-5" stroke="currentColor" stroke-width="2">
          <path d="M6 12.5 10 16l8-9" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <span>
        <span class="block text-sm font-semibold tracking-wide">RecallOps AI</span>
        <span class="block text-[11px] text-slate-400">Product safety workspace</span>
      </span>
    </a>

    <nav class="mt-5 flex gap-2 overflow-x-auto pb-1 lg:mt-10 lg:block lg:space-y-1" aria-label="Primary navigation">
      {#each navigation as item}
        <a
          href={item.href}
          aria-current={isActive(item.href) ? 'page' : undefined}
          class={`flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${isActive(item.href) ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'}`}
        >
          <span class="flex size-5 items-center justify-center" aria-hidden="true">
            {#if item.icon === 'overview'}
              <svg viewBox="0 0 24 24" fill="none" class="size-[18px]" stroke="currentColor" stroke-width="1.8"><path d="M4 13h6V4H4v9Zm0 7h6v-3H4v3Zm10 0h6v-9h-6v9Zm0-16v3h6V4h-6Z" stroke-linejoin="round" /></svg>
            {:else if item.icon === 'review'}
              <svg viewBox="0 0 24 24" fill="none" class="size-[18px]" stroke="currentColor" stroke-width="1.8"><path d="M9 11h6m-6 4h4m7-3a8 8 0 1 1-3.1-6.33L20 4v8Z" stroke-linecap="round" stroke-linejoin="round" /></svg>
            {:else if item.icon === 'cases'}
              <svg viewBox="0 0 24 24" fill="none" class="size-[18px]" stroke="currentColor" stroke-width="1.8"><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7m-11 4h16M5 7h14a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" stroke-linecap="round" stroke-linejoin="round" /></svg>
            {:else}
              <svg viewBox="0 0 24 24" fill="none" class="size-[18px]" stroke="currentColor" stroke-width="1.8"><path d="M7 3.5h8l3 3V20H7V3.5Zm8 0v3h3M4 7v13h10" stroke-linecap="round" stroke-linejoin="round" /></svg>
            {/if}
          </span>
          {item.label}
        </a>
      {/each}
    </nav>

    <div class="mt-5 hidden rounded-xl border border-white/10 bg-white/5 p-3 lg:absolute lg:right-6 lg:bottom-7 lg:left-6 lg:block">
      <p class="text-[11px] font-medium tracking-wide text-slate-500 uppercase">Local workspace</p>
      <p class="mt-1 text-xs leading-5 text-slate-300">No external actions are connected.</p>
    </div>
  </aside>

  <div class="min-w-0">
    <header class="flex h-16 items-center justify-between border-b border-slate-200/80 bg-white/80 px-5 backdrop-blur lg:px-10">
      <p class="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase">Recall monitoring</p>
      <div class="flex items-center gap-2.5" aria-label="Current user">
        <span class="flex size-8 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">DU</span>
        <span class="hidden text-sm font-medium text-slate-700 sm:inline">Demo User</span>
      </div>
    </header>

    <main class="mx-auto w-full max-w-7xl px-5 py-8 lg:px-10 lg:py-10">
      {@render children()}
    </main>
  </div>
</div>
