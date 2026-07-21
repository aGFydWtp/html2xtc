// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { randomToken, sha256Hex } from "../security/crypto";
import type { Env } from "../types";

/**
 * auth_challenges storage: issuing, hashed-lookup, and one-time consumption
 * of WebAuthn ceremony challenges (registration and login), per plan §5.1 —
 * "登録・認証チャレンジは短時間で失効させる" / "チャレンジは一度だけ使用
 * 可能とする". The raw challenge value is never persisted; only its SHA-256
 * hash (challenge_hash) is written to D1, mirroring how session tokens
 * (src/auth/sessions.ts) are handled.
 *
 * Callers (src/auth/webauthn.ts) pass the exact same raw challenge string
 * into the @simplewebauthn options builder, so the value the authenticator
 * signs over is identical to the one hashed here.
 */

export type ChallengePurpose = "registration" | "login";

/** Challenges expire quickly — long enough to complete a WebAuthn ceremony, short enough to limit replay/guessing exposure. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** 256-bit challenge, matching the token/secret entropy bar used elsewhere (sessions, invites, pairing secrets). */
const CHALLENGE_BYTES = 32;

export interface IssuedChallenge {
  /** Raw base64url challenge value. Pass this straight into generateRegistrationOptions/generateAuthenticationOptions's `challenge` param — never persisted raw beyond this return value. */
  challenge: string;
  expiresAt: string;
}

/**
 * Issues and persists a new challenge for `purpose`. `accountId` ties a
 * challenge to a known account when one already exists (e.g. adding a
 * passkey to a logged-in account); it is null for new-account registration
 * and for login (discoverable credential — the account isn't known until
 * the credential is presented). `metadata` is arbitrary JSON-serializable
 * state (e.g. invite id, pending account id, display name) carried through
 * to whatever calls consumeChallenge() for the matching purpose.
 */
export async function issueChallenge(
  env: Pick<Env, "APP_DB">,
  purpose: ChallengePurpose,
  accountId: string | null,
  metadata: unknown,
): Promise<IssuedChallenge> {
  const challenge = randomToken(CHALLENGE_BYTES);
  const challengeHash = await sha256Hex(challenge);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);

  await env.APP_DB.prepare(
    `INSERT INTO auth_challenges (id, purpose, account_id, challenge_hash, metadata_json, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      purpose,
      accountId,
      challengeHash,
      metadata === undefined ? null : JSON.stringify(metadata),
      expiresAt.toISOString(),
      now.toISOString(),
    )
    .run();

  return { challenge, expiresAt: expiresAt.toISOString() };
}

/**
 * Pure eligibility check, hoisted out of consumeChallenge so the expiry/
 * one-time-use rule is directly unit-testable without D1 (see
 * test/auth-challenges.test.ts): a challenge is consumable iff it hasn't
 * already been consumed and its expiry is still in the future.
 */
export function isChallengeConsumable(
  row: { consumedAt: string | null; expiresAt: string },
  nowMs: number,
): boolean {
  if (row.consumedAt !== null) {
    return false;
  }
  return new Date(row.expiresAt).getTime() > nowMs;
}

export interface ConsumedChallenge<TMetadata> {
  accountId: string | null;
  metadata: TMetadata | null;
}

interface ChallengeRow {
  id: string;
  account_id: string | null;
  metadata_json: string | null;
  expires_at: string;
  consumed_at: string | null;
}

/**
 * Looks up the challenge matching `purpose` + the raw challenge value's
 * hash, and atomically claims it: the UPDATE's WHERE clause re-asserts
 * "not already consumed" at claim time, so a concurrent duplicate call for
 * the same challenge can win the read but still loses the claim (its
 * `changes` count comes back 0), and only one caller ever receives a
 * non-null result for a given challenge.
 *
 * Returns null whenever the challenge can't be used — unknown hash, wrong
 * purpose, expired, already consumed, or lost the concurrent claim — and
 * callers must treat every one of those identically (reject the ceremony)
 * rather than distinguishing the reason to the client.
 */
export async function consumeChallenge<TMetadata = unknown>(
  env: Pick<Env, "APP_DB">,
  purpose: ChallengePurpose,
  challenge: string,
  nowMs: number = Date.now(),
): Promise<ConsumedChallenge<TMetadata> | null> {
  const challengeHash = await sha256Hex(challenge);

  const row = await env.APP_DB.prepare(
    `SELECT id, account_id, metadata_json, expires_at, consumed_at
     FROM auth_challenges
     WHERE challenge_hash = ? AND purpose = ?`,
  )
    .bind(challengeHash, purpose)
    .first<ChallengeRow>();
  if (row === null) {
    return null;
  }
  if (!isChallengeConsumable({ consumedAt: row.consumed_at, expiresAt: row.expires_at }, nowMs)) {
    return null;
  }

  const claim = await env.APP_DB.prepare(
    `UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`,
  )
    .bind(new Date(nowMs).toISOString(), row.id)
    .run();
  if ((claim.meta.changes ?? 0) !== 1) {
    return null;
  }

  return {
    accountId: row.account_id,
    metadata: row.metadata_json !== null ? (JSON.parse(row.metadata_json) as TMetadata) : null,
  };
}
