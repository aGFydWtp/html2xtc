<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  // 標準 OPDS 端末の接続情報表示（OPDS Phase 2 §10.3）。新規登録直後・token
  // 再発行直後の両方から開く。password はこのダイアログが開いている間だけ
  // 画面に表示し、閉じたら共有 state（authDialogs.svelte.ts の
  // opdsCredentialsDialog）から必ずクリアする（§11 セキュリティ要件）。
  // 「保存しました」チェック未確認での close は confirm() で確認を挟む。
  import { closeOpdsCredentialsDialog, opdsCredentialsDialog } from "../lib/authDialogs.svelte";
  import { t } from "../lib/i18n.svelte";

  let dlg = $state<HTMLDialogElement | null>(null);
  let confirmed = $state(false);
  let copiedField = $state<string | null>(null);
  let copyFailedField = $state<string | null>(null);

  let serverInput = $state<HTMLInputElement | null>(null);
  let urlInput = $state<HTMLInputElement | null>(null);
  let userInput = $state<HTMLInputElement | null>(null);
  let passInput = $state<HTMLInputElement | null>(null);
  let bulkTextarea = $state<HTMLTextAreaElement | null>(null);

  $effect(() => {
    if (!dlg) return;
    if (opdsCredentialsDialog.open) {
      if (!dlg.open) {
        confirmed = false;
        copiedField = null;
        copyFailedField = null;
        dlg.showModal();
      }
    } else if (dlg.open) {
      dlg.close();
    }
  });

  function bulkText(): string {
    const opds = opdsCredentialsDialog.opds;
    if (!opds) return "";
    return [
      `${t("opds_field_server_name")}: ${opds.serverName}`,
      `${t("opds_field_catalog_url")}: ${opds.catalogUrl}`,
      `${t("opds_field_username")}: ${opds.username}`,
      `${t("opds_field_password")}: ${opds.password}`,
    ].join("\n");
  }

  // Clipboard API が使えない/失敗する環境向けに、対象 input を選択状態にして
  // 手動コピー（Ctrl+C）できるようフォールバックする（§11-12）。
  async function copyField(field: string, text: string, el: HTMLInputElement | HTMLTextAreaElement | null): Promise<void> {
    copiedField = null;
    copyFailedField = null;
    try {
      if (!navigator.clipboard || !window.isSecureContext) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      copiedField = field;
    } catch {
      copyFailedField = field;
      el?.focus();
      el?.select();
    }
  }

  function requestClose(): void {
    if (confirmed || confirm(t("opds_close_confirm"))) {
      closeOpdsCredentialsDialog();
    }
  }

  // Escape キー押下は既定で dialog を閉じてしまう（cancel → close）ため、
  // 未確認のまま token を state から消してしまわないよう cancel を止めて
  // requestClose() に一本化する。
  function onCancel(event: Event): void {
    event.preventDefault();
    requestClose();
  }

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) requestClose();
  }
</script>

<dialog
  class="simple-dialog wide"
  bind:this={dlg}
  aria-labelledby="opds-credentials-dialog-title"
  onclick={onDialogClick}
  oncancel={onCancel}
  onclose={() => closeOpdsCredentialsDialog()}
