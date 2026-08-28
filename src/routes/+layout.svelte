<script lang="ts">
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';

  import Icon from '$lib/components/Icon.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import '../app.css';

  interface NavigationItem {
    label: string;
    href: string;
    icon: string;
    activePrefixes: readonly string[];
  }

  let { children }: { children: Snippet } = $props();

  const navigation: readonly NavigationItem[] = [
    {
      label: 'Overview',
      href: '/dashboard',
      icon: 'layout-dashboard',
      activePrefixes: ['/dashboard']
    },
    {
      label: 'Review Queue',
      href: '/review',
      icon: 'scan-search',
      activePrefixes: ['/review', '/alerts']
    },
    {
      label: 'Cases',
      href: '/cases',
      icon: 'briefcase-business',
      activePrefixes: ['/cases']
    },
    {
      label: 'Action Drafts',
      href: '/actions',
      icon: 'send',
      activePrefixes: ['/actions']
    }
  ];

  const isOnboarding = $derived(
    page.url.pathname === '/onboarding' || page.url.pathname.startsWith('/onboarding/')
  );

  function isActive(item: NavigationItem): boolean {
    return item.activePrefixes.some(
      (prefix) => page.url.pathname === prefix || page.url.pathname.startsWith(`${prefix}/`)
    );
  }
</script>

{#if isOnboarding}
  {@render children()}
{:else}
  <div class="app-root">
    <header class="app-header">
      <div class="app-header__grid">
        <a class="app-brand" href="/dashboard" aria-label="Recall Agent overview">
          <Logo />
          <span>Recall Agent</span>
        </a>

        <div class="app-header__content">
          <div class="app-header__primary">
            <form class="global-search" action="/dashboard" method="GET" role="search">
              <label class="sr-only" for="global-search">Search alerts and catalogue records</label>
              <Icon class="global-search__icon" name="search" size={15} />
              <input
                id="global-search"
                class="input-ui"
                type="search"
                name="q"
                value={page.url.searchParams.get('q') ?? ''}
                placeholder="Alerts, EAN, products, suppliers, cases..."
                autocomplete="off"
              />
            </form>

            <a class="header-task" href="/review">
              <span class="header-task__label">Critical review due today</span>
              <span class="header-task__copy">Review the next uncertain catalogue match</span>
            </a>

            <a class="header-view-all" href="/review">View all</a>
          </div>

          <div class="app-header__tools">
            <button class="icon-button" type="button" aria-label="Notifications" title="Notifications">
              <Icon name="bell" size={17} />
            </button>
            <a class="icon-button" href="/onboarding" aria-label="Help and demo setup" title="Help and demo setup">
              <Icon name="circle-help" size={18} />
            </a>
            <span class="header-divider" aria-hidden="true"></span>
            <button class="user-menu" type="button" aria-label="Demo user menu">
              <span class="user-avatar" aria-hidden="true">HS</span>
              <span class="user-copy">
                <span class="user-name">Herman</span>
                <span class="user-role">Compliance operator</span>
              </span>
              <Icon class="user-chevron" name="chevron-down" size={12} />
            </button>
          </div>
        </div>
      </div>
    </header>

    <div class="app-layout">
      <aside class="card app-sidebar">
        <nav class="sidebar-nav" aria-label="Primary navigation">
          <div class="sidebar-nav__list">
            {#each navigation as item}
              <a
                class="nav-item"
                class:active={isActive(item)}
                href={item.href}
                aria-current={isActive(item) ? 'page' : undefined}
              >
                <Icon name={item.icon} size={17} />
                <span>{item.label}</span>
              </a>
            {/each}
          </div>

          <div class="sidebar-nav__footer">
            <a class="nav-item" href="/onboarding">
              <Icon name="sparkles" size={17} />
              <span>Demo Setup</span>
            </a>

            <div class="human-approval">
              <div class="human-approval__title">
                <Icon name="shield-check" size={16} />
                <span>Human approval active</span>
              </div>
              <p class="human-approval__copy">
                Critical actions cannot be sent without confirmation.
              </p>
            </div>
          </div>
        </nav>
      </aside>

      <main class="app-main">
        {@render children()}
      </main>
    </div>
  </div>
{/if}
