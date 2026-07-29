# Phase 1 実装仕様書  
## html2xtc の既存端末連携を標準的な XTC 対応 OPDS 配信へ整理する

## 1. 目的

`html2xtc` が現在提供している端末別ライブラリ、OPDS カタログ、XTC ダウンロード機能を維持したまま、以下のクライアントから同じ OPDS カタログを利用できる状態にする。

- `aGFydWtp/crosspoint-jp`
- XTC/XTCH の OPDS 取得対応が入った本家 `crosspoint-reader/crosspoint-reader`
- 将来追加する一般的な OPDS クライアント

本フェーズでは、新しい端末登録方式は追加しない。既存のペアリングと端末別配信リストをそのまま利用し、OPDS のメディアタイプ、ダウンロード URL、UI 文言、テストを標準化する。

---

## 2. 現状

### html2xtc

現在、端末は以下の情報で認証される。

- `deviceId`
- `deviceToken`

端末は共通 URL に Basic 認証付きでアクセスする。

```text
GET /opds/v1/catalog.xml
Authorization: Basic base64(deviceId:deviceToken)
```

サーバーは、認証された端末に割り当てられている `device_library_items` のみを OPDS フィードへ掲載する。

現状の acquisition link は次の形になっている。

```xml
<link
  rel="http://opds-spec.org/acquisition"
  href="/api/device/library-items/{itemId}/download"
  type="application/octet-stream" />
```

XTC ダウンロードレスポンスも `Content-Type: application/octet-stream` を返している。

### crosspoint-jp

`crosspoint-jp` は以下をすでに実装している。

- `application/octet-stream` を XTC 候補として扱う
- `application/vnd.xteink.xtc` を XTC として扱う
- `Content-Disposition`、レスポンスの `Content-Type`、OPDS entry の `type`、URL 拡張子から保存形式を判定する
- XTC を `/XTCFiles` 配下へ保存する
- OPDS entry の ID を用いて再ダウンロード時の保存先を安定化する

### 本家 CrossPoint

本家の XTC/XTCH OPDS 対応では、以下の MIME タイプが想定されている。

- `application/vnd.xteink.xtc`
- `application/vnd.xteink.xtch`
- `application/x-xtc+zip`
- `application/x-xtch+zip`

`application/octet-stream` の場合は、URL 末尾の `.xtc` / `.xtch` / `.epub` による推定へフォールバックする。

現行 URL の `/download` には拡張子がないため、MIME タイプを具体化しない限り、本家 CrossPoint では認識されない可能性がある。

---

## 3. ゴール

実装完了後、OPDS entry は次の形で配信されること。

```xml
<link
  rel="http://opds-spec.org/acquisition"
  href="https://xtc.hr20k.com/api/device/library-items/{itemId}/download.xtc"
  type="application/vnd.xteink.xtc" />
```

ダウンロードレスポンスは次を返すこと。

```http
Content-Type: application/vnd.xteink.xtc
Content-Disposition: attachment; filename="...xtc"; filename*=UTF-8''...xtc
Content-Length: ...
ETag: "..."
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
```

既存の `/download` URL は後方互換のため残す。

---

## 4. 非ゴール

以下は本フェーズでは実装しない。

- 新しい端末登録 API
- 手動 OPDS 端末登録 UI
- 端末ごとの秘密 URL
- OPDS 2.0
- サーバーから端末への Push 配信
- 自動ダウンロード
- Range Request
- EPUB と XTC の同時配信
- XTCH 配信
- 既存のペアリング方式の廃止

---

## 5. ユーザーストーリー

### 5.1 既存の crosspoint-jp ユーザー

1. 端末を従来どおりペアリングする。
2. Web ライブラリでファイルを選択する。
3. 「端末に追加」を実行する。
4. 端末の「マイ XTC」を開く。
5. 割り当てたファイルが表示される。
6. XTC をダウンロードして開ける。

既存ユーザーは再ペアリングを要求されてはならない。

### 5.2 本家 CrossPoint ユーザー

本家 CrossPoint に手動で OPDS 接続情報を設定済みである場合、端末別 OPDS カタログから XTC を表示、ダウンロード、閲覧できる。

本フェーズでは、その接続情報を発行する WebUI は提供しない。

---

## 6. 機能要件

## 6.1 OPDS フィード

対象ファイル:

```text
html2xtc/src/opds/feed.ts
```

変更要件:

1. XTC acquisition link の `type` を以下へ変更する。

```text
application/vnd.xteink.xtc
```

2. acquisition link の `href` を以下へ変更する。

