import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@aicr/agents": fileURLToPath(new URL("./packages/agents/src/index.ts", import.meta.url)),
      "@aicr/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
      "@aicr/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@aicr/eval": fileURLToPath(new URL("./packages/eval/src/index.ts", import.meta.url)),
      "@aicr/llm": fileURLToPath(new URL("./packages/llm/src/index.ts", import.meta.url)),
      "@aicr/mcp-output": fileURLToPath(
        new URL("./packages/mcp-output/src/index.ts", import.meta.url),
      ),
      "@aicr/outputs": fileURLToPath(new URL("./packages/outputs/src/index.ts", import.meta.url)),
      "@aicr/sandbox": fileURLToPath(new URL("./packages/sandbox/src/index.ts", import.meta.url)),
      "@aicr/server": fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url)),
      "@aicr/store": fileURLToPath(new URL("./packages/store/src/index.ts", import.meta.url)),
      "@aicr/vcs": fileURLToPath(new URL("./packages/vcs/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Live-service suites (redis/pg gated by AICR_REDIS_TEST_URL/AICR_PG_TEST_URL)
    // exceed the 5s default under high worker parallelism on many-core hosts.
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/index.ts"],
      thresholds: {
        // P6 paradigm modules: 100% statements/branches/functions/lines (spec §8.3).
        "packages/core/src/config-ui-runtime.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/config-ui-spec.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "packages/core/src/config-form-state.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});