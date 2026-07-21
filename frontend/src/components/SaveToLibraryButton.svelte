<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- 自動保存（convert.svelte.ts の maybeAutoSave）の状態をテキストで表示する。
     手動保存の導線は History.svelte の行メニュー側に残っている。 -->
<script lang="ts">
  import { authStore } from "../lib/auth.svelte";
  import { t } from "../lib/i18n.svelte";
  import { libraryStore } from "../lib/library.svelte";

  interface Props {
    jobId: string;
  }
  const { jobId }: Props = $props();
</script>

{#if authStore.account}
  {#if libraryStore.isSavedJob(jobId)}
    <span class="saved-text">{t("library_saved_inline")}</span>
  {:else if libraryStore.isSavingJob(jobId)}
    <span class="saved-text">{t("library_saving_inline")}</span>
  {:else if libraryStore.isSaveFailedJob(jobId)}
    <span class="save-fail">{t("library_save_failed")}</span>
  {/if}
{/if}

<style>
  .save-fail { color: var(--error); font-size: 13px; }
  .saved-text { color: var(--faint); font-size: 14px; }
</style>
