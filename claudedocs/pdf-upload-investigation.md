# PDFアップロード機能 実装調査レポート

調査日: 2026-07-21
対象: `/Users/haruki/Documents/html2xtc-pdf-upload`（git worktree）
入力仕様書: `/Users/haruki/Downloads/html2xtc-pdf-upload-spec.md`
参考UI: `/Users/haruki/Downloads/index.html`

このレポートは実装エージェントがコードを再探索せずに実装へ入れるよう、実在のファイルパス・行番号・関数名・型名を記載する。**仕様書の記述と実コードベースには複数の重大な差異がある**（§4 ギャップ分析を必ず読むこと）。特に R2 キー命名・エラーレスポンス形式・ジョブ状態モデルは仕様書どおりに実装すると既存機能を壊す。

---

## 0. 現状サマリ（最重要）

- 現行コードは仕様書が前提とする「シンプルな `/jobs` + `ConvertJobParams{url}`」より大幅に進んでいる。認証（WebAuthn passkey）・端末ペアリング・OPDS配信・永続ライブラリ・青空文庫カタログ同期がすでに実装済みで、`src/router.ts`（新方式）と `src/index.ts` の `route()`（レガシー方式）の2系統のルーティングが共存している。
- 参考UI (`/Users/haruki/Downloads/index.html`) はこのリポジトリの実装物ではなく、**別の古いモックアップ**（PDF/EPUB/TXTの3種ファイル対応・crop単位mm・margin=fit/width等、仕様書とも食い違うデータモデル）。デザイントークン（CSS変数名・色）は現行 `frontend/src/app.css` と完全一致するので流用可能だが、UI構造・状態遷移・データモデルはそのまま使えない。仕様書 (`PdfConvertOptions`) を正とすること。
- R2キー命名は仕様書 §13.1 (`input/{jobId}/source.pdf`, `output/{jobId}/output.xtc`) と実コード (`intermediate/{jobId}/source.pdf`, `jobs/{jobId}/output.xtc`) が食い違う。**R2 lifecycle ルールは `wrangler.jsonc` では設定不可**で、CLIで一度だけ手動適用されている（`claudedocs/deploy-guide.md`）。新規プレフィックスを使うなら新しい lifecycle ルールをCLIで追加する必要がある。
- 既存 `/jobs`・`/convert` はエラーを `{"error": "<string>"}` 形式で返す（レガシー）。新方式ルート（`src/router.ts` 経由）は `{"error": {"code", "message"}}`（`src/security/errors.ts`）。フロントエンドの `frontend/src/lib/convert.svelte.ts` は **文字列形式を前提**にパースしている（`JobsPostResponse.error?: string`）。`/jobs/pdf` をどちらに載せるかで応答形式が変わるため注意。

---

## 1. バックエンド（Cloudflare Worker）調査結果

### 1.1 ルーティング構造

`src/index.ts` の `fetch()`（50-70行目）:

```ts
const router = new Router();
registerAuthRoutes(router);
registerLibraryRoutes(router);
registerDeviceRoutes(router);
registerOpdsRoutes(router);

export default {
  async fetch(request, env) {
    try {
      const routed = await router.handle(request, env);
      if (routed !== null) return withSecurityHeaders(routed, newRequestId());
      return await route(request, env);   // ← レガシー route() へフォールバック
    } catch (error) { ... }
  },
  ...
};
```

- `Router`（`src/router.ts`）: 新方式（auth/library/devices/opds）。`:param` セグメントのみ、正規表現なし。`handle()` はパスにマッチする登録ルートが1つもなければ `null` を返し `route()` にフォールバックする。マッチしたが method 不一致なら 405（Allow ヘッダ付き）。
- `route()`（`src/index.ts` 116-176行目）: レガシー手書きルーター。`/convert`・`/jobs`・`/api/books`・`/jobs/:jobId`（正規表現）・`/jobs/:jobId/download`（正規表現）・`/download/:jobId`（正規表現）をここで判定。

該当箇所（`src/index.ts`）:

```
132: if (pathname === "/jobs") { ... POST only ... }
153: const jobStatus = pathname.match(/^\/jobs\/([^/]+)$/);
161: const jobDownload = pathname.match(/^\/jobs\/([^/]+)\/download$/);
169: const download = pathname.match(/^\/download\/([^/]+)$/);
```

**仕様書 §10.1 の指示どおり `/jobs/pdf` は `jobStatus` 正規表現（153行目）より前**、かつ `pathname === "/jobs"` ブロック（132行目）の直後に追加すること。`/jobs/pdf` は `jobStatus` の `[^/]+` にもマッチしてしまうため、先着判定が必須（仕様書の指摘は正しい）。

新方式の `Router` にPDFルートを載せる選択肢もあるが、**推奨しない**: 新方式はエラー形式が `{error:{code,message}}` で、フロントの `submitFile` 相当を新規実装する際は自由に選べるとしても、既存フロントの `submitUrl`/ポーリング系ヘルパー（`convert.svelte.ts`）が期待する文字列エラー形式・`JobStatusResponse` 形式との整合を取るなら、`/jobs` 系はレガシー `route()` に揃えるのが自然。仕様書もこの前提で書かれている。

### 1.2 レート制限

`src/ratelimiter.ts` の `enforceRateLimit(request, env)`:

```ts
export async function enforceRateLimit(
  request: Request,
  env: Env,
): Promise<Response | null>
```

- 呼び出し例（`src/index.ts` 125行目, 136行目）: `/convert` と `/jobs` の両方が同じ `enforceRateLimit` を通す（同一カウンタ。`purposeRateLimitKey` ではなく `rateLimitKey` を使う共有窓）。
- 429時は `Response.json({error:"rate limit exceeded; try again later"}, {status:429, headers:{"Retry-After":...}})`（**文字列エラー形式**）。
- 内部は `RateLimiter` Durable Object（同ファイル、`class RateLimiter extends DurableObject<Env>`）の `take(limit)`。DO障害時は fail-open（null を返し通す）。
- 仕様書 §8.1「レート制限」が言う「`/convert` `/jobs` `/jobs/pdf` に同じ制限」は **`enforceRateLimit` をそのまま呼べば実現できる**（新しいカウンタ空間を切る必要はない — 既存と同一窓のままでよい）。
- 別の仕組みとして `enforcePurposeRateLimit`（同ファイル）もあるが、これは auth/pairing等の新方式ルート専用（fail-closed 選択可）。PDFアップロードは `enforceRateLimit` 踏襲でよい。

### 1.3 R2バケット・キー命名・Env型

`wrangler.jsonc`:
```jsonc
"r2_buckets": [{ "binding": "XTC_BUCKET", "bucket_name": "xteink-conversions" }]
```

