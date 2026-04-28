import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appConfigSchema,
  loadConfigFile,
  mergeConfigLayers,
  workspaceRootKeys,
} from "../src/config.js";

describe("mergeConfigLayers", () => {
  it("deep merges defaults, system config, and workspace overrides", () => {
    const merged = mergeConfigLayers(
      {
        agent: {
          default: "kilo",
          sandbox: {
            kind: "docker",
            engine: "auto",
          },
        },
        workspaces: {
          cache: {
            max_total_gb: 50,
            eviction: "lru",
            ttl_days: 30,
          },
          defaults: {
            review: {
              commit_strategy: "aggregate",
            },
          },
          instances: {},
        },
      },
      {
        agent: {
          timeout_seconds: 900,
        },
        outputs: {
          template_engine: "handlebars",
        },
      },
      {
        workspaces: {
          instances: {
            "gitea-internal-owent-example": {
              agent: {
                default: "claude-code",
              },
              review: {
                exclude: ["docs/**"],
              },
            },
          },
        },
      },
    );

    expect(merged.agent.default).toBe("kilo");
    expect(merged.agent.timeout_seconds).toBe(900);
    expect(merged.workspaces.instances["gitea-internal-owent-example"]?.agent?.default).toBe(
      "claude-code",
    );
    expect(merged.workspaces.cache.max_total_gb).toBe(50);
    expect(merged.outputs.template_engine).toBe("handlebars");
  });

  it("rejects deprecated workspace keys at the top level", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        cache: {
          max_total_gb: 50,
          eviction: "lru",
          ttl_days: 30,
        },
        legacyWorkspace: {},
      },
    });

    expect(result.success).toBe(false);
  });

  it.each(workspaceRootKeys)(
    "rejects reserved workspace_id %s under workspaces.instances (Plan §3.10 D14)",
    (reservedId) => {
      const result = appConfigSchema.safeParse({
        workspaces: {
          instances: {
            [reservedId]: {},
          },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes("instances"))).toBe(true);
      }
    },
  );

  it("applies built-in defaults when given an empty config", () => {
    const merged = mergeConfigLayers({});

    expect(merged.agent.default).toBe("kilo");
    expect(merged.agent.timeout_seconds).toBe(600);
    expect(merged.agent.auto_approve).toBe(true);
    expect(merged.agent.sandbox.kind).toBe("docker");
    expect(merged.agent.sandbox.engine).toBe("auto");
    expect(merged.outputs.template_engine).toBe("handlebars");
    expect(merged.queue.kind).toBe("memory");
    expect(merged.workspaces.cache.max_total_gb).toBe(50);
    expect(merged.workspaces.cache.eviction).toBe("lru");
    expect(merged.workspaces.instances).toEqual({});
    expect(merged.review.incremental).toBe(true);
  });

  it("replaces arrays wholesale instead of concatenating during merge", () => {
    const merged = mergeConfigLayers(
      {
        triggers: [{ name: "gitea-internal", kind: "gitea" }],
      },
      {
        triggers: [{ name: "github-saas", kind: "github" }],
      },
    );

    expect(merged.triggers).toHaveLength(1);
    expect(merged.triggers[0]?.name).toBe("github-saas");
  });

  it("rejects an unknown sandbox kind in workspace overrides", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        instances: {
          example: {
            sandbox: { kind: "vm-magic" },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts the forgejo trigger kind alias for Gitea-compatible deployments", () => {
    const merged = mergeConfigLayers({
      triggers: [{ name: "forgejo-community", kind: "forgejo" }],
    });

    expect(merged.triggers[0]?.kind).toBe("forgejo");
  });

  it("loads an empty YAML file as the default config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-config-"));
    const filePath = join(tempDir, "config.yaml");

    try {
      await writeFile(filePath, "\n", "utf8");

      const loaded = await loadConfigFile(filePath);

      expect(loaded.agent.default).toBe("kilo");
      expect(loaded.outputs.template_engine).toBe("handlebars");
      expect(loaded.workspaces.instances).toEqual({});
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a YAML document whose root is not an object", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-config-"));
    const filePath = join(tempDir, "config.yaml");

    try {
      await writeFile(filePath, "- not-an-object\n", "utf8");

      await expect(loadConfigFile(filePath)).rejects.toThrow(
        "Config file root must be a YAML mapping/object.",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});