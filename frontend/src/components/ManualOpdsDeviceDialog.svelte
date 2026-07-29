<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // 標準 OPDS 端末の手動登録ダイアログ（OPDS Phase 2 §10.2）。
  // PairingApprovalDialog と同じ「共有 state + $effect で showModal()/close() を
  // 同期する」パターンを踏襲する。成功したら自分を閉じ、接続情報ダイアログ
  // （OpdsCredentialsDialog）を新しい token 付きで開く。
  import {
    closeManualOpdsDeviceDialog,
    manualOpdsDeviceDialog,
    openOpdsCredentialsDialog,
  } from "../lib/authDialogs.svelte";
  import { devicesStore, type CreateManualOpdsDeviceInput } from "../lib/devices.svelte";
  import { t } from "../lib/i18n.svelte";

  type DeviceModel = "x3" | "x4";

  let dlg = $state<HTMLDialogElement | null>(null);
  let name = $state("");
  let model = $state<DeviceModel>("x3");
  let busy = $state(false);
  let errorCode = $state<string | null>(null);

  $effect(() => {
    if (!dlg) return;
    if (manualOpdsDeviceDialog.open) {
      if (!dlg.open) {
        name = "";
        model = "x3";
        busy = false;
        errorCode = null;
        dlg.showModal();
      }
    } else if (dlg.open) {
      dlg.close();
    }
  });

  const canSubmit = $derived(name.trim().length > 0);

  function errorText(code: string | null): string {
    switch (code) {
      case "INVALID_DEVICE_NAME": return t("devices_manual_error_name");
      case "INVALID_DEVICE_MODEL": return t("devices_manual_error_model");
      case "INVALID_DEVICE_RESOLUTION": return t("devices_manual_error_resolution");
      case "DEVICE_LIMIT_EXCEEDED": return t("devices_manual_error_limit");
      case "UNAUTHORIZED": return t("devices_manual_error_unauthorized");
      case "CSRF_REJECTED": return t("devices_manual_error_csrf");
      default: return t("devices_manual_error_generic");
    }
  }

  async function onSubmit(): Promise<void> {
    if (!canSubmit || busy) return;
    busy = true;
    errorCode = null;
    const input: CreateManualOpdsDeviceInput = { name: name.trim(), deviceModel: model };
    const result = await devicesStore.createManualOpdsDevice(input);
    busy = false;
    if (result.ok) {
      closeManualOpdsDeviceDialog();
      openOpdsCredentialsDialog(result.device.name, result.opds);
    } else {
      errorCode = result.code;
    }
  }

  function onClose(): void {
    closeManualOpdsDeviceDialog();
  }

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) onClose();
  }
</script>

<dialog
  class="simple-dialog"
  bind:this={dlg}
  aria-labelledby="manual-opds-dialog-title"
  onclick={onDialogClick}
  onclose={onClose}
>
  <div class="dlg-head">
    <span class="dlg-title" id="manual-opds-dialog-title">{t("devices_manual_dialog_title")}</span>
    <button type="button" class="dlg-x" aria-label={t("cancel")} onclick={onClose}>×</button>
  </div>
  <div class="dlg-body">
    <label class="field">
      <span>{t("devices_manual_name_label")}</span>
      <input type="text" bind:value={name} required maxlength="100" />
    </label>
    <div class="field">
      <span>{t("devices_manual_model_label")}</span>
      <div class="model-options">
        <label class="radio"><input type="radio" name="manual-device-model" value="x3" bind:group={model} />{t("devices_manual_model_x3")}</label>
        <label class="radio"><input type="radio" name="manual-device-model" value="x4" bind:group={model} />{t("devices_manual_model_x4")}</label>
      </div>
    </div>
    {#if errorCode}<p class="error-text">{errorText(errorCode)}</p>{/if}
  </div>
  <div class="dlg-actions">
    <button type="button" class="dlg-cancel" onclick={onClose}>{t("cancel")}</button>
    <button type="button" class="dlg-submit" disabled={!canSubmit || busy} onclick={() => void onSubmit()}>{t("devices_manual_submit")}</button>
  </div>
</dialog>

<style>
  .model-options { display: flex; flex-wrap: wrap; gap: 6px 18px; }
  .radio { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--text); cursor: pointer; }
  .radio input { accent-color: var(--ink); cursor: pointer; }
</style>
