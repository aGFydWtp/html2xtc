<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { authStore } from "../lib/auth.svelte";
  import { closeRegistrationDialog, registrationDialog } from "../lib/authDialogs.svelte";
  import { t } from "../lib/i18n.svelte";

  let dlg = $state<HTMLDialogElement | null>(null);
  let displayName = $state("");

  const isAddMode = $derived(registrationDialog.inviteToken === null);

  $effect(() => {
    if (!dlg) return;
    if (registrationDialog.open) {
      if (!dlg.open) {
        displayName = "";
        authStore.errorCode = null;
        dlg.showModal();
      }
    } else if (dlg.open) {
      dlg.close();
    }
  });

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) closeRegistrationDialog();
  }

  async function onSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const ok = isAddMode
      ? await authStore.addPasskey()
      : await authStore.register(registrationDialog.inviteToken ?? undefined, displayName.trim());
    if (ok) closeRegistrationDialog();
  }
</script>

<dialog
  class="simple-dialog"
  bind:this={dlg}
  aria-labelledby="reg-dialog-title"
  onclick={onDialogClick}
  onclose={() => closeRegistrationDialog()}
>
  <div class="dlg-head">
    <span class="dlg-title" id="reg-dialog-title">{isAddMode ? t("account_add_passkey") : t("register_dialog_title")}</span>
    <button type="button" class="dlg-x" aria-label={t("cancel")} onclick={() => closeRegistrationDialog()}>×</button>
  </div>
  <form onsubmit={(e) => void onSubmit(e)}>
    <div class="dlg-body">
      {#if isAddMode}
        <p class="reg-intro">{t("account_add_passkey_intro")}</p>
      {:else}
        <label class="field">
          <span>{t("register_display_name_label")}</span>
          <input type="text" bind:value={displayName} required maxlength="100" placeholder={t("register_display_name_placeholder")} />
        </label>
      {/if}
      {#if authStore.errorCode}<div class="error-text">{t("register_failed")}</div>{/if}
    </div>
    <div class="dlg-actions">
      <button type="button" class="dlg-cancel" onclick={() => closeRegistrationDialog()}>{t("cancel")}</button>
      <button type="submit" class="dlg-submit" disabled={authStore.busy || (!isAddMode && !displayName.trim())}>{t("register_submit")}</button>
    </div>
  </form>
</dialog>

<style>
  .reg-intro { margin: 0; color: var(--muted2); font-size: 14px; line-height: 1.7; }
</style>
