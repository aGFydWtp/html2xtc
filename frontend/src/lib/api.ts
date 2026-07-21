// SPDX-License-Identifier: AGPL-3.0-or-later
// 認証・ライブラリ・端末 API 共通の fetch ヘルパー。
// エラー形式は {"error":{"code","message"}}（実装計画 §9）。既存の変換API
// （/convert, /jobs 等）が使う {"error":"..."} 形式とは別物なので混在させない。
// 変更系（POST/PATCH/PUT/DELETE）は Content-Type: application/json を必須と
// するサーバー側のCSRF対策があるため、常にこのヘッダーを付ける（実装計画
// §5.1「CSRF対策」）。Cookie はセッション認証用で same-origin fetch のため
// 明示指定不要（ブラウザが自動送信する）。

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown };
}

function parseError(body: unknown): { code: string | null; message: string | null } {
  if (!body || typeof body !== "object") return { code: null, message: null };
  const err = (body as ErrorBody).error;
  if (!err || typeof err !== "object") return { code: null, message: null };
  const code = typeof err.code === "string" ? err.code : null;
  const message = typeof err.message === "string" ? err.message : null;
  return { code, message };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, null, "network error");
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null) as unknown;
  if (!res.ok) {
    const { code, message } = parseError(body);
    throw new ApiError(res.status, code, message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

/** GET — no body, no CSRF headers needed. */
export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

/**
 * POST/PATCH/PUT/DELETE — always sends a JSON body (defaults to `{}`) and the
 * Content-Type header the server's CSRF check requires, even for routes that
 * don't otherwise need a body (e.g. DELETE, logout).
 */
export function apiSend<T>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}
