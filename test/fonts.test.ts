import { describe, expect, it, vi } from "vitest";
import { buildInlineFontCss } from "../src/fonts";
import type { FontFetcher } from "../src/fonts";

const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";

const face = (weight: number, kit: string) => `@font-face {
  font-family: 'BIZ UDPGothic';
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: url(https://fonts.gstatic.com/l/font?kit=${kit}) format('woff2');
  unicode-range: U+3042, U+3044, U+9c3b;
}`;

const FIXTURE_CSS = `${face(400, "kit400")}\n${face(700, "kit700")}`;

/**
 * Routes css2 URLs to the fixture CSS and gstatic URLs to fixed bytes;
 * records every request for assertions.
 */
function mockFetcher(
  cssBody: string = FIXTURE_CSS,
  woff2Bytes: Uint8Array = new Uint8Array([1, 2, 3, 4]),
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn: FontFetcher = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("https://fonts.googleapis.com/")) {
      return new Response(cssBody, { status: 200 });
    }
    return new Response(woff2Bytes.slice().buffer, { status: 200 });
  });
  return { fetchFn, calls };
}

describe("buildInlineFontCss", () => {
  it("inlines every face as a base64 data URL and keeps unicode-range", async () => {
    const { fetchFn, calls } = mockFetcher();
    const css = await buildInlineFontCss("あい鰻", JOB_ID, fetchFn);
    expect(css).not.toBeNull();
    // [1,2,3,4] -> AQIDBA==
    expect(css).toContain("src:url(data:font/woff2;base64,AQIDBA==) format('woff2')");
    expect(css).toContain("font-weight:400");
    expect(css).toContain("font-weight:700");
    expect(css).toContain("unicode-range:U+3042, U+3044, U+9c3b");
    expect(css).not.toContain("fonts.gstatic.com"); // no remote refs remain
    // 1 css request + 2 woff2 requests
    expect(calls).toHaveLength(3);
    const cssCall = calls[0];
    expect(cssCall?.url).toContain("text=");
    expect(cssCall?.url).toContain(encodeURIComponent("鰻"));
    // Chrome-like UA toward Google Fonts (subset woff2, not the 4.4MB TTF).
    expect(
      new Headers(cssCall?.init.headers).get("User-Agent"),
    ).toContain("Chrome");
  });

  it("splits large character sets into multiple URL-length-safe requests", async () => {
    const { fetchFn, calls } = mockFetcher();
    let text = "";
    for (let i = 0; i < 1000; i++) {
      text += String.fromCharCode(0x4e00 + i);
    }
    const css = await buildInlineFontCss(text, JOB_ID, fetchFn);
    expect(css).not.toBeNull();
    const cssCalls = calls.filter((c) =>
      c.url.startsWith("https://fonts.googleapis.com/"),
    );
    expect(cssCalls).toHaveLength(3); // 1000 chars / 450 per chunk
    for (const call of cssCalls) {
      expect(call.url.length).toBeLessThan(8000);
    }
  });

  it("caps the number of chunks for pathologically rich documents", async () => {
    const { fetchFn, calls } = mockFetcher();
    let text = "";
    for (let i = 0; i < 5000; i++) {
      text += String.fromCodePoint(0x4e00 + i);
    }
    const css = await buildInlineFontCss(text, JOB_ID, fetchFn);
    expect(css).not.toBeNull();
    const cssCalls = calls.filter((c) =>
      c.url.startsWith("https://fonts.googleapis.com/"),
    );
    expect(cssCalls).toHaveLength(8); // MAX_CHUNKS
  });

  it("returns null when the fetch throws (fail-soft)", async () => {
    const fetchFn: FontFetcher = async () => {
      throw new Error("network down");
    };
    await expect(buildInlineFontCss("あ", JOB_ID, fetchFn)).resolves.toBeNull();
  });

  it("returns null on a non-2xx css response", async () => {
    const fetchFn: FontFetcher = async () =>
      new Response("Too Many Requests", { status: 429 });
    await expect(buildInlineFontCss("あ", JOB_ID, fetchFn)).resolves.toBeNull();
  });

  it("returns null when the css has no gstatic woff2 src (unexpected shape)", async () => {
    const ttfCss = `@font-face {
  font-family: 'BIZ UDPGothic';
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/bizudpgothic/full.ttf) format('truetype');
}`;
    const { fetchFn } = mockFetcher(ttfCss);
    await expect(buildInlineFontCss("あ", JOB_ID, fetchFn)).resolves.toBeNull();
  });

  it("returns null when the fonts exceed the inline size cap", async () => {
    // Two faces of this each -> just over the 2 MiB total cap.
    const big = new Uint8Array(1024 * 1024 + 1024);
    const { fetchFn } = mockFetcher(FIXTURE_CSS, big);
    await expect(buildInlineFontCss("あ", JOB_ID, fetchFn)).resolves.toBeNull();
  });

  it("returns null for text with no subsettable characters", async () => {
    const { fetchFn, calls } = mockFetcher();
    await expect(buildInlineFontCss("\n\t", JOB_ID, fetchFn)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});
