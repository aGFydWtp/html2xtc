// SPDX-License-Identifier: AGPL-3.0-or-later
// ログイン・パスキー登録・ペアリング承認ダイアログの開閉状態。
// AozoraDialog（frontend/src/lib/aozora.svelte.ts）と同じ「open フラグを
// $state で保持し、コンポーネント側の $effect が dialog.showModal()/close() と
// 同期する」パターン。App.svelte から一度だけマウントされる各ダイアログを、
// Header 等の別コンポーネントから開けるようにするための共有状態。

export const loginDialog = $state({ open: false });

export function openLoginDialog(): void {
  loginDialog.open = true;
}
export function closeLoginDialog(): void {
  loginDialog.open = false;
}

// registrationDialog の3状態（登録モード仕様 Phase2 §5.2 (2)）:
//   "add"    ログイン中アカウントへの追加パスキー登録（招待不要）
//   "invite" ?register=<token> からの招待新規登録
//   "open"   未ログイン・招待なしの公開新規登録（mode==="open" のときだけ
//            Header から遷移可能 — publicConfig.svelte.ts 参照）
// inviteToken は mode==="invite" のときだけ意味を持つ（他モードでは null）。
// $state な discriminated union への部分的なプロパティ書き込みは TypeScript
// 上扱いにくいため（union 全体を通した書き込み可能型になってしまう）、
// あえてフラットな { mode, inviteToken } 構造にして呼び出し元の型だけ
// discriminated union にしている。
export type OpenRegistrationDialogParams =
  | { mode: "add" }
  | { mode: "invite"; inviteToken: string }
  | { mode: "open" };

export const registrationDialog = $state<{
  open: boolean;
  mode: "add" | "invite" | "open";
  inviteToken: string | null;
}>({
  open: false,
  mode: "add",
  inviteToken: null,
});

export function openRegistrationDialog(params: OpenRegistrationDialogParams): void {
  registrationDialog.mode = params.mode;
  registrationDialog.inviteToken = params.mode === "invite" ? params.inviteToken : null;
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

// アカウント画面（登録モード仕様 Phase1 §5.9）。Header のメニューから開く。
export const accountDialog = $state({ open: false });

export function openAccountDialog(): void {
  accountDialog.open = true;
}
export function closeAccountDialog(): void {
  accountDialog.open = false;
}
