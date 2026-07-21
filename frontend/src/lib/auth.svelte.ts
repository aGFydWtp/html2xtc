// SPDX-License-Identifier: AGPL-3.0-or-later
// パスキー認証・セッション状態（実装計画 §5.1 / §9.1）。
// account: ログイン中のアカウント。null は未ログイン。ready は /api/me の
// 初回取得が完了したかどうか（未確定の間はログインボタンを出さない）。

import { apiGet, apiSend, ApiError } from "./api";
import { startAuthentication, startRegistration } from "./passkeys";

export interface Account {
  id: string;
  displayName: string;
}

export interface SessionEntry {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

interface AccountResponse {
  account?: unknown;
}
interface SessionsResponse {
  sessions?: unknown;
}
interface OptionsResponse {
  options?: unknown;
}

function parseAccount(raw: unknown): Account | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.displayName !== "string") return null;
  return { id: r.id, displayName: r.displayName };
}

function parseSessions(raw: unknown): SessionEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionEntry[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    if (
      typeof r.id !== "string"
      || typeof r.createdAt !== "string"
      || typeof r.lastSeenAt !== "string"
      || typeof r.expiresAt !== "string"
    ) continue;
    out.push({
      id: r.id,
      userAgent: typeof r.userAgent === "string" ? r.userAgent : null,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt,
      isCurrent: r.isCurrent === true,
    });
  }
  return out;
}

function errorCodeOf(e: unknown): string {
  // ApiError はサーバーの {error:{code}} をそのまま使う。それ以外
  // （navigator.credentials 呼び出しの失敗・ユーザーによるキャンセル等）は
  // 汎用コードにまとめる — 失敗理由を細かく区別して見せる必要はない。
  if (e instanceof ApiError) return e.code ?? "UNKNOWN";
  return "PASSKEY_FAILED";
}

class AuthStore {
  account = $state<Account | null>(null);
  ready = $state(false);
  busy = $state(false);
  errorCode = $state<string | null>(null);
  sessions = $state<SessionEntry[]>([]);

  async init(): Promise<void> {
    await this.refresh();
    this.ready = true;
  }

  async refresh(): Promise<void> {
    try {
      const body = await apiGet<AccountResponse>("/api/me");
      this.account = parseAccount(body.account);
    } catch {
      // 401（未ログイン）も含め、失敗時は未ログイン扱いにする（fail-safe）。
      this.account = null;
    }
  }

  /**
   * inviteToken 指定時は新規アカウント作成、未指定時はログイン中アカウントへの
   * 追加パスキー登録（サーバー側がセッションから既存アカウントを判定する）。
   */
  async register(inviteToken: string | undefined, displayName: string): Promise<boolean> {
    this.busy = true;
    this.errorCode = null;
    try {
      const optionsBody = await apiSend<OptionsResponse>("POST", "/api/auth/registration/options", {
        inviteToken,
        displayName,
      });
      const credential = await startRegistration(optionsBody.options);
      const verifyBody = await apiSend<AccountResponse>("POST", "/api/auth/registration/verify", {
        response: credential,
      });
      const account = parseAccount(verifyBody.account);
      if (!account) {
        this.errorCode = "UNKNOWN";
        return false;
      }
      this.account = account;
      return true;
    } catch (e) {
      this.errorCode = errorCodeOf(e);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** ログイン中アカウントへ追加のパスキーを登録する（招待コード不要）。 */
  async addPasskey(): Promise<boolean> {
    if (!this.account) return false;
    return this.register(undefined, this.account.displayName);
  }

  async login(): Promise<boolean> {
    this.busy = true;
    this.errorCode = null;
    try {
      const optionsBody = await apiSend<OptionsResponse>("POST", "/api/auth/login/options", {});
      const credential = await startAuthentication(optionsBody.options);
      const verifyBody = await apiSend<AccountResponse>("POST", "/api/auth/login/verify", {
        response: credential,
      });
      const account = parseAccount(verifyBody.account);
      if (!account) {
        this.errorCode = "UNKNOWN";
        return false;
      }
      this.account = account;
      return true;
    } catch (e) {
      this.errorCode = errorCodeOf(e);
      return false;
    } finally {
      this.busy = false;
    }
  }

  async logout(): Promise<void> {
    try {
      await apiSend("POST", "/api/auth/logout", {});
    } catch {
      // 失敗してもUI上はログアウト扱いにする（Cookie失効はサーバー側の責務）。
    }
    this.account = null;
    this.sessions = [];
  }

  async loadSessions(): Promise<void> {
    try {
      const body = await apiGet<SessionsResponse>("/api/me/sessions");
      this.sessions = parseSessions(body.sessions);
    } catch {
      this.sessions = [];
    }
  }

  async revokeSession(id: string): Promise<boolean> {
    try {
      await apiSend("DELETE", `/api/me/sessions/${encodeURIComponent(id)}`);
      this.sessions = this.sessions.filter((s) => s.id !== id);
      return true;
    } catch {
      return false;
    }
  }
}

export const authStore = new AuthStore();
