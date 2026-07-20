import { describe, expect, it, vi } from "vitest";
import {
  AOZORA_DOCUMENT_CSS,
  extractAozoraArticle,
  prepareAozoraRenderInput,
} from "../src/aozora";
import { prepareRenderInput } from "../src/extract";
import type { SourceHtmlFetcher } from "../src/extract";
import {
  buildInlineFontCss,
  fontCssEndpoint,
  sanitizeFontFamily,
} from "../src/fonts";
import type { FontFetcher } from "../src/fonts";
import {
  buildPrintCssWithFontImport,
  buildPrintRules,
  renderPdfFromHtml,
} from "../src/pdf";
import { isAozoraBunkoUrl, resolveRenderOptions } from "../src/sitepresets";
import type { Env, RenderOptions } from "../src/types";

const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";

const AOZORA_URL =
  "https://www.aozora.gr.jp/cards/000148/files/789_14547.html";

/** The resolved default options for an Aozora URL. */
const VERTICAL_MINCHO: RenderOptions = {
  layout: "vertical",
  font: "BIZ UDMincho",
};

// Shape of a real Aozora XHTML reader file: XML prolog, Shift_JIS metas,
// ruby in full <rb>/<rp>/<rt> form, U+3000 paragraph indents, <br /> breaks,
// jisage with a PHYSICAL inline margin, site-relative gaiji, files-relative
// illustration, the empty JS-toc placeholder, and the 底本 block.
const AOZORA_HTML = `<?xml version="1.0" encoding="Shift_JIS"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xml:lang="ja" lang="ja">
<head>
  <meta http-equiv="Content-Type" content="text/html;charset=Shift_JIS" />
  <meta name="DC.Title" content="草枕" />
  <meta name="DC.Creator" content="夏目漱石" />
  <title>夏目漱石 草枕</title>
</head>
<body>
<div class="metadata">
<h1 class="title">草<ruby><rb>枕</rb><rp>（</rp><rt>まくら</rt><rp>）</rp></ruby></h1>
<h2 class="author">夏目漱石</h2>
</div>
<div id="contents"></div>
<div class="main_text">　山路を<ruby><rb>登</rb><rp>（</rp><rt>のぼ</rt><rp>）</rp></ruby>りながら、こう考えた。<br />
　智に働けば角が立つ。情に棹させば流される。<br />
<div class="jisage_2" style="margin-left: 2em">字下げの段落<br /></div>
<div class="chitsuki_1" style="text-align:right; margin-right: 1em">地付きの行<br /></div>
外字<img class="gaiji" src="../../../gaiji/1-85/1-85-87.png" alt="※" />のある行。<br />
<img class="illustration" src="fig789_01.png" alt="挿絵" width="400" height="300" />
</div>
<div class="bibliographical_information">底本：「草枕」テスト文庫、1906（明治39）年</div>
<script type="text/javascript" src="../../jquery-1.4.2.min.js"></script>
</body>
</html>`;

// Standard-pipeline fixture (long enough for Readability + the extract
// gate), for the general-site + explicit-options cases.
const GENERAL_BODY = "これは本文の段落です。抽出テストのための文章が続きます。".repeat(30);
const GENERAL_HTML = `<!doctype html>
<html lang="ja">
<head><title>一般記事</title></head>
<body><article><h1>一般記事</h1><p>${GENERAL_BODY}</p><p>${GENERAL_BODY}</p></article></body>
</html>`;

const sourceAozora: SourceHtmlFetcher = async () => ({
  html: AOZORA_HTML,
  finalUrl: new URL(AOZORA_URL),
});

const fontFetchFail: FontFetcher = async () => {
  throw new Error("no network in tests");
};

/** css2/gstatic mock that serves `face` and records every request URL. */
const fontFetchServing = (face: string) => {
  const calls: string[] = [];
  const fetchFn: FontFetcher = async (url) => {
    calls.push(url);
    return url.startsWith("https://fonts.googleapis.com/")
      ? new Response(face, { status: 200 })
      : new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 });
  };
  return { fetchFn, calls };
};

const mincho400Face = (family: string) => `@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/l/font?kit=k4) format('woff2');
  unicode-range: U+3042;
}`;

