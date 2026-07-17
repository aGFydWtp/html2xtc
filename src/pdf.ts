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

    header,
    nav,
    footer,
    aside,
    [role="navigation"],
    [class*="sidebar"],
    [class*="advert"],
    [class*="cookie"],
    [class*="share"] {
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

export function renderPdf(env: Env, url: string): Promise<Response> {
  return env.BROWSER.quickAction("pdf", {
    url,
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
