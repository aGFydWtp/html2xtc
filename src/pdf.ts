// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import { DEFAULT_FONT_FAMILY, fontCssEndpoint } from "./fonts";
import type { Env, RenderOptions } from "./types";

/**
 * Baseline render options — the pre-options behavior: horizontal layout,
 * BIZ UDPGothic (SIL OFL), a UD (universal design) gothic tuned for
 * legibility at small sizes, which suits 10pt text on the X3's 1-bit
 * e-paper. Requests may override both axes (layout/font); callers that
 * predate the options — and Workflow steps replaying old params — get this.
 */
export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  layout: "horizontal",
  font: DEFAULT_FONT_FAMILY,
};

/**
 * Body font stack for the given options: the (sanitized) Google Fonts
 * family first, then a bare generic keyed on the layout — serif suits
 * vertical literary text, sans-serif the default horizontal article layout.
 * Deliberately no named intermediate fallbacks: for a user-chosen family
 * they would be arbitrary, and Browser Run ships no Japanese font anyway
 * (its only CJK face is WenQuanYi Zen Hei, whatever we list).
 */
function fontStack(options: RenderOptions): string {
  return `"${options.font}", ${options.layout === "vertical" ? "serif" : "sans-serif"}`;
}

/**
 * Google Fonts stylesheet URL for the default family, kept for the tests
 * that pin the @import placement. The css2 CSS defines @font-face rules
 * split into many unicode-range subsets, so the browser downloads only the
 * few woff2 slices a given page actually uses — this is why the full-page
 * path references the CSS by URL instead of inlining it (inlining all JP
 * subsets would bloat the injected style by ~100 KB while still fetching
 * from fonts.gstatic.com). display=swap keeps text readable via the
 * fallback stack whenever the fetch is slow or blocked.
 */
export const PRINT_FONT_CSS_URL = fontCssEndpoint(DEFAULT_FONT_FAMILY);

// ---------------------------------------------------------------------------
// Blocks shared by the horizontal AND vertical rule sets. All of these were
// added for real overflow/size bugs on ordinary sites (webgenron.com /
// synodos.jp / omocoro.jp — rationale in the comments below), and a request
// may render ANY site vertically (layout option), so the vertical set needs
// the same defenses. Physical left/right properties are correct in both
// layouts on purpose: Chromium's print-layout "contents width" expansion and
// paper-edge clipping are physically horizontal regardless of writing-mode,
// so the paper-width guards stay physical. The blocks are inert on documents
// this service authors itself (extract/Aozora print HTML): those carry no
// page chrome, no pinned widths and no competing font sizing — and the
// Aozora structure CSS wins against them on !important + class specificity
// where it must (jisage margins, gaiji/illustration sizing, 底本 8pt).
// ---------------------------------------------------------------------------

/* Normalize body-text size with direct element selectors: a body rule only
   works through inheritance, so a site rule that targets a container (e.g.
   synodos.jp's .content { font-size: 1.13rem } = ~18px) or an inline style
   bypasses it and the whole article prints oversized. Absolute 10pt on each
   element, NOT html { font-size: 10pt } + 1rem: rem is a shared layout unit
   (padding/width/gap), so resizing the root would rescale every rem
   dimension — sites on the html { font-size: 62.5% } convention would
   inflate ~1.33x and re-cause the overflow clipping handled below. h1-h6
   are deliberately NOT listed so headings/titles keep their sizing (the
   vertical set sizes them explicitly). Trade-off: intentional non-heading
   size differences (lead paragraphs, notes) flatten to 10pt; a stable body
   size wins on a 58mm page. header/footer/nav/aside are omitted because
   the hide rules display:none them anyway. */
const BODY_TEXT_SIZE_RULES = `div,
    section,
    article,
    main,
    p,
    li,
    dd,
    dt,
    blockquote,
    figcaption,
    caption,
    th,
    td,
    address,
    summary,
    pre {
      font-size: 10pt !important;
    }

    /* Restore the semantically-smaller elements the normalization above
       would otherwise inflate to full body size. */
    sub,
    sup,
    small {
      font-size: 0.75em !important;
    }

    code,
    kbd,
    samp {
      font-size: 0.9em !important;
    }`;

