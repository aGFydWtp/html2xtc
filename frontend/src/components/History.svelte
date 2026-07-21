<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount, tick } from "svelte";
  import { authStore } from "../lib/auth.svelte";
  import { markJobExpired } from "../lib/convert.svelte";
  import { statusLabel, t } from "../lib/i18n.svelte";
  import { effectiveStatus, formatDate, jobsStore } from "../lib/jobs.svelte";
  import { libraryStore } from "../lib/library.svelte";
  import { openPreview, previewBroken } from "../lib/preview.svelte";

  // 全行で共有する操作メニュー（ポップオーバー）1 個。
  // Popover API 非対応ブラウザ（Chrome <114, Safari <17, Firefox <125）は
  // クラス切替のフォールバック: 同じ fixed 配置のメニューを、light dismiss の
  // 代わりに自前の外側クリック / Escape リスナーで閉じる。
  const POPOVER_OK = typeof HTMLElement.prototype.showPopover === "function";
  const MENU_TOGGLE_MS = 300; // 同じジョブでの close → ⋮ クリックがこの時間内ならトグル扱い

  let menuEl = $state<HTMLDivElement | null>(null);
  let menuJobId = $state<string | null>(null); // 開いているメニューが指すジョブ
  let fallbackOpen = $state(false); // フォールバック時の表示状態
  let menuClosedAt = 0; // light dismiss は ⋮ の click より先に発火するので、直前の
  let menuClosedJob: string | null = null; // close を覚えて 2 回目の ⋮ クリックをトグルにする

  const menuJob = $derived(menuJobId === null ? undefined : jobsStore.list.find((j) => j.jobId === menuJobId));
  const menuDone = $derived(!!menuJob && effectiveStatus(menuJob) === "completed");

  function jobMenuOpen(): boolean {
    if (!menuEl) return false;
    return POPOVER_OK ? menuEl.matches(":popover-open") : fallbackOpen;
  }
  function hideJobMenu(): void {
    if (!menuEl) return;
    if (POPOVER_OK) {
      if (menuEl.matches(":popover-open")) menuEl.hidePopover(); // toggle イベントが menuJobId をリセットする
      return;
    }
    fallbackOpen = false;
    menuJobId = null;
  }
  async function openJobMenu(btn: HTMLElement, jobId: string): Promise<void> {
    if (jobMenuOpen() && menuJobId === jobId) { hideJobMenu(); return; } // フォールバックのトグル（light dismiss なし）
    if (menuClosedJob === jobId && Date.now() - menuClosedAt < MENU_TOGGLE_MS) { menuClosedJob = null; return; }
    menuJobId = jobId;
    await tick(); // メニュー項目の disabled を DOM に反映してから表示・採寸する
    if (!menuEl) return;
    if (POPOVER_OK) {
      menuEl.showPopover();
    } else {
      fallbackOpen = true;
      await tick(); // display:block 反映後に offsetWidth/offsetHeight を測る
    }
    const r = btn.getBoundingClientRect();
    menuEl.style.left = `${Math.max(8, Math.min(r.right - menuEl.offsetWidth, window.innerWidth - menuEl.offsetWidth - 8))}px`;
    menuEl.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menuEl.offsetHeight - 8)}px`;
  }
  function onMenuToggle(event: Event): void {
    if ((event as ToggleEvent).newState === "closed") {
      menuClosedAt = Date.now();
      menuClosedJob = menuJobId;
      menuJobId = null;
    }
  }

  onMount(() => {
    if (POPOVER_OK) return;
    const onDocClick = (event: MouseEvent) => {
      if (!jobMenuOpen()) return;
      const target = event.target as Element | null;
      if (target && (menuEl?.contains(target) || target.closest(".more-btn"))) return;
      hideJobMenu();
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideJobMenu();
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeydown);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeydown);
    };
  });

  // 期限切れの成果物へ遷移して生の 404 JSON を見せないよう、ジョブの存在を確認して
  // からダウンロードへナビゲートする（404 ならエントリを expired に切り替える）。
  async function menuDownload(): Promise<void> {
    const jobId = menuJobId;
    hideJobMenu();
    if (!jobId) return;
    try {
      const res = await fetch(`/jobs/${encodeURIComponent(jobId)}`);
      if (res.status === 404) { markJobExpired(jobId); return; }
    } catch { /* そのままダウンロードを試みる */ }
    window.location.href = `/jobs/${encodeURIComponent(jobId)}/download`;
  }
  function menuPreview(): void {
    const jobId = menuJobId;
    hideJobMenu();
    if (jobId) void openPreview(jobId);
  }

  let savingMenuJob = $state(false);

  async function menuSaveToLibrary(): Promise<void> {
    const jobId = menuJobId;
    if (!jobId || savingMenuJob || libraryStore.isSavedJob(jobId)) return;
    const job = jobsStore.list.find((j) => j.jobId === jobId);
    savingMenuJob = true;
    await libraryStore.saveFromJob(jobId, job?.title);
    savingMenuJob = false;
  }

  function clearAll(): void {
    if (confirm(t("confirm_clear"))) jobsStore.clear();
  }
</script>

{#if jobsStore.list.length}
  <section class="history">
    <div class="history-head">
      <h2>{t("history")}</h2>
      <button type="button" onclick={clearAll}>{t("clear_all")}</button>
    </div>
    <ul class="jobs">
      {#each jobsStore.list as j (j.jobId)}
        {@const status = effectiveStatus(j)}
        {@const done = status === "completed"}
        <li>
          <div class="info">
            <div class="job-title" class:dim={!done}>
              {#if j.sourceType === "pdf"}<span class="src-badge">PDF</span>{:else if j.sourceType === "txt"}<span class="src-badge">TXT</span>{/if}
              {j.title || j.sourceLabel}
            </div>
            <div class="date">{formatDate(j.createdAt ?? "")}{done ? "" : ` · ${statusLabel(status)}`}</div>
          </div>
          <button
            type="button"
            class="more-btn"
            aria-haspopup="true"
            aria-label={t("menu_label")}
            onclick={(event) => void openJobMenu(event.currentTarget, j.jobId)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5.5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="18.5" r="1.7" /></svg>
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<footer class="site">
  <a href="/about">{t("about_link")}</a><br />
  <span>{t("copyright_line")}</span>
</footer>

<div
  class="job-menu"
  class:open={fallbackOpen}
  role="menu"
  popover="auto"
  bind:this={menuEl}
  ontoggle={onMenuToggle}
>
  <button type="button" role="menuitem" disabled={!menuDone} onclick={() => void menuDownload()}>{t("menu_dl")}</button>
  <button type="button" role="menuitem" disabled={!menuDone || (menuJobId !== null && previewBroken.has(menuJobId))} onclick={menuPreview}>{t("menu_preview")}</button>
  {#if authStore.account}
    <button
      type="button"
      role="menuitem"
      disabled={!menuDone || savingMenuJob || (menuJobId !== null && libraryStore.isSavedJob(menuJobId))}
      onclick={() => void menuSaveToLibrary()}
    >{menuJobId !== null && libraryStore.isSavedJob(menuJobId) ? t("library_saved") : t("library_save")}</button>
  {/if}
</div>

<style>
  section.history { padding-top: 26px; }
  .history-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
  .history-head h2 { font-size: 18px; font-weight: 600; letter-spacing: .08em; margin: 0; }
  .history-head button {
    border: 0; background: none; color: var(--muted); font: inherit; font-size: 14px;
    cursor: pointer; text-decoration: underline; padding: 12px 4px; margin: -12px -4px;
  }
  ul.jobs { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; }
  ul.jobs li { display: flex; align-items: center; gap: 14px; padding: 12px 0; border-top: 1px solid var(--line); }
  ul.jobs li:last-child { border-bottom: 1px solid var(--line); }
  ul.jobs .info { flex: 1; min-width: 0; }
  ul.jobs .job-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ul.jobs .job-title.dim { color: var(--faint); }
  .src-badge {
    font-family: var(--mono); font-size: 11px; font-weight: 600; padding: 1px 6px;
    background: var(--panel); color: #4d4a42; border-radius: 4px; margin-right: 6px;
  }
  ul.jobs .date { font-family: var(--mono); font-size: 14px; color: var(--faint); }
  .more-btn {
    border: 0; background: none; color: var(--muted2); cursor: pointer;
    display: flex; align-items: center; padding: 10px; margin: -10px -6px; border-radius: 4px;
  }
  .more-btn:hover { background: var(--panel); color: var(--text); }
  .job-menu {
    position: fixed; display: none; margin: 0; padding: 6px; min-width: 180px;
    border: 1px solid var(--line); border-radius: 4px; background: var(--card);
    box-shadow: 0 4px 16px rgba(28, 26, 23, .16);
  }
  /* この 2 つのルールは分けたままにする: Popover API 非対応ブラウザでは、セレクタ
     リスト中の未知の :popover-open がリスト全体を無効にしてしまうため。 */
  .job-menu:popover-open { display: block; }
  .job-menu.open { display: block; }
  .job-menu button {
    display: block; width: 100%; text-align: left; padding: 8px 12px;
    font: inherit; font-size: 14px; border: 0; border-radius: 3px;
    background: none; color: var(--text); cursor: pointer; white-space: nowrap;
  }
  .job-menu button:hover:not(:disabled) { background: var(--panel); }
  .job-menu button:disabled { color: var(--disabled); cursor: default; }
  footer.site {
    margin-top: 26px; padding-top: 16px;
    font-size: 14px; color: var(--muted); line-height: 1.8;
  }
  footer.site a { color: var(--muted2); }
</style>
