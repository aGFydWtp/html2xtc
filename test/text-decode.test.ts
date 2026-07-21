// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import * as JapaneseEncoding from "encoding-japanese";
import { describe, expect, it } from "vitest";
import {
  BinaryTextFileError,
  EncodingDetectionFailedError,
  Utf16NotSupportedError,
  decodeTextFile,
  hasUtf16Bom,
  looksBinary,
  replacementRatio,
} from "../src/text-decode";

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function withUtf8Bom(text: string): Uint8Array {
  const body = utf8Bytes(text);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}

function cp932Bytes(text: string): Uint8Array {
  const codes = JapaneseEncoding.convert(text, { to: "SJIS", from: "UNICODE", type: "array" });
  return Uint8Array.from(codes);
}

describe("hasUtf16Bom", () => {
  it("detects UTF-16LE and UTF-16BE BOMs", () => {
    expect(hasUtf16Bom(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]))).toBe(true);
    expect(hasUtf16Bom(Uint8Array.from([0xfe, 0xff, 0x00, 0x41]))).toBe(true);
  });

  it("is false for UTF-8 (with or without BOM) and empty input", () => {
    expect(hasUtf16Bom(utf8Bytes("hello"))).toBe(false);
    expect(hasUtf16Bom(withUtf8Bom("hello"))).toBe(false);
    expect(hasUtf16Bom(new Uint8Array())).toBe(false);
  });
});

describe("looksBinary", () => {
  it("flags a NUL byte anywhere in the sniff window", () => {
    expect(looksBinary(Uint8Array.from([0x41, 0x00, 0x42]))).toBe(true);
  });

  it("flags known binary magics", () => {
    expect(looksBinary(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(true); // %PDF-
    expect(looksBinary(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true); // ZIP
    expect(looksBinary(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true); // PNG
  });

  it("flags a high ASCII-control-byte ratio", () => {
    const bytes = new Uint8Array(200).fill(0x01);
    expect(looksBinary(bytes)).toBe(true);
  });

  it("accepts plain ASCII/UTF-8 English text", () => {
    expect(looksBinary(utf8Bytes("Hello, world!\nThis is a normal line.\n"))).toBe(false);
  });

  it("does not miscount Shift_JIS/CP932 multi-byte sequences as control bytes", () => {
    const bytes = cp932Bytes("これは日本語のテキストファイルです。\n".repeat(20));
    expect(looksBinary(bytes)).toBe(false);
  });

  it("keeps LF/TAB/CR out of the control-byte ratio", () => {
    const bytes = utf8Bytes("a\tb\r\nc\nd\n".repeat(50));
    expect(looksBinary(bytes)).toBe(false);
  });
});

describe("replacementRatio", () => {
  it("is 0 for text with no replacement characters", () => {
    expect(replacementRatio("hello world")).toBe(0);
  });

  it("counts only over non-whitespace characters", () => {
    expect(replacementRatio("�b")).toBeCloseTo(0.5);
    expect(replacementRatio("  �b  ")).toBeCloseTo(0.5);
  });

  it("is 0 for an all-whitespace string", () => {
    expect(replacementRatio("   \n\t")).toBe(0);
  });
});

describe("decodeTextFile: UTF-8", () => {
  it("decodes plain ASCII", () => {
    const result = decodeTextFile(utf8Bytes("Hello, world!"), "auto");
    expect(result).toEqual({ text: "Hello, world!", encoding: "utf-8", confidence: "high" });
  });

  it("decodes UTF-8 Japanese text", () => {
    const result = decodeTextFile(utf8Bytes("吾輩は猫である。"), "auto");
    expect(result.text).toBe("吾輩は猫である。");
    expect(result.encoding).toBe("utf-8");
  });

  it("strips a UTF-8 BOM", () => {
    const result = decodeTextFile(withUtf8Bom("BOM付きテキスト"), "auto");
    expect(result.text).toBe("BOM付きテキスト");
    expect(result.encoding).toBe("utf-8");
  });

  it("manual utf-8 request decodes valid UTF-8", () => {
    const result = decodeTextFile(utf8Bytes("test"), "utf-8");
    expect(result).toEqual({ text: "test", encoding: "utf-8", confidence: "high" });
  });

  it("manual utf-8 request throws on invalid UTF-8 bytes", () => {
    const invalid = Uint8Array.from([0x41, 0xff, 0xfe, 0x42]);
    expect(() => decodeTextFile(invalid, "utf-8")).toThrow(EncodingDetectionFailedError);
  });
});

describe("decodeTextFile: Shift_JIS/CP932", () => {
  it("manual shift_jis request decodes CP932 bytes", () => {
    const result = decodeTextFile(cp932Bytes("日本語のテキスト"), "shift_jis");
    expect(result.text).toBe("日本語のテキスト");
    expect(result.encoding).toBe("shift_jis");
  });

  it("decodes a CP932-specific character (NEC row 13, e.g. Ⅰ Roman numeral I)", () => {
    const result = decodeTextFile(cp932Bytes("ⅠⅡⅢ"), "shift_jis");
    expect(result.text).toBe("ⅠⅡⅢ");
  });

  it("auto-detection falls back to Shift_JIS when the bytes are not valid UTF-8", () => {
    const result = decodeTextFile(cp932Bytes("これは自動判定のテストです。"), "auto");
    expect(result.text).toBe("これは自動判定のテストです。");
    expect(result.encoding).toBe("shift_jis");
  });
});

describe("decodeTextFile: unsupported/invalid input", () => {
  it("rejects UTF-16 BOMs regardless of the requested encoding", () => {
    const utf16le = Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
    expect(() => decodeTextFile(utf16le, "auto")).toThrow(Utf16NotSupportedError);
    expect(() => decodeTextFile(utf16le, "utf-8")).toThrow(Utf16NotSupportedError);
    expect(() => decodeTextFile(utf16le, "shift_jis")).toThrow(Utf16NotSupportedError);
  });

  it("rejects binary input (NUL byte) before attempting to decode", () => {
    const binary = Uint8Array.from([0x41, 0x00, 0x42, 0x43]);
    expect(() => decodeTextFile(binary, "auto")).toThrow(BinaryTextFileError);
  });

  it("auto-detection fails when neither UTF-8 nor CP932 look plausible", () => {
    // 0x80/0xA0/0xFD/0xFE/0xFF are all undefined Shift_JIS/CP932 lead bytes
    // (verified against Encoding.detect(_, "SJIS") => false); not valid
    // UTF-8 either, so this must fail both legs of the auto-detect chain.
    const leadBytes = [0x80, 0xa0, 0xfd, 0xfe, 0xff];
    const garbage = Uint8Array.from(
      Array.from({ length: 200 }, (_, i) => leadBytes[i % leadBytes.length] as number),
    );
    expect(() => decodeTextFile(garbage, "auto")).toThrow(EncodingDetectionFailedError);
  });
});