```text
/api/device/library-items/{itemId}/download.xtc
```

3. URL はフィードの origin と同一であること。
4. `rel` は現在と同じ acquisition relation を維持すること。
5. `id`、`title`、`author`、`updated` の生成規則は変更しないこと。
6. ページングと検索フィードの動作を変更しないこと。

期待する entry:

```xml
<entry>
  <id>urn:html2xtc:item:{itemId}</id>
  <title>{title}</title>
  <author><name>{author}</name></author>
  <updated>{updatedAt}</updated>
  <link
    rel="http://opds-spec.org/acquisition"
    href="https://xtc.hr20k.com/api/device/library-items/{itemId}/download.xtc"
    type="application/vnd.xteink.xtc" />
</entry>
```

---

## 6.2 XTC ダウンロードルート

対象ファイル:

```text
html2xtc/src/opds/routes.ts
```

追加する正式ルート:

```text
GET /api/device/library-items/:itemId/download.xtc
```

後方互換ルート:

```text
GET /api/device/library-items/:itemId/download
```

要件:

1. 両ルートは同じ認証、認可、監査、R2 取得処理を利用すること。
2. 実装を重複させず、共通ハンドラへ委譲すること。
3. 端末 Basic 認証を必須とすること。
4. 対象 item が当該端末へ割り当てられていない場合は、従来どおり `404 ITEM_NOT_FOUND` とすること。
5. R2 オブジェクトが存在しない場合も、情報を区別せず `404 ITEM_NOT_FOUND` とすること。
6. 成功時に `last_seen_at` を更新すること。
7. 成功時に既存の `device.download.completed` 監査イベントを記録すること。
8. `Content-Type` は次とすること。

```text
application/vnd.xteink.xtc
```

9. `Content-Disposition` は既存の `xtcContentDisposition()` を利用すること。
10. `ETag`、`Content-Length`、`Cache-Control`、`X-Content-Type-Options` を維持すること。
11. レスポンスボディは R2 からストリーミングすること。
12. XTC 全体を Worker メモリへ読み込まないこと。

推奨実装形:

```ts
async function handleDeviceXtcDownload(...) {
  // 認証
  // 端末別 item 認可
  // R2 get
  // last_seen / audit
  // Response
}

router.get("/api/device/library-items/:itemId/download.xtc", handleDeviceXtcDownload);
router.get("/api/device/library-items/:itemId/download", handleDeviceXtcDownload);
```

---

## 6.3 Web ライブラリの文言

対象候補:

```text
html2xtc/frontend/src/components/Library.svelte
html2xtc/frontend/src/components/DeviceLibraryEditor.svelte
html2xtc/frontend/src/lib/i18n.*
```

動作は変更しない。

日本語 UI では、Push 済みと誤解されにくい文言へ調整する。

推奨文言:

| 現行 | 変更後 |
|---|---|
| 端末に追加 | 端末の配信リストに追加 |
| 追加しました | 端末の配信リストに追加しました |
| 端末へ送信 | 端末で読めるようにする |

英語 UI がある場合の推奨:

| 現行候補 | 変更後 |
|---|---|
| Send to device | Add to device catalog |
| Added to device | Added to device catalog |

ボタンが長くなりすぎる場合は、ボタンを「端末に追加」のまま維持し、補足文で Pull 型であることを説明してもよい。

補足文:

```text
追加したファイルは端末の OPDS ライブラリに表示されます。端末側でダウンロードしてください。
```

---

## 6.4 crosspoint-jp の互換性

原則としてファームウェア変更は不要。

確認対象:

```text
crosspoint-jp/lib/OpdsParser/OpdsParser.cpp
crosspoint-jp/src/activities/browser/OpdsBookBrowserActivity.cpp
```

確認事項:

1. `application/vnd.xteink.xtc` を XTC として認識すること。
2. `download.xtc` URLを正しく取得できること。
3. `Content-Type: application/vnd.xteink.xtc` を認識すること。
4. `Content-Disposition` から `.xtc` ファイル名を生成できること。
5. 従来の `/download` URLでも引き続き取得できること。

必要であればテストのみ追加する。プロダクションコードの変更は、互換性問題が見つかった場合だけ行う。

---

## 7. API 互換性

### 維持する API

```text
GET /opds/v1/catalog.xml
GET /opds/v1/search.xml
GET /api/device/library-items/:itemId/download
```

### 追加する API

```text
GET /api/device/library-items/:itemId/download.xtc
```

### 変更するレスポンス

