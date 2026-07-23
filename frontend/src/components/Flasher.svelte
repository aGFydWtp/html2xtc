<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // ESP Web Tools の Custom Element（<esp-web-install-button>）を登録する副作用
  // import。npm 依存としてバンドルし、実行時の外部 CDN 読み込みは行わない
  // （実装仕様書 §7.2, §15.4）。パッケージに "exports" は無く、package.json の
  // "main" が指すのは "dist/install-button.js"（"dist/web/..." は存在しない）。
  import "esp-web-tools/dist/install-button.js";
  import { onMount } from "svelte";
  import { loadManifestState, MANIFEST_URLS, type FirmwareChannel, type ManifestState } from "../lib/flasher";
  import { t } from "../lib/i18n.svelte";

  type EspWebInstallButtonElement = HTMLElement & { manifest: string };

  // 配布ファームウェアのフォーク元。html2xtc 用に接続機能を追加したフォーク版で
  // あることを明示するために表示する（本家との混同防止）。
  const FLASHER_UPSTREAM_URL = "https://github.com/zrn-ns/crosspoint-jp";

  // 両チャンネルとも利用不可の間は未選択（null）のままにする（実装仕様書 §5.5 優先順位3）。
  let channel = $state<FirmwareChannel | null>(null);
  let devState = $state<ManifestState>({ status: "loading" });
  let stableState = $state<ManifestState>({ status: "loading" });
  let installButton = $state<EspWebInstallButtonElement | null>(null);

  const serialSupported = typeof navigator !== "undefined" && "serial" in navigator;
  const secureContext = typeof window !== "undefined" && window.isSecureContext;

  // channel が null（両チャンネル利用不可、または取得完了前）の間は「未選択」として扱う。
  const selectedState = $derived(
    channel === "dev" ? devState : channel === "stable" ? stableState : null,
  );

  const canInstall = $derived(
    serialSupported && secureContext && selectedState !== null && selectedState.status === "available",
  );

  // 両チャンネルとも取得に失敗した場合の案内（実装仕様書 §14.3）。
  const bothUnavailable = $derived(devState.status === "unavailable" && stableState.status === "unavailable");

  function manifestErrorText(reason: "not-found" | "network" | "invalid"): string {
    if (reason === "not-found") return t("flasher_not_released");
    if (reason === "invalid") return t("flasher_manifest_invalid");
    return t("flasher_manifest_failed");
  }

  // Custom Element へは manifest が利用可能な場合のみ有効な URL を渡す。disabled
  // 属性だけに依存せず、空状態では manifest 自体を空にする（実装仕様書 §11.2）。
  $effect(() => {
    if (!installButton) return;
    installButton.manifest = selectedState !== null && selectedState.status === "available" ? selectedState.manifestUrl : "";
  });

  onMount(() => {
    const controller = new AbortController();

    void Promise.all([
      loadManifestState(MANIFEST_URLS.dev, controller.signal),
      loadManifestState(MANIFEST_URLS.stable, controller.signal),
    ])
      .then(([dev, stable]) => {
        devState = dev;
        stableState = stable;

        // 初期選択の優先順位（実装仕様書 §5.5）: 開発版 > 安定版 > 未選択。
        // 両方利用不可の場合は channel を null のままにする。
        if (dev.status === "available") {
          channel = "dev";
        } else if (stable.status === "available") {
          channel = "stable";
        }
      })
      .catch((error: unknown) => {
        // タブ離脱（unmount）による controller.abort() で両 fetch が AbortError を
        // 投げると Promise.all が reject する。それ自体はコンポーネント破棄後の
        // 想定内の後始末なので握りつぶし、それ以外の予期しない例外のみ再 throw する。
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        throw error;
      });

    return () => controller.abort();
  });
</script>