`src/jobs.ts` の実際のキー生成関数（**仕様書の `input/`/`output/` とは異なる**）:

```ts
export function intermediatePdfKey(jobId: string): string {
  return `intermediate/${jobId}/source.pdf`;
}
export function outputXtcKey(jobId: string): string {
  return `jobs/${jobId}/output.xtc`;
}
```

- `intermediate/` プレフィックス: 1日で自動削除（lifecycle rule `expire-intermediate-pdf`）。URL変換の中間PDFに使われている。
- `jobs/` プレフィックス: 1日で自動削除（lifecycle rule `expire-job-outputs`。README上は「約24時間」）。完成XTCの保存先。
- `library/accounts/{accountId}/items/{itemId}/book.xtc`（`src/library/storage.ts`）: lifecycle対象外の永続ライブラリ。**PDFアップロード機能とは無関係だが、prefix設計の参考にする**。

**推奨**: アップロードPDFの入力は新規 `input/` プレフィックスを追加し、専用のR2ライフサイクルルールを別途CLIで登録する（§4.3参照）。既存 `intermediate/` を流用すると、URL変換の中間PDFと削除ポリシーの意味が混ざる（アップロードPDFは「Workflow完了時に即時削除、lifecycleは保険」という異なる運用方針）。出力XTCは既存 `outputXtcKey(jobId)`（`jobs/{jobId}/output.xtc`）をそのまま流用すればよい — ダウンロード・ステータスAPIが共通化できる。

`Env` 型（`src/types.ts` 58-115行目）に **PDF関連フィールドは1つも無い**。追加が必要:
```ts
export interface Env {
  BROWSER: BrowserRun;
  XTC_BUCKET: R2Bucket;
  XTC_CONVERTER: DurableObjectNamespace<XtcConverterContainer>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  CONVERT_WORKFLOW: Workflow<ConvertJobParams>;
  AOZORA_DB: D1Database;
  AOZORA_SYNC_WORKFLOW: Workflow<AozoraCatalogSyncParams>;
  APP_DB: D1Database;
  MAX_PDF_BYTES?: string;          // 既存: 生成PDF(URL変換)の上限。仕様のMAX_UPLOAD_PDF_BYTESとは別軸
  EXTRACT_MIN_CHARS?: string;
  RATE_LIMIT_PER_HOUR?: string;
  WEBAUTHN_RP_ID?: string; ...
}
```
`MAX_UPLOAD_PDF_BYTES` のような新規var、または既存 `MAX_PDF_BYTES` の意味を「PDF入出力共通の上限」に拡張するか要判断（仕様書は独立した48MiBデフォルトを想定=`MAX_UPLOAD_PDF_BYTES=50331648`。現行 `MAX_PDF_BYTES` はコード既定20MiB・wrangler.jsonc設定値48MiB=50331648で**数値が偶然一致**している。別varにするのが安全 — URL変換PDF上限とアップロードPDF上限を将来別々に変えたくなる可能性がある）。

### 1.4 workflow.ts の実体

`ConvertJobParams`（`src/types.ts` 35-46行目）は仕様書と大きく異なる:
```ts
export interface ConvertJobParams {
  url: string;              // 必須。仕様書は url?: string + source? を想定
  mode?: ConvertMode;
  layout?: string;
  font?: string;
}
```
**`source: ConvertSource` フィールドは存在しない。`pdfOptions` も存在しない。** 仕様書 §9.1 の型を実際に追加する必要がある。`url` を必須のままにするか optional にするかは既存ジョブとの後方互換に影響する（Workflow instance の paramsは永続化済みなので、型を optional にしても既存データは壊れない。むしろ `url: string` を `url?: string` に緩めるのは安全な変更）。

`ConvertWorkflow`（`src/workflow.ts`、`WorkflowEntrypoint<Env, ConvertJobParams>`）の `run()` 構成:
1. `event.payload.mode ?? "full"` でモード決定
2. `mode === "extract" || isAozoraBunkoUrl(target)` なら `step.do("extract-content", ...)`
3. 常に `step.do("render-pdf", {retries:{limit:2,delay:"10 seconds",backoff:"exponential"}, timeout:"7 minutes"}, ...)` — Browser RunでPDF生成 → `intermediatePdfKey(jobId)` へR2保存
4. `step.do("convert-xtc", {retries:{limit:2,delay:"30 seconds",backoff:"constant"}, timeout:"12 minutes"}, ...)` — R2から `pdfKey` streamGet → `convertInContainer()` → `storeXtcOutput()`
5. `finally` で `step.do("delete-intermediate-pdf", ...)` — pdfKey/articleKey/fontsKeyをbest-effort削除

**PDF分岐の実装方針**: `event.payload.url` は既存ジョブとの後方互換のため必須のまま残し、`event.payload.source`（新規, `ConvertSource` 型）が存在すればそちらを優先する分岐を `run()` の先頭に追加する（仕様書 §9.1 の `resolveSource()` と同じ考え方）。`source.kind === "pdf"` の場合は `extract-content`/`render-pdf` の2ステップを完全にスキップし、新規 `step.do("convert-uploaded-pdf", {retries:{limit:2,delay:"30 seconds",backoff:"constant"}, timeout:"12 minutes"}, ...)` を実行 — R2 `input/{jobId}/source.pdf` を `source.body.pipeThrough(new FixedLengthStream(source.size))` でストリームし、`container.ts` に新設する関数（後述）で Container `/convert/uploaded-pdf` へ送る。**`convertInContainer()` を流用せず新関数にすること**（送信先パス・追加ヘッダー `X-Pdf-Options`/`X-Source-Filename` が異なるため）。`finally` で入力PDFのbest-effort削除（`step.do("delete-uploaded-pdf", ...)`）。

`title` の扱い: 既存パイプラインは `storeXtcOutput()`（`src/pipeline.ts`）が Container レスポンスの `X-Xtc-Title` ヘッダーから title を取得し R2 customMetadata に格納、Workflow の戻り値 `{xtcKey, title}` として `instance.status().output` に載る（`src/jobs.ts` の `titleFromOutput()` がそれを読む）。PDF側もこの経路（`X-Xtc-Title` ヘッダー）にそのまま乗せられる ── Container 側で「PDFメタデータのタイトル、なければファイル名」を `X-Xtc-Title` にセットすればWorker側の変更は最小で済む。

### 1.5 container.ts の呼び出し方法

