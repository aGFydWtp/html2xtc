/**
 * SSRF guard for user-supplied URLs.
 *
 * Coverage:
 * - IP literals (IPv4/IPv6, including encoded forms canonicalized by the
 *   WHATWG URL parser: "http://2130706433" -> "127.0.0.1",
 *   "[::ffff:127.0.0.1]" -> "[::ffff:7f00:1]").
 * - IPv6 addresses embedding an IPv4 address: IPv4-mapped (::ffff:0:0/96),
 *   IPv4-compatible (::/96), 6to4 (2002::/16), NAT64 (64:ff9b::/96).
 * - Non-literal hostnames are pre-resolved over DoH and the resolved IPs go
 *   through the same range checks. A partially failing DoH lookup never
 *   discards the answers that did arrive; hosts for which both A and AAAA
 *   queries succeed with zero addresses are rejected (fail closed). Only a
 *   total DoH failure (both queries erroring) lets the URL pass unchecked
 *   (availability over strictness; Browser Run re-resolves anyway).
 *
 * Known limitations (Phase 1, also listed in README):
 * - TOCTOU / DNS rebinding: the DoH answer here and the resolution Browser Run
 *   performs later are separate lookups; a rebinding DNS server can pass this
 *   check and still hand a private IP to the renderer.
 * - Redirect targets are not re-validated (quickAction offers no hook for it).
 */

export class UrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlValidationError";
  }
}

export type DnsResolver = (hostname: string, type: "A" | "AAAA") => Promise<string[]>;

// "xtc.hr20k.com" is this service's own custom domain: letting the renderer
// fetch it would recurse the converter into itself (self-request loops, and a
// probe of our own Access-protected UI/API from inside the trust boundary).
const FORBIDDEN_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "xtc.hr20k.com",
]);

export async function validatePublicUrl(
  input: string,
  resolve: DnsResolver = dohResolve,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlValidationError("invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlValidationError("only http/https URLs are allowed");
  }

  // A trailing dot is the same host in DNS ("localhost." etc.).
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  if (hostname.length === 0) {
    throw new UrlValidationError("invalid URL");
  }

  // ".workers.dev" (suffix match, like ".localhost" below) covers this
  // service's own deploy host: the wrangler name is "url-to-xtc" but the
  // account subdomain in "url-to-xtc.<subdomain>.workers.dev" is not known
  // statically, so the whole suffix is rejected. Blocking every workers.dev
  // host is an accepted over-match — a legitimate need to convert someone
  // else's workers.dev page is hard to imagine for this service.
  if (
    FORBIDDEN_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".workers.dev")
  ) {
    throw new UrlValidationError(`forbidden hostname: ${hostname}`);
  }

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const words = parseIpv6(hostname.slice(1, -1));
    if (words === null || isForbiddenIpv6(words)) {
      throw new UrlValidationError(`forbidden IP address: ${hostname}`);
    }
    return url;
  }

  const octets = parseIpv4(hostname);
  if (octets !== null) {
    if (isForbiddenIpv4(octets)) {
      throw new UrlValidationError(`forbidden IP address: ${hostname}`);
    }
    return url;
  }

  // Non-literal hostname: pre-resolve over DoH and check the answers.
  // allSettled, not all: an answer from a query that succeeded is never
  // discarded — if the A query returns a private IP, a failing AAAA query
  // must not let the URL bypass the range checks below.
  const [aResult, aaaaResult] = await Promise.allSettled([
    resolve(hostname, "A"),
    resolve(hostname, "AAAA"),
  ]);

  if (aResult.status === "rejected" && aaaaResult.status === "rejected") {
    // Availability over strictness: a full DoH outage must not take the whole
    // API down, and Browser Run resolves the hostname itself anyway. Let it
    // pass — but only when we got no answer at all.
    return url;
  }

  const resolved = [
    ...(aResult.status === "fulfilled" ? aResult.value : []),
    ...(aaaaResult.status === "fulfilled" ? aaaaResult.value : []),
  ];

  if (
    aResult.status === "fulfilled" &&
    aaaaResult.status === "fulfilled" &&
    resolved.length === 0
  ) {
    // Both queries answered NOERROR (dohResolve throws on HTTP errors and on
    // any non-zero DNS RCODE, so SERVFAIL/REFUSED land in the rejected branch
    // above) yet neither returned an address. Cloudflare DoH flattens CNAME
    // chains down to the final A/AAAA records, so a legitimate host reachable
    // over http/https never yields two empty NOERROR answers; this shape is
    // how a split-horizon internal name looks from the outside. Fail closed.
    throw new UrlValidationError(`hostname does not resolve to any IP: ${hostname}`);
  }
  // If exactly one query succeeded and it returned no addresses, we let the
  // URL pass: the other query's failure may indicate a partial DoH problem
  // (429/5xx), so an empty answer alone is not trustworthy evidence that the
  // host has no public address. Same availability-over-strictness stance as
  // the both-failed case above. Note this path is reproducible by an attacker
  // who controls their domain's authoritative DNS (answer A empty, time out
  // AAAA), so it is an accepted risk — but no worse than the both-failed
  // pass-through above, which the same attacker can trigger just as easily.

  for (const ip of resolved) {
    if (isForbiddenIpString(ip)) {
      throw new UrlValidationError(`hostname resolves to a forbidden IP: ${hostname}`);
    }
  }

  return url;
}

