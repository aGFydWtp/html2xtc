import { describe, expect, it } from "vitest";
import { buildColophonScript, formatJstTimestamp } from "../src/pdf";

const CONVERTED_AT = "2026-07-18 21:30 JST";

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
