import { describe, expect, it, vi } from "vitest";
import {
  buildColophonScript,
  formatJstTimestamp,
  renderPdf,
  renderPdfFromHtml,
  LAZY_IMAGE_SCRIPT,
  PRINT_FONT_CSS_URL,
  X3_PRINT_CSS,
  X3_PRINT_CSS_NO_FONT_IMPORT,
} from "../src/pdf";
import type { Env } from "../src/types";

const CONVERTED_AT = "2026-07-18 21:30 JST";

describe("renderPdfFromHtml", () => {
  const captureEnv = () => {
    const quickAction = vi.fn(
      async (_action: string, _options: unknown) =>
        new Response("%PDF", { status: 200 }),
    );
    return {
      env: { BROWSER: { quickAction } as unknown as BrowserRun } as Env,
      quickAction,
    };
  };
  const capturedOptions = (
    quickAction: ReturnType<typeof captureEnv>["quickAction"],
  ) =>
    quickAction.mock.calls[0]?.[1] as {
      addStyleTag: Array<{ content: string }>;
      waitForTimeout?: number;
    };
  const styleContents = (
    quickAction: ReturnType<typeof captureEnv>["quickAction"],
  ) => capturedOptions(quickAction).addStyleTag.map((tag) => tag.content);

  it("injects the inline font css via addStyleTag, faces before rules", async () => {
    const { env, quickAction } = captureEnv();
    const fontCss = "@font-face{font-family:'BIZ UDPGothic';src:url(data:font/woff2;base64,AQIDBA==) format('woff2');}";
    await renderPdfFromHtml(env, "<html></html>", fontCss);
    const styles = styleContents(quickAction);
    // Browser Run applies custom fonts only through addStyleTag (docs), so
    // the font MUST be here, and before the rules that reference it. The
    // no-@import variant avoids a second network fetch of the same family.
    expect(styles).toEqual([fontCss, X3_PRINT_CSS_NO_FONT_IMPORT]);
  });

  it("falls back to the @import print css when no font css is available", async () => {
    const { env, quickAction } = captureEnv();
    await renderPdfFromHtml(env, "<html></html>", null);
    expect(styleContents(quickAction)).toEqual([X3_PRINT_CSS]);
  });

  it("waits a fixed grace period for the font decode and image tail", async () => {
    const { env, quickAction } = captureEnv();
    await renderPdfFromHtml(env, "<html></html>", "@font-face{}");
    // networkidle2 fires with up to 2 image fetches still in flight; this
    // grace lets those stragglers land before capture.
    expect(capturedOptions(quickAction).waitForTimeout).toBe(3_000);
  });
});

describe("renderPdf (full-page path)", () => {
  const captureEnv = () => {
    const quickAction = vi.fn(
      async (_action: string, _options: unknown) =>
        new Response("%PDF", { status: 200 }),
    );
    return {
      env: { BROWSER: { quickAction } as unknown as BrowserRun } as Env,
      quickAction,
    };
  };

  it("injects the lazy-image script before the colophon script", async () => {
    const { env, quickAction } = captureEnv();
    await renderPdf(env, "https://example.com/article");
    const options = quickAction.mock.calls[0]?.[1] as {
      addScriptTag: Array<{ content: string }>;
      waitForTimeout?: number;
    };
    expect(options.addScriptTag[0]?.content).toBe(LAZY_IMAGE_SCRIPT);
    expect(options.addScriptTag).toHaveLength(2);
    // Budget for the script's scroll phase (<= 6 s) + image fetch tail;
    // also subsumes the previous 3 s font grace. Must stay under the
    // quick-action cap (60 s) and inside the workflow step budget.
    expect(options.waitForTimeout).toBe(10_000);
  });
});

describe("LAZY_IMAGE_SCRIPT", () => {
  it("is syntactically valid standalone JavaScript", () => {
    expect(() => new Function(LAZY_IMAGE_SCRIPT)).not.toThrow();
  });

  it("covers deferred-src promotion, eager-izing and scrolling", () => {
    for (const marker of [
      "data-src",
      "data-lazy-src",
      "data-original",
      "data-srcset",
      '"eager"',
      "scrollTo",
    ]) {
      expect(LAZY_IMAGE_SCRIPT).toContain(marker);
    }
  });
});

