import { describe, expect, it, vi } from "vitest";
import {
  extractArticle,
  fetchRenderedHtml,
  isExtractSufficient,
  prepareRenderInput,
} from "../src/extract";
import type { SourceHtml } from "../src/extract";
import type { FontFetcher } from "../src/fonts";

const JOB_ID = "0f6ff35e-3f8a-4f2e-9c8e-1a2b3c4d5e6f";

// Long enough to clear both Readability's charThreshold (250) and the
// default extract gate (300 chars after whitespace removal).
const BODY_TEXT = "これは本文の段落です。抽出テストのための文章が続きます。".repeat(30);

const ARTICLE_HTML = `<!doctype html>
<html lang="ja">
<head><title>テスト記事のタイトル</title></head>
<body>
  <nav>メニュー</nav>
  <article>
    <h1>テスト記事のタイトル</h1>
    <p>${BODY_TEXT}</p>
    <p>${BODY_TEXT}</p>
  </article>
  <footer>フッター</footer>
</body>
</html>`;

const SHELL_HTML = `<!doctype html>
<html><head><title>SPA</title></head><body><div id="root"></div></body></html>`;

/** BROWSER mock whose content action resolves with the given JSON body. */
const browserEnv = (body: unknown, status = 200) => {
  const quickAction = vi.fn(async () =>
    new Response(JSON.stringify(body), { status }),
  );
  return {
    env: {
      BROWSER: { quickAction } as unknown as BrowserRun,
      EXTRACT_MIN_CHARS: undefined,
    },
    quickAction,
  };
};

describe("extractArticle", () => {
  it("extracts title and body from an article page", () => {
    const article = extractArticle(ARTICLE_HTML, "https://example.com/a");
    expect(article).not.toBeNull();
    expect(article?.title).toBe("テスト記事のタイトル");
    expect(article?.contentHtml).toContain("本文の段落です");
    expect(article?.lang).toBe("ja");
  });

  it("returns null for an empty SPA shell", () => {
    expect(extractArticle(SHELL_HTML, "https://example.com/spa")).toBeNull();
  });

  it("returns null instead of throwing on broken input", () => {
    expect(extractArticle("", "https://example.com/empty")).toBeNull();
  });
});

describe("isExtractSufficient", () => {
  const article = {
    contentHtml: "<p>x</p>",
    textContent: "あ".repeat(300),
  };

  it("rejects null", () => {
    expect(isExtractSufficient(null, {})).toBe(false);
  });

  it("counts whitespace-stripped characters against the default 300", () => {
    expect(isExtractSufficient(article, {})).toBe(true);
    // Whitespace must not count: 299 chars + padding stays insufficient.
    expect(
      isExtractSufficient(
        { ...article, textContent: `${"あ".repeat(299)} \n\t ` },
        {},
      ),
    ).toBe(false);
  });

  it("honors the EXTRACT_MIN_CHARS override", () => {
    expect(
      isExtractSufficient(article, { EXTRACT_MIN_CHARS: "301" }),
    ).toBe(false);
    expect(isExtractSufficient(article, { EXTRACT_MIN_CHARS: "10" })).toBe(true);
    // Garbage falls back to the default.
    expect(isExtractSufficient(article, { EXTRACT_MIN_CHARS: "banana" })).toBe(true);
  });
});

describe("fetchRenderedHtml", () => {
  it("returns the rendered HTML on success", async () => {
    const { env } = browserEnv({
      success: true,
      result: ARTICLE_HTML,
      meta: { status: 200, title: "テスト記事のタイトル" },
    });
    await expect(
      fetchRenderedHtml(env, "https://example.com/a", JOB_ID),
    ).resolves.toBe(ARTICLE_HTML);
  });

  it("returns null when the action reports failure", async () => {
    const { env } = browserEnv({ success: false, errors: [{ code: 1 }] });
    await expect(
      fetchRenderedHtml(env, "https://example.com/a", JOB_ID),
    ).resolves.toBeNull();
  });

  it("returns null when the page itself errored (meta.status)", async () => {
    const { env } = browserEnv({
      success: true,
      result: "<html><body>Not Found</body></html>",
      meta: { status: 404, title: "404" },
    });
    await expect(
      fetchRenderedHtml(env, "https://example.com/gone", JOB_ID),
    ).resolves.toBeNull();
  });

  it("returns null on a non-2xx action response", async () => {
    const { env } = browserEnv({ success: false }, 429);
    await expect(
      fetchRenderedHtml(env, "https://example.com/a", JOB_ID),
    ).resolves.toBeNull();
  });

  it("returns null when the binding throws", async () => {
    const env = {
      BROWSER: {
        quickAction: async () => {
          throw new Error("boom");
        },
      } as unknown as BrowserRun,
    };
    await expect(
      fetchRenderedHtml(env, "https://example.com/a", JOB_ID),
    ).resolves.toBeNull();
  });
});