```ts
export function convertInContainer(
  env: Env, jobId: string,
  pdfBody: ArrayBuffer | ReadableStream,
  timeoutMs: number,
): Promise<Response> {
  const container = getContainer(env.XTC_CONVERTER, converterInstanceName(jobId));
  return container.fetch(new Request("http://converter/convert", {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "X-Convert-Timeout-Seconds": subprocessTimeoutSeconds,
      "X-Max-Pdf-Bytes": String(resolveMaxPdfBytes(env)),
    },
    body: pdfBody,
    signal: AbortSignal.timeout(timeoutMs),
  }));
}
```
- `getContainer(env.XTC_CONVERTER, converterInstanceName(jobId))` — jobIdをハッシュして固定4インスタンスプール（`CONVERTER_POOL_SIZE = 4`。`wrangler.jsonc` の `containers[].max_instances` と一致させる必要あり、というコメントが既にある）にルーティング。
- ストリームで送る場合は必ず `FixedLengthStream` で長さを付与すること（`app.py` の `http.server` は chunked を受け付けない — 仕様書 §11.3 と整合）。
- 新規に `convertUploadedPdfInContainer(env, jobId, pdfBody, pdfOptions, filename, timeoutMs)` のような専用関数を追加し、送信先を `http://converter/convert/uploaded-pdf` に、ヘッダーに `X-Pdf-Options`（base64url JSON）・`X-Source-Filename`（base64url UTF-8）を追加する形が既存コードと最も整合する。

### 1.6 jobs.ts のステータス判定ロジック

```ts
export function mapInstanceStatus(
  jobId: string, instance: WorkflowStatusLike, hasIntermediatePdf: boolean,
): JobStatusBody {
  switch (instance.status) {
    case "queued": return { jobId, status: "queued" };
    case "complete": { ... status:"completed", downloadUrl, title }
    case "errored": case "terminated": return { jobId, status:"failed", error: instance.error?.message ?? "unknown error" };
    default: // running/waiting/paused/...
      return { jobId, status: hasIntermediatePdf ? "converting" : "rendering" };
  }
}
```
`hasIntermediatePdf` は `src/index.ts` の `handleJobStatus`（呼び出し元、`mapWithPhaseProbe` 経由）が `needsPhaseProbe(status)` が true のときだけ R2 に `intermediatePdfKey(jobId)` の存在確認を行って渡す値。**PDFジョブには「rendering」フェーズが存在しない**（Browser Run を使わないため）ので、この関数は PDF ジョブに対しては常に `"converting"` を返すよう分岐を追加する必要がある。判定方法の候補: `instance` だけからは PDF/URL の区別がつかないため、呼び出し元で `source.kind` を Workflow params から読むか、`needsPhaseProbe` 相当のR2プローブを `input/{jobId}/source.pdf` の有無に置き換えるロジックを別途用意する。**`ConvertJobParams` に `source` を追加した後、Workflow instance から `event.payload` を読む手段がないため**（`instance.status()` は `output`/`error`しか返さない）、実装上は「PDFジョブは常に converting、rendering フェーズという概念自体を持たない」という設計にし、`handleJobStatus` 内でPDFジョブか否かを別経路（例えばjobId生成時にR2へ軽量メタを書く、または `input/` プレフィックスの存在チェックをPDFジョブ判定に流用）で判定する設計が必要。**この論点は実装開始前に確定させること**（仕様書は触れていないギャップ）。

`sanitizeTitle`/`decodeTitleHeader`/`xtcContentDisposition`（`src/jobs.ts`）はソース非依存の純関数なのでそのまま再利用可能。

### 1.7 wrangler.jsonc の該当設定

- Workflow binding: `workflows[0] = {name:"xtc-convert", binding:"CONVERT_WORKFLOW", class_name:"ConvertWorkflow"}` — PDF分岐は同じWorkflowクラス内に追加するので**新しいWorkflow定義は不要**。
- Container設定: `containers[0] = {class_name:"XtcConverterContainer", image:"./converter/Dockerfile", max_instances:4, instance_type:"basic"}`。`instance_type: "basic"`（1GiB）は既にPyMuPDFラスタライズを前提にした設定（コメント参照）。PDFアップロード機能追加でも変更不要な可能性が高いが、大きいPDFのチャンク処理で追加メモリが必要ならここを見直す。
- **R2 lifecycle は wrangler.jsonc に存在しない**（§0参照）。CLIコマンドでの追加が必須（§4.3）。
- `assets.run_worker_first` に `/jobs/*` が既に含まれる（137-155行目）ため、`/jobs/pdf` は追加設定なしでWorkerに届く。

### 1.8 既存テスト構成

- ランナー: Vitest（`vitest.config.ts` = `{test:{include:["test/**/*.test.ts"]}}`）。実行: `npm test`（= `vitest run`）。
- `test/jobs.test.ts` は `mapInstanceStatus`/`intermediatePdfKey`/`outputXtcKey`等の純関数を直接テスト（Workers runtimeなし、プレーンvitest）。新設する `resolveSource`/`pdfOptions` バリデーション関数も同じ形式で `test/pdf-upload.test.ts`・`test/pdf-options.test.ts` に置く（仕様書 §15 のファイル構成案どおりでよい）。
- `test/router.test.ts` は `Router` クラス単体のテスト（`env = {} as Env` で bindings 未使用のハンドラのみテスト）。
- Python: `npm run test:converter` = `python3 -m pytest test/converter/`。既存 `test/converter/test_app.py` は `sys.path.insert(...)` で `converter/` を直接 import し、`subprocess.run` を `mock.patch` して xtctool 呼び出しをモックしている（実xtctoolは一切実行しない）。新規 `test/converter/test_pdf_upload.py` も同じパターンを踏襲すべき。

---

## 2. Container (Python) 調査結果

### 2.1 converter/app.py のHTTPサーバ実装方式

- **フレームワークなし**。標準ライブラリの `http.server.BaseHTTPRequestHandler` + `ThreadingHTTPServer`（`converter/app.py` 336-474行目）。
- 既存 `/convert` の処理フロー（`_handle_post`, 372-441行目）:
  1. `Content-Length` ヘッダーの存在・正整数チェック（欠落/0以下→400、close）
  2. `effective_max_pdf_bytes(headers)` でサイズ上限確認（超過→413、close。**bodyを読まない**ので接続を切る）
  3. `X-Convert-Timeout-Seconds` ヘッダーから `timeout_seconds` を決定（Workerが計算した値。上限は `CONVERT_TIMEOUT_SECONDS`）
  4. **`self.rfile.read(content_length)` で全量メモリに読み込む**（仕様書§11.3が要求する「一時ファイルへの分割書き込み」は現状**していない** — これはWorkerが生成した信頼済みPDFだけを扱う前提だから許容されている設計）
  5. `CONVERSION_SLOTS`（`threading.Semaphore(MAX_CONCURRENT_CONVERSIONS)`, 既定2）を取得してから `read_pdf_metadata()` → `convert_pdf()`
  6. 成功時 `_send_bytes(xtc_bytes, title)`（`X-Xtc-Title` ヘッダーにurlencodeしたtitle）

