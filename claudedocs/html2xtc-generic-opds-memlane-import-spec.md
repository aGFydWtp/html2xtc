# 汎用OPDS基盤＋Memlane EPUB取り込み機能 実装仕様書

対象リポジトリ: `aGFydWtp/html2xtc`  
想定実行環境: Cloudflare Workers / D1 / R2 / Workflows / Svelte 5  
初期対応プロバイダー: Memlane  
文書目的: 実装エージェントへ渡し、調査・設計・実装・テストまで進めるための仕様を定義する

---

## 1. 概要

`html2xtc` に、外部OPDSサーバーからEPUBを選択し、既存のEPUB→XTC変換パイプラインへ投入する基盤を追加する。

初期リリースのユーザー向けUIはMemlane専用とする。

```text
[青空文庫から選択] [MemlaneからEPUBを取り込み]
```

ただし、内部実装はMemlane専用にせず、将来次のOPDSサーバーを追加できる汎用構造とする。

- 認証なしの公開OPDS
- URL自体に秘密値を含むOPDS
- HTTP Basic認証を使うOPDS
- Calibre / Calibre-Web / Kavita等のOPDS
- 将来追加するベンダー固有OPDSアダプター

初期リリースでは、汎用OPDS接続画面は公開しない。

```text
初期UI
  └─ MemlaneからEPUBを取り込み

内部
  └─ 汎用OPDS接続・カタログ・取り込み基盤
       ├─ Memlaneプリセット
       ├─ Generic / 認証なし
       ├─ Generic / URL secret
       └─ Generic / Basic認証
```

---

## 2. 主要な設計判断

## 2.1 表側はMemlane専用、内部は汎用OPDS

初期UIでは、ユーザーに認証方式やプロバイダー種別を選択させない。

Memlane登録時、フロントエンドまたはサーバー内部では次の接続として扱う。

```json
{
  "name": "Memlane",
  "provider": "memlane",
  "authType": "url_secret",
  "catalogUrl": "https://..."
}
```

将来「その他のOPDSサーバーから取り込み」を追加するときは、同じDB・API・暗号化・OPDSパーサー・取り込み処理を再利用する。

---

## 2.2 ログイン必須

OPDS取り込み機能はログイン済みユーザー限定とする。

未ログイン時は次のボタンを表示しない。

```text
MemlaneからEPUBを取り込み
```

関連APIもすべてCookieセッション認証を必須とする。

### 未ログイン対応を採用しない理由

技術的には匿名短期セッションやブラウザ内保存で実装できるが、初期リリースでは採用しない。

理由:

1. 外部OPDS認証情報の所有者を安定して識別できない
2. 匿名の外部URL取得APIがSSRF・公開プロキシ化しやすい
3. 変換後のライブラリ自動保存がアカウント所有権を前提としている
4. secret URLやBasic認証情報をブラウザへ永続保存したくない
5. CORS依存のブラウザ直接取得は不安定
6. 接続解除、資格情報変更、監査、レート制限をアカウント単位で管理したい

---

## 2.3 Pull型取り込み

ブラウザが外部OPDSサーバーから直接EPUBを取得しない。

```text
ブラウザ
  ↓ カタログ閲覧要求
html2xtc Worker
  ↓ OPDS取得
外部OPDSサーバー
```

EPUB取り込み:

```text
外部OPDSサーバー
  ↓ EPUBストリーム
html2xtc Worker
  ↓
R2
  ↓
既存ConvertWorkflow
  ↓
XTC
  ↓
html2xtcライブラリ
```

理由:

- CORSに依存しない
- 認証情報をブラウザへ返さない
- URLを汎用プロキシとして直接指定させない
- 既存のR2・Workflow・ジョブ管理を再利用できる

---

## 3. ゴール

実装完了後、ログイン済みユーザーは次を行える。

1. 変換画面で「MemlaneからEPUBを取り込み」を押す
2. 未接続ならMemlane登録ダイアログが開く
3. Memlane OPDS URLを登録する
4. 登録直後にMemlaneカタログが開く
5. navigation entryを辿る
6. EPUB entryを1〜5件選択する
7. 既存EPUB変換オプションを指定する
8. EPUBを既存の変換Workflowへ投入する
9. 既存の現在ジョブ・履歴UIで進行状況を確認する
10. 変換完了後、既存仕様に従いライブラリへ自動保存される
11. Memlane接続を置換・解除できる

内部的には次を満たす。

