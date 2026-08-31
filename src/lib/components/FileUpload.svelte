<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';

  let {
    id,
    title,
    description,
    action,
    buttonLabel
  }: {
    id: string;
    title: string;
    description: string;
    action: string;
    buttonLabel: string;
  } = $props();

  let fileName = $state('No file selected');
  let submitting = $state(false);

  const handleSubmit: SubmitFunction = () => {
    submitting = true;
    return async ({ update }) => {
      try {
        await update();
      } finally {
        submitting = false;
      }
    };
  };

  function chooseFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    fileName = input.files?.[0]?.name ?? 'No file selected';
  }
</script>

<form method="POST" action={action} enctype="multipart/form-data" use:enhance={handleSubmit} aria-busy={submitting}>
  <label for={id} class="upload-zone flex min-h-[210px] cursor-pointer flex-col items-center justify-center px-5 text-center">
    <span class="grid h-12 w-12 place-items-center rounded-full bg-[#f1e9ff] text-[#7542dd]">
      <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M12 16V4m0 0L8 8m4-4 4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>
    <b class="mt-3 text-[12px]">{title}</b>
    <span class="mt-1 text-[9px] text-[#716b7b]">{description}</span>
    <span class="btn btn-secondary mt-4">Select File</span>
    <input
      id={id}
      name="file"
      type="file"
      accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      required
      class="sr-only"
      onchange={chooseFile}
    />
  </label>

  <div class="upload-file-row mt-3 flex min-h-11 items-center gap-3 rounded-lg border border-[#eae4f2] px-3 py-2.5">
    <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5 shrink-0 text-[#2aa96b]" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d="M7 3h7l4 4v14H7V3Zm7 0v4h4M10 12h5m-5 4h5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span class="min-w-0">
      <b class="block truncate text-[10px]">{fileName}</b>
      <span class="text-[8px] text-[#716b7b]">CSV or XLSX · up to 5 MB · max 5,000 rows</span>
    </span>
    <button type="submit" class="btn btn-primary ml-auto shrink-0" disabled={submitting}>
      {submitting ? 'Validating…' : buttonLabel}
    </button>
  </div>
</form>

<style>
  @media (max-width: 520px) {
    .upload-file-row {
      align-items: stretch;
      flex-wrap: wrap;
    }

    .upload-file-row .btn {
      width: 100%;
      margin-left: 0;
    }
  }
</style>
