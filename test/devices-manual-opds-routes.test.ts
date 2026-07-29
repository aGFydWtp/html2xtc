// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// src/devices/routes.ts pulls in src/ratelimiter.ts, which imports
// DurableObject from cloudflare:workers at module top level — that only
// resolves under the real workerd runtime. Same stub as
// test/devices-pairing-mode.test.ts.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

/**
 * Route-level tests for POST /api/devices/manual-opds and
 * POST /api/devices/:deviceId/rotate-token (Phase2 spec §8.1/§8.2/§13.1):
 * auth/CSRF gating, response shape (device + opds block), Cache-Control:
 * no-store, and audit-event emission without ever including the token.
 * src/devices/service.ts's createManualOpdsDevice/rotateDeviceToken are
 * mocked so these tests exercise only the HTTP adapter — the service logic
 * itself is covered by test/devices-manual-opds-service.test.ts and
 * test/devices-token-rotation-service.test.ts.
 */

let sessionAccount: { id: string; displayName: string } | null = { id: "acct-1", displayName: "Haruki" };
let csrfResult: { ok: true } | { ok: false; reason: string } = { ok: true };

vi.mock("../src/auth/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/sessions")>();
  return { ...actual, requireSession: vi.fn(async () => sessionAccount) };
});

vi.mock("../src/auth/csrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/csrf")>();
  return { ...actual, verifyCsrf: vi.fn(() => csrfResult) };
});

vi.mock("../src/devices/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/devices/service")>();
  return {
    ...actual,
    createManualOpdsDevice: vi.fn(),
    rotateDeviceToken: vi.fn(),
  };
});

const { registerDeviceRoutes } = await import("../src/devices/routes");
const { Router } = await import("../src/router");
const { createManualOpdsDevice, rotateDeviceToken } = await import("../src/devices/service");
const { ApiError } = await import("../src/security/errors");
type Env = import("../src/types").Env;
type DeviceCredentialResult = import("../src/devices/service").DeviceCredentialResult;

function makeEnv(): Env {
  return { WEBAUTHN_RP_ID: "xtc.example.com" } as unknown as Env;
}

function makeRouter() {
  const router = new Router();
  registerDeviceRoutes(router);
  return router;
}

function credentialResult(overrides: Partial<DeviceCredentialResult["device"]> = {}): DeviceCredentialResult {
  return {
    device: {
      id: "dev-1",
      name: "Xteink X3",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: null,
      device: "x3",
      width: 528,
      height: 792,
      registrationMethod: "manual_opds",
      ...overrides,
    },
    token: "plaintext-device-token",
  };
}

describe("POST /api/devices/manual-opds", () => {
  beforeEach(() => {
    sessionAccount = { id: "acct-1", displayName: "Haruki" };
    csrfResult = { ok: true };
    vi.mocked(createManualOpdsDevice).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function post(body: unknown): Promise<Response> {
    const response = await makeRouter().handle(
      new Request("https://example.com/api/devices/manual-opds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      makeEnv(),
    );
    expect(response).not.toBeNull();
    return response as Response;
  }

  it("returns 401 when not logged in", async () => {
    sessionAccount = null;
    const response = await post({ name: "Reader" });
    expect(response.status).toBe(401);
    expect(createManualOpdsDevice).not.toHaveBeenCalled();
  });

  it("returns 403 when CSRF verification fails", async () => {
    csrfResult = { ok: false, reason: "bad origin" };
    const response = await post({ name: "Reader" });
    expect(response.status).toBe(403);
    expect(createManualOpdsDevice).not.toHaveBeenCalled();
  });

  it("returns 400 INVALID_DEVICE_NAME when name is not a string, without calling the service", async () => {
    const response = await post({ name: 123 });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "INVALID_DEVICE_NAME" },
    });
    expect(createManualOpdsDevice).not.toHaveBeenCalled();
  });

  it("returns 201 with the device + opds connection info, Cache-Control: no-store, and logs an audit event without the token", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(createManualOpdsDevice).mockResolvedValue(credentialResult());

    const response = await post({ name: "Xteink X3", deviceModel: "x3" });

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as {
      device: { id: string; registrationMethod: string };
      opds: { serverName: string; catalogUrl: string; username: string; password: string };
    };
    expect(body.device.id).toBe("dev-1");
    expect(body.device.registrationMethod).toBe("manual_opds");
    expect(body.opds).toEqual({
      serverName: "html2xtc",
      catalogUrl: "https://xtc.example.com/opds/v1/catalog.xml",
      username: "dev-1",
      password: "plaintext-device-token",
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(logged.event).toBe("device.manual_opds.created");
    expect(logged.accountId).toBe("acct-1");
    expect(logged.deviceId).toBe("dev-1");
    expect(JSON.stringify(logged)).not.toContain("plaintext-device-token");
  });

  it("propagates a 409 DEVICE_LIMIT_EXCEEDED from the service unchanged", async () => {
    vi.mocked(createManualOpdsDevice).mockRejectedValue(new ApiError(409, "DEVICE_LIMIT_EXCEEDED", "device limit reached"));
    const response = await post({ name: "Reader" });
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "DEVICE_LIMIT_EXCEEDED" },
    });
  });
});

describe("POST /api/devices/:deviceId/rotate-token", () => {
  beforeEach(() => {
    sessionAccount = { id: "acct-1", displayName: "Haruki" };
    csrfResult = { ok: true };
    vi.mocked(rotateDeviceToken).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function rotate(deviceId = "dev-1"): Promise<Response> {
    const response = await makeRouter().handle(
      new Request(`https://example.com/api/devices/${deviceId}/rotate-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
      makeEnv(),
    );
    expect(response).not.toBeNull();
    return response as Response;
  }

  it("returns 401 when not logged in", async () => {
    sessionAccount = null;
    const response = await rotate();
    expect(response.status).toBe(401);
    expect(rotateDeviceToken).not.toHaveBeenCalled();
  });

  it("returns 403 when CSRF verification fails", async () => {
    csrfResult = { ok: false, reason: "bad origin" };
    const response = await rotate();
    expect(response.status).toBe(403);
    expect(rotateDeviceToken).not.toHaveBeenCalled();
  });

  it("returns 404 when the service reports the device missing/not owned", async () => {
    vi.mocked(rotateDeviceToken).mockRejectedValue(new ApiError(404, "DEVICE_NOT_FOUND", "device not found"));
    const response = await rotate("dev-missing");
    expect(response.status).toBe(404);
  });

  it("returns 409 DEVICE_REVOKED when the service reports the device revoked", async () => {
    vi.mocked(rotateDeviceToken).mockRejectedValue(new ApiError(409, "DEVICE_REVOKED", "device is revoked"));
    const response = await rotate();
    expect(response.status).toBe(409);
  });

  it("returns 200 with the new opds connection info, Cache-Control: no-store, and logs an audit event without the token", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(rotateDeviceToken).mockResolvedValue(credentialResult());

    const response = await rotate();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as {
      device: { id: string; name: string; status: string };
      opds: { serverName: string; catalogUrl: string; username: string; password: string };
    };
    expect(body.device).toEqual({ id: "dev-1", name: "Xteink X3", status: "active" });
    expect(body.opds).toEqual({
      serverName: "html2xtc",
      catalogUrl: "https://xtc.example.com/opds/v1/catalog.xml",
      username: "dev-1",
      password: "plaintext-device-token",
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(logged.event).toBe("device.token.rotated");
    expect(logged.accountId).toBe("acct-1");
    expect(logged.deviceId).toBe("dev-1");
    expect(JSON.stringify(logged)).not.toContain("plaintext-device-token");
  });
});