- 接続情報は汎用OPDS接続として保存する
- 認証なし、URL secret、Basic認証の保存形式を定義する
- OPDS 1.x Atom XMLを汎用パーサーで解析する
- プロバイダー固有差異はアダプターへ分離する
- 外部URLをブラウザへ返さず、暗号化cursorを使う

---

## 4. 非ゴール

初期リリースでは次を実装しない。

- 未ログインユーザー向けOPDS取り込み
- 汎用OPDS接続UI
- Memlane OAuth
- OPDS 2.0 JSON
- Digest認証
- OAuth / OIDC認証OPDS
- フォームログイン＋Cookie認証OPDS
- 独自Bearerヘッダー認証
- DRM解除
- 取り込み済みコンテンツの自動同期
- 既読状態同期
- 定期バックグラウンド取り込み
- 家庭内LANのprivate IPへの接続
- HTTPまたは自己署名証明書の許可
- 外部OPDSへの書き戻し
- EPUB以外の形式取り込み
- 複数Memlane接続のUI
- Memlane OPDS URLやBasicパスワードの平文再表示

---

## 5. 対応するOPDSプロファイル

## 5.1 初期対応

- OPDS 1.x
- Atom XML
- HTTPS
- publication acquisition:
  - `application/epub+zip`
- navigation feed
- next / previous
- OpenSearch search templateがある場合の検索

## 5.2 認証方式

内部型:

```ts
export type OpdsAuthType =
  | "none"
  | "url_secret"
  | "basic";
```

### none

```text
公開HTTPS OPDS
```

保存対象:

- catalog URL

### url_secret

```text
URLのpathまたはquery自体が秘密値
```

Memlaneの初期プリセットはこの型とする。

保存対象:

- catalog URL全体

### basic

```text
HTTP Basic認証
```

保存対象:

- catalog URL
- username
- password

すべて暗号化保存する。URLには秘密値が含まれる可能性があるため、`none`であってもcatalog URL全体を暗号化する。

---

## 6. プロバイダー設計

内部型:

```ts
export type OpdsProvider =
  | "memlane"
  | "generic"
  | "calibre"
  | "calibre_web"
  | "kavita"
  | "other";
```

初期リリースで実際に作成する接続:

```text
provider = memlane
authType = url_secret
```

プロバイダー名だけで挙動を大きく分岐させない。原則としてgeneric実装を使い、実サービス差異が確認されたときだけアダプターで上書きする。

インターフェース例:

```ts
export interface OpdsProviderAdapter {
  normalizeConnectionInput(
    input: OpdsConnectionInput,
  ): OpdsConnectionInput;

  validateCatalogResponse(
    response: Response,
  ): Promise<void>;

  isAllowedNavigationUrl(
    connection: DecryptedOpdsConnection,
    target: URL,
  ): boolean;

  isAllowedAcquisitionUrl(
    connection: DecryptedOpdsConnection,
    target: URL,
  ): boolean;

  normalizeEntry?(
    entry: ParsedOpdsEntry,
  ): ParsedOpdsEntry;
}
```

初期状態:

```ts
export const memlaneAdapter: OpdsProviderAdapter = genericAdapter;
```

Memlane固有のCDN、Content-Type、リダイレクト等が確認された場合だけ差分を追加する。

---

## 7. Memlane実サービス調査

実装開始時に、開発者所有のMemlane接続を使って次を確認する。

- OPDSバージョン
- URL自体が認証情報として機能するか
- Basic認証の有無
- feed `Content-Type`
- navigation link
- search link
- acquisition linkの`rel`
- EPUB acquisition linkの`type`
- EPUBレスポンスの`Content-Type`
- EPUBレスポンスの`Content-Length`
- `Content-Disposition`
- 相対URLの有無
- redirectの有無
- redirect先origin
- CDN host
- ページング
- 最大想定フィードサイズ

実URL、secret path、query、EPUB本文をfixture・ログ・CI artifactへ含めない。

調査結果と本仕様の差異は設計メモへ記録する。

---

## 8. UX仕様

## 8.1 ボタン表示

対象:

```text
frontend/src/components/ConvertForm.svelte
```

既存青空文庫ボタンの隣へ追加する。

表示条件:

```svelte
{#if
  authStore.ready
  && authStore.account
  && publicConfigStore.opdsImportEnabled
}
  <button
    type="button"
    class="secondary"
    onclick={() => void opds.openMemlane()}
  >
    {t("memlane_open")}
  </button>
{/if}
```

