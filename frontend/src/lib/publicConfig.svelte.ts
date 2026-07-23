// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/public/config を起動時に一度だけ取得して保持する軽量ストア
// （登録モード仕様 Phase2 §5.2 (1) / src/public-config.ts が返す形と対応）。
// registrationMode はサーバー側の設定（REGISTRATION_MODE）が決める値で、
// フロント側では特定のモードを前提にしない。mode === "open" 限定の UI
// （Header の「新規登録」、PasskeyRegistrationDialog の公開登録フォーム）は
// このストアが保持する値だけを見て出し分ける。
// 取得前・取得失敗時は既定値（invite 相当・登録UIなし）のまま fail-safe。

import { apiGet } from "./api";

export type RegistrationMode = "invite" | "open" | "closed";

export interface PublicConfigLimits {
  maxLibraryItemsPerAccount: number;
  maxLibraryBytesPerAccount: number;
  maxDevicesPerAccount: number;
  maxActiveSessionsPerAccount: number;
  maxPasskeysPerAccount: number;
}

interface PublicConfigResponse {
  registrationMode?: unknown;
  registrationAvailable?: unknown;
  registrationReason?: unknown;
  registrationMessage?: unknown;
  termsVersion?: unknown;
  limits?: unknown;
  turnstileSiteKey?: unknown;
}

function parseLimits(raw: unknown): PublicConfigLimits | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.maxLibraryItemsPerAccount !== "number"
    || typeof r.maxLibraryBytesPerAccount !== "number"
    || typeof r.maxDevicesPerAccount !== "number"
    || typeof r.maxActiveSessionsPerAccount !== "number"
    || typeof r.maxPasskeysPerAccount !== "number"
  ) {
    return null;
  }
  return {
    maxLibraryItemsPerAccount: r.maxLibraryItemsPerAccount,
    maxLibraryBytesPerAccount: r.maxLibraryBytesPerAccount,
    maxDevicesPerAccount: r.maxDevicesPerAccount,
    maxActiveSessionsPerAccount: r.maxActiveSessionsPerAccount,
    maxPasskeysPerAccount: r.maxPasskeysPerAccount,
  };
}

class PublicConfigStore {
  // 既定値は「invite・登録不可」— サーバー未応答/エラー時も open 専用 UI が
  // 誤って出てこないための fail-safe（登録 UI なしの見た目に倒す）。
  registrationMode = $state<RegistrationMode>("invite");
  registrationAvailable = $state(false);
  // 登録モード仕様 Phase3 §4: mode==="closed" のときだけ意味を持つ。公開可
  // 理由(maintenance/capacity/manual)ではコード値が入り、非公開理由/未設定
  // では null（サーバー側が既に security/abuse という値自体を返さない —
  // src/public-config.ts 参照）。
  registrationReason = $state<string | null>(null);
  registrationMessage = $state<string | null>(null);
  termsVersion = $state<string | null>(null);
  turnstileSiteKey = $state<string | null>(null);
  limits = $state<PublicConfigLimits | null>(null);
  loaded = $state(false);

  async init(): Promise<void> {
    try {
      const body = await apiGet<PublicConfigResponse>("/api/public/config");
      if (body.registrationMode === "invite" || body.registrationMode === "open" || body.registrationMode === "closed") {
        this.registrationMode = body.registrationMode;
      }
      if (typeof body.registrationAvailable === "boolean") {
        this.registrationAvailable = body.registrationAvailable;
      }
      this.registrationReason = typeof body.registrationReason === "string" ? body.registrationReason : null;
      this.registrationMessage = typeof body.registrationMessage === "string" ? body.registrationMessage : null;
      if (typeof body.termsVersion === "string" && body.termsVersion.length > 0) {
        this.termsVersion = body.termsVersion;
      }
      if (typeof body.turnstileSiteKey === "string" && body.turnstileSiteKey.length > 0) {
        this.turnstileSiteKey = body.turnstileSiteKey;
      }
      this.limits = parseLimits(body.limits);
    } catch {
      // 取得失敗時は既定値（invite・登録不可）のまま — fail-safe。
    } finally {
      this.loaded = true;
    }
  }
}

export const publicConfigStore = new PublicConfigStore();