**重要**: 新設する `/convert/uploaded-pdf` は**信頼できない外部PDF**を扱うため、既存 `_handle_post` をそのまま再利用してはならない。仕様書§11.3が求める「一時ファイルへ分割書き込み（chunk_size=1MB）」「先頭1024バイトに`%PDF-`確認」「PyMuPDFでopen可能か確認」「暗号化拒否」「ページ数上限確認」を持つ**新しいハンドラ関数**を書く必要がある。`do_POST`/`_handle_post` のディスパッチに `self.path` で分岐を追加する形が既存コードと自然に整合する（`if self.path == "/convert": ... elif self.path == "/convert/uploaded-pdf": ...`）。

### 2.2 xtctool呼び出し・config TOML生成

`_run_xtctool(sources, out_path, config_path, timeout_seconds, total_timeout_seconds, stage)`（197-239行目）:
```python
command = ["xtctool", "convert", *sources, "-o", str(out_path), "-c", config_path]
result = subprocess.run(command, capture_output=True, text=True, timeout=timeout_seconds, check=False)
```
- `sources` はファイルパスの配列。ページ範囲指定は `f"{pdf_path}:{start}-{end}"` という **xtctool独自のコロン構文**（308行目）で渡す。既存の「チャンク分割変換」がまさにこれを使っている。
- `config_with_title(title)`（182-194行目）は `tomllib.load()` でベースconfigを読み込み `config.setdefault("output",{})["title"] = title` した上でTOMLテキストへ再構成する。仕様書§11.10で言う「threshold/invert/dither/dither_strengthの上書き」も**同じ関数パターンを拡張**すればよい（`config[table][key] = value` の shallow merge — `[xtg]` テーブルへのマージロジックを `config_with_title` に相当する新関数 `config_with_pdf_options(title, options)` として追加するのが自然）。
- `converter/config-x3.toml` の内容（実物）:
```toml
[output]
width = 528
height = 792
format = "xtg"          # 1-bit固定。xthは使えない(crosspoint firmwareの制約、コメント参照)
resample_method = "BOX"
title = ""
author = ""
publisher = ""
language = "ja-JP"
direction = "ltr"

[pdf]
resolution = 200        # 仕様書のPDF_RENDER_DPI=200と既に一致

[xth]                    # xtg専用運用なので未使用だが定義は残っている
threshold1 = 85
threshold2 = 170
threshold3 = 255
invert = false
dither = true
dither_strength = 0.8

[xtg]
threshold = 128          # 仕様書のDEFAULT_PDF_OPTIONS.thresholdと一致
invert = false
dither = true
dither_strength = 0.8    # 仕様書のditherStrengthデフォルトと一致
```
**xtctool自体がPDF→XTC変換・ページ選択・DPI・二値化・ディザリングを内蔵している**ことに注意。仕様書§11.5〜11.8（回転・クロップ・contain/cover・528×792配置をPillowで行う）は、**xtctoolの標準PDF変換パスをバイパスして「事前にPillowでページ画像を作り、それをxtctoolへ渡す」という設計**を意味する。すなわち新規 `pdf_upload.py` は PyMuPDF でページをラスタライズ（回転・クロップ・contain/cover・528×792配置・グレースケール化はPillowで自前実装）→ PNG保存 → `xtctool convert page*.png -c config.toml` という、既存の「xtctoolに直接PDFを渡す」フローとは別のコードパスになる。既存 `_run_xtctool` 関数自体（PNG群を`sources`として渡す）は流用できるが、**ページ画像生成ロジックは全て新規実装**が必要。

### 2.3 PyMuPDF / Pillow の可用性

`converter/requirements.lock` に両方とも**既に固定バージョンで含まれている**（xtctoolの依存関係として transitively pulled）:
```
pillow==12.3.0
pymupdf==1.28.0
```
`converter/app.py` は既に `import pymupdf`（30-33行目, try/exceptでoptional化）してPDFタイトル・ページ数取得に使っている。**Dockerfile変更は不要**（新規pip installなし）。`pdf_upload.py` は `import pymupdf` と `from PIL import Image` をそのまま使える。

### 2.4 Pythonテストの有無と実行方法

- `test/converter/test_app.py`（685行超、`TestConvertPdf`/`TestChunkedConversion`/`TestPositiveEnvInt`/`TestTitleHandling`/`TestEffectiveMaxPdfBytes`/`TestHttpServer`/`TestGracefulShutdown` の7クラス）。
- 実行: `python3 -m pytest test/converter/`（`package.json` の `npm run test:converter` と同義）。
- モック方針: `subprocess.run` を `mock.patch("app.subprocess.run", side_effect=run_success)` のように差し替え、実xtctoolは呼ばない。新規 `test_pdf_upload.py` も同じ mock パターンを踏襲すべき（仕様書§15が挙げる `test/converter/fixtures/*.pdf`（text-a4/landscape/grayscale/encrypted/malformed）は実PDFバイナリなので**新規に作成が必要** — リポジトリに現存しない）。

---

## 3. フロントエンド（Svelte）調査結果

### 3.1 現状構造

`frontend/src/components/ConvertForm.svelte`（全64行）は**URL入力とAozoraボタンのみ**。ファイルドロップ・ファイル選択は一切実装されていない（参考UIindex.htmlのような `mode-url`/`mode-file` 切り替えは存在しない）。

```svelte
<script lang="ts">
  import { aozora } from "../lib/aozora.svelte";
  import { submitUrl, submitting } from "../lib/convert.svelte";
  import { t } from "../lib/i18n.svelte";
  let url = $state("");
  function onsubmit(event: SubmitEvent) { event.preventDefault(); void submitUrl(url); }
</script>
<section class="convert">
  <p class="intro">{t("intro")}</p>
  <form {onsubmit}>
    <div class="form-note">...利用規約...</div>
    <div class="input-row">
      <input type="url" bind:value={url} required placeholder="https://example.com/article" .../>
      <button class="primary" type="submit" disabled={submitting.busy}>{t("convert")}</button>
    </div>
  </form>
  <div class="aozora-open-row">
    <button type="button" class="secondary" onclick={() => aozora.show()}>{t("aozora_open")}</button>
  </div>
</section>
```
仕様書§7.2の「一体型入力エリア（URL欄＋ドロップゾーン＋ファイル選択＋青空文庫ボタン）」へ改修する際は、この `<section class="convert">` を土台に、`mode-url`/`mode-file` 相当の条件表示ブロックを追加する形になる。CSS変数（`--ink`, `--card`, `--muted` 等）は `app.css`（後述）と完全共有できる。

