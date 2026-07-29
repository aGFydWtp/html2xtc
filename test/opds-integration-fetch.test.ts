// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpdsAuthHeaders,
  fetchOpdsResource,
  validateOpdsExternalUrl,
} from "../src/integrations/opds/fetch";
import type { DecryptedOpdsConnection } from "../src/integrations/opds/types";
import { UrlValidationError } from "../src/validate";

const NONE_CONNECTION: DecryptedOpdsConnection = {
  id: "conn-1",
  accountId: "acct-1",
  provider: "generic",
  authType: "none",
  catalogUrl: "https://opds.example.com/catalog",
  origin: "https://opds.example.com",
  host: "opds.example.com",
  username: null,
  password: null,
};

const BASIC_CONNECTION: DecryptedOpdsConnection = {
  ...NONE_CONNECTION,
  authType: "basic",
  username: "reader",
  password: "s3cret",
};

/**
 * Non-literal hostnames (every "*.example.com" used below) go through
 * src/validate.ts's DoH pre-resolution, which itself calls the SAME global
 * fetch() this test suite otherwise mocks for the OPDS request itself.
 * Without special-casing the DoH endpoint, every mockResolvedValueOnce
 * queue would be silently consumed by DoH lookups instead of the intended
 * feed/redirect responses. This installs one fetch mock that answers any
 * cloudflare-dns.com DoH query with "resolves to a public IP" and delegates
 * everything else to `handler`.
 */
function installFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://cloudflare-dns.com/")) {
      const isA = url.includes("type=A");
      return new Response(
        JSON.stringify({ Status: 0, Answer: isA ? [{ type: 1, data: "203.0.113.5" }] : [] }),
        { status: 200 },
      );
    }
    return handler(url, init);
  }) as unknown as typeof fetch;
}

describe("validateOpdsExternalUrl", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accepts a plain https URL", async () => {
    installFetchMock(() => new Response("unused", { status: 200 }));
    await expect(validateOpdsExternalUrl("https://opds.example.com/catalog")).resolves.toBeInstanceOf(URL);
  });

  it("rejects http", async () => {
    await expect(validateOpdsExternalUrl("http://opds.example.com/catalog")).rejects.toThrow(UrlValidationError);
  });

  it("rejects a data: URL", async () => {
    await expect(validateOpdsExternalUrl("data:text/plain;base64,aGVsbG8=")).rejects.toThrow(UrlValidationError);
  });

  it("rejects userinfo", async () => {
    await expect(validateOpdsExternalUrl("https://user:pass@opds.example.com/catalog")).rejects.toThrow(
      UrlValidationError,
    );
  });

  it("strips a fragment rather than rejecting it", async () => {
    installFetchMock(() => new Response("unused", { status: 200 }));
    const url = await validateOpdsExternalUrl("https://opds.example.com/catalog#frag");
    expect(url.hash).toBe("");
  });

  it("rejects localhost", async () => {
    await expect(validateOpdsExternalUrl("https://localhost/catalog")).rejects.toThrow(UrlValidationError);
  });

  it("rejects a private IPv4 literal", async () => {
    await expect(validateOpdsExternalUrl("https://192.168.1.1/catalog")).rejects.toThrow(UrlValidationError);
  });

  it("rejects an IPv6 loopback literal", async () => {
    await expect(validateOpdsExternalUrl("https://[::1]/catalog")).rejects.toThrow(UrlValidationError);
  });

  it("rejects a link-local metadata-style IPv4 literal", async () => {
    await expect(validateOpdsExternalUrl("https://169.254.169.254/catalog")).rejects.toThrow(UrlValidationError);
  });
});

