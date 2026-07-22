// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Shared Aozora Bunko structural CSS (spec §12.1). Originally authored for
 * the URL-based Aozora Bunko extraction path (src/aozora.ts's
 * AOZORA_DOCUMENT_CSS) and moved here so the AST-based TXT→HTML aozora
 * renderer (render-html.ts) can reuse the exact same class names and rules
 * — spec §9.4's "既存 AOZORA_DOCUMENT_CSS と同じクラス名へ寄せる" is an
 * explicit requirement, not a coincidence. src/aozora.ts re-exports this
 * constant under its old name for backward compatibility with existing
 * imports/tests.
 *
 * Kept writing-mode-agnostic on purpose (spec §12.2's closing note): no rule
 * here sets `writing-mode` on a nested element — only the caller's own
 * document-level CSS (src/text-html.ts's buildTextPrintCss /
 * src/pdf.ts's buildPrintRules) does that on the root, because Chromium's
 * print pagination cannot split a vertical-rl block that is nested rather
 * than root-level.
 */

// 字下げ (jisage_N: N-em indent from the line start) and 地付き (chitsuki_N:
// aligned to the line end, N em short of it) run up to well past 10 em in
// real files; 30 covers everything observed in practice, and an unmatched
// deeper class just prints without the indent. Logical properties on
// purpose: physical margin-left/right would indent the wrong axis in
// vertical-rl. !important so this class selector always wins over any
// horizontal/vertical rule set's own margin handling (both !important →
// specificity decides, and this is the more specific selector).
const AOZORA_MAX_INDENT_EM = 30;

function aozoraIndentRules(): string {
  const rules: string[] = [];
  for (let n = 1; n <= AOZORA_MAX_INDENT_EM; n++) {
    rules.push(`.jisage_${n} { margin-inline-start: ${n}em !important; }`);
  }
  rules.push(`[class^="chitsuki_"], [class*=" chitsuki_"] { text-align: end !important; }`);
  for (let n = 1; n <= AOZORA_MAX_INDENT_EM; n++) {
    rules.push(`.chitsuki_${n} { margin-inline-end: ${n}em !important; }`);
  }
  return rules.join("\n");
}

export const AOZORA_DOCUMENT_CSS = `
em[class] {
  font-style: normal !important;
  background: none !important;
  padding: 0 !important;
}
em.sesame_dot, em.sesame_dot_after { text-emphasis: filled sesame; }
em.white_sesame_dot { text-emphasis: open sesame; }
em.black_circle { text-emphasis: filled circle; }
em.white_circle { text-emphasis: open circle; }
em.black_up-pointing_triangle { text-emphasis: filled triangle; }
em.white_up-pointing_triangle { text-emphasis: open triangle; }
em.bullseye { text-emphasis: open double-circle; }
em.fisheye { text-emphasis: filled double-circle; }
em.saltire { text-emphasis: "×"; }
em[class^="underline_"] {
  text-decoration: underline;
  text-underline-position: left;
}
em[class^="overline_"] { text-decoration: overline; }

/* 外字 (JIS X 0213 glyphs served as tiny PNGs, URL-extraction path only):
   size them like a kanji. */
img.gaiji {
  width: 1em !important;
  height: 1em !important;
}

/* 挿絵: width/height ATTRIBUTES survive sanitization (only style/srcset are
   stripped) and would pin a squashed size once the layout's max-* limits
   bite, so both CSS dimensions go back to auto — the attributes still
   supply the intrinsic aspect ratio. */
img.illustration {
  width: auto !important;
  height: auto !important;
  break-inside: avoid;
}

/* 底本 (source edition) info: small print on its own page, like a colophon. */
.bibliographical_information {
  break-before: page;
  font-size: 8pt !important;
}

${aozoraIndentRules()}

/* --- AST-based TXT renderer additions (spec §12.2) -------------------- */

.aozora-page-break {
  break-before: page;
}

.aozora-center {
  text-align: center !important;
}

.tcy {
  text-combine-upright: all;
}

.aozora-heading {
  break-after: avoid;
}

.aozora-heading-large {
  font-size: 1.45em;
}

.aozora-heading-medium {
  font-size: 1.25em;
}

.aozora-heading-small {
  font-size: 1.08em;
}

.aozora-heading-inline {
  display: inline;
}

.gaiji-fallback {
  font-family: serif;
}

.aozora-raw-note,
.aozora-image-placeholder {
  font-size: 0.72em;
  line-height: 1.3;
}

/* chitsuki_0 (地付き with no additional indent) already matches the
   [class^="chitsuki_"] rule above; this explicit rule documents the
   spec §9.7 contract directly and stays correct even if the prefix
   selector above is ever narrowed. */
.chitsuki_0 {
  text-align: end !important;
}
`;
