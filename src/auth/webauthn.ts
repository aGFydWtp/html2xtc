// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { resolveMaxPasskeysPerAccount, resolveMaxTotalAccounts } from "../quotas";
import { logAuditEvent } from "../security/audit";
import { base64UrlDecode, hashClientIp, sha256Hex } from "../security/crypto";
import { Errors } from "../security/errors";
import type { Env } from "../types";
import { consumeChallenge, issueChallenge } from "./challenges";
import { resolveRegistrationClosedReason, resolveRegistrationMode } from "./registration-mode";
import {
  countTotalAccounts,
  deleteAccountById,
  findCredentialByCredentialId,
  findInviteByTokenHash,
  getAccountById,
  insertCredential,
  isInviteUsable,
  listCredentialsForAccount,
  runNewAccountRegistrationBatch,
  runOpenAccountRegistrationBatch,
  updateCredentialAfterLogin,
} from "./repository";
import type { Account } from "./sessions";
import { createSession } from "./sessions";

/**
 * WebAuthn ceremony orchestration for registration and login (plan §5.1,
 * §9.1): wires generateRegistrationOptions / verifyRegistrationResponse /
 * generateAuthenticationOptions / verifyAuthenticationResponse
 * (@simplewebauthn/server) together with the auth_challenges store
 * (src/auth/challenges.ts), the D1 repository (src/auth/repository.ts), and
 * session issuance (src/auth/sessions.ts). src/auth/routes.ts is the thin
 * HTTP adapter over this module — it never talks to D1 or @simplewebauthn
 * directly.
 */

const RP_NAME = "html2xtc";
const MAX_DISPLAY_NAME_LENGTH = 100;

/** Strips control characters, collapses whitespace, trims, and caps length — same shape as src/library/service.ts's sanitizeText, applied here to the WebAuthn user-facing display name. */
export function sanitizeDisplayName(value: string): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
}

export function resolveWebauthnRpId(env: Pick<Env, "WEBAUTHN_RP_ID">): string {
  if (env.WEBAUTHN_RP_ID === undefined || env.WEBAUTHN_RP_ID.length === 0) {
    throw Errors.internal("WEBAUTHN_RP_ID is not configured");
  }
  return env.WEBAUTHN_RP_ID;
}

export function resolveWebauthnOrigin(env: Pick<Env, "WEBAUTHN_ORIGIN">): string {
  if (env.WEBAUTHN_ORIGIN === undefined || env.WEBAUTHN_ORIGIN.length === 0) {
    throw Errors.internal("WEBAUTHN_ORIGIN is not configured");
  }
  return env.WEBAUTHN_ORIGIN;
}

/**
 * Reads REGISTRATION_IP_PEPPER or throws REGISTRATION_VERIFICATION_UNAVAILABLE
 * (503, fail-closed) — resolved only once the caller has already confirmed
 * mode === "open" (i.e. only from the open-account branches below), so an
 * invite-only deployment that never sets this secret is unaffected
 * (登録モード仕様 Phase2 §6 risk 3).
 */
export function resolveRegistrationIpPepper(env: Pick<Env, "REGISTRATION_IP_PEPPER">): string {
  if (env.REGISTRATION_IP_PEPPER === undefined || env.REGISTRATION_IP_PEPPER.length === 0) {
    throw Errors.serviceUnavailable(
      "REGISTRATION_VERIFICATION_UNAVAILABLE",
      "open registration is not configured",
    );
  }
  return env.REGISTRATION_IP_PEPPER;
}

/** ip_hash placeholder for the rare case (local dev, or an edge that stripped CF-Connecting-IP) where there is no client IP to hash — never reachable from the real Cloudflare edge in production. Every such request shares one bucket for the per-IP daily count, matching how purposeRateLimitKey/rateLimitKey already treat a missing IP as "skip/shared", not as an error. */
const UNKNOWN_CLIENT_IP_HASH = "unknown";

