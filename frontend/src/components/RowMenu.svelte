<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script module lang="ts">
  // 行アクションメニューの 1 項目。href があればアンカー、なければボタンとして描画する。
  export interface RowMenuItem {
    label: string;
    onSelect?: () => void;
    href?: string;
    danger?: boolean;
    disabled?: boolean;
  }

  // aria-controls 用のインスタンスごとの一意 id。
  let nextMenuId = 0;
</script>

<script lang="ts">
  import { onMount, tick } from "svelte";
  import { t } from "../lib/i18n.svelte";

  interface Props {
    items: RowMenuItem[];
  }
  const { items }: Props = $props();

  // 行右端の ⋮ から開く操作メニュー（ポップオーバー）。History.svelte /
  // Header.svelte のメニューと同じ方式: Popover API 非対応ブラウザ
  // （Chrome <114, Safari <17, Firefox <125）はクラス切替のフォールバックで、
  // light dismiss の代わりに自前の外側クリック / Escape リスナーで閉じる。
  const POPOVER_OK = typeof HTMLElement.prototype.showPopover === "function";
  const MENU_TOGGLE_MS = 300; // light dismiss → ⋮ クリックがこの時間内ならトグル（閉じたまま）扱い

  const menuId = `row-menu-${nextMenuId++}`;
  let btnEl = $state<HTMLButtonElement | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  let menuOpen = $state(false); // aria-expanded とフォールバック表示の状態
  let menuClosedAt = 0; // light dismiss は ⋮ の click より先に発火するので直前の close を覚える

  function hideMenu(): void {
    if (!menuEl) return;
    if (POPOVER_OK) {
      if (menuEl.matches(":popover-open")) menuEl.hidePopover(); // toggle イベントが menuOpen を戻す
      return;
    }
    // メニュー内にフォーカスが残ったまま閉じるとフォーカスが body に落ちるので ⋮ へ返す
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
      if (target && (menuEl?.contains(target) || btnEl?.contains(target))) return;
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

  function select(item: RowMenuItem): void {
    hideMenu();
    item.onSelect?.();
  }
</script>

<button
  type="button"
  class="more-btn"
  aria-controls={menuId}
  aria-expanded={menuOpen}
  aria-label={t("menu_label")}
  bind:this={btnEl}
  onclick={() => void toggleMenu()}
>
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5.5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="18.5" r="1.7" /></svg>
</button>

<div
  class="row-menu"
  class:open={menuOpen}
  id={menuId}
  popover="auto"
  bind:this={menuEl}
  ontoggle={onMenuToggle}
>
  {#each items as item}
    {#if item.href !== undefined}
      <a href={item.href} class:danger={item.danger} onclick={hideMenu}>{item.label}</a>
    {:else}
      <button
        type="button"
        class:danger={item.danger}
        disabled={item.disabled}
        onclick={() => select(item)}
      >{item.label}</button>
    {/if}
  {/each}
</div>

<style>
  .more-btn {
    border: 0; background: none; color: var(--muted2); cursor: pointer;
    display: flex; align-items: center; padding: 10px; margin: -10px -6px; border-radius: 4px;
  }
  .more-btn:hover { background: var(--panel); color: var(--text); }
  .row-menu {
    position: fixed; display: none; margin: 0; padding: 6px; min-width: 180px;
    border: 1px solid var(--line); border-radius: 4px; background: var(--card);
    box-shadow: 0 4px 16px rgba(28, 26, 23, .16);
  }
  /* この 2 つのルールは分けたままにする: Popover API 非対応ブラウザでは、セレクタ
     リスト中の未知の :popover-open がリスト全体を無効にしてしまうため。 */
  .row-menu:popover-open { display: block; }
  .row-menu.open { display: block; }
  .row-menu button,
  .row-menu a {
    display: block; width: 100%; box-sizing: border-box; text-align: left; padding: 8px 12px;
    font: inherit; font-size: 14px; border: 0; border-radius: 3px;
    background: none; color: var(--text); cursor: pointer;
    white-space: nowrap; text-decoration: none;
  }
  .row-menu button:hover:not(:disabled),
  .row-menu a:hover { background: var(--panel); }
  .row-menu button:disabled { color: var(--disabled); cursor: default; }
  .row-menu .danger { color: var(--error); }
</style>
