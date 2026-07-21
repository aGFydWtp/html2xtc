<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { authStore } from "../lib/auth.svelte";
  import { closeLoginDialog, loginDialog } from "../lib/authDialogs.svelte";
  import { t } from "../lib/i18n.svelte";

  let dlg = $state<HTMLDialogElement | null>(null);

  // open 状態とネイティブ <dialog> の開閉を同期する（AozoraDialog と同じパターン）。
  $effect(() => {
    if (!dlg) return;
    if (loginDialog.open) {
      if (!dlg.open) {
        authStore.errorCode = null;
        dlg.showModal();
      }
    } else if (dlg.open) {
      dlg.close();
    }
  });

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) closeLoginDialog(); // ::backdrop 領域のクリック
  }

  async function onLogin(): Promise<void> {
    const ok = await authStore.login();
    if (ok) closeLoginDialog();
  }
</script>

<dialog
  class="simple-dialog"
  bind:this={dlg}
  aria-labelledby="login-dialog-title"
  onclick={onDialogClick}
  onclose={() => closeLoginDialog()}
>
  <div class="dlg-head">
    <span class="dlg-title" id="login-dialog-title">{t("login_dialog_title")}</span>
    <button type="button" class="dlg-x" aria-label={t("cancel")} onclick={() => closeLoginDialog()}>×</button>
  </div>
  <div class="dlg-body">
    <p class="login-intro">{t("login_dialog_intro")}</p>
    {#if authStore.errorCode}<div class="error-text">{t("login_failed")}</div>{/if}
  </div>
  <div class="dlg-actions">
    <button type="button" class="dlg-cancel" onclick={() => closeLoginDialog()}>{t("cancel")}</button>
    <button type="button" class="dlg-submit" disabled={authStore.busy} onclick={() => void onLogin()}>{t("login_button")}</button>
  </div>
</dialog>

<style>
  .login-intro { margin: 0; color: var(--muted2); font-size: 14px; line-height: 1.7; }
</style>