### 3.2 convert.svelte.ts のジョブ投入・ポーリング

`frontend/src/lib/convert.svelte.ts`（全259行）の要点:
- `submitUrl(rawUrl, displayTitle?)`: `fetch("/jobs", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({url, mode:"extract"})})`。**フロントは常に `mode:"extract"` を送る**（`full` はAPI直叩き専用、コメントに明記）。
- `JobsPostResponse { jobId?: string; error?: string }` — **エラーは平文字列**。新設 `submitPdf` も同じ形式を期待するレスポンスにするか、`ApiError` 形式にするかは要判断（§0参照。仕様書はJSON形式を明示していないので実装側の裁量）。
- ポーリングは `pollers: Map<string, Poller>` でjobIdごとに並行管理。`Poller {job, failures, poll404s, timer}`。`isStale(p)` で「差し替えられた古いループ」を自己終了させる設計。`beginPoll(job)` で新規開始・既存タイマークリア。
- `current`（`CurrentView` インスタンス、`entries: CurrentEntry[]`）が画面上部の「進行中+直近の完了/失敗」表示を担当。`MAX_CURRENT = 10`（in-flightは間引き対象外）。
- `sessionJobIds: Set<string>` — このセッションで投入したジョブだけが完了時に自動的にライブラリへ保存される（`maybeAutoSave`）。PDFジョブもこの経路に自然に乗る（`submitPdf` も投入時に `sessionJobIds.add(job.jobId)` すればよい）。
- **アップロード進捗の仕組みは何もない**（fetchのみ。XHRは未使用）。仕様書§7.9が要求する `XMLHttpRequest` ベースの進捗表示は完全新規実装。`submitting.busy` という単純なboolean状態はあるが、これは進捗%を持たない。新設が必要な状態: `uploading` フェーズ・進捗%・abort機構。

### 3.3 jobs.svelte.ts（履歴管理）の現行モデル

`frontend/src/lib/jobs.svelte.ts`:
```ts
export interface JobEntry {
  jobId: string;
  url: string;       // 必須。仕様書のJobEntryはurl?を想定 — ここも要変更
  status: string;
  createdAt?: string;
  title?: string;
  error?: string;
}
const STORE_KEY = "xtc-jobs";
const MAX_ENTRIES = 50;   // 仕様書§7.10の50件と一致
export const IN_FLIGHT = ["queued", "rendering", "converting"];
```
- `localStorage` キー: `"xtc-jobs"`。`loadFromStorage()` は `jobId`/`url`/`status` が string であることだけを検証してフィルタ（**`url` が無いエントリは黙って捨てられる** — `JobSourceType`/`sourceLabel` 追加時、`url` を optional にした上でこのバリデーションを緩め、`migrateJobEntry` 相当のマイグレーション処理を追加する必要がある。仕様書§7.10の設計どおりでよいが、既存 `loadFromStorage` のフィルタ条件を壊さないよう気をつける）。
- マルチタブ整合性: `commit()` の直前に必ず `loadFromStorage()` で再読込してから書く設計（他タブの変更を上書きしないため）。新規実装でも同じパターンを踏襲すること。
- `window.addEventListener("storage", ...)` で他タブの変更をリアルタイム反映。
- `IN_FLIGHT` 配列に PDFジョブ固有のステータス（`uploading`はクライアントローカル状態なのでサーバーpollingには乗らない点に注意。仕様書§14.1どおり）。

### 3.4 i18n の仕組み

`frontend/src/lib/i18n.svelte.ts`（全444行）:
- `Messages` インターフェース + `I18N: Record<Lang, Messages>`（`ja`/`en`）ですべての文言を型安全に管理。追加する文言は `Messages` インターフェースにキーを足し、`I18N.ja`/`I18N.en` 両方に値を追加するだけ（他ページ（`about.html`静的ページ）とは `LANG_KEY = "xtc-lang"` の localStorage キーだけ共有）。
- `t<K extends keyof Messages>(key: K): Messages[K]` で参照。関数型メッセージ（`(n:number)=>string` 等）も型で保証される。
- `JobStatus` 型は `"queued"|"rendering"|"converting"|"completed"|"failed"|"expired"` の6値固定。PDFジョブは `rendering` を使わない設計（§1.6参照）なので、`status` オブジェクトのキー自体は変更不要（未使用になるだけ）。
- `serverErrorText(err: string)` はサーバーの英語エラー文字列を正規表現でi18nキーへ写像するパターン（`pdf_too_large`の例）。PDFアップロードのサーバーエラー文言（仕様書§14.2の「PDFファイルを選択してください。」等）も**サーバー側は英語固定文字列を返し、フロントでこのパターンにマッチさせてi18n化**するのが既存踏襲。

### 3.5 ビルド設定（pdfjs-dist同梱の観点）

`frontend/vite.config.ts`:
```ts
const WORKER_PATHS = ["/convert", "/jobs", "/download", "/version.json", "/api"];
export default defineConfig({
  plugins: [svelte(), aboutRewrite],
  server: { proxy: Object.fromEntries(WORKER_PATHS.map((p) => [p, "http://localhost:8787"])) },
});
```
- **プラグイン追加なし**（`@sveltejs/vite-plugin-svelte` のみ）。`pdfjs-dist` の Worker 同梱は Vite 標準の `new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), {type:"module"})` パターンで解決できる可能性が高い（Vite7 は `?worker` インポートもサポート）が、pdfjs-dist の配布形態（ESM/legacy）とVite7の互換性は未検証。**Phase 0相当の検証が必要**（仕様書§19-8「PDF.js Workerの配布方法」が未確定事項として明記されている通り）。
- `frontend/package.json` に `pdfjs-dist` 依存は未追加。追加時は `frontend/package-lock.json` を都度更新すること（`npm ci --prefix frontend` がCIで走る前提、`scripts/deploy.sh` 参照）。
- devDependencies に `svelte-check`（型チェック用, `npm run check --prefix frontend`）はあるが、**フロントエンドの自動テストは存在しない**（vitest/playwright等の設定なし）。仕様書§16.3/16.4のフロントエンドテスト・E2Eテストは**フレームワークからのセットアップが必要**。

### 3.6 既存のCSS変数・デザイントークン

`frontend/src/app.css`（全体）— 参考UI (`/Users/haruki/Downloads/index.html`) の `:root` とほぼ同一（`--faint`が同名、参考UIにある `--panel`/`--muted2`/`--line2`/`--disabled` は現行app.cssに**一部欠落**）:

