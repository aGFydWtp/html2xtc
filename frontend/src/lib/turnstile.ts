// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloudflare Turnstile ウィジェットのブラウザ側ラッパー（登録モード仕様
// Phase2 §5.2 (4)）。公式スクリプト（https://challenges.cloudflare.com/
// turnstile/v0/api.js）は frontend/index.html に <script defer> で読み込む
// — defer のためダイアログを開くユーザー操作より読み込みが遅れることが
// あり、window.turnstile の出現をポーリングで待つ必要がある。

export interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
}

export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

function getTurnstileApi(): TurnstileApi | null {
  const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
  return api ?? null;
}

const POLL_INTERVAL_MS = 150;
const POLL_TIMEOUT_MS = 10_000;

/**
 * window.turnstile が使えるようになるまで待つ。api.js のロード失敗・
 * ネットワーク遮断・広告ブロッカー等で読み込まれない場合は
 * POLL_TIMEOUT_MS で諦めて null を返す — 呼び出し側（PasskeyRegistrationDialog）
 * はこれを「認証ウィジェットを読み込めませんでした」表示にフォールバックし、
 * 送信ボタンを無効のままにする（fail-closed、仕様4c と同じ方向性）。
 */
export function waitForTurnstile(): Promise<TurnstileApi | null> {
  const existing = getTurnstileApi();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const api = getTurnstileApi();
      if (api) {
        clearInterval(interval);
        resolve(api);
        return;
      }
      if (Date.now() - start > POLL_TIMEOUT_MS) {
        clearInterval(interval);
        resolve(null);
      }
    }, POLL_INTERVAL_MS);
  });
}

export function resetTurnstile(widgetId: string): void {
  getTurnstileApi()?.reset(widgetId);
}

export function removeTurnstile(widgetId: string): void {
  getTurnstileApi()?.remove(widgetId);
}