/**
 * 登録モード仕様 Phase3 §9: closed による新規登録拒否1件ごとに一度だけ呼ぶ。
 * fields は mode/reason のみ — トークン・Cookie・IPは絶対に含めない
 * (src/security/audit.ts の ForbiddenAuditKey が主要な秘密キー名を型で
 * ブロックするが、この呼び出し自体もそれらを一切渡さない設計にしてある)。
 * reason はコード値そのもの（security/abuseも含む）を記録してよい —
 * これは内部監査ログであり、GET /api/public/config の出し分け
 * (src/public-config.ts) とは別の経路。
 */
function auditRegistrationClosedRejection(env: Pick<Env, "REGISTRATION_CLOSED_REASON">): void {
  const reason = resolveRegistrationClosedReason(env);
  logAuditEvent("auth.registration.blocked", { mode: "closed", reason: reason ?? "unset" });
}

/** registration_events retention (matches src/db/cleanup.ts's daily sweep target — Phase2 §4b). */
const REGISTRATION_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Extracts the base64url `challenge` embedded in a WebAuthn ceremony's
 * clientDataJSON (itself base64url-encoded) — pure decode + JSON parse, no
 * @simplewebauthn call involved, so it's directly unit-testable (see
 * test/auth-webauthn.test.ts). Used to look up the matching auth_challenges
 * row via consumeChallenge() *before* handing the same value to
 * @simplewebauthn as `expectedChallenge` (which re-checks it against
 * clientDataJSON itself — the actual unpredictability/one-time guarantee
 * comes from the D1-backed consumeChallenge lookup, not from this decode).
 */
export function extractClientDataChallenge(clientDataJSONB64Url: string): string {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(clientDataJSONB64Url);
  } catch {
    throw Errors.badRequest("INVALID_CLIENT_DATA", "clientDataJSON is not valid base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw Errors.badRequest("INVALID_CLIENT_DATA", "clientDataJSON is not valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { challenge?: unknown }).challenge !== "string"
  ) {
    throw Errors.badRequest("INVALID_CLIENT_DATA", "clientDataJSON is missing challenge");
  }
  return (parsed as { challenge: string }).challenge;
}

/** Carried from registration/options to registration/verify via the challenge's metadata_json (never trusted from the client again at verify time). */
export type RegistrationChallengeMetadata =
  | { kind: "new-account"; inviteId: string; pendingAccountId: string; displayName: string }
  | { kind: "add-credential"; accountId: string }
  | { kind: "open-account"; pendingAccountId: string; displayName: string; termsVersion: string };

export interface StartRegistrationParams {
  /** Set when the caller already has a valid session — registers an additional passkey on that account, no invite needed (plan §16 "アカウントへ複数パスキーを登録可能にする"). */
  existingAccount?: Account;
  /** Set for a brand-new account: an unconsumed, unexpired registration invite plus the display name to create the account with. */
  invite?: { inviteToken: string; displayName: string };
  /**
   * Set for a brand-new account created via open (invite-less) registration
   * (登録モード仕様 Phase2 §5.1) — only honored when REGISTRATION_MODE is
   * "open" and no invite was supplied; ignored otherwise (the caller,
   * src/auth/routes.ts, has already run the total-account-cap/rate-limit/
   * Turnstile/terms checks by the time this is set). termsVersion is the
   * already-validated value to record into account_terms_acceptances.
   */
  open?: { displayName: string; termsVersion: string };
}

const REGISTRATION_TIMEOUT_MS = 60_000;

function toExcludeCredentials(
  credentials: { credentialId: string; transports: AuthenticatorTransportFuture[] | null }[],
): { id: string; transports?: AuthenticatorTransportFuture[] }[] {
  return credentials.map((cred) => ({
    id: cred.credentialId,
    ...(cred.transports !== null ? { transports: cred.transports } : {}),
  }));
}

/**
 * POST /api/auth/registration/options (plan §9.1). Exactly one of
 * params.existingAccount / params.invite must be usable; anything else is a
 * 400. residentKey "required" + userVerification "required" (plan §5.1 —
 * discoverable credentials, UV required rather than merely preferred).
 *
 * Registration mode (登録モード仕様 Phase1 §5.1): only gates *new*-account
 * registration (params.invite / no params at all) — adding a passkey to an
 * already-authenticated existingAccount is never blocked by REGISTRATION_MODE.
 * "closed" rejects immediately, before even checking for an invite token.
 * "open" is not yet implemented in Phase 1 (still requires a valid invite,
 * the same as the default "invite" mode) — see the TODO below;
 * invite-less registration is Phase 2's responsibility.
 */
