import { describe, expect, it } from "vitest";
import { escapeXmlText, stripControlChars } from "../src/opds/xml";

// Built via String.fromCharCode (never a literal escape sequence in source)
// so the test fixture is unambiguous regardless of how the surrounding
// tooling round-trips backslash escapes.
const NUL = String.fromCharCode(0x00);
const SOH = String.fromCharCode(0x01);
const DEL = String.fromCharCode(0x7f);

describe("stripControlChars", () => {
  it("removes C0 control characters and DEL", () => {
    expect(stripControlChars(`a${NUL}b${SOH}c${DEL}d`)).toBe("abcd");
  });

  it("keeps tab, LF, and CR", () => {
    expect(stripControlChars("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("leaves ordinary text untouched", () => {
    expect(stripControlChars("日本語タイトル")).toBe("日本語タイトル");
  });
});

describe("escapeXmlText", () => {
  it("escapes the five XML predefined entities", () => {
    expect(escapeXmlText(`<a & "b" 'c'>`)).toBe("&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;");
  });

  it("escapes & before other entities so it isn't double-escaped", () => {
    expect(escapeXmlText("&amp;")).toBe("&amp;amp;");
  });

  it("passes Japanese titles through unescaped (no XML-special chars)", () => {
    expect(escapeXmlText("吾輩は猫である")).toBe("吾輩は猫である");
  });

  it("strips control characters before escaping", () => {
    expect(escapeXmlText(`bad${NUL}<>`)).toBe("bad&lt;&gt;");
  });
});
