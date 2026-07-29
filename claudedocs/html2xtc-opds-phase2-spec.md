# Phase 2 実装仕様書  
## 本家 CrossPoint などの標準 OPDS クライアントを WebUI から手動登録できるようにする

## 1. 目的

`crosspoint-jp` 独自の QR ペアリングを利用できない端末でも、`html2xtc` の端末別 OPDS カタログを利用できるようにする。

ユーザーは WebUI で「標準 OPDS 端末」を登録し、発行された接続情報を本家 CrossPoint の OPDS 設定へ入力する。

登録後の操作は既存の端末連携と共通化する。

```text
端末を登録
  ↓
OPDS 接続情報を発行
  ↓
ライブラリからファイルを選択
  ↓
端末の配信リストへ追加
  ↓
端末で OPDS カタログを開く
  ↓
XTC をダウンロード
```

本フェーズでは、端末ごとの秘密 URL 方式ではなく、既存設計と互換性が高い「共通カタログ URL + 端末別 Basic 認証」を採用する。

---

## 2. 前提

Phase 1 が完了していること。

具体的には以下が成立していること。

- OPDS acquisition link が `application/vnd.xteink.xtc`
- acquisition URL が `/download.xtc`
- 本家 CrossPoint が XTC を一覧表示、ダウンロードできる
- 既存 `crosspoint-jp` との互換性が維持されている

---

## 3. ゴール

WebUI から端末を作成すると、次の接続情報を一度だけ表示する。

```text
表示名: Xteink X3
カタログ URL: https://xtc.hr20k.com/opds/v1/catalog.xml
ユーザー名: <deviceId>
パスワード: <deviceToken>
```

ユーザーは本家 CrossPoint で次を設定する。

```text
Settings
  → System
  → OPDS Servers
  → Add Server
```

入力内容:

```text
Server Name: html2xtc
OPDS Server URL: https://xtc.hr20k.com/opds/v1/catalog.xml
Username: <deviceId>
Password: <deviceToken>
```

以後、その端末は既存の `devices`、`device_library_items`、OPDS、監査、last seen、revoke の仕組みを利用する。

---

## 4. 非ゴール

以下は本フェーズでは実装しない。

- 端末から開始する QR ペアリングの廃止
- `crosspoint-jp` のペアリング方式変更
- パスワードなしの秘密 URL
- OPDS 2.0
- 自動ダウンロード
- Push 配信
- 端末側設定のリモート書き換え
- Range Request
- 端末間の既読同期
- 既存端末 token の一覧表示
- 平文 token の再表示

---

## 5. ユーザーストーリー

## 5.1 標準 OPDS 端末を登録する

1. ユーザーが WebUI にログインする。
2. 「端末」タブを開く。
3. 「標準 OPDS 端末を追加」を押す。
4. 端末名と機種を入力する。
5. 登録を実行する。
6. OPDS 接続情報が表示される。
7. 接続情報を本家 CrossPoint へ入力する。
8. 接続確認を実行する。
9. WebUI の端末一覧に last seen が表示される。

## 5.2 ファイルを端末へ割り当てる

1. ユーザーが「ライブラリ」タブでファイルを選択する。
2. 「端末の配信リストに追加」を押す。
3. 登録済み端末を選ぶ。
4. 端末側で OPDS カタログを開く。
5. 割り当てたファイルが一覧に表示される。

## 5.3 接続情報を紛失した

平文 token は再表示しない。

ユーザーは「接続情報を再発行」を実行する。

- 旧 token は即時失効する。
- 新 token を一度だけ表示する。
- 端末側の OPDS 設定を更新するまで、その端末は利用できない。

---

## 6. 設計方針

## 6.1 端末 ID と token

既存の端末認証方式を利用する。

```text
Username = deviceId
Password = deviceToken
```

要件:

1. `deviceId` は UUID。
2. `deviceToken` は暗号学的乱数から生成する。
3. token は最低 32 byte のランダム値を base64url 化する。
4. DB には token のハッシュのみ保存する。
5. 平文 token は作成・再発行レスポンスで一度だけ返す。
6. token をログ、監査イベント、例外へ含めない。
7. 一覧 API は token を返さない。

