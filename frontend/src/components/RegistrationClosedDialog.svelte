<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // 登録モード仕様 Phase3 §5: ?register=<token> でアクセスしたが
  // REGISTRATION_MODE==="closed" だった場合の案内ダイアログ。登録ダイアログ
  // (PasskeyRegistrationDialog)を一切開かず、代わりにこれを開く。
  import { closeRegistrationClosedNotice, openLoginDialog, registrationClosedNotice } from "../lib/authDialogs.svelte";
  import { t } from "../lib/i18n.svelte";

  let dlg = $state<HTMLDialogElement | null>(null);

  // open 状態とネイティブ <dialog> の開閉を同期する（PasskeyLoginDialog と同じパターン）。
  $effect(() => {
    if (!dlg) return;
    if (registrationClosedNotice.open) {
      if (!dlg.open) dlg.showModal();
    } else if (dlg.open) {
      dlg.close();
    }
  });

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) closeRegistrationClosedNotice(); // ::backdrop 領域のクリック
  }

  function onLoginClick(): void {
    closeRegistrationClosedNotice();
    openLoginDialog();
  }
</script>

<dialog
  class="simple-dialog"
  bind:this={dlg}
  aria-labelledby="registration-closed-dialog-title"
  onclick={onDialogClick}
  onclose={() => closeRegistrationClosedNotice()}
>
  <div class="dlg-head">
    <span class="dlg-title" id="registration-closed-dialog-title">{t("register_closed_title")}</span>
    <button type="button" class="dlg-x" aria-label={t("register_closed_close")} onclick={() => closeRegistrationClosedNotice()}>×</button>
  </div>
  <div class="dlg-body">
    <p class="closed-body">{t("register_closed_body")}</p>
  </div>
  <div class="dlg-actions">
    <button type="button" class="dlg-cancel" onclick={() => closeRegistrationClosedNotice()}>{t("register_closed_close")}</button>
    <button type="button" class="dlg-submit" onclick={onLoginClick}>{t("register_closed_login")}</button>
  </div>
</dialog>

<style>
  .closed-body { margin: 0; color: var(--muted2); font-size: 14px; line-height: 1.7; }
</style>
