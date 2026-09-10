import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { appConfigSchema, loadConfigFile } from "../src/config.js";

const root = new URL("../../../", import.meta.url);

describe("checked-in configuration examples", () => {
  it("loads the deployment config through the public loader", async () => {
    const config = await loadConfigFile(
      fileURLToPath(new URL("example/config.yaml", root)),
    );
    expect(Object.keys(config.workspaces.instances).length).toBeGreaterThan(0);
  });

  it.each([
    "example/README.md",
    "docs/site/src/content/docs/en/configuration/queue.md",
    "docs/site/src/content/docs/zh-cn/configuration/queue.md",
  ])("validates complete auto-commit examples in %s", async (path) => {
    const markdown = await readFile(new URL(path, root), "utf8");
    const blocks = [...markdown.matchAll(/^```ya?ml\s*\r?\n([\s\S]*?)^```/gm)]
      .map((match) => match[1]!)
      .filter((block) => /^\s+auto_commit:/m.test(block));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const config = appConfigSchema.parse(parse(block));
      expect(config.review.auto_commit?.schedule?.rules.length).toBeGreaterThan(
        0,
      );
    }
  });
});