現行 `app.css`:
```css
:root {
  --bg: #f4f1ea; --card: #fdfcf9; --panel: #ece8dd; --text: #1c1a17;
  --muted: #8a857b; --muted2: #6b665c; --faint: #a39d90; --disabled: #c4beb0;
  --line: #ddd6c8; --ink: #1c1a17; --ink-text: #f4f1ea; --error: #8a3d33;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
```
（`--line2`/`--panel`は既に定義済み。参考UIとほぼ一致 — 新規PDF UIコンポーネントは既存変数だけで組める。）

- `.badge`/`.spinner`/`.error-text` は `app.css` の共通クラス（`CurrentJob.svelte`/`PreviewDialog.svelte`等で共用）。新規PDFステータス表示もこのクラスをそのまま使う。
- `dialog.simple-dialog` 系クラスは新規ダイアログ（PairingApprovalDialog等）用の共通土台。PDF編集パネルをダイアログではなくインラインパネルにするなら流用不要。

### 3.7 フロントエンドのテスト有無と実行コマンド

`npm run check --prefix frontend`（`svelte-check`、型チェックのみ）。**単体テスト・E2Eテストのランナーは未設定**。仕様書§16.3/16.4を満たすには Vitest（+ `@testing-library/svelte` 等）または Playwright を新規導入する必要がある。

---

## 4. 参考UI (index.html) の抜粋と統合方針

### 4.1 概要

`/Users/haruki/Downloads/index.html`（全1153行、単一HTMLファイル、フレームワークなしvanilla JS）は、PDF/EPUB/TXTの3種ファイル入力＋URL入力を統合したモックアップ。**このリポジトリの実装物ではない**（`fetch("/jobs", {method:"POST", body: fd})` でFormData送信するなど、現行Worker実装（JSON body限定の`/jobs`）とも仕様書（`POST /jobs/pdf` に raw bytes + ヘッダー）とも異なるAPI呼び出しをしている）。**デザイン言語（CSS変数・クラス命名規則・コンポーネント構造の発想）の参照専用**として扱うこと。データモデル・API呼び出し・オプション項目は仕様書 (`PdfConvertOptions`) を正とする。

### 4.2 ドロップゾーン（URL入力と統合された `.zone`）

```html
<div id="zone" class="zone">
  <div id="mode-url">
    <form id="form">
      <div class="input-row">
        <input id="url" type="url" required placeholder="https://example.com/article" ...>
        <button id="submit" class="primary" type="submit">変換</button>
      </div>
    </form>
    <div class="zone-hint">または PDF / EPUB / TXT をここにドラッグ＆ドロップ ／
      <button class="linkish" id="pick-file" type="button">ファイルを選択</button></div>
    <div class="zone-aozora"><button id="aozora-open" class="secondary" type="button">青空文庫から選択</button></div>
    <input id="file-input" type="file" accept=".pdf,.epub,.txt,application/pdf,application/epub+zip,text/plain" hidden>
  </div>
  <div id="mode-file" hidden> <!-- ファイル選択後の表示 --> ... </div>
</div>
```
```css
.zone { border: 1.5px dashed var(--muted); border-radius: 4px; background: var(--card); padding: 28px 24px; text-align: center; }
.zone.drag { background: var(--panel); border-color: var(--ink); }
```
ドラッグ&ドロップの実装（JS側、838-849行目）:
```js
["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("drag"); }));
zone.addEventListener("drop", (e) => { const file = e.dataTransfer?.files?.[0]; if (file) setFile(file); });
```

### 4.3 ファイル選択後の添付表示（`.att-row`）

```html
<div class="att-row">
  <span class="att-badge" id="att-badge">EPUB</span>
  <div class="att-info">
    <div class="att-name" id="att-name"></div>
    <div class="att-meta" id="att-meta"></div>
  </div>
  <button class="att-x" id="att-x" type="button" aria-label="remove">×</button>
</div>
```
```css
.att-row { display: flex; align-items: center; gap: 12px; border: 1px solid var(--line2); border-radius: 4px; background: #fff; padding: 12px 16px; }
.att-badge { flex: none; font-family: var(--mono); font-size: 12px; font-weight: 600; padding: 3px 8px; background: var(--panel); color: #4d4a42; border-radius: 4px; }
.att-name { font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att-meta { font-family: var(--mono); font-size: 12px; color: var(--faint); }
```
仕様書§7.2の「ファイル: example.pdf / サイズ: 12.4 MB / ページ数: 120」相当。ページ数は参考UIの`.att-meta`には含まれない（参考UIはEPUB/TXTも扱う汎用設計のため）ので、PDF専用パネルではこの構造を拡張してページ数行を追加する。

### 4.4 PDFプレビュー（`.pv-wrap` / ページャ / モード切替）

```html
<div class="pv-wrap" id="pdf-preview" hidden>
  <div class="pv-label">表示プレビュー</div>
  <div class="pv-page"> ... </div>
  <div class="pv-pager">
    <button id="pdf-prev" type="button" disabled>‹</button>
    <span class="pv-count"><span id="pdf-pageno">1</span> / <span id="pdf-pagecount">—</span></span>
    <button id="pdf-next" type="button" disabled>›</button>
  </div>
  <div class="pv-modes">
    <div class="seg" id="pdf-mode">
      <button type="button" data-val="src">元PDF</button>
      <button type="button" data-val="x3" aria-pressed="true">X3プレビュー</button>
      <button type="button" data-val="diff">比較</button>
    </div>
  </div>
</div>
```
```css
.pv-page { display:inline-block; width:176px; height:264px; background:#fff; border:1.5px solid var(--ink);
  border-radius:4px; box-shadow:3px 3px 0 var(--line); padding:16px 14px; overflow:hidden; }
.pv-pager { margin-top:12px; display:flex; align-items:center; justify-content:center; gap:14px; }
.seg { display: inline-flex; border: 1px solid var(--line2); border-radius: 4px; overflow: hidden; }
.seg button[aria-pressed="true"] { background: var(--ink); color: var(--ink-text); font-weight: 700; }
```
`.pv-page` の `176:264` 比率（= 528:792 と同一比率、幅の縮小表示）はそのまま使える。**注意**: 参考UIは「元PDF/X3プレビュー/比較」の3モードだが、仕様書§7.7は「初期リリースでは左右比較表示を必須としない」としているので、MVPでは`元PDF`/`X3プレビュー`の2モードのみでよい。

### 4.5 PDF詳細設定アコーディオン（`#pdf-acc`）

