# Phase 0 技術検証結果（実装の前提事実）

作成日: 2026-07-17。3 つの調査エージェントが公式 docs・npm 実パッケージ・xtctool 実ソース・実 Docker ビルドから確認した事実のまとめ。実装はこのファイルを正とする。

## Browser Run（旧 Browser Rendering）

出典: developers.cloudflare.com/browser-run/（quick-actions/pdf-endpoint, reference/wrangler, reference/supported-fonts, reference/timeouts, pricing）+ @cloudflare/workers-types@5.20260717.1 実物

- `env.BROWSER.quickAction("pdf", options)` は実在。戻り値 `Promise<Response>`（成功 200 / `Content-Type: application/pdf`、失敗 400/422/429/500/503 で JSON エラー、`X-Browser-Ms-Used` ヘッダあり）。
- **`compatibility_date` は `2026-03-24` 以降必須**（quickAction の要件）。
- wrangler 設定: `"browser": { "binding": "BROWSER", "remote": true }`。**`remote: true` がないと `wrangler dev` ローカルモードで quickAction が動かない**（`The RPC receiver does not implement the method "quickAction"` エラー）。
- オプション（すべて実在確認済み）:
  - `addStyleTag: Array<{ content?: string; url?: string }>`
  - `gotoOptions: { timeout (default 30000, max 60000), waitUntil: "load"|"domcontentloaded"(default)|"networkidle0"|"networkidle2", ... }`
  - `pdfOptions: { printBackground (default false), preferCSSPageSize (default false), displayHeaderFooter (default false), format, width, height, margin, scale, timeout (max 5分), ... }`
  - その他: `viewport` (default 1920x1080), `setExtraHTTPHeaders`, `cookies`, `authenticate`, `emulateMediaType`, `rejectResourceTypes`, `waitForSelector`, `bestAttempt`, **`cacheTTL`（default 5 秒。0 で無効）**
- **日本語フォントはプリインストール**: Noto CJK、IPAfont Gothic、Noto Color Emoji（reference/supported-fonts に明記）。Web フォント注入は不要。
- 型: `@cloudflare/workers-types` に `BrowserRun` / `BrowserRunPDFOptions` あり。`wrangler types` でも Env に `BrowserRun` 型で生成される。
- binding 経由なら API トークン不要。nodejs_compat は quickAction のみなら不要（docs の例に含まれない。明文記述なしの推論）。
- 料金（Workers Paid）: browser hours 10h/月込み、超過 $0.09/h。Quick Actions レート 10 req/s。

## Cloudflare Containers

出典: developers.cloudflare.com/containers/（get-started, container-class, scaling-and-routing, platform-details, limits, local-dev, image-management, pricing）+ cloudflare/containers GitHub README

- `@cloudflare/containers` npm パッケージの `Container` クラスを継承:
  ```ts
  export class XtcConverterContainer extends Container {
    defaultPort = 8080;
    sleepAfter = "2m";
  }
  ```
- `defaultPort` は「コンテナがそのポートで listen するまでリクエストをブロック」する（起動待ちは自動。手動の起動 API は `startAndWaitForPorts()`）。
- Worker からの呼び出し: `getContainer(env.XTC_CONVERTER, name).fetch(request)` または `env.XTC_CONVERTER.getByName(name)` → `stub.fetch(request)`。
- wrangler 設定（spec の形で正しい）: `containers` + `durable_objects.bindings` + `migrations`。**`new_sqlite_classes` 必須**（`new_classes` 不可）。
- `instance_type`: lite(1/16 vCPU, 256MiB, 2GB) / basic(1/4, 1GiB, 4GB) / standard-1(1/2, 4GiB, 8GB) …。**デフォルトは lite**。PyMuPDF のラスタライズには 256MiB は不足リスク → **basic を採用**。
- イメージ: **linux/amd64 必須**。`image` に Dockerfile パスを書くと `wrangler deploy` 時にローカル build → Cloudflare Registry へ自動 push（**deploy 時に Docker 起動が必要**）。
- **ローカル開発では Dockerfile に `EXPOSE 8080` 宣言が必須**（本番は不要だが書いておく）。
- リクエストサイズ: client→Worker はアカウントプラン依存（Free/Pro 100MB）。Worker→Container に別途上限の記載なし。レスポンスサイズ上限なし。
- コールドスタート 1〜3 秒程度。オートスケーリングは未提供。課金は起動〜sleep 間（scale-to-zero）なので `sleepAfter` は短め（2m）にする。
- 料金（Workers Paid $5/月必須）: Memory 25 GiB-h/月込み、CPU 375 vCPU-min/月込み、超過は従量。

## xtctool（実ソース確認 + Docker ビルド・変換検証済み）

出典: github.com/chazeon/xtctool 実ソース + linux/amd64 Docker ビルドと日本語 PDF 変換の実測