const browserEnv = () => {
  const quickAction = vi.fn(
    async () => new Response(JSON.stringify({ success: false }), { status: 200 }),
  );
  return {
    env: {
      BROWSER: { quickAction } as unknown as BrowserRun,
      EXTRACT_MIN_CHARS: undefined,
    },
    quickAction,
  };
};

describe("isAozoraBunkoUrl", () => {
  it("matches XHTML reader files on aozora.gr.jp", () => {
    expect(isAozoraBunkoUrl(new URL(AOZORA_URL))).toBe(true);
    expect(
      isAozoraBunkoUrl(
        new URL("http://aozora.gr.jp/cards/000035/files/1567_14913.html"),
      ),
    ).toBe(true);
  });

  it("rejects everything else on the site", () => {
    for (const url of [
      "https://www.aozora.gr.jp/", // top page
      "https://www.aozora.gr.jp/cards/000148/card789.html", // card page
      "https://www.aozora.gr.jp/cards/000148/files/789_ruby_5639.zip", // download
      "https://www.aozora.gr.jp/cards/148/files/789_14547.html", // non-6-digit author id
      "https://www.aozora.gr.jp/index_pages/person148.html",
    ]) {
      expect(isAozoraBunkoUrl(new URL(url))).toBe(false);
    }
  });

  it("rejects other hosts, including lookalikes", () => {
    for (const url of [
      "https://example.com/cards/000148/files/789_14547.html",
      "https://aozora.gr.jp.evil.example/cards/000148/files/789_14547.html",
    ]) {
      expect(isAozoraBunkoUrl(new URL(url))).toBe(false);
    }
  });
});

describe("resolveRenderOptions", () => {
  const general = new URL("https://example.com/article");
  const aozora = new URL(AOZORA_URL);

  it("defaults to horizontal + BIZ UDPGothic", () => {
    expect(resolveRenderOptions(general)).toEqual({
      layout: "horizontal",
      font: "BIZ UDPGothic",
    });
  });

  it("defaults Aozora URLs to vertical + BIZ UDMincho", () => {
    expect(resolveRenderOptions(aozora)).toEqual(VERTICAL_MINCHO);
  });

  it("lets explicit values beat the per-site defaults (both directions)", () => {
    // Aozora forced back to horizontal, with a user-chosen family.
    expect(resolveRenderOptions(aozora, "horizontal", "Noto Serif JP")).toEqual({
      layout: "horizontal",
      font: "Noto Serif JP",
    });
    // Ordinary site rendered vertically.
    expect(resolveRenderOptions(general, "vertical", "Zen Old Mincho")).toEqual({
      layout: "vertical",
      font: "Zen Old Mincho",
    });
  });

  it("fails soft to the defaults on invalid values (never an error)", () => {
    expect(resolveRenderOptions(general, "diagonal", 42)).toEqual({
      layout: "horizontal",
      font: "BIZ UDPGothic",
    });
    // Invalid values on an Aozora URL fall back to the AOZORA defaults.
    expect(resolveRenderOptions(aozora, "slanted", "Fake'); @import")).toEqual(
      VERTICAL_MINCHO,
    );
  });
});

describe("sanitizeFontFamily", () => {
  it("accepts real Google Fonts family names (trimmed)", () => {
    expect(sanitizeFontFamily("BIZ UDMincho")).toBe("BIZ UDMincho");
    expect(sanitizeFontFamily("  Zen Old Mincho ")).toBe("Zen Old Mincho");
    expect(sanitizeFontFamily("M PLUS 1p")).toBe("M PLUS 1p");
  });

  it("rejects anything that could break out of CSS or the css2 URL", () => {
    for (const value of [
      "Fake'; } body { display: none }", // CSS injection
      'Fake" <style>', // markup
      "Fake&family=Evil", // URL parameter smuggling
      "游明朝", // non-ASCII: not a Google Fonts machine name
      "-leading-hyphen",
      "a".repeat(65), // over the length cap
      "",
      "   ",
      42,
      null,
      undefined,
      ["BIZ UDMincho"],
    ]) {
      expect(sanitizeFontFamily(value)).toBeUndefined();
    }
  });
});

