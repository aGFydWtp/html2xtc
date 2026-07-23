// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it, vi } from "vitest";

// src/index.ts pulls in src/ratelimiter.ts (DurableObject) and
// src/container.ts (@cloudflare/containers, which needs WorkerEntrypoint
// too) — both resolve cloudflare:workers imports only under the real
// workerd runtime. Same stub shape as test/ratelimiter-scope-global.test.ts,
// extended with the WorkerEntrypoint export @cloudflare/containers needs.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {},
}));
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: class extends Error {} }));

const { default: worker } = await import("../src/index");
type Env = import("../src/types").Env;

/**
 * 登録モード仕様 Phase3 §7: CONVERSION_MODE ゲート。/convert・/jobs・
 * /jobs/pdf・/jobs/text・/jobs/epub の5分岐すべてで、メソッドチェック直後・他の
 * バインディング(R2/AOZORA_DB/BROWSER/CONVERT_WORKFLOW等)に触れる前に
 * ゲートが効くことを、実際の fetch ハンドラ経由で確認する。CF-Connecting-IP
 * を付けないため enforceRateLimit は毎回スキップされ、RATE_LIMITER binding
 * は disabled/enabled いずれのケースも不要
 * （disabled はゲートで即リターン、enabled 側は各ハンドラの早期バリデーション
 * — Content-Type / JSON parse 失敗 — で止まるので、そもそも到達しない）。
 */

function minimalEnv(extra: Record<string, string> = {}): Env {
  return { ...extra } as unknown as Env;
}

// worker.fetch's Request type carries the Workers-runtime `cf` property
// shape (IncomingRequestCfProperties), which plain DOM `new Request(...)`
// (RequestInitCfProperties) doesn't structurally satisfy — cast once here
// rather than at every call site below.
function fetchPath(path: string, init: RequestInit, env: Env): Promise<Response> {
  return worker.fetch(new Request(`https://example.com${path}`, init) as never, env);
}

const ENDPOINTS: { path: string; init: RequestInit }[] = [
  { path: "/convert", init: { method: "POST", body: "not json" } },
  { path: "/jobs", init: { method: "POST", body: "not json" } },
  { path: "/jobs/pdf", init: { method: "POST", headers: { "Content-Type": "application/pdf" } } },
  { path: "/jobs/text", init: { method: "POST", headers: { "Content-Type": "text/plain" } } },
  { path: "/jobs/epub", init: { method: "POST", headers: { "Content-Type": "application/epub+zip" } } },
];

describe("CONVERSION_MODE gate — /convert, /jobs, /jobs/pdf, /jobs/text, /jobs/epub", () => {
  for (const { path, init } of ENDPOINTS) {
    it(`${path}: rejects with 503 "conversion is currently disabled" before touching any other binding`, async () => {
      const env = minimalEnv({ CONVERSION_MODE: "disabled" });
      const response = await fetchPath(path, init, env);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("conversion is currently disabled");
    });

    it(`${path}: does not return the disabled gate response when CONVERSION_MODE is unset (default enabled — non-regression)`, async () => {
      const env = minimalEnv();
      const response = await fetchPath(path, init, env);
      // Proceeds past the gate to some other (early, header/body-shape)
      // rejection instead — never the 503 conversion-disabled response.
      expect(response.status).not.toBe(503);
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      expect(body?.error).not.toBe("conversion is currently disabled");
    });

    it(`${path}: does not return the disabled gate response on an unrecognized CONVERSION_MODE value (falls back to enabled)`, async () => {
      const env = minimalEnv({ CONVERSION_MODE: "banana" });
      const response = await fetchPath(path, init, env);
      expect(response.status).not.toBe(503);
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      expect(body?.error).not.toBe("conversion is currently disabled");
    });
  }

  it("does not gate GET /jobs/:jobId (status lookup stays available even when CONVERSION_MODE is disabled)", async () => {
    const env = minimalEnv({ CONVERSION_MODE: "disabled" });
    const response = await fetchPath("/jobs/some-job-id", { method: "GET" }, env);
    expect(response.status).not.toBe(503);
  });
});
