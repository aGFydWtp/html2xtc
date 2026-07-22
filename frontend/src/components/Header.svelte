<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount, tick } from "svelte";
  import { authStore } from "../lib/auth.svelte";
  import { openAccountDialog, openLoginDialog, openRegistrationDialog } from "../lib/authDialogs.svelte";
  import { getLang, setLang, t } from "../lib/i18n.svelte";

  // ハンバーガーメニュー（ポップオーバー）。History.svelte のジョブ操作メニューと
  // 同じ方式: Popover API 非対応ブラウザ（Chrome <114, Safari <17, Firefox <125）は
  // クラス切替のフォールバックで、light dismiss の代わりに自前の外側クリック /
  // Escape リスナーで閉じる。
  const POPOVER_OK = typeof HTMLElement.prototype.showPopover === "function";
  const MENU_TOGGLE_MS = 300; // light dismiss → ≡ クリックがこの時間内ならトグル（閉じたまま）扱い

  let btnEl = $state<HTMLButtonElement | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  let menuOpen = $state(false); // aria-expanded とフォールバック表示の状態
  let menuClosedAt = 0; // light dismiss は ≡ の click より先に発火するので直前の close を覚える
  let busy = $state(false);

  function hideMenu(): void {
    if (!menuEl) return;
    if (POPOVER_OK) {
      if (menuEl.matches(":popover-open")) menuEl.hidePopover(); // toggle イベントが menuOpen を戻す
      return;
    }
    // メニュー内にフォーカスが残ったまま閉じるとフォーカスが body に落ちるので ≡ へ返す
    if (menuEl.contains(document.activeElement)) btnEl?.focus();
    menuOpen = false;
  }

  async function toggleMenu(): Promise<void> {
    if (menuOpen) { hideMenu(); return; } // フォールバックのトグル（light dismiss なし）
    if (POPOVER_OK && Date.now() - menuClosedAt < MENU_TOGGLE_MS) return; // このクリックの light dismiss で閉じた直後
    if (!menuEl || !btnEl) return;
    if (POPOVER_OK) {
      menuEl.showPopover();
    } else {
      menuOpen = true;
      await tick(); // display:block 反映後に offsetWidth/offsetHeight を測る
    }
    const r = btnEl.getBoundingClientRect();
    menuEl.style.left = `${Math.max(8, Math.min(r.right - menuEl.offsetWidth, window.innerWidth - menuEl.offsetWidth - 8))}px`;
    menuEl.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menuEl.offsetHeight - 8)}px`;
  }

  function onMenuToggle(event: Event): void {
    const open = (event as ToggleEvent).newState === "open";
    menuOpen = open;
    if (!open) menuClosedAt = Date.now();
  }

  onMount(() => {
    if (POPOVER_OK) return;
    const onDocClick = (event: MouseEvent) => {
      if (!menuOpen) return;
      const target = event.target as Element | null;
      if (target && (menuEl?.contains(target) || target.closest(".menu-btn"))) return;
      hideMenu();
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideMenu();
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeydown);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeydown);
    };
  });

  // ダイアログを開く項目は、popover と <dialog> の重なりを避けるため先にメニューを閉じる。
  function menuAddPasskey(): void {
    hideMenu();
    openRegistrationDialog(null);
  }
  function menuAccount(): void {
    hideMenu();
    openAccountDialog();
  }
  function menuLogin(): void {
    hideMenu();
    openLoginDialog();
  }
  async function onLogout(): Promise<void> {
    if (busy) return;
    hideMenu();
    busy = true;
    await authStore.logout();
    busy = false;
  }
</script>

<header class="site">
  <div>
    <div class="brand-name">{t("brand")}</div>
    <div class="brand-sub">FOR XTEINK X3</div>
  </div>
  <button
    type="button"
    class="menu-btn"
    aria-controls="header-menu"
    aria-expanded={menuOpen}
    aria-label={t("menu_open")}
    bind:this={btnEl}
    onclick={() => void toggleMenu()}
  >
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6.5h16M4 12h16M4 17.5h16" /></svg>
  </button>
</header>

<div
  id="header-menu"
  class="hd-menu"
  class:open={!POPOVER_OK && menuOpen}
  popover="auto"
  bind:this={menuEl}
  ontoggle={onMenuToggle}
>
  {#if authStore.account}
    <div class="account-name">{authStore.account.displayName}</div>
    <button type="button" class="item" onclick={menuAccount}>{t("account_menu_item")}</button>
    <button type="button" class="item" onclick={menuAddPasskey}>{t("account_add_passkey")}</button>
    <button type="button" class="item" disabled={busy} onclick={() => void onLogout()}>{t("account_logout")}</button>
  {:else if authStore.ready}
    <button type="button" class="item" onclick={menuLogin}>{t("account_login")}</button>
  {/if}
  {#if authStore.account || authStore.ready}
    <hr />
  {/if}
  <div class="lang" role="group" aria-label="Language">
    <button type="button" aria-pressed={getLang() === "ja"} onclick={() => setLang("ja")}>日本語</button>
    <button type="button" aria-pressed={getLang() === "en"} onclick={() => setLang("en")}>EN</button>
  </div>
</div>

<style>
  header.site { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .brand-name { font-size: 20px; font-weight: 700; letter-spacing: .06em; }
  .brand-sub { font-family: var(--mono); font-size: 14px; color: var(--muted); letter-spacing: .18em; }
  .menu-btn {
    border: 0; background: none; color: var(--muted2); cursor: pointer;
    display: flex; align-items: center; padding: 10px; margin: -10px -6px; border-radius: 4px;
  }
  .menu-btn:hover { background: var(--panel); color: var(--text); }
  .hd-menu {
    position: fixed; display: none; margin: 0; padding: 6px; min-width: 200px;
    border: 1px solid var(--line); border-radius: 4px; background: var(--card);
    box-shadow: 0 4px 16px rgba(28, 26, 23, .16);
  }
  /* この 2 つのルールは分けたままにする: Popover API 非対応ブラウザでは、セレクタ
     リスト中の未知の :popover-open がリスト全体を無効にしてしまうため。 */
  .hd-menu:popover-open { display: block; }
  .hd-menu.open { display: block; }
  .account-name { padding: 8px 12px 4px; font-size: 14px; font-weight: 500; color: var(--muted2); }
  .hd-menu .item {
    display: block; width: 100%; text-align: left; padding: 8px 12px;
    font: inherit; font-size: 14px; border: 0; border-radius: 3px;
    background: none; color: var(--text); cursor: pointer; white-space: nowrap;
  }
  .hd-menu .item:hover:not(:disabled) { background: var(--panel); }
  .hd-menu .item:disabled { color: var(--disabled); cursor: default; }
  .hd-menu hr { border: 0; border-top: 1px solid var(--line); margin: 6px 4px; }
  .lang { display: flex; gap: 2px; padding: 4px 8px 6px; font-family: var(--mono); font-size: 14px; }
  .lang button {
    padding: 5px 10px; font: inherit; cursor: pointer; border-radius: 4px;
    border: 1px solid transparent; background: none; color: var(--muted);
  }
  .lang button[aria-pressed="true"] { background: var(--ink); color: var(--ink-text); }
  .lang button[aria-pressed="false"] { border-color: #cfc9bd; }
</style>
