<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from "svelte";
  import Account from "./components/Account.svelte";
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
  import { publicConfigStore } from "./lib/publicConfig.svelte";

  type Tab = "convert" | "library" | "devices";

  // パス⇔タブ対応表（History API ベースのルーティング）。
  const PATH_TO_TAB: Record<string, Tab> = { "/": "convert", "/library": "library", "/devices": "devices" };
  const TAB_TO_PATH: Record<Tab, string> = { convert: "/", library: "/library", devices: "/devices" };

  function tabFromPath(pathname: string): Tab {
    const p = pathname.replace(/\/+$/, "") || "/";
    return PATH_TO_TAB[p] ?? "convert";
  }

  let tab = $state<Tab>(tabFromPath(location.pathname));

  // 未ログイン時はタブを表示しない。ライブラリ/端末タブを開いたままログアウト
  // した場合（未ログインで /library 等を直接開いた場合も含む）はアクティブタブを
  // 「変換」へ戻し、URL も揃える。ready を待つのは、セッション復元中（/api/me
  // 応答前）にログイン済みユーザーの深いリンクを / へ書き換えないため。
  $effect(() => {
    if (authStore.ready && !authStore.account && tab !== "convert") {
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
    // publicConfig は認証状態と無関係に取得できるので authStore.init() と
    // 並列で走らせる（Header の「新規登録」ボタン表示判定に使う）。
    void publicConfigStore.init();
    void authStore.init().then(() => {
      const params = new URLSearchParams(location.search);
      const registerToken = params.get("register");
      const pairCode = params.get("pair");
      if (registerToken) openRegistrationDialog({ mode: "invite", inviteToken: registerToken });
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
  {#if authStore.account}
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === "convert"} onclick={() => selectTab("convert")}>{t("tab_convert")}</button>
      <button type="button" role="tab" aria-selected={tab === "library"} onclick={() => selectTab("library")}>{t("tab_library")}</button>
      <button type="button" role="tab" aria-selected={tab === "devices"} onclick={() => selectTab("devices")}>{t("tab_devices")}</button>
    </div>
  {:else}
    <div class="tabs-spacer"></div>
  {/if}
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
<Account />

<style>
  main { max-width: 44rem; margin: 0 auto; padding: 28px 20px 48px; }
  .tabs { display: flex; gap: 4px; margin: 18px 0 4px; border-bottom: 1px solid var(--line); }
  /* タブ非表示時もコンテンツ開始位置が不自然に詰まらないよう、タブバーの
     上マージン相当の余白を確保する（空 div のマージン相殺を避け高さで指定）。 */
  .tabs-spacer { height: 18px; }
  .tabs button {
    padding: 10px 16px; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
    border: 0; border-bottom: 2px solid transparent; background: none; color: var(--muted);
  }
  .tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
</style>
