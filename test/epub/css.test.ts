// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { describe, expect, it } from "vitest";
import { sanitizeCss, sanitizeInlineStyle } from "../../src/epub/css";

const noResolve = () => undefined;
const resolveToDataUrl = (raw: string) =>
  raw === "images/foo.png" ? "data:image/png;base64,AAAA" : undefined;

describe("sanitizeCss: @import removal (spec §19.1 @import除去)", () => {
  it("drops an @import statement entirely", () => {
    const css = `@import url("other.css");\nbody { color: red; }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).not.toMatch(/@import/i);
    expect(out).toContain("color: red");
  });

  it("drops a quoteless @import block form too", () => {
    const css = `@import "other.css";\np { color: blue; }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).not.toMatch(/@import/i);
  });
});

describe("sanitizeCss: external url() removal (spec §19.1 外部url()除去)", () => {
  it("drops a declaration whose url() is http(s)", () => {
    const css = `body { background-image: url("https://evil.example/x.png"); }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).not.toContain("background-image");
    expect(out).not.toContain("evil.example");
  });

  it("drops a declaration whose url() is a bare ftp/file reference", () => {
    const css = `p { background: url(ftp://x/y.png) red; }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).not.toContain("background");
  });
});

describe("sanitizeCss: relative image url() -> data URL (spec §19.1 相対画像Data URL化)", () => {
  it("rewrites a resolvable relative url() to the resolver's data: URL", () => {
    const css = `body { background-image: url("images/foo.png"); }`;
    const out = sanitizeCss(css, resolveToDataUrl);
    expect(out).toContain('url("data:image/png;base64,AAAA")');
  });

  it("drops the declaration when the resolver can't resolve the reference", () => {
    const css = `body { background-image: url("images/missing.png"); }`;
    const out = sanitizeCss(css, resolveToDataUrl);
    expect(out).not.toContain("background-image");
  });
});

describe("sanitizeCss: javascript: removal (spec §19.1 javascript:除去)", () => {
  it("drops a declaration whose value contains a javascript: URL", () => {
    const css = `a { background: url(javascript:alert(1)); }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("background");
  });

  it("drops a declaration containing a bare javascript: string with no url()", () => {
    const css = `a { color: expression(javascript:alert(1)); }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).not.toContain("javascript");
  });
});

describe("sanitizeCss: writing-mode preserved (spec §19.1 writing-mode保持)", () => {
  it("keeps writing-mode: vertical-rl and text-orientation", () => {
    const css = `body { writing-mode: vertical-rl; text-orientation: mixed; }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).toContain("writing-mode: vertical-rl");
    expect(out).toContain("text-orientation: mixed");
  });

  it("keeps text-combine-upright and ruby-position (spec §10.4)", () => {
    const css = `.tatechuyoko { text-combine-upright: all; } rt { ruby-position: over; }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).toContain("text-combine-upright: all");
    expect(out).toContain("ruby-position: over");
  });
});

describe("sanitizeCss: @font-face removal (spec §19.1 font-face除去, design decision D3)", () => {
  it("drops an entire @font-face block, embedded font data included", () => {
    const css = `@font-face { font-family: "Embedded"; src: url("fonts/embedded.woff2") format("woff2"); }\nbody { font-family: "Embedded"; }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).not.toMatch(/@font-face/i);
    expect(out).not.toContain("embedded.woff2");
    // The unrelated body rule survives (only the @font-face block itself is dropped).
    expect(out).toContain("font-family");
  });
});

describe("sanitizeCss: malformed CSS (spec §19.1 malformed CSS)", () => {
  it("never throws on unbalanced braces", () => {
    expect(() => sanitizeCss("body { color: red; ", noResolve)).not.toThrow();
    expect(() => sanitizeCss("body color: red; }", noResolve)).not.toThrow();
    expect(() => sanitizeCss("{{{{ } } }", noResolve)).not.toThrow();
  });

  it("skips a declaration with no colon rather than throwing", () => {
    const out = sanitizeCss("body { garbage-no-colon; color: green; }", noResolve);
    expect(out).toContain("color: green");
  });

  it("returns a best-effort prefix for a truncated stylesheet", () => {
    const out = sanitizeCss("body { color: red; } p { color", noResolve);
    expect(out).toContain("color: red");
  });

  it("handles a completely empty stylesheet", () => {
    expect(sanitizeCss("", noResolve)).toBe("");
  });
});

describe("sanitizeCss: at-rule prelude external URL removal (review H1)", () => {
  it("drops an @supports block whose prelude url() points at an external host", () => {
    const css = `@supports (background: url("http://evil.example/track.png")) { body { color: red; } }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("@supports");
    expect(out).not.toContain("color: red");
  });

  it("drops an @media block whose prelude contains an external url()", () => {
    const css = `@media (min-width: 1px), url(https://evil.example/leak?x=1) { body { color: red; } }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("@media");
  });

  it("keeps an @supports block whose prelude has no url() at all", () => {
    const css = `@supports (display: flex) { body { color: red; } }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).toContain("@supports (display: flex)");
    expect(out).toContain("color: red");
  });

  it("rewrites a resolvable relative url() in an @supports prelude to the resolver's data: URL", () => {
    const css = `@supports (background: url(images/foo.png)) { body { color: red; } }`;
    const out = sanitizeCss(css, resolveToDataUrl);
    expect(out).toContain("data:image/png;base64,AAAA");
    expect(out).not.toContain("images/foo.png");
    expect(out).toContain("color: red");
  });
});

describe("sanitizeCss: at-rule nesting (spec §10.2 @media/@page のネスト)", () => {
  it("keeps @media's nested rules, sanitized the same way", () => {
    const css = `@media print { body { color: red; behavior: url(evil.htc); } }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).toContain("@media print");
    expect(out).toContain("color: red");
    expect(out).not.toContain("behavior");
  });

  it("keeps @page's nested declarations", () => {
    const css = `@page { margin: 10px; }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).toContain("@page");
    expect(out).toContain("margin: 10px");
  });
});

describe("sanitizeCss: disallowed properties (design decision D2 許可プロパティ方式)", () => {
  it("drops behavior and -moz-binding declarations", () => {
    const css = `div { behavior: url(evil.htc); -moz-binding: url(evil.xml); color: red; }`;
    const out = sanitizeCss(css, noResolve);
    expect(out).not.toContain("behavior");
    expect(out).not.toContain("-moz-binding");
    expect(out).toContain("color: red");
  });

  it("rewrites position: fixed to position: static", () => {
    const out = sanitizeCss("div { position: fixed; }", noResolve);
    expect(out).toContain("position: static");
    expect(out).not.toContain("fixed");
  });

  it("drops an extreme negative margin", () => {
    const out = sanitizeCss("div { margin-left: -99999px; }", noResolve);
    expect(out).not.toContain("margin-left");
  });

  it("drops an extreme absolute font-size", () => {
    const out = sanitizeCss("div { font-size: 999999px; }", noResolve);
    expect(out).not.toContain("font-size");
  });
});

describe("sanitizeInlineStyle", () => {
  it("sanitizes an inline style attribute value the same way", () => {
    expect(sanitizeInlineStyle("color: red; behavior: url(evil.htc)", noResolve)).toBe("color: red;");
  });

  it("returns an empty string when nothing survives", () => {
    expect(sanitizeInlineStyle("behavior: url(evil.htc)", noResolve)).toBe("");
  });
});