## 6.2 接続 URL

MVP では全端末で共通 URL を利用する。

```text
https://xtc.hr20k.com/opds/v1/catalog.xml
```

端末の識別は Basic 認証で行う。

専用 URL 方式は将来拡張とする。

---

## 7. データモデル

既存の `devices` テーブルを利用する。

必要な既存項目の想定:

- `id`
- `account_id`
- `name`
- `status`
- `token_hash`
- `created_at`
- `updated_at`
- `last_seen_at`
- `library_version`
- `device`
- `width`
- `height`

追加を推奨する項目:

```text
registration_method TEXT NOT NULL DEFAULT 'pairing'
```

許容値:

```text
pairing
manual_opds
```

用途:

- WebUI で登録種別を表示する
- 監査、運用、将来の移行で識別する
- QR ペアリング端末と手動登録端末を同じテーブルで扱う

既存行は `pairing` とする。

DB 変更を避けたい場合、Phase 2 MVP では追加しなくてもよい。ただし、運用上の識別性が低くなるため追加を推奨する。

---

## 8. サーバー API

## 8.1 標準 OPDS 端末の作成

追加エンドポイント:

```text
POST /api/devices/manual-opds
```

認証:

- Cookie session 必須
- CSRF 検証必須

リクエスト:

```json
{
  "name": "Xteink X3",
  "deviceModel": "x3",
  "width": 528,
  "height": 792
}
```

フィールド:

| field | 必須 | 説明 |
|---|---:|---|
| name | 必須 | 1〜100文字 |
| deviceModel | 任意 | `x3`、`x4`、`other`、null |
| width | 任意 | 正の整数 |
| height | 任意 | 正の整数 |

機種プリセット:

| deviceModel | width | height |
|---|---:|---:|
| x3 | 528 | 792 |
| x4 | 480 | 800 |

`x3` または `x4` が指定された場合、サーバー側で解像度を正規化してよい。クライアント値を無条件に信用しない。

成功レスポンス:

```json
{
  "device": {
    "id": "uuid",
    "name": "Xteink X3",
    "status": "active",
    "createdAt": "2026-07-29T00:00:00.000Z",
    "lastSeenAt": null,
    "device": "x3",
    "width": 528,
    "height": 792,
    "registrationMethod": "manual_opds"
  },
  "opds": {
    "serverName": "html2xtc",
    "catalogUrl": "https://xtc.hr20k.com/opds/v1/catalog.xml",
    "username": "uuid",
    "password": "base64url-token"
  }
}
```

HTTP status:

```text
201 Created
```

要件:

1. アカウントの端末数上限を既存クォータで検証する。
2. token 生成、ハッシュ化、端末作成は既存ペアリング承認処理と共通化する。
3. token 平文はレスポンス生成後に保持しない。
4. `device.created` または `device.manual_opds.created` の監査イベントを記録する。
5. 監査イベントに token を含めない。
6. 作成時の device library は空。
7. account ownership を必ず設定する。

エラー例:

| status | code | 条件 |
|---:|---|---|
| 400 | INVALID_DEVICE_NAME | name が不正 |
| 400 | INVALID_DEVICE_MODEL | 未対応値 |
| 400 | INVALID_DEVICE_RESOLUTION | 解像度不正 |
| 401 | UNAUTHORIZED | 未ログイン |
| 403 | CSRF_REJECTED | CSRF 不正 |
| 409 | DEVICE_LIMIT_REACHED | 端末上限 |
| 503 | DEVICE_CREATION_DISABLED | 運用上の新規登録停止 |

---

## 8.2 接続情報の再発行

追加エンドポイント:

```text
POST /api/devices/:deviceId/rotate-token
```

認証:

- Cookie session 必須
- CSRF 検証必須

成功レスポンス:

```json
{
  "device": {
    "id": "uuid",
    "name": "Xteink X3",
    "status": "active"
  },
  "opds": {
    "serverName": "html2xtc",
    "catalogUrl": "https://xtc.hr20k.com/opds/v1/catalog.xml",
    "username": "uuid",
    "password": "new-base64url-token"
  }
}
```

要件:

1. 対象端末がログインアカウントの所有物であること。
2. revoked 端末は再発行不可とする。
3. 新 token の保存に成功してから旧 token を無効化する。
4. API 成功後、旧 token は即時利用不可となる。
5. `device.token.rotated` の監査イベントを記録する。
6. token 平文をログへ出さない。
7. レスポンスは `Cache-Control: no-store` を付与する。

---

## 8.3 端末一覧

既存:

```text
GET /api/devices
```

レスポンスへ追加する候補:

```json
{
  "registrationMethod": "manual_opds"
}
```

token や token hash は返さない。

---

## 8.4 既存 revoke

既存:

```text
DELETE /api/devices/:deviceId
```

手動 OPDS 端末にも同じ revoke を適用する。

revoke 後:

- OPDS 認証は 401
- ダウンロードも 401
- WebUI で配信リスト編集を不可にする
- 既存 device library は保持する
- 再有効化は本フェーズの対象外

---

## 9. サーバー実装箇所

対象候補:

```text
html2xtc/src/devices/routes.ts
html2xtc/src/devices/service.ts
html2xtc/src/devices/repository.ts
html2xtc/src/devices/authentication.ts
html2xtc/src/devices/pairings.ts
html2xtc/src/security/audit.ts
html2xtc/src/quotas.ts
html2xtc/migrations/app/*
```

実装方針:

1. token 生成とハッシュ化を `pairings.ts` 固有ロジックのままにしない。
2. 共通モジュールへ抽出する。

例:

```text
src/devices/credentials.ts
```

責務:

- `generateDeviceToken()`
- `hashDeviceToken()`
- `verifyDeviceToken()`
- 必要なら token rotation 用データ生成

3. ペアリング承認と手動 OPDS 端末作成が同じ credential 実装を利用する。
4. DB 書き込みは service 層に置く。
5. route は入力検証、認証、CSRF、レスポンス整形に限定する。

---

## 10. WebUI

## 10.1 端末タブ

対象候補:

```text
html2xtc/frontend/src/components/Devices.svelte
html2xtc/frontend/src/lib/devices.svelte
html2xtc/frontend/src/lib/i18n.*
```

追加ボタン:

```text
標準 OPDS 端末を追加
```

既存の「端末を接続する方法」と併存させる。

推奨 UI:

```text
[端末を接続する方法] [標準 OPDS 端末を追加]
```

---

## 10.2 作成ダイアログ

新規コンポーネント候補:

```text
frontend/src/components/ManualOpdsDeviceDialog.svelte
```

入力項目:

### 端末名

```text
Xteink X3
```

必須。

### 端末モデル

選択肢:

- Xteink X3
- Xteink X4
- その他

モデル選択時の自動入力:

```text
X3: 528 × 792
X4: 480 × 800
```

「その他」の場合だけ width / height を編集可能にする。

### 説明

```text
登録後に表示される OPDS 接続情報を端末へ入力します。
パスワードは一度しか表示されません。
```

送信ボタン:

```text
端末を登録
```

---

## 10.3 接続情報表示ダイアログ

新規コンポーネント候補:

```text
frontend/src/components/OpdsCredentialsDialog.svelte
```

表示項目:

- サーバー名
- カタログ URL
- ユーザー名
- パスワード

各項目にコピーボタンを付ける。

一括コピー:

```text
サーバー名: html2xtc
URL: https://xtc.hr20k.com/opds/v1/catalog.xml
ユーザー名: ...
パスワード: ...
```

警告:

```text
このパスワードはこの画面を閉じると再表示できません。
安全な場所へ保存するか、今すぐ端末へ設定してください。
```

確認チェック:

```text
接続情報を保存しました
```

チェック前は「閉じる」操作時に確認ダイアログを出してよい。