表示:

| 状態 | Memlaneボタン |
|---|---:|
| 未ログイン | 非表示 |
| セッション復元中 | 非表示 |
| ログイン済み | 表示 |
| 機能フラグ無効 | 非表示 |
| ログアウト直後 | 非表示 |

ボタン行:

```text
[青空文庫から選択] [MemlaneからEPUBを取り込み]
```

CSS:

```css
.source-buttons {
  margin-top: 16px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
```

---

## 8.2 ボタン押下時

`openMemlane()`は、サーバーからMemlane接続状態を取得する。

### 未接続

`MemlaneConnectionDialog`を開く。

### 接続済み

接続IDを保持し、`OpdsCatalogDialog`をMemlane表示モードで開く。

### セッション切れ

- ダイアログを閉じる
- cursor、entry、selectionを破棄する
- 既存ログイン導線に従う
- 外部接続情報を画面へ残さない

---

## 8.3 Memlane接続登録ダイアログ

新規候補:

```text
frontend/src/components/MemlaneConnectionDialog.svelte
```

タイトル:

```text
Memlaneを接続
```

説明:

```text
Memlaneで発行されたOPDSカタログURLを登録します。
このURLは認証情報として暗号化保存され、登録後は再表示されません。
```

入力:

```text
Memlane OPDS URL
```

属性:

```html
<input
  type="url"
  autocomplete="off"
  autocapitalize="none"
  spellcheck="false"
/>
```

ボタン:

```text
[キャンセル] [接続して開く]
```

成功時:

1. 入力stateを即時クリア
2. 登録ダイアログを閉じる
3. 返却されたconnectionIdでカタログダイアログを開く
4. ルートフィードを取得

新URLの検証が成功するまで既存接続を上書きしない。

---

## 8.4 カタログダイアログ

汎用コンポーネントとして作る。

```text
frontend/src/components/OpdsCatalogDialog.svelte
```

初期UIではMemlane専用ラベルで開く。

```text
MemlaneからEPUBを取り込み
```

表示:

- 現在フィードタイトル
- 戻る
- search
- navigation entry
- publication entry
- 選択数
- `EpubOptions`
- 取り込みボタン
- 接続更新
- 接続解除

最大選択数:

```text
5件
```

navigation entryは選択不可。EPUB acquisitionを持つpublicationだけ選択可能。

---

## 8.5 変換開始

選択したEPUBを1件ずつ独立リクエストで投入する。

```text
POST /api/integrations/opds/{connectionId}/import
```

推奨同時実行数:

```text
2
```

1件失敗しても他を継続する。

完了表示例:

```text
4件の変換を開始しました
1件は取り込みを開始できませんでした
```

---

## 8.6 接続更新・解除

### 更新

Memlane登録ダイアログを再利用する。

- 新URL検証成功後に置換
- 失敗時は旧接続を維持
- 成功後、古いcursorとカタログstateを破棄

### 解除

確認:

```text
Memlane接続を解除しますか？
html2xtcへ取り込み済みのファイルは削除されません。
```

解除後:

- 接続行削除
- cursor、selection、entryを破棄
- 取り込み済みlibrary itemは保持
- 次回ボタン押下時は登録ダイアログ

---

## 9. フロントエンド構成

追加候補:

```text
frontend/src/components/MemlaneConnectionDialog.svelte
frontend/src/components/OpdsCatalogDialog.svelte
frontend/src/components/OpdsEntryRow.svelte
frontend/src/lib/opds.svelte.ts
```

既存変更候補:

```text
frontend/src/App.svelte
frontend/src/components/ConvertForm.svelte
frontend/src/lib/convert.svelte.ts
frontend/src/lib/i18n.svelte.ts
frontend/src/lib/publicConfig.svelte.ts
```

内部storeはMemlane専用名ではなく汎用名にする。

---

## 9.1 フロントエンド型

```ts
export interface OpdsConnectionSummary {
  id: string;
  name: string;
  provider: string;
  authType: string;
  host: string;
  lastVerifiedAt: string | null;
}

export interface OpdsNavigationEntry {
  kind: "navigation";
  id: string;
  title: string;
  cursor: string;
}

export interface OpdsPublicationEntry {
  kind: "publication";
  id: string;
  title: string;
  author: string | null;
  updatedAt: string | null;
  canImportEpub: boolean;
  acquisitionCursor: string | null;
}

export type OpdsEntry =
  | OpdsNavigationEntry
  | OpdsPublicationEntry;

export interface OpdsCatalogPage {
  title: string;
  entries: OpdsEntry[];
  nextCursor: string | null;
  previousCursor: string | null;
  searchSupported: boolean;
  searchCursor: string | null;
}
```

