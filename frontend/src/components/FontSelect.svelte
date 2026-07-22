<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script module lang="ts">
  // インスタンスごとの一意 id（listbox/option の id 生成に使う）。RowMenu.svelte の
  // nextMenuId と同じ方式。
  let nextFontSelectId = 0;
</script>

<script lang="ts">
  import type { FontCandidate } from "../lib/text-options";

  let {
    id,
    candidates,
    value = $bindable(),
  }: {
    /** トリガー button の id。既存の <label for="text-font"> との対応関係を保つため呼び出し側から指定する。 */
    id?: string;
    candidates: readonly FontCandidate[];
    value: string;
  } = $props();

  const uid = `font-select-${nextFontSelectId++}`;
  const listboxId = `${uid}-listbox`;
  const optionId = (index: number) => `${uid}-opt-${index}`;

  let open = $state(false);
  let activeIndex = $state(0);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  const selectedIndex = $derived(Math.max(0, candidates.findIndex((c) => c.family === value)));
  const selectedCandidate = $derived(candidates[selectedIndex] ?? candidates[0]);

  // FOUT対策: 候補の字形サンプルは <div role="option"> の {#each} が {#if open} の内側に
  // あるため、初回オープン前は選択中の1書体しかブラウザにロード要求されていない。
  // document.fonts.ready は「ロード要求された書体」しか待たないため、これに頼ると
  // 初めてドロップダウンを開いた瞬間（最もFOUTが起きやすい場面）に他5書体がまだ
  // ダウンロードされていない。そこでマウント時に候補全件を明示的に
  // document.fonts.load() でロード要求してから完了を待つ。読み込み完了までは
  // リスト内の字形サンプルをうっすら表示し、完了後にふわっと確定させる。
  let fontsReady = $state(false);
  $effect(() => {
    if (typeof document === "undefined" || !("fonts" in document)) {
      fontsReady = true;
      return;
    }
    Promise.allSettled(candidates.map((c) => document.fonts.load(`16px "${c.family}"`))).then(() => {
      fontsReady = true;
    });
  });

  function openList(): void {
    if (open) return;
    open = true;
    activeIndex = selectedIndex;
  }

  function closeList(returnFocus: boolean): void {
    if (!open) return;
    open = false;
    if (returnFocus) triggerEl?.focus();
  }

  function toggleList(): void {
    if (open) {
      closeList(false);
    } else {
      openList();
    }
  }

  function commitActive(): void {
    const candidate = candidates[activeIndex];
    if (candidate) value = candidate.family;
    closeList(true);
  }

  function moveActive(delta: number): void {
    const len = candidates.length;
    if (len === 0) return; // 汎用コンポーネントとして: 候補が空なら % len のゼロ除算(NaN)を避ける
    activeIndex = (activeIndex + delta + len) % len;
  }

  function onTriggerKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        if (!open) {
          openList();
        } else {
          moveActive(event.key === "ArrowDown" ? 1 : -1);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) commitActive();
        else openList();
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          closeList(true);
        }
        break;
      default:
        break;
    }
  }

  function onListKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        event.preventDefault();
        activeIndex = 0;
        break;
      case "End":
        event.preventDefault();
        activeIndex = candidates.length - 1;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commitActive();
        break;
      case "Escape":
        event.preventDefault();
        closeList(true);
        break;
      case "Tab":
        closeList(false);
        break;
      default:
        break;
    }
  }

  function onDocumentPointerDown(event: PointerEvent): void {
    if (!open) return;
    const target = event.target as Element | null;
    if (target && (listEl?.contains(target) || triggerEl?.contains(target))) return;
    closeList(false);
  }

  $effect(() => {
    if (!open) return;
    listEl?.focus();
    document.addEventListener("pointerdown", onDocumentPointerDown);
    return () => document.removeEventListener("pointerdown", onDocumentPointerDown);
  });
</script>

<div class="font-select">
  <button
    type="button"
    class="fs-trigger"
    {id}
    bind:this={triggerEl}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={listboxId}
    onclick={toggleList}
    onkeydown={onTriggerKeydown}
  >
    <span class="fs-value" style:font-family={`"${selectedCandidate.family}"`}>{selectedCandidate.label}</span>
    <span class="fs-arrow" aria-hidden="true">{open ? "▾" : "▸"}</span>
  </button>

  {#if open}
    <div
      class="fs-listbox"
      class:fs-fonts-ready={fontsReady}
      role="listbox"
      id={listboxId}
      tabindex="-1"
      aria-labelledby={id}
      aria-activedescendant={optionId(activeIndex)}
      bind:this={listEl}
      onkeydown={onListKeydown}
    >
      {#each candidates as candidate, index (candidate.family)}
        <!-- svelte-ignore a11y_interactive_supports_focus -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- キーボード操作は親 .fs-listbox の aria-activedescendant パターンで処理するため、
             各 option 自体はフォーカス/tabindexを持たない（W3C ARIA APG の Collapsible
             Dropdown Listbox パターンと同じ設計）。クリックは補助的な操作。 -->
        <div
          class="fs-option"
          class:active={index === activeIndex}
          class:selected={candidate.family === value}
          role="option"
          id={optionId(index)}
          aria-selected={candidate.family === value}
          style:font-family={`"${candidate.family}"`}
          onpointerenter={() => (activeIndex = index)}
          onclick={() => {
            activeIndex = index;
            commitActive();
          }}
        >
          {candidate.label}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .font-select { position: relative; align-self: flex-start; min-width: 200px; }

  .fs-trigger {
    display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
    padding: 8px 10px; font: inherit; font-size: 14px; border: 1px solid var(--line); border-radius: 4px;
    background: var(--card); color: var(--text); cursor: pointer; text-align: left;
  }
  .fs-trigger:hover { border-color: var(--faint); }
  .fs-trigger:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
  .fs-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fs-arrow { flex: none; color: var(--muted); font-size: 12px; }

  .fs-listbox {
    position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; right: 0;
    max-height: 260px; overflow-y: auto; margin: 0; padding: 6px;
    border: 1px solid var(--line); border-radius: 4px; background: var(--card);
    box-shadow: 0 4px 16px rgba(28, 26, 23, .16);
  }
  .fs-listbox:focus-visible { outline: none; }

  .fs-option {
    padding: 9px 10px 9px 7px; font-size: 15px; border-radius: 3px; cursor: pointer; color: var(--text);
    border-left: 3px solid transparent; opacity: .55; transition: opacity .15s ease;
  }
  .fs-listbox.fs-fonts-ready .fs-option { opacity: 1; }
  .fs-option.active { background: var(--line); }
  /* 選択中の強調は font-weight ではなく背景+左罫線+チェックマークで示す。候補の
     Noto Sans JP / Noto Serif JP / Zen Maru Gothic / Shippori Mincho は 400 しか
     ロードしていないため、太字化すると合成太字(faux bold)で字形が歪む。字形サンプルは
     常に通常ウェイトのまま見せるのが「その書体自身の字形を見せる」目的に忠実。 */
  .fs-option.selected { background: var(--panel); border-left-color: var(--ink); }
  .fs-option.selected::after { content: " ✓"; font-weight: 400; color: var(--muted); }
</style>
