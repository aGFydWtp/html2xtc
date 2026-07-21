<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { authStore } from "../lib/auth.svelte";
  import { openLoginDialog, openRegistrationDialog } from "../lib/authDialogs.svelte";
  import { t } from "../lib/i18n.svelte";

  let busy = $state(false);

  async function onLogout(): Promise<void> {
    busy = true;
    await authStore.logout();
    busy = false;
  }
</script>

<div class="account-menu">
  {#if authStore.account}
    <span class="account-name">{authStore.account.displayName}</span>
    <button type="button" class="link-btn" onclick={() => openRegistrationDialog(null)}>{t("account_add_passkey")}</button>
    <button type="button" class="link-btn" disabled={busy} onclick={() => void onLogout()}>{t("account_logout")}</button>
  {:else if authStore.ready}
    <button type="button" class="link-btn" onclick={openLoginDialog}>{t("account_login")}</button>
  {/if}
</div>

<style>
  .account-menu { display: flex; align-items: center; justify-content: flex-end; gap: 14px; font-size: 14px; margin-top: 10px; }
  .account-name { color: var(--muted2); font-weight: 500; }
  .link-btn {
    border: 0; background: none; font: inherit; font-size: 14px; color: var(--muted);
    text-decoration: underline; cursor: pointer; padding: 4px;
  }
  .link-btn:disabled { opacity: .6; cursor: default; }
</style>
