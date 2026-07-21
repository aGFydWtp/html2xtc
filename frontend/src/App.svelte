<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from "svelte";
  import AozoraDialog from "./components/AozoraDialog.svelte";
  import ConvertForm from "./components/ConvertForm.svelte";
  import CurrentJob from "./components/CurrentJob.svelte";
  import Devices from "./components/Devices.svelte";
  import Header from "./components/Header.svelte";
  import History from "./components/History.svelte";
  import Library from "./components/Library.svelte";
  import PairingApprovalDialog from "./components/PairingApprovalDialog.svelte";
  import PasskeyLoginDialog from "./components/PasskeyLoginDialog.svelte";
  import PasskeyRegistrationDialog from "./components/PasskeyRegistrationDialog.svelte";
  import PreviewDialog from "./components/PreviewDialog.svelte";
  import { authStore } from "./lib/auth.svelte";
  import { openPairingDialog, openRegistrationDialog } from "./lib/authDialogs.svelte";
  import { refreshStale } from "./lib/convert.svelte";
  import { t } from "./lib/i18n.svelte";

  type Tab = "convert" | "library" | "devices";
  let tab = $state<Tab>("convert");

  // ?register=<token> はパスキー新規登録ダイアログを、?pair=<userCode> は端末
  // ペアリング承認ダイアログを開く（実装計画 §6 / §14）。両方とも起動後は
  // URL から取り除き、再読み込みでの再表示・ブックマークでの露出を避ける。
  onMount(() => {
    void refreshStale();
    void authStore.init().then(() => {
      const params = new URLSearchParams(location.search);
      const registerToken = params.get("register");
      const pairCode = params.get("pair");
      if (registerToken) openRegistrationDialog(registerToken);
      if (pairCode) {
        openPairingDialog(pairCode);
        tab = "devices";
      }
      if (registerToken || pairCode) {
        params.delete("register");
        params.delete("pair");
        const qs = params.toString();
        history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
      }
    });
  });
</script>

<main>
  <Header />
  <div class="tabs" role="tablist">
    <button type="button" role="tab" aria-selected={tab === "convert"} onclick={() => (tab = "convert")}>{t("tab_convert")}</button>
    <button type="button" role="tab" aria-selected={tab === "library"} onclick={() => (tab = "library")}>{t("tab_library")}</button>
    <button type="button" role="tab" aria-selected={tab === "devices"} onclick={() => (tab = "devices")}>{t("tab_devices")}</button>
  </div>
  {#if tab === "convert"}
    <ConvertForm />
    <CurrentJob />
    <History />
  {:else if tab === "library"}
    <Library />
  {:else}
    <Devices />
  {/if}
</main>
<AozoraDialog />
<PreviewDialog />
<PasskeyLoginDialog />
<PasskeyRegistrationDialog />
<PairingApprovalDialog />

<style>
  main { max-width: 44rem; margin: 0 auto; padding: 28px 20px 48px; }
  .tabs { display: flex; gap: 4px; margin: 18px 0 4px; border-bottom: 1px solid var(--line); }
  .tabs button {
    padding: 10px 16px; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
    border: 0; border-bottom: 2px solid transparent; background: none; color: var(--muted);
  }
  .tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
</style>
