# 運用手順書（端末別ライブラリ機能）

アカウント登録・秘密情報・D1・R2・障害対応の運用手順。既存の変換API（`/convert`, `/jobs`）の
デプロイ手順・課金・既知の制限は `claudedocs/deploy-guide.md` を参照（本書はこの機能追加分のみ）。
認証・レート制限・監査ログの仕様は `docs/security-model.md`、ペアリングの内部仕様は
`docs/pairing-protocol.md` を参照。

## 1. 招待コード発行手順

新規アカウント作成には招待トークンが必須（誰でも自由登録はできない、ADR-6参照）。

```bash
node scripts/create-invite.mjs           # 本番(APP_DB --remote)向けコマンドを出力
node scripts/create-invite.mjs --local   # ローカル(--local)向けコマンドを出力
```

このスクリプト自体は wrangler を呼ばない。出力される2つの情報を確認してから、自分で実行する:

1. `npx wrangler d1 execute html2xtc-app --remote --command "INSERT INTO registration_invites ..."`
   —— これをコピーして実行し、`registration_invites` にトークンのSHA-256ハッシュのみを登録する。
2. `https://xtc.hr20k.com/?register=<token>` —— 一度だけ表示される登録URL。**信頼できる経路**
   （直接手渡し・既知の相手とのDM等）で共有すること。ログにも残らないため再表示できない。

- 有効期限: 7日固定（`INVITE_TTL_DAYS`）。
- 1回使い切り: 登録完了（`finishRegistration`のnew-accountパス）で `consumed_at` が設定され、
  以後同じトークンは使えない。
- トークンの平文はどこにも永続保存されない（`docs/security-model.md` §8参照）。

## 2. Wrangler secrets の初期設定

以下は `wrangler.jsonc` の `vars` ではなく Wrangler secret として設定する（コード上の
コメントも同様に注記している）。

```bash
# 32バイト(256ビット)のランダム値を生成して設定する例
npx wrangler secret put SESSION_PEPPER
npx wrangler secret put PAIRING_ENCRYPTION_KEY   # base64エンコードされた256ビット鍵であること
```

`PAIRING_ENCRYPTION_KEY` は `resolvePairingEncryptionKey`（`src/security/aes-gcm.ts`）が
「base64デコードして正確に32バイトになること」を要求する。生成例:

```bash
openssl rand -base64 32
```

`WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` は秘密ではなく `wrangler.jsonc` の `vars` に平文設定済み
（ドメインは既に公開情報のため）。

### ローテーション手順と影響

**`SESSION_PEPPER` のローテーション**:

```bash
npx wrangler secret put SESSION_PEPPER
```

- 影響: `sessions.token_hash` は旧pepperで計算された値のまま残る。新pepperをセットした瞬間から
  `hashSessionToken` は新pepperでハッシュを計算するため、**既存の全セッションが即座に無効化される**
  （`requireSession` の照合が一致しなくなる）。ローテーション直後は全ユーザーが再ログイン
  （パスキー認証）を求められる。
- 実行タイミング: 影響範囲がユーザー全員に及ぶため、事前に告知するか、影響が許容できる
  タイミング（利用者が少ない/自分のみの運用等）で行う。
- ロールバック不可: 旧pepperを保持していない限り、ローテーション前のセッションを復元する
  方法はない（意図的な設計——pepper漏洩時に即座に全セッションを無効化できることが目的）。

**`PAIRING_ENCRYPTION_KEY` のローテーション**:

```bash
npx wrangler secret put PAIRING_ENCRYPTION_KEY
```

- 影響: `devices.token_hash`（確定済みのデバイス認証情報）には一切影響しない
  ——このキーは `device_pairings` の**一時的な受け渡し中のdeviceToken**の暗号化にしか
  使われないため。
- ローテーション時点で `approved` 状態（まだ `complete` されていない = 端末が未取得）の
  ペアリングが存在する場合、その行の `encrypted_device_token` は**旧キーで暗号化されたまま**
  残る。新キーへ切り替えた後にその端末がポーリングすると `decryptWithPairingKey` が復号に
  失敗し（`crypto.subtle.decrypt` が例外を投げ、`pollPairing` はそのまま例外を伝播させる ——
  現状ハンドリングされておらず 500 応答になる）、その端末は認証情報を取得できなくなる。
- 実務上の手順: ローテーション前に「進行中の `approved` ペアリング」が無いことを確認するか
  （下記クエリ）、あるいは影響を許容し、該当端末には再ペアリングをやり直してもらう。

  ```bash
  npx wrangler d1 execute html2xtc-app --remote --command \
    "SELECT id, device_id, approved_at FROM device_pairings WHERE status = 'approved'"
  ```

  結果が0件であればローテーションは安全。

**`REGISTRATION_INVITE_SECRET`**: `docs/security-model.md` の注記のとおり、現在のコードは
このシークレットを一切参照していない（未使用）。設定してもしなくても招待検証の挙動に影響はない。

## 3. D1 バックアップ/リストア手順

