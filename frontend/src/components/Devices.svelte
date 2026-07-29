<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { authStore } from "../lib/auth.svelte";
  import {
    openDevicesHowtoDialog,
    openLoginDialog,
    openManualOpdsDeviceDialog,
    openOpdsCredentialsDialog,
  } from "../lib/authDialogs.svelte";
  import { devicesStore, type Device } from "../lib/devices.svelte";
  import { t } from "../lib/i18n.svelte";
  import { formatDate } from "../lib/jobs.svelte";
  import DeviceLibraryEditor from "./DeviceLibraryEditor.svelte";
  import RowMenu from "./RowMenu.svelte";

  // タブ表示（マウント）のたびに再取得して常に最新を表示する。タブは
  // App.svelte の {#if} で破棄されるため、マウント＝タブ切り替え 1 回に対応。
  // 既にデータがある場合は load() が既存表示を維持したまま裏で更新する。
  $effect(() => {
    if (authStore.account) void devicesStore.load();
  });

  let renamingId = $state<string | null>(null);
  let nameInput = $state("");
  let busyId = $state<string | null>(null);
  let editingLibraryFor = $state<Device | null>(null);
  /** 接続情報の再発行に失敗した端末（成功時は OpdsCredentialsDialog を開くだけで一覧を書き換えないため、失敗時だけこの id で行内にエラーを出す）。 */
  let rotateFailedId = $state<string | null>(null);
  let rotateFailedCode = $state<string | null>(null);

  function startRename(device: Device): void {
    renamingId = device.id;
    nameInput = device.name;
  }

  async function saveRename(device: Device): Promise<void> {
    const name = nameInput.trim();
    if (!name) return;
    busyId = device.id;
    await devicesStore.rename(device.id, name);
    busyId = null;
    renamingId = null;
  }

  async function onRevoke(device: Device): Promise<void> {
    if (!confirm(t("devices_revoke_confirm"))) return;
    busyId = device.id;
    await devicesStore.revoke(device.id);
    busyId = null;
  }

  async function onRotateToken(device: Device): Promise<void> {
    if (!confirm(t("devices_manual_rotate_confirm"))) return;
    busyId = device.id;
    rotateFailedId = null;
    rotateFailedCode = null;
    const result = await devicesStore.rotateDeviceToken(device.id);
    busyId = null;
    if (result.ok) {
      openOpdsCredentialsDialog(device.name, result.opds);
    } else {
      rotateFailedId = device.id;
      rotateFailedCode = result.code;
    }
  }

  function rotateErrorText(code: string | null): string {
    return code === "DEVICE_REVOKED" ? t("devices_manual_rotate_error_revoked") : t("devices_manual_rotate_error_generic");
  }

  function lastSeenText(device: Device): string {
    return device.lastSeenAt ? formatDate(device.lastSeenAt) : t("devices_last_seen_never");
  }

  function deviceModelLabel(device: Device): string | null {
    if (device.device === "x3") return t("devices_manual_model_x3");
    if (device.device === "x4") return t("devices_manual_model_x4");
    return null;
  }

  // App.svelte はタブ状態を自身の onMount 内 popstate リスナーで管理しており、
  // Devices.svelte から直接参照する手段がないため、既存のルーティング規約
  // （history.pushState + popstate）に沿って /flasher への遷移を発火する。
  function goToFlasher(): void {
    history.pushState(null, "", "/flasher" + location.search + location.hash);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
</script>

<section class="devices">
  {#if !authStore.account}
    <div class="login-gate">
      <p class="note">{t("account_login_prompt")}</p>
      <button type="button" class="secondary" onclick={openLoginDialog}>{t("account_login")}</button>
    </div>
  {:else}
    <div class="device-actions">
      <button type="button" class="bulk-btn" onclick={openDevicesHowtoDialog}>{t("devices_howto_btn")}</button>
      <button type="button" class="bulk-btn" onclick={openManualOpdsDeviceDialog}>{t("devices_manual_add_btn")}</button>
    </div>
    {#if devicesStore.loadState === "loading" || devicesStore.loadState === "idle"}
      <p class="note">{t("library_loading")}</p>
    {:else if devicesStore.loadState === "fail"}
      <p class="error-text">{t("devices_load_failed")}</p>
    {:else if devicesStore.devices.length === 0}
      <div class="devices-empty">
        <p class="note">{t("devices_empty")}</p>
        <p class="note">{t("devices_empty_hint")}</p>
        <button type="button" class="secondary" onclick={goToFlasher}>{t("devices_empty_flash")}</button>
      </div>
    {:else}
      <ul class="items">
        {#each devicesStore.devices as device (device.id)}
          <li class="device-row">
            {#if renamingId === device.id}
              <div class="edit-fields">
                <input type="text" bind:value={nameInput} maxlength="100" />
                <div class="row-actions">
                  <button type="button" class="text-btn" onclick={() => (renamingId = null)}>{t("cancel")}</button>
                  <button
                    type="button"
                    class="text-btn primary"
                    disabled={busyId === device.id || !nameInput.trim()}
                    onclick={() => void saveRename(device)}
                  >{t("save")}</button>
                </div>
              </div>
            {:else}
              <div class="info">
                <div class="title">
                  {device.name}
                  {#if device.registrationMethod === "manual_opds"}<span class="method-badge">{t("devices_manual_badge")}</span>{/if}
                </div>
                <div class="meta">
                  {#if deviceModelLabel(device)}<span>{deviceModelLabel(device)}</span>{/if}
                  {#if device.width && device.height}<span>{device.width} × {device.height}</span>{/if}
                  <span>{lastSeenText(device)}</span>
                </div>
                {#if rotateFailedId === device.id}<p class="error-text">{rotateErrorText(rotateFailedCode)}</p>{/if}
              </div>
              <RowMenu
                items={[
                  { label: t("devices_rename"), onSelect: () => startRename(device) },
                  { label: t("devices_edit_library"), onSelect: () => (editingLibraryFor = device) },
                  ...(device.registrationMethod === "manual_opds"
                    ? [{
                        label: t("devices_manual_rotate"),
                        disabled: busyId === device.id,
                        onSelect: () => void onRotateToken(device),
                      }]
                    : []),
                  {
                    label: t("devices_revoke"),
                    danger: true,
                    disabled: busyId === device.id,
                    onSelect: () => void onRevoke(device),
                  },
                ]}
              />
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

{#if editingLibraryFor}
  <DeviceLibraryEditor device={editingLibraryFor} onclose={() => (editingLibraryFor = null)} />
{/if}

<style>
  section.devices { padding: 0 0 24px; }
  .login-gate, .devices-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
  /* Library.svelte の .bulk-bar と同じ領域スタイリング（横スクロール＋スクロールバー非表示）。 */
  .device-actions {
    display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
    flex-wrap: nowrap; overflow-x: auto;
    scrollbar-width: none;
  }
  .device-actions::-webkit-scrollbar { display: none; }
  .device-actions > :global(*) { flex: none; }
  .device-actions .bulk-btn {
    padding: 8px 18px; font: inherit; font-size: 14px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  .device-actions .bulk-btn:hover:not(:disabled) { background: var(--panel); }
  .note { color: var(--muted); font-size: 14px; }
  ul.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  ul.items li.device-row { padding: 14px 0; display: flex; align-items: center; gap: 14px; }
  ul.items li.device-row + li.device-row { border-top: 1px solid var(--line); }
  ul.items li.device-row:last-child { border-bottom: 1px solid var(--line); }
  .info { flex: 1; min-width: 0; }
  .info .title { font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .info .meta { display: flex; gap: 10px; flex-wrap: wrap; font-family: var(--mono); font-size: 14px; color: var(--faint); margin-top: 4px; }
  .method-badge {
    font-size: 11px; font-weight: 500; color: var(--muted2); border: 1px solid var(--line);
    border-radius: 3px; padding: 1px 6px; white-space: nowrap;
  }
  .edit-fields { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
  .edit-fields input {
    padding: 8px 10px; font: inherit; font-size: 14px; border: 1.5px solid var(--ink);
    border-radius: 4px; background: var(--card); color: var(--text);
  }
  .row-actions { display: flex; gap: 14px; flex-wrap: wrap; }
  .text-btn {
    border: 0; background: none; font: inherit; font-size: 14px; color: var(--muted2);
    text-decoration: underline; cursor: pointer; padding: 0;
  }
  .text-btn.primary { color: var(--ink); font-weight: 700; }
  .text-btn:disabled { opacity: .5; cursor: default; }
  button.secondary {
    padding: 8px 18px; font: inherit; font-size: 14px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  button.secondary:hover { background: var(--panel); }
</style>
