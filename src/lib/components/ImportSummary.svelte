<script lang="ts">
  import type { ImportSummary } from '$lib/server/imports/importer';

  let { summary, title }: { summary: ImportSummary; title: string } = $props();

  const columns = $derived(summary.preview.length > 0 ? Object.keys(summary.preview[0]).slice(0, 5) : []);

  function displayName(value: string): string {
    return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function displayValue(value: string | number | null): string {
    return value === null || value === '' ? 'Missing' : String(value);
  }
</script>

<section class="mt-4" aria-label={title}>
  {#if summary.preview.length > 0}
    <div class="overflow-x-auto rounded-xl border border-[#eae4f2]">
      <table class="w-full min-w-[520px] border-collapse text-left text-[9px]">
        <thead class="bg-[#f8f4ff] font-bold text-[#433c4b]">
          <tr>
            {#each columns as column}
              <th class="px-3 py-2 font-bold">{displayName(column)}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each summary.preview as row}
            <tr class="border-t border-[#eae4f2]">
              {#each columns as column}
                <td class:missing={row[column] === null || row[column] === ''} class="max-w-36 truncate px-3 py-2.5">
                  {displayValue(row[column])}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="mt-3 grid grid-cols-3 gap-3">
    <div class="rounded-lg bg-[#ecfbf3] p-3">
      <span class="text-[9px] text-[#268d5c]">Accepted</span>
      <b class="mt-1 block text-[18px]">{summary.acceptedRows.toLocaleString('en')}</b>
    </div>
    <div class="rounded-lg bg-[#fff0f0] p-3">
      <span class="text-[9px] text-[#c74047]">Rejected</span>
      <b class="mt-1 block text-[18px]">{summary.rejectedRows.toLocaleString('en')}</b>
    </div>
    <div class="rounded-lg bg-[#f8f4ff] p-3">
      <span class="text-[9px] text-[#7542dd]">Total rows</span>
      <b class="mt-1 block text-[18px]">{summary.totalRows.toLocaleString('en')}</b>
    </div>
  </div>

  {#if summary.errors.length > 0}
    <div class="mt-3 rounded-xl border border-[#ffd9db] bg-[#fff8f8] p-3" role="alert">
      <div class="flex items-center gap-2 text-[10px] font-bold text-[#b9333a]">
        <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" stroke="currentColor" stroke-width="1.9" aria-hidden="true">
          <path d="M12 8v5m0 3.5v.01M10.3 4.5 3.2 17a2 2 0 0 0 1.74 3h14.12a2 2 0 0 0 1.74-3L13.7 4.5a2 2 0 0 0-3.4 0Z" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        File rejected — no rows were imported
      </div>
      <ul class="mt-2 max-h-28 space-y-1 overflow-y-auto pr-1 text-[9px] leading-4 text-[#8f3036]">
        {#each summary.errors as error}
          <li>
            <b>{error.row > 0 ? `Row ${error.row}` : 'File'}{error.field ? ` · ${displayName(error.field)}` : ''}:</b>
            {error.message}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

<style>
  .missing {
    color: #e14f55;
  }
</style>