secret URL、username、password、元hrefを型へ含めない。

---

## 9.2 ジョブ管理との統合

`frontend/src/lib/convert.svelte.ts`へ共通関数を追加する。

```ts
export function registerCreatedJob(input: {
  jobId: string;
  sourceType: JobEntry["sourceType"];
  sourceLabel: string;
  title?: string;
}): void;
```

Memlane成功時:

```ts
registerCreatedJob({
  jobId: response.jobId,
  sourceType: "epub",
  sourceLabel: `Memlane: ${entry.title}`,
  title: entry.title,
});
```

既存の:

- `jobsStore`
- `sessionJobIds`
- `startPolling`
- `maybeAutoSave`

を再利用する。

Memlane専用のジョブポーリング・ライブラリ保存を作らない。

---

## 10. データモデル

Migration候補:

```text
migrations/app/00xx_opds_connections.sql
```

テーブル:

```sql
CREATE TABLE opds_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  auth_type TEXT NOT NULL,

  catalog_url_ciphertext BLOB NOT NULL,
  catalog_url_iv BLOB NOT NULL,
  catalog_url_auth_tag BLOB NOT NULL,

  username_ciphertext BLOB,
  username_iv BLOB,
  username_auth_tag BLOB,

  password_ciphertext BLOB,
  password_iv BLOB,
  password_auth_tag BLOB,

  origin TEXT NOT NULL,
  host TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,

  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX idx_opds_connections_account
  ON opds_connections(account_id);

CREATE UNIQUE INDEX idx_opds_connections_account_provider_name
  ON opds_connections(account_id, provider, name);
```

初期リリースでは、Memlane接続は1アカウント1件とする。

service層で:

```text
accountId + provider=memlane
```

をupsert対象にする。

DB自体は将来複数OPDS接続を保存できる構造とする。

---

## 10.1 保存規則

### 常に暗号化

- catalog URL

### Basic認証の場合のみ暗号化

- username
- password

### 平文保存可能

- name
- provider
- auth_type
- origin
- host
- created_at
- updated_at
- last_verified_at

保存禁止:

- catalog URL平文
- URL path
- URL query
- username平文
- password平文

---

## 11. 暗号化

Wrangler secret:

```text
OPDS_CONNECTION_ENCRYPTION_KEY
OPDS_CURSOR_ENCRYPTION_KEY
```

それぞれ:

- standard base64
- 復号後32 byte
- AES-256-GCM
- IV 12 byte
- auth tag 16 byte
- non-extractable CryptoKey

接続暗号化のAAD:

```text
html2xtc:opds-connection:v1:{accountId}:{connectionId}:{field}
```

`field`:

```text
catalog_url
username
password
```

暗号文を別アカウント・別接続・別フィールドへ移しても復号できないようにする。

---

## 11.1 cursor

ブラウザへ元URLを返さない。

payload例:

```json
{
  "v": 1,
  "accountId": "uuid",
  "connectionId": "uuid",
  "kind": "navigation",
  "url": "https://...",
  "depth": 2,
  "issuedAt": 1785312000,
  "expiresAt": 1785312900
}
```

kind:

```text
navigation
search
acquisition_epub
next
previous
```

要件:

- 有効期限15分
- accountId一致
- connectionId一致
- kind一致
- 最大depth 10
- 改ざん検知
- URLをログへ出さない
- 接続削除後は利用不可
- 接続置換時は新connectionIdを発行するか、credential versionをcursorに含めて旧cursorを失効させる

推奨:

```text
接続置換時は既存row更新ではなく、新connectionIdで置換
```

旧row削除後に新rowを有効化する。ただし、新接続検証成功までは旧rowを保持する。

---

## 12. サーバー構成

追加候補:

```text
src/integrations/opds/routes.ts
src/integrations/opds/service.ts
src/integrations/opds/repository.ts
src/integrations/opds/connection-crypto.ts
src/integrations/opds/cursor-crypto.ts
src/integrations/opds/parser-v1.ts
src/integrations/opds/fetch.ts
src/integrations/opds/import.ts
src/integrations/opds/types.ts

src/integrations/opds/providers/generic.ts
src/integrations/opds/providers/memlane.ts
src/integrations/opds/providers/index.ts
```

