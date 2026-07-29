<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // 汎用OPDSカタログの1エントリ行（仕様書 §8.4）。navigation entryは選択不可
  // （タップで下階層へ移動）、EPUB acquisitionを持つpublicationだけ選択可能。
  import { isImportableEntry, type OpdsEntry } from "../lib/opds-entry";

  let {
    entry,
    selected,
    selectionDisabled,
    onToggle,
    onNavigate,
  }: {
    entry: OpdsEntry;
    selected: boolean;
    /** 未選択でも選択上限に達している場合、新規選択を disable する。 */
    selectionDisabled: boolean;
    onToggle: (checked: boolean) => void;
    onNavigate: (cursor: string) => void;
  } = $props();

  const importable = $derived(entry.kind === "publication" && isImportableEntry(entry));
</script>

{#if entry.kind === "navigation"}
  <li>
    <button type="button" class="nav-row" onclick={() => onNavigate(entry.cursor)}>
      <span class="nav-title">{entry.title}</span>
      <span class="nav-chevron" aria-hidden="true">›</span>
    </button>
  </li>
{:else}
  <li class:on={selected}>
    <label class:disabled={!importable}>
      <input
        type="checkbox"
        checked={selected}
        disabled={!importable || (!selected && selectionDisabled)}
        onchange={(e) => onToggle(e.currentTarget.checked)}
      />
      <div class="pub-info">
        <div class="pub-title">{entry.title}</div>
        {#if entry.author}<div class="pub-author">{entry.author}</div>{/if}
      </div>
    </label>
  </li>
{/if}

<style>
  li { border-top: 1px solid var(--line); list-style: none; }
  li:last-child { border-bottom: 1px solid var(--line); }
  .nav-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    width: 100%; padding: 12px 2px; border: 0; background: none; font: inherit;
    color: var(--text); cursor: pointer; text-align: left;
  }
  .nav-title { font-size: 14px; font-weight: 600; }
  .nav-chevron { color: var(--muted); }
  label { display: flex; align-items: center; gap: 12px; padding: 11px 2px; cursor: pointer; }
  label.disabled { cursor: default; opacity: .5; }
  li.on label { background: var(--panel); margin: 0 -22px; padding: 11px 22px; }
  input[type="checkbox"] { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--ink); cursor: pointer; }
  input[type="checkbox"]:disabled { cursor: default; }
  .pub-info { flex: 1; min-width: 0; }
  .pub-title { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li.on .pub-title { font-weight: 700; }
  .pub-author { font-family: var(--mono); font-size: 12px; color: var(--faint); }
</style>