```html
<div class="acc" id="pdf-acc" data-open="false" hidden>
  <button class="acc-head" type="button" id="pdf-acc-head" aria-expanded="false">
    <span class="acc-title"><span id="pdf-acc-arrow">▸</span> 詳細設定</span>
    <span class="acc-summary" id="pdf-summary"></span>
  </button>
  <div class="acc-body">
    <div class="opt-grid">
      <div class="full pdf-note">PDF はページレイアウトが確定しているため、フォント・文字サイズ・組方向・行間は変更できません。</div>
      <div class="full">
        <div class="opt-label">余白</div>
        <div class="seg" id="pdf-margin">
          <button data-val="fit" aria-pressed="true">全体を収める</button>
          <button data-val="width">横幅に合わせる</button>
        </div>
      </div>
      <div>
        <div class="opt-label">クロップ（mm）</div>
        <div class="crop-grid">
          <span></span><input id="crop-top" type="number" value="0" min="0"><span></span>
          <input id="crop-left" type="number" value="0" min="0"><span class="crop-center"></span><input id="crop-right" type="number" value="0" min="0">
          <span></span><input id="crop-bottom" type="number" value="0" min="0"><span></span>
        </div>
      </div>
      <div>
        <div class="opt-label">拡大縮小</div>
        <select class="opt-select" id="pdf-scale"> <option value="75">75%</option> ... </select>
      </div>
      <div>
        <div class="opt-label">二値化しきい値</div>
        <div class="th-row">
          <input id="pdf-threshold" type="range" min="0" max="255" value="128">
          <span class="th-val" id="pdf-threshold-val">128</span>
        </div>
      </div>
      <div>
        <div class="opt-label">ディザリング</div>
        <div class="seg" id="pdf-dither"><button data-val="on" aria-pressed="true">あり</button><button data-val="off">なし</button></div>
      </div>
      <div>
        <div class="opt-label">ページ範囲</div>
        <div class="pages-row">
          <input id="pdf-page-from" type="number" value="1" min="1"><span class="pages-sep">–</span>
          <input id="pdf-page-to" type="number" placeholder="最終" min="1">
        </div>
      </div>
      <div>
        <div class="opt-label">白黒反転</div>
        <div class="seg" id="pdf-invert"><button data-val="off" aria-pressed="true">しない</button><button data-val="on">する</button></div>
      </div>
    </div>
  </div>
</div>
```
```css
.acc { margin-top: 14px; border: 1px solid var(--line); border-radius: 4px; background: var(--card); }
.acc-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; cursor: pointer; }
.acc[data-open="false"] .acc-body { display: none; }
.opt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 20px; }
.crop-grid { display: grid; grid-template-columns: 52px 52px 52px; gap: 6px; }
.th-row { display: flex; align-items: center; gap: 10px; }
.th-row input[type="range"] { flex: 1; accent-color: var(--ink); }
```

**重要な差分（仕様書 vs 参考UI、実装は仕様書優先）**:

| 項目 | 参考UI (index.html) | 仕様書 `PdfConvertOptions` | 実装方針 |
|---|---|---|---|
| クロップ単位 | mm、絶対値の4入力欄 | 回転後ページに対する比率 0.0〜0.4 | 仕様書どおり比率。UI表示はスライダーか%入力に置き換える |
| 余白/収め方 | `margin: "fit"｜"width"`（1軸） | `fit: "contain"｜"cover"` + `marginPx: number`（2軸独立） | 仕様書どおり2つのコントロールに分離（参考UIの`.seg`パターンはfit用に流用、marginPxは別途pxのnumber inputかselect） |
| ページ範囲 | `pageFrom`/`pageTo` の2 number input | `pages: string`（`"1-10,15"`のような構文） | UIはfrom/to方式のまま裏でstring構文へ変換してもよいし、仕様書の自由記述構文をそのまま1つのtext inputにしてもよい（バリデーションは§5.3/5.4のパーサ関数に必ず通す） |
| 拡大縮小 | `pdf-scale` select (75-150%) | 存在しない（`fit`/`marginPx`で代替） | 仕様書に無い機能なのでMVPでは実装しない（`opt-grid`から`pdf-scale`ブロックを削除） |
| ディザリング強度 | 存在しない | `ditherStrength: number (0.0-1.0)` | 参考UIの`th-row`（range + 数値表示）パターンをそのまま流用してスライダーを追加 |

### 4.6 統合提案

1. `ConvertForm.svelte` を土台に、参考UIの `.zone`/`.att-row`/`drag`クラスの発想を移植した新規 `PdfDropZone.svelte`（仕様書§15のファイル構成案どおり）を作る。CSS変数は共有できるのでゼロから配色を作る必要はない。
2. `.acc`（アコーディオン）パターンは既存フロントに類似実装が無いため新規コンポーネント化する（`accInit`のトグルJSは単純な `$state<boolean>` + `onclick` に素直に書き直せる）。
3. `.seg`（segmented control、`aria-pressed`でトグル表示）は fit・dither・invertの3箇所で使うので、共通の小コンポーネント化（例: `SegmentedControl.svelte`）を検討する価値がある。
4. `.pv-page`（176×264、528:792比率）＋ `.pv-pager` はそのまま `PdfPreview.svelte` の外枠として使える。
5. 参考UIの文言（「表示プレビューは変換結果の目安です」的な注記文言は無いが、仕様書§4.3の注記文言をこの位置に追加する）。

---

## 5. ギャップ分析（実装前に必ず確認すること）

### 5.1 ファイル構成案の差異

仕様書§15のファイル構成案は概ねそのまま新規追加できるが、以下は確認が必要:
- `src/pdf-upload.ts`（新規） — 依存する `src/jobs.ts` の関数（`sanitizeTitle`, `outputXtcKey`など）は既存のものを再利用する。
- `converter/pdf_upload.py`（新規） — `converter/app.py` の `_run_xtctool`/`config_with_title`/`read_pdf_metadata` 等のヘルパーは import して再利用できるよう `app.py` からの切り出し、または `pdf_upload.py` からの `import app` が必要（循環import に注意 — `app.py` が `pdf_upload.py` のハンドラを呼ぶ構造なら `pdf_upload.py` → `app` の一方向 import にする）。
- `frontend/src/lib/pdf-dither.worker.ts`（新規Web Worker） — Vite7でのWorkerバンドル方法を事前検証すること（`import Worker from "./x.worker.ts?worker"` 構文が Svelte5 + Vite7 でどう解決されるか未確認）。
- `test/converter/fixtures/*.pdf`（新規テストPDF群） — リポジトリに現存しないため一から作成が必要。

### 5.2 R2キー命名の確定が必須

