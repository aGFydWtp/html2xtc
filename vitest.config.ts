import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "packages/aozora-text/test/**/*.test.ts"],
  },
});
