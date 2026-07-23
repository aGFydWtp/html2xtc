<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { authStore } from "../lib/auth.svelte";
  import { closeRegistrationDialog, registrationDialog } from "../lib/authDialogs.svelte";
  import { t } from "../lib/i18n.svelte";
  import { publicConfigStore } from "../lib/publicConfig.svelte";
  import { removeTurnstile, resetTurnstile, waitForTurnstile } from "../lib/turnstile";

  let dlg = $state<HTMLDialogElement | null>(null);
  let displayName = $state("");
  let agreedTerms = $state(false);
  let agreedPrivacy = $state(false);
  let turnstileToken = $state<string | null>(null);
  let turnstileContainer = $state<HTMLDivElement | null>(null);
  let turnstileWidgetId: string | null = null;
  let turnstileStatus = $state<"loading" | "ready" | "unavailable">("loading");
  // 登録成功後、招待/公開いずれの新規アカウント作成でもバックアップパスキー
  // の追加を促す案内へ切り替える（登録モード仕様 Phase2 §5.2 (6) / 仕様6）。
  // isAddMode（既存アカウントへの追加登録）はそもそも「2本目」を今まさに
  // 登録している最中なのでこの案内は出さず、従来通り即座に閉じる。
  let step = $state<"form" | "done">("form");
  let addingBackupPasskey = $state(false);

  const isAddMode = $derived(registrationDialog.mode === "add");
  const isOpenMode = $derived(registrationDialog.mode === "open");
  // Opening a ?register=<token> invite link while already logged in must
  // never silently add a passkey to the logged-in account instead of
  // creating the new one the invite was meant for (plan §16 review M2) — so
  // this state short-circuits both the submit handler and the normal
  // new-account form below. Open registration has no such conflict: Header
  // only offers its "新規登録" entry in the logged-out menu branch, so this
  // dialog is never opened in mode "open" while authStore.account is set.
  const loggedInConflict = $derived(registrationDialog.mode === "invite" && authStore.account !== null);

  const turnstileSiteKeyPresent = $derived(publicConfigStore.turnstileSiteKey !== null);

  const submitDisabled = $derived(
    authStore.busy
    || (registrationDialog.mode === "invite" && !displayName.trim())
    || (isOpenMode && (
      !displayName.trim()
      || !agreedTerms
      || !agreedPrivacy
      || (turnstileSiteKeyPresent && (turnstileToken === null || turnstileStatus !== "ready"))
    )),
  );

  $effect(() => {
    if (!dlg) return;
    if (registrationDialog.open) {
      if (!dlg.open) {
        displayName = "";
        agreedTerms = false;
        agreedPrivacy = false;
        turnstileToken = null;
        step = "form";
        authStore.errorCode = null;
        dlg.showModal();
      }
    } else if (dlg.open) {
      dlg.close();
    }
  });

  // Turnstile ウィジェットの描画/破棄（登録モード仕様 Phase2 §5.2 (4)）。
  // isOpenMode かつダイアログが開いていて turnstileSiteKey が設定されている
  // 場合のみ描画する — 未設定（自己ホスト等でTurnstile無効）ならウィジェット
  // 自体を出さない。api.js は frontend/index.html に defer で読み込まれる
  // ため window.turnstile の出現をポーリングで待つ（turnstile.ts）。
  // 依存: turnstileContainer は step が "form"→"done" に変わる、または
  // ダイアログが閉じることで unmount され null に戻り、その度にこの effect
  // のクリーンアップ（ウィジェット破棄）が走る。
  $effect(() => {
    if (!isOpenMode || !registrationDialog.open || !turnstileContainer || !turnstileSiteKeyPresent) return;
    let cancelled = false;
    turnstileStatus = "loading";
    void waitForTurnstile().then((api) => {
      if (cancelled || !turnstileContainer) return;
      if (!api) {
        turnstileStatus = "unavailable";
        return;
      }
      turnstileWidgetId = api.render(turnstileContainer, {
        sitekey: publicConfigStore.turnstileSiteKey ?? "",
        callback: (token) => { turnstileToken = token; },
        "expired-callback": () => { turnstileToken = null; },
        "error-callback": () => { turnstileToken = null; },
      });
      turnstileStatus = "ready";
    });
    return () => {
      cancelled = true;
      if (turnstileWidgetId !== null) {
        removeTurnstile(turnstileWidgetId);
        turnstileWidgetId = null;
      }
      turnstileToken = null;
    };
  });

  function onDialogClick(event: MouseEvent): void {
    if (event.target === dlg) closeRegistrationDialog();
  }

  function registerErrorText(code: string | null): string {
    switch (code) {
      case "REGISTRATION_CAPACITY_REACHED": return t("register_error_capacity_reached");
      case "REGISTRATION_VERIFICATION_UNAVAILABLE": return t("register_error_verification_unavailable");
      case "INVALID_TURNSTILE_TOKEN": return t("register_error_invalid_turnstile");
      case "TERMS_VERSION_MISMATCH": return t("register_error_terms_mismatch");
      default: return isOpenMode ? t("register_open_failed") : t("register_failed");
    }
  }

  async function onSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (loggedInConflict) return;
    let ok: boolean;
    if (isAddMode) {
      ok = await authStore.addPasskey();
    } else if (isOpenMode) {
      ok = await authStore.register({
        displayName: displayName.trim(),
        turnstileToken: turnstileToken ?? undefined,
        acceptedTermsVersion: publicConfigStore.termsVersion ?? undefined,
      });
      // Turnstile トークンは1回限り — 成功/失敗いずれでも使い切りなので、
      // ウィジェットを再描画して次の送信（失敗時の再試行）に備える。
      turnstileToken = null;
      if (turnstileWidgetId !== null) resetTurnstile(turnstileWidgetId);
    } else {
      ok = await authStore.register({
        inviteToken: registrationDialog.inviteToken ?? undefined,
        displayName: displayName.trim(),
      });
    }
    if (!ok) return;
    if (isAddMode) {
      closeRegistrationDialog();
      return;
    }
    step = "done";
  }

  async function onAddBackupPasskey(): Promise<void> {
    addingBackupPasskey = true;
    await authStore.addPasskey();
    addingBackupPasskey = false;
    closeRegistrationDialog();
  }

  async function onLogoutClick(): Promise<void> {
    await authStore.logout();
  }
