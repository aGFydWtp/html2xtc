// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

/**
 * Route-level wiring tests (spec §24.6): session auth, CSRF, the
 * OPDS_IMPORT_MODE feature-flag gate, and the response shape — with
 * src/integrations/opds/service.ts fully mocked out (its own logic is
 * covered by test/opds-integration-service.test.ts). Mirrors
 * test/library-routes-auto-add-device.test.ts's mocking convention.
 */

vi.mock("../src/auth/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/sessions")>();
  return { ...actual, requireSession: vi.fn(async () => ({ id: "acct-1", displayName: "Haruki" })) };
});

vi.mock("../src/auth/csrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/csrf")>();
  return { ...actual, verifyCsrf: vi.fn(() => ({ ok: true as const })) };
});

vi.mock("../src/integrations/opds/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/integrations/opds/service")>();
  return {
    ...actual,
    listOpdsConnections: vi.fn(async () => [
      { id: "conn-1", name: "Memlane", provider: "memlane", authType: "url_secret", host: "opds.example.com", lastVerifiedAt: null },
    ]),
    createOrReplaceOpdsConnection: vi.fn(async () => ({
      connection: { id: "conn-1", name: "Memlane", provider: "memlane", authType: "url_secret", host: "opds.example.com", lastVerifiedAt: "2026-01-01T00:00:00.000Z" },
    })),
    deleteOpdsConnectionForAccount: vi.fn(async () => undefined),
    fetchOpdsCatalogPage: vi.fn(async () => ({
      title: "Catalog",
      entries: [],
      nextCursor: null,
      previousCursor: null,
      searchSupported: false,
      searchCursor: null,
    })),
    startOpdsImport: vi.fn(async () => ({ jobId: "job-1", statusUrl: "/jobs/job-1" })),
  };
});

const { registerOpdsIntegrationRoutes } = await import("../src/integrations/opds/routes");
const { Router } = await import("../src/router");
const { requireSession } = await import("../src/auth/sessions");
const service = await import("../src/integrations/opds/service");
type Env = import("../src/types").Env;

// opds.catalog.fetch uses scope:"account" (accountRateLimitKey), which —
// unlike the default IP-scoped purposes — always produces a key and so
// always calls into RATE_LIMITER, even with no CF-Connecting-IP header on
// the test Request. A minimal always-allow stub keeps these route tests
// focused on auth/CSRF/feature-flag wiring rather than the rate limiter
// itself (covered separately by test/ratelimiter*.test.ts).
const FAKE_RATE_LIMITER = {
  idFromName: () => "fake-id",
  get: () => ({
    take: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    takeWithWindow: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  }),
};

function buildEnv(overrides: Record<string, unknown> = {}): Env {
  return { OPDS_IMPORT_MODE: "enabled", RATE_LIMITER: FAKE_RATE_LIMITER, ...overrides } as unknown as Env;
}

async function handle(request: Request, env: Env): Promise<Response> {
  const router = new Router();
  registerOpdsIntegrationRoutes(router);
  const response = await router.handle(request, env);
  expect(response).not.toBeNull();
  return response as Response;
}

describe("OPDS integration routes", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockClear();
    vi.mocked(requireSession).mockResolvedValue({ id: "acct-1", displayName: "Haruki" });
  });

  it("GET /api/integrations/opds returns 401 when not logged in", async () => {
    vi.mocked(requireSession).mockResolvedValueOnce(null);
    const response = await handle(new Request("https://example.com/api/integrations/opds"), buildEnv());
    expect(response.status).toBe(401);
  });

  it("GET /api/integrations/opds returns the connection list without secrets when logged in", async () => {
    const response = await handle(new Request("https://example.com/api/integrations/opds"), buildEnv());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { connections: unknown[] };
    expect(body.connections).toHaveLength(1);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("GET /api/integrations/opds returns 503 when OPDS_IMPORT_MODE is disabled", async () => {
    const response = await handle(
      new Request("https://example.com/api/integrations/opds"),
      buildEnv({ OPDS_IMPORT_MODE: "disabled" }),
    );
    expect(response.status).toBe(503);
  });

  it("GET /api/integrations/opds returns 503 when OPDS_IMPORT_MODE is unset (safe default)", async () => {
    const response = await handle(
      new Request("https://example.com/api/integrations/opds"),
      buildEnv({ OPDS_IMPORT_MODE: undefined }),
    );
    expect(response.status).toBe(503);
  });

  it("POST /api/integrations/opds creates a connection and returns 201", async () => {
    const response = await handle(
      new Request("https://example.com/api/integrations/opds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Memlane",
          provider: "memlane",
          authType: "url_secret",
          catalogUrl: "https://opds.example.com/secret/catalog",
        }),
      }),
      buildEnv(),
    );
    expect(response.status).toBe(201);
    expect(vi.mocked(service.createOrReplaceOpdsConnection)).toHaveBeenCalledTimes(1);
  });

  it("DELETE /api/integrations/opds/:connectionId returns 204", async () => {
    const response = await handle(
      new Request("https://example.com/api/integrations/opds/conn-1", { method: "DELETE" }),
      buildEnv(),
    );
    expect(response.status).toBe(204);
  });

  it("GET .../catalog returns the page shape (no raw URLs)", async () => {
    const response = await handle(
      new Request("https://example.com/api/integrations/opds/conn-1/catalog"),
      buildEnv(),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("http://");
  });

  it("GET .../catalog rejects a cross-site Sec-Fetch-Site (side-effecting GET, spec §21 review)", async () => {
    const callsBefore = vi.mocked(service.fetchOpdsCatalogPage).mock.calls.length;
    const response = await handle(
      new Request("https://example.com/api/integrations/opds/conn-1/catalog", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      }),
      buildEnv(),
    );
    expect(response.status).toBe(403);
    expect(vi.mocked(service.fetchOpdsCatalogPage).mock.calls.length).toBe(callsBefore);
  });

  it("GET .../catalog allows a missing Sec-Fetch-Site (native tools/older clients)", async () => {
    const response = await handle(
      new Request("https://example.com/api/integrations/opds/conn-1/catalog"),
      buildEnv(),
    );
    expect(response.status).toBe(200);
  });

  it("GET .../catalog rejects a search query longer than 256 characters", async () => {
    const callsBefore = vi.mocked(service.fetchOpdsCatalogPage).mock.calls.length;
    const response = await handle(
      new Request(
        `https://example.com/api/integrations/opds/conn-1/catalog?search=${"a".repeat(257)}`,
      ),
      buildEnv(),
    );
    expect(response.status).toBe(400);
    expect(vi.mocked(service.fetchOpdsCatalogPage).mock.calls.length).toBe(callsBefore);
  });

  it("POST .../import returns 202 with jobId/statusUrl", async () => {
    const response = await handle(
      new Request("https://example.com/api/integrations/opds/conn-1/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acquisitionCursor: "cursor-value", epubOptions: {} }),
      }),
      buildEnv(),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string; statusUrl: string };
    expect(body).toEqual({ jobId: "job-1", statusUrl: "/jobs/job-1" });
  });
});