画面を閉じた後に token をフロントエンド state や localStorage へ残さないこと。

---

## 10.4 本家 CrossPoint 向け設定手順

接続情報ダイアログ内に次を表示する。

```text
1. CrossPoint で Settings → System → OPDS Servers を開く
2. Add Server を選ぶ
3. Server Name に「html2xtc」を入力
4. OPDS Server URL に表示された URL を入力
5. Username と Password を入力
6. 保存後、OPDS ライブラリを開く
```

日本語 UI 名が本家で未提供の場合、英語ラベルを優先する。

---

## 10.5 端末一覧

手動登録端末には次を表示する。

```text
Xteink X3
標準 OPDS
528 × 792
最終接続: 未接続
```

行メニュー:

- 名前を変更
- 配信リストを編集
- 接続情報を再発行
- 端末を解除

`接続情報を再発行` は確認を必須とする。

確認文:

```text
再発行すると、現在のパスワードでは接続できなくなります。
端末側の OPDS 設定を更新する必要があります。
```

---

## 10.6 ライブラリ画面

既存の「端末の配信リストに追加」操作をそのまま利用する。

手動 OPDS 端末も、QR ペアリング端末と同じ一覧に表示する。

端末種別によって別 API や別ライブラリを使ってはならない。

---

## 11. セキュリティ要件

1. token は URL に含めない。
2. token は作成・再発行時に一度だけ返す。
3. token を localStorage、sessionStorage、IndexedDB に保存しない。
4. token を console、監査、アクセスログへ出さない。
5. 作成・rotation レスポンスへ `Cache-Control: no-store` を付ける。
6. CSRF 検証を必須とする。
7. 端末数クォータを適用する。
8. token rotation は所有者だけが実行できる。
9. 端末不存在と他アカウント所有を同じ 404 として扱う。
10. revoke 後の token は即時無効。
11. Basic 認証は HTTPS でのみ利用する。
12. WebUI のコピー機能は Clipboard API 失敗時に手動選択へフォールバックする。
13. パスワードを DOM に表示する期間を接続情報ダイアログ表示中だけに限定する。

---

## 12. 競合と整合性

### token rotation

rotation 中に OPDS リクエストが発生した場合、以下を許容する。

- 更新コミット前: 旧 token が成功
- 更新コミット後: 新 token のみ成功

新旧 token の長時間併存は認めない。

### 端末ライブラリ

既存の `library_version` と optimistic lock をそのまま利用する。

手動登録端末専用の競合処理を追加しない。

---

## 13. テスト要件

## 13.1 サーバー単体テスト

### 手動端末作成

- ログイン済み + 正常入力で 201
- token が返る
- DB には token 平文が存在しない
- device status が active
- registration method が manual_opds
- device library が空
- X3/X4 の解像度が正規化される
- 不正な name は 400
- 不正な model は 400
- 不正な resolution は 400
- 未ログインは 401
- CSRF 不正は 403
- 端末上限は 409
- audit event が記録される
- audit に token が含まれない

### token rotation

- 所有端末で成功
- 新 token で OPDS 認証成功
- 旧 token で OPDS 認証失敗
- 他アカウント端末は 404
- revoked 端末は 409 または定義済みエラー
- 未ログインは 401
- CSRF 不正は 403
- no-store ヘッダーあり
- audit event が記録される

### 一覧

- registrationMethod が返る
- token/tokenHash が返らない

---

## 13.2 WebUI テスト

- 端末追加ボタンが表示される
- ダイアログ入力検証
- X3/X4 選択で解像度が自動設定される
- 成功後に接続情報ダイアログが開く
- 各コピーボタンが動作する
- token を閉じた後に再表示できない
- 接続情報再発行の確認が表示される
- rotation 後に新しい接続情報を表示する
- 手動端末をライブラリ追加対象として選べる
- revoked 端末を追加対象から除外する

---

## 13.3 結合テスト

