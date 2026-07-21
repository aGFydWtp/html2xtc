import { afterEach, describe, expect, it, vi } from "vitest";
import { logAuditEvent } from "../src/security/audit";

describe("logAuditEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a single JSON line with event, fields, and a timestamp", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logAuditEvent("device.download.completed", {
      accountId: "acc-1",
      deviceId: "dev-1",
      itemId: "item-1",
      sizeBytes: 12345,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(logged).toMatchObject({
      event: "device.download.completed",
      accountId: "acc-1",
      deviceId: "dev-1",
      itemId: "item-1",
      sizeBytes: 12345,
    });
    expect(typeof logged.timestamp).toBe("string");
    expect(() => new Date(logged.timestamp).toISOString()).not.toThrow();
  });

  it("logs an event with no fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logAuditEvent("auth.login.failed");
    const logged = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(logged.event).toBe("auth.login.failed");
    expect(typeof logged.timestamp).toBe("string");
  });

  it("rejects forbidden secret-shaped field names at compile time", () => {
    // @ts-expect-error deviceToken must never be an audit field.
    logAuditEvent("device.pairing.approved", { deviceToken: "should-not-compile" });
    // @ts-expect-error pairingSecret must never be an audit field.
    logAuditEvent("device.pairing.approved", { pairingSecret: "should-not-compile" });
    // @ts-expect-error a raw Authorization header must never be an audit field.
    logAuditEvent("device.opds.fetched", { authorization: "should-not-compile" });
  });
});
