#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Issues a one-time passkey registration invite (implementation plan §5.1
 * "招待コード方式"): generates a 256-bit random token, then PRINTS (does not
 * execute) the `wrangler d1 execute` command that inserts a
 * registration_invites row holding only the token's SHA-256 hash and a
 * 7-day expiry — never the plaintext token. The plaintext token is printed
 * exactly once, as the one-time registration URL, and nowhere else (not to
 * a file, not to D1, not to any log).
 *
 * Usage:
 *   node scripts/create-invite.mjs             # prints an APP_DB --remote command
 *   node scripts/create-invite.mjs --local     # prints a --local command instead
 *
 * This script never calls wrangler itself — copy the printed command and
 * run it yourself. That keeps the remote/local choice explicit to whoever
 * runs it, and means this script needs no Cloudflare API auth of its own.
 *
 * After running the printed command, share the printed
 * https://xtc.hr20k.com/?register=<token> URL with the intended user over a
 * channel you trust (it is a bearer credential for account creation until
 * used or expired).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

const DATABASE_NAME = "html2xtc-app";
const INVITE_TTL_DAYS = 7;
const TOKEN_BYTES = 32; // 256 bits, matching the plan's "256ビット以上のランダム値" requirement.
const REGISTER_BASE_URL = "https://xtc.hr20k.com/?register=";

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sqlQuote(value) {
  // SQLite string literal escaping: double any single quote. Every value
  // interpolated below is generated locally (UUID/hex/ISO timestamp), never
  // attacker-controlled, but quoting is still done properly rather than
  // assumed safe.
  return `'${value.replace(/'/g, "''")}'`;
}

const useLocal = process.argv.includes("--local");

const token = base64Url(randomBytes(TOKEN_BYTES));
const tokenHash = createHash("sha256").update(token).digest("hex");
const id = randomUUID();
const now = new Date();
const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

const sql =
  `INSERT INTO registration_invites (id, token_hash, expires_at, created_at) ` +
  `VALUES (${sqlQuote(id)}, ${sqlQuote(tokenHash)}, ${sqlQuote(expiresAt.toISOString())}, ${sqlQuote(now.toISOString())});`;

const flag = useLocal ? "--local" : "--remote";
const command = `npx wrangler d1 execute ${DATABASE_NAME} ${flag} --command "${sql.replace(/"/g, '\\"')}"`;

console.log("Run this command yourself to create the invite (not executed automatically):\n");
console.log(command);
console.log("\nOne-time registration URL — share it once, over a trusted channel; it will not be shown again:\n");
console.log(`${REGISTER_BASE_URL}${token}`);
console.log(`\nExpires ${expiresAt.toISOString()} (${INVITE_TTL_DAYS} days from now). Unused after expiry or after one successful registration.`);
