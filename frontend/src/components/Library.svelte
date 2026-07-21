<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { authStore } from "../lib/auth.svelte";
  import { openLoginDialog } from "../lib/authDialogs.svelte";
  import { t } from "../lib/i18n.svelte";
  import { libraryStore } from "../lib/library.svelte";
  import LibraryItem from "./LibraryItem.svelte";

  $effect(() => {
    if (authStore.account && libraryStore.loadState === "idle") {
      void libraryStore.load();
    }
  });
</script>

<section class="library">
  {#if !authStore.account}
    <div class="login-gate">
      <p class="note">{t("account_login_prompt")}</p>
      <button type="button" class="secondary" onclick={openLoginDialog}>{t("account_login")}</button>
    </div>
  {:else if libraryStore.loadState === "loading" || libraryStore.loadState === "idle"}
    <p class="note">{t("library_loading")}</p>
  {:else if libraryStore.loadState === "fail"}
    <p class="error-text">{t("library_load_failed")}</p>
  {:else if libraryStore.items.length === 0}
    <p class="note">{t("library_empty")}</p>
  {:else}
    <ul class="items">
      {#each libraryStore.items as item (item.id)}
        <li><LibraryItem {item} /></li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  section.library { padding: 24px 0; }
  .login-gate { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
  .note { color: var(--muted); font-size: 14px; }
  ul.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  ul.items li { border-top: 1px solid var(--line); }
  ul.items li:last-child { border-bottom: 1px solid var(--line); }
  button.secondary {
    padding: 8px 18px; font: inherit; font-size: 14px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  button.secondary:hover { background: var(--panel); }
</style>
