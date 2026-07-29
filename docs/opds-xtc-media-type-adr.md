# ADR: OPDS acquisition の media type / URL を `application/vnd.xteink.xtc` + `.xtc` 拡張子へ移行

`aGFydWtp/crosspoint-jp` に加え、XTC/XTCH の OPDS 取得対応が入った本家
`crosspoint-reader/crosspoint-reader` からも同じ OPDS カタログを利用できるようにする
（`claudedocs/html2xtc-opds-phase1-spec.md` §1/§3）ための、acquisition link と
ダウンロードレスポンスの media type / URL に関する設計判断。

## ADR: `application/octet-stream` から `application/vnd.xteink.xtc` へ、URL に `.xtc` 拡張子を追加

**採用**: `src/opds/media-type.ts` の `XTC_MEDIA_TYPE = "application/vnd.xteink.xtc"` を
`src/opds/feed.ts`（acquisition link の `type`）と `src/opds/routes.ts`
（ダウンロードレスポンスの `Content-Type`）の両方から参照する。acquisition link の
`href` も `/api/device/library-items/{itemId}/download` から
`/api/device/library-items/{itemId}/download.xtc` に変更する。

**背景**: 本家 CrossPoint の XTC/XTCH OPDS 対応は、OPDS entry の判定に
`application/vnd.xteink.xtc` / `application/vnd.xteink.xtch` /
`application/x-xtc+zip` / `application/x-xtch+zip` を優先し、`application/octet-stream`
の場合のみ URL 末尾の `.xtc` / `.xtch` / `.epub` へフォールバックする（実装計画 §2「本家
CrossPoint」）。html2xtc の従来の acquisition link は `type="application/octet-stream"`
かつ拡張子なしの `/download` だったため、この判定ロジックのどちらの経路でも XTC と
認識されない可能性があった。`crosspoint-jp` 側は既に両方の media type を XTC 候補として
受け付けているため、この変更による退行は無い。

**検討した代替案**:
- 現状維持（`application/octet-stream` + 拡張子なし URL）: 自前クライアント
  （crosspoint-jp）は既に対応済みで動くが、本家 CrossPoint の判定ロジックとは噛み合わない
  可能性が残る。「一般的な OPDS クライアントからも同じカタログを使える」という本フェーズの
  目的（実装計画 §1）を満たせない。
- media type だけ変更し URL 拡張子は変えない: 本家側の判定は `type` を優先するため単独でも
  動作しうるが、`type` を読み損ねた場合のフォールバック（拡張子推定）が効かず、判定の頑健性で
  劣る。両方揃える方が安全。
- 拡張子だけ変更し media type は `application/octet-stream` のまま: 逆に `type` 優先の判定に
  対して弱い。同様の理由で採用しない。

**採用理由**: media type と URL 拡張子の両方を本家の判定ロジックに合わせることで、`type` を
見るクライアントにも拡張子だけを見るクライアントにも対応でき、実装コストも定数 1 個の追加と
2 ファイルの参照変更で済む。

## ADR: 旧 `/download`（拡張子なし・`application/octet-stream`）ルートは削除せず維持する

**採用**: `src/opds/routes.ts` に `GET .../download.xtc`（正式）と
`GET .../download`（後方互換）の 2 ルートを登録し、どちらも同一の内部ハンドラ
（`handleDeviceXtcDownload`）に委譲する。新規に生成する OPDS フィードの acquisition link は
`.xtc` 付き URL のみを発行するが、旧 URL への直接アクセスは今後も同じレスポンスを返し続ける。

**検討した代替案**: 旧 `/download` を撤去し、`.xtc` ルートのみを提供する。実装は単純になるが、
以下の理由で採用しなかった。

**採用理由**:
- 既存の crosspoint-jp 端末・OPDS クライアントが、移行前にキャッシュ・保存した旧 URL
  （フィード XML そのものをローカルに保持している場合や、ハードコードされたダウンロード URL
  を持つ実装がある場合）を引き続き解決できる必要がある（実装計画 §5.1「既存ユーザーは
  再ペアリングを要求されてはならない」/ §7「維持する API」）。
- 2 ルートを同じハンドラへ委譲する実装コストはほぼゼロで、認証・認可・監査・R2 取得の
  ロジックを重複させる必要がない。
- ロールバック時（media type / URL を旧仕様へ戻す必要が生じた場合）も、`.xtc` ルート自体は
  互換性を損なわないため残してよい（実装計画 §11「移行とロールバック」）。
