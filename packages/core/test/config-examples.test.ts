import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  collectPathTemplateVariables,
  compileWorkspacePathTemplate,
  validateWorkPathTemplateVariables,
  WORK_PATH_TEMPLATE_VARIABLES,
} from "../src/config-path-template.js";
import { appConfigSchema, loadConfigFile, parseConfigDocumentText } from "../src/config.js";
import { ConfigError } from "../src/index.js";

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

  it("exposes the live dynamic config source section", async () => {
    const config = await loadConfigFile(
      fileURLToPath(new URL("example/config.yaml", root)),
    );
    expect(config.config_sources.database).toEqual({
      enabled: true,
      backend: "storage",
      namespace: "default",
    });
    expect(config.config_sources.runtime.refresh_interval_seconds).toBe(5);
    expect(config.config_sources.secret_refs).toEqual([{ env: "DB_LLM_KEY",
      target: ["llm", "providers", "db-model", "api_key_env"],
      destinations: { kind: "openai_compatible", base_url: "https://llm.example.com/v1" } }]);
  });

  it("compiles every example work_path template against the variable registry", async () => {
    const config = await loadConfigFile(
      fileURLToPath(new URL("example/config.yaml", root)),
    );
    const registry: Record<string, (typeof WORK_PATH_TEMPLATE_VARIABLES)[number]> =
      Object.fromEntries(WORK_PATH_TEMPLATE_VARIABLES.map((entry) => [entry.path, entry]));
    const templates = Object.values(config.workspaces.instances)
      .map((instance) => instance.work_path)
      .filter((template): template is string => template !== undefined);
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      expect(() => compileWorkspacePathTemplate(template)).not.toThrow();
      expect(() => validateWorkPathTemplateVariables(template)).not.toThrow();
      for (const variable of collectPathTemplateVariables(template)) {
        expect(registry[variable]?.availability).toBe("extracted");
      }
    }
    // Negative cases: event.* is forbidden and unknown variables are rejected.
    expect(() => validateWorkPathTemplateVariables("{{segment event.action}}")).toThrow(/must not use/u);
    expect(() => validateWorkPathTemplateVariables("{{segment nosuch.field}}")).toThrow(/Unknown work_path variable/u);
  });

  // Top-level namespaces of appConfigSchema (.strict()); a fenced YAML block
  // containing a known root key is an AICR config fragment, while
  // docker-compose/systemd/etc. blocks are ignored.
  const CONFIG_NAMESPACES = new Set([
    "storage", "admin", "config_sources", "server", "llm", "triggers",
    "outputs", "prompts", "queue", "agent", "compression", "review",
    "workspaces",
  ]);
  const YAML_BLOCK = /^```ya?ml\s*\r?\n([\s\S]*?)^```/gm;

  function isConfigFragment(text: string): boolean {
    // Discover before parsing, so malformed YAML cannot silently opt out.
    const rootKeys = [...text.matchAll(/^(?:"([\w]+)"|'([\w]+)'|([\w]+))\s*:/gm)];
    if (rootKeys.some((match) => CONFIG_NAMESPACES.has(match[1] ?? match[2] ?? match[3]!))) return true;
    try {
      const document: unknown = parse(text);
      return document !== null && typeof document === "object" && !Array.isArray(document)
        && Object.keys(document).some((key) => CONFIG_NAMESPACES.has(key));
    } catch {
      return false;
    }
  }

  it.each([
    "llm:\n  default_model_chain: [broken\n",
    "queue: { kind: memory }\ntelemetry: { enabled: true }\n",
    '{ "queue": { "kind": "memory" }, "typo": true }',
  ])("discovers invalid config fragments instead of filtering them out: %s", (text) => {
    expect(isConfigFragment(text)).toBe(true);
    expect(() => appConfigSchema.parse(parse(text))).toThrow();
  });

  it("ignores other YAML formats", () => {
    expect(isConfigFragment("services:\n  aicr:\n    image: aicr\n")).toBe(false);
  });

  async function collectConfigFragments(): Promise<{ file: string; index: number; text: string }[]> {
    const docsRoot = fileURLToPath(new URL("docs/site/src/content/docs", root));
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".md")) files.push(path);
      }
    };
    await walk(docsRoot);
    files.push(
      fileURLToPath(new URL("example/README.md", root)),
      fileURLToPath(new URL("docs/output-channels.md", root)),
    );

    const fragments: { file: string; index: number; text: string }[] = [];
    for (const file of files) {
      const markdown = await readFile(file, "utf8");
      let index = 0;
      for (const match of markdown.matchAll(YAML_BLOCK)) {
        index += 1;
        const text = match[1]!;
        if (isConfigFragment(text)) {
          fragments.push({ file: relative(fileURLToPath(root), file), index, text });
        }
      }
    }
    return fragments;
  }

  it("validates every config fragment across the documentation set", async () => {
    const fragments = await collectConfigFragments();
    // Guard against filter rot: the docs currently carry well over a hundred
    // config fragments; a large drop means the discovery heuristic broke.
    expect(fragments.length).toBeGreaterThan(100);
    for (const fragment of fragments) {
      try {
        appConfigSchema.parse(parse(fragment.text));
      } catch (error) {
        throw new Error(
          `${fragment.file} yaml block #${fragment.index} fails appConfigSchema`, { cause: error },
        );
      }
    }
  });
});

describe("negative configuration examples", () => {
  function expectRejected(text: string, fragment: RegExp): void {
    expect(() => parseConfigDocumentText(text)).toThrow(fragment);
  }

  it("rejects a scalar where include_branches expects a list", () => {
    expectRejected(
      ["review:", "  auto_commit:", '    include_branches: "main"'].join("\n"),
      /include_branches|Expected array/u,
    );
  });

  it("rejects an unknown queue kind", () => {
    expectRejected(["queue:", "  kind: etcd"].join("\n"), /kind|Invalid enum/u);
  });

  it("rejects an unknown top-level namespace (strict schema)", () => {
    expectRejected(["telemetry:", "  enabled: true"].join("\n"), /Unrecognized key/u);
  });

  it("rejects the removed llm.fallback_chain field with a migration hint", () => {
    expectRejected(
      ["llm:", "  fallback_chain:", "    - primary"].join("\n"),
      /fallback_chain|model_chain/u,
    );
  });

  it("rejects the removed gitea_finding_issue channel kind", () => {
    expectRejected(
      ["outputs:", "  channels:", "    - name: legacy", "      kind: gitea_finding_issue"].join("\n"),
      /gitea_finding_issue/u,
    );
  });

  it("rejects a workspace match rule referencing an unknown trigger", () => {
    let caught: unknown;
    try {
      parseConfigDocumentText(
        [
          "triggers:",
          "  - { name: gitea-main, kind: gitea }",
          "workspaces:",
          "  instances:",
          "    services:",
          "      match:",
          "        - triggers: [nosuch-trigger]",
          "          source:",
          '            repo_ref: { glob: "acme/*" }',
        ].join("\n"),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("invalid_reference");
    expect((caught as ConfigError).message).toContain("nosuch-trigger");
  });

  it("rejects mutually exclusive secret forms on a channel", () => {
    expectRejected(
      [
        "outputs:",
        "  channels:",
        "    - name: bot",
        "      kind: feishu_bot",
        "      webhook_url: https://example.com/hook",
        "      webhook_url_env: BOT_HOOK",
      ].join("\n"),
      /webhook_url/u,
    );
  });
});
