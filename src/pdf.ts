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

export function renderPdf(env: Env, url: string): Promise<Response> {
  return env.BROWSER.quickAction("pdf", {
    url,
    userAgent: RENDER_USER_AGENT,
    addStyleTag: [{ content: X3_PRINT_CSS }],
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