describe("buildOpdsAuthHeaders", () => {
  it("adds no Authorization header for authType=none", () => {
    const { headers, authOrigin } = buildOpdsAuthHeaders(NONE_CONNECTION);
    expect(headers.has("Authorization")).toBe(false);
    expect(authOrigin).toBeNull();
  });

  it("adds a Basic Authorization header for authType=basic", () => {
    const { headers, authOrigin } = buildOpdsAuthHeaders(BASIC_CONNECTION);
    const expected = `Basic ${btoa("reader:s3cret")}`;
    expect(headers.get("Authorization")).toBe(expected);
    expect(authOrigin).toBe("https://opds.example.com");
  });
});

describe("fetchOpdsResource", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the response directly when there is no redirect", async () => {
    let calls = 0;
    installFetchMock(() => {
      calls += 1;
      return new Response("ok", { status: 200 });
    });

    const { headers, authOrigin } = buildOpdsAuthHeaders(NONE_CONNECTION);
    const result = await fetchOpdsResource(new URL("https://opds.example.com/catalog"), { headers, authOrigin });
    expect(result.response.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("follows a same-origin redirect and re-validates the target", async () => {
    let calls = 0;
    installFetchMock((url) => {
      calls += 1;
      if (url === "https://opds.example.com/catalog") {
        return new Response(null, { status: 302, headers: { Location: "https://opds.example.com/catalog2" } });
      }
      return new Response("ok", { status: 200 });
    });

    const { headers, authOrigin } = buildOpdsAuthHeaders(NONE_CONNECTION);
    const result = await fetchOpdsResource(new URL("https://opds.example.com/catalog"), { headers, authOrigin });
    expect(result.response.status).toBe(200);
    expect(result.finalUrl.toString()).toBe("https://opds.example.com/catalog2");
    expect(calls).toBe(2);
  });

  it("rejects more than MAX_OPDS_REDIRECTS hops", async () => {
    installFetchMock(
      () => new Response(null, { status: 302, headers: { Location: "https://opds.example.com/next" } }),
    );

    const { headers, authOrigin } = buildOpdsAuthHeaders(NONE_CONNECTION);
    await expect(
      fetchOpdsResource(new URL("https://opds.example.com/catalog"), { headers, authOrigin }),
    ).rejects.toThrow(UrlValidationError);
  });

  it("rejects a redirect that downgrades to http", async () => {
    installFetchMock(
      () => new Response(null, { status: 302, headers: { Location: "http://opds.example.com/catalog" } }),
    );

    const { headers, authOrigin } = buildOpdsAuthHeaders(NONE_CONNECTION);
    await expect(
      fetchOpdsResource(new URL("https://opds.example.com/catalog"), { headers, authOrigin }),
    ).rejects.toThrow(UrlValidationError);
  });

  it("cancels the previous hop's response body before following a redirect", async () => {
    let cancelCalled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("unused"));
        controller.close();
      },
      cancel() {
        cancelCalled = true;
      },
    });
    installFetchMock((url) => {
      if (url === "https://opds.example.com/catalog") {
        return new Response(body, { status: 302, headers: { Location: "https://opds.example.com/catalog2" } });
      }
      return new Response("ok", { status: 200 });
    });

    const { headers, authOrigin } = buildOpdsAuthHeaders(NONE_CONNECTION);
    await fetchOpdsResource(new URL("https://opds.example.com/catalog"), { headers, authOrigin });
    expect(cancelCalled).toBe(true);
  });

  it("does not forward the Authorization header across a cross-origin redirect", async () => {
    const seenAuthHeaders: (string | null)[] = [];
    installFetchMock((url, init) => {
      const headers = new Headers(init?.headers);
      seenAuthHeaders.push(headers.get("Authorization"));
      if (url === "https://opds.example.com/file") {
        return new Response(null, { status: 302, headers: { Location: "https://cdn.other-example.com/file.epub" } });
      }
      return new Response("ok", { status: 200 });
    });

    const { headers, authOrigin } = buildOpdsAuthHeaders(BASIC_CONNECTION);
    await fetchOpdsResource(new URL("https://opds.example.com/file"), { headers, authOrigin });

    expect(seenAuthHeaders[0]).not.toBeNull();
    expect(seenAuthHeaders[1]).toBeNull();
  });
});
