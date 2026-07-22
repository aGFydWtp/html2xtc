<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // アカウント画面（登録モード仕様 Phase1 §5.9）。open フラグの同期は
  // PasskeyLoginDialog と同じパターン。端末セクションは既存の Devices.svelte を
  // そのまま埋め込んで再利用する（重複実装を避ける — 実装計画の指示どおり）。
  import { accountStore, usageIsFull, usageIsWarning, type UsageMetric } from "../lib/account.svelte";
  import { accountDialog, closeAccountDialog } from "../lib/authDialogs.svelte";
  import { authStore } from "../lib/auth.svelte";
  import { t } from "../lib/i18n.svelte";
  import { formatDate } from "../lib/jobs.svelte";
  import { formatSize } from "../lib/library.svelte";
  import Devices from "./Devices.svelte";

  let dlg = $state<HTMLDialogElement | null>(null);
  let deleteInput = $state("");
  let deleteBusy = $state(false);
  let deleteError = $state<string | null>(null);

  $effect(() => {
    if (!dlg) return;
    if (accountDialog.open) {
      if (!dlg.open) {
        deleteInput = "";
        deleteError = null;
        dlg.showModal();
        void accountStore.loadUsage();
        void accountStore.loadPasskeys();
        void authStore.loadSessions();
      }
    } else if (dlg.open) {
      dlg.close();
    }
  });

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) closeAccountDialog();
  }

  interface UsageRow {
    label: string;
    metric: UsageMetric;
    text: string;
  }

  const usageRows = $derived<UsageRow[]>(
    accountStore.usage
      ? [
          {
            label: t("account_usage_library_items"),
            metric: accountStore.usage.libraryItems,
            text: t("account_usage_count")(accountStore.usage.libraryItems.used, accountStore.usage.libraryItems.limit),
          },
          {
            label: t("account_usage_library_bytes"),
            metric: accountStore.usage.libraryBytes,
            text: t("account_usage_bytes")(
              formatSize(accountStore.usage.libraryBytes.used),
              formatSize(accountStore.usage.libraryBytes.limit),
            ),
          },
          {
            label: t("account_usage_devices"),
            metric: accountStore.usage.devices,
            text: t("account_usage_count")(accountStore.usage.devices.used, accountStore.usage.devices.limit),
          },
          {
            label: t("account_usage_sessions"),
            metric: accountStore.usage.sessions,
            text: t("account_usage_count")(accountStore.usage.sessions.used, accountStore.usage.sessions.limit),
          },
          {
            label: t("account_usage_passkeys"),
            metric: accountStore.usage.passkeys,
            text: t("account_usage_count")(accountStore.usage.passkeys.used, accountStore.usage.passkeys.limit),
          },
        ]
      : [],
  );

  async function onDeletePasskey(id: string): Promise<void> {
    if (!confirm(t("account_passkey_delete_confirm"))) return;
    await accountStore.deletePasskey(id);
  }

  async function onRevokeSession(id: string): Promise<void> {
    if (!confirm(t("account_session_revoke_confirm"))) return;
    await authStore.revokeSession(id);
  }

  async function onDeleteAccount(): Promise<void> {
    if (deleteInput !== "DELETE" || deleteBusy) return;
    deleteBusy = true;
    deleteError = null;
    const result = await authStore.deleteAccount();
    deleteBusy = false;
    if (result.ok) {
      closeAccountDialog();
    } else {
      deleteError = result.errorCode;
    }
  }
</script>

<dialog
  class="simple-dialog wide"
  bind:this={dlg}
  aria-labelledby="account-dialog-title"
  onclick={onDialogClick}
  onclose={() => closeAccountDialog()}
