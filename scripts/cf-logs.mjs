#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 aGFydWtp

/**
 * Queries Cloudflare Workers Logs (Workers Observability) after the fact, so
 * an incident can be investigated from the recorded logs instead of being
 * reproduced against production and caught with `wrangler tail`.
 *
 * Wraps POST /accounts/{account_id}/workers/observability/telemetry/{query,keys,values}.
 * The Worker's log context (`console.log("...", { code, elapsedMs, ... })`) is
 * indexed field by field, so structured filters such as `code eq 6002` or
 * `elapsedMs gt 60000` work — not just full-text search.
 *
 * Auth: an API token with the "Workers Observability" permission, read from
 * 1Password at run time. Wrangler's OAuth token does NOT carry that permission
 * (the API answers 403), which is why this script does not reuse it. The token
 * value is never printed, written to a file, or passed as a CLI argument.
 *
 * Configuration (env vars; `.cf-logs.env` in the repo root is loaded first if
 * it exists — that file is gitignored, this repo is public):
 *   CF_LOGS_OP_ITEM   required. 1Password secret reference for the token,
 *                     e.g. "op://<vault>/<item>/credential".
 *   CF_ACCOUNT_ID     optional. Auto-detected when the token can see exactly
 *                     one account.
 *
 * Usage:
 *   node scripts/cf-logs.mjs --since 2h --needle "Browser Run returned 422"
 *   node scripts/cf-logs.mjs --since 24h --filter "code eq 6002"
 *   node scripts/cf-logs.mjs --since 7d --filter "elapsedMs gt 60000" --limit 100
 *   node scripts/cf-logs.mjs --since 24h --view calculations \
 *     --calc count --calc avg:elapsedMs --calc max:elapsedMs --group-by mode
 *   node scripts/cf-logs.mjs --keys                 # indexed field names + types
 *   node scripts/cf-logs.mjs --values mode          # observed values of a field
 *
 * Retention is 7 days on Workers Paid (3 on Free), so `--since` beyond 7d
 * silently returns nothing for the part that fell off — the script warns.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_BASE = "https://api.cloudflare.com/client/v4";
const DATASET = "cloudflare-workers";
const RETENTION_DAYS = 7; // Workers Paid. Free is 3.

const FILTER_OPERATIONS = new Set([
  "includes",
  "not_includes",
  "starts_with",
  "ends_with",
  "regex",
  "exists",
  "is_null",
  "in",
  "not_in",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
]);
// Operations that take no operand; everything else requires a value.
const VALUELESS_OPERATIONS = new Set(["exists", "is_null"]);
// Operations whose operand is a comma-separated list.
const LIST_OPERATIONS = new Set(["in", "not_in"]);
const CALC_OPERATORS = new Set([
  "count",
  "uniq",
  "min",
  "max",
  "sum",
  "avg",
  "median",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "stddev",
  "variance",
]);

function usage() {
  console.log(
    `使い方: node scripts/cf-logs.mjs [options]

期間（既定は --since 1h）
  --since <30m|2h|3d>       現在から遡る期間
  --from <ISO|epoch_ms>     開始時刻（--since より優先）
  --to   <ISO|epoch_ms>     終了時刻（既定: 現在）

絞り込み
  --needle <text>           全文検索（既定で大小文字を無視）
  --regex                   --needle を正規表現として扱う
  --match-case              --needle の大小文字を区別する
  --filter '<key>[:<type>] <op> [value]'
                            構造化フィルタ。複数指定は AND。
                            op: ${[...FILTER_OPERATIONS].join(", ")}
                            in / not_in の値はカンマ区切り（例: 'status in 404,422'）
                            type は 明示 → API が返す実際の型 → value からの推定
                            の順に決まる（型が実データと違うと 0 件になるため）
  --script <name>           Worker 名で絞る（$workers.scriptName）

表示
  --view events|calculations   既定 events
  --limit <n>               既定 50（最大 2000）
  --calc <op[:key[:type]]>  calculations 用。例 count / avg:elapsedMs
  --group-by <key[:type]>   calculations の集計軸。複数指定可
  --utc                     時刻を UTC で表示（既定はローカル時刻）
  --json                    API のレスポンスをそのまま出力

その他
  --keys                    インデックスされているフィールド一覧
  --values <key>            そのフィールドの観測値一覧
  --help`,
  );
}

// ---------------------------------------------------------------- config

function loadDotEnv() {
  const path = join(REPO_ROOT, ".cf-logs.env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function readToken() {
  const ref = process.env.CF_LOGS_OP_ITEM;
  if (!ref) {
    fail(
      "CF_LOGS_OP_ITEM が未設定です。1Password の参照 (op://<vault>/<item>/credential) を\n" +
        `  ${join(REPO_ROOT, ".cf-logs.env")} か環境変数で指定してください。`,
    );
  }
  try {
    // execFileSync (not a shell) so the token never passes through a command
    // line; it stays in this process's memory and goes out only as a header.
    return execFileSync("op", ["read", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    fail(`1Password からトークンを読めませんでした (${ref}): ${error.message}`);
  }
}

async function resolveAccountId(token) {
  if (process.env.CF_ACCOUNT_ID) return process.env.CF_ACCOUNT_ID;
  // Deliberately not hard-coded: this repository is public.
  const response = await fetch(`${API_BASE}/accounts`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json();
  if (!response.ok || !body.success) fail(`アカウント一覧の取得に失敗しました: ${JSON.stringify(body.errors ?? body)}`);
  if (body.result.length !== 1) {
    fail(`トークンから見えるアカウントが ${body.result.length} 件あります。CF_ACCOUNT_ID を明示してください。`);
  }
  return body.result[0].id;
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const options = {
    since: "1h",
    from: null,
    to: null,
    needle: null,
    isRegex: false,
    matchCase: false,
    filters: [],
    script: null,
    view: "events",
    limit: 50,
    calculations: [],
    groupBys: [],
    utc: false,
    json: false,
    keys: false,
    values: null,
  };
  const next = (index, flag) => {
    if (index + 1 >= argv.length) fail(`${flag} には値が必要です`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      case "--since": options.since = next(i, arg); i += 1; break;
      case "--from": options.from = parseTime(next(i, arg), arg); i += 1; break;
      case "--to": options.to = parseTime(next(i, arg), arg); i += 1; break;
      case "--needle": options.needle = next(i, arg); i += 1; break;
      case "--regex": options.isRegex = true; break;
      case "--match-case": options.matchCase = true; break;
      case "--filter": options.filters.push(parseFilter(next(i, arg))); i += 1; break;
      case "--script": options.script = next(i, arg); i += 1; break;
      case "--view": options.view = next(i, arg); i += 1; break;
      case "--limit": options.limit = Number(next(i, arg)); i += 1; break;
      case "--calc": options.calculations.push(parseCalc(next(i, arg))); i += 1; break;
      case "--group-by": options.groupBys.push(parseGroupBy(next(i, arg))); i += 1; break;
      case "--utc": options.utc = true; break;
      case "--json": options.json = true; break;
      case "--keys": options.keys = true; break;
      case "--values": options.values = next(i, arg); i += 1; break;
      default:
        fail(`不明なオプション: ${arg}\n--help を参照してください。`);
    }
  }
  if (!Number.isFinite(options.limit) || options.limit < 1 || options.limit > 2000) {
    fail("--limit は 1〜2000 の数値です");
  }
  if (options.view !== "events" && options.view !== "calculations") {
    fail("--view は events か calculations です");
  }
  if (options.view === "calculations" && options.calculations.length === 0) {
    options.calculations.push({ operator: "count", alias: "count" });
  }
  // ここで解決しておく: 1Password の読み取りより前に落とさないと、書式ミスを
  // 知るのに生体認証のプロンプトを1回待たされる。
  options.sinceMs = parseDuration(options.since);
  return options;
}

function parseTime(raw, flag) {
  if (/^\d+$/.test(raw)) {
    // 10 桁は epoch 秒の書き間違いなのでエラーにする。ミリ秒として通すと
    // 1970 年を指し、エラーにならないまま「該当ログなし」になる。
    if (raw.length !== 13) fail(`${flag} の epoch はミリ秒（13桁）です: ${raw}（秒なら ×1000）`);
    return Number(raw);
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) fail(`${flag} の時刻を解釈できません: ${raw}（ISO8601 か epoch ミリ秒）`);
  return ms;
}

function parseDuration(raw) {
  const match = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(raw.trim());
  if (!match) fail(`--since を解釈できません: ${raw}（例: 30m, 2h, 3d）`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return Number(match[1]) * unit;
}

/**
 * `key[:type] op [value]` を、型だけ未確定のまま持ち回る中間形にする。
 * 型は後で /telemetry/keys が返す実際の型に合わせる（下の resolveFilter）:
 * 型が実データとずれていると API はエラーではなく 0 件を返すため、値からの
 * 推定だけに頼ると「該当なし」と誤読する。
 */
