<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // Memlane接続の新規登録・置換ダイアログ（仕様書 §8.3, §8.6「更新」）。
  // 汎用OPDS基盤の上に立つMemlane専用UI文言だが、内部は opdsStore（汎用OPDS
  // ストア）をそのまま使う（仕様書 §28）。
  import { t } from "../lib/i18n.svelte";
  import { opdsStore } from "../lib/opds.svelte";

  let dlg = $state<HTMLDialogElement | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let url = $state("");

  // AozoraDialog と同じパターン: open状態とネイティブ<dialog>の開閉を同期する。
  //
  // このURLはpath 1セグメントが認証情報そのもの（実質パスワード）であるため、
  // ダイアログが閉じるすべての経路（キャンセル、backdropクリック、Esc、
  // 接続失敗後の離脱、ログアウト/アカウント切替による opdsStore.reset()）で
  // 入力stateを確実にクリアする。このコンポーネントは App.svelte で無条件に
  // マウントされ続けるため、opdsStore.connectDialogOpen を監視するこの
  // $effect がすべての close 経路をカバーする単一の掃除口になる。
  $effect(() => {
    if (!dlg) return;
    if (opdsStore.connectDialogOpen) {
      if (!dlg.open) {
        dlg.showModal();
        input?.focus();
      }
    } else if (dlg.open) {
      dlg.close();
      url = "";
    }
  });

  function close(): void {
    opdsStore.closeConnectDialog();
  }

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) close(); // ::backdrop 領域のクリック
  }

  const errorText = $derived.by(() => {
    const key = opdsStore.connectErrorKey;
    return key ? t(key) : null;
  });

  async function onSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (opdsStore.connectBusy) return;
    // 成功時は store が connectDialogOpen を false にし、上の $effect が
    // ダイアログを閉じると同時に url をクリアする。失敗時はダイアログを
    // 開いたままにしてエラーを表示するため、ここでは何もクリアしない
    // （ユーザーはURLを修正して再送信できる）。
    await opdsStore.submitConnect(url);
  }
</script>

<dialog
  class="memlane-dialog"
  bind:this={dlg}
  aria-labelledby="memlane-connect-title"
  onclick={onDialogClick}
  onclose={close}
>
  <div class="dlg-head">
    <span class="dlg-title" id="memlane-connect-title">{t("memlane_connect_title")}</span>
    <button type="button" class="dlg-x" aria-label={t("cancel")} onclick={close}>×</button>
  </div>

  <form class="dlg-body" onsubmit={(e) => void onSubmit(e)}>
    <p class="dlg-description">{t("memlane_connect_description")}</p>

    <label class="dlg-label" for="memlane-url">{t("memlane_url_label")}</label>
    <!-- svelte-ignore a11y_autofocus 開いた直後の $effect でフォーカスするため autofocus は使わない -->
    <input
      id="memlane-url"
      bind:this={input}
      bind:value={url}
      type="url"
      required
      autocomplete="off"
      autocapitalize="none"
      spellcheck="false"
      disabled={opdsStore.connectBusy}
    />

    {#if errorText}<div class="error-text">{errorText}</div>{/if}

    <div class="dlg-actions">
      <button type="button" class="dlg-cancel" onclick={close}>{t("cancel")}</button>
      <button type="submit" class="dlg-connect" disabled={opdsStore.connectBusy || !url.trim()}>
        {opdsStore.connectBusy ? t("memlane_connecting") : t("memlane_connect")}
      </button>
    </div>
  </form>
</dialog>

<style>
  dialog.memlane-dialog {
    padding: 0; border: 1.5px solid var(--ink); border-radius: 4px;
    background: var(--bg); color: var(--text);
    width: min(480px, calc(100vw - 32px));
    max-height: calc(100vh - 96px);
    max-height: calc(100dvh - 96px);
    box-shadow: 4px 4px 0 rgba(var(--ink-rgb), .35);
  }
  dialog.memlane-dialog[open] { display: flex; flex-direction: column; }
  dialog.memlane-dialog::backdrop { background: rgba(var(--ink-rgb), .45); }
  .dlg-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 16px 22px; border-bottom: 1px solid var(--line); flex: none;
  }
  .dlg-title { font-size: 16px; font-weight: 700; letter-spacing: .04em; }
  .dlg-x {
    width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--line-strong); border-radius: 4px; background: none; color: var(--muted);
    font-size: 14px; line-height: 1; cursor: pointer; font-family: inherit;
  }
  .dlg-x:hover { color: var(--text); }
  .dlg-body { padding: 20px 22px 16px; display: flex; flex-direction: column; gap: 10px; }
  .dlg-description { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.7; }
  .dlg-label { font-size: 13px; font-weight: 600; color: var(--muted2); }
  input[type="url"] {
    padding: 11px 14px; font: inherit; font-size: 15px; border: 1.5px solid var(--ink);
    border-radius: 4px; background: var(--card); color: var(--text);
  }
  input[type="url"]:focus { outline: 2px solid var(--ink); outline-offset: 1px; }
  input[type="url"]:disabled { opacity: .6; }
  .error-text { font-size: 13px; color: var(--error); }
  .dlg-actions { display: flex; align-items: center; justify-content: flex-end; gap: 16px; margin-top: 8px; }
  .dlg-cancel {
    border: 0; background: none; font: inherit; font-size: 14px; color: var(--muted);
    text-decoration: underline; cursor: pointer; padding: 0;
  }
  .dlg-connect {
    padding: 10px 24px; font: inherit; font-size: 14px; font-weight: 700; letter-spacing: .08em;
    border: 0; border-radius: 4px; background: var(--ink); color: var(--ink-text); cursor: pointer;
    white-space: nowrap;
  }
  .dlg-connect:disabled { opacity: .55; cursor: default; }
</style>
