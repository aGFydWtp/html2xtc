// SPDX-License-Identifier: AGPL-3.0-or-later
// ログイン・パスキー登録・ペアリング承認ダイアログの開閉状態。
// AozoraDialog（frontend/src/lib/aozora.svelte.ts）と同じ「open フラグを
// $state で保持し、コンポーネント側の $effect が dialog.showModal()/close() と
// 同期する」パターン。App.svelte から一度だけマウントされる各ダイアログを、
// AccountMenu 等の別コンポーネントから開けるようにするための共有状態。

export const loginDialog = $state({ open: false });

export function openLoginDialog(): void {
  loginDialog.open = true;
}
export function closeLoginDialog(): void {
  loginDialog.open = false;
}

// inviteToken === null は「ログイン中アカウントへの追加パスキー登録」、
// 非 null は「?register=<token> からの新規アカウント作成」。
export const registrationDialog = $state<{ open: boolean; inviteToken: string | null }>({
  open: false,
  inviteToken: null,
});

export function openRegistrationDialog(inviteToken: string | null): void {
  registrationDialog.inviteToken = inviteToken;
  registrationDialog.open = true;
}
export function closeRegistrationDialog(): void {
  registrationDialog.open = false;
}

export const pairingDialog = $state<{ open: boolean; code: string | null }>({
  open: false,
  code: null,
});

export function openPairingDialog(code: string): void {
  pairingDialog.code = code;
  pairingDialog.open = true;
}
export function closePairingDialog(): void {
  pairingDialog.open = false;
}