>
  {#if opdsCredentialsDialog.opds}
    {@const opds = opdsCredentialsDialog.opds}
    <div class="dlg-head">
      <span class="dlg-title" id="opds-credentials-dialog-title">{t("opds_credentials_title")}</span>
      <button type="button" class="dlg-x" aria-label={t("cancel")} onclick={requestClose}>×</button>
    </div>
    <div class="dlg-body">
      <p class="warning">{t("opds_password_warning")}</p>

      <div class="cred-row">
        <label class="cred-label" for="opds-cred-server">{t("opds_field_server_name")}</label>
        <input id="opds-cred-server" type="text" readonly bind:this={serverInput} value={opds.serverName} />
        <button type="button" class="copy-btn" onclick={() => void copyField("server", opds.serverName, serverInput)}>{t("opds_copy_btn")}</button>
      </div>
      <div class="cred-row">
        <label class="cred-label" for="opds-cred-url">{t("opds_field_catalog_url")}</label>
        <input id="opds-cred-url" type="text" readonly bind:this={urlInput} value={opds.catalogUrl} />
        <button type="button" class="copy-btn" onclick={() => void copyField("url", opds.catalogUrl, urlInput)}>{t("opds_copy_btn")}</button>
      </div>
      <div class="cred-row">
        <label class="cred-label" for="opds-cred-user">{t("opds_field_username")}</label>
        <input id="opds-cred-user" type="text" readonly bind:this={userInput} value={opds.username} />
        <button type="button" class="copy-btn" onclick={() => void copyField("username", opds.username, userInput)}>{t("opds_copy_btn")}</button>
      </div>
      <div class="cred-row">
        <label class="cred-label" for="opds-cred-pass">{t("opds_field_password")}</label>
        <input id="opds-cred-pass" type="text" readonly bind:this={passInput} value={opds.password} />
        <button type="button" class="copy-btn" onclick={() => void copyField("password", opds.password, passInput)}>{t("opds_copy_btn")}</button>
      </div>

      <textarea class="bulk-text" readonly rows="4" bind:this={bulkTextarea} value={bulkText()}></textarea>
      <button type="button" class="secondary copy-all-btn" onclick={() => void copyField("all", bulkText(), bulkTextarea)}>{t("opds_copy_all_btn")}</button>
      {#if copiedField}<p class="copy-status">{t("opds_copied")}</p>{/if}
      {#if copyFailedField}<p class="copy-status error-text">{t("opds_copy_failed")}</p>{/if}

      <label class="confirm-row">
        <input type="checkbox" bind:checked={confirmed} />
        {t("opds_confirm_saved_label")}
      </label>

      <h3>{t("opds_crosspoint_heading")}</h3>
      <ol>
        <li>{t("opds_crosspoint_step1")}</li>
        <li>{t("opds_crosspoint_step2")}</li>
        <li>{t("opds_crosspoint_step3")}</li>
        <li>{t("opds_crosspoint_step4")}</li>
        <li>{t("opds_crosspoint_step5")}</li>
        <li>{t("opds_crosspoint_step6")}</li>
      </ol>
    </div>
    <div class="dlg-actions">
      <button type="button" class="dlg-submit" onclick={requestClose}>{t("register_closed_close")}</button>
    </div>
  {/if}
</dialog>

<style>
  .warning { margin: 0 0 16px; padding: 10px 12px; border: 1px solid var(--error); border-radius: 4px; color: var(--error); font-size: 14px; line-height: 1.7; }
  .cred-row { display: grid; grid-template-columns: 100px 1fr auto; align-items: center; gap: 8px; margin-bottom: 10px; }
  .cred-label { font-size: 14px; color: var(--muted2); }
  .cred-row input {
    min-width: 0; padding: 8px 10px; font: inherit; font-family: var(--mono); font-size: 13px;
    border: 1.5px solid var(--line); border-radius: 4px; background: var(--card); color: var(--text);
  }
  .copy-btn {
    flex: none; padding: 8px 14px; font: inherit; font-size: 13px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer; white-space: nowrap;
  }
  .copy-btn:hover { background: var(--panel); }
  button.secondary {
    padding: 8px 18px; font: inherit; font-size: 14px; font-weight: 500; border-radius: 4px;
    border: 1px solid var(--ink); background: var(--card); color: var(--ink); cursor: pointer;
  }
  button.secondary:hover { background: var(--panel); }
  .bulk-text {
    width: 100%; box-sizing: border-box; margin-top: 4px; padding: 8px 10px; resize: vertical;
    font: inherit; font-family: var(--mono); font-size: 13px; line-height: 1.6;
    border: 1.5px solid var(--line); border-radius: 4px; background: var(--card); color: var(--text);
  }
  .copy-all-btn { margin: 8px 0 0; }
  .copy-status { margin: 8px 0 0; font-size: 13px; color: var(--muted2); }
  .confirm-row { display: flex; align-items: center; gap: 8px; margin: 18px 0 4px; font-size: 14px; cursor: pointer; }
  .confirm-row input { accent-color: var(--ink); cursor: pointer; }
  h3 { margin: 20px 0 8px; font-size: 14px; }
  ol { margin: 0; padding-left: 20px; color: var(--muted2); font-size: 14px; line-height: 1.7; }
  ol li + li { margin-top: 4px; }
</style>
