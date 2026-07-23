<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // devices タブの「端末の追加方法」ボタンから開く、登録手順の案内ダイアログ。
  // RegistrationClosedDialog.svelte と同じ「共有 state + $effect で
  // showModal()/close() を同期する」パターンを踏襲する。
  import { closeDevicesHowtoDialog, devicesHowtoDialog } from "../lib/authDialogs.svelte";
  import { t } from "../lib/i18n.svelte";
  import imgMyxtcMenu from "../assets/howto/01-myxtc-menu.webp";
  import imgPairingQr from "../assets/howto/02-pairing-qr.webp";
  import imgPairingApprove from "../assets/howto/03-pairing-approve.webp";
  import imgPairingCompleted from "../assets/howto/04-pairing-completed.webp";
  import imgSaveLibrary from "../assets/howto/05-save-to-library.webp";
  import imgEditLibraryMenu from "../assets/howto/06-edit-library-menu.webp";
  import imgDeviceLibrarySave from "../assets/howto/07-device-library-save.webp";
  import imgDeviceMyxtcList from "../assets/howto/08-device-myxtc-list.webp";

  let dlg = $state<HTMLDialogElement | null>(null);

  $effect(() => {
    if (!dlg) return;
    if (devicesHowtoDialog.open) {
      if (!dlg.open) dlg.showModal();
    } else if (dlg.open) {
      dlg.close();
    }
  });

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) closeDevicesHowtoDialog(); // ::backdrop 領域のクリック
  }

  // Devices.svelte の goToFlasher と同じ遷移方法（App.svelte が popstate で
  // タブ状態を管理しているため、直接の遷移手段がない）。遷移前にダイアログを閉じる。
  function goToFlasher(): void {
    closeDevicesHowtoDialog();
    history.pushState(null, "", "/flasher" + location.search + location.hash);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
</script>

<dialog
  class="simple-dialog wide"
  bind:this={dlg}
  aria-labelledby="devices-howto-dialog-title"
  onclick={onDialogClick}
  onclose={() => closeDevicesHowtoDialog()}
>
  <div class="dlg-head">
    <span class="dlg-title" id="devices-howto-dialog-title">{t("devices_howto_title")}</span>
    <button type="button" class="dlg-x" aria-label={t("register_closed_close")} onclick={() => closeDevicesHowtoDialog()}>×</button>
  </div>
  <div class="dlg-body">
    <h3>{t("devices_howto_step1_heading")}</h3>
    <ol>
      <li>{t("devices_howto_step1_device")}</li>
      <li>{t("devices_howto_step1_firmware")}</li>
      <li>{t("devices_howto_step1_connect")}</li>
      <li>{t("devices_howto_step1_flasher")}</li>
    </ol>
    <button type="button" class="secondary" onclick={goToFlasher}>{t("devices_empty_flash")}</button>
    <h3>{t("devices_howto_step2_heading")}</h3>
    <ol>
      <li>
        {t("devices_howto_step2_menu")}
        <img src={imgMyxtcMenu} alt={t("devices_howto_img_myxtc_menu")} width="563" height="563" loading="lazy" />
      </li>
      <li>
        {t("devices_howto_step2_qr")}
        <img src={imgPairingQr} alt={t("devices_howto_img_pairing_qr")} width="563" height="563" loading="lazy" />
      </li>
      <li>{t("devices_howto_step2_scan")}</li>
      <li>{t("devices_howto_step2_login")}</li>
      <li>
        {t("devices_howto_step2_approve")}
        <img src={imgPairingApprove} alt={t("devices_howto_img_pairing_approve")} width="1000" height="1249" loading="lazy" />
      </li>
      <li>
        {t("devices_howto_step2_completed")}
        <img src={imgPairingCompleted} alt={t("devices_howto_img_pairing_completed")} width="563" height="563" loading="lazy" />
      </li>
      <li>{t("devices_howto_step2_expiry")}</li>
    </ol>
    <h3>{t("devices_howto_step3_heading")}</h3>
    <ol>
      <li>
        {t("devices_howto_step3_save")}
        <img src={imgSaveLibrary} alt={t("devices_howto_img_save_library")} width="1000" height="1250" loading="lazy" />
      </li>
      <li>
        {t("devices_howto_step3_edit_menu")}
        <img src={imgEditLibraryMenu} alt={t("devices_howto_img_edit_library_menu")} width="1000" height="1251" loading="lazy" />
      </li>
      <li>
        {t("devices_howto_step3_check_save")}
        <img src={imgDeviceLibrarySave} alt={t("devices_howto_img_device_library_save")} width="1000" height="1250" loading="lazy" />
      </li>
      <li>
        {t("devices_howto_step3_device_menu")}
        <!-- 端末トップの「マイXTC」画面はステップ2の 01 と同じ画像を使い回す。 -->
        <img src={imgMyxtcMenu} alt={t("devices_howto_img_device_myxtc")} width="563" height="563" loading="lazy" />
      </li>
      <li>
        {t("devices_howto_step3_device_list")}
        <img src={imgDeviceMyxtcList} alt={t("devices_howto_img_device_list")} width="563" height="563" loading="lazy" />
      </li>
    </ol>
  </div>
  <div class="dlg-actions">
    <button type="button" class="dlg-cancel" onclick={() => closeDevicesHowtoDialog()}>{t("register_closed_close")}</button>
  </div>
</dialog>

<style>
  .dlg-body h3 { margin: 0 0 8px; font-size: 14px; }
  .dlg-body h3:not(:first-child) { margin-top: 18px; }
  .dlg-body ol { margin: 0; padding-left: 20px; color: var(--muted2); font-size: 14px; line-height: 1.7; }
  .dlg-body ol li + li { margin-top: 4px; }
  .dlg-body ol img {
    display: block; margin: 8px 0 4px; max-width: 100%; height: auto;
    border: 1px solid var(--line); border-radius: 4px;
  }
  .dlg-body button.secondary {
    margin-top: 18px; padding: 8px 18px; font: inherit; font-size: 14px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  .dlg-body button.secondary:hover { background: var(--panel); }
</style>
