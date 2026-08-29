<script lang="ts">
  let {
    name,
    size = 18,
    strokeWidth = 1.8,
    class: className = ''
  }: {
    name: string;
    size?: number;
    strokeWidth?: number;
    class?: string;
  } = $props();
</script>

<svg
  viewBox="0 0 24 24"
  fill="none"
  width={size}
  height={size}
  class={className}
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
  data-icon={name}
>
  {#if name === 'layout-dashboard'}
    <rect x="3" y="3" width="7" height="9" rx="1" />
    <rect x="14" y="3" width="7" height="5" rx="1" />
    <rect x="14" y="12" width="7" height="9" rx="1" />
    <rect x="3" y="16" width="7" height="5" rx="1" />
  {:else if name === 'radio-tower'}
    <path d="M8.5 16.5a5.5 5.5 0 0 1 0-9M15.5 7.5a5.5 5.5 0 0 1 0 9" />
    <path d="M5.5 19.5a9.5 9.5 0 0 1 0-15M18.5 4.5a9.5 9.5 0 0 1 0 15" />
    <circle cx="12" cy="12" r="1.5" />
  {:else if name === 'scan-search'}
    <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
    <circle cx="11" cy="11" r="4" />
    <path d="m14 14 3.5 3.5" />
  {:else if name === 'circle-check-big'}
    <path d="M21.8 10.3A10 10 0 1 1 17.6 4" />
    <path d="m9 11 3 3L22 4" />
  {:else if name === 'briefcase-business' || name === 'briefcase'}
    <rect x="3" y="7" width="18" height="13" rx="2" />
    <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2" />
  {:else if name === 'archive-check'}
    <rect x="3" y="5" width="18" height="4" rx="1" />
    <path d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M9 13h2" />
    <path d="m12 16 2 2 4-4" />
  {:else if name === 'refresh-cw'}
    <path d="M20 7v5h-5M4 17v-5h5" />
    <path d="M6.1 8.2A7 7 0 0 1 18.7 6L20 8M4 16l1.3 2a7 7 0 0 0 12.6-2.2" />
  {:else if name === 'chevron-right'}
    <path d="m9 18 6-6-6-6" />
  {:else if name === 'chevron-left'}
    <path d="m15 18-6-6 6-6" />
  {:else if name === 'chevron-down'}
    <path d="m6 9 6 6 6-6" />
  {:else if name === 'triangle-alert'}
    <path d="M10.3 3.7 2.4 17.5A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.5L13.7 3.7a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  {:else if name === 'arrow-left'}
    <path d="m15 18-6-6 6-6M9 12h10" />
  {:else if name === 'arrow-right'}
    <path d="M5 12h14m-6-6 6 6-6 6" />
  {:else if name === 'external-link'}
    <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  {:else if name === 'package'}
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
    <path d="m4.5 7.8 7.5 4.3 7.5-4.3M12 12v9M8 5.2l8 4.6" />
  {:else if name === 'camera'}
    <path d="M14.5 4 16 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-3h5Z" />
    <circle cx="12" cy="13" r="3.5" />
  {:else if name === 'file-text'}
    <path d="M6 2h8l4 4v16H6V2Z" />
    <path d="M14 2v5h5M9 13h6M9 17h6M9 9h2" />
  {:else if name === 'scan-barcode'}
    <path d="M3 6V4a1 1 0 0 1 1-1h2M18 3h2a1 1 0 0 1 1 1v2M21 18v2a1 1 0 0 1-1 1h-2M6 21H4a1 1 0 0 1-1-1v-2" />
    <path d="M7 8v8M10 8v8M14 8v8M17 8v8" />
  {:else if name === 'warehouse'}
    <path d="m3 10 9-7 9 7v11H3V10Z" />
    <path d="M7 21v-7h10v7M7 10h.01M12 10h.01M17 10h.01" />
  {:else if name === 'shield-alert'}
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    <path d="M12 8v4M12 16h.01" />
  {:else if name === 'shield-check'}
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    <path d="m9 12 2 2 4-4" />
  {:else if name === 'send'}
    <path d="m22 2-7 20-4-9-9-4 20-7Z" />
    <path d="M22 2 11 13" />
  {:else if name === 'sparkles'}
    <path d="m12 3-1.1 3.1L8 7.2l2.9 1.1L12 11.5l1.1-3.2L16 7.2l-2.9-1.1L12 3ZM5 13l-.8 2.2L2 16l2.2.8L5 19l.8-2.2L8 16l-2.2-.8L5 13ZM18 13l-1.1 3.1-2.9 1.1 2.9 1.1L18 21.5l1.1-3.2 2.9-1.1-2.9-1.1L18 13Z" />
  {:else if name === 'search'}
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-4-4" />
  {:else if name === 'bell'}
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
  {:else if name === 'circle-help'}
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9a2.6 2.6 0 1 1 3.4 2.5c-.7.3-1 1-1 1.7M12 17h.01" />
  {:else if name === 'check'}
    <path d="m5 12 4 4L19 6" />
  {:else if name === 'x'}
    <path d="m6 6 12 12M18 6 6 18" />
  {:else if name === 'plus'}
    <path d="M12 5v14M5 12h14" />
  {:else if name === 'download'}
    <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />
  {:else if name === 'upload'}
    <path d="M12 16V4m0 0L8 8m4-4 4 4M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
  {:else if name === 'more-vertical'}
    <circle cx="12" cy="5" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
  {:else}
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4M12 16h.01" />
  {/if}
</svg>