ルート:

```ts
registerOpdsRoutes(router);
```

---

## 13. API

## 13.1 接続一覧

```http
GET /api/integrations/opds
```

認証:

- Cookie session必須

レスポンス:

```json
{
  "connections": [
    {
      "id": "uuid",
      "name": "Memlane",
      "provider": "memlane",
      "authType": "url_secret",
      "host": "example.com",
      "lastVerifiedAt": "2026-07-29T09:00:00.000Z"
    }
  ]
}
```

secretを返さない。

ヘッダー:

```http
Cache-Control: private, no-store
```

---

## 13.2 Memlane接続取得

フロントは接続一覧から:

```text
provider === "memlane"
```

を探す。

専用status APIは作らなくてもよい。

一覧APIが複雑になる場合だけ追加:

```http
GET /api/integrations/opds/by-provider/memlane
```

ただし、初期実装では一覧APIを優先する。

---

## 13.3 接続作成

```http
POST /api/integrations/opds
Content-Type: application/json
X-CSRF-Token: ...
```

汎用リクエスト:

```json
{
  "name": "Memlane",
  "provider": "memlane",
  "authType": "url_secret",
  "catalogUrl": "https://..."
}
```

将来のBasic例:

```json
{
  "name": "自宅のOPDS",
  "provider": "generic",
  "authType": "basic",
  "catalogUrl": "https://books.example.com/opds",
  "username": "user",
  "password": "secret"
}
```

初期リリースでは、フロントから作成できるのはMemlaneのみ。

サーバーは汎用入力を検証する。

処理順:

1. セッション認証
2. CSRF
3. feature flag
4. JSON shape
5. provider/authType組み合わせ
6. URL検証
7. credential shape検証
8. 目的別レート制限
9. 外部ルートフィード取得
10. OPDS解析
11. provider adapter検証
12. origin/host確定
13. credential暗号化
14. D1 insert
15. 同一Memlane旧接続を削除または置換
16. 監査
17. summary返却

Memlane:

```text
provider=memlane
authType=url_secret
username/password禁止
```

generic:

```text
authType=none | url_secret | basic
```

---

## 13.4 接続置換

次のどちらかを採用する。

推奨:

```http
POST /api/integrations/opds
```

で同一`accountId + provider=memlane`を置換する。

要件:

- 新接続検証成功まで旧接続を維持
- 成功後、新connection rowを作成
- トランザクション相当のD1 batchで旧Memlane rowを削除
- 新connectionIdを返す
- 旧cursorを失効

または:

```http
PUT /api/integrations/opds/{connectionId}
```

を追加してもよいが、credential versionを導入しない限り旧cursor失効に注意する。

---

## 13.5 接続削除

```http
DELETE /api/integrations/opds/{connectionId}
X-CSRF-Token: ...
```

認証:

- Cookie session必須
- 所有者確認
- CSRF必須

成功:

```http
204 No Content
```

取り込み済みlibrary itemと実行中Workflowは削除・停止しない。

---

## 13.6 カタログ取得

```http
GET /api/integrations/opds/{connectionId}/catalog
GET /api/integrations/opds/{connectionId}/catalog?cursor={cursor}
GET /api/integrations/opds/{connectionId}/catalog?search={query}&cursor={searchCursor}
```

クライアントから外部URLを受け取らない。

成功:

```json
{
  "title": "Memlane",
  "entries": [
    {
      "kind": "navigation",
      "id": "opaque-id",
      "title": "Recents",
      "cursor": "encrypted-cursor"
    },
    {
      "kind": "publication",
      "id": "opaque-id",
      "title": "記事タイトル",
      "author": "著者",
      "updatedAt": "2026-07-29T00:00:00.000Z",
      "canImportEpub": true,
      "acquisitionCursor": "encrypted-cursor"
    }
  ],
  "nextCursor": null,
  "previousCursor": null,
  "searchSupported": true,
  "searchCursor": "encrypted-cursor"
}
```

返却禁止:

- 元href
- 元feed URL
- acquisition URL
- catalog secret
- XML原文
- Basic credentials

---

## 13.7 EPUB取り込み

```http
POST /api/integrations/opds/{connectionId}/import
Content-Type: application/json
X-CSRF-Token: ...
```

リクエスト:

```json
{
  "acquisitionCursor": "encrypted-cursor",
  "title": "表示タイトル",
  "epubOptions": {}
}
```