export async function startRegistration(
  env: Pick<
    Env,
    "APP_DB" | "WEBAUTHN_RP_ID" | "REGISTRATION_MODE" | "REGISTRATION_CLOSED_REASON" | "MAX_PASSKEYS_PER_ACCOUNT"
  >,
  params: StartRegistrationParams,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const rpId = resolveWebauthnRpId(env);

  let userId: string;
  let userDisplayName: string;
  /**
   * WebAuthn "userName" (登録モード仕様 Phase2 §7): invite/add-credential
   * keep passing the display name itself, byte-for-byte unchanged from
   * before Phase 2 (the invite-registration WebAuthn UI's account-picker
   * label must not regress). Open registration explicitly allows duplicate
   * display names, so it passes the opaque pendingAccountId instead —
   * see the open branch below.
   */
  let userName: string;
  let metadata: RegistrationChallengeMetadata;
  let excludeCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] = [];

  if (params.existingAccount !== undefined) {
    const account = params.existingAccount;
    userId = account.id;
    userDisplayName = account.displayName;
    userName = account.displayName;
    metadata = { kind: "add-credential", accountId: account.id };
    const existingCredentials = await listCredentialsForAccount(env.APP_DB, account.id);
    // Passkey-count quota (登録モード仕様 Phase1 §5.3), checked here — before
    // the invite-consumption batch doesn't apply to this branch (there's no
    // invite to consume when adding a passkey to an existing account), so
    // there's no ordering hazard like the new-account branch below.
    if (existingCredentials.length >= resolveMaxPasskeysPerAccount(env)) {
      logAuditEvent("account.quota.exceeded", { accountId: account.id, quota: "passkeys" });
      throw Errors.conflict("PASSKEY_LIMIT_EXCEEDED", "passkey limit reached");
    }
    excludeCredentials = toExcludeCredentials(existingCredentials);
  } else {
    const mode = resolveRegistrationMode(env);
    if (mode === "closed") {
      auditRegistrationClosedRejection(env);
      throw Errors.forbidden("REGISTRATION_CLOSED", "new account registration is closed");
    }
    if (params.invite === undefined && mode === "open" && params.open !== undefined) {
      // Phase 2: open (invite-less) registration. The caller
      // (src/auth/routes.ts) has already run the total-account-cap,
      // open.start rate limit, daily/IP registration count, Turnstile, and
      // terms-version checks — this branch is WebAuthn-ceremony concerns
      // only (登録モード仕様 Phase2 §5.1). Duplicate display names are
      // explicitly allowed (§7), so userName is the opaque pendingAccountId
      // rather than the display name — never leaking a
      // possibly-duplicated, user-chosen string into the authenticator's
      // own account-picker UI the way the invite path's userName does.
      const displayName = sanitizeDisplayName(params.open.displayName);
      if (displayName.length === 0) {
        throw Errors.badRequest("INVALID_DISPLAY_NAME", "displayName is required");
      }
      const pendingAccountId = crypto.randomUUID();
      userId = pendingAccountId;
      userDisplayName = displayName;
      userName = pendingAccountId;
      metadata = {
        kind: "open-account",
        pendingAccountId,
        displayName,
        termsVersion: params.open.termsVersion,
      };
    } else {
      if (params.invite === undefined) {
        throw Errors.badRequest("INVITE_REQUIRED", "inviteToken is required to create an account");
      }
      const tokenHash = await sha256Hex(params.invite.inviteToken);
      const invite = await findInviteByTokenHash(env.APP_DB, tokenHash);
      if (invite === null || !isInviteUsable(invite, Date.now())) {
        throw Errors.badRequest("INVALID_INVITE", "invite is invalid or expired");
      }
      const displayName = sanitizeDisplayName(params.invite.displayName);
      if (displayName.length === 0) {
        throw Errors.badRequest("INVALID_DISPLAY_NAME", "displayName is required");
      }
      const pendingAccountId = crypto.randomUUID();
      userId = pendingAccountId;
      userDisplayName = displayName;
      userName = displayName;
      metadata = { kind: "new-account", inviteId: invite.id, pendingAccountId, displayName };
    }
  }

  const issued = await issueChallenge(env, "registration", null, metadata);

  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId,
    userName,
    userDisplayName,
    // .slice() forces an ArrayBuffer-backed Uint8Array (matching
    // @simplewebauthn's Uint8Array_ = ReturnType<Uint8Array['slice']>) —
    // TextEncoder().encode() alone types as Uint8Array<ArrayBufferLike>.
    userID: new TextEncoder().encode(userId).slice(),
    // Pass the DECODED bytes, not the base64url string: @simplewebauthn v13
    // UTF-8-encodes string challenges and re-encodes them, so the value the
    // browser echoes back in clientDataJSON.challenge would be a
    // double-encoded string that no longer hashes to the stored
    // challenge_hash. Decoding first makes options.challenge round-trip as
    // exactly issued.challenge.
    challenge: base64UrlDecode(issued.challenge).slice(),
    timeout: REGISTRATION_TIMEOUT_MS,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials,
  });
}