describe("prepareRenderInput", () => {
  const target = new URL("https://example.com/article");
  const sourceOk = async (): Promise<SourceHtml> => ({
    html: ARTICLE_HTML,
    finalUrl: new URL("https://example.com/article-final"),
  });
  const sourceShell = async (): Promise<SourceHtml> => ({
    html: SHELL_HTML,
    finalUrl: target,
  });
  const sourceFail = async () => null;

  // Keeps tests off the network; the font inliner must fail-soft to <link>.
  const fontFetchFail: FontFetcher = async () => {
    throw new Error("no network in tests");
  };

  it("uses the plain-fetch path without touching the browser", async () => {
    const { env, quickAction } = browserEnv({ success: false });
    const input = await prepareRenderInput(
      env,
      target,
      JOB_ID,
      sourceOk,
      fontFetchFail,
    );
    expect(input.kind).toBe("html");
    if (input.kind === "html") {
      expect(input.html).toContain("本文の段落です");
      // Base URL must be the post-redirect URL, not the submitted one.
      expect(input.html).toContain('href="https://example.com/article-final"');
      // Font fail-soft: no inline CSS; the render will inject the @import
      // variant of the print CSS instead. The document itself never carries
      // a font reference.
      expect(input.fontCss).toBeNull();
      expect(input.html).not.toContain("fonts.googleapis.com");
    }
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("inlines the font subset when the font fetch succeeds", async () => {
    const fontCssFixture = `@font-face {
  font-family: 'BIZ UDPGothic';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/l/font?kit=k4) format('woff2');
  unicode-range: U+3042;
}`;
    const fontFetchOk: FontFetcher = async (url) =>
      url.startsWith("https://fonts.googleapis.com/")
        ? new Response(fontCssFixture, { status: 200 })
        : new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 });
    const { env } = browserEnv({ success: false });
    const input = await prepareRenderInput(
      env,
      target,
      JOB_ID,
      sourceOk,
      fontFetchOk,
    );
    expect(input.kind).toBe("html");
    if (input.kind === "html") {
      // The inlined font rides NEXT TO the HTML (injected via addStyleTag at
      // render time), never inside it: Browser Run's html mode ignores
      // document-level data: @font-face.
      expect(input.fontCss).toContain("data:font/woff2;base64,AQIDBA==");
      expect(input.html).not.toContain("data:font/woff2");
      expect(input.html).not.toContain("fonts.googleapis.com");
    }
  });

  it("falls back to the browser when the fetched page has no article", async () => {
    const { env, quickAction } = browserEnv({
      success: true,
      result: ARTICLE_HTML,
      meta: { status: 200, title: "" },
    });
    const input = await prepareRenderInput(
      env,
      target,
      JOB_ID,
      sourceShell,
      fontFetchFail,
    );
    expect(input.kind).toBe("html");
    expect(quickAction).toHaveBeenCalledTimes(1);
  });

  it("degrades to full mode when both paths fail", async () => {
    const { env } = browserEnv({ success: false });
    const input = await prepareRenderInput(
      env,
      target,
      JOB_ID,
      sourceFail,
      fontFetchFail,
    );
    expect(input).toEqual({ kind: "url", url: target.toString() });
  });

  it("degrades to full mode when even the rendered HTML has no article", async () => {
    const { env } = browserEnv({
      success: true,
      result: SHELL_HTML,
      meta: { status: 200, title: "SPA" },
    });
    const input = await prepareRenderInput(
      env,
      target,
      JOB_ID,
      sourceFail,
      fontFetchFail,
    );
    expect(input).toEqual({ kind: "url", url: target.toString() });
  });
});
