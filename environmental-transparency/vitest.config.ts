import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: process.env.INTEGRATION ? ["tests/integration/**/*.test.ts"] : ["tests/unit/**/*.test.ts"],
    testTimeout: process.env.INTEGRATION ? 120_000 : 10_000,
    environment: "node",
  },
});