describe("X3_PRINT_CSS", () => {
  it("imports the BIZ UDPGothic stylesheet as the first rule", () => {
    // CSS silently drops an @import that follows any other rule, so the
    // import must come before @page/@media in the stylesheet text.
    const firstRule = X3_PRINT_CSS.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    expect(firstRule.startsWith(`@import url("${PRINT_FONT_CSS_URL}");`)).toBe(
      true,
    );
    expect(PRINT_FONT_CSS_URL).toContain("BIZ+UDPGothic");
    expect(PRINT_FONT_CSS_URL).toContain("display=swap");
  });

  it("prefers BIZ UDPGothic with the fallback stack", () => {
    // Web font first. The named fallbacks do NOT exist on Browser Run (its
    // only CJK face is WenQuanYi Zen Hei); they are harmless there and only
    // matter for local previews or a future runtime image.
    expect(X3_PRINT_CSS).toMatch(
      /font-family:\s*"BIZ UDPGothic",\s*"Noto Sans JP",\s*"Hiragino Sans",\s*sans-serif !important/,
    );
  });

  it("declares the body font-family OUTSIDE the @media print block", () => {
    // Regression pin for the root cause of the font-not-applied bug:
    // Chromium only lazy-loads a web font when some element uses its family
    // under the CURRENT media. With font-family inside @media print, the
    // face stays unloaded during screen rendering, and the print path
    // captures with the fallback instead of waiting for the load. The rule
    // must therefore precede @media print at the stylesheet top level.
    for (const raw of [X3_PRINT_CSS, X3_PRINT_CSS_NO_FONT_IMPORT]) {
      // Comments mention both terms; only the actual rules matter.
      const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
      const familyIndex = css.indexOf("font-family:");
      const printIndex = css.indexOf("@media print");
      expect(familyIndex).toBeGreaterThan(-1);
      expect(printIndex).toBeGreaterThan(-1);
      expect(familyIndex).toBeLessThan(printIndex);
      // ...and no font-family may sneak back inside the print block.
      expect(css.slice(printIndex)).not.toContain("font-family");
    }
  });
});

describe("buildColophonScript", () => {
  it("stays syntactically valid with hostile characters in the URL", () => {
    // Quote, backslash and a closing script tag must not break out of the
    // embedded string literal (they are JSON.stringify-escaped).
    const hostileUrls = [
      'https://example.com/a?q="quote"',
      "https://example.com/a?q=back\\slash",
      "https://example.com/a?q=</script><script>alert(1)</script>",
      'https://example.com/</script>"\\`${}  ',
    ];
    for (const url of hostileUrls) {
      const script = buildColophonScript(url, CONVERTED_AT);
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it("stays syntactically valid with hostile characters in convertedAt", () => {
    const script = buildColophonScript(
      "https://example.com/",
      '"</script>\\',
    );
    expect(() => new Function(script)).not.toThrow();
  });

  it("embeds url and convertedAt as escaped string literals", () => {
    const url = "https://example.com/article";
    const script = buildColophonScript(url, CONVERTED_AT);
    expect(script).toContain(JSON.stringify(url));
    expect(script).toContain(JSON.stringify(CONVERTED_AT));
  });
});

describe("formatJstTimestamp", () => {
  it("formats in JST regardless of runtime timezone", () => {
    // 12:30 UTC = 21:30 JST (UTC+9, no DST).
    expect(formatJstTimestamp(new Date("2026-07-18T12:30:00Z"))).toBe(
      "2026-07-18 21:30 JST",
    );
  });

  it("renders midnight as 00, not 24, and rolls the date over", () => {
    // 15:00 UTC = 00:00 JST the next day; hourCycle "h23" keeps it "00".
    expect(formatJstTimestamp(new Date("2026-01-01T15:00:00Z"))).toBe(
      "2026-01-02 00:00 JST",
    );
  });
});
