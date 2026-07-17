# Cloudflare Workerを受付・制御役にして、Browser RunでPDF化し、Cloudflare ContainerでXTC化するアプリ

```text
URLを送信
  ↓
Cloudflare Worker
  ├─ URL検証
  ├─ Browser RunでCSS適用
  ├─ PDF生成
  ├─ PDFをR2へ保存
  ↓
Cloudflare Container
  ├─ xtctoolでPDF→XTC
  ├─ XTCをR2へ保存
  ↓
WorkerからダウンロードURLを返す
```

## なぜWorkerだけではなくContainerを使うのか

URLからPDFまでなら、WorkerからBrowser RunのPDF Quick Actionを呼ぶだけで実現できます。URL、追加CSS、Cookie、HTTPヘッダー、Viewportなどを指定できます。([Cloudflare Docs][1])

一方、`xtctool`は次のネイティブ寄りの依存関係を使います。

* PyMuPDF：PDFの画像化
* Pillow：画像処理
* NumPy：配列処理
* オプションでNumba：ディザリング高速化

そのため、通常のWorkersランタイムへそのまま載せるのは難しいです。`xtctool`自体はPDFを直接XTCに変換でき、幅・高さ・ディザリングなども設定できます。([GitHub][2])

Cloudflare Containersなら、Python、ネイティブライブラリ、Linuxファイルシステムを含む既存ツールを動かせます。Workers Paidプランで利用可能です。([Cloudflare Docs][3])

## PDF生成部分

Cloudflare Browser Runには、URLをPDF化する機能があります。追加CSSも直接渡せます。

```ts
interface Env {
  BROWSER: BrowserRun;
  XTC_BUCKET: R2Bucket;
}

const X3_PRINT_CSS = `
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

    img,
    table,
    pre {
      max-width: 100% !important;
    }

    pre {
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
    }
  }
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const body = await request.json<{ url?: string }>();

    if (!body.url) {
      return Response.json(
        { error: "url is required" },
        { status: 400 },
      );
    }

    const target = validatePublicUrl(body.url);

    const pdfResponse = await env.BROWSER.quickAction("pdf", {
      url: target.toString(),

      addStyleTag: [
        {
          content: X3_PRINT_CSS,
        },
      ],

      gotoOptions: {
        waitUntil: "networkidle2",
        timeout: 30_000,
      },

      pdfOptions: {
        printBackground: false,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
      },
    });

    if (!pdfResponse.ok) {
      return Response.json(
        {
          error: "PDF generation failed",
          detail: await pdfResponse.text(),
        },
        { status: 502 },
      );
    }

    const jobId = crypto.randomUUID();
    const pdfKey = `jobs/${jobId}/source.pdf`;

    await env.XTC_BUCKET.put(pdfKey, pdfResponse.body, {
      httpMetadata: {
        contentType: "application/pdf",
      },
    });

    return Response.json({
      jobId,
      status: "pdf-generated",
      pdfKey,
    });
  },
} satisfies ExportedHandler<Env>;

function validatePublicUrl(input: string): URL {
  const url = new URL(input);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("http/https URL only");
  }

  const hostname = url.hostname.toLowerCase();

  const forbiddenHosts = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "169.254.169.254",
  ]);

  if (forbiddenHosts.has(hostname)) {
    throw new Error("private URL is not allowed");
  }

  return url;
}
```

Browser RunのQuick Actionでは、公式例でも次のようにURLと追加CSSを同時に指定しています。([Cloudflare Docs][1])

```ts
return env.BROWSER.quickAction("pdf", {
  url: "https://example.com/",
  addStyleTag: [
    {
      content: "body { font-family: Arial; }",
    },
  ],
});
```

## Wrangler設定

```jsonc
{
  "name": "url-to-xtc",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-17",

  "browser": {
    "binding": "BROWSER"
  },

  "r2_buckets": [
    {
      "binding": "XTC_BUCKET",
      "bucket_name": "xteink-conversions"
    }
  ],

  "containers": [
    {
      "class_name": "XtcConverterContainer",
      "image": "./converter/Dockerfile",
      "max_instances": 2
    }
  ],

  "durable_objects": {
    "bindings": [
      {
        "name": "XTC_CONVERTER",
        "class_name": "XtcConverterContainer"
      }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["XtcConverterContainer"]
    }
  ]
}
```

## XTC変換用Container

### Dockerfile

```dockerfile
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git \
       build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/chazeon/xtctool.git /opt/xtctool \
    && pip install --no-cache-dir "/opt/xtctool[performance]"

WORKDIR /app

COPY app.py /app/app.py
COPY config-x3.toml /app/config-x3.toml

EXPOSE 8080

CMD ["python", "/app/app.py"]
```

### X3用設定

```toml
[output]
width = 528
height = 792
resample_method = "LANCZOS"

title = ""
author = ""
publisher = ""
language = "ja-JP"
direction = "ltr"

[pdf]
resolution = 200

[xtg]
threshold = 128
invert = false
dither = true
dither_strength = 0.7

[xth]
threshold1 = 85
threshold2 = 170
threshold3 = 255
invert = false
dither = true
dither_strength = 0.8
```

X3のターゲット解像度は528×792です。XTC.jsもX3向けにこのサイズで処理しています。([GitHub][4])

### Container側の処理イメージ

Containerは、WorkerからPDFを受け取って一時ファイルに保存し、次のコマンドを実行します。

```bash
xtctool convert \
  /tmp/source.pdf \
  -o /tmp/output.xtc \
  -c /app/config-x3.toml
