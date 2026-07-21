# 認証・認可モデル

html2xtc の端末別ライブラリ機能における認証・認可・秘密情報の扱いの横断仕様。
個々のAPIのリクエスト/レスポンス形式は `docs/device-api.md`、ペアリングの状態遷移は
`docs/pairing-protocol.md`、運用手順（鍵ローテーション等）は `docs/operations.md` を参照。

## 1. セッション（Web側、Cookie認証）

実装: `src/auth/sessions.ts`。

- Cookie名: `__Host-html2xtc_session`。属性: `Secure; HttpOnly; SameSite=Lax; Path=/`
  （`__Host-` プレフィックスの要件どおり `Domain` 属性なし）。
- セッショントークン: 32バイトのランダム値（base64url、`randomToken(32)`）。
- 保存形式: 平文トークンはD1に保存しない。`SESSION_PEPPER`（Wrangler secret）と結合して
  `sha256Hex(`${pepper}:${token}`)` した結果だけを `sessions.token_hash` に保存する
  （pepper付きハッシュ）。
- TTL: デフォルト30日（`SESSION_TTL_DAYS` で上書き可、0以下/非数値は既定値にフォールバック）。
- 検証: Cookieのトークンをハッシュ化してD1照合し、`revoked_at IS NULL` かつ
  `expires_at` が未来であることの両方を満たせば有効（`isSessionValid`）。
- 失効: ログアウト（`POST /api/auth/logout`）でトークン一致行の `revoked_at` を設定。
  `GET /api/me/sessions` で自アカウントの有効セッション一覧を取得でき、
  `DELETE /api/me/sessions/{sessionId}` で個別に失効できる（`account_id` でスコープ、
  他アカウントのセッションは失効できない）。
- セッショントークンはレスポンスJSONに一切含まれない。常に `Set-Cookie` のみで渡す。

## 2. CSRF対策

実装: `src/auth/csrf.ts`。すべての「Cookie認証で状態変更するAPI」（POST/PATCH/PUT/DELETE）に
`verifyCsrf` を適用する。判定は3つ:

1. `Sec-Fetch-Site` が送られている場合、値は `same-origin` または `none` のみ許可
   （`cross-site`/`same-site` は拒否）。
2. `Origin` ヘッダーが必須。値は `WEBAUTHN_ORIGIN`（env var）と完全一致すること。
   `WEBAUTHN_ORIGIN` 未設定時はfail-closed（拒否）。
3. `Content-Type` が `application/json` で始まること。

いずれか不一致なら `403 CSRF_REJECTED`。ログイン確立前の `POST /api/auth/registration/verify` /
`POST /api/auth/login/verify` にもこのチェックを適用している——これらは「ログイン済みでない」
リクエストだが、成功するとセッションを新規発行するため、CSRFで攻撃者のアカウントへ
セッション固定させる攻撃（login CSRF）を防ぐ目的で同じチェックをかけている。

## 3. WebAuthn（パスキー）検証

実装: `src/auth/webauthn.ts` + `src/auth/challenges.ts`。`@simplewebauthn/server` を使用。

- 登録・ログインとも `userVerification: "required"`。登録は `residentKey: "required"`
  （Discoverable Credential必須）。ログインの `allowCredentials` は省略し、プラットフォームの
  Discoverable Credentialピッカーに任せる。
- チャレンジ: 256ビットランダム値を発行し、`sha256Hex` したものだけを
  `auth_challenges.challenge_hash` に保存（平文は保存しない）。TTL 5分。
- 一回性: `consumeChallenge` は「未消費かつ未期限切れ」を読み取り確認した後、
  `UPDATE ... WHERE consumed_at IS NULL` で原子的に消費済みへ遷移させる
  （同時に複数リクエストが同じチャレンジを使おうとしても1つしか成功しない）。
- 検証: `expectedOrigin`（`WEBAUTHN_ORIGIN`）、`expectedRPID`（`WEBAUTHN_RP_ID`）、
  `expectedChallenge` を厳密に照合。登録・ログインとも失敗理由（署名不一致／チャレンジ期限切れ／
  invite競合等）を区別しない単一のエラー（登録: `400 REGISTRATION_FAILED`、
  ログイン: `401`）を返す。