>
  <div class="dlg-head">
    <span class="dlg-title" id="account-dialog-title">{t("account_dialog_title")}</span>
    <button type="button" class="dlg-x" aria-label={t("cancel")} onclick={() => closeAccountDialog()}>×</button>
  </div>
  <div class="dlg-body">
    <section class="acc-section">
      <h3>{t("account_section_usage")}</h3>
      {#if accountStore.usageLoadState === "loading" || accountStore.usageLoadState === "idle"}
        <p class="note">{t("account_usage_loading")}</p>
      {:else if accountStore.usageLoadState === "fail"}
        <p class="error-text">{t("account_usage_load_failed")}</p>
      {:else}
        <ul class="usage-list">
          {#each usageRows as row (row.label)}
            <li class="usage-row">
              <div class="usage-line">
                <span class="usage-label">{row.label}</span>
                <span class="usage-value">{row.text}</span>
              </div>
              {#if usageIsFull(row.metric)}
                <p class="error-text">{t("account_usage_full")}</p>
              {:else if usageIsWarning(row.metric)}
                <p class="warn-text">{t("account_usage_warning")}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="acc-section">
      <h3>{t("account_section_passkeys")}</h3>
      {#if accountStore.passkeysLoadState === "loading" || accountStore.passkeysLoadState === "idle"}
        <p class="note">{t("account_passkeys_loading")}</p>
      {:else if accountStore.passkeysLoadState === "fail"}
        <p class="error-text">{t("account_passkeys_load_failed")}</p>
      {:else}
        {#if accountStore.passkeys.length === 1}
          <p class="warn-text">{t("account_passkey_last_passkey")}</p>
        {/if}
        <ul class="items">
          {#each accountStore.passkeys as passkey (passkey.id)}
            <li class="row">
              <div class="info">
                <div class="meta">
                  <span>{t("account_passkey_created")(formatDate(passkey.createdAt))}</span>
                  <span>{passkey.lastUsedAt ? t("account_passkey_last_used")(formatDate(passkey.lastUsedAt)) : t("account_passkey_last_used_never")}</span>
                  {#if passkey.backedUp}<span>{t("account_passkey_synced")}</span>{/if}
                </div>
              </div>
              <button
                type="button"
                class="text-btn danger"
                disabled={accountStore.passkeys.length <= 1 || accountStore.deletingPasskeyId === passkey.id}
                title={accountStore.passkeys.length <= 1 ? t("account_passkey_last_passkey_title") : undefined}
                onclick={() => void onDeletePasskey(passkey.id)}
              >{t("account_passkey_delete")}</button>
            </li>
          {/each}
        </ul>
        {#if accountStore.passkeyErrorCode}<p class="error-text">{t("account_passkey_delete_failed")}</p>{/if}
      {/if}
    </section>

    <section class="acc-section">
      <h3>{t("account_section_sessions")}</h3>
      {#if authStore.sessions.length === 0}
        <p class="note">{t("account_sessions_loading")}</p>
      {:else}
        <ul class="items">
          {#each authStore.sessions as session (session.id)}
            <li class="row">
              <div class="info">
                <div class="meta">
                  <span>{session.isCurrent ? t("account_session_current") : formatDate(session.lastSeenAt)}</span>
                </div>
              </div>
              {#if !session.isCurrent}
                <button type="button" class="text-btn danger" onclick={() => void onRevokeSession(session.id)}>{t("account_session_revoke")}</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="acc-section">
      <h3>{t("account_section_devices")}</h3>
      <Devices />
    </section>

    <section class="acc-section danger-section">
      <h3>{t("account_section_danger")}</h3>
      <p class="note">{t("account_delete_intro")}</p>
      <p class="note">{t("account_delete_input_label")}</p>
      <input
        type="text"
        class="delete-input"
        bind:value={deleteInput}
        placeholder={t("account_delete_input_placeholder")}
        autocomplete="off"
        spellcheck="false"
      />
      {#if deleteError}<p class="error-text">{t("account_delete_failed")}</p>{/if}
      <button
        type="button"
        class="delete-btn"
        disabled={deleteInput !== "DELETE" || deleteBusy}
        onclick={() => void onDeleteAccount()}
      >{t("account_delete_button")}</button>
    </section>
  </div>
</dialog>

<style>
  .note { color: var(--muted); font-size: 14px; margin: 0; }
  .warn-text { color: #8a6d1a; font-size: 14px; margin: 4px 0 0; }
  .acc-section { margin-bottom: 26px; }
  .acc-section:last-child { margin-bottom: 0; }
  .acc-section h3 { margin: 0 0 10px; font-size: 15px; font-weight: 700; letter-spacing: .03em; }
  .usage-list { list-style: none; margin: 0; padding: 0; }
  .usage-row { padding: 8px 0; border-top: 1px solid var(--line); }
  .usage-row:last-child { border-bottom: 1px solid var(--line); }
  .usage-line { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .usage-label { font-size: 14px; }
  .usage-value { font-family: var(--mono); font-size: 14px; color: var(--muted2); white-space: nowrap; }
  ul.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  ul.items li.row { padding: 10px 0; display: flex; align-items: center; justify-content: space-between; gap: 14px; border-top: 1px solid var(--line); }
  ul.items li.row:last-child { border-bottom: 1px solid var(--line); }
  .info { flex: 1; min-width: 0; }
  .info .meta { display: flex; gap: 10px; flex-wrap: wrap; font-family: var(--mono); font-size: 13px; color: var(--faint); }
  .text-btn {
    border: 0; background: none; font: inherit; font-size: 14px; color: var(--muted2);
    text-decoration: underline; cursor: pointer; padding: 0; flex: none; white-space: nowrap;
  }
  .text-btn.danger { color: var(--error); }
  .text-btn:disabled { opacity: .5; cursor: default; }
  .delete-input {
    display: block; padding: 10px 12px; font: inherit; font-size: 16px; border: 1.5px solid var(--error);
    border-radius: 4px; background: var(--card); color: var(--text); width: 100%; max-width: 220px;
    margin: 10px 0 12px;
  }
  .delete-btn {
    padding: 10px 20px; font: inherit; font-size: 14px; font-weight: 700; letter-spacing: .04em;
    border: 1.5px solid var(--error); border-radius: 4px; background: none; color: var(--error); cursor: pointer;
  }
  .delete-btn:hover:not(:disabled) { background: var(--error); color: var(--card); }
  .delete-btn:disabled { opacity: .5; cursor: default; }
</style>
