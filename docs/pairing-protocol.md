# ペアリングプロトコル詳細

CrossPoint (Xteink) 端末と html2xtc アカウントを結びつける「ペアリング」の内部仕様。
実装: `src/devices/pairings.ts`（状態遷移・暗号化受け渡し）、`src/devices/routes.ts`（HTTPアダプタ）、
`src/security/aes-gcm.ts`（トークン暗号化）。エンドポイントのリクエスト/レスポンス形式は
`docs/device-api.md` を参照。

## 1. シーケンス

```text
Xteink                         html2xtc                         スマホ(WebUI)
  │                               │                               │
  │ POST /api/device-pairings     │                               │
  ├──────────────────────────────>│                               │
  │ {pairingId, pairingSecret,    │                               │
  │  userCode, verificationUri,   │                               │
  │  expiresAt, pollIntervalSeconds}                              │
  │<──────────────────────────────┤                               │
  │                               │                               │
  │ userCode + verificationUriの  │                               │
  │ QRコードを画面に表示           │                               │
  │                               │                               │
  │                               │<──── QRを読む/URLを開く ───────┤
  │                               │      (?pair=ABCD-EFGH)         │
  │                               │                               │
  │                               │ パスキーでログイン (未ログインなら)│
  │                               │<───────────────────────────────┤
  │                               │                               │
  │                               │ GET /api/pairings/by-code/ABCD-EFGH
  │                               │<───────────────────────────────┤
  │                               │ {pairingId, requestedName, expiresAt}
  │                               ├───────────────────────────────>│
  │                               │                               │
  │                               │ POST /api/pairings/{id}/approve│
  │                               │ {name: "端末名"}               │
  │                               │<───────────────────────────────┤
  │                               │ {device: {id, name, status,    │
  │                               │           createdAt}}          │
  │                               ├───────────────────────────────>│
  │                               │                               │
  │ GET /api/device-pairings/{id} │ (pollIntervalSeconds間隔で継続)│
  │ Authorization: Pairing <secret>                                │
  ├──────────────────────────────>│                               │
  │ {status:"pending"}            │                               │
  │<──────────────────────────────┤                               │
  │  ...(承認されるまで繰り返し)... │                               │
  │ GET /api/device-pairings/{id} │                               │
  ├──────────────────────────────>│                               │
  │ {status:"approved",           │                               │
  │  deviceId, deviceToken}       │                               │
  │<──────────────────────────────┤                               │
  │                               │                               │
  │ deviceId/deviceTokenを        │                               │
  │ 端末側ストレージに保存         │                               │
  │                               │                               │
  │ POST /api/device-pairings/{id}/complete                       │
  │ Authorization: Pairing <secret>                                │
  ├──────────────────────────────>│                               │
  │ {status:"completed"}          │                               │
  │<──────────────────────────────┤                               │
  │                               │ (encrypted_device_token等を削除)│
```

以降、端末は `Authorization: Basic base64(deviceId:deviceToken)` で OPDS・ダウンロードを呼ぶ
（`docs/device-api.md` §4〜6）。

## 2. userCode の形式

`src/devices/pairings.ts` の `generateUserCode` / `normalizeUserCode`。

- アルファベット: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（32文字）。`O`/`0`、`I`/`1` を除外し、
  視認しやすい文字だけを使う。
- 長さ: 8文字を `XXXX-XXXX` の形（ハイフン区切り）に整形して発行・保存する。
- 生成: `crypto.getRandomValues` で得た乱数バイトを `& 0x1f` でアルファベットの32要素へ
  マスクする（32は2の冪なので剰余バイアスが生じない）。
- 入力側の正規化（WebUIでユーザーが手入力する場合）: 大文字小文字を区別しない、ハイフンは
  あってもなくてもよい。正規化後にアルファベット外の文字が含まれる場合、またはハイフン除去後の
  長さが8文字でない場合は「見つからない」扱い（`404 PAIRING_NOT_FOUND`）にする——存在しないコードと
  区別しない。
- 一意性: `device_pairings.user_code` に `UNIQUE` 制約。衝突時は最大10回まで新しいコードで
  再試行する（`startPairing` のリトライループ）。

## 3. pairingSecret の扱い

- 生成: `randomToken(32)`（256ビット、base64url）。
- 保存: 平文はどこにも保存しない。`sha256Hex` でハッシュ化した `pairing_secret_hash` のみを
  `device_pairings` に保存する。
- 提示: `POST /api/device-pairings` の応答で端末にだけ一度返す。QRコードにも画面表示にも
  含めない（QRコードには `verificationUri` だけを埋め込む）。
- 使用: 端末は以降のポーリング(`GET /api/device-pairings/{id}`)と完了通知
  (`POST /api/device-pairings/{id}/complete`)で `Authorization: Pairing <pairingSecret>` として送る。
- 検証: `verifyPairingSecret` が受け取った値をハッシュ化し、保存済み `pairing_secret_hash` と
  `timingSafeEqual` で比較する（タイミング攻撃対策）。不一致・ヘッダー欠如ともに同じ401
  (`UNAUTHORIZED`) を返し、区別できない。

