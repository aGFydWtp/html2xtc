// SPDX-License-Identifier: AGPL-3.0-or-later
import * as EncodingJapanese from "encoding-japanese";
import { describe, expect, it } from "vitest";
import { decodeTextBytes, TextDecodeError } from "../src/lib/text-decode";

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8BomBytes(text: string): Uint8Array {
  const body = utf8Bytes(text);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}

function sjisBytes(text: string): Uint8Array {
  const codes = EncodingJapanese.convert(EncodingJapanese.stringToCode(text), { to: "SJIS", from: "UNICODE" }) as number[];
  return Uint8Array.from(codes);
}

const JP_TEXT = "こんにちは、世界。改行も含む\nテキストです。";

describe("decodeTextBytes — auto detection (§5.3)", () => {
  it("detects plain UTF-8 (no BOM) with medium confidence", () => {
    const { text, result } = decodeTextBytes(utf8Bytes(JP_TEXT), "auto");
    expect(text).toBe(JP_TEXT);
    expect(result.encoding).toBe("utf-8");
    expect(result.confidence).toBe("medium");
    expect(result.replacementRatio).toBe(0);
  });

  it("detects UTF-8 with BOM as high confidence and strips the BOM", () => {
    const { text, result } = decodeTextBytes(utf8BomBytes(JP_TEXT), "auto");
    expect(text).toBe(JP_TEXT);
    expect(result.encoding).toBe("utf-8");
    expect(result.confidence).toBe("high");
  });

  it("falls back to Shift_JIS when the bytes are not valid UTF-8", () => {
    const { text, result } = decodeTextBytes(sjisBytes(JP_TEXT), "auto");
    expect(text).toBe(JP_TEXT);
    expect(result.encoding).toBe("shift_jis");
  });

  it("throws kind 'empty' (not encoding_unknown) for whitespace-only UTF-8 content", () => {
    // A strict UTF-8 decode succeeds here — the file is valid UTF-8, just
    // empty of usable characters. That's an empty-file condition, not an
    // encoding-detection failure, so it must map to text_err_empty in the UI
    // rather than the generic "encoding unknown" message.
    expect(() => decodeTextBytes(utf8Bytes("   \n\t  "), "auto")).toThrowError(TextDecodeError);
    try {
      decodeTextBytes(utf8Bytes("   "), "auto");
    } catch (e) {
      expect((e as TextDecodeError).kind).toBe("empty");
    }
  });

  it("rejects a garbage byte sequence with no known magic and no NUL byte via the Shift_JIS detect() gate", () => {
    // 0x80/0xA0/0xFD/0xFE/0xFF are all undefined Shift_JIS/CP932 lead bytes
    // (mirrors src/text-decode.test.ts's server-side equivalent test): not
    // valid UTF-8 either, so this must fail both legs of the auto-detect
    // chain and be rejected as encoding_unknown rather than silently
    // "converted" via encoding-japanese's permissive convert().
    const leadBytes = [0x80, 0xa0, 0xfd, 0xfe, 0xff];
    const garbage = Uint8Array.from(
      Array.from({ length: 200 }, (_, i) => leadBytes[i % leadBytes.length] as number),
    );
    expect(() => decodeTextBytes(garbage, "auto")).toThrowError(TextDecodeError);
    try {
      decodeTextBytes(garbage, "auto");
    } catch (e) {
      expect((e as TextDecodeError).kind).toBe("encoding_unknown");
    }
  });
});

describe("decodeTextBytes — failure conditions (§5.4)", () => {
  it("rejects a UTF-16LE BOM", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00]);
    expect(() => decodeTextBytes(bytes, "auto")).toThrowError(TextDecodeError);
    try {
      decodeTextBytes(bytes, "auto");
    } catch (e) {
      expect((e as TextDecodeError).kind).toBe("utf16");
    }
  });

  it("rejects a UTF-16BE BOM", () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x41]);
    expect(() => decodeTextBytes(bytes, "auto")).toThrowError(TextDecodeError);
  });

  it("rejects content with a NUL byte", () => {
    const bytes = new Uint8Array([0x41, 0x00, 0x42]);
    try {
      decodeTextBytes(bytes, "auto");
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TextDecodeError);
      expect((e as TextDecodeError).kind).toBe("binary");
    }
  });
});

describe("decodeTextBytes — manual encoding selection (§10.5)", () => {
  it("decodes as UTF-8 when explicitly requested", () => {
    const { text, result } = decodeTextBytes(utf8Bytes(JP_TEXT), "utf-8");
    expect(text).toBe(JP_TEXT);
    expect(result.encoding).toBe("utf-8");
  });

  it("throws when explicitly requesting UTF-8 on non-UTF-8 bytes", () => {
    expect(() => decodeTextBytes(sjisBytes(JP_TEXT), "utf-8")).toThrowError(TextDecodeError);
  });

  it("decodes as Shift_JIS when explicitly requested", () => {
    const { text, result } = decodeTextBytes(sjisBytes(JP_TEXT), "shift_jis");
    expect(text).toBe(JP_TEXT);
    expect(result.encoding).toBe("shift_jis");
  });
});
