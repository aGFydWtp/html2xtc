// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { hasDisallowedUrlScheme, sanitizeSvgMarkup } from "../../src/epub/assets";

const noResolve = () => undefined;
const resolveToDataUrl = (raw: string) =>
  raw === "images/foo.png" ? "data:image/png;base64,AAAA" : undefined;

describe("hasDisallowedUrlScheme: baseline scheme blocking", () => {
  it("blocks http/https/javascript/data/etc.", () => {
    for (const scheme of ["http://x", "https://x", "javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "blob:x", "filesystem:x", "ftp://x"]) {
      expect(hasDisallowedUrlScheme(scheme)).toBe(true);
    }
  });

  it("allows a plain relative reference", () => {
    expect(hasDisallowedUrlScheme("images/foo.png")).toBe(false);
  });
});

describe("hasDisallowedUrlScheme: TAB/CR/LF scheme-name obfuscation (review M1)", () => {
  it("blocks a javascript: URL with an embedded TAB before the colon", () => {
    expect(hasDisallowedUrlScheme("java\tscript:alert(1)")).toBe(true);
  });

  it("blocks a javascript: URL with an embedded newline", () => {
    expect(hasDisallowedUrlScheme("java\nscript:alert(1)")).toBe(true);
  });

  it("blocks a javascript: URL with an embedded carriage return", () => {
    expect(hasDisallowedUrlScheme("java\rscript:alert(1)")).toBe(true);
  });

  it("blocks a javascript: URL with control chars scattered across the whole scheme name", () => {
    expect(hasDisallowedUrlScheme("j\ta\nv\ra\tscript:alert(1)")).toBe(true);
  });
});

describe("sanitizeSvgMarkup: SMIL animation removal (review C1)", () => {
  it("removes an <animate> that retargets an ancestor <a>'s href to javascript:", () => {
    const svg =
      '<svg><a href="#safe"><animate attributeName="href" from="0" to="javascript:alert(1)" begin="0s" dur="1s"/>click</a></svg>';
    const out = sanitizeSvgMarkup(svg, noResolve);
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<animate");
    expect(out).toContain("click");
  });

  it("removes animateTransform/animateMotion/animateColor/set elements", () => {
    const svg =
      '<svg><rect><animateTransform attributeName="transform" to="javascript:alert(1)"/><animateMotion path="javascript:alert(1)"/><animateColor attributeName="fill" to="javascript:alert(1)"/><set attributeName="href" to="javascript:alert(1)"/></rect></svg>';
    const out = sanitizeSvgMarkup(svg, noResolve);
    expect(out).not.toContain("javascript:");
    expect(out).not.toMatch(/<(animateTransform|animateMotion|animateColor|set)/i);
  });
});

describe("sanitizeSvgMarkup: <style> element sanitization (review H2)", () => {
  it("removes an external url() reference from an inline <style>", () => {
    const svg = '<svg><style>rect{background-image:url(http://evil.example/track.png)}</style><rect width="1" height="1"/></svg>';
    const out = sanitizeSvgMarkup(svg, noResolve);
    expect(out).not.toContain("evil.example");
    expect(out).toContain("<rect");
  });

  it("rewrites a resolvable relative url() inside <style> to the resolver's data: URL", () => {
    const svg = '<svg><style>rect{background-image:url(images/foo.png)}</style><rect width="1" height="1"/></svg>';
    const out = sanitizeSvgMarkup(svg, resolveToDataUrl);
    expect(out).toContain("data:image/png;base64,AAAA");
    expect(out).not.toContain("images/foo.png");
  });

  it("drops a javascript: expression() from an inline <style>", () => {
    const svg = '<svg><style>rect{width:expression(javascript:alert(1))}</style><rect width="1" height="1"/></svg>';
    const out = sanitizeSvgMarkup(svg, noResolve);
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("expression");
  });
});

describe("sanitizeSvgMarkup: baseline behavior preserved", () => {
  it("still removes <script> and <foreignObject>", () => {
    const svg = '<svg><script>alert(1)</script><foreignObject>x</foreignObject><circle r="1"/></svg>';
    const out = sanitizeSvgMarkup(svg, noResolve);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<foreignObject");
    expect(out).toContain("<circle");
  });

  it("still strips on* event attributes", () => {
    const svg = '<svg onload="alert(1)"><circle r="1"/></svg>';
    const out = sanitizeSvgMarkup(svg, noResolve);
    expect(out).not.toContain("onload");
  });

  it("returns undefined for markup with no parseable <svg> root", () => {
    expect(sanitizeSvgMarkup("<p>not svg</p>", noResolve)).toBeUndefined();
  });
});
