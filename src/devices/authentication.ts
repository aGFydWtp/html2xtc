// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { sha256Hex, timingSafeEqual } from "../security/crypto";
import type { Env } from "../types";
import { getDeviceForAuth } from "./repository";

/**
 * Device-side authentication (plan §5.2 / §9.5): Basic auth with
 * username=deviceId, password=deviceToken, checked against the SHA-256 hash
 * stored on devices.token_hash (no pepper — plan §5.2 explicitly allows a
 * plain hash here since deviceToken is already 256 bits of entropy, unlike a
 * user-chosen password). Authentication is abstracted behind
 * DeviceAuthenticator (plan §5.2) so a future Ed25519-based
 * SignedDeviceRequestAuthenticator can be added without touching call
 * sites; none exist yet — the OPDS/download routes (a later phase) will be
 * the first callers of authenticateDevice().
 */

export interface AuthenticatedDevice {
  deviceId: string;
  accountId: string;
  name: string;
  /** Last-seen timestamp as of *before* this request — used by src/devices/last-seen.ts to decide whether this request should refresh it. */
  lastSeenAt: string | null;
}

export interface DeviceAuthenticator {
  authenticate(request: Request, env: Pick<Env, "APP_DB">): Promise<AuthenticatedDevice | null>;
}

const BASIC_AUTH_PREFIX = "Basic ";

/**
 * Parses an HTTP Basic Authorization header into {deviceId, deviceToken}.
 * Pure (no D1/Request dependency beyond the header string itself), so it's
 * directly unit-testable (see test/devices-authentication.test.ts), including
 * the "reject malformed base64" case from plan §18.1. Only the first ":"
 * splits deviceId from deviceToken — deviceToken itself never contains one
 * in practice (it's base64url, per src/security/crypto.ts's randomToken),
 * but a hypothetical colon in it would still end up correctly folded into
 * the token rather than truncating it.
 */
export function parseBasicAuthHeader(header: string | null): { deviceId: string; deviceToken: string } | null {
  if (header === null || !header.startsWith(BASIC_AUTH_PREFIX)) {
    return null;
  }
  const encoded = header.slice(BASIC_AUTH_PREFIX.length);
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) {
    return null;
  }
  const deviceId = decoded.slice(0, colon);
  const deviceToken = decoded.slice(colon + 1);
  if (deviceId.length === 0 || deviceToken.length === 0) {
    return null;
  }
  return { deviceId, deviceToken };
}

/**
 * BasicDeviceTokenAuthenticator (plan §5.2): looks up the device by the
 * Basic username (deviceId), rejects anything but an 'active' device (plan
 * §16 "端末解除を即時反映する"), and compares the SHA-256 of the supplied
 * token against token_hash with a timing-safe comparison. Every rejection
 * path — malformed header, unknown deviceId, revoked device, wrong token —
 * returns the same null so a caller can't distinguish them (plan §16
 * "認証失敗のエラーでdeviceIdの存在有無を判別しにくくする").
 */
export const BasicDeviceTokenAuthenticator: DeviceAuthenticator = {
  async authenticate(request, env) {
    const parsed = parseBasicAuthHeader(request.headers.get("Authorization"));
    if (parsed === null) {
      return null;
    }
    const device = await getDeviceForAuth(env.APP_DB, parsed.deviceId);
    if (device === null || device.status !== "active") {
      return null;
    }
    const tokenHash = await sha256Hex(parsed.deviceToken);
    if (!timingSafeEqual(tokenHash, device.tokenHash)) {
      return null;
    }
    return { deviceId: device.id, accountId: device.accountId, name: device.name, lastSeenAt: device.lastSeenAt };
  },
};

/**
 * Convenience wrapper matching the plan's `authenticateDevice(request, env)`
 * signature (plan §5.2) — delegates to the configured DeviceAuthenticator
 * (BasicDeviceTokenAuthenticator today; swapping in a future signed-request
 * authenticator only touches this one line). Intended for the OPDS and
 * device-download routes added in a later phase; nothing in this phase calls
 * it yet.
 */
export async function authenticateDevice(
  request: Request,
  env: Pick<Env, "APP_DB">,
): Promise<AuthenticatedDevice | null> {
  return BasicDeviceTokenAuthenticator.authenticate(request, env);
}
