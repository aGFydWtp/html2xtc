<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- タイトル直前に置く機種タグ（X3/X4）。X3 は outlined、X4 は filled（塗り+反転）。
     device 未指定時のフォールバック（→ X3）は device-tag.ts 側の判断に委ねる。 -->
<script lang="ts">
  import { resolveDeviceTag } from "../lib/device-tag";
  import { t } from "../lib/i18n.svelte";

  interface Props {
    device?: string;
  }
  const { device }: Props = $props();

  const label = $derived(resolveDeviceTag(device).toUpperCase());
</script>

<span class="device-tag" class:filled={label === "X4"} aria-label={t("device_tag_label")(label)}>{label}</span>

<style>
  .device-tag {
    flex: none;
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    margin-right: 6px;
    border-radius: 4px;
    border: 1px solid var(--line);
    color: var(--muted2);
    background: none;
  }
  .device-tag.filled {
    border-color: var(--ink);
    background: var(--ink);
    color: var(--ink-text);
  }
</style>
