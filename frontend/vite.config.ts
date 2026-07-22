// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";

// 共有パッケージ packages/aozora-text はビルドステップなしでソースを直接
// 参照する（npm workspaces は導入しない — 実装ブリーフ参照）。tsconfig.json
// の paths と同じマッピングをここにも与える。
const AOZORA_TEXT_ENTRY = fileURLToPath(
  new URL("../packages/aozora-text/src/index.ts", import.meta.url),
);

// dev 時は API と version.json をローカルの wrangler dev (port 8787) へ中継する。
// 本番は Workers assets + run_worker_first（wrangler.jsonc）が同じ振り分けを行う。
const WORKER_PATHS = ["/convert", "/jobs", "/download", "/version.json", "/api"];

// 本番（Workers assets の html_handling）は /about を about.html で応答する。
// dev サーバーでも同じ URL で開けるように書き換える。
const aboutRewrite: Plugin = {
  name: "about-html-rewrite",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/about" || req.url?.startsWith("/about?")) req.url = "/about.html";
      next();
    });
  },
};

export default defineConfig({
  plugins: [svelte(), aboutRewrite],
  resolve: {
    alias: {
      "@html2xtc/aozora-text": AOZORA_TEXT_ENTRY,
    },
  },
  server: {
    proxy: Object.fromEntries(WORKER_PATHS.map((p) => [p, "http://localhost:8787"])),
    // packages/aozora-text lives outside frontend/ (this project's root),
    // so dev-server file serving needs the parent repo root allow-listed —
    // otherwise Vite's fs.allow default (project root only) 403s the
    // aliased import above.
    fs: {
      allow: [fileURLToPath(new URL("..", import.meta.url))],
    },
  },
});
