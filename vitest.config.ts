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
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/index.ts"],
    },
  },
});