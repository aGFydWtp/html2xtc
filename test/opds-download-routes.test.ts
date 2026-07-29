// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { beforeEach, describe, expect, it, vi } from "vitest";

// src/opds/routes.ts pulls in src/ratelimiter.ts (for the device-auth-failure
// limiter), which imports DurableObject from cloudflare:workers at module top
// level — that only resolves under the real workerd runtime. Same stub as
// test/devices-pairing-mode.test.ts / test/ratelimiter-scope-global.test.ts.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

/**
 * Route-level tests for GET /api/device/library-items/:itemId/download.xtc
 * and its backward-compatible alias GET .../download (plan §6.2 / §9). Both
 * are registered by the same registerOpdsRoutes() call and delegate to the
 * same internal handler, so every test below exercises the pair together
 * unless a case is specific to one of the two URLs.
 *
 * Mocking boundary mirrors test/library-routes-auto-add-device.test.ts:
 * authenticateDevice (src/devices/authentication.ts) and
 * getAssignedLibraryItemForDownload (src/opds/repository.ts) are mocked so
 * auth/authorization outcomes are controlled directly without a D1 fixture;
 * touchLastSeenIfStale (src/devices/last-seen.ts) is mocked for the same
 * reason (it otherwise writes to D1). env.XTC_BUCKET.get is a plain vi.fn
 * stub — R2Bucket has no lightweight in-memory fake in this codebase.
 * logAuditEvent (src/security/audit.ts) is left real; its JSON.stringify
 * output is asserted via a console.log spy, which exercises the actual
 * event-shape contract rather than a mock of it.
 */

vi.mock("../src/devices/authentication", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/devices/authentication")>();
  return { ...actual, authenticateDevice: vi.fn() };
});

vi.mock("../src/opds/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/opds/repository")>();
  return { ...actual, getAssignedLibraryItemForDownload: vi.fn() };
});

vi.mock("../src/devices/last-seen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/devices/last-seen")>();
  return { ...actual, touchLastSeenIfStale: vi.fn(async () => undefined) };
});

const { registerOpdsRoutes } = await import("../src/opds/routes");
const { Router } = await import("../src/router");
const { authenticateDevice } = await import("../src/devices/authentication");
const { getAssignedLibraryItemForDownload } = await import("../src/opds/repository");
const { touchLastSeenIfStale } = await import("../src/devices/last-seen");
type Env = import("../src/types").Env;
type AuthenticatedDevice = import("../src/devices/authentication").AuthenticatedDevice;
type AssignedDownloadItem = import("../src/opds/repository").AssignedDownloadItem;

const DEVICE: AuthenticatedDevice = {
  deviceId: "device-1",
  accountId: "acct-1",
  name: "X3",
  lastSeenAt: null,
};

const ITEM: AssignedDownloadItem = {
  id: "item-1",
  title: "テスト本",
  r2Key: "library/item-1.xtc",
};

const XTC_BYTES = new TextEncoder().encode("fake xtc bytes");

function makeR2Object(): { body: ReadableStream<Uint8Array>; size: number; httpEtag: string } {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(XTC_BYTES);
        controller.close();
      },
    }),
    size: XTC_BYTES.byteLength,
    httpEtag: '"etag-item-1"',
  };
}

function makeEnv(bucketGet: (key: string) => unknown): Env {
  return {
    APP_DB: {} as unknown,
    XTC_BUCKET: { get: vi.fn(bucketGet) } as unknown,
    RATE_LIMITER: {} as unknown,
  } as unknown as Env;
}

function makeRouter() {
  const router = new Router();
  registerOpdsRoutes(router);
  return router;
}

async function download(router: InstanceType<typeof Router>, env: Env, path: string): Promise<Response> {
  const response = await router.handle(
    new Request(`https://example.com${path}`, { headers: { Authorization: "Basic ZGV2aWNlLTE6dG9rZW4=" } }),
    env,
  );
  expect(response).not.toBeNull();
  return response as Response;
}