describe("fontCssEndpoint", () => {
  it("requests 400;700 for the known dual-weight defaults", () => {
    expect(fontCssEndpoint("BIZ UDPGothic")).toBe(
      "https://fonts.googleapis.com/css2?family=BIZ+UDPGothic:wght@400;700&display=swap",
    );
    expect(fontCssEndpoint("BIZ UDMincho")).toContain(":wght@400;700");
  });

  it("requests regular only for arbitrary families (+-encoded)", () => {
    // css2 rejects the whole request when a listed weight is missing from
    // the family, so unknown families must not pin a weight axis.
    const url = fontCssEndpoint("Zen Old Mincho");
    expect(url).toBe(
      "https://fonts.googleapis.com/css2?family=Zen+Old+Mincho&display=swap",
    );
    expect(url).not.toContain("wght");
  });
});

describe("extractAozoraArticle", () => {
  it("pulls title, author and the main text with ruby intact", () => {
    const article = extractAozoraArticle(AOZORA_HTML, AOZORA_URL);
    expect(article).not.toBeNull();
    // Ruby readings must not leak into the title text.
    expect(article?.title).toBe("草枕");
    expect(article?.byline).toBe("夏目漱石");
    expect(article?.siteName).toBe("青空文庫");
    expect(article?.lang).toBe("ja");
    expect(article?.contentHtml).toContain("<ruby>");
    expect(article?.contentHtml).toContain("<rt>のぼ</rt>");
    // 底本 info rides along at the end.
    expect(article?.contentHtml).toContain("底本：「草枕」テスト文庫");
    // The body text keeps the U+3000 paragraph indent (no trimming).
    expect(article?.contentHtml).toContain("　山路を");
    // rt text stays in textContent: the font subsetter needs those glyphs.
    expect(article?.textContent).toContain("のぼ");
  });

  it("falls back to the DC metas when the headings are missing", () => {
    const html = AOZORA_HTML.replace(
      /<div class="metadata">[\s\S]*?<\/div>/,
      "",
    );
    const article = extractAozoraArticle(html, AOZORA_URL);
    expect(article?.title).toBe("草枕");
    expect(article?.byline).toBe("夏目漱石");
  });

  it("returns null when there is no main_text (old-format files)", () => {
    expect(
      extractAozoraArticle(
        "<html><body><pre>本文</pre></body></html>",
        AOZORA_URL,
      ),
    ).toBeNull();
    expect(extractAozoraArticle("", AOZORA_URL)).toBeNull();
  });
});

describe("AOZORA_DOCUMENT_CSS", () => {
  it("re-expresses 字下げ/地付き along the logical inline axis", () => {
    expect(AOZORA_DOCUMENT_CSS).toContain(
      ".jisage_2 { margin-inline-start: 2em !important; }",
    );
    expect(AOZORA_DOCUMENT_CSS).toContain(
      ".chitsuki_1 { margin-inline-end: 1em !important; }",
    );
    expect(AOZORA_DOCUMENT_CSS).toMatch(/chitsuki[^}]*text-align:\s*end/);
    // Physical properties must not sneak in: they indent the wrong axis in
    // vertical writing.
    expect(AOZORA_DOCUMENT_CSS).not.toContain("margin-left");
    expect(AOZORA_DOCUMENT_CSS).not.toContain("margin-right");
  });

  it("replaces the background-image 傍点 with text-emphasis", () => {
    expect(AOZORA_DOCUMENT_CSS).toContain("text-emphasis: filled sesame");
    expect(AOZORA_DOCUMENT_CSS).toMatch(/em\[class\]\s*\{[^}]*background: none/);
  });

  it("sizes 外字 like a kanji", () => {
    expect(AOZORA_DOCUMENT_CSS).toMatch(/img\.gaiji\s*\{[^}]*width: 1em/);
  });
});

