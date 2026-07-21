// SPDX-License-Identifier: AGPL-3.0-or-later
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";

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
  server: {
    proxy: Object.fromEntries(WORKER_PATHS.map((p) => [p, "http://localhost:8787"])),
  },
});