1. WebUI から手動 OPDS 端末を作成する。
2. 発行された URL、username、password で OPDS を取得する。
3. 空フィードが返る。
4. ライブラリ item を端末へ追加する。
5. 同じ credential で再取得する。
6. item が表示される。
7. acquisition URL から XTC を取得する。
8. token rotation する。
9. 旧 credential が 401 になる。
10. 新 credential が成功する。
11. revoke する。
12. 新 credential も 401 になる。

---

## 13.4 実機確認

本家 CrossPoint の XTC/XTCH OPDS 対応ビルドで確認する。

1. OPDS Servers に接続情報を設定できる。
2. カタログを開ける。
3. XTC entry が表示される。
4. XTC をダウンロードできる。
5. ダウンロードした XTC を開ける。
6. WebUI で追加した item が反映される。
7. WebUI で削除した item が次回取得時に消える。
8. token rotation 後は旧設定で認証エラーになる。
9.新設定へ更新すると再び開ける。
10. revoke 後は認証エラーになる。

---

## 14. 実装順序

1. token 生成・検証ロジックを共通モジュールへ抽出する。
2. 必要なら `registration_method` migration を追加する。
3. manual OPDS device 作成 service を実装する。
4. `POST /api/devices/manual-opds` を追加する。
5. token rotation service を実装する。
6. `POST /api/devices/:deviceId/rotate-token` を追加する。
7. devices list DTO を拡張する。
8. サーバー単体テストを追加する。
9. frontend store に create/rotate API を追加する。
10. 手動端末作成ダイアログを追加する。
11. 接続情報表示ダイアログを追加する。
12. 端末一覧へ登録種別、機種、解像度を表示する。
13. token 再発行 UI を追加する。
14. 本家 CrossPoint 向け手順を UI とドキュメントへ追加する。
15. 結合テストを実施する。
16. 実機確認を実施する。

---

## 15. 移行

既存端末に影響を与えてはならない。

### 既存の QR ペアリング端末

- 認証方式を変更しない
- token を再発行しない
- registration method は `pairing`
- 既存の「マイ XTC」を維持する

### 新しい手動 OPDS 端末

- registration method は `manual_opds`
- OPDS URL は既存と同じ
- Basic 認証を利用する
- device library は既存機能を利用する

---

## 16. 専用 URL 方式の将来拡張

本フェーズでは実装しない。

将来、次のような URL-only 接続を追加できる。

```text
https://xtc.hr20k.com/opds/d/{secret}/catalog.xml
```

実装する場合の必須条件:

- secret は最低 128 bit
- DB には hash のみ保存
- URL の再発行と revoke
- アクセスログで secret をマスク
- OPDS feed と download の双方で同じ secret を検証
- Referer を外部へ送らない
- URL-only と Basic のどちらでアクセスしても同じ device principal へ解決する

ただし、URL がそのままパスワードになるため、Basic 認証方式より優先しない。

---

## 17. 受け入れ条件

以下をすべて満たしたら完了とする。

- [ ] WebUI から標準 OPDS 端末を登録できる
- [ ] OPDS 接続情報が一度だけ表示される
- [ ] token 平文が DB、ログ、監査へ残らない
- [ ] 本家 CrossPoint へ接続情報を入力してカタログを開ける
- [ ] ライブラリ item を端末へ追加できる
- [ ] 本家 CrossPoint から XTC をダウンロードして開ける
- [ ] token を再発行できる
- [ ] 再発行後は旧 token が無効
- [ ] revoke 後は接続不可
- [ ] 既存 crosspoint-jp 端末に影響がない
- [ ] 端末数クォータが適用される
- [ ] 自動テストと実機確認が完了している
- [ ] API、運用、ユーザー向け手順が更新されている

---

## 18. Definition of Done

- DB migration
- サーバー API
- token 共通モジュール
- WebUI の端末作成画面
- 一度限りの接続情報表示
- token rotation
- 単体テスト
- 結合テスト
- 本家 CrossPoint 実機確認
- API ドキュメント
- ユーザー向け設定手順
- 監査イベント一覧更新
- 運用手順への token 再発行・端末 revoke 追加