describe("prepareAozoraRenderInput", () => {
  it("builds a print document with the structure CSS embedded", async () => {
    const input = await prepareAozoraRenderInput(
      new URL(AOZORA_URL),
      JOB_ID,
      sourceAozora,
      fontFetchFail,
      VERTICAL_MINCHO,
    );
    expect(input).not.toBeNull();
    expect(input?.kind).toBe("html");
    if (input?.kind !== "html") {
      return;
    }
    // Font fail-soft: render proceeds without the inline font.
    expect(input.fontCss).toBeNull();
    // The Aozora structure CSS travels inside the document, so it applies
    // under whichever layout the request resolved to.
    expect(input.html).toContain("margin-inline-start: 2em");
    expect(input.html).toContain("text-emphasis: filled sesame");
    // Ruby structure survives sanitization end to end.
    expect(input.html).toContain("<rt>のぼ</rt>");
    // Site-relative gaiji and files-relative illustration are absolutized.
    expect(input.html).toContain(
      'src="https://www.aozora.gr.jp/gaiji/1-85/1-85-87.png"',
    );
    expect(input.html).toContain(
      'src="https://www.aozora.gr.jp/cards/000148/files/fig789_01.png"',
    );
    // The original PHYSICAL inline margins are gone (sanitizeContent strips
    // inline styles); the classes survive for the logical rules above.
    expect(input.html).not.toContain("margin-left");
    expect(input.html).toContain('class="jisage_2"');
    expect(input.html).toContain('class="chitsuki_1"');
    // jquery must not survive into the print document.
    expect(input.html).not.toContain("jquery");
    // Colophon identifies the source.
    expect(input.html).toContain("青空文庫");
    expect(input.html).toContain(AOZORA_URL);
  });

  it("subsets the font the options selected", async () => {
    const { fetchFn, calls } = fontFetchServing(mincho400Face("BIZ UDMincho"));
    const input = await prepareAozoraRenderInput(
      new URL(AOZORA_URL),
      JOB_ID,
      sourceAozora,
      fetchFn,
      VERTICAL_MINCHO,
    );
    expect(input?.kind).toBe("html");
    if (input?.kind === "html") {
      expect(input.fontCss).toContain("font-family:'BIZ UDMincho'");
    }
    expect(calls[0]).toContain("family=BIZ+UDMincho");
  });

  it("returns null when the fetch fails", async () => {
    await expect(
      prepareAozoraRenderInput(
        new URL(AOZORA_URL),
        JOB_ID,
        async () => null,
        fontFetchFail,
        VERTICAL_MINCHO,
      ),
    ).resolves.toBeNull();
  });
});

