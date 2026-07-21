# html2xtc OPDS プロファイル

CrossPoint (Xteink) 側実装者向けの、html2xtc が提供する OPDS エンドポイントの仕様。
実装: `src/opds/`。関連する D1 スキーマ・端末認証は `migrations/app/0001_initial.sql` /
`src/devices/authentication.ts` を参照。

## 1. 認証方式

3 つのエンドポイントすべてで HTTP Basic 認証が必須。

```
Authorization: Basic base64(deviceId:deviceToken)
```

- `deviceId` / `deviceToken` はペアリング完了時に発行される（別紙 pairing-protocol 相当。本文書の対象外）。
- 認証失敗（ヘッダー欠如、base64 不正、deviceId 不明、token 不一致、端末 revoked のいずれも同一の応答）:

  ```http
  401 Unauthorized
  WWW-Authenticate: Basic realm="html2xtc"
  ```

  ボディは `{"error":{"code":"UNAUTHORIZED","message":"..."}}`。

- 失敗が続くと `429`（まれに DO 障害時 `503`）を返すことがある（§7 レート制限）。
- `deviceToken` を URL クエリに含めてはならない。TLS 必須（平文 HTTP は運用しない）。

## 2. XML namespace

```xml
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opds="http://opds-spec.org/2010/catalog">
```

OPDS 1.x（Atom ベース）。OPDS 2.0 (JSON) は提供しない。

## 3. エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/opds/v1/catalog.xml` | その端末に割り当てられた XTC 一覧（フィード） |
| GET | `/opds/v1/search.xml?q=<query>` | タイトル・著者・元 URL の部分一致検索 |
| GET | `/api/device/library-items/{itemId}/download` | XTC 本体のダウンロード |

## 4. フィード要素

`GET /opds/v1/catalog.xml` の例:

```xml
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:html2xtc:device:{deviceId}</id>
  <title>html2xtc マイライブラリ</title>
  <updated>2026-07-21T00:00:00.000Z</updated>
  <link rel="self" href="https://xtc.hr20k.com/opds/v1/catalog.xml"
        type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  <link rel="search" href="https://xtc.hr20k.com/opds/v1/search.xml?q={searchTerms}"
        type="application/atom+xml"/>
  <entry>
    <id>urn:html2xtc:item:{itemId}</id>
    <title>作品名</title>
    <author><name>著者名</name></author>
    <updated>2026-07-21T00:00:00.000Z</updated>
    <link rel="http://opds-spec.org/acquisition"
          href="https://xtc.hr20k.com/api/device/library-items/{itemId}/download"
          type="application/octet-stream"/>
  </entry>
</feed>
```

必須要素:

- `feed/id`: `urn:html2xtc:device:{deviceId}`
- `feed/title`
- `feed/updated`: フィードに含まれる item の `updated_at` の最大値（UTC ISO-8601、末尾 `Z`）。item が 0 件の場合はレスポンス生成時刻。
- `feed/link[rel=self]`
- `feed/link[rel=search]`: ルートフィードのみに存在（検索結果フィードには含まれない）
- `entry/id`: `urn:html2xtc:item:{itemId}`
- `entry/title`
- `entry/author/name`: 著者情報がない item では `<author>` 要素自体を省略する（空文字列や `<author/>` は出さない）
- `entry/updated`
- `entry/link[rel="http://opds-spec.org/acquisition"]`: 後述の acquisition media type

XML 特殊文字（`& < > " '`）は必ずエスケープされる。制御文字は取り除かれる。

## 5. Acquisition media type

```
type="application/octet-stream"
```

XTC 固有の media type は割り当てていない。CrossPoint 側は `Content-Disposition` の
ファイル名拡張子（`.xtc`）または実際のダウンロードレスポンスの `Content-Type`
（同じく `application/octet-stream`）で XTC と判定すること。EPUB 用の固定 `.epub`
判定処理を流用しないこと（実装計画 §15.1）。

## 6. ページング

- 1 ページ 100 件固定。
- `?page=N`（1 始まり）。省略時は `page=1` と同じ。
- `page` が正の整数でない場合（`0`、負数、小数、先頭ゼロ、非数値）は `400 Bad Request`。
- 次ページが存在する場合のみ `rel="next"`、2 ページ目以降のみ `rel="previous"` を出力する。
- `rel="next"` / `rel="previous"` の href は `page` 以外のクエリ（検索の `q` 等）を保持する。

## 7. 検索

```
GET /opds/v1/search.xml?q={searchTerms}&page=N
```

- 検索対象: `title` / `author` / `source_url` の部分一致（SQL `LIKE`）。
- 検索範囲はその端末に割り当て済み・削除されていない item のみ（アカウント全体や他端末の item は対象外）。
- `q` が空・未指定の場合は D1 へ問い合わせず空フィードを返す（`200`）。
- `q` に含まれる `%` `_` はワイルドカードとしてではなく文字そのものとして扱われる（サーバー側でエスケープ済み）。
- ページングは §6 と同じ。
- 検索結果フィードには `rel="search"` リンクを含めない。

## 8. Content-Disposition（ダウンロード）

```
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="<ASCII fallback>.xtc"; filename*=UTF-8''<RFC 5987 encoded title>.xtc
Content-Length: <bytes>
ETag: "<r2 object etag>"
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
```

- `filename`（quoted-string）: 印字可能 ASCII のみのフォールバック。Windows/FAT で禁止された文字
  (`\ / : * ? " < > |`) は空白に置換済み。
- `filename*`: RFC 5987 percent-encoding された UTF-8 タイトル（日本語タイトルはこちらで表現される）。
- タイトルがない場合はどちらも item の内部 ID を使う。

## 9. エラーコード

| status | code | 状況 |
|---:|---|---|
| 400 | `INVALID_PAGE` | `page` が正の整数でない |
| 401 | `UNAUTHORIZED` | Basic 認証失敗（端末不明・revoked・token 不一致を区別しない） |
| 404 | `ITEM_NOT_FOUND` | 指定 itemId が未割り当て・他端末のもの・削除済み・R2 オブジェクト欠落のいずれか（区別しない） |
| 429 | `RATE_LIMITED` | 端末認証失敗が閾値を超えた（IP＋deviceId、60 回/時） |
| 503 | `RATE_LIMITER_UNAVAILABLE` | レート制限バックエンド障害中（fail-closed のため、認証成功前の失敗カウント判定ができず一時的にブロック） |

いずれもボディは `{"error":{"code":"...","message":"..."}}`。`message` に内部詳細（SQL、R2 キー等）は含まれない。

OPDS フィード取得・ダウンロードの成功に対するレート制限はない（失敗のみカウントする）。

## 10. TLS 要件

すべてのリクエストは TLS 経由で送ること。CrossPoint 側は `setInsecure()` 相当の検証省略を行わず、
CA 証明書またはバンドルによるサーバー証明書検証を有効にすること（実装計画 §15.2、必須対応）。
`deviceToken` は平文 HTTP では絶対に送信しないこと。

## 11. 副作用

- OPDS 取得・ダウンロードいずれかが成功すると、その端末の `last_seen_at` が更新される。
  ただし直近 5 分以内に更新済みの場合は書き込みをスキップする（D1 書き込み抑制のため）。
  CrossPoint 側が数秒間隔でポーリングしても問題ない。