export interface FinishRegistrationResult {
  account: Account;
  /** Only set for a brand-new account; adding a passkey to an already-logged-in account keeps that session as-is. */
  session: { token: string; expiresAt: string; maxAgeSeconds: number } | null;
  /** True only for the open (invite-less) registration path — src/auth/routes.ts uses this to decide whether to tally the open-registration success rate limits (登録モード仕様 Phase2 §8's "全体50/日"/"3/日/IP" budgets). */
  isOpenRegistration: boolean;
}

/** Throws a single, undifferentiated error for every registration-verification failure mode so a client can't distinguish "bad signature" from "challenge expired" from "invite race lost". */
function registrationFailed(): never {
  throw Errors.badRequest("REGISTRATION_FAILED", "passkey registration could not be verified");
}

/**
 * POST /api/auth/registration/verify (plan §9.1). `clientIp` is the raw
 * CF-Connecting-IP header value (or null) — always passed by the caller
 * (src/auth/routes.ts) regardless of registration kind; it is only ever
 * used (hashed, via hashClientIp) inside the open-account branch, after
 * metadata.kind has already confirmed this is an open registration, so
 * REGISTRATION_IP_PEPPER is never resolved on the invite/add-credential
 * path (登録モード仕様 Phase2 §6 risk 3).
 */
