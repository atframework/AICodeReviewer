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
  ])("validates automatic commit and PR policy examples in %s", async (path) => {
    const markdown = await readFile(new URL(path, root), "utf8");
    const blocks = [...markdown.matchAll(/^```ya?ml\s*\r?\n([\s\S]*?)^```/gm)]
      .map((match) => match[1]!)
      .filter((block) => /^\s+(?:auto_commit|pull_request):/m.test(block));
    expect(blocks.length).toBeGreaterThan(0);
    const discovered = new Set<string>();
    for (const block of blocks) {
      const config = appConfigSchema.parse(parse(block));
      const reviews = [
        config.review,
        config.workspaces.defaults.review,
        ...Object.values(config.workspaces?.instances ?? {}).map(
          (instance) => instance.review,
        ),
      ];
      for (const review of reviews) {
        for (const kind of ["auto_commit", "pull_request"] as const) {
          if (review?.[kind]) {
            discovered.add(kind);
            if (review[kind].schedule?.rules.length) discovered.add(`${kind}.schedule`);
          }
        }
      }
    }
    // Check discovery as well as parsing: each document demonstrates both
    // families, including at least one non-empty automatic commit schedule.
    // Other fragments may use rules: [] to deliberately lift the window.
    expect([...discovered]).toEqual(expect.arrayContaining(["auto_commit", "auto_commit.schedule", "pull_request"]));
  });
});