</script>

<dialog
  class="simple-dialog"
  bind:this={dlg}
  aria-labelledby="reg-dialog-title"
  onclick={onDialogClick}
  onclose={() => closeRegistrationDialog()}
>
  <div class="dlg-head">
    <span class="dlg-title" id="reg-dialog-title">
      {isAddMode ? t("account_add_passkey") : isOpenMode ? t("register_open_dialog_title") : t("register_dialog_title")}
    </span>
    <button type="button" class="dlg-x" aria-label={t("cancel")} onclick={() => closeRegistrationDialog()}>×</button>
  </div>

  {#if step === "done"}
    <div class="dlg-body">
      <p class="reg-intro">{t("register_done_message")}</p>
    </div>
    <div class="dlg-actions">
      <button type="button" class="dlg-cancel" disabled={addingBackupPasskey} onclick={() => closeRegistrationDialog()}>{t("register_done_later")}</button>
      <button type="button" class="dlg-submit" disabled={addingBackupPasskey} onclick={() => void onAddBackupPasskey()}>{t("register_done_add_passkey")}</button>
    </div>
  {:else}
    <form onsubmit={(e) => void onSubmit(e)}>
      <div class="dlg-body">
        {#if loggedInConflict}
          <p class="reg-intro">{t("register_logged_in_conflict")(authStore.account?.displayName ?? "")}</p>
        {:else if isAddMode}
          <p class="reg-intro">{t("account_add_passkey_intro")}</p>
        {:else}
          {#if isOpenMode}
            <p class="reg-warning">{t("register_open_warning")}</p>
          {/if}
          <label class="field">
            <span>{t("register_display_name_label")}</span>
            <input type="text" bind:value={displayName} required maxlength="100" placeholder={t("register_display_name_placeholder")} />
          </label>
          {#if isOpenMode}
            <label class="check-field">
              <input type="checkbox" bind:checked={agreedTerms} />
              <span>{t("register_terms_agree_before")}<a href="/about#terms" target="_blank" rel="noopener">{t("register_terms_link")}</a>{t("register_terms_agree_after")}</span>
            </label>
            <label class="check-field">
              <input type="checkbox" bind:checked={agreedPrivacy} />
              <!-- 利用規約・プライバシーは frontend/public/about.html に掲載 -->
              <span>{t("register_privacy_agree_before")}<a href="/about#privacy" target="_blank" rel="noopener">{t("register_privacy_link")}</a>{t("register_privacy_agree_after")}</span>
            </label>
            {#if turnstileSiteKeyPresent}
              <div class="turnstile-field">
                <div bind:this={turnstileContainer}></div>
                {#if turnstileStatus === "unavailable"}
                  <p class="error-text">{t("register_turnstile_unavailable")}</p>
                {/if}
              </div>
            {/if}
          {/if}
        {/if}
        {#if authStore.errorCode}<div class="error-text">{registerErrorText(authStore.errorCode)}</div>{/if}
      </div>
      <div class="dlg-actions">
        {#if loggedInConflict}
          <button type="button" class="dlg-cancel" onclick={() => closeRegistrationDialog()}>{t("cancel")}</button>
          <button type="button" class="dlg-submit" onclick={() => void onLogoutClick()}>{t("account_logout")}</button>
        {:else}
          <button type="button" class="dlg-cancel" onclick={() => closeRegistrationDialog()}>{t("cancel")}</button>
          <button type="submit" class="dlg-submit" disabled={submitDisabled}>{t("register_submit")}</button>
        {/if}
      </div>
    </form>
  {/if}
</dialog>

<style>
  .reg-intro { margin: 0; color: var(--muted2); font-size: 14px; line-height: 1.7; }
  .reg-warning {
    margin: 0 0 14px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 4px;
    background: var(--panel); color: var(--muted2); font-size: 13px; line-height: 1.6;
  }
  .check-field {
    display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: var(--muted2);
    line-height: 1.6; margin-bottom: 12px; cursor: pointer;
  }
  .check-field input[type="checkbox"] { margin-top: 3px; flex: none; }
  .check-field a { text-decoration: underline; }
  .turnstile-field { margin-bottom: 12px; }
</style>
