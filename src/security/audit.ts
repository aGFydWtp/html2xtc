// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Structured audit logging (plan §17): one JSON line per event via
 * console.log, matching the existing console.error convention used
 * elsewhere for diagnostics — no external sink yet.
 *
 * Plan §17 forbids ever logging deviceToken, pairingSecret, session
 * cookies/tokens, WebAuthn challenges, invite tokens, Authorization
 * headers, or XTC file bytes. Two layers enforce that:
 *  - Every field value is constrained to `string | number` by the type
 *    signature alone, so a caller can never pass an object/Headers/Request
 *    that might carry a secret as a nested value.
 *  - ForbiddenAuditKey statically blocks the obvious secret-shaped field
 *    *names* (deviceToken, pairingSecret, ...) at the call site — see
 *    test/security-audit.test.ts's `@ts-expect-error` cases.
 * This is a naming/shape guard, not a content scanner: a caller could still
 * misuse an unrelated key name to smuggle a secret value through. Every
 * call site added alongside this module (auth/devices/library/opds routes)
 * only ever passes ids, counts, and byte sizes.
 */

export type AuditFieldValue = string | number;

/** Field names that must never appear in an audit event, whatever their value. */
type ForbiddenAuditKey =
  | "deviceToken"
  | "pairingSecret"
  | "sessionToken"
  | "sessionCookie"
  | "cookie"
  | "authorization"
  | "challenge"
  | "inviteToken"
  | "password"
  | "token";

/**
 * Logs one audit event as a single JSON line: {event, ...fields, timestamp}.
 * `fields` is typed to reject (at compile time) any key from
 * ForbiddenAuditKey — see the module doc for what this guard does and does
 * not catch.
 */
export function logAuditEvent<T extends Record<string, AuditFieldValue>>(
  event: string,
  fields?: T & { [K in Extract<keyof T, ForbiddenAuditKey>]?: never },
): void {
  console.log(JSON.stringify({ event, ...(fields ?? {}), timestamp: new Date().toISOString() }));
}