- 新規アカウント登録は招待（invite）消費・アカウント作成・クレデンシャル登録を1つのD1バッチで
  原子的に行う（`runNewAccountRegistrationBatch`）。クレデンシャル重複時は
  `409 CREDENTIAL_ALREADY_REGISTERED`。invite消費が競合で失敗した場合は作成済みアカウントを
  ロールバック削除する。

## 4. 端末認証（Basic認証）

実装: `src/devices/authentication.ts`。

- `Authorization: Basic base64(deviceId:deviceToken)`。
- `deviceToken` の検証は `sha256Hex(deviceToken)` を `devices.token_hash` と
  `timingSafeEqual` で比較（pepperなし——`deviceToken` 自体が256ビットの高エントロピー値のため、
  ユーザー選択パスワード向けのpepperは付与していない）。
- `status !== 'active'`（revoked含む）の端末は認証失敗として扱う。
- 失敗理由（ヘッダー欠如・base64不正・deviceId不明・token不一致・revoked）はすべて同一の
  `401 UNAUTHORIZED` を返し、区別しない（deviceIdの存在有無を外部から判別できないようにする）。

## 5. スコープ規則

- **devices**: すべて `account_id` でスコープする。`getDeviceById` は
  `WHERE id = ? AND account_id = ?` で取得するため、他アカウントの `deviceId` を知っていても
  到達できない。
- **library_items**: `account_id` でスコープ（`src/library/repository.ts`、本文書の対象外だが
  同じ原則）。
- **device_library_items（配信リスト）**: `PUT /api/devices/{deviceId}/library` は
  (1) `deviceId` がリクエスト元アカウントの所有であること（`requireOwnedDevice`）、
  (2) 割り当てようとする各 `itemId` がリクエスト元アカウント所有かつ未削除であること
  （`countAccountOwnedItems`）、の両方を満たさない限り `403 ITEM_NOT_OWNED` になる。
- **device_pairings（ペアリング中）**: `pairingId` はアカウントに紐付かない
  （承認されるまで `account_id` は `NULL`）。ただし承認・拒否操作自体はCookieセッションが
  必要で、承認したアカウントの `account_id` がその場で書き込まれる。
- **セッション**: `revokeSessionById` は `account_id` でスコープし、他アカウントのセッションは
  失効できない。

## 6. レート制限表（実装値）

実装: `src/ratelimit.ts`（純粋ロジック）、`src/ratelimiter.ts`（Durable Object・ゲート関数）。
キーはIPアドレス単位（IPv4はフルアドレス、IPv6は/64プレフィックス）。固定ウィンドウ方式
（`RATE_LIMIT_WINDOW_MS = 1時間`）。

| 対象 | purpose キー | キー粒度 | 上限 | 障害時挙動 |
|---|---|---|---:|---|
| パスキー登録開始 (`POST /api/auth/registration/options`) | `auth.registration.start` | IP | 10回/時 | fail-closed（`503`） |
| パスキーログイン開始 (`POST /api/auth/login/options`) | `auth.login.start` | IP | 30回/時 | fail-closed（`503`） |
| ログイン検証失敗 (`POST /api/auth/login/verify` 失敗時のみ計上) | `auth.login.verify_failed` | IP | 30回/時 | fail-closed（`503`） |
| ペアリング開始 (`POST /api/device-pairings`) | `device.pairing.start` | IP | 20回/時 | fail-closed（`503`） |
| userCode照会 (`GET /api/pairings/by-code/:userCode`) | `device.pairing.lookup` | IP | 60回/時 | fail-closed（`503`） |
| 端末認証失敗 (OPDS・ダウンロード) | `device.auth.failed` | IP＋deviceId（claimed） | 60回/時 | fail-closed（`503`） |
| 既存の変換API (`POST /convert`, `POST /jobs`) | (プレフィックス無し) | IP | `RATE_LIMIT_PER_HOUR`（既定50）/時 | **fail-open**（無制限） |

- fail-closed 対象はレート制限バックエンド（Durable Object）障害時に `503 RATE_LIMITER_UNAVAILABLE`
  （`Retry-After: 5`）を返し、リクエストをブロックする。
- 既存の変換API（`/convert`, `/jobs`）だけは可用性優先でfail-open（障害時は無制限で通す）——
  この方針は本機能追加以前からの既存動作で、変更していない。