```

`xtctool`はPDFから複数ページのXTCコンテナを直接生成できます。([GitHub][2])

簡略化したPython APIは次のようになります。

```python
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import json
import subprocess
import tempfile
import urllib.request


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path != "/convert":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length))
        pdf_url = payload["pdfUrl"]

        with tempfile.TemporaryDirectory() as workdir:
            pdf_path = Path(workdir) / "source.pdf"
            xtc_path = Path(workdir) / "output.xtc"

            urllib.request.urlretrieve(pdf_url, pdf_path)

            result = subprocess.run(
                [
                    "xtctool",
                    "convert",
                    str(pdf_path),
                    "-o",
                    str(xtc_path),
                    "-c",
                    "/app/config-x3.toml",
                ],
                capture_output=True,
                text=True,
                timeout=600,
                check=False,
            )

            if result.returncode != 0:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps({
                        "error": "conversion failed",
                        "stderr": result.stderr,
                    }).encode()
                )
                return

            output = xtc_path.read_bytes()

            self.send_response(200)
            self.send_header(
                "Content-Type",
                "application/octet-stream",
            )
            self.send_header(
                "Content-Disposition",
                'attachment; filename="document.xtc"',
            )
            self.send_header("Content-Length", str(len(output)))
            self.end_headers()
            self.wfile.write(output)


HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
```

実運用では、PDFとXTCをHTTPレスポンスで往復させるより、R2経由にする方が安全です。

## 同期処理と非同期処理

### 小さい記事なら同期処理

```text
POST /convert
→ PDF生成
→ ContainerでXTC化
→ XTCを直接返す
```

数ページ程度なら、これでも動かせる可能性があります。

### 長い記事・ドキュメントなら非同期処理

```text
POST /jobs
→ 202 Accepted + jobId

GET /jobs/{jobId}
→ queued / rendering / converting / completed

GET /jobs/{jobId}/download
→ XTC
```

こちらが安定します。

Cloudflare Queuesのconsumerは1回あたり最大15分のwall timeを利用できるため、変換ジョブをキュー処理する構成と相性がよいです。([Cloudflare Docs][5])

```text
Worker
  ↓ jobを登録
Queue
  ↓
PDF生成Worker
  ↓
R2 source.pdf
  ↓
Container
  ↓
R2 output.xtc
```

## XTC.jsをそのままWorkerに移植する案

不可能ではありませんが、最初のPoCにはおすすめしません。

XTC.jsはTypeScript主体で、PDF.js、JSZip、PDF-libなどを使い、PDF・画像からブラウザ内でXTCを生成します。MITライセンスなので、変換ロジックを抽出して再利用する選択肢はあります。([GitHub][6])

ただし、現状の実装は「ブラウザ内でローカル変換するWebアプリ」が中心です。Canvas、ImageData、PDF.js workerなど、Workersランタイムには存在しないブラウザAPIへの依存を切り離す作業が必要になる可能性があります。XTC.jsのサーバー側コードも、確認できる範囲では主に統計や補助APIで、変換処理そのものはクライアント側です。([GitHub][4])

したがって、最初は次の構成が堅実です。

```text
Cloudflare Worker
  Browser RunでURL＋CSS → PDF
        ↓
Cloudflare Container
  xtctoolでPDF → XTC
        ↓
R2
```

## 注意点

### 認証が必要なページ

Browser RunにはCookie、追加ヘッダー、Basic認証などを設定できます。([Cloudflare Docs][1])

ただし、MicrosoftやGoogleへの対話的ログインを自動化するより、対象サイト専用のセッションCookieや、閲覧用トークンを渡す設計の方が安定します。

### SSRF対策

ユーザーが自由にURLを渡せるAPIでは、最低でも以下が必要です。

* `https:`以外を拒否
* localhostやプライベートIPを拒否
* リダイレクト先も再検証
* 最大ページ数・最大処理時間を設定
* API自体をCloudflare Accessで保護する

## 結論

**URLを1つ渡して、CSS適用、PDF化、XTC化、ダウンロードまでCloudflare上で自動化できます。**

ただし役割分担は、

* URL表示・CSS適用・PDF生成：**Worker＋Browser Run**
* PDFの画像化・ディザリング・XTC生成：**Cloudflare Container＋xtctool**
* 中間ファイルと完成品：**R2**
* 長い処理：**Queues**

が現実的です。

最初のPoCなら、`POST /convert`へURLを渡し、同期でXTCを返すところから始めるのがよいです。

[1]: https://developers.cloudflare.com/browser-run/quick-actions/pdf-endpoint/ "/pdf - Render PDF · Cloudflare Browser Run docs"
[2]: https://github.com/chazeon/xtctool "GitHub - chazeon/xtctool: Turn EPUB and PDF into beautiful books on your Xteink e-reader · GitHub"
[3]: https://developers.cloudflare.com/containers/ "Overview · Cloudflare Containers docs"
[4]: https://github.com/varo6/xtcjs "GitHub - varo6/xtcjs: Convert manga cbz to xtc locally on your browser! XTEink X4 optimized! · GitHub"
[5]: https://developers.cloudflare.com/queues/platform/limits/?utm_source=chatgpt.com "Limits · Cloudflare Queues docs"
[6]: https://github.com/varo6/xtcjs/blob/master/package.json "xtcjs/package.json at master · varo6/xtcjs · GitHub"
