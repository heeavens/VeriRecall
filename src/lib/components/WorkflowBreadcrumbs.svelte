<script lang="ts">
  import Icon from './Icon.svelte';

  export interface BreadcrumbItem {
    label: string;
    href?: string;
  }

  let { items }: { items: readonly BreadcrumbItem[] } = $props();
</script>

<nav class="workflow-breadcrumbs" aria-label="Breadcrumb">
  {#each items as item, index}
    {#if index > 0}
      <Icon name="chevron-right" size={12} />
    {/if}
    {#if item.href}
      <a href={item.href}>{item.label}</a>
    {:else}
      <span aria-current={index === items.length - 1 ? 'page' : undefined}>{item.label}</span>
    {/if}
  {/each}
</nav>

<style>
  .workflow-breadcrumbs {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    margin-bottom: 13px;
    color: #716b7b;
    font-size: 9px;
    line-height: 1.3;
  }

  .workflow-breadcrumbs :global(svg) {
    flex: 0 0 auto;
    color: #a59eac;
  }

  .workflow-breadcrumbs a,
  .workflow-breadcrumbs span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workflow-breadcrumbs a {
    color: #6330c8;
    font-weight: 700;
  }

  .workflow-breadcrumbs a:hover {
    text-decoration: underline;
  }
</style>
