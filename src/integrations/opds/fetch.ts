// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { DecryptedOpdsConnection } from "./types";
import { UrlValidationError, validatePublicUrl } from "../../validate";

/**
 * SSRF/redirect defenses for every external OPDS fetch (root feed,
 * navigation, search, next/previous, EPUB acquisition — spec §15). Reuses
 * src/validate.ts's validatePublicUrl for the private-IP/loopback/link-
 * local/metadata/DoH-resolution checks (already covers IPv4 + IPv6, incl.
 * embedded-IPv4 forms) rather than re-implementing that logic, but adds what
 * validatePublicUrl deliberately does NOT do (it's shared with the
 * url-render pipeline, which has different needs):
 *   - HTTPS-only (validatePublicUrl also accepts http — the url-render
 *     pipeline legitimately renders http pages)
 *   - userinfo rejection ("user:pass@host" in the URL)
 *   - fragment stripping
 *   - manual redirect handling with per-hop re-validation, a hard cap, and
 *     HTTPS-downgrade rejection (validatePublicUrl has no opinion on
 *     redirects at all — its caller, quickAction, doesn't chase them itself)
 */

export { UrlValidationError };

const MAX_OPDS_REDIRECTS = 3; // spec §15's "redirect最大3"
const OPDS_FETCH_TIMEOUT_MS = 15_000;

/**
 * Validates a URL destined for an external OPDS request: HTTPS only, no
 * userinfo, fragment stripped, and every check validatePublicUrl already
 * does (private/loopback/link-local/metadata IPs, forbidden hostnames,
 * DoH-resolved non-literal hostnames). Never logs the URL itself (spec
 * §15/§22) — callers must not include it in any thrown message either
 * beyond what UrlValidationError's own generic text already says.
 *
 * Inherited limitation: validatePublicUrl's own module header documents
 * TOCTOU/DNS-rebinding as an accepted Phase-1 limitation (the DoH answer
 * checked here and the resolution the actual outbound `fetch()` performs a
 * moment later are two separate lookups — src/validate.ts:20-24), and its
 * DoH failure handling has two explicit fail-open edges (both A/AAAA queries
 * erroring, or one empty-NOERROR + one timeout — src/validate.ts:105-109,
 * :130-137). That acceptance was made for the url-render (Browser Rendering
 * screenshot) pipeline, which never carries a credential. This OPDS
 * integration reuses the same function for requests that DO carry a
 * credential (Basic auth headers, or a secret baked into the URL itself for
 * authType="url_secret"), so it is knowingly inheriting that same accepted
 * risk rather than re-deriving a stricter check — justified here because
 * Cloudflare Workers' egress path does not route to RFC1918/link-local/
 * metadata addresses regardless of what a rebinding DNS answer claims, so the
 * practical exposure is small. If this code is ever run outside the Workers
 * runtime (e.g. a self-hosted/Node deployment with unrestricted egress),
 * this assumption no longer holds and must be re-evaluated — a rebinding
 * attacker in that environment could redirect a POST-verification-time
 * "public" URL to an internal service by the time the real request lands.
 */
export async function validateOpdsExternalUrl(input: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlValidationError("invalid URL");
  }
  if (url.protocol !== "https:") {
    throw new UrlValidationError("only https URLs are allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UrlValidationError("userinfo is not allowed in a catalog/acquisition URL");
  }
  url.hash = "";
  // validatePublicUrl re-parses the (fragment-stripped, still-https) string;
  // its own protocol check is a strict subset of the https-only check above,
  // so this never re-opens the door to http.
  return validatePublicUrl(url.toString());
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export interface OpdsFetchRequest {
  /** Headers to send, e.g. an Authorization: Basic header (src/integrations/opds/fetch.ts's buildOpdsAuthHeaders). */
  headers: Headers;
  /**
   * The origin `headers` is scoped to — when set, any header carried across
   * a redirect to a DIFFERENT origin is dropped rather than forwarded (spec
   * §14: "Authorizationを別origin redirectへ無条件転送する" is forbidden).
   * null means `headers` carries nothing origin-sensitive (authType "none"/
   * "url_secret" — the secret already lives in the URL itself, not a
   * header) and can be sent to every hop unconditionally.
   */
  authOrigin: string | null;
}

export interface OpdsFetchResult {
  response: Response;
  /** The URL the response actually came from, after following any redirects — never exposed to a client, used only to resolve relative hrefs in the body. */
  finalUrl: URL;
}

/**
 * Fetches `startUrl` with manual redirect handling: each Location header is
 * re-validated by validateOpdsExternalUrl (so a redirect can never downgrade
 * to http, point at a private IP, or exceed MAX_OPDS_REDIRECTS), and the
 * request's headers are stripped of anything scoped to `request.authOrigin`
 * once the current URL's origin no longer matches it.
 */
export async function fetchOpdsResource(
  startUrl: URL,
  request: OpdsFetchRequest,
): Promise<OpdsFetchResult> {
  let currentUrl = startUrl;
  let redirects = 0;

  for (;;) {
    const headersForThisHop = new Headers(request.headers);
    if (request.authOrigin !== null && currentUrl.origin !== request.authOrigin) {
      headersForThisHop.delete("Authorization");
    }

    const response = await fetch(currentUrl.toString(), {
      headers: headersForThisHop,
      redirect: "manual",
      signal: AbortSignal.timeout(OPDS_FETCH_TIMEOUT_MS),
    });

    if (!isRedirectStatus(response.status)) {
      return { response, finalUrl: currentUrl };
    }
    // This hop's body is never read (only the Location header matters for a
    // redirect) — cancel it before moving on so the underlying connection is
    // released rather than left open until GC, whether or not another hop
    // follows.
    await response.body?.cancel();
    if (redirects >= MAX_OPDS_REDIRECTS) {
      throw new UrlValidationError("too many redirects");
    }
    const location = response.headers.get("Location");
    if (location === null) {
      throw new UrlValidationError("redirect response missing Location header");
    }
    let nextRaw: string;
    try {
      nextRaw = new URL(location, currentUrl).toString();
    } catch {
      throw new UrlValidationError("redirect Location header is not a valid URL");
    }
    currentUrl = await validateOpdsExternalUrl(nextRaw);
    redirects += 1;
  }
}

export class ResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * Reads `response.body` into a string, aborting (and cancelling the reader)
 * the moment more than `maxBytes` have arrived — a Content-Length header
 * can lie, so this is the actual enforcement point for the feed/OpenSearch
 * size caps (spec §16's "XML最大1 MiB"), not just a check against a header.
 */
export async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError("response exceeds the maximum allowed size");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/** RFC 7617 standard (non-url-safe) base64 of UTF-8 bytes — `Authorization: Basic` needs the RFC's exact alphabet, unlike this codebase's usual base64url tokens. */
function toStandardBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

/**
 * Builds the headers (and their origin-scoping) for a request to
 * `connection`'s external server (spec §14's applyOpdsAuthentication).
 * authType "none"/"url_secret" add nothing — url_secret's credential is
 * already part of the stored catalog URL itself, never a header.
 */
export function buildOpdsAuthHeaders(connection: DecryptedOpdsConnection): OpdsFetchRequest {
  const headers = new Headers();
  if (connection.authType === "basic" && connection.username !== null && connection.password !== null) {
    headers.set("Authorization", `Basic ${toStandardBase64(`${connection.username}:${connection.password}`)}`);
    return { headers, authOrigin: connection.origin };
  }
  return { headers, authOrigin: null };
}
