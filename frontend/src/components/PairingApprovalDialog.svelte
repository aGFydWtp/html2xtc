<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { authStore } from "../lib/auth.svelte";
  import { closePairingDialog, openLoginDialog, pairingDialog } from "../lib/authDialogs.svelte";
  import { devicesStore, type PairingLookup } from "../lib/devices.svelte";
  import { t } from "../lib/i18n.svelte";

  let dlg = $state<HTMLDialogElement | null>(null);
  let lookup = $state<PairingLookup | null>(null);
  let lookupState = $state<"idle" | "loading" | "found" | "not_found">("idle");
  let name = $state("");
  let busy = $state(false);
  let actionFailed = $state(false);

  async function runLookup(): Promise<void> {
    const code = pairingDialog.code;
    if (!code) return;
    lookupState = "loading";
    const result = await devicesStore.lookupPairing(code);
    if (result) {
      lookup = result;
      name = result.requestedName ?? "";
      lookupState = "found";
    } else {
      lookup = null;
      lookupState = "not_found";
    }
  }

  $effect(() => {
    if (!dlg) return;
    if (pairingDialog.open) {
      if (!dlg.open) {
        actionFailed = false;
        dlg.showModal();
      }
    } else if (dlg.open) {
      dlg.close();
    }
  });

  // ダイアログが開いていてログイン済み・未照会なら照会する（ログイン完了直後も含む）。
  $effect(() => {
    if (pairingDialog.open && authStore.account && lookupState === "idle") {
      void runLookup();
    }
  });

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) onClose();
  }

  function onClose(): void {
    closePairingDialog();
    lookup = null;
    lookupState = "idle";
    name = "";
  }

  async function onApprove(): Promise<void> {
    if (!lookup) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    busy = true;
    actionFailed = false;
    const ok = await devicesStore.approvePairing(lookup.pairingId, trimmed);
    busy = false;
    if (ok) onClose();
    else actionFailed = true;
  }

  async function onReject(): Promise<void> {
    if (!lookup) return;
    busy = true;
    actionFailed = false;
    const ok = await devicesStore.rejectPairing(lookup.pairingId);
    busy = false;
    if (ok) onClose();
    else actionFailed = true;
  }
</script>

<dialog
  class="simple-dialog"
  bind:this={dlg}
  aria-labelledby="pairing-dialog-title"
  onclick={onDialogClick}
  onclose={onClose}
>
  <div class="dlg-head">
    <span class="dlg-title" id="pairing-dialog-title">{t("pairing_dialog_title")}</span>
    <button type="button" class="dlg-x" aria-label={t("cancel")} onclick={onClose}>×</button>
  </div>
  <div class="dlg-body">
    {#if !authStore.account}
      <p class="pairing-note">{t("pairing_login_required")}</p>
    {:else if lookupState === "loading" || lookupState === "idle"}
      <p class="pairing-note">{t("library_loading")}</p>
    {:else if lookupState === "not_found"}
      <p class="error-text">{t("pairing_not_found")}</p>
    {:else if lookup}
      <label class="field">
        <span>{t("pairing_requested_name_label")}</span>
        <input type="text" bind:value={name} required maxlength="100" />
      </label>
    {/if}
    {#if actionFailed}<div class="error-text">{t("pairing_action_failed")}</div>{/if}
  </div>
  {#if !authStore.account}
    <div class="dlg-actions">
      <button type="button" class="dlg-cancel" onclick={onClose}>{t("cancel")}</button>
      <button type="button" class="dlg-submit" onclick={openLoginDialog}>{t("account_login")}</button>
    </div>
  {:else if lookup && lookupState === "found"}
    <div class="dlg-actions">
      <button type="button" class="dlg-cancel" disabled={busy} onclick={() => void onReject()}>{t("pairing_reject")}</button>
      <button type="button" class="dlg-submit" disabled={busy || !name.trim()} onclick={() => void onApprove()}>{t("pairing_approve")}</button>
    </div>
  {/if}
</dialog>

<style>
  .pairing-note { margin: 0; color: var(--muted2); font-size: 14px; line-height: 1.7; }
</style>
