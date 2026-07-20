<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { getLang, setLang, t } from "../lib/i18n.svelte";
</script>

<header class="site">
  <div>
    <div class="brand-name">{t("brand")}</div>
    <div class="brand-sub">FOR XTEINK X3</div>
  </div>
  <div class="lang" role="group" aria-label="Language">
    <button type="button" aria-pressed={getLang() === "ja"} onclick={() => setLang("ja")}>日本語</button>
    <button type="button" aria-pressed={getLang() === "en"} onclick={() => setLang("en")}>EN</button>
  </div>
</header>

<style>
  header.site { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .brand-name { font-size: 20px; font-weight: 700; letter-spacing: .06em; }
  .brand-sub { font-family: var(--mono); font-size: 14px; color: var(--muted); letter-spacing: .18em; }
  .lang { display: flex; gap: 2px; font-family: var(--mono); font-size: 14px; }
  .lang button {
    padding: 5px 10px; font: inherit; cursor: pointer; border-radius: 4px;
    border: 1px solid transparent; background: none; color: var(--muted);
  }
  .lang button[aria-pressed="true"] { background: var(--ink); color: var(--ink-text); }
  .lang button[aria-pressed="false"] { border-color: #cfc9bd; }
</style>
