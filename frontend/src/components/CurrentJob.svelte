<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { current } from "../lib/convert.svelte";
  import { noteText, serverErrorText, statusLabel, t } from "../lib/i18n.svelte";
  import { IN_FLIGHT } from "../lib/jobs.svelte";
  import { openPreview, previewBroken } from "../lib/preview.svelte";
  import SaveToLibraryButton from "./SaveToLibraryButton.svelte";
</script>

{#if current.entries.length}
  <div class="current">
    {#each current.entries as entry (entry.key)}
      {@const job = entry.job}
      {@const busy = !entry.note && IN_FLIGHT.includes(job.status)}
      <div class="job-row">
        {#if job.title}<div class="title-line">{job.title}</div>{/if}
        {#if job.url}<div class="url-line">{job.url}</div>{/if}
        <div class="status-line">
          {#if busy}<span class="spinner"></span>{/if}
          <span class="badge" class:err={job.status === "failed" || job.status === "expired"}>{statusLabel(job.status)}</span>
          {#if job.status === "completed"}
            <a class="dl" href="/jobs/{encodeURIComponent(job.jobId)}/download">{t("dl")}</a>
            <button
              type="button"
              class="preview-btn"
              disabled={previewBroken.has(job.jobId)}
              onclick={() => void openPreview(job.jobId)}
            >{t("preview")}</button>
            <SaveToLibraryButton jobId={job.jobId} title={job.title} />
          {/if}
        </div>
        {#if entry.note}<div class="error-text">{noteText(entry.note)}</div>{/if}
        {#if job.status === "failed" && job.error}<div class="error-text">{serverErrorText(job.error)}</div>{/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .current { border-bottom: 1px solid var(--line); }
  /* 1 件時は旧 .current（padding: 22px 0）と同じ見え方。複数件は行間に区切り線。 */
  .job-row { padding: 22px 0; }
  .job-row + .job-row { border-top: 1px solid var(--line); }
  .title-line { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .url-line {
    font-family: var(--mono); font-size: 14px; color: var(--faint);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px;
  }
  .status-line { display: flex; align-items: center; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
  a.dl {
    display: inline-block; padding: 9px 20px; border-radius: 4px;
    background: var(--ink); color: var(--ink-text); font-weight: 700; text-decoration: none;
  }
  a.dl:hover { color: var(--ink-text); opacity: .88; }
  button.preview-btn {
    padding: 9px 20px; border-radius: 4px; font: inherit; font-weight: 700; cursor: pointer;
    border: 1.5px solid var(--ink); background: none; color: var(--ink);
  }
  button.preview-btn:hover { opacity: .7; }
  button.preview-btn:disabled { border-color: var(--disabled); color: var(--disabled); cursor: default; opacity: 1; }
</style>
