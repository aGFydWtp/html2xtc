# 本番ログを後から検索する（Workers Logs / Observability API）

`wrangler tail` は実行中しか見られないため、これまでインシデント調査は「同じ入力で本番を再実行して tail で捕まえる」しかなかった。Workers Logs は `observability.enabled: true`（[wrangler.jsonc](../wrangler.jsonc)）で記録されているので、**専用 API トークンがあれば事後に検索できる**。その手順。

調査日: 2026-07-24。以下の挙動はすべてこの日の本番データで実測した。

## 1. セットアップ

必要なのは **`Workers Observability` 権限を持つ API トークン**。wrangler の OAuth トークンにはこの権限がなく、telemetry query API は 403 を返す（`wrangler tail` に頼っていたのはこれが理由）。トークンは 1Password に置き、値はリポジトリにもシェル履歴にも残さない。

リポジトリ直下に `.cf-logs.env` を置く（gitignore 済み。**このリポジトリは公開なのでアカウント ID もここに置き、コミットしない**）:

```
CF_LOGS_OP_ITEM=op://<vault>/<item-id>/credential
CF_ACCOUNT_ID=<account id>
```

`CF_ACCOUNT_ID` は省略可（トークンから見えるアカウントが 1 つならスクリプトが自動判定する）。`op` は 1Password CLI で、実行時に `op read` で都度読む。

## 2. スクリプト

[scripts/cf-logs.mjs](../scripts/cf-logs.mjs)。依存なしの Node スクリプト。

```bash
node scripts/cf-logs.mjs --help
```

よく使う形:

```bash
# 直近2時間の全文検索
node scripts/cf-logs.mjs --since 2h --needle "Browser Run returned 422"

# 構造化フィールドで絞る（複数指定は AND）
node scripts/cf-logs.mjs --since 24h --filter "code eq 6002"
node scripts/cf-logs.mjs --since 7d --filter "elapsedMs gt 60000" --filter "ok eq false"

# 集計（広い期間はまずこちらで数える。下の「取りこぼし」を参照）
node scripts/cf-logs.mjs --since 7d --view calculations \
  --calc count --calc avg:elapsedMs --calc max:elapsedMs \
  --group-by mode --filter "elapsedMs exists"

# 複数値（in / not_in はカンマ区切り）
node scripts/cf-logs.mjs --since 6h --filter "status in 404,422"

# 何が検索できるかを調べる
node scripts/cf-logs.mjs --since 24h --keys      # フィールド名と型
node scripts/cf-logs.mjs --since 24h --values status

# 時刻を明示（ISO8601 か epoch ミリ秒）
node scripts/cf-logs.mjs --from 2026-07-24T09:00:00Z --to 2026-07-24T09:30:00Z --limit 200
```

`--json` で API の生レスポンスを出せる（`jq` に渡す用）。時刻表示は既定でローカル、`--utc` で UTC。

**検索範囲はアカウント全体**（このアカウントには `url-to-xtc` 以外の Worker もいる）。html2xtc だけを見たいときは `--script url-to-xtc` を付ける。`code` や `elapsedMs` のように html2xtc 固有のフィールドで絞るなら実質不要だが、`--needle` の全文検索や `--view calculations` の集計では他 Worker のログが混ざる。

## 3. 何が検索できるか（重要）

**`console.log("...", { ... })` の第2引数のオブジェクトは、キーごとに型付きでインデックスされる。** 全文検索しかできないわけではない。実測で確認したフィールド:

```
number   elapsedMs, browserMs, articleBytes, fontCssBytes, status, code
boolean  ok
string   mode, message, level
string   exception.message, exception.name, exception.stack
```

つまり `code eq 6002` や `elapsedMs gt 60000` で直接絞り込める。`[<jobId>] font: inline (...)` のように文字列に埋め込んだ値は当然フィールドにならないので、全文検索（`--needle`）でしか拾えない。**後から集計したい値はオブジェクトで渡す**、が結論。

Cloudflare 側が付けるフィールドは `$` 始まり（`$workers.scriptName`、`$workers.workflowName`、`$workers.instanceId`、`$metadata.requestId`、`$metadata.messageTemplate` など）。`--filter '$workers.scriptName eq url-to-xtc'` のように指定できる（`--script url-to-xtc` が同じことをする）。

`$metadata.messageTemplate` は可変部分を伏せたテンプレート（例: `[<UUID>] render-pdf`）で、同種のログをまとめて数えるのに使える。

### 期間を広げると events は黙って取りこぼす（最重要）

**events は期間が広いと API 側でサンプリングされ、件数の少ないログが 1 件も返らないことがある。**
2026-07-24 の実測（`status eq 422` = 実際は 6 件）:

| 期間 | events の件数 | `abr_level` | calculations の件数 | `abr_level` |
| --- | --- | --- | --- | --- |
| 6h / 1d | 6 | 1 | 6 | 1 |
| 2d 〜 7d | **0** | 10 | 6 | 1 |

つまり `--since 7d --filter "code eq 6002"` は「該当なし」と表示するが、実際には 6 件あった。
**0 件を「起きていない」と読んではいけない。** `--view calculations`（同条件で `abr_level` は 1 のまま正確）は
影響を受けなかったので、

1. まず `--view calculations --calc count` で件数と発生時間帯を確認し、
2. その時間帯に `--from` / `--to` を絞って events を読む

の順で調べる。スクリプトは `statistics.abr_level > 1` を検知したら警告を出す。

### 型が合わないと 0 件になる