- CLI: `xtctool convert <sources...> -o <output> [-c <config>]`。convert のオプションは `-o` `-c` の 2 つのみ。
- 出力形式は**出力ファイルの拡張子で決定**: `.xtc`（マルチページコンテナ）/ `.xth` / `.xtg` / `.png` / `.pdf`（後者 2 つはデバッグ用逆変換）。`info` コマンドは無い。
- **Python 3.11+ 必須**（`import tomllib`）。python:3.12-slim で OK。
- **検証結果**: linux/amd64 ビルド成功（Apple Silicon エミュレーションで 39 秒、イメージ 687MB）。日本語 2 ページ PDF → XTC 変換 3.1 秒、逆変換 PNG で**日本語が正常描画（豆腐なし）**。XTC ヘッダに config のメタデータ（language="ja-JP" 等）が反映されることを確認。
- **Dockerfile の必須修正 2 点（ビルド検証で判明）**:
  1. 上流 packaging バグ: hatchling が `force-include` の重複で失敗 → `sed -i '/force-include/,+1d' pyproject.toml` を install 前に実行。
  2. `[performance]` extra だけでは CLI が起動しない（`assets/__init__.py` が無条件に jinja2 を import）→ **`[performance,markdown]` 両方必須**。
  - build-essential は不要（全依存に amd64 wheel あり）。git のみ必要。
- **確定版 Dockerfile ベース**（検証済み。実装時に app.py の COPY と CMD を追加すること）:
  ```dockerfile
  FROM python:3.12-slim
  RUN apt-get update \
      && apt-get install -y --no-install-recommends git \
      && rm -rf /var/lib/apt/lists/*
  # Upstream packaging bug: [tool.hatch.build.targets.wheel.force-include] duplicates
  # files already included via packages=["xtctool"]; newer hatchling rejects the dup.
  RUN git clone https://github.com/chazeon/xtctool.git /opt/xtctool \
      && sed -i '/force-include/,+1d' /opt/xtctool/pyproject.toml \
      && pip install --no-cache-dir "/opt/xtctool[performance,markdown]"
  # [markdown] is required in practice: assets/__init__.py unconditionally imports jinja2.
  ```
- 設定 TOML の実スキーマ（DEFAULT_CONFIG。ユーザー設定は shallow マージ、未知キーはエラーにならない）:
  ```toml
  [output]
  width = 528        # X3 ターゲット
  height = 792
  format = "xth"     # .xtc 出力時のコンテナ内フレーム形式（xth=4階調/xtg=2値）。省略時 xth
  resample_method = "LANCZOS"  # コードコメント: BOX はテキスト向き、LANCZOS は写真向き
  title = ""
  author = ""
  publisher = ""
  language = "ja-JP"
  direction = "ltr"  # ltr/rtl/ttb

  [pdf]
  resolution = 200   # デフォルトは 144

  [xth]
  threshold1 = 85
  threshold2 = 170
  threshold3 = 255
  invert = false
  dither = true
  dither_strength = 0.8

  [xtg]
  threshold = 128
  invert = false
  dither = true
  dither_strength = 0.8
  ```
  実測: この設定で 2 ページ XTC = 約 205KB（528×792×2bit/頁、無圧縮 4 階調）。
- 出力サイズ目安: **約 102KB/ページ**（xth 4 階調時）。50 ページの記事なら約 5MB。

## 実装への確定事項

1. wrangler.jsonc: `compatibility_date: "2026-03-24"` 以降（今日の日付でよい）、`browser: { binding, remote: true }`、containers は `instance_type: "basic"`。
2. Container 通信は `@cloudflare/containers` の `getContainer().fetch()`。PDF バイトを POST /convert で直送、XTC バイトをレスポンスで受領。
3. Dockerfile は上記の確定版ベース + `EXPOSE 8080` + app.py の COPY/CMD。
4. config-x3.toml は上記実スキーマ準拠。テキスト記事主体なので `resample_method = "BOX"` を既定にし、写真主体なら LANCZOS とコメントで案内。**（2026-07-17 実機検証で修正: `format` は必ず `"xtg"`。実機ファーム crosspoint-jp v0.1.7 の XtcParser は `.xtc` コンテナ（`XTC\0` マジック）を 1bit XTG フレーム決め打ちで解釈するため、XTH(4 階調) 入り .xtc はサイズに関係なく INVALID_MAGIC →「ページ読み込みエラー」になる。xtg 化は実機で表示確認済み。4 階調は `.xtch` コンテナが必要だが xtctool は未対応）**
5. X3_PRINT_CSS は spec のものをそのまま使用（日本語フォントは Noto CJK プリインストールのため追加読込不要）。
6. `pdfOptions.timeout` / `gotoOptions.timeout` を明示設定。`cacheTTL` は既定 5 秒のままでよい。