- OPDS取得成功・ダウンロード成功には専用のレート制限が無い（実装計画§13が挙げていた
  「XTCダウンロード: 高めの上限」は未実装。成功リクエストはOPDS/ダウンロードとも無制限で、
  失敗（端末認証失敗）だけが `device.auth.failed` でカウントされる）。
- IPアドレスが取得できない場合（`CF-Connecting-IP` 欠如。ローカル `wrangler dev` 等）は
  全てのレート制限がスキップされる——本番のCloudflareエッジでは発生しない。

## 7. 監査ログ

実装: `src/security/audit.ts`（`logAuditEvent`）。1イベント1行のJSON（`console.log`）。
呼び出し箇所は `grep -rn "logAuditEvent(" src/` で確認できる。

### 実装済みのイベント

| event | フィールド |
|---|---|
| `auth.login.failed` | (フィールドなし) |
| `auth.login.succeeded` | `accountId` |
| `library.item.created` | `accountId`, `itemId` |
| `library.item.deleted` | `accountId`, `itemId` |
| `device.pairing.approved` | `accountId`, `deviceId`, `pairingId` |
| `device.revoked` | `accountId`, `deviceId` |
| `device.library.updated` | `accountId`, `deviceId`, `version`, `itemCount` |
| `device.opds.fetched` | `accountId`, `deviceId`, `page`, (検索時のみ)`search: 1` |
| `device.download.completed` | `accountId`, `deviceId`, `itemId`, `sizeBytes` |

**実装計画で挙げられていたが未実装のイベント**（`auth.registration.completed` /
`auth.session.revoked` / `device.pairing.created` / `device.registered` /
`device.token.rotated`）は現時点のコードには存在しない。監査ログを前提にした運用・分析を
行う場合はこの欠落を踏まえること。

### 禁止フィールド

`logAuditEvent` の型シグネチャがコンパイル時に以下のキー名を拒否する（`ForbiddenAuditKey`）:

```text
deviceToken, pairingSecret, sessionToken, sessionCookie, cookie,
authorization, challenge, inviteToken, password, token
```

これは名前ベースのガードであり内容スキャナーではない——別名のキーに秘密情報を詰めて渡すことは
型システム上防げない。現状のすべての呼び出し箇所はID・件数・バイト数のみを渡している。

## 8. 秘密情報の保存方針

| 値 | 平文で存在する場所 | 永続保存される形 |
|---|---|---|
| セッショントークン | `Set-Cookie` レスポンス・ブラウザのCookieジャーのみ | `sha256Hex(pepper:token)`（`sessions.token_hash`） |
| deviceToken | ペアリング承認直後の暗号化前のみ（サーバー内メモリ）／端末側の恒久保存 | `sha256Hex(token)`（`devices.token_hash`、pepperなし） |
| deviceToken（受け渡し中） | 端末が復号するまでの間 | AES-GCM暗号文 + IV + 認証タグ（`device_pairings.encrypted_device_token`/`token_iv`/`token_auth_tag`、鍵は`PAIRING_ENCRYPTION_KEY`） |
| pairingSecret | ペアリング開始時のレスポンス・端末側保持のみ | `sha256Hex(secret)`（`device_pairings.pairing_secret_hash`） |
| 招待トークン (inviteToken) | `scripts/create-invite.mjs` の標準出力に一度だけ | `sha256Hex(token)`（`registration_invites.token_hash`、pepperなし） |
| WebAuthnチャレンジ | ブラウザ⇔認証器間のセレモニー中のみ | `sha256Hex(challenge)`（`auth_challenges.challenge_hash`） |
| WebAuthn公開鍵 | — | 平文BLOB（`webauthn_credentials.public_key`）——公開鍵なので暗号化不要 |

**注記（既知の乖離）**: `src/types.ts` の `Env` インターフェースには `REGISTRATION_INVITE_SECRET`
というシークレットが宣言されており、`wrangler.jsonc` のコメントにも言及があるが、実際の招待検証
（`scripts/create-invite.mjs` / `src/auth/repository.ts` の `findInviteByTokenHash`）は
単純な `sha256Hex(token)` のみで、この secret は一切参照されていない（デッドコード）。
削除するか実際にpepperとして組み込むかは今後の判断事項。
