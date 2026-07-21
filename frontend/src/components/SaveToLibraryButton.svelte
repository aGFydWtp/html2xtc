<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { authStore } from "../lib/auth.svelte";
  import { t } from "../lib/i18n.svelte";
  import { libraryStore } from "../lib/library.svelte";

  interface Props {
    jobId: string;
    title?: string;
  }
  const { jobId, title }: Props = $props();

  let busy = $state(false);
  let failed = $state(false);

  async function save(): Promise<void> {
    if (busy || libraryStore.isSavedJob(jobId)) return;
    busy = true;
    failed = false;
    const ok = await libraryStore.saveFromJob(jobId, title);
    busy = false;
    if (!ok) failed = true;
  }
</script>

{#if authStore.account}
  {#if libraryStore.isSavedJob(jobId)}
    <span class="saved-text">{t("library_saved_inline")}</span>
  {:else}
    <button
      type="button"
      class="save-btn"
      disabled={busy}
      onclick={() => void save()}
    >{busy ? t("library_saving") : t("library_save")}</button>
    {#if failed}<span class="save-fail">{t("library_save_failed")}</span>{/if}
  {/if}
{/if}

<style>
  button.save-btn {
    padding: 9px 20px; border-radius: 4px; font: inherit; font-weight: 700; cursor: pointer;
    border: 1.5px solid var(--ink); background: none; color: var(--ink);
  }
  button.save-btn:hover:not(:disabled) { opacity: .7; }
  button.save-btn:disabled { border-color: var(--disabled); color: var(--disabled); cursor: default; opacity: 1; }
  .save-fail { color: var(--error); font-size: 13px; }
  .saved-text { color: var(--faint); font-size: 14px; }
</style>