/* Layout-wrapper resets. main/article: unclamp the article column a site
   centers at a fixed max-width. div/section: Chromium evaluates print media
   queries at ~816px (US Letter), not at the @page size, so sites keep their
   desktop/tablet shell when printed — padded, centered layout wrappers get
   flowed into the 58mm content box and push the article column past the
   right paper edge (verified on webgenron.com: a grid wrapper with 20px
   side padding shifted all body text ~3.5mm right, clipping ~2mm off every
   line on every page). Divs/sections are layout chrome, not prose, so drop
   their horizontal padding and (auto-)centering margins; the @page margin
   is the only gutter the X3 page can afford. Lists, blockquotes, pre and
   table cells are untouched and keep their indentation. The max-width
   clamp catches script-pinned wrapper widths (verified on omocoro.jp: a
   slider-pro carousel set width: 800px on its track div, growing the whole
   print layout ~10% past the paper); max-width rather than width: auto so
   deliberately narrow UI bits keep their intended width. */
const LAYOUT_RESET_RULES = `main,
    article {
      width: 100% !important;
      max-width: none !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    div,
    section {
      padding-left: 0 !important;
      padding-right: 0 !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
    }

    div,
    section {
      max-width: 100% !important;
    }`;

/* Keep replaced/embedded media inside the page. A fixed-width image or
   iframe would widen the print layout and clip the page at the right edge
   (same "contents width" mechanism as above), and height: auto preserves
   the aspect ratio when width/height attributes would otherwise squash a
   shrunken image. */
const MEDIA_FIT_RULES = `img,
    svg,
    video,
    iframe,
    canvas,
    embed,
    table,
    pre {
      max-width: 100% !important;
    }

    img,
    svg,
    video,
    iframe,
    canvas,
    embed {
      height: auto !important;
    }`;

// Page-chrome hide rules shared by the horizontal and vertical rule sets
// (the long rationale for the selector choices sits at the usage site in
// horizontalPrintRules; the vertical set reuses the block because full-page
// vertical renders of ordinary sites meet the same nav/consent/share
// chrome, and the selectors are inert on documents we author ourselves).
const HIDE_CHROME_RULES = `body header,
    body nav,
    body footer,
    body aside,
    body [role="navigation"],
    body [class~="sidebar"],
    body [class~="advert"],
    body [class~="advertisement"],
    body [class~="ad-container"],
    body [class*="cookie-banner" i],
    body [class*="cookie-consent" i],
    body [class*="cookieconsent" i],
    body [class*="cookie-notice" i],
    body [class*="cookie-popup" i],
    body [id*="cookie-banner" i],
    body [id*="cookieconsent" i],
    body [class~="share"],
    body [class*="share-button"],
    body [class*="social-share"],
    body [class*="share-bar"],
    body [class*="share-icons"],
    body [class*="share-tools"],
    body [class*="sharetools" i],
    body #onetrust-banner-sdk,
    body #CybotCookiebotDialog,
    body .cc-window,
    body .fc-consent-root,
    body #cookie-law-info-bar,
    body .cmplz-cookiebanner,
    body .addthis_toolbox,
    body .sharedaddy {
      display: none !important;
    }`;