async function dohResolve(hostname: string, type: "A" | "AAAA"): Promise<string[]> {
  const query = new URL("https://cloudflare-dns.com/dns-query");
  query.searchParams.set("name", hostname);
  query.searchParams.set("type", type);
  const response = await fetch(query, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`DoH lookup failed with status ${response.status}`);
  }
  const data = (await response.json()) as {
    Status: number;
    Answer?: Array<{ type: number; data: string }>;
  };
  // The DoH-JSON API reports upstream DNS failures (SERVFAIL, REFUSED, ...)
  // as HTTP 200 with a non-zero RCODE in Status and an empty Answer. Treat
  // those as query failures (throw -> rejected in allSettled), not as an
  // authoritative "no records" answer, so transient DNS trouble rides the
  // availability path instead of tripping the empty-answer rejection.
  if (data.Status !== 0) {
    throw new Error(`DoH lookup failed with DNS RCODE ${data.Status}`);
  }
  const wantedType = type === "A" ? 1 : 28; // DNS RR type numbers
  return (data.Answer ?? [])
    .filter((answer) => answer.type === wantedType)
    .map((answer) => answer.data);
}

function isForbiddenIpString(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (octets !== null) {
    return isForbiddenIpv4(octets);
  }
  const words = parseIpv6(ip);
  if (words !== null) {
    return isForbiddenIpv6(words);
  }
  return false;
}

/** Strict dotted-quad parser. Returns the four octets, or null if not IPv4. */
function parseIpv4(host: string): number[] | null {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return null;
  }
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function isForbiddenIpv4(octets: number[]): boolean {
  const [a, b, c] = octets as [number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 ("this network", includes 0.0.0.0)
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 198 && (b === 18 || b === 19)) // 198.18.0.0/15 benchmarking
  );
}

/**
 * Expands an IPv6 literal (without brackets) into its eight 16-bit words.
 * Supports "::" compression, an embedded IPv4 tail ("::ffff:10.0.0.1"),
 * and a zone index suffix ("fe80::1%eth0"). Returns null if malformed.
 * Exported for reuse by the rate limiter's /64 key normalization
 * (src/ratelimit.ts).
 */
export function parseIpv6(literal: string): number[] | null {
  const addr = literal.split("%")[0] ?? "";
  const halves = addr.split("::");
  if (halves.length > 2) {
    return null;
  }

  const splitGroups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  let head = splitGroups(halves[0] ?? "");
  let tail = halves.length === 2 ? splitGroups(halves[1] ?? "") : null;

  // An embedded IPv4 address may only appear as the final group.
  const expandV4Tail = (groups: string[]): string[] | null => {
    const last = groups[groups.length - 1];
    if (last === undefined || !last.includes(".")) {
      return groups;
    }
    const octets = parseIpv4(last);
    if (octets === null) {
      return null;
    }
    const [o1, o2, o3, o4] = octets as [number, number, number, number];
    return [
      ...groups.slice(0, -1),
      (((o1 << 8) | o2) >>> 0).toString(16),
      (((o3 << 8) | o4) >>> 0).toString(16),
    ];
  };

  const target = tail ?? head;
  const expanded = expandV4Tail(target);
  if (expanded === null) {
    return null;
  }
  if (tail !== null) {
    tail = expanded;
  } else {
    head = expanded;
  }

  let groups: string[];
  if (tail !== null) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) {
      return null;
    }
    groups = [...head, ...(Array(fill).fill("0") as string[]), ...tail];
  } else {
    groups = head;
  }

  if (groups.length !== 8) {
    return null;
  }

  const words = groups.map((group) =>
    /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN,
  );
  return words.some(Number.isNaN) ? null : words;
}

function isForbiddenIpv6(words: number[]): boolean {
  const zeroRange = (start: number, end: number) =>
    words.slice(start, end).every((word) => word === 0);
  const embeddedIpv4 = (hi: number, lo: number) =>
    isForbiddenIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);

  const w0 = words[0] ?? 0;
  const w1 = words[1] ?? 0;
  const w2 = words[2] ?? 0;
  const w5 = words[5] ?? 0;
  const w6 = words[6] ?? 0;
  const w7 = words[7] ?? 0;

  // "::" (unspecified) and "::1" (loopback)
  if (zeroRange(0, 7) && (w7 === 0 || w7 === 1)) {
    return true;
  }
  if ((w0 & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique local
  }
  if ((w0 & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }
  // IPv4-mapped (::ffff:a.b.c.d)
  if (zeroRange(0, 5) && w5 === 0xffff) {
    return embeddedIpv4(w6, w7);
  }
  // IPv4-compatible (deprecated "::a.b.c.d"; canonical hex form "::7f00:1")
  if (zeroRange(0, 6)) {
    return embeddedIpv4(w6, w7);
  }
  // 6to4 (2002:V4HI:V4LO::/48)
  if (w0 === 0x2002) {
    return embeddedIpv4(w1, w2);
  }
  // NAT64 well-known prefix (64:ff9b::a.b.c.d)
  if (w0 === 0x0064 && w1 === 0xff9b && zeroRange(2, 6)) {
    return embeddedIpv4(w6, w7);
  }
  return false;
}