```diff
- Content-Type: application/octet-stream
+ Content-Type: application/vnd.xteink.xtc
```

クライアントが `Content-Disposition` のみを利用している場合も動作を維持すること。

---

## 8. セキュリティ要件

1. OPDS とダウンロードは HTTPS のみを前提とする。
2. `deviceToken` を URL、ログ、監査イベントへ含めない。
3. 認証失敗時のエラーは、端末不存在、token 不一致、revoked を区別しない。
4. 他端末へ割り当てられた item の存在を推測できない。
5. URL 末尾に `.xtc` を追加しても、静的ファイルとして扱わず必ず認証ルートを通す。
6. `X-Content-Type-Options: nosniff` を維持する。
7. 既存の認証失敗レート制限を維持する。

---

## 9. テスト要件

## 9.1 html2xtc 単体テスト

### OPDS feed

以下を検証する。

- `type="application/vnd.xteink.xtc"` が出力される
- `href` が `/download.xtc` で終わる
- XML エスケープが維持される
- author が null の場合に author 要素を省略する
- root feed と search feed の双方で同じ acquisition link を生成する
- ページング link に影響がない

### ダウンロード

以下を検証する。

- `/download.xtc` が成功する
- 旧 `/download` が成功する
- 両ルートのレスポンスボディが同一
- `Content-Type` が vendor MIME
- `Content-Disposition` が `.xtc`
- `ETag`、`Content-Length` が設定される
- 未認証は 401
- 他端末の item は 404
- revoked 端末は 401
- R2 オブジェクト欠落は 404
- 成功時に last seen と監査イベントが更新される

## 9.2 crosspoint-jp テスト

既存テスト基盤で可能な範囲で以下を追加する。

- vendor MIME の OPDS entry を BOOK として解析
- `.xtc` URL の acquisition link を解析
- vendor MIME のダウンロード形式判定
- `Content-Disposition` 優先順位
- octet-stream 旧形式の後方互換

## 9.3 実機確認

最低 1 台の Xteink X3 または X4 で確認する。

1. 既存端末で再ペアリングせずに「マイ XTC」を開ける。
2. 端末別ライブラリへ追加した XTC が表示される。
3. ダウンロードできる。
4. ダウンロード後に開ける。
5. 同じ item を再ダウンロードしても重複ファイルが増えない。
6. 旧 `/download` URLを直接使う既存ファームでも取得できる。

可能であれば、本家 CrossPoint の PR #2627 相当ビルドでも確認する。

---

## 10. 実装順序

1. `src/opds/feed.ts` の MIME と URL を変更する。
2. `src/opds/routes.ts` に `.xtc` ルートを追加し、共通ハンドラ化する。
3. ダウンロードレスポンスの Content-Type を変更する。
4. OPDS feed テストを更新する。
5. ダウンロードルートのテストを追加する。
6. UI 文言を調整する。
7. API/OPDS ドキュメントを更新する。
8. `crosspoint-jp` の自動テストを追加する。
9. ステージングへデプロイする。
10. crosspoint-jp 実機で確認する。
11. 本番へデプロイする。

---

## 11. 移行とロールバック

### 移行

DB マイグレーションは不要。

既存端末の以下は変更しない。

- `deviceId`
- `deviceToken`
- `device_library_items`
- OPDS catalog URL
- ペアリング情報

### ロールバック

問題発生時は、OPDS link を旧 `/download` と `application/octet-stream` に戻せる。

ただし、新しい `/download.xtc` ルートは互換性を損なわないため、ロールバック時も残してよい。

---

## 12. 受け入れ条件

以下をすべて満たしたら完了とする。

- [ ] OPDS feed が vendor MIME を返す
- [ ] OPDS acquisition URL が `.xtc` で終わる
- [ ] 新旧ダウンロード URL の双方が動作する
- [ ] XTC レスポンスが vendor MIME を返す
- [ ] 既存の crosspoint-jp 端末が再ペアリングなしで利用できる
- [ ] 本家 CrossPoint の XTC OPDS 対応実装で entry が表示される
- [ ] 本家 CrossPoint で XTC をダウンロードして開ける
- [ ] 他端末の item を取得できない
- [ ] 自動テストが通る
- [ ] API と OPDS ドキュメントが更新される
- [ ] UI が Push 配信と誤認させない

---

## 13. Definition of Done

- 実装コード
- 単体テスト
- 実機確認記録
- API ドキュメント更新
- OPDS プロファイル更新
- 変更理由を記載した ADR または設計メモ
- 後方互換ルートを削除しないことを明記したコメント