// Print CSS for the Xteink X3 page geometry (66mm x 99mm at 4mm margins),
// horizontal layout. Body text prefers the web font the options selected.
// NOTE: Browser Run ships NO Japanese font — when the web font is not
// applied, CJK text falls back to WenQuanYi Zen Hei (a Chinese font with
// Chinese-style glyphs for 学/編 etc.), which is why the web font matters.
//
// Rule block only (no web-font @import): the extract path injects these
// rules together with the inlined @font-face CSS (renderPdfFromHtml), so
// re-importing the same family here would only add a pointless network
// fetch at render time. buildPrintCssWithFontImport prepends the @import
// for the paths that have no inlined font.
function horizontalPrintRules(options: RenderOptions): string {
  return `
  /* The body font-family is declared at TOP LEVEL — outside @media print —
     deliberately, and it must stay there. Chromium loads web fonts lazily:
     a @font-face only loads once some element uses its family under the
     CURRENT media. Inside @media print, nothing references the family
     during the normal (screen) rendering, the face stays "unloaded", and
     Chromium's print path does NOT wait for font loads — it captures with
     the fallback. Verified with minimal probes: identical font payloads
     failed with this rule inside @media print and succeeded outside,
     regardless of injection route, payload size or waits (see the font
     investigation notes). test/pdf.test.ts pins this placement. */
  body {
    font-family: ${fontStack(options)} !important;
  }

  @page {
    size: 66mm 99mm;
    margin: 4mm;
  }

  @media print {
    html,
    body {
      margin: 0 !important;
      padding: 0 !important;
      background: white !important;
      color: black !important;
    }

    body {
      font-size: 10pt !important;
      line-height: 1.55 !important;
    }

    ${BODY_TEXT_SIZE_RULES}

    /* Force full-contrast text everywhere: sites commonly use gray body text
       (e.g. #6b7280) or light text on dark blocks; with printBackground off
       and 1-bit XTG dithering both come out as faint dot patterns on the X3.
       Element-level colors beat the body rule above, so override them all. */
    body * {
      color: black !important;
      -webkit-text-fill-color: black !important;
      text-shadow: none !important;
    }

    /* Keep every box inside the 58mm content width. Chromium's print layout
       expands the whole document's layout width to the widest overflowing
       element ("contents width") and then clips at the paper edge, so one
       non-shrinking flex/grid item or unbreakable token (URL, date badge)
       shifts and clips EVERY line at the right edge (seen on webgenron.com:
       an author-metadata flex row overflowed by ~24px and the entire body
       text lost ~2mm on the right on all pages). Allowing mid-token wraps
       and letting flex/grid items shrink below min-content removes the
       overflow at its source instead of hiding it with overflow-x. */
    body * {
      overflow-wrap: anywhere !important;
      min-width: 0 !important;
    }

    /* Hide page chrome (nav, sidebars, ads, cookie banners, share widgets).
       Match whole class tokens ([class~=]) or specific multi-word UI
       compounds only. The previous [class*="sidebar"/"advert"/"cookie"/
       "share"] substring selectors deleted article content silently:
       .share-your-story and .shareholder-* are body sections, .cookie-recipe
       is the recipe itself on cooking sites, and wrappers like
       .no-sidebar-layout or .article-share-and-info can contain the whole
       article. A silently missing body is worse on the X3 than a leftover
       widget, so ambiguous names (.advertorial, .sidebar-widget,
       .share-links, bare "ad") are deliberately NOT matched. Two structural
       guards against blank-PDF misfires: every selector is prefixed with
       "body " so a layout-modifier class on <body>/<html> itself can never
       hide the whole document, and layout-flag tokens like "sidebar-left"/
       "sidebar-right" are not matched at all — CMSes emit them on <body> or
       top-level wrappers to describe where the sidebar goes (real sidebars
       are covered by aside / [class~="sidebar"] / their inner widgets).
       Accepted trade-offs: some sidebar/share variants survive as leftover
       chunks, and compound matches can still hit flag-style classes on
       inner wrappers (e.g. .has-social-share). The "i" attribute-selector
       flag (supported by Chromium) catches camelCase library classes such
       as CookieConsent / shareTools. The trailing id/class selectors are
       vendor-specific consent/share widgets (OneTrust, Cookiebot, Osano,
       Google Funding Choices, CookieYes, Complianz, AddThis, Jetpack);
       their ids/classes are unique to those vendors so there is no misfire
       risk, and hiding them matters because position:fixed banners are
       repeated on every printed page by Chromium. */
    ${HIDE_CHROME_RULES}

    ${LAYOUT_RESET_RULES}

    ${MEDIA_FIT_RULES}

    pre {
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
    }
  }
`;
}

