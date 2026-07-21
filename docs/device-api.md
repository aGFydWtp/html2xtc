# 端末（CrossPoint）向け API 仕様

CrossPoint (Xteink) 実機から呼び出す html2xtc の全エンドポイントの仕様。
実装: `src/devices/routes.ts`（ペアリング3エンドポイント）、`src/opds/routes.ts`（OPDS・ダウンロード）。
ペアリングの状態遷移やシーケンスの詳細は `docs/pairing-protocol.md` を、認証・レート制限・監査ログの
横断的な仕様は `docs/security-model.md` を参照。

すべての日時は UTC の ISO-8601 文字列（`...Z`）。エラーボディは共通で
`{"error":{"code":"...","message":"..."}}`（`message` に内部詳細は含まれない）。

## 1. ペアリング開始（端末発行）

```
POST /api/device-pairings
Content-Type: application/json

{"requestedName": "任意の端末名(省略可、文字列)"}
```

認証不要。呼び出し元はレート制限のみで保護される（§5参照）。

成功応答 `201 Created`:

```json
{
  "pairingId": "uuid",
  "pairingSecret": "base64url、32バイト由来の高エントロピー値",
  "userCode": "ABCD-EFGH",
  "verificationUri": "https://xtc.hr20k.com/?pair=ABCD-EFGH",
  "expiresAt": "2026-07-21T01:00:00.000Z",
  "pollIntervalSeconds": 5
}
```

- `pairingSecret` は以降の2エンドポイント（poll / complete）で
  `Authorization: Pairing <pairingSecret>` として送る。QRコードや画面には出さない。
- `verificationUri` だけを QR コードに埋め込む。
- 有効期限は発行から10分固定（`PAIRING_TTL_MS`）。
- `pollIntervalSeconds` は5固定。

エラー:

| status | code | 状況|
|---:|---|---|
| 400 | `INVALID_REQUESTED_NAME` | `requestedName` が文字列でない |
| 400 | `INVALID_JSON` | リクエストボディがJSONでない/オブジェクトでない |
| 429 | `RATE_LIMITED` | IPあたり20回/時を超えた |
| 503 | `RATE_LIMITER_UNAVAILABLE` | レート制限バックエンド障害中（fail-closed） |

## 2. ペアリング状態のポーリング（端末発行）

```
GET /api/device-pairings/{pairingId}
Authorization: Pairing <pairingSecret>
```

成功応答 `200 OK`。`status` により応答形が変わる:

```json
{"status": "pending"}
```
```json
{"status": "rejected"}
```
```json
{"status": "expired"}
```
```json
{"status": "completed"}
```
```json
{
  "status": "approved",
  "deviceId": "uuid",
  "deviceToken": "base64url、以降のBasic認証で使う平文トークン"
}
```

- `approved` になって初めて `deviceId` / `deviceToken` を含む。それ以外の状態では2フィールドとも省略される。
- `deviceToken` はこの応答でしか得られない。取得後は端末側で安全に保存し、以降は
  `Authorization: Basic base64(deviceId:deviceToken)` で使う（`docs/security-model.md` §3参照）。
- 推奨ポーリング間隔: `pollIntervalSeconds`（5秒）。承認されるまでこのエンドポイントを呼び続ける。

エラー:

| status | code | 状況 |
|---:|---|---|
| 401 | `UNAUTHORIZED` | `Authorization: Pairing <secret>` ヘッダーが無い/形式不正 |
| 401 | `UNAUTHORIZED` | `pairingSecret` が該当 `pairingId` のものと一致しない |
| 404 | `PAIRING_NOT_FOUND` | `pairingId` が存在しない |

`Authorization` ヘッダー欠如・形式不正の場合と、値が一致しない場合はいずれも「ペアリング secret が必要です」
「不正な pairing secret です」という区別のつきにくい 401 を返す（`src/devices/routes.ts` の
`requirePairingSecret` / `src/devices/pairings.ts` の `verifyPairingSecret`）。

## 3. ペアリング完了通知（端末発行）

```
POST /api/device-pairings/{pairingId}/complete
Authorization: Pairing <pairingSecret>
```

`deviceToken` を保存し終えたら必ず呼ぶ。呼ぶことで `device_pairings` 上の暗号化トークン材料
（`encrypted_device_token` / `token_iv` / `token_auth_tag`）が削除される（保持期間の最小化）。

成功応答 `200 OK`:

```json
{"status": "completed"}
```

エラー:

| status | code | 状況 |
|---:|---|---|
| 401 | `UNAUTHORIZED` | `Authorization: Pairing` ヘッダー欠如/不一致（§2と同じ） |
| 404 | `PAIRING_NOT_FOUND` | `pairingId` が存在しない |
| 409 | `PAIRING_NOT_APPROVED` | ペアリングが `approved` 状態でない（まだ承認されていない/既に completed/rejected/expired、または同時実行で先に complete された） |

冪等ではない: 2回目以降の呼び出しは `409 PAIRING_NOT_APPROVED` になる（1回目で状態が `completed` に
変わっているため）。既に `completed` の場合、端末側の実装は「成功したこと」として扱ってよい
（トークンは既に取得済みのはずなので実害はない）。

