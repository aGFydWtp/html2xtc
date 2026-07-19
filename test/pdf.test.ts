import { describe, expect, it, vi } from "vitest";
import {
  buildColophonScript,
  formatJstTimestamp,
  renderPdfFromHtml,
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

  it("waits a fixed grace period for the font decode/swap", async () => {
    const { env, quickAction } = captureEnv();
    await renderPdfFromHtml(env, "<html></html>", "@font-face{}");
    expect(capturedOptions(quickAction).waitForTimeout).toBe(1_500);
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

  it("prefers BIZ UDPGothic with the Noto CJK fallback stack", () => {
    // Order matters: web font first, then the fonts preinstalled on
    // Browser Run so a failed fetch degrades to the previous rendering.
    expect(X3_PRINT_CSS).toMatch(
      /font-family:\s*"BIZ UDPGothic",\s*"Noto Sans JP",\s*"Hiragino Sans",\s*sans-serif !important/,
    );
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
