import { describe, expect, it, vi } from "vitest";
import {
  extractAozoraArticle,
  prepareAozoraRenderInput,
} from "../src/aozora";
import { prepareRenderInput } from "../src/extract";
import type { SourceHtmlFetcher } from "../src/extract";
import { buildInlineFontCss } from "../src/fonts";
import type { FontFetcher } from "../src/fonts";
import { AOZORA_PRINT_RULES, renderPdfFromHtml } from "../src/pdf";
import { isAozoraBunkoUrl } from "../src/sitepresets";
import type { Env } from "../src/types";

const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";

const AOZORA_URL =
  "https://www.aozora.gr.jp/cards/000148/files/789_14547.html";

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

const sourceAozora: SourceHtmlFetcher = async () => ({
  html: AOZORA_HTML,
  finalUrl: new URL(AOZORA_URL),
});

const fontFetchFail: FontFetcher = async () => {
  throw new Error("no network in tests");
};

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

describe("prepareAozoraRenderInput", () => {
  it("builds a vertical-preset print document", async () => {
    const input = await prepareAozoraRenderInput(
      new URL(AOZORA_URL),
      JOB_ID,
      sourceAozora,
      fontFetchFail,
    );
    expect(input).not.toBeNull();
    expect(input?.kind).toBe("html");
    if (input?.kind !== "html") {
      return;
    }
    expect(input.printPreset).toBe("aozora");
    // Font fail-soft: render proceeds without the inline font.
    expect(input.fontCss).toBeNull();
    // Ruby structure survives sanitization end to end.
    expect(input.html).toContain("<rt>のぼ</rt>");
    // Site-relative gaiji and files-relative illustration are absolutized.
    expect(input.html).toContain(
      'src="https://www.aozora.gr.jp/gaiji/1-85/1-85-87.png"',
    );
    expect(input.html).toContain(
      'src="https://www.aozora.gr.jp/cards/000148/files/fig789_01.png"',
    );
    // Physical inline margins are gone (vertical-rl would indent the wrong
    // axis); the class survives for the logical margin-inline rules.
    expect(input.html).not.toContain("margin-left");
    expect(input.html).toContain('class="jisage_2"');
    expect(input.html).toContain('class="chitsuki_1"');
    // jquery must not survive into the print document.
    expect(input.html).not.toContain("jquery");
    // Colophon identifies the source.
    expect(input.html).toContain("青空文庫");
    expect(input.html).toContain(AOZORA_URL);
  });

  it("returns null when the fetch fails", async () => {
    await expect(
      prepareAozoraRenderInput(
        new URL(AOZORA_URL),
        JOB_ID,
        async () => null,
        fontFetchFail,
      ),
    ).resolves.toBeNull();
  });
});

describe("prepareRenderInput aozora routing", () => {
  it("uses the aozora preset for Aozora URLs regardless of mode", async () => {
    const { env, quickAction } = browserEnv();
    for (const mode of ["full", "extract"] as const) {
      const input = await prepareRenderInput(
        env,
        new URL(AOZORA_URL),
        JOB_ID,
        sourceAozora,
        fontFetchFail,
        mode,
      );
      expect(input.kind).toBe("html");
      if (input.kind === "html") {
        expect(input.printPreset).toBe("aozora");
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
    );
    // Fetch fails and the browser fallback reports failure → full render.
    expect(input).toEqual({ kind: "url", url: AOZORA_URL });
  });

  it("keeps non-aozora URLs off the aozora preset", async () => {
    const { env } = browserEnv();
    const input = await prepareRenderInput(
      env,
      new URL("https://example.com/cards/000148/files/789_14547.html"),
      JOB_ID,
      sourceAozora,
      fontFetchFail,
    );
    if (input.kind === "html") {
      expect(input.printPreset).toBeUndefined();
    }
  });
});

describe("buildInlineFontCss family override", () => {
  it("requests and emits BIZ UDMincho when asked to", async () => {
    const face = `@font-face {
  font-family: 'BIZ UDMincho';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/l/font?kit=k4) format('woff2');
  unicode-range: U+3042;
}`;
    const calls: string[] = [];
    const fetchFn: FontFetcher = async (url) => {
      calls.push(url);
      return url.startsWith("https://fonts.googleapis.com/")
        ? new Response(face, { status: 200 })
        : new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 });
    };
    const css = await buildInlineFontCss("あ", JOB_ID, fetchFn, "BIZ UDMincho");
    expect(css).toContain("font-family:'BIZ UDMincho'");
    expect(calls[0]).toContain("family=BIZ+UDMincho");
  });
});

describe("AOZORA_PRINT_RULES", () => {
  const rules = AOZORA_PRINT_RULES.replace(/\/\*[\s\S]*?\*\//g, "");

  it("sets vertical writing on the root element", () => {
    expect(rules).toMatch(/html\s*\{[^}]*writing-mode:\s*vertical-rl/);
  });

  it("keeps the X3 page geometry", () => {
    expect(rules).toContain("size: 66mm 99mm");
    expect(rules).toContain("margin: 4mm");
  });

  it("declares the BIZ UDMincho family OUTSIDE the @media print block", () => {
    // Same lazy-font-loading pin as X3_PRINT_CSS: Chromium's print capture
    // only waits for a web font that some element references under the
    // CURRENT (screen) media, so the family must sit at the top level.
    const familyIndex = rules.indexOf("font-family:");
    const printIndex = rules.indexOf("@media print");
    expect(familyIndex).toBeGreaterThan(-1);
    expect(printIndex).toBeGreaterThan(-1);
    expect(familyIndex).toBeLessThan(printIndex);
    expect(rules.slice(printIndex)).not.toContain("font-family");
    expect(rules).toContain('"BIZ UDMincho"');
  });

  it("never @imports a remote stylesheet", () => {
    // The vertical path relies on the inlined subset only; a remote fetch
    // at capture time is probabilistic and must not be reintroduced.
    expect(rules).not.toContain("@import");
  });

  it("indents 字下げ/地付き along the logical inline axis", () => {
    expect(rules).toContain(".jisage_2 { margin-inline-start: 2em !important; }");
    expect(rules).toContain(".chitsuki_1 { margin-inline-end: 1em !important; }");
    expect(rules).toMatch(/chitsuki[^}]*text-align:\s*end/);
  });

  it("hides the rp fallback parentheses and shrinks rt", () => {
    expect(rules).toMatch(/rp\s*\{[^}]*display:\s*none/);
    expect(rules).toMatch(/rt\s*\{[^}]*font-size:\s*0\.5em/);
  });

  it("gives the body no fixed block size", () => {
    // height:100%/100vh on the body is the classic way to collapse a
    // vertical document into a single page.
    expect(rules).not.toMatch(/height:\s*100/);
  });
});

describe("renderPdfFromHtml aozora preset", () => {
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

  it("injects the vertical rules after the inline font", async () => {
    const { env, quickAction } = captureEnv();
    const fontCss = "@font-face{font-family:'BIZ UDMincho';src:url(data:font/woff2;base64,AQIDBA==) format('woff2');}";
    await renderPdfFromHtml(env, "<html></html>", fontCss, "aozora");
    expect(styleContents(quickAction)).toEqual([fontCss, AOZORA_PRINT_RULES]);
  });

  it("renders with the vertical rules alone when the font failed (no @import fallback)", async () => {
    const { env, quickAction } = captureEnv();
    await renderPdfFromHtml(env, "<html></html>", null, "aozora");
    expect(styleContents(quickAction)).toEqual([AOZORA_PRINT_RULES]);
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