`epubOptions`は既存`EpubConvertOptions`のshapeをそのまま使う。

処理順:

1. セッション認証
2. 所有者確認
3. CSRF
4. feature flag
5. rate limit
6. cursor復号
7. accountId / connectionId / kind / expiry
8. 接続復号
9. acquisition URL検証
10. provider adapter検証
11. EPUB取得
12. redirectごとに検証
13. Content-Type
14. Content-Length
15. 最大サイズ
16. ZIP magic
17. filename
18. R2ストリーミング保存
19. ConvertWorkflow作成
20. 監査
21. jobId返却

成功:

```http
202 Accepted
```

```json
{
  "jobId": "uuid",
  "statusUrl": "/jobs/uuid"
}
```

---

## 14. 接続情報のHTTP適用

外部fetch helperは、接続のauth typeに応じてRequestを構築する。

```ts
function applyOpdsAuthentication(
  headers: Headers,
  connection: DecryptedOpdsConnection,
): void;
```

### none

追加ヘッダーなし。

### url_secret

追加ヘッダーなし。暗号化保存されたURL自体を使う。

### basic

```http
Authorization: Basic base64(username:password)
```

禁止:

- credentialをURL userinfoへ埋め込む
- Authorizationを別origin redirectへ無条件転送する

Basic認証のredirect:

- 同一originのみAuthorizationを維持
- 別originへはAuthorizationを転送しない
- acquisition CDNを許可する場合もBasicヘッダーは転送しない
- CDNにも認証が必要なサービスは個別アダプターで明示対応する

---

## 15. SSRF・外部URL対策

すべての外部fetchで共通検証を使う。

対象:

- 接続検証
- navigation
- search
- next / previous
- acquisition
- redirect

要件:

1. HTTPSのみ
2. userinfo禁止
3. fragment禁止または除去
4. loopback拒否
5. private IPv4拒否
6. link-local拒否
7. multicast拒否
8. unspecified拒否
9. IPv6 loopback / ULA / link-local拒否
10. metadata endpoint拒否
11. redirectごとに再検証
12. redirect最大3
13. HTTPS→HTTP拒否
14. navigation/searchは原則同一origin
15. acquisitionは同一originを原則
16. 実サービス上CDNが必要な場合だけ限定allowlist
17. URLをログへ出さない
18. 外部URLをリクエストパラメータとして直接受け取らない

家庭内の:

```text
http://192.168.x.x
```

等は対象外。

---

## 16. OPDS 1.xパーサー

新規:

```text
src/integrations/opds/parser-v1.ts
```

解析:

- feed/title
- feed link next
- feed link previous
- feed link search
- entry/id
- entry/title
- entry/author/name
- entry/updated
- navigation link
- acquisition link

EPUB判定:

1. `type=application/epub+zip`
2. `application/octet-stream`かつhref末尾`.epub`
3. 最終的にはimport時のレスポンスで再検証

XML対策:

- DTD禁止
- 外部実体参照禁止
- entity expansion禁止
- XML最大1 MiB
- entry最大100
- 各文字列長上限
- 不正XMLは422
- 外部リソースを取得しない

OPDS 2.0は別パーサーとして将来追加する。

---

## 17. EPUB job共通化

既存`POST /jobs/epub`から、R2保存とWorkflow作成を共通化する。

新規候補:

```text
src/epub-job.ts
```

例:

```ts
export interface CreateStoredEpubJobInput {
  body: ReadableStream<Uint8Array>;
  declaredSize: number;
  filename: string;
  epubOptions: EpubConvertOptions;
  sourceMetadata: {
    sourceType: "epub-upload" | "opds";
    provider?: string;
    connectionId?: string;
  };
}

export async function createStoredEpubJob(
  env: Env,
  input: CreateStoredEpubJobInput,
): Promise<{
  jobId: string;
  statusUrl: string;
}>;
```

HTTP固有処理は含めない。

共通化するもの:

- key生成
- ZIP leading bytes確認後のR2保存
- R2 size照合
- ConvertJobParams
- Workflow作成
- Workflow失敗時のR2削除

禁止:

- `response.arrayBuffer()`
- EPUB全体のWorkerメモリ保持
- 既存Workflowの複製

---

## 18. Content-Length

MVPでは外部EPUBレスポンスの`Content-Length`を必須とすることを推奨する。

- 正の整数
- 最大EPUBサイズ以下
- R2保存後size照合

