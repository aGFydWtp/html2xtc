// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

import type { Env } from "./types";

// Print CSS for the Xteink X3 page geometry (66mm x 99mm at 4mm margins).
// Japanese text renders with the preinstalled Noto CJK fonts on Browser Run,
// so no web-font injection is needed.
export const X3_PRINT_CSS = `
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
      font-family:
        "Noto Sans JP",
        "Hiragino Sans",
        sans-serif !important;
      font-size: 10pt !important;
      line-height: 1.55 !important;
    }

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
    body header,
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
    }

    main,
    article {
      width: 100% !important;
      max-width: none !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    /* Chromium evaluates print media queries at ~816px (US Letter), not at
       the @page size, so sites keep their desktop/tablet shell when printed:
       padded, centered layout wrappers get flowed into the 58mm content box
       and push the article column past the right paper edge (verified on
       webgenron.com: a grid wrapper with 20px side padding shifted all body
       text ~3.5mm right, clipping ~2mm off every line on every page).
       Divs/sections are layout chrome, not prose, so drop their horizontal
       padding and (auto-)centering margins; the @page margin is the only
       gutter the X3 page can afford. Lists, blockquotes, pre and table cells
       are untouched and keep their indentation. */
    div,
    section {
      padding-left: 0 !important;
      padding-right: 0 !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
    }

    /* Stripping padding/margin above is not enough when a script pins an
       explicit width on a wrapper: carousel JS writes inline styles like
       width: 800px on its track div (verified on omocoro.jp: a slider-pro
       carousel set width: 800px on the track and width: 200px per slide),
       which re-triggers the same contents-width expansion — the whole print
       layout grows ~10% past the paper and every line loses its last 1-2
       characters, while blockquote borders run off the right edge. Clamp
       with max-width rather than width: auto so deliberately narrow UI
       bits (e.g. a 180px "read more" button div) keep their intended width
       instead of being inflated to full page width. */
    div,
    section {
      max-width: 100% !important;
    }

    /* Keep replaced/embedded media inside the page. A fixed-width image or
       iframe would widen the print layout and clip the page at the right
       edge (same mechanism as the flex overflow handled above), and
       height: auto preserves the aspect ratio when width/height attributes
       would otherwise squash a shrunken image. */
    img,
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
    }

    pre {
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
    }
  }
`;

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
      setStyles(line, { "margin": "0", "padding": "0" });
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

export function renderPdf(env: Env, url: string): Promise<Response> {
  const convertedAt = formatJstTimestamp(new Date());
  return env.BROWSER.quickAction("pdf", {
    url,
    userAgent: RENDER_USER_AGENT,
    addStyleTag: [{ content: X3_PRINT_CSS }],
    // Appends the colophon page to the DOM after load, before PDF capture.
    addScriptTag: [{ content: buildColophonScript(url, convertedAt) }],
    gotoOptions: {
      waitUntil: "networkidle2",
      // Browser Run's documented cap for goto is 60s; use the full budget so
      // heavy pages still load for async (/jobs) conversions.
      timeout: 60_000,
    },
    pdfOptions: {
      preferCSSPageSize: true,
      printBackground: false,
      displayHeaderFooter: false,
      // Browser Run's documented cap for pdf generation is 5 minutes.
      timeout: 300_000,
    },
  });
}