## 4. 状態遷移

`device_pairings.status` は `pending` / `approved` / `rejected` / `completed` / `expired` の
いずれか（`CHECK` 制約、`migrations/app/0001_initial.sql`）。ただし `expired` はDBへ物理的に
書き込まれる値ではなく、`pending` のまま `expires_at` を過ぎた行を読み取り時に仮想的に
`expired` として扱う（`decidePairingStatus`、`src/devices/pairings.ts`）——`pending` 以外の状態
（`approved`/`rejected`/`completed`）は `expires_at` に関わらずそのまま返る。

```text
        ┌──────────┐
        │ pending  │──expires_at経過(読み取り時に仮想化)──> [expired]
        └────┬─────┘
             │approve (POST /api/pairings/:id/approve)
             │  条件: status='pending' AND expires_at > now (DB上で二重チェック)
             ▼
        ┌──────────┐
        │ approved │
        └────┬─────┘
             │complete (POST /api/device-pairings/:id/complete)
             │  条件: status='approved'
             ▼
        ┌───────────┐
        │ completed │  (encrypted_device_token/token_iv/token_auth_tagをNULLへ)
        └───────────┘

pending から reject (POST /api/pairings/:id/reject) でも遷移する:
        pending ──reject──> rejected
          条件: status='pending' AND expires_at > now
```

- **承認 (`approvePairingRow`)**: `status='pending' AND expires_at > now` を条件にした
  `UPDATE ... WHERE` で原子的に遷移させる。この条件チェックとアプリ側の事前チェック
  (`isPairingApprovable`) の間の競合を閉じるための「二重チェック」で、二重承認・期限切れ承認・
  reject後の承認を防ぐ（同じ形の対策が `consumeChallenge` にもある）。負けた場合、直前に
  作成した `devices` 行はロールバック（`hardDeleteDevice`）される。
- **拒否 (`rejectPairingRow`)**: 同様に `status='pending' AND expires_at > now` が条件。
- **完了 (`completePairingRow`)**: `status='approved'` が条件。
- **承認・拒否ともに、`pending` 以外からの呼び出しは同じ `409 PAIRING_NOT_PENDING`**
  （完了だけは `409 PAIRING_NOT_APPROVED`）。

## 5. 有効期限

- ペアリング全体の有効期限: 発行から **10分**（`PAIRING_TTL_MS = 10 * 60 * 1000`）。
  `approved`/`rejected`/`completed` に遷移した後は、この期限は判定に使われなくなる
  （`decidePairingStatus` は `pending` の行にだけ期限切れ判定を適用する）。
- 期限切れの行は日次のクリーンアップで物理削除される（`src/db/cleanup.ts`、既存の
  日次Cron 18:30 UTC に相乗り）: `expires_at` を過ぎた行はステータスを問わず削除される。
  承認後に完了通知が来ないまま放置された `approved` 行の暗号化トークン材料
  (`encrypted_device_token` 等) も、この削除により `expires_at`（発行から10分）を超えて
  最長でも次回Cronまでしか残らない（実装計画 §6「完了通知がなくてもペアリング期限後に削除」に対応）。
  `completed`/`rejected`/`expired` の行は7日経過後に削除される。読み取り時には従来どおり
  `decidePairingStatus` が期限切れ `pending` を `expired` として見せる（Cron前でも取得不可）。

## 6. 暗号化されたトークン受け渡しの仕組み

平文の `deviceToken` を D1 へ永続的に置く期間を最小化するための仕組み（ADR-7、
`docs/device-library-adr.md` 参照）。

1. `POST /api/pairings/{id}/approve`（Web側、Cookieセッション）で `deviceToken` を新規生成
   （`randomToken(32)`）。
2. `devices.token_hash` へその SHA-256 ハッシュを永続保存（以降のBasic認証で使う正本）。
3. `PAIRING_ENCRYPTION_KEY`（base64エンコードされた256ビット鍵、Wrangler secret）で
   `deviceToken` の平文をAES-GCM暗号化する（`encryptWithPairingKey`、`src/security/aes-gcm.ts`）。
   IVは96ビットのランダム値、認証タグは128ビット（WebCryptoのデフォルト）。
4. 暗号文・IV・認証タグをそれぞれ `device_pairings.encrypted_device_token` /
   `token_iv` / `token_auth_tag`（すべてBLOB列）へ保存し、同じUPDATEで
   `status='approved'` に遷移させる。
5. 端末は `GET /api/device-pairings/{id}` のポーリングで、`pairingSecret` の検証に成功すると
   `decryptWithPairingKey` で復号された平文 `deviceToken` を受け取る。
6. 端末が `POST /api/device-pairings/{id}/complete` を呼ぶと、暗号文・IV・認証タグは
   `NULL` にクリアされる（`completePairingRow`）。

この構造により、通信途中で端末が再起動しても、有効期限内（`approved` である限り）は
再度ポーリングして同じ `deviceToken` を再取得できる——暗号文は完了通知が来るまで消えない。
鍵 (`PAIRING_ENCRYPTION_KEY`) のローテーション手順・影響範囲は `docs/operations.md` を参照。