function parseFilter(raw) {
  // Split off only the key and the operator; the value keeps its own spacing
  // (a `message includes ...` value may legitimately contain runs of spaces).
  const match = /^\s*(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
  if (!match) fail(`--filter の書式が不正です: ${raw}（例: 'code eq 6002'）`);
  const [, keySpec, operation, rest] = match;
  if (!FILTER_OPERATIONS.has(operation)) {
    fail(`--filter の演算子が不正です: ${operation}\n使えるのは ${[...FILTER_OPERATIONS].join(", ")}`);
  }
  const [key, explicitType] = keySpec.split(":");
  if (VALUELESS_OPERATIONS.has(operation)) return { key, operation, explicitType, rawValue: null };
  if (rest === undefined || rest === "") fail(`--filter に値がありません: ${raw}`);
  return { key, operation, explicitType, rawValue: rest };
}

function inferType(raw) {
  if (raw === "true" || raw === "false") return "boolean";
  if (raw !== "" && !Number.isNaN(Number(raw))) return "number";
  return "string";
}

function resolveFilter(filter, keyTypes) {
  let type = filter.explicitType ?? keyTypes.get(filter.key);
  if (!type) {
    // そのキーがこの期間のログに1件も出ていないと型を引けない。値からの推定に
    // 落ちるが、推定が実際の型と違えば黙って0件になるので必ず知らせる
    // （例: `ok eq True` は boolean 検証を素通りして string として送られる）。
    type = filter.rawValue === null ? "string" : inferType(filter.rawValue);
    console.error(
      `警告: ${filter.key} はこの期間のログに現れないため型を判定できず、` +
        `値から ${type} と推定しました。\n      意図と違えば 0 件になります。` +
        `期間を広げるか --filter '${filter.key}:<type> ...' で型を明示してください。`,
    );
  }
  if (filter.rawValue === null) return { kind: "filter", key: filter.key, type, operation: filter.operation };
  let value = filter.rawValue;
  if (LIST_OPERATIONS.has(filter.operation)) {
    // The API wants a comma-separated *string* here even for number fields:
    // an array is rejected (400) and a bare number 500s. Verified 2026-07-24.
    if (type === "number") {
      for (const item of value.split(",")) {
        if (item.trim() === "" || Number.isNaN(Number(item))) {
          fail(`--filter ${filter.operation} の値に数値でない要素があります: ${item}（${filter.key} は number）`);
        }
      }
    }
    return { kind: "filter", key: filter.key, type, operation: filter.operation, value: value.split(",").map((s) => s.trim()).join(",") };
  }
  if (type === "number") {
    value = Number(filter.rawValue);
    if (Number.isNaN(value)) fail(`--filter の値を数値にできません: ${filter.rawValue}（${filter.key} は number）`);
  } else if (type === "boolean") {
    // Reject anything else rather than silently collapsing to false — a
    // mistyped `ok eq True` would otherwise return exactly the wrong rows.
    if (filter.rawValue !== "true" && filter.rawValue !== "false") {
      fail(`--filter の値は true か false です: ${filter.rawValue}（${filter.key} は boolean）`);
    }
    value = filter.rawValue === "true";
  }
  return { kind: "filter", key: filter.key, type, operation: filter.operation, value };
}

/** `op[:key[:type]]` → calculation の中間形。keyType も後で解決する。 */
function parseCalc(raw) {
  const [operator, key, explicitType] = raw.split(":");
  if (!CALC_OPERATORS.has(operator)) {
    fail(`--calc の演算子が不正です: ${operator}\n使えるのは ${[...CALC_OPERATORS].join(", ")}`);
  }
  if (operator === "count") return { operator, alias: "count" };
  if (!key) fail(`--calc ${operator} には対象キーが必要です（例: ${operator}:elapsedMs）`);
  return { operator, key, explicitType, alias: `${operator}(${key})` };
}

function resolveCalc(calc, keyTypes) {
  if (calc.operator === "count") return { operator: "count", alias: calc.alias };
  const keyType = calc.explicitType ?? keyTypes.get(calc.key) ?? (calc.operator === "uniq" ? "string" : "number");
  return { operator: calc.operator, key: calc.key, keyType, alias: calc.alias };
}

function parseGroupBy(raw) {
  const [value, explicitType] = raw.split(":");
  return { value, explicitType };
}

// ---------------------------------------------------------------- api

async function callApi(token, accountId, path, body) {
  const response = await fetch(`${API_BASE}/accounts/${accountId}/workers/observability${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    // 403 here almost always means the token lacks "Workers Observability".
    fail(`API エラー HTTP ${response.status}: ${text.slice(0, 800)}`);
  }
  const parsed = JSON.parse(text);
  if (!parsed.success) fail(`API エラー: ${JSON.stringify(parsed.errors ?? parsed).slice(0, 800)}`);
  return parsed.result;
}

// ---------------------------------------------------------------- output

function formatTime(ms, utc) {
  const date = new Date(ms);
  if (utc) return `${date.toISOString().replace("T", " ").slice(0, 23)}Z`;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return `${parts}.${String(ms % 1000).padStart(3, "0")}`;
}

function printEvents(result, options) {
  const events = result.events?.events ?? [];
  if (events.length === 0) {
    console.log("(該当ログなし)");
    return;
  }
  // Newest first from the API; print oldest first so a burst reads top-down.
  for (const event of [...events].reverse()) {
    const metadata = event.$metadata ?? {};
    const source = event.source ?? {};
    const level = source.level ?? metadata.level ?? "log";
    const message = metadata.message ?? source.message ?? "";
    console.log(`${formatTime(event.timestamp, options.utc)}  ${String(level).padEnd(5)}  ${message}`);
    // Structured context: everything the Worker passed as an object literal.
    const fields = Object.entries(source).filter(([key]) => key !== "message" && key !== "level");
    if (fields.length > 0) {
      console.log(`    ${fields.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")}`);
    }
    const workflow = event.$workers?.workflowName;
    const instance = event.$workers?.instanceId;
    if (workflow) console.log(`    workflow=${workflow}${instance ? ` instance=${instance}` : ""}`);
  }
  const stats = result.statistics ?? {};
  console.log(
    `\n${events.length} 件 (limit ${options.limit})` +
      (stats.rows_read ? ` / scanned ${stats.rows_read.toLocaleString()} rows in ${stats.elapsed?.toFixed(2)}s` : ""),
  );
}

/**
 * 期間が広いと events は API 側でサンプリングされ（statistics.abr_level > 1）、
 * 件数の少ないログは 1 件も返らないことがある。実測（2026-07-24）では 1 日なら
 * abr_level=1 で全件、2 日以上で abr_level=10 になり、7 日窓では該当 6 件が
 * まるごと消えた。0 件を「起きていない」と読み違えないよう必ず警告する。
 * calculations は同じ条件でも abr_level=1 のまま正確な件数を返したので、
 * まず数えてから期間を狭めて events を見るのが安全。
 */
function warnIfSampled(result, view) {
  const level = result.statistics?.abr_level;
  if (!level || level <= 1) return;
  if (view === "events") {
    console.error(
      `警告: 期間が広いため events がサンプリングされています (abr_level=${level})。` +
        `\n      件数の少ないログは 0 件に見えることがあります。期間を狭めるか、` +
        `\n      --view calculations で件数を確認してください。`,
    );
  }
}

function printCalculations(result) {
  const calculations = result.calculations ?? [];
  if (calculations.length === 0) {
    console.log("(集計結果なし)");
    return;
  }
  for (const calculation of calculations) {
    console.log(`\n# ${calculation.alias ?? calculation.calculation}`);
    const aggregates = calculation.aggregates ?? [];
    if (aggregates.length === 0) {
      console.log("  (該当データなし)");
      continue;
    }
    for (const aggregate of aggregates) {
      const label = (aggregate.groups ?? []).map((group) => `${group.key}=${group.value}`).join(" ") || "(all)";
      console.log(`  ${label.padEnd(40)} ${aggregate.value}`);
    }
  }
}

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- main

async function main() {
  loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  const token = readToken();
  const accountId = await resolveAccountId(token);

  const to = options.to ?? Date.now();
  const from = options.from ?? to - options.sinceMs;
  const oldest = Date.now() - RETENTION_DAYS * 86_400_000;
  // 1 分の余裕: `--since 7d` は境界とミリ秒差で並ぶので、そこで警告を出さない。
  if (from < oldest - 60_000) {
    console.error(
      `警告: 保持期間は ${RETENTION_DAYS} 日です。${formatTime(oldest, options.utc)} より前のログは残っていません。`,
    );
  }

  if (options.keys) {
    const keys = await callApi(token, accountId, "/telemetry/keys", {
      datasets: [DATASET],
      from,
      to,
      limit: 500,
    });
    for (const key of keys.filter((k) => !k.key.startsWith("$"))) console.log(`${key.type.padEnd(8)} ${key.key}`);
    console.log("\n-- Cloudflare 付与 ($ 始まり) --");
    for (const key of keys.filter((k) => k.key.startsWith("$"))) console.log(`${key.type.padEnd(8)} ${key.key}`);
    return;
  }

  if (options.values) {
    const [key, explicitType] = options.values.split(":");
    options.values = key;
    let type = explicitType;
    if (!type) {
      const keys = await callApi(token, accountId, "/telemetry/keys", { datasets: [DATASET], from, to, limit: 500 });
      type = keys.find((k) => k.key === key)?.type;
      if (!type) fail(`フィールド ${key} はこの期間のログに現れません（--keys で一覧を確認）`);
    }
    const result = await callApi(token, accountId, "/telemetry/values", {
      datasets: [DATASET],
      key: options.values,
      type,
      timeframe: { from, to },
      limit: options.limit,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Field types must match how the field is actually indexed, or the API
  // returns 0 rows instead of an error. Ask it rather than guess.
  const needsTypes =
    options.filters.some((f) => !f.explicitType) ||
    options.calculations.some((c) => c.key && !c.explicitType) ||
    options.groupBys.some((g) => !g.explicitType);
  const keyTypes = new Map();
  if (needsTypes) {
    const keys = await callApi(token, accountId, "/telemetry/keys", { datasets: [DATASET], from, to, limit: 500 });
    for (const key of keys) keyTypes.set(key.key, key.type);
  }

  const filters = options.filters.map((filter) => resolveFilter(filter, keyTypes));
  if (options.script) {
    filters.push({
      kind: "filter",
      key: "$workers.scriptName",
      type: "string",
      operation: "eq",
      value: options.script,
    });
  }
  const parameters = { datasets: [DATASET], limit: options.limit };
  if (filters.length > 0) {
    parameters.filters = filters;
    parameters.filterCombination = "and";
  }
  if (options.needle) {
    parameters.needle = { value: options.needle, isRegex: options.isRegex, matchCase: options.matchCase };
  }
  if (options.view === "calculations") {
    parameters.calculations = options.calculations.map((calc) => resolveCalc(calc, keyTypes));
    if (options.groupBys.length > 0) {
      parameters.groupBys = options.groupBys.map((group) => ({
        value: group.value,
        type: group.explicitType ?? keyTypes.get(group.value) ?? "string",
      }));
    }
  }

  const body = {
    // Required by the API. An ad-hoc identifier is fine: a saved query's
    // parameters are only loaded when `parameters` is omitted.
    queryId: "cf-logs.mjs",
    timeframe: { from, to },
    view: options.view,
    limit: options.limit,
    parameters,
  };
  const result = await callApi(token, accountId, "/telemetry/query", body);

  warnIfSampled(result, options.view);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.error(
    `# ${formatTime(from, options.utc)} 〜 ${formatTime(to, options.utc)}${options.utc ? " UTC" : " (local)"}`,
  );
  if (options.view === "calculations") printCalculations(result);
  else printEvents(result, options);
}

await main();
