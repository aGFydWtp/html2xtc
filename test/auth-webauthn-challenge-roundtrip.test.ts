// SPDX-License-Identifier: AGPL-3.0-or-later
// Regression test for the challenge double-encoding bug: @simplewebauthn v13
// UTF-8-encodes *string* challenges and base64url-encodes them again, so the
// browser would echo back a double-encoded challenge in clientDataJSON that
// no longer hashes to the auth_challenges.challenge_hash stored by
// issueChallenge(). startRegistration/startLogin must therefore pass DECODED
// bytes. These tests assert the end-to-end invariant:
//   sha256(options.challenge) === challenge_hash bound in the D1 INSERT
// which is exactly the lookup finishRegistration/finishLogin performs.
import { describe, expect, it } from "vitest";

import { startLogin, startRegistration } from "../src/auth/webauthn";
import { sha256Hex } from "../src/security/crypto";
import type { Env } from "../src/types";

/** Minimal D1 mock capturing values bound to the auth_challenges INSERT. */
function mockAppDb(captured: { challengeHash?: string }): D1Database {
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          if (sql.includes("INSERT INTO auth_challenges")) {
            // (id, purpose, account_id, challenge_hash, metadata_json, expires_at, created_at)
            captured.challengeHash = values[3] as string;
          }
          return {
            run: async () => ({ success: true, meta: {} }),
            first: async () => null,
            all: async () => ({ results: [] }),
          };
        },
      };
    },
  };
  return db as unknown as D1Database;
}

const baseEnv = { WEBAUTHN_RP_ID: "example.com" } as Pick<Env, "WEBAUTHN_RP_ID">;

describe("webauthn challenge round-trip", () => {
  it("startLogin: options.challenge hashes to the stored challenge_hash", async () => {
    const captured: { challengeHash?: string } = {};
    const env = { ...baseEnv, APP_DB: mockAppDb(captured) };
    const options = await startLogin(env);
    expect(captured.challengeHash).toBeDefined();
    expect(await sha256Hex(options.challenge)).toBe(captured.challengeHash);
  });

  it("startRegistration (add-credential): options.challenge hashes to the stored challenge_hash", async () => {
    const captured: { challengeHash?: string } = {};
    const env = { ...baseEnv, APP_DB: mockAppDb(captured) };
    const options = await startRegistration(env, {
      existingAccount: { id: "acct-1", displayName: "Tester" },
    });
    expect(captured.challengeHash).toBeDefined();
    expect(await sha256Hex(options.challenge)).toBe(captured.challengeHash);
  });
});
