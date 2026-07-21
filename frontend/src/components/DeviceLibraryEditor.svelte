<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from "svelte";
  import { devicesStore, type Device } from "../lib/devices.svelte";
  import { t } from "../lib/i18n.svelte";
  import { libraryStore } from "../lib/library.svelte";

  interface Props {
    device: Device;
    onclose: () => void;
  }
  const { device, onclose }: Props = $props();

  interface ItemMeta {
    title: string;
    author: string | null;
    sizeBytes: number;
  }

  let dlg = $state<HTMLDialogElement | null>(null);
  let version = $state<number | null>(null);
  let assignedOrder = $state<string[]>([]);
  let itemMeta = $state<Map<string, ItemMeta>>(new Map());
  let loadState = $state<"loading" | "loaded" | "fail">("loading");
  let saving = $state(false);
  let conflict = $state(false);
  let saveFailed = $state(false);

  const unassigned = $derived(
    libraryStore.items.map((i) => i.id).filter((id) => !assignedOrder.includes(id)),
  );

  async function load(): Promise<void> {
    loadState = "loading";
    if (libraryStore.loadState === "idle") await libraryStore.load();
    const lib = await devicesStore.getLibrary(device.id);
    if (!lib) {
      loadState = "fail";
      return;
    }
    version = lib.version;
    const sorted = lib.items.slice().sort((a, b) => a.position - b.position);
    assignedOrder = sorted.map((i) => i.id);
    const meta = new Map<string, ItemMeta>();
    for (const i of sorted) meta.set(i.id, { title: i.title, author: i.author, sizeBytes: i.sizeBytes });
    for (const i of libraryStore.items) {
      if (!meta.has(i.id)) meta.set(i.id, { title: i.title, author: i.author, sizeBytes: i.sizeBytes });
    }
    itemMeta = meta;
    loadState = "loaded";
  }

  onMount(() => {
    dlg?.showModal();
    void load();
  });

  function itemLabel(id: string): ItemMeta {
    return itemMeta.get(id) ?? { title: id, author: null, sizeBytes: 0 };
  }

  function addItem(id: string): void {
    if (assignedOrder.includes(id)) return;
    assignedOrder = [...assignedOrder, id];
  }
  function removeItem(id: string): void {
    assignedOrder = assignedOrder.filter((x) => x !== id);
  }
  function moveUp(index: number): void {
    if (index <= 0) return;
    const next = assignedOrder.slice();
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    assignedOrder = next;
  }
  function moveDown(index: number): void {
    if (index >= assignedOrder.length - 1) return;
    const next = assignedOrder.slice();
    [next[index + 1], next[index]] = [next[index], next[index + 1]];
    assignedOrder = next;
  }
  function selectAll(): void {
    assignedOrder = [...assignedOrder, ...unassigned];
  }
  function deselectAll(): void {
    assignedOrder = [];
  }

  function reload(): void {
    conflict = false;
    void load();
  }

  async function onSave(): Promise<void> {
    if (version === null) return;
    saving = true;
    conflict = false;
    saveFailed = false;
    const result = await devicesStore.replaceLibrary(device.id, version, assignedOrder);
    saving = false;
    if (result.ok) {
      onclose();
      return;
    }
    if (result.conflict) conflict = true;
    else saveFailed = true;
  }

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) onclose();
  }
</script>

<dialog
  class="simple-dialog wide"
  bind:this={dlg}
  aria-labelledby="dle-title"
  onclick={onDialogClick}
  onclose={onclose}
>
  <div class="dlg-head">
    <span class="dlg-title" id="dle-title">{t("device_library_title")(device.name)}</span>
    <button type="button" class="dlg-x" aria-label={t("cancel")} onclick={onclose}>×</button>
  </div>
  <div class="dlg-body">
    {#if loadState === "loading"}
      <p class="note">{t("library_loading")}</p>
    {:else if loadState === "fail"}
      <p class="error-text">{t("library_load_failed")}</p>
    {:else if conflict}
      <div class="conflict-box">
        <p class="error-text">{t("device_library_conflict")}</p>
        <button type="button" class="secondary" onclick={reload}>{t("device_library_reload")}</button>
      </div>
    {:else}
      {#if assignedOrder.length === 0 && unassigned.length === 0}
        <p class="note">{t("device_library_empty")}</p>
      {:else}
        <div class="bulk-actions">
          <button type="button" class="text-btn" disabled={unassigned.length === 0} onclick={selectAll}>{t("device_library_select_all")}</button>
          <button type="button" class="text-btn" disabled={assignedOrder.length === 0} onclick={deselectAll}>{t("device_library_deselect_all")}</button>
        </div>
        <ul class="dle-list">
          {#each assignedOrder as id, index (id)}
            {@const meta = itemLabel(id)}
            <li class="dle-row">
              <label class="dle-check">
                <input type="checkbox" checked onchange={() => removeItem(id)} />
                <span class="dle-title">{meta.title}</span>
              </label>
              <div class="dle-order-btns">
                <button type="button" disabled={index === 0} onclick={() => moveUp(index)} aria-label={t("device_library_move_up")}>▲</button>
                <button type="button" disabled={index === assignedOrder.length - 1} onclick={() => moveDown(index)} aria-label={t("device_library_move_down")}>▼</button>
              </div>
            </li>
          {/each}
          {#each unassigned as id (id)}
            {@const meta = itemLabel(id)}
            <li class="dle-row dle-row-unassigned">
              <label class="dle-check">
                <input type="checkbox" onchange={() => addItem(id)} />
                <span class="dle-title dim">{meta.title}</span>
              </label>
            </li>
          {/each}
        </ul>
      {/if}
      {#if saveFailed}<p class="error-text">{t("device_library_save_failed")}</p>{/if}
    {/if}
  </div>
  {#if loadState === "loaded" && !conflict}
    <div class="dlg-actions">
      <button type="button" class="dlg-cancel" onclick={onclose}>{t("cancel")}</button>
      <button type="button" class="dlg-submit" disabled={saving} onclick={() => void onSave()}>{t("device_library_save")}</button>
    </div>
  {/if}
</dialog>

<style>
  .note { color: var(--muted); font-size: 14px; margin: 0; }
  .conflict-box { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
  .bulk-actions { display: flex; gap: 16px; margin-bottom: 12px; }
  .text-btn {
    border: 0; background: none; font: inherit; font-size: 14px; color: var(--muted2);
    text-decoration: underline; cursor: pointer; padding: 0;
  }
  .text-btn:disabled { opacity: .5; cursor: default; }
  button.secondary {
    padding: 8px 18px; font: inherit; font-size: 14px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  button.secondary:hover { background: var(--panel); }
  ul.dle-list { list-style: none; margin: 0; padding: 0; }
  li.dle-row {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 8px 0; border-top: 1px solid var(--line);
  }
  li.dle-row:last-child { border-bottom: 1px solid var(--line); }
  .dle-check { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; cursor: pointer; }
  .dle-check input { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--ink); cursor: pointer; }
  .dle-title { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dle-title.dim { color: var(--faint); }
  .dle-order-btns { display: flex; gap: 4px; flex: none; }
  .dle-order-btns button {
    width: 28px; height: 28px; border: 1px solid var(--line); border-radius: 4px;
    background: var(--card); color: var(--text); cursor: pointer; font-size: 14px;
  }
  .dle-order-btns button:disabled { color: var(--disabled); cursor: default; }
</style>
