# ADR: 端末別ライブラリ機能の設計判断

実装計画（`/Users/haruki/Downloads/html2xtc-device-library-implementation-plan.md`）に基づき実装した、
アカウント／端末／端末別配信リスト機能の主要な設計判断とその理由。各判断は実装済みのコードを正とする。

## ADR-1: Web側の認証はパスキー（WebAuthn）

**採用**: `src/auth/webauthn.ts` + `src/auth/sessions.ts`。`residentKey: "required"` /
`userVerification: "required"` で Discoverable Credential を要求し、成功時に
`__Host-html2xtc_session` Cookie（Secure/HttpOnly/SameSite=Lax）を発行するセッション認証へ切り替える。

**検討した代替案**:
- メール＋パスワード: パスワード漏洩・使い回し・ブルートフォースの対策コストが継続的にかかる。個人〜少数運用のスコープに対して過剰。
- メールリンク（マジックリンク）: メール到達性・フィッシング耐性の運用負荷が生じる。
- OAuth（Google 等）への委任: 外部IdP依存が増え、個人運用のシンプルさを損なう。

**採用理由**: フィッシング耐性が高く、パスワード管理そのものが不要になる。個人〜少人数利用の
スコープでは実装・運用コストと安全性のバランスが良い。`@simplewebauthn/server` で実装コストも小さい。

## ADR-2: 端末（CrossPoint）側は deviceId + ランダムトークンの Basic 認証

**採用**: `src/devices/authentication.ts`。`Authorization: Basic base64(deviceId:deviceToken)` を
`devices.token_hash`（SHA-256、pepper なし）と比較する `BasicDeviceTokenAuthenticator`。

**検討した代替案**:
- Ed25519 署名リクエスト認証: 鍵ペア生成・署名検証の実装コストが高く、CrossPoint（組み込み）側の対応工数も大きい。
- WebAuthn を端末側にも拡張: 組み込み機器では実用的な認証器がなく非現実的。
- 固定APIキーのみ（端末識別なし）: 端末ごとの失効・スコープ分離ができない。

**採用理由**: 組み込みHTTPクライアントで実装しやすい標準的な方式。deviceToken は256ビットのランダム値で
既に高エントロピーなため、ユーザー選択パスワードのような pepper 付きハッシュは不要と判断（`src/devices/authentication.ts`
のコメント参照）。`DeviceAuthenticator` インターフェースで抽象化してあり、将来 Ed25519 方式に差し替え可能な
構造にしてある（`authenticateDevice()` はまだこの1認証器しか呼んでいない）。

## ADR-3: OPDS は 1.x（Atom）、2.0（JSON）は提供しない

**採用**: `src/opds/feed.ts` / `src/opds/xml.ts`。`application/atom+xml` の OPDS 1.x フィードのみ。

**検討した代替案**: OPDS 2.0（JSON-based）。仕様としては新しいが、CrossPoint（Xteink機器）の既存
OPDSパーサーが Atom ベースであるため、2.0 を実装しても端末側が読めない。

**採用理由**: 端末側の既存実装との互換性を最優先。新しい規格を採用する価値より、実機で動くことを優先した。

## ADR-4: D1 の中間テーブル（`device_library_items`）で端末別空間を表現

**採用**: `migrations/app/0001_initial.sql` の `device_library_items(device_id, library_item_id, position, added_at)`。
実体（`library_items` / R2オブジェクト）は1つのアカウントに1つだけ存在し、どの端末にどの item を
「配信するか」だけをこの中間テーブルが持つ。`devices.library_version` を楽観ロックのバージョン番号として使う
（`src/devices/service.ts` の `replaceDeviceLibrary` / `src/devices/repository.ts` の
`incrementDeviceLibraryVersion`）。

**検討した代替案**:
- 端末ごとにR2オブジェクトを複製: ストレージ容量が端末数倍になり、削除・更新の伝播も複雑化する。
- アカウント全体で1つの共通ライブラリ（端末別配信リストなし）: 実装計画の主要な要求（端末ごとに異なるXTC一覧）を満たせない。