### APP_DB（バックアップ対象）

`APP_DB`（アカウント・セッション・端末・ライブラリ・ペアリング）はユーザーデータの正本であり、
再構築不可能なため定期的なバックアップが必要。

```bash
# エクスポート
npx wrangler d1 export html2xtc-app --remote --output=app-db-backup-$(date +%Y%m%d).sql

# リストア（新規/既存DBへSQLを流し込む。既存データがある場合は競合に注意）
npx wrangler d1 execute html2xtc-app --remote --file=app-db-backup-YYYYMMDD.sql
```

- バックアップファイルには `sessions.token_hash` / `devices.token_hash` /
  `device_pairings.pairing_secret_hash` 等のハッシュ値、および `device_pairings` の
  暗号化済みトークン材料（AES-GCM暗号文。復号には `PAIRING_ENCRYPTION_KEY` が必要）が
  含まれる——平文の秘密情報は含まれないが、機微なハッシュ値を含むため保管場所は
  アクセス制限された場所にすること。
- リストア後、`PAIRING_ENCRYPTION_KEY` / `SESSION_PEPPER` が当時と同じ値でなければ、
  既存セッション・進行中ペアリングは復元できない（鍵/pepperも合わせてバックアップ・復元する
  運用にするか、リストア後の再ログイン・再ペアリングを許容すること）。

### AOZORA_DB（バックアップ不要という判断）

`AOZORA_DB`（青空文庫カタログ）はバックアップ対象**としない**。理由:

- 内容は青空文庫の公開データから `AozoraCatalogSyncWorkflow`（`src/catalog-workflow.ts`）が
  毎日決定的に再構築する導出データであり、外部の正本（青空文庫）から失われても再同期一回で
  復旧できる。
- ユーザー固有の状態を一切含まない（生成専用のカタログ）。

万一 `AOZORA_DB` を失った場合は、次回の日次Cron（`wrangler.jsonc` の `triggers.crons`）を待つか、
手動でWorkflowをトリガーして再同期する。

## 4. R2 `library/` の位置づけ

`library/` prefix（`libraryItemKey`、`src/library/storage.ts`）は**自動削除の対象外**。
既存の `jobs/`・`intermediate/` prefix（変換の中間生成物）にはR2 Lifecycle Ruleによる
自動期限切れ（24時間）が設定されているが（`claudedocs/deploy-guide.md` §5参照）、
`library/` は永続ライブラリのため意図的に対象から外してある。

**確認手順**（デプロイ時・Lifecycle Rule変更時に必ず確認する）:

```bash
npx wrangler r2 bucket lifecycle list xteink-conversions
```

出力される各ルールの prefix が `intermediate/` および `jobs/` のみであり、`library/` を
対象にするルールが存在しないことを目視確認する。もし `library/` を巻き込むルール（例:
バケット全体を対象にする空prefixのルール）が誤って追加されていた場合は、ユーザーの永続ライブラリが
自動削除されてしまうため直ちに `npx wrangler r2 bucket lifecycle remove` で削除すること。

## 5. マイグレーション適用手順

```bash
# APP_DB（アカウント・端末・ライブラリ）
npx wrangler d1 migrations apply html2xtc-app --remote    # 本番
npx wrangler d1 migrations apply html2xtc-app --local     # ローカル開発

# AOZORA_DB（カタログ、別のmigrations_dir）
npx wrangler d1 migrations apply html2xtc-aozora-catalog --remote
```

`wrangler.jsonc` の各 `d1_databases` エントリの `migrations_dir`
（`migrations/app/` / `migrations/aozora/`）に対応するSQLが未適用のものだけ順に実行される。
マイグレーションは原則forward-only（実装計画§22の方針）。破壊的変更は新列・新テーブル経由で行う。

## 6. デプロイ手順

`npm run deploy`（= `bash scripts/deploy.sh`）を実行する。このスクリプトは
AGPL-3.0対応（稼働版とpushされたソースの対応をGitタグで担保）のための検証を含む——詳細は
`scripts/deploy.sh` 本体および `claudedocs/deploy-guide.md` を参照。要点のみ:

- 作業ツリーがクリーンで、HEADが `origin/main` にpush済みであることを要求する。
- フロントエンド（`frontend/`）をビルドしてから `wrangler deploy` する。
- 成功後、`deploy-<UTC日時>-<short hash>` の注釈付きタグを作成し `origin` へpushする。

デプロイ前に必要な手動ステップ（初回のみ、または変更時のみ）:

- `npx wrangler secret put SESSION_PEPPER` / `PAIRING_ENCRYPTION_KEY`（本書§2）
- `npx wrangler d1 migrations apply html2xtc-app --remote`（本書§5、未適用のマイグレーションがある場合）
- R2 Lifecycle Rule の確認（本書§4）

## 7. 障害時の基本対応

### D1（APP_DB）障害時

認証系（セッション・端末・ペアリング・ライブラリ）はすべて `APP_DB` に依存するため、
`APP_DB` が利用不能になると以下がすべて機能しなくなる:

- パスキー登録・ログイン（`src/auth/webauthn.ts`、`src/auth/sessions.ts`）
- 既存セッションの検証（`requireSession`）—— 実質的に全ユーザーがログアウト状態と同じ扱いになる
- 端末ペアリング・端末認証・OPDS・ダウンロード（すべて `devices` / `device_pairings` /
  `device_library_items` テーブルへのアクセスが必要）
- 永続ライブラリのCRUD（`library_items`）

一方、**既存の変換API（`POST /convert`, `POST /jobs`, `GET /jobs/:jobId`,
`GET /download/:jobId`, `GET /jobs/:jobId/download`）は `APP_DB` にも `AOZORA_DB` にも
依存しない**——R2とレート制限用Durable Objectのみに依存するため、`APP_DB` 障害時でも
変換機能自体は生存する（ただし変換結果を永続ライブラリへ保存する
`POST /api/library/items/from-job` は失敗する）。

### D1（AOZORA_DB）障害時

青空文庫カタログ検索（`GET /api/books` 等、本機能の対象外）が失敗する。認証・端末・ライブラリ機能
（`APP_DB` 側）には影響しない——2つのD1データベースは完全に独立している（ADR-5参照）。

### レート制限Durable Object障害時

`docs/security-model.md` §6の表のとおり、fail-closed対象（パスキー登録/ログイン開始・
ログイン検証失敗・ペアリング開始・userCode照会・端末認証失敗）は `503 RATE_LIMITER_UNAVAILABLE`
を返してブロックする。既存の変換API（`/convert`, `/jobs`）はfail-openのため引き続き無制限で動作する。

### R2障害時

ダウンロード・OPDSアクイジションリンクの実体取得ができなくなる（`404`や5xx応答）。
D1側の状態（デバイス一覧・ペアリング状態等）は引き続き閲覧・操作できる。

## 8. トラブルシューティング

### 登録失敗

- `400 INVITE_REQUIRED` / `INVALID_INVITE`: 招待トークンが未指定・存在しない・期限切れ
  （7日）・使用済みのいずれか。`scripts/create-invite.mjs` で再発行する。
- `400 REGISTRATION_FAILED`: WebAuthnセレモニー自体の失敗（署名不一致、チャレンジ期限切れ
  [5分]、ブラウザ/認証器側のキャンセル等）。区別できないよう意図的に単一化されているため、
  ユーザーには「もう一度試す」を案内する以外にサーバー側からの切り分け手段はない。
  `wrangler tail` のconsole.errorログ（`registration verification error` 等）でサーバー側の
  詳細を確認できる（クライアントには返さない）。
- `409 CREDENTIAL_ALREADY_REGISTERED`: 同じ認証器（パスキー）が既に別アカウントに登録済み。
- `429` / `503`: レート制限（登録開始10回/時/IP）。`Retry-After` を確認する。

### ペアリング失敗

- 端末側が `pending` から進まない: WebUI側で `GET /api/pairings/by-code/{userCode}` が
  404を返していないか確認する（コード誤入力、10分の期限切れ、既に承認/拒否済みのいずれか
  ——区別なく404）。
- 端末ポーリングが401: `pairingSecret` の不一致、または `pairingId` 自体が存在しない
  （`docs/pairing-protocol.md` §3参照）。ペアリングをやり直す以外の回復手段はない。
- 完了通知(`complete`)が409: 既に `completed` か、まだ `approved` になっていない
  （`docs/device-api.md` §3参照）。二重に呼んでいないか確認する。
- 承認直後に端末が認証情報を取得できない: `PAIRING_ENCRYPTION_KEY` を承認直前後で
  ローテーションしていないか確認する（本書§2「ローテーション手順と影響」参照）。

### OPDS 401

- まず `WWW-Authenticate: Basic realm="html2xtc"` が返っていることを確認し、Basic認証
  ヘッダー自体を送っているか確認する。
- deviceId不明・token不一致・端末revokedのいずれも同じ401で区別できない
  （`docs/security-model.md` §4）。切り分けるには:
  1. `npx wrangler d1 execute html2xtc-app --remote --command "SELECT id, status FROM devices WHERE id = '<deviceId>'"`
     で端末が存在するか・`status = 'active'` かを確認する。
  2. `revoked` であれば新トークンを発行するAPIは存在しない——端末を再ペアリングする以外の
     回復手段はない（`revoked` の端末は一覧からも非表示になる。plan §9.3）。
  3. `active` なのに401が続く場合は保存済み `deviceToken` の破損・取り違えを疑う。
     トークン単体を再発行する手段はないため、WebUIから端末を解除し、端末を再ペアリング
     する（`docs/pairing-protocol.md`）。
- `429`/`503`: 端末認証失敗レート制限（IP＋deviceId、60回/時）に達している可能性。
  `Retry-After` を確認し、それでも続く場合は正しい認証情報を使っているか再確認する
  （誤った認証情報でのリトライがさらに閾値を消費する）。