describe("GET /api/device/library-items/:itemId/download.xtc and legacy /download", () => {
  beforeEach(() => {
    vi.mocked(authenticateDevice).mockReset();
    vi.mocked(getAssignedLibraryItemForDownload).mockReset();
    vi.mocked(touchLastSeenIfStale).mockReset().mockResolvedValue(undefined);
  });

  for (const path of [
    "/api/device/library-items/item-1/download.xtc",
    "/api/device/library-items/item-1/download",
  ]) {
    it(`${path} succeeds with the vendor XTC media type and R2-backed headers`, async () => {
      vi.mocked(authenticateDevice).mockResolvedValue(DEVICE);
      vi.mocked(getAssignedLibraryItemForDownload).mockResolvedValue(ITEM);
      const env = makeEnv(() => makeR2Object());
      const router = makeRouter();

      const response = await download(router, env, path);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/vnd.xteink.xtc");
      expect(response.headers.get("Content-Disposition")).toMatch(/\.xtc/);
      expect(response.headers.get("ETag")).toBe('"etag-item-1"');
      expect(response.headers.get("Content-Length")).toBe(String(XTC_BYTES.byteLength));
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });
  }

  it("both routes return byte-identical bodies for the same item", async () => {
    vi.mocked(authenticateDevice).mockResolvedValue(DEVICE);
    vi.mocked(getAssignedLibraryItemForDownload).mockResolvedValue(ITEM);
    const env = makeEnv(() => makeR2Object());
    const router = makeRouter();

    const xtcResponse = await download(router, env, "/api/device/library-items/item-1/download.xtc");
    const legacyResponse = await download(router, env, "/api/device/library-items/item-1/download");

    const [xtcBody, legacyBody] = await Promise.all([xtcResponse.arrayBuffer(), legacyResponse.arrayBuffer()]);
    expect(new Uint8Array(xtcBody)).toEqual(new Uint8Array(legacyBody));
  });

  it("returns 401 when device authentication fails (unknown device / bad token)", async () => {
    vi.mocked(authenticateDevice).mockResolvedValue(null);
    const env = makeEnv(() => makeR2Object());
    const router = makeRouter();

    const response = await download(router, env, "/api/device/library-items/item-1/download.xtc");

    expect(response.status).toBe(401);
    expect(getAssignedLibraryItemForDownload).not.toHaveBeenCalled();
  });

  it("returns 401 for a revoked device — authenticateDevice already collapses this to null, same as any other auth failure", async () => {
    vi.mocked(authenticateDevice).mockResolvedValue(null);
    const env = makeEnv(() => makeR2Object());
    const router = makeRouter();

    const response = await download(router, env, "/api/device/library-items/item-1/download");

    expect(response.status).toBe(401);
  });

  it("returns 404 ITEM_NOT_FOUND when the item is assigned to a different device (not this one)", async () => {
    vi.mocked(authenticateDevice).mockResolvedValue(DEVICE);
    vi.mocked(getAssignedLibraryItemForDownload).mockResolvedValue(null);
    const env = makeEnv(() => makeR2Object());
    const router = makeRouter();

    const response = await download(router, env, "/api/device/library-items/item-1/download.xtc");

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ITEM_NOT_FOUND");
  });

  it("returns 404 ITEM_NOT_FOUND (indistinguishable from unassigned) when the R2 object is missing", async () => {
    vi.mocked(authenticateDevice).mockResolvedValue(DEVICE);
    vi.mocked(getAssignedLibraryItemForDownload).mockResolvedValue(ITEM);
    const env = makeEnv(() => null);
    const router = makeRouter();

    const response = await download(router, env, "/api/device/library-items/item-1/download.xtc");

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ITEM_NOT_FOUND");
  });

  it("on success, refreshes last_seen_at and logs a device.download.completed audit event", async () => {
    vi.mocked(authenticateDevice).mockResolvedValue(DEVICE);
    vi.mocked(getAssignedLibraryItemForDownload).mockResolvedValue(ITEM);
    const env = makeEnv(() => makeR2Object());
    const router = makeRouter();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await download(router, env, "/api/device/library-items/item-1/download.xtc");

    expect(response.status).toBe(200);
    expect(touchLastSeenIfStale).toHaveBeenCalledTimes(1);
    expect(vi.mocked(touchLastSeenIfStale).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ deviceId: DEVICE.deviceId }),
    );

    const loggedEvents = consoleSpy.mock.calls.map((call) => JSON.parse(call[0] as string) as { event: string });
    const auditEvent = loggedEvents.find((event) => event.event === "device.download.completed");
    expect(auditEvent).toEqual(
      expect.objectContaining({
        event: "device.download.completed",
        accountId: DEVICE.accountId,
        deviceId: DEVICE.deviceId,
        itemId: ITEM.id,
      }),
    );

    consoleSpy.mockRestore();
  });
});