## 4. OPDS ルートフィード

```
GET /opds/v1/catalog.xml?page=1
Authorization: Basic base64(deviceId:deviceToken)
```

端末Basic認証必須。詳細な要素・namespace・ページング仕様は `docs/opds-profile.md` を参照
（本書はエンドポイント一覧としての位置づけ）。

- `page` 省略時は `1`。1ページ100件固定。
- 成功応答 `200 OK`、`Content-Type: application/atom+xml;charset=utf-8`。
- 副作用: 成功すると当該端末の `last_seen_at` が更新される（直近5分以内に更新済みならスキップ）。

## 5. OPDS 検索フィード

```
GET /opds/v1/search.xml?q={searchTerms}&page=1
Authorization: Basic base64(deviceId:deviceToken)
```

- 検索対象はタイトル・著者・元URLの部分一致（`src/opds/repository.ts`）。範囲は当該端末に
  割り当て済みかつ削除されていない item のみ。
- `q` が空/未指定なら D1 へ問い合わせず空フィードを返す（`200`）。
- ページングは §4 と同じ。

## 6. XTC ダウンロード

```
GET /api/device/library-items/{itemId}/download
Authorization: Basic base64(deviceId:deviceToken)
```

成功応答 `200 OK`:

```
Content-Type: application/octet-stream
Content-Length: <bytes>
Content-Disposition: attachment; filename="<ASCII fallback>.xtc"; filename*=UTF-8''<RFC5987エンコードされたタイトル>.xtc
ETag: "<r2 object etag>"
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
```

ボディは R2 オブジェクトのバイト列そのもの（ストリーミング転送）。副作用は §4 と同じ
last_seen_at 更新。Range Request には未対応（実装計画は「初期リリースの必須要件としない」としており、
現状のコードにも Range 処理はない）。

## 7. OPDS・ダウンロード共通のエラーコード

| status | code | 状況 |
|---:|---|---|
| 400 | `INVALID_PAGE` | `page` が正の整数でない（`0`・負数・小数・非数値） |
| 401 | `UNAUTHORIZED` | Basic 認証失敗（ヘッダー欠如・base64不正・deviceId不明・token不一致・端末revokedのいずれも区別しない）。応答に `WWW-Authenticate: Basic realm="html2xtc"` を付与 |
| 404 | `ITEM_NOT_FOUND` | `itemId` が当該端末に未割り当て・他端末のもの・削除済み・R2オブジェクト欠落のいずれか（区別しない） |
| 429 | `RATE_LIMITED` | 端末認証失敗が閾値超過（IP＋deviceId、60回/時） |
| 503 | `RATE_LIMITER_UNAVAILABLE` | レート制限バックエンド障害中（fail-closed） |

OPDS取得・ダウンロードの**成功**に対するレート制限は無い（失敗のみカウント、実装計画§13が挙げていた
「XTCダウンロード: 高めの上限」の専用リミッターは未実装 — ダウンロード成功はOPDS取得成功と同様、
無制限）。

## 8. レート制限一覧（端末が関わるもの）

| 対象 | キー | 上限 | 障害時挙動 |
|---|---|---:|---|
| ペアリング開始（`POST /api/device-pairings`） | IP | 20回/時 | fail-closed（`503`） |
| 端末認証失敗（OPDS・ダウンロード・後述） | IP＋deviceId | 60回/時 | fail-closed（`503`） |

`docs/security-model.md` にAPI全体（Web側も含む）のレート制限表がある。

## 9. タイムアウト・リトライの推奨

コード上に明示のサーバー側タイムアウト設定は無い（Cloudflare Workers のCPU/wall時間上限に従う）。
CrossPoint側の実装として以下を推奨する（実装計画§15.1/§15.2に基づく）。

- **TLS証明書検証を必ず有効にする**（`setInsecure()` 相当の無効化を行わない）。`deviceToken` は
  平文HTTPでは絶対に送らない。
- **ペアリングポーリング**: `pollIntervalSeconds`（5秒）間隔。`pending` の間は待機を継続し、
  `expiresAt`（10分後）を過ぎたら諦めてユーザーに再試行を促す。
- **OPDS/ダウンロードのHTTPタイムアウト**: 数十秒程度の妥当なクライアント側タイムアウトを設定し、
  タイムアウトやネットワークエラー時は指数バックオフで再試行する。`429`/`503` を受けた場合は
  `Retry-After` ヘッダーの秒数だけ待ってから再試行する。
- **ダウンロード失敗時**: `.part` 拡張子等で保存し、完了時にリネームする（不完全ファイルを
  正式なファイル名で残さない）。
- **401を受けた場合**: 再ペアリングが必要（保存済みの `deviceId`/`deviceToken` を破棄し、
  ユーザーに新しいペアリングを促す）。トークン不一致・端末revoked・deviceId不明のいずれも
  同じ401で区別できないため、リトライで解決しない401は再ペアリング一択とする。