/**
 * Vertical-writing rule set. Purpose-built instead of deriving from the
 * horizontal rules: those are horizontal-writing assumptions throughout
 * (per-element font-size normalization and physical margin stripping target
 * scraped web layouts flowing left-to-right). The page geometry (66mm x
 * 99mm at 4mm margins — the Xteink X3 panel) is identical.
 *
 * Works for both sources of vertical renders: documents this service
 * authors (extract mode, Aozora Bunko — whose structure-specific CSS is
 * embedded in the document itself, see AOZORA_DOCUMENT_CSS in
 * src/aozora.ts) and full-page renders of arbitrary sites, which is why
 * the chrome-hide block rides along here too.
 *
 * Deliberate choices, mirroring the constraints documented on the
 * horizontal rules:
 * - writing-mode sits on html, not body: applying it below the root is a
 *   known source of broken pagination in Chromium's print path. !important
 *   so a site's own root rules cannot flip a requested vertical render.
 * - font-family stays at TOP LEVEL (outside @media print) — same lazy-font
 *   loading trap as the horizontal stylesheet; test/pdf.test.ts pins this.
 *   Declared on html AND body so a site's body font rule cannot mask the
 *   family at screen time.
 * - No height:100%/100vh anywhere: a fixed block size on the body is the
 *   classic way to collapse a vertical document into a single page.
 * - 傍点 (Aozora emphasis marks) and 字下げ/地付き live in
 *   AOZORA_DOCUMENT_CSS, not here: their class selectors (e.g. #contents)
 *   could collide with ordinary sites' markup.
 */
function verticalPrintRules(options: RenderOptions): string {
  return `
  /* Root: vertical flow. */
  html {
    writing-mode: vertical-rl !important;
    text-orientation: mixed !important;
    line-height: 1.9;
    line-break: strict;
  }

  /* Chosen family + serif generic; must stay OUTSIDE @media print (the
     lazy-font-loading trap documented on the horizontal rules). */
  html,
  body {
    font-family: ${fontStack(options)} !important;
  }

  @page {
    size: 66mm 99mm;
    margin: 4mm;
  }

  @media print {
    html,
    body {
      margin: 0 !important;
      padding: 0 !important;
      background: white !important;
      color: black !important;
    }

    body {
      font-size: 10pt !important;
    }

    /* Full contrast plus the overflow guards: mid-token wraps and letting
       flex/grid items shrink below min-content (min-width for the physical
       paper-width axis, min-height for the inline axis, which is vertical
       here) — same "contents width" clipping mechanism documented on the
       shared blocks above. */
    body * {
      color: black !important;
      -webkit-text-fill-color: black !important;
      text-shadow: none !important;
      overflow-wrap: anywhere !important;
      min-width: 0 !important;
      min-height: 0 !important;
    }

    ${BODY_TEXT_SIZE_RULES}

    /* The title heading buildPrintHtml emits, plus the 見出し levels the
       Aozora markup uses (h3.o-midashi / h4.naka-midashi / h5.ko-midashi).
       Kept close to the body size: a 58mm-wide page has no room for large
       display sizes. Sized AFTER the shared normalization on purpose — the
       normalization skips h1-h6, and the vertical set pins them because a
       site's display sizes have no room on this page. */
    h1 {
      font-size: 13pt !important;
      font-weight: 700 !important;
    }
    h2 {
      font-size: 11pt !important;
      font-weight: 700 !important;
    }
    h3,
    h4,
    h5,
    h6 {
      font-size: 10.5pt !important;
      font-weight: 700 !important;
    }

    /* Ruby: annotations on the right of the base text (over-position in
       vertical-rl), readings upright, and the <rp> fallback parentheses
       hidden — with real ruby layout they would print as stray （）. */
    ruby {
      ruby-position: over;
    }
    rt {
      font-size: 0.5em !important;
      text-orientation: upright;
    }
    rp {
      display: none !important;
    }

    ${LAYOUT_RESET_RULES}

    ${MEDIA_FIT_RULES}

    /* On top of the shared physical clamps: logical limits so media also
       stays inside the page along the vertical inline axis, and
       max-block-size < 100% so a full-bleed image cannot swallow a whole
       column (block size is the horizontal axis here). The Aozora document
       CSS overrides these for gaiji/illustrations where it must (class
       specificity + !important). */
    img,
    svg,
    video,
    iframe,
    canvas,
    embed,
    table,
    pre {
      max-inline-size: 100% !important;
      max-block-size: 90% !important;
    }

    pre {
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
    }

    ${HIDE_CHROME_RULES}
  }
`;
}