describe("prepareRenderInput routing", () => {
  it("runs the aozora extraction for Aozora URLs regardless of mode", async () => {
    const { env, quickAction } = browserEnv();
    for (const mode of ["full", "extract"] as const) {
      const input = await prepareRenderInput(
        env,
        new URL(AOZORA_URL),
        JOB_ID,
        sourceAozora,
        fontFetchFail,
        mode,
        VERTICAL_MINCHO,
      );
      expect(input.kind).toBe("html");
      if (input.kind === "html") {
        expect(input.html).toContain("text-emphasis: filled sesame");
      }
    }
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("degrades a failed aozora extraction to the plain URL render in full mode", async () => {
    const { env, quickAction } = browserEnv();
    const input = await prepareRenderInput(
      env,
      new URL(AOZORA_URL),
      JOB_ID,
      async () => null,
      fontFetchFail,
      "full",
      VERTICAL_MINCHO,
    );
    expect(input).toEqual({ kind: "url", url: AOZORA_URL });
    // Full mode must not silently pay for the browser-extract fallback.
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("degrades a failed aozora extraction to the standard extract pipeline in extract mode", async () => {
    const { env } = browserEnv();
    const input = await prepareRenderInput(
      env,
      new URL(AOZORA_URL),
      JOB_ID,
      async () => null,
      fontFetchFail,
      "extract",
      VERTICAL_MINCHO,
    );
    // Fetch fails and the browser fallback reports failure → full render.
    expect(input).toEqual({ kind: "url", url: AOZORA_URL });
  });

  it("keeps general sites on the standard pipeline and honors the font option", async () => {
    const target = new URL("https://example.com/article");
    const sourceGeneral: SourceHtmlFetcher = async () => ({
      html: GENERAL_HTML,
      finalUrl: target,
    });
    const { fetchFn, calls } = fontFetchServing(mincho400Face("Noto Serif JP"));
    const { env } = browserEnv();
    const input = await prepareRenderInput(
      env,
      target,
      JOB_ID,
      sourceGeneral,
      fetchFn,
      "extract",
      { layout: "vertical", font: "Noto Serif JP" },
    );
    expect(input.kind).toBe("html");
    if (input.kind === "html") {
      // Standard (Readability) document: no Aozora structure CSS embedded.
      expect(input.html).not.toContain("text-emphasis: filled sesame");
      expect(input.fontCss).toContain("font-family:'Noto Serif JP'");
    }
    // Arbitrary family: no weight axis in the css2 request.
    expect(calls[0]).toContain("family=Noto+Serif+JP&display=swap");
  });
});

describe("buildInlineFontCss family selection", () => {
  it("requests and emits the given family", async () => {
    const { fetchFn, calls } = fontFetchServing(mincho400Face("BIZ UDMincho"));
    const css = await buildInlineFontCss("あ", JOB_ID, fetchFn, "BIZ UDMincho");
    expect(css).toContain("font-family:'BIZ UDMincho'");
    expect(calls[0]).toContain("family=BIZ+UDMincho");
  });
});

describe("buildPrintRules (vertical)", () => {
  const rules = buildPrintRules(VERTICAL_MINCHO).replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  it("sets vertical writing on the root element", () => {
    expect(rules).toMatch(/html\s*\{[^}]*writing-mode:\s*vertical-rl/);
  });

  it("keeps the X3 page geometry", () => {
    expect(rules).toContain("size: 66mm 99mm");
    expect(rules).toContain("margin: 4mm");
  });

  it("stacks the chosen family over the layout's generic fallback", () => {
    expect(rules).toContain('font-family: "BIZ UDMincho", serif !important');
    expect(
      buildPrintRules({ layout: "vertical", font: "Zen Old Mincho" }),
    ).toContain('font-family: "Zen Old Mincho", serif !important');
    // Horizontal layouts fall back to sans-serif instead.
    expect(
      buildPrintRules({ layout: "horizontal", font: "BIZ UDPGothic" }),
    ).toContain('font-family: "BIZ UDPGothic", sans-serif !important');
  });

  it("declares the family OUTSIDE the @media print block", () => {
    // Same lazy-font-loading pin as the horizontal stylesheet: Chromium's
    // print capture only waits for a web font that some element references
    // under the CURRENT (screen) media.
    const familyIndex = rules.indexOf("font-family:");
    const printIndex = rules.indexOf("@media print");
    expect(familyIndex).toBeGreaterThan(-1);
    expect(printIndex).toBeGreaterThan(-1);
    expect(familyIndex).toBeLessThan(printIndex);
    expect(rules.slice(printIndex)).not.toContain("font-family");
  });

  it("hides the rp fallback parentheses and shrinks rt", () => {
    expect(rules).toMatch(/rp\s*\{[^}]*display:\s*none/);
    expect(rules).toMatch(/rt\s*\{[^}]*font-size:\s*0\.5em/);
  });

  it("gives the body no fixed block size", () => {
    // height:100%/100vh on the body is the classic way to collapse a
    // vertical document into a single page.
    expect(rules).not.toMatch(/height:\s*100%/);
    expect(rules).not.toMatch(/height:\s*100vh/);
  });

  it("carries the shared anti-overflow defenses (general sites can be vertical)", () => {
    const horizontal = buildPrintRules({
      layout: "horizontal",
      font: "BIZ UDPGothic",
    });
    for (const set of [rules, horizontal]) {
      // Per-element body-text normalization (body-only sizing loses to
      // site container rules on specificity).
      expect(set).toMatch(/figcaption,[\s\S]{0,200}font-size: 10pt !important/);
      // Article-column and layout-wrapper resets.
      expect(set).toContain("max-width: none !important");
      expect(set).toContain("padding-left: 0 !important");
      expect(set).toContain("max-width: 100% !important");
      // Media clamps + aspect-ratio reset for width/height attributes.
      expect(set).toContain("height: auto !important");
      // Flex/grid shrink + mid-token wrap guards.
      expect(set).toContain("overflow-wrap: anywhere !important");
      expect(set).toContain("min-width: 0 !important");
      // Page-chrome hiding (consent banners repeat on every printed page).
      expect(set).toContain("body #onetrust-banner-sdk");
    }
    // The vertical set keeps its logical media limits on top.
    expect(rules).toContain("max-inline-size: 100% !important");
    expect(rules).toContain("max-block-size: 90% !important");
  });

  it("stays harmless for the Aozora document (structure CSS wins where it must)", () => {
    // The shared div-margin strip is physical left/right only; the jisage
    // indent is margin-inline-start (= margin-top in vertical-rl), so the
    // two never target the same declaration in the vertical layout — and in
    // the horizontal layout the class selector out-specifies the shared
    // element selector at equal !important.
    expect(rules).not.toContain("margin-inline-start: 0");
    expect(AOZORA_DOCUMENT_CSS).toContain(
      ".jisage_2 { margin-inline-start: 2em !important; }",
    );
    // gaiji/illustration sizing beats the shared img rules the same way.
    expect(AOZORA_DOCUMENT_CSS).toMatch(/img\.gaiji\s*\{[^}]*width: 1em !important/);
    expect(AOZORA_DOCUMENT_CSS).toMatch(
      /img\.illustration\s*\{[^}]*height: auto !important/,
    );
    // 底本 8pt beats the shared 10pt div normalization (class specificity).
    expect(AOZORA_DOCUMENT_CSS).toMatch(
      /\.bibliographical_information\s*\{[^}]*font-size: 8pt !important/,
    );
  });
});

describe("buildPrintCssWithFontImport", () => {
  it("imports the css2 stylesheet of the selected family first", () => {
    const css = buildPrintCssWithFontImport({
      layout: "vertical",
      font: "Zen Old Mincho",
    });
    const firstRule = css.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    expect(
      firstRule.startsWith(
        '@import url("https://fonts.googleapis.com/css2?family=Zen+Old+Mincho&display=swap");',
      ),
    ).toBe(true);
  });
});

describe("renderPdfFromHtml with options", () => {
  const captureEnv = () => {
    const quickAction = vi.fn(
      async (_action: string, _options: unknown) =>
        new Response("%PDF", { status: 200 }),
    );
    return {
      env: { BROWSER: { quickAction } as unknown as BrowserRun } as Env,
      quickAction,
    };
  };
  const styleContents = (
    quickAction: ReturnType<typeof captureEnv>["quickAction"],
  ) =>
    (
      quickAction.mock.calls[0]?.[1] as {
        addStyleTag: Array<{ content: string }>;
      }
    ).addStyleTag.map((tag) => tag.content);

  it("injects the layout rules after the inline font", async () => {
    const { env, quickAction } = captureEnv();
    const fontCss = "@font-face{font-family:'BIZ UDMincho';src:url(data:font/woff2;base64,AQIDBA==) format('woff2');}";
    await renderPdfFromHtml(env, "<html></html>", fontCss, VERTICAL_MINCHO);
    expect(styleContents(quickAction)).toEqual([
      fontCss,
      buildPrintRules(VERTICAL_MINCHO),
    ]);
  });

  it("falls back to the @import variant of the same options when the font failed", async () => {
    const { env, quickAction } = captureEnv();
    await renderPdfFromHtml(env, "<html></html>", null, VERTICAL_MINCHO);
    expect(styleContents(quickAction)).toEqual([
      buildPrintCssWithFontImport(VERTICAL_MINCHO),
    ]);
  });
});

describe("Shift_JIS decoding support", () => {
  it("decodes Shift_JIS in this runtime (fetchSourceHtml depends on it)", () => {
    // Aozora files are Shift_JIS with no charset in the HTTP header;
    // fetchSourceHtml's meta scan hands "Shift_JIS" to TextDecoder. This
    // suite runs on Node, so the pin covers the local runtime only; workerd
    // gained full WHATWG-encoding TextDecoder well before this project's
    // compatibility_date (2026-07-01) — verify once on a deployed Worker.
    const decoder = new TextDecoder("shift_jis");
    expect(decoder.decode(new Uint8Array([0x82, 0xa0]))).toBe("あ");
    // "青空" in Shift_JIS.
    expect(decoder.decode(new Uint8Array([0x90, 0xc2, 0x8b, 0xf3]))).toBe(
      "青空",
    );
  });
});