MemlaneがContent-Lengthを返さないことが確認された場合は、R2 multipart upload等の上限付きストリーミングを実装する。

禁止:

- サイズ無制限buffer
- 最大サイズを超えた一時オブジェクトの放置

---

## 19. ファイル名

優先順位:

1. `Content-Disposition`
2. OPDS entry title
3. `document.epub`

既存:

```text
sanitizeUploadEpubFilename()
```

を使う。

URL pathから秘密値を含むファイル名を生成しない。

---

## 20. feature flag

公開設定:

```text
OPDS_IMPORT_MODE
```

値:

```text
enabled
disabled
```

公開config:

```json
{
  "opdsImportEnabled": true
}
```

初期UIではこのフラグをMemlaneボタン表示に使用する。

disabled時:

- ボタン非表示
- OPDS APIは503または既存方針に合わせたエラー
- 保存済み接続は削除しない
- 実行済みWorkflowは継続

---

## 21. レート制限

初期値:

| purpose | key | 上限 |
|---|---|---:|
| `opds.connection.verify` | accountId + IP | 10回/時 |
| `opds.catalog.fetch` | accountId | 120回/時 |
| `opds.import.start` | accountId + IP | 30回/時 |

importは既存の変換開始制限も通す。

---

## 22. 監査

イベント:

```text
integration.opds.connected
integration.opds.replaced
integration.opds.disconnected
integration.opds.catalog_fetched
integration.opds.import_started
integration.opds.import_failed
```

属性:

- accountId
- connectionId
- provider
- authType
- host
- jobId
- sizeBytes
- failure category

禁止:

- URL全体
- path
- query
- username
- password
- Authorization
- cursor
- XML
- EPUB本文

---

## 23. i18n

初期UI向けキー:

```text
memlane_open
memlane_connect_title
memlane_connect_description
memlane_url_label
memlane_connect
memlane_connecting
memlane_disconnect
memlane_disconnect_confirm
memlane_replace_connection
memlane_catalog_title
memlane_catalog_loading
memlane_catalog_empty
memlane_catalog_failed
memlane_selected_count
memlane_import
memlane_importing
memlane_import_started
memlane_import_partial_failed
memlane_invalid_url
memlane_https_required
memlane_feed_invalid
memlane_upstream_error
memlane_timeout
memlane_cursor_invalid
memlane_epub_unavailable
memlane_session_expired
```

内部APIエラーcodeは`OPDS_*`を使ってよい。

例:

```text
OPDS_CONNECTION_NOT_FOUND
OPDS_CONNECTION_INVALID
OPDS_CURSOR_INVALID
OPDS_FEED_INVALID
OPDS_UPSTREAM_ERROR
OPDS_EPUB_UNAVAILABLE
```

---

## 24. テスト

## 24.1 接続暗号化

- URL round trip
- username/password round trip
- random IV
- wrong key
- tamper
- accountId AAD mismatch
- connectionId mismatch
- field mismatch
- DB rowに平文非存在

## 24.2 cursor

- round trip
- expiry
- account mismatch
- connection mismatch
- kind mismatch
- tamper
- depth上限
- 接続置換後の旧cursor無効

## 24.3 認証方式

- none
- url_secret
- basic
- Basic header生成
- 別origin redirectでAuthorizationを転送しない
- provider/authType不正組み合わせ拒否
- Memlane + basic拒否
- Memlane + none拒否

## 24.4 URL検証

拒否:

- HTTP
- file / ftp / data
- userinfo
- localhost
- private IP
- link-local
- IPv6 private
- metadata
- downgrade redirect
- redirect loop
- redirect過多
- 別origin navigation
- 非許可CDN

## 24.5 OPDSパーサー

- root
- navigation
- EPUB acquisition
- authorなし
- relative href
- next / previous
- search
- namespace
- malformed XML
- DTD
- entity expansion
- サイズ上限
- entry上限
- EPUB以外
- octet-stream + `.epub`

## 24.6 API

### 一覧

- 未ログイン401
- アカウント分離
- secretを返さない

### 作成

- 未ログイン401
- CSRF
- Memlane正常
- URL不正
- HTTP拒否
- OPDS不正
- upstreamエラー
- rate limit
- URL非ログ出力

### 削除

- 所有者
- CSRF
- 冪等方針
- library item維持

### catalog

- root
- navigation
- search
- next / previous
- cursor不正
- 他アカウントcursor
- 元URL非返却

### import