**採用理由**: ストレージは常に1コピーのみ保持しつつ、「どの端末に何を配信するか」という関係だけを
D1の軽量な行で表現できる。削除時は `device_library_items` からのfan-out削除＋各端末の
`library_version` インクリメントで、配信中だった端末に「一覧が変わった」ことを伝播できる
（`src/library/service.ts` の `deleteLibrary` → `removeItemFromAllDeviceLibraries` /
`bumpLibraryVersionForDevices`）。

## ADR-5: `AOZORA_DB` と `APP_DB` を分離した2つのD1データベース

**採用**: `wrangler.jsonc` の `d1_databases` に `AOZORA_DB`（青空文庫カタログ、`migrations/aozora/`）と
`APP_DB`（アカウント・端末・ライブラリ、`migrations/app/`）を別々にバインド。

**検討した代替案**: 1つのD1データベースに全テーブルを同居させる。マイグレーション管理は単純化するが、
カタログの再同期・世代切替（`src/catalog-workflow.ts`）がユーザーデータと同じトランザクション空間・
バックアップ単位に入ってしまう。

**採用理由**: カタログ同期用の大量データとユーザー情報を完全に分離できる。カタログDBは決定的に
再構築可能（青空文庫から再同期すればよい）なため、バックアップ要否の判断もデータベース単位で
はっきり分かれる（`docs/operations.md` 参照）。マイグレーションの責務も明確になる。

## ADR-6: 招待制のアカウント登録（invite token）

**採用**: `scripts/create-invite.mjs` が `registration_invites` に SHA-256ハッシュのみを書き込む
`wrangler d1 execute` コマンドを出力し、平文トークンは一度だけ標準出力に表示する。
`POST /api/auth/registration/options` はセッションが無い呼び出しで `inviteToken` を必須とする。

**検討した代替案**:
- 誰でも自由登録: 個人〜少人数運用のスコープでは不要な公開面を増やすだけで、パスキー登録の
  乱用（無意味なアカウント大量作成等）に対する防御も必要になる。
- 管理者が手動でアカウントを作る（招待リンクなし）: 招待される側が自分でパスキーを登録できず、
  管理者が秘密鍵材料を扱う必要が生じる。

**採用理由**: 個人〜少人数の私的運用に対して過不足のない仕組み。招待トークンは7日で失効し
1回使い切りで、`registration_invites.token_hash` にはハッシュのみが残る。

## ADR-7: ペアリング時のdeviceTokenはAES-GCMで暗号化して受け渡す

**採用**: `src/security/aes-gcm.ts`。承認時に生成した平文 `deviceToken` は D1 に平文保存せず、
`PAIRING_ENCRYPTION_KEY`（256ビット、Wrangler secret）で AES-GCM 暗号化し、`device_pairings` の
`encrypted_device_token` / `token_iv` / `token_auth_tag` に保存する。端末側は `pairingSecret` を
知っている限りポーリングでこれを取得し復号できる（`src/devices/pairings.ts` の `pollPairing`）。

**検討した代替案**:
- deviceToken を平文のまま `device_pairings` に保存し、ポーリング応答でそのまま返す: 承認から
  完了通知までの間、D1上に平文の認証情報が残ってしまう。
- deviceToken を都度再生成し、ポーリングのたびに新しいトークンを返す: ハッシュ済みで永続保存した
  `devices.token_hash` と不整合を起こしやすく、再生成のたびにdevices行の更新が必要になり複雑化する。

**採用理由**: D1へ永続保存する `devices.token_hash`（片方向ハッシュ）とは別に、承認〜完了通知までの
「受け渡し中」の一時的な期間だけ暗号文として存在させることで、平文が永続ストレージに残る期間を
最小化できる。端末が完了通知（`POST /api/device-pairings/:pairingId/complete`）を送ると暗号文は
削除される（`completePairingRow`）。
