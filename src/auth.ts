import { createRemoteJWKSet, jwtVerify } from "jose";

/** The subset of Env that authorization reads (narrow for testability). */
export interface AuthEnv {
  AUTH_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_POLICY_AUD?: string;
}

/**
 * Verifies a Cloudflare Access JWT. Injectable so authorize() can be unit
 * tested without real JWKS fetches.
 */
export type AccessJwtVerifier = (
  token: string,
  teamDomain: string,
  audience: string,
) => Promise<boolean>;

// Module-scope JWKS cache: createRemoteJWKSet caches keys internally, so the
// isolate refetches certs only on unknown-kid / expiry, not per request.
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Default verifier: checks signature, issuer, and audience via jose. */
export const verifyAccessJwt: AccessJwtVerifier = async (
  token,
  teamDomain,
  audience,
) => {
  try {
    jwks ??= createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    // Pin the algorithm Access uses (RS256) to rule out alg confusion.
    await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience,
      algorithms: ["RS256"],
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Authorizes a request. Passes when either
 *  (a) a valid Cloudflare Access JWT is presented (only when
 *      ACCESS_TEAM_DOMAIN and ACCESS_POLICY_AUD are both configured), or
 *  (b) the Bearer token matches the AUTH_TOKEN secret (when configured).
 * Only when ACCESS_TEAM_DOMAIN, ACCESS_POLICY_AUD, and AUTH_TOKEN are ALL
 * unset (local dev) does every request pass. A half-configured Access pair
 * (only one of the two vars set — a typo or missing var) is treated as a
 * misconfiguration, not as "Access off": Access JWTs are not accepted, and
 * requests fail closed with 401 unless a valid AUTH_TOKEN Bearer is presented.
 *
 * Note: static assets under public/ are served before the Worker runs, so
 * this function never sees them; the UI relies on the edge-side Access app
 * for protection (see research-ui.md).
 *
 * Returns null when authorized, or the 401 response to send.
 */
export async function authorize(
  request: Request,
  env: AuthEnv,
  verify: AccessJwtVerifier = verifyAccessJwt,
): Promise<Response | null> {
  const accessConfigured = Boolean(
    env.ACCESS_TEAM_DOMAIN && env.ACCESS_POLICY_AUD,
  );
  // Open (unauthenticated) only when NOTHING auth-related is configured.
  // A half-configured Access pair must not silently disable auth; it falls
  // through to the checks below and, without a valid Bearer token, gets 401.
  if (!env.ACCESS_TEAM_DOMAIN && !env.ACCESS_POLICY_AUD && !env.AUTH_TOKEN) {
    return null; // local dev: no auth mechanism configured at all
  }

  if (accessConfigured) {
    // Access injects the JWT as a header; browsers also carry it in the
    // CF_Authorization cookie (fallback for non-injected paths).
    const token =
      request.headers.get("Cf-Access-Jwt-Assertion") ??
      getCookie(request, "CF_Authorization");
    if (
      token &&
      (await verify(token, env.ACCESS_TEAM_DOMAIN!, env.ACCESS_POLICY_AUD!))
    ) {
      return null;
    }
  }

  if (env.AUTH_TOKEN) {
    const header = request.headers.get("Authorization") ?? "";
    const token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    if (token && timingSafeEqualStr(token, env.AUTH_TOKEN)) {
      return null;
    }
  }

  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) {
    return null;
  }
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  if (bytesA.length !== bytesB.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  }
  return diff === 0;
}