/**
 * Print rules for the given options (no font @import): the layout picks the
 * rule set, the font fills the body stack. Injected next to the inlined
 * @font-face CSS on the extract path.
 */
export function buildPrintRules(options: RenderOptions): string {
  return options.layout === "vertical"
    ? verticalPrintRules(options)
    : horizontalPrintRules(options);
}

/**
 * Rules preceded by the css2 @import of the selected family — for the
 * render paths that carry no inlined @font-face CSS (the full-page path,
 * and HTML renders whose font subsetting fail-softed to null). A
 * nonexistent family just 400s the import and the generic fallback is used;
 * the conversion itself never fails on a font.
 */
export function buildPrintCssWithFontImport(options: RenderOptions): string {
  return `
  /* Must stay the first rule in this stylesheet (CSS drops later @imports).
     Injected via addStyleTag after page load, so a target page's CSP may
     block it — an accepted degradation, like the colophon script below. */
  @import url("${fontCssEndpoint(options.font)}");
${buildPrintRules(options)}`;
}

// Fixed default-options variants; test/pdf.test.ts pins their exact text
// (the @import placement and the top-level font-family rule).
export const X3_PRINT_CSS = buildPrintCssWithFontImport(DEFAULT_RENDER_OPTIONS);
export const X3_PRINT_CSS_NO_FONT_IMPORT = buildPrintRules(DEFAULT_RENDER_OPTIONS);

/**
 * User agent the rendering browser announces when fetching the target page.
 * Named after the Googlebot "+URL" convention so site operators can identify
 * this service, block it by UA if unwanted, and find policy/contact
 * information at the linked /about page.
 */
export const RENDER_USER_AGENT = "xtc-converter/1.0 (+https://xtc.hr20k.com/about)";