export async function finishRegistration(
  env: Pick<
    Env,
    | "APP_DB"
    | "WEBAUTHN_RP_ID"
    | "WEBAUTHN_ORIGIN"
    | "SESSION_PEPPER"
    | "SESSION_TTL_DAYS"
    | "MAX_TOTAL_ACCOUNTS"
    | "REGISTRATION_IP_PEPPER"
    | "REGISTRATION_MODE"
    | "REGISTRATION_CLOSED_REASON"
  >,
  response: RegistrationResponseJSON,
  userAgent: string | null,
  clientIp: string | null,
): Promise<FinishRegistrationResult> {
  const rpId = resolveWebauthnRpId(env);
  const origin = resolveWebauthnOrigin(env);

  const challenge = extractClientDataChallenge(response.response.clientDataJSON);
  const consumed = await consumeChallenge<RegistrationChallengeMetadata>(env, "registration", challenge);
  if (consumed === null || consumed.metadata === null) {
    registrationFailed();
  }
  const metadata = consumed.metadata;

  // 登録モード仕様 Phase3 §3: closed への切替後でも、challengeが未消費なら
  // まだ再利用可能になってしまう — 必ず上の consumeChallenge の「後」に置く
  // (PHASE3_GAP_ANALYSIS.md §6 risk 1)。add-credential (既存アカウントへの
  // 追加パスキー)はこの判定に一切含めない — 既存アカウントの認証手段追加は
  // closed でも常に許可する。
  if (
    (metadata.kind === "new-account" || metadata.kind === "open-account") &&
    resolveRegistrationMode(env) === "closed"
  ) {
    auditRegistrationClosedRejection(env);
    throw Errors.forbidden("REGISTRATION_CLOSED", "new account registration is closed");
  }

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
  } catch (error) {
    console.error("registration verification error", error);
    registrationFailed();
  }
  if (!verification.verified) {
    registrationFailed();
  }
  const { registrationInfo } = verification;

  const nowIso = new Date().toISOString();
  const newCredential = {
    id: crypto.randomUUID(),
    credentialId: registrationInfo.credential.id,
    publicKey: registrationInfo.credential.publicKey,
    signCount: registrationInfo.credential.counter,
    transports: registrationInfo.credential.transports ?? null,
    deviceType: registrationInfo.credentialDeviceType,
    backedUp: registrationInfo.credentialBackedUp,
    createdAt: nowIso,
  };

  if (metadata.kind === "new-account") {
    const accountId = metadata.pendingAccountId;
    const displayName = metadata.displayName;
    // Invite consumption + account creation + credential insertion run as
    // one atomic D1 batch (src/auth/repository.ts's
    // runNewAccountRegistrationBatch) so a credential-insert failure (e.g.
    // this passkey is already registered to another account) rolls back the
    // whole thing instead of leaving a used-invite, zero-credential orphan
    // account behind.
    let batchResult: { inviteConsumed: boolean };
    try {
      batchResult = await runNewAccountRegistrationBatch(env.APP_DB, {
        invite: { id: metadata.inviteId, consumedAt: nowIso },
        account: { id: accountId, displayName, createdAt: nowIso },
        credential: { ...newCredential, accountId },
      });
    } catch (error) {
      console.error("credential insert failed", error);
      throw Errors.conflict("CREDENTIAL_ALREADY_REGISTERED", "this passkey is already registered");
    }
    if (!batchResult.inviteConsumed) {
      // Lost a race against a concurrent request that consumed this same
      // invite a moment earlier: the batch above still committed our
      // account+credential (D1 batch() can't make those conditional on the
      // invite UPDATE's affected-row count), so undo them now. ON DELETE
      // CASCADE on webauthn_credentials.account_id removes the credential
      // row too.
      await deleteAccountById(env.APP_DB, accountId);
      throw Errors.conflict("INVITE_ALREADY_USED", "invite has already been used");
    }
    const account: Account = { id: accountId, displayName };
    const session = await createSession(env, accountId, userAgent);
    return { account, session, isOpenRegistration: false };
  }

  if (metadata.kind === "open-account") {
    const accountId = metadata.pendingAccountId;
    const displayName = metadata.displayName;

    // Total-account-cap re-check (登録モード仕様 Phase2 §4a: both
    // registration/options and registration/verify must enforce
    // MAX_TOTAL_ACCOUNTS) — closes the race where two concurrent open
    // registrations both passed the options-time check in
    // src/auth/routes.ts and would otherwise both still complete here.
    const totalAccounts = await countTotalAccounts(env.APP_DB);
    if (totalAccounts >= resolveMaxTotalAccounts(env)) {
      throw Errors.serviceUnavailable("REGISTRATION_CAPACITY_REACHED", "registration is temporarily full");
    }

    // REGISTRATION_IP_PEPPER is resolved here — only after metadata.kind has
    // already confirmed this is the open-account branch — never on the
    // invite/add-credential paths above (登録モード仕様 Phase2 §6 risk 3).
    const ipHash = await hashClientIp(clientIp, resolveRegistrationIpPepper(env));
    const registrationEventId = crypto.randomUUID();
    const registrationEventExpiresAt = new Date(
      Date.now() + REGISTRATION_EVENT_RETENTION_MS,
    ).toISOString();

    try {
      await runOpenAccountRegistrationBatch(env.APP_DB, {
        account: { id: accountId, displayName, createdAt: nowIso },
        credential: { ...newCredential, accountId },
        termsAcceptance: {
          id: crypto.randomUUID(),
          termsVersion: metadata.termsVersion,
          acceptedAt: nowIso,
        },
        registrationEvent: {
          id: registrationEventId,
          ipHash: ipHash ?? UNKNOWN_CLIENT_IP_HASH,
          createdAt: nowIso,
          expiresAt: registrationEventExpiresAt,
        },
      });
    } catch (error) {
      console.error("credential insert failed", error);
      throw Errors.conflict("CREDENTIAL_ALREADY_REGISTERED", "this passkey is already registered");
    }

    const account: Account = { id: accountId, displayName };
    const session = await createSession(env, accountId, userAgent);
    return { account, session, isOpenRegistration: true };
  }

  const accountId = metadata.accountId;
  const existing = await getAccountById(env.APP_DB, accountId);
  if (existing === null) {
    throw Errors.notFound("ACCOUNT_NOT_FOUND", "account not found");
  }
  try {
    await insertCredential(env.APP_DB, { ...newCredential, accountId });
  } catch (error) {
    console.error("credential insert failed", error);
    throw Errors.conflict("CREDENTIAL_ALREADY_REGISTERED", "this passkey is already registered");
  }

  return {
    account: { id: accountId, displayName: existing.displayName },
    session: null,
    isOpenRegistration: false,
  };
}

