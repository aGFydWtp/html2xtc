<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from "svelte";
  import Account from "./components/Account.svelte";
  import AozoraDialog from "./components/AozoraDialog.svelte";
  import ConvertForm from "./components/ConvertForm.svelte";
  import CurrentJob from "./components/CurrentJob.svelte";
  import Devices from "./components/Devices.svelte";
  import DevicesHowtoDialog from "./components/DevicesHowtoDialog.svelte";
  import Flasher from "./components/Flasher.svelte";
  import Header from "./components/Header.svelte";
  import History from "./components/History.svelte";
  import Library from "./components/Library.svelte";
  import PairingApprovalDialog from "./components/PairingApprovalDialog.svelte";
  import PasskeyLoginDialog from "./components/PasskeyLoginDialog.svelte";
  import PasskeyRegistrationDialog from "./components/PasskeyRegistrationDialog.svelte";
  import PreviewDialog from "./components/PreviewDialog.svelte";
  import RegistrationClosedDialog from "./components/RegistrationClosedDialog.svelte";
  import { authStore } from "./lib/auth.svelte";
  import { openPairingDialog, openRegistrationClosedNotice, openRegistrationDialog } from "./lib/authDialogs.svelte";
  import { refreshStale } from "./lib/convert.svelte";
  import { t } from "./lib/i18n.svelte";
  import { publicConfigStore } from "./lib/publicConfig.svelte";

  type Tab = "convert" | "library" | "devices" | "flasher";

  // パス⇔タブ対応表（History API ベースのルーティング）。
  const PATH_TO_TAB: Record<string, Tab> = {
    "/": "convert",
    "/library": "library",
    "/devices": "devices",
    "/flasher": "flasher",
  };
  const TAB_TO_PATH: Record<Tab, string> = {
    convert: "/",
    library: "/library",
    devices: "/devices",
    flasher: "/flasher",
  };

  // ログイン必須のタブ（実装仕様書 §12.4）。ファームウェア機能はログイン不要のため
  // ここには含めない — 未ログインで /flasher を直接開いても変換タブへ戻さない。
  const AUTH_REQUIRED_TABS = new Set<Tab>(["library", "devices"]);

  function tabFromPath(pathname: string): Tab {
    const p = pathname.replace(/\/+$/, "") || "/";
    return PATH_TO_TAB[p] ?? "convert";
  }

  let tab = $state<Tab>(tabFromPath(location.pathname));

  // 未ログイン時、ログイン必須タブ（ライブラリ・端末）を開いたままログアウト
  // した場合（未ログインで /library 等を直接開いた場合も含む）はアクティブタブを
  // 「変換」へ戻し、URL も揃える。ready を待つのは、セッション復元中（/api/me
  // 応答前）にログイン済みユーザーの深いリンクを / へ書き換えないため。
  // ファームウェア機能（AUTH_REQUIRED_TABS に含まれない）は未ログインでも
  // そのまま表示する（実装仕様書 §4.3, §12.4）。
  $effect(() => {
    if (authStore.ready && !authStore.account && AUTH_REQUIRED_TABS.has(tab)) {
      tab = "convert";
      history.replaceState(null, "", TAB_TO_PATH.convert + location.search + location.hash);
    }
  });

  function selectTab(next: Tab) {
    if (tab === next) return;
    tab = next;
    history.pushState(null, "", TAB_TO_PATH[next] + location.search + location.hash);
  }

  // ?register=<token> はパスキー新規登録ダイアログを、?pair=<userCode> は端末
  // ペアリング承認ダイアログを開く（実装計画 §6 / §14）。両方とも起動後は
  // URL から取り除き、再読み込みでの再表示・ブックマークでの露出を避ける。
  onMount(() => {
    void refreshStale();
    // publicConfig と authStore の両方が確定してから ?register= を判定する
    // （登録モード仕様 Phase3 §5: publicConfigStore.registrationMode が
    // "closed" かどうかで開くダイアログを分けるため、片方だけの完了を待つ
    // と registrationMode がまだ既定値 "invite" のままの可能性がある —
    // PHASE3_GAP_ANALYSIS.md §5.1 (11) のレース条件指摘への対応）。
    void Promise.all([authStore.init(), publicConfigStore.init()]).then(() => {
      const params = new URLSearchParams(location.search);
      const registerToken = params.get("register");
      const pairCode = params.get("pair");
      if (registerToken) {
        if (publicConfigStore.registrationMode === "closed") {
          openRegistrationClosedNotice();
        } else {
          openRegistrationDialog({ mode: "invite", inviteToken: registerToken });
        }
      }
      if (pairCode) {
        openPairingDialog(pairCode);
        tab = "devices";
      }
      if (registerToken || pairCode) {
        params.delete("register");
        params.delete("pair");
        const qs = params.toString();
        const path = pairCode ? "/devices" : location.pathname;
        history.replaceState(null, "", path + (qs ? `?${qs}` : "") + location.hash);
      }
    });

    const onPopState = () => {
      tab = tabFromPath(location.pathname);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });
</script>

<main>
  <Header />
  <div class="tabs" role="tablist">
    <button type="button" role="tab" aria-selected={tab === "convert"} onclick={() => selectTab("convert")}>{t("tab_convert")}</button>
    {#if authStore.account}
      <button type="button" role="tab" aria-selected={tab === "library"} onclick={() => selectTab("library")}>{t("tab_library")}</button>
      <button type="button" role="tab" aria-selected={tab === "devices"} onclick={() => selectTab("devices")}>{t("tab_devices")}</button>
    {/if}
    <button type="button" role="tab" aria-selected={tab === "flasher"} onclick={() => selectTab("flasher")}>{t("tab_flasher")}</button>
  </div>
  {#if tab === "convert"}
    <ConvertForm />
    <CurrentJob />
    <History />
  {:else if tab === "library"}
    <Library />
  {:else if tab === "devices"}
    <Devices />
  {:else if tab === "flasher"}
    <Flasher />
  {/if}
</main>
<AozoraDialog />
<PreviewDialog />
<PasskeyLoginDialog />
<PasskeyRegistrationDialog />
<RegistrationClosedDialog />
<PairingApprovalDialog />
<DevicesHowtoDialog />
<Account />

<style>
  main { max-width: 44rem; margin: 0 auto; padding: 28px 20px 48px; }
  /* モバイル幅で全タブが収まらない場合は横スクロールを許可する（実装仕様書 §5.2, §12.7）。 */
  .tabs { display: flex; gap: 4px; margin: 18px 0 4px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: thin; }
  .tabs button {
    flex: 0 0 auto; white-space: nowrap;
    padding: 10px 16px; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
    border: 0; border-bottom: 2px solid transparent; background: none; color: var(--muted);
  }
  .tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
</style>