- 正常202
- cursor不正
- Content-Type
- Content-Length
- サイズ超過
- ZIP magic
- R2失敗
- Workflow失敗時削除
- job status取得
- auditにsecretなし

## 24.7 フロントエンド

- 未ログインでMemlaneボタン非表示
- auth復元中非表示
- ログイン後表示
- feature flag無効で非表示
- 未接続で登録ダイアログ
- 接続済みでカタログ
- 登録成功後URL state消去
- 最大5件
- navigation
- search
- 既存EpubOptions
- 同時実行数2
- 部分失敗
- registerCreatedJob
- ライブラリ自動保存
- 接続更新
- 接続解除
- logout/account切替でstate破棄

---

## 25. 実装順序

1. Memlane実OPDS調査
2. 汎用OPDS型・設計メモ
3. feature flag
4. D1 migration
5. 接続暗号化
6. cursor暗号化
7. repository
8. provider adapter
9. URL・redirect検証
10. OPDS 1.x parser
11. 接続一覧・作成・削除API
12. catalog API
13. EPUB job共通化
14. import API
15. サーバーテスト
16. `registerCreatedJob()`共通化
17. 汎用OPDS frontend store
18. Memlane登録ダイアログ
19. 汎用カタログダイアログ
20. ConvertFormへログイン条件付きボタン
21. i18n
22. フロントテスト
23. 結合テスト
24. staging
25. 実Memlane確認
26. セキュリティレビュー
27. production flag有効化
28. 運用・ユーザー向け文書

---

## 26. 受け入れ条件

- [ ] 未ログイン時、Memlaneボタンが表示されない
- [ ] 未ログインAPI呼び出しは401
- [ ] 初期UIはMemlane専用
- [ ] DB/API/暗号化/パーサーは汎用OPDS構造
- [ ] 未接続押下でMemlane登録ダイアログ
- [ ] 接続済み押下でカタログ
- [ ] catalog URLが平文保存されない
- [ ] Basic username/passwordを暗号化保存できる内部設計
- [ ] 元URLをブラウザへ返さない
- [ ] navigation/searchが動作する
- [ ] EPUBを最大5件選択できる
- [ ] 既存EpubOptionsを再利用する
- [ ] EPUB全量をWorkerメモリへ載せない
- [ ] SSRF・危険redirectを拒否する
- [ ] 既存Workflowを利用する
- [ ] 既存ジョブUIへ表示される
- [ ] 完了後ライブラリへ自動保存
- [ ] 1件失敗しても他を継続
- [ ] 新接続検証失敗時は旧接続維持
- [ ] 接続解除後も取り込み済みitem維持
- [ ] ログ・監査へsecretを出さない
- [ ] feature flagで停止可能
- [ ] Memlane adapterとgeneric adapterが分離される
- [ ] 将来generic OPDS UIを追加してもDB/APIを作り直す必要がない
- [ ] 単体・結合・実サービス確認が完了

---

## 27. Definition of Done

- 汎用`opds_connections` migration
- 認証方式型
- provider adapter
- 接続資格情報暗号化
- cursor暗号化
- 接続管理API
- OPDS 1.x取得・解析
- SSRF・redirect対策
- EPUB取り込みAPI
- EPUB job共通化
- 汎用frontend store
- Memlane初回登録ダイアログ
- 汎用カタログダイアログ
- ログイン条件付きMemlaneボタン
- 既存ジョブ・自動保存統合
- feature flag
- rate limit
- audit
- i18n
- 単体テスト
- 結合テスト
- 実Memlane確認
- セキュリティレビュー記録
- 運用文書
- ユーザー向けMemlane接続手順

---

## 28. 実装エージェントへの注意

- UI名がMemlaneでも、内部クラス・DB・APIをMemlane専用にしないこと
- `memlane_connections`ではなく`opds_connections`を使うこと
- 外部URLをブラウザへ返さないこと
- URL・username・password・cursorをログへ出さないこと
- 任意URLプロキシを作らないこと
- private IPを許可しないこと
- EPUB全体を`arrayBuffer()`で読み込まないこと
- 既存EPUB Workflowを複製しないこと
- 既存ジョブポーリングとライブラリ自動保存を複製しないこと
- UI非表示だけで認可を済ませずAPIでも認証すること
- Memlane実secretをfixture・コミット・CI artifactへ含めないこと
- 実サービス差異はprovider adapterへ閉じ込めること
- OPDS 2.0対応をOPDS 1.x parserへ無理に混ぜないこと