const AUTHENTICATION_TIMEOUT_MS = 60_000;

/** POST /api/auth/login/options (plan §9.1). allowCredentials is omitted (not merely empty) so the platform's discoverable-credential picker is used — plan §5.1 "Discoverable Credentialを推奨する". */
export async function startLogin(
  env: Pick<Env, "APP_DB" | "WEBAUTHN_RP_ID">,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const rpId = resolveWebauthnRpId(env);
  const issued = await issueChallenge(env, "login", null, null);
  return generateAuthenticationOptions({
    rpID: rpId,
    // Decoded bytes for the same reason as startRegistration: a string
    // challenge would be double-encoded and break challenge_hash lookup.
    challenge: base64UrlDecode(issued.challenge).slice(),
    timeout: AUTHENTICATION_TIMEOUT_MS,
    userVerification: "required",
  });
}

export interface FinishLoginResult {
  account: Account;
  session: { token: string; expiresAt: string; maxAgeSeconds: number };
}

/** Throws a single, undifferentiated 401 for every login failure mode (unknown credential, bad signature, expired/reused challenge) — plan §16 "認証失敗のエラーでdeviceIdの存在有無を判別しにくくする", applied here to accounts/credentials instead of devices. */
function loginFailed(): never {
  throw Errors.unauthorized("passkey authentication failed");
}

/** POST /api/auth/login/verify (plan §9.1). */
export async function finishLogin(
  env: Pick<Env, "APP_DB" | "WEBAUTHN_RP_ID" | "WEBAUTHN_ORIGIN" | "SESSION_PEPPER" | "SESSION_TTL_DAYS">,
  response: AuthenticationResponseJSON,
  userAgent: string | null,
): Promise<FinishLoginResult> {
  const rpId = resolveWebauthnRpId(env);
  const origin = resolveWebauthnOrigin(env);

  const challenge = extractClientDataChallenge(response.response.clientDataJSON);
  const consumedChallenge = await consumeChallenge(env, "login", challenge);
  if (consumedChallenge === null) {
    loginFailed();
  }

  const credentialRecord = await findCredentialByCredentialId(env.APP_DB, response.id);
  if (credentialRecord === null) {
    loginFailed();
  }

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: {
        id: credentialRecord.credentialId,
        publicKey: credentialRecord.publicKey.slice(),
        counter: credentialRecord.signCount,
        ...(credentialRecord.transports !== null ? { transports: credentialRecord.transports } : {}),
      },
      requireUserVerification: true,
    });
  } catch (error) {
    console.error("authentication verification error", error);
    loginFailed();
  }
  if (!verification.verified) {
    loginFailed();
  }

  const account = await getAccountById(env.APP_DB, credentialRecord.accountId);
  if (account === null) {
    loginFailed();
  }

  const nowIso = new Date().toISOString();
  await updateCredentialAfterLogin(
    env.APP_DB,
    credentialRecord.credentialId,
    verification.authenticationInfo.newCounter,
    nowIso,
  );

  const session = await createSession(env, account.id, userAgent);
  return { account, session };
}