§0/§1.3で述べた通り、`input/`/`output/` (仕様書) と `intermediate/`/`jobs/` (実コード) が食い違う。**実装開始前に以下を決定すること**:
- 入力PDF: 新規 `input/{jobId}/source.pdf` プレフィックスを採用するか、既存 `intermediate/` を流用するか。
- 出力XTC: 既存 `outputXtcKey(jobId)` = `jobs/{jobId}/output.xtc` をそのまま使う（URL変換ジョブと同じ命名にできる — ダウンロード/ステータスAPIの共通化に有利）。

### 5.3 R2 lifecycle はコードでは設定できない

`claudedocs/deploy-guide.md`・`claudedocs/phase2-findings.md` に明記の通り、R2 lifecycle は `wrangler.jsonc` に書けない。既存ルールは:
```
npx wrangler r2 bucket lifecycle add xteink-conversions expire-intermediate-pdf intermediate/ --expire-days 1
npx wrangler r2 bucket lifecycle add xteink-conversions expire-job-outputs jobs/ --expire-days 1
```
新規プレフィックス（例: `input/`）を採用する場合、デプロイ手順に以下を追加する必要がある（`scripts/deploy.sh` には組み込まれていない=**手動の一度きりの作業**）:
```
npx wrangler r2 bucket lifecycle add xteink-conversions expire-input-pdf input/ --expire-days 1
```
これを忘れると「入力PDFを24時間以内に削除する」という受け入れ条件（仕様書§17.2）が担保されない（Workflow側の明示削除がベースラインなので即座に壊れるわけではないが、削除失敗時の保険が効かない）。

### 5.4 エラーレスポンス形式の不一致

- レガシー `/convert`・`/jobs`: `{"error": "<string>"}`。
- 新方式ルート（`src/router.ts` 経由）: `{"error": {"code": "...", "message": "..."}}`（`src/security/errors.ts`）。
- `frontend/src/lib/convert.svelte.ts` の `JobsPostResponse { error?: string }` は**前者を前提**にパースしている。
`POST /jobs/pdf` をレガシー`route()`に置くなら文字列形式で統一し、フロントの`submitPdf`もそれに合わせる。新方式`Router`に置くなら`{code,message}`形式になり、`frontend/src/lib/api.ts`の`apiSend`/`ApiError`パターン（`code`を見て文言をi18nに写像する設計、`parseError()`参照）を使う方が自然。**どちらかに統一すること**（仕様書は形式を明示していないので実装側で決める）。

### 5.5 ジョブステータスモデルの罠

- `mapInstanceStatus()` の `rendering`/`converting` 判定は「R2上に中間PDFがあるか」で行っている（Browser Run経由のURL変換専用ロジック）。PDFアップロードジョブには「rendering」フェーズが概念上存在しない。既存関数にPDFジョブを素通しすると、**入力PDFがR2にある間ずっと `converting` ではなく誤って `rendering` と判定される**おそれがある（`hasIntermediatePdf`のR2キーを`intermediatePdfKey(jobId)`固定で見ているため、入力PDFを別プレフィックス`input/`に置けば偶然一致はしないが、「rendering」表示自体が出ない=`hasIntermediatePdf`は常にfalseになり、PDFジョブは実行中ずっと`rendering`と誤表示される）。`handleJobStatus`にPDF/URL分岐を追加すること。判定材料としてWorkflow paramsを読む手段が無い点が設計上のネックなので、§1.6の通り実装方針を先に固める。

### 5.6 Container `/convert` を絶対に流用しない

`converter/app.py`の既存`/convert`は「Workerが生成した信頼済みPDF」専用で、`self.rfile.read(content_length)`による全量メモリ読込・PyMuPDFでの一括openを前提にしている。外部PDFをこの経路に流すと、仕様書§12のセキュリティ要件（暗号化PDF拒否・一時ファイル分割書き込み・ページ数上限など）が一切効かない。**新設`/convert/uploaded-pdf`は完全に別のハンドラ関数として実装すること**（§2.1参照）。

### 5.7 型の後方互換

- `ConvertJobParams.url: string`（必須） → `url?: string` に緩めても既存Workflow instanceのparamsには影響しない（型はTypeScript側だけの静的チェック、永続化データの形は変わらない）。
- `JobEntry.url: string`（`frontend/src/lib/jobs.svelte.ts`、必須） → `url?: string` + `sourceType`/`sourceLabel` を追加する際、`loadFromStorage()`のバリデーション（29-31行目、`typeof j.url === "string"`を必須としている）を緩めないと、**追加後の初回ロードで旧形式のURLジョブは通るがPDFジョブ（urlフィールド無し）は不正エントリとして黙って消される**。マイグレーション関数だけでなく、この既存バリデーション自体の修正が必須。

### 5.8 ビルド・デプロイ手順

- `package.json` scripts: `dev`（`wrangler dev`）, `dev:frontend`（`vite`）, `build:frontend`（`vite build --prefix frontend`）, `check:frontend`（`svelte-check`）, `deploy`（`bash scripts/deploy.sh`）, `typecheck`（`tsc --noEmit`）, `test`（`vitest run`）, `test:converter`（`pytest test/converter/`）。
- `scripts/deploy.sh`: (1) working tree clean 確認 → (2) HEADがorigin/mainの祖先か確認 → (3) `npm ci --prefix frontend && npm run build --prefix frontend` → (4) `frontend/dist/version.json` 生成（AGPL対応の稼働バージョン表示用）→ (5) `npx wrangler deploy` → (6) `deploy-<UTC日時>-<short-hash>` タグ作成・push。**Docker daemon起動が必要**（Container imageのビルド&push）。
- `.claude/skills/deploy/SKILL.md` が存在する（このリポジトリの正式デプロイ手順書。deployを頼まれたら参照すること、とCLAUDE.mdにも記載あり）。
- R2 lifecycle設定はデプロイスクリプトに含まれない一度きりの手動CLI作業（§5.3）。

---

## 6. 実装時の追加確認事項（未解決の設計判断）

1. `/jobs/pdf` はレガシー`route()`（推奨・仕様書と整合）と新方式`Router`のどちらに置くか（§0, §5.4）。
2. PDFジョブの`rendering`/`converting`判定方法（§1.6, §5.5）。
3. R2キープレフィックス: `input/`新設 vs `intermediate/`流用（§1.3, §5.2）。
4. `MAX_PDF_BYTES`（既存, URL変換PDF用）と PDFアップロード上限を同じenv varで共有するか分離するか（§1.3）。
5. `pdfjs-dist` のVite7 Worker同梱方法の事前検証（§3.5, §5.1）。
6. エラーレスポンス形式の統一（§5.4）。

これらは仕様書§19「実装上の判断事項」には含まれない、**このコードベース固有の追加論点**であり、実装開始前にプロジェクトオーナーと確定させることを推奨する。