API はフィールドの型が実データと違っても**エラーではなく 0 件**を返す。`elapsedMs`（number）に `type: "string"` で `exists` を投げると空振りする。スクリプトは `--keys` の結果から実際の型を引いて自動で合わせるので普段は意識しなくてよいが、生 API を直接叩くときは注意。

型は **明示 → API が返す実際の型 → 値からの推定** の順に決まる。**指定した期間にそのフィールドが 1 件も出ていないと型を引けず**、値からの推定に落ちる（このとき警告が出る）。狭い期間で「エラーも出ないのに 0 件」になったらこれを疑い、期間を広げるか `--filter 'status:number eq 422'` のように型を明示する。

boolean は `true` / `false` 以外を書くとエラーになる。`ok eq True` を黙って `ok eq false` として送ると、成功だけを見ているつもりで失敗だけを見ることになるため。

## 4. 保持期間: 7 日

- 公式ドキュメント: Workers Paid = **7 日**、Free = 3 日。
- 実測（2026-07-24 10:04 UTC 時点）: 6 時間刻みで遡ると 07-17 10:04 UTC 以降は件数があり、それより前はすべて 0。**現在時刻から正確に 7 日のローリング**で切れている。

7 日より前は API でも UI でも取れない。長期保存が要るなら [Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/) か Tail Workers で外に出すしかない（本タスクの範囲外）。

その他の上限: 1 ログあたり 256 KB（超過分は切り詰められ `$cloudflare.truncated` が true）、アカウントあたり 50 億ログ/日。`head_sampling_rate` は未設定 = 100% 記録（[wrangler.jsonc](../wrangler.jsonc) の `observability` は `enabled` のみ）。

## 5. API の素の形

スクリプトを使わず直接叩く場合。エンドポイントは 3 つ:

| エンドポイント | 用途 |
| --- | --- |
| `POST /accounts/{account_id}/workers/observability/telemetry/query` | ログ検索・集計 |
| `POST .../telemetry/keys` | インデックス済みフィールド一覧 |
| `POST .../telemetry/values` | あるフィールドの観測値一覧 |

query のボディ（`queryId` と `timeframe` が必須。`queryId` は保存クエリを読み込むとき以外は任意の文字列でよい）:

```json
{
  "queryId": "adhoc",
  "timeframe": { "from": 1784880000000, "to": 1784890000000 },
  "view": "events",
  "limit": 50,
  "parameters": {
    "datasets": ["cloudflare-workers"],
    "limit": 50,
    "filterCombination": "and",
    "filters": [
      { "kind": "filter", "key": "code", "type": "number", "operation": "eq", "value": 6002 }
    ],
    "needle": { "value": "Browser Run returned 422", "matchCase": false, "isRegex": false }
  }
}
```

- `filters[]` の必須キーは `key` / `operation` / `type`。`kind: "filter"` を付ける（`kind: "group"` にすると `filterCombination` + `filters` でネストできる）。
- `operation`: `eq neq gt gte lt lte includes not_includes starts_with ends_with regex exists is_null in not_in`（大文字の別名もある）。
- `in` / `not_in` の値は **カンマ区切りの文字列**。number 型のキーでも文字列で渡す（`"404,422"`）。配列は 400、単一の数値は 500 になる。
- `view`: `events`（既定は `calculations`）。他に `traces` / `invocations` / `requests` / `agents`。
- 集計は `parameters.calculations[]`（`operator` 必須、`key` / `keyType` / `alias`）と `parameters.groupBys[]`（`value` / `type`）、絞り込みに `havings[]`。
- レスポンスは `result.events.events[]`（`timestamp` / `source` / `$metadata` / `$workers`）または `result.calculations[]`、加えて `result.statistics`（スキャン行数と所要秒数）。

スキーマの正は Cloudflare の OpenAPI（`https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json` の `/accounts/{account_id}/workers/observability/telemetry/query`）。[API リファレンス](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)はこれの生成物。

## 6. ダッシュボードの Query Builder との違い

未検証を含むので、確実に言えることだけ:

- **保持期間は同じ 7 日。** 保持はストレージ側の性質で UI/API の別ではない（実測で 7 日より前は 0 件）。
- ダッシュボード（Workers & Pages → 対象 Worker → Observability）はトークン不要で、同じ account スコープのデータを見る。`view` の enum（`events` / `traces` / `invocations` / `requests` / `calculations`）が UI のタブに対応している。
- API 側にしかない機能として、保存クエリ（`/observability/queries`）、共有クエリ（`/observability/shared/query`）、live-tail（`/observability/telemetry/live-tail`）のエンドポイントが存在する。
- UI 固有の機能（可視化やアラート連携など）が API に無いかどうかは**未確認**。

## 7. 実例: 2026-07-24 の render-pdf タイムアウト

```bash
node scripts/cf-logs.mjs --since 24h --filter "code eq 6002"
```

```
2026-07-24 18:13:51.069  log    [080271cd-...] render-pdf
    ok=false mode="extract" status=422 elapsedMs=121957 browserMs=0
    articleBytes=754304 fontCssBytes=1986319 code=6002
    workflow=xtc-convert instance=080271cd-...
```

`--needle "Browser Run returned 422"` を使えば対になる `console.error` 側（Browser Run の 6002 / "A timeout was reached."）も取れる。`instanceId` が同じなので、片方から Workflow インスタンスを特定して `--filter '$workers.instanceId eq <id>'` で 1 ジョブ分のログを通しで読める。
