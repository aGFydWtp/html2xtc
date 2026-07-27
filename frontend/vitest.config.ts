// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@html2xtc/aozora-text": fileURLToPath(
        new URL("../packages/aozora-text/src/index.ts", import.meta.url),
      ),
      "@html2xtc/markdown-text": fileURLToPath(
        new URL("../packages/markdown-text/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