/** Formats a timestamp as e.g. "2026-07-18 21:30 JST" for the colophon. */
export function formatJstTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // "h23" so midnight is "00", not "24" (hour12: false alone can yield 24).
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} JST`;
}

/**
 * Builds the script injected via quickAction's addScriptTag (runs after page
 * load, before PDF generation) that appends a colophon page: title, site
 * name, author (best effort), source URL, conversion time, and a
 * personal-use/no-redistribution notice.
 *
 * Design constraints:
 * - Fail-soft: the whole script is wrapped in try/catch, and a page CSP with
 *   a script-src directive may block the injected tag entirely. Either way
 *   the conversion must still succeed — a missing colophon is an accepted
 *   degradation, a broken render is not.
 * - The container is a <div>, NOT <footer>/<header>/<aside>: X3_PRINT_CSS
 *   hides "body footer" etc. with display:none, which would silently delete
 *   the colophon. No class attribute either, so the [class~=...] hide rules
 *   above can never match it.
 * - All styles go through el.style.setProperty(..., "important") so site
 *   CSS (including the site's own !important rules) cannot override them;
 *   inline !important wins the cascade against stylesheet !important.
 * - Text is built with createElement + textContent only — page-derived
 *   strings never pass through innerHTML.
 *
 * `url` and `convertedAt` are embedded with JSON.stringify so arbitrary
 * characters in the (already validated) URL cannot break out of the string
 * literal and inject script.
 */
export function buildColophonScript(url: string, convertedAt: string): string {
  return `(() => {
  try {
    var doc = document;
    var meta = function (sel) {
      var el = doc.querySelector(sel);
      var v = el && el.getAttribute("content");
      return v && v.trim() ? v.trim() : "";
    };

    // Empty <title> would otherwise print a bare "タイトル: " label.
    var title = (doc.title || "").trim() || "(無題)";
    var siteName = meta('meta[property="og:site_name"]') || location.hostname;

    // Author, best effort; when nothing usable is found the line is omitted.
    var author = meta('meta[name="author"]');
    if (!author) {
      // article:author is often a profile URL rather than a name; skip
      // absolute URLs plus root-relative and protocol-relative paths
      // ("/...", "//...").
      var fbAuthor = meta('meta[property="article:author"]');
      if (fbAuthor && !/^(https?:|\\/)/i.test(fbAuthor)) author = fbAuthor;
    }
    if (!author) {
      // JSON-LD: top-level "author" only (string / object / array of both);
      // walking @graph is not worth the complexity for a colophon line.
      // Every loop is capped at MAX_LD entries: this script runs inside the
      // quickAction time budget, so a pathologically large JSON-LD payload
      // must degrade to "no author line" — never eat the action timeout and
      // fail the render (same fail-soft rationale as the outer try/catch).
      var MAX_LD = 20;
      var blocks = doc.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < Math.min(blocks.length, MAX_LD) && !author; i++) {
        try {
          var data = JSON.parse(blocks[i].textContent || "");
          var nodes = Array.isArray(data) ? data : [data];
          for (var j = 0; j < Math.min(nodes.length, MAX_LD) && !author; j++) {
            var a = nodes[j] && nodes[j].author;
            var cands = Array.isArray(a) ? a : [a];
            for (var k = 0; k < Math.min(cands.length, MAX_LD) && !author; k++) {
              var c = cands[k];
              if (typeof c === "string" && c.trim()) {
                author = c.trim();
              } else if (c && typeof c.name === "string" && c.name.trim()) {
                author = c.name.trim();
              }
            }
          }
        } catch (e) {
          // Invalid JSON-LD on the page; try the next block.
        }
      }
    }

    var setStyles = function (el, styles) {
      for (var p in styles) el.style.setProperty(p, styles[p], "important");
    };

    var box = doc.createElement("div");
    box.id = "xtc-colophon";
    // break-before: page puts the colophon on its own final page. Keep the
    // typography small and plain: the content box is only 58mm wide
    // (66mm paper minus 4mm margins), and X3_PRINT_CSS already forces black
    // text and mid-token wrapping (long URLs included) on every element.
    setStyles(box, {
      "break-before": "page",
      "font-size": "8pt",
      "line-height": "1.6",
      "margin": "0",
      "padding": "0",
    });

    var addLine = function (text, styles) {
      var line = doc.createElement("div");
      line.textContent = text;
      // font-size on each line, not just the box: X3_PRINT_CSS normalizes
      // div font-size to 10pt !important, which would beat the box's
      // inherited 8pt; the inline !important here wins the cascade.
      setStyles(line, { "margin": "0", "padding": "0", "font-size": "8pt" });
      if (styles) setStyles(line, styles);
      box.appendChild(line);
    };

    addLine("タイトル: " + title);
    addLine("サイト名: " + siteName);
    if (author) addLine("著者: " + author);
    addLine("URL: " + ${JSON.stringify(url)});
    addLine("変換日時: " + ${JSON.stringify(convertedAt)});
    addLine("個人的利用のために作成。再配布禁止。", {
      "border-top": "1px solid black",
      "margin-top": "6pt",
      "padding-top": "4pt",
    });
    addLine("Created for personal use. Redistribution prohibited.");

    doc.body.appendChild(box);
  } catch (e) {
    // Fail-soft: never let colophon construction break the PDF render.
  }
})();`;
}

/**
 * Injected into the full-page render via addScriptTag (which the quick
 * action runs after goto and before the waitForTimeout grace, same ordering
 * the colophon/font handling already relies on): coaxes lazy-loaded images
 * into fetching NOW so the waitForTimeout below can catch them. networkidle2
 * alone misses them — a lazy image only starts loading on scroll, and the
 * quick action never scrolls. Three triggers, all fail-soft:
 *  1. promote data-src/data-srcset style deferred URLs onto img/source
 *     (covers JS lazy-load libraries whose IntersectionObserver would need
 *     scrolling);
 *  2. flip loading="lazy" to eager (native lazy-loading skips
 *     below-viewport images in an unscrolled page);
 *  3. stepwise-scroll to the bottom and back to top, for loaders that only
 *     react to viewport intersection (and rootMargin'd observers).
 * quickAction has no waitForFunction, so the script cannot signal
 * completion; the scroll phase bounds itself (<= 40 steps x 150 ms + a hard
 * 6 s deadline) and PDF_FULL_WAIT_MS is the overall budget — on expiry the
 * page is captured as-is (degraded images beat a failed render).
 */
export const LAZY_IMAGE_SCRIPT = `(() => {
  try {
    for (const el of Array.from(document.querySelectorAll("img, source"))) {
      try {
        const src = el.getAttribute("src") || "";
        if (
          el.tagName === "IMG" &&
          (src.trim() === "" || /^(?:data|about|blob):/i.test(src.trim()))
        ) {
          const deferred =
            el.getAttribute("data-src") ||
            el.getAttribute("data-lazy-src") ||
            el.getAttribute("data-original");
          if (deferred) el.setAttribute("src", deferred);
        }
        if (!el.getAttribute("srcset")) {
          const deferredSet =
            el.getAttribute("data-srcset") || el.getAttribute("data-lazy-srcset");
          if (deferredSet) el.setAttribute("srcset", deferredSet);
        }
        if (el.getAttribute("loading") === "lazy") {
          el.setAttribute("loading", "eager");
        }
      } catch (e) {}
    }
    const scroller = document.scrollingElement || document.documentElement;
    const deadline = Date.now() + 6000;
    // Step size adapts to the page so even a very long article finishes in
    // <= ~40 steps; scrollHeight is re-read each tick because loading images
    // can grow the page under us.
    const step = Math.max(window.innerHeight || 600, Math.ceil(scroller.scrollHeight / 40));
    let y = 0;
    const timer = setInterval(() => {
      try {
        y += step;
        window.scrollTo(0, y);
        if (y >= scroller.scrollHeight || Date.now() > deadline) {
          clearInterval(timer);
          window.scrollTo(0, 0);
        }
      } catch (e) {
        clearInterval(timer);
      }
    }, 150);
  } catch (e) {
    // Fail-soft: never let image coaxing break the PDF render.
  }
})();`;

// Fixed post-goto grace for the full-page path: the lazy-image scroll phase
// (<= 6 s, see LAZY_IMAGE_SCRIPT) plus a fetch tail for the images it
// triggered, and it subsumes the previous 3 s font grace (the BIZ UDPGothic
// @import in X3_PRINT_CSS only starts loading at injection time — after
// goto — so networkidle2 never waits for it). Capped well under the
// quick-action limit (60 s) and budgeted in the render-pdf Workflow step
// timeout (workflow.ts).
const PDF_FULL_WAIT_MS = 10_000;

// Options shared by both render paths (full URL and extract-mode HTML).
const PDF_GOTO_OPTIONS = {
  // networkidle2 also applies to html-sourced renders: it waits for the
  // article's (absolute-URL) images to finish loading before capture.
  waitUntil: "networkidle2",
  // Browser Run's documented cap for goto is 60s; use the full budget so
  // heavy pages still load for async (/jobs) conversions.
  timeout: 60_000,
} as const;

const PDF_OPTIONS = {
  preferCSSPageSize: true,
  printBackground: false,
  displayHeaderFooter: false,
  // Browser Run's documented cap for pdf generation is 5 minutes.
  timeout: 300_000,
} as const;

export function renderPdf(
  env: Env,
  url: string,
  options: RenderOptions = DEFAULT_RENDER_OPTIONS,
): Promise<Response> {
  const convertedAt = formatJstTimestamp(new Date());
  return env.BROWSER.quickAction("pdf", {
    url,
    userAgent: RENDER_USER_AGENT,
    addStyleTag: [{ content: buildPrintCssWithFontImport(options) }],
    // First coax lazy images into loading, then append the colophon page to
    // the DOM — both run after load, before the waitForTimeout grace and the
    // PDF capture. A page CSP can block either script (fail-soft by design).
    addScriptTag: [
      { content: LAZY_IMAGE_SCRIPT },
      { content: buildColophonScript(url, convertedAt) },
    ],
    gotoOptions: PDF_GOTO_OPTIONS,
    // Grace for the lazy-image scroll/fetch AND the injected web font (see
    // PDF_FULL_WAIT_MS). Probabilistic, not guaranteed: on expiry the page
    // is captured as-is. display=swap bounds the font worst case at the
    // fallback face — on Browser Run that is WenQuanYi Zen Hei, since no
    // Japanese font is installed.
    waitForTimeout: PDF_FULL_WAIT_MS,
    pdfOptions: PDF_OPTIONS,
  });
}

/**
 * Renders a PDF from a self-contained HTML document (extract mode, see
 * src/printhtml.ts). No addScriptTag here: the colophon is already part of
 * the document, built server-side — which also means no page CSP can ever
 * block it, unlike the injected script on the full-page path.
 */
export function renderPdfFromHtml(
  env: Env,
  html: string,
  fontCss: string | null = null,
  options: RenderOptions = DEFAULT_RENDER_OPTIONS,
): Promise<Response> {
  // With inlined font CSS the rules ride without an @import (a remote fetch
  // of the same family would only race the data: faces); on font fail-soft
  // (null) the @import variant is the best remaining effort — probabilistic
  // like the full path, worst case the generic/WenQuanYi fallback.
  const styles =
    fontCss !== null
      ? [{ content: fontCss }, { content: buildPrintRules(options) }]
      : [{ content: buildPrintCssWithFontImport(options) }];
  return env.BROWSER.quickAction("pdf", {
    html,
    // The browser still fetches the article's images from their origin;
    // announce the same UA as the full-page path so site operators see a
    // single identity for this service.
    userAgent: RENDER_USER_AGENT,
    // fontCss (inlined data: @font-face rules, src/fonts.ts) rides in via
    // addStyleTag — the injection path the custom-fonts docs document for
    // quick actions. Order matters: the faces first, then the rules that
    // reference the family. What actually makes the font take effect is the
    // font-family rule sitting OUTSIDE @media print (see the print rules):
    // an earlier claim that "html mode ignores document-level data:
    // @font-face" was a misattribution — those probes had the family inside
    // @media print, so the lazy loader never fired. On font fail-soft
    // (null) inject the @import variant instead — probabilistic like the
    // full path, worst case the WenQuanYi fallback, but never a second
    // fetch racing an inlined font.
    addStyleTag: styles,
    gotoOptions: PDF_GOTO_OPTIONS,
    // Probes show data: faces apply even without a wait once the family is
    // used at screen time; keep a safety margin for cold-instance decode of
    // multi-hundred-KB subsets. Also covers the image tail: sanitizeContent
    // normalized every img to a plain absolute src, so networkidle2 waits
    // for them — but it fires with up to 2 connections still in flight, and
    // this grace lets those stragglers land before capture.
    waitForTimeout: 3_000,
    pdfOptions: PDF_OPTIONS,
  });
}

/**
 * Renders a PDF from a TXT-upload article document (src/text-html.ts), which
 * is fully self-styled: its own <style> tag already carries the @page
 * geometry (528x792 CSS px) and every typographic rule the user's
 * TextConvertOptions selected (src/text-options.ts). Deliberately NOT built
 * on renderPdfFromHtml: that function always injects buildPrintRules(), a
 * !important-laden stylesheet tuned for arbitrary scraped web pages (fixed
 * 66mm x 99mm page, 10pt body text, layout-reset/chrome-hide rules) which
 * would fight the TXT document's own variable page size, font size (12-32px)
 * and margins (0-120px) — buildPrintRules' !important rules would win. The
 * only thing this path injects is the inlined @font-face CSS (src/fonts.ts's
 * buildInlineFontCss); with no inline font available it injects nothing and
 * relies on the document's own generic font-family fallback (serif/
 * sans-serif per layout, baked into text-html.ts) — never buildPrintCssWithFontImport,
 * which would also drag in buildPrintRules via buildPrintRules() internally.
 */
export function renderSelfStyledHtmlPdf(
  env: Env,
  html: string,
  fontCss: string | null,
): Promise<Response> {
  return env.BROWSER.quickAction("pdf", {
    html,
    userAgent: RENDER_USER_AGENT,
    // Only the inlined font faces ride along via addStyleTag — no rule
    // injection of any kind, unlike renderPdfFromHtml. An empty array is
    // valid input (no-op) when font inlining fail-soft'd to null.
    addStyleTag: fontCss !== null ? [{ content: fontCss }] : [],
    gotoOptions: PDF_GOTO_OPTIONS,
    // Same rationale as renderPdfFromHtml's wait: gives a cold-instance
    // font decode time to finish before capture; harmless no-op when there
    // is no inlined font.
    waitForTimeout: 3_000,
    pdfOptions: PDF_OPTIONS,
  });
}