<section class="flasher">
  <h2>{t("flasher_title")}</h2>
  <p class="intro">{t("flasher_intro")}</p>
  <p class="fork-notice">
    {t("flasher_fork_notice")}
    <a href={FLASHER_UPSTREAM_URL} target="_blank" rel="noopener noreferrer">{t("flasher_upstream_label")}</a>
  </p>

  <!-- 警告の優先順位（実装仕様書 §11.5）: 非HTTPS > Web Serial非対応 > manifest取得失敗 > 通常表示。 -->
  {#if !secureContext}
    <div class="notice error" role="alert">{t("flasher_https_required")}</div>
  {:else if !serialSupported}
    <div class="notice warning" role="status">{t("flasher_unsupported")}</div>
  {:else if bothUnavailable}
    <div class="notice warning" role="status">{t("flasher_manifest_failed")}</div>
  {/if}

  <fieldset class="channel-list">
    <legend>{t("flasher_channel_heading")}</legend>

    <label class="channel-option">
      <input type="radio" name="firmware-channel" value="dev" bind:group={channel} disabled={devState.status !== "available"} />
      <span class="channel-body">
        <span class="channel-name">{t("flasher_dev")}</span>
        <span class="channel-desc">{t("flasher_dev_description")}</span>
        <span class="channel-version" aria-live="polite">
          {#if devState.status === "loading"}
            {t("flasher_loading")}
          {:else if devState.status === "available"}
            {t("flasher_version")(devState.version)}
          {:else}
            {manifestErrorText(devState.reason)}
          {/if}
        </span>
      </span>
    </label>

    <label class="channel-option">
      <input type="radio" name="firmware-channel" value="stable" bind:group={channel} disabled={stableState.status !== "available"} />
      <span class="channel-body">
        <span class="channel-name">{t("flasher_stable")}</span>
        <span class="channel-desc">{t("flasher_stable_description")}</span>
        <span class="channel-version" aria-live="polite">
          {#if stableState.status === "loading"}
            {t("flasher_loading")}
          {:else if stableState.status === "available"}
            {t("flasher_version")(stableState.version)}
          {:else}
            {manifestErrorText(stableState.reason)}
          {/if}
        </span>
      </span>
    </label>
  </fieldset>

  <esp-web-install-button bind:this={installButton}>
    <button type="button" slot="activate" class="primary" disabled={!canInstall}>
      {t("flasher_install")}
    </button>

    <span slot="unsupported">{t("flasher_unsupported")}</span>
    <span slot="not-allowed">{t("flasher_https_required")}</span>
  </esp-web-install-button>

  <section class="instructions">
    <h3>{t("flasher_instructions_heading")}</h3>
    <ol>
      <li>{t("flasher_instruction_connect")}</li>
      <li>{t("flasher_instruction_select")}</li>
      <li>{t("flasher_instruction_install")}</li>
      <li>{t("flasher_instruction_port")}</li>
      <li>{t("flasher_instruction_wait")}</li>
    </ol>
  </section>

  <section class="warnings">
    <h3>{t("flasher_warning_heading")}</h3>
    <ul>
      <li>{t("flasher_warning_browser")}</li>
      <li>{t("flasher_warning_erase")}</li>
      <li>{t("flasher_warning_disconnect")}</li>
      <li>{t("flasher_warning_restart")}</li>
    </ul>
  </section>
</section>

<style>
  section.flasher { padding: 0 0 30px; }
  section.flasher h2 { margin: 0 0 8px; font-size: 20px; }
  section.flasher .intro { margin: 0 0 20px; color: var(--muted2); line-height: 1.8; }
  section.flasher .fork-notice { margin: 0 0 20px; color: var(--muted2); font-size: 13px; line-height: 1.8; }
  section.flasher .fork-notice a { color: inherit; }

  .notice { padding: 12px 14px; margin: 0 0 18px; border-radius: 4px; font-size: 14px; line-height: 1.7; }
  .notice.error { border: 1px solid var(--error); color: var(--error); }
  .notice.warning { border: 1px solid var(--line); background: var(--panel); color: var(--muted2); }

  fieldset.channel-list {
    border: 1.5px solid var(--line); border-radius: 4px; margin: 0 0 20px; padding: 14px 16px 16px;
    display: flex; flex-direction: column; gap: 12px;
  }
  fieldset.channel-list legend { padding: 0 6px; font-size: 13px; font-weight: 700; color: var(--muted2); letter-spacing: .04em; }

  .channel-option { display: flex; align-items: flex-start; gap: 12px; cursor: pointer; }
  .channel-option:has(input:disabled) { cursor: default; }
  .channel-option input[type="radio"] { margin-top: 4px; flex: none; accent-color: var(--ink); }
  .channel-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .channel-name { font-weight: 700; }
  .channel-desc { font-size: 14px; color: var(--muted2); }
  .channel-version { font-family: var(--mono); font-size: 13px; color: var(--faint); }
  .channel-option:has(input:disabled) .channel-name,
  .channel-option:has(input:disabled) .channel-desc { color: var(--disabled); }

  button.primary {
    padding: 14px 26px; font: inherit; font-size: 16px; font-weight: 700; letter-spacing: .1em;
    border: 0; border-radius: 4px; background: var(--ink); color: var(--ink-text); cursor: pointer; white-space: nowrap;
  }
  button.primary:disabled { opacity: .55; cursor: default; }

  section.instructions, section.warnings { margin-top: 26px; }
  section.instructions h3, section.warnings h3 { margin: 0 0 10px; font-size: 15px; }
  section.instructions ol, section.warnings ul { margin: 0; padding-left: 22px; color: var(--muted2); font-size: 14px; line-height: 1.9; }
</style>
