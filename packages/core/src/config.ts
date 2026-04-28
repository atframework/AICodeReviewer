import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const workspaceRootKeys = ["cache", "defaults", "instances"] as const;

const reservedWorkspaceIds = new Set<string>(workspaceRootKeys);

const workspaceIdSchema = z
  .string()
  .min(1)
  .refine((value) => !reservedWorkspaceIds.has(value), {
    message:
      "workspace_id must not collide with reserved keys (cache, defaults, instances); see Plan.md §3.10 D14",
  });

const llmProviderSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      "openai_compatible",
      "azure_openai",
      "anthropic",
      "vertex_ai",
      "bedrock",
      "google_ai_studio",
      "ollama",
      "copilot",
    ]),
    base_url: z.string().url().optional(),
    api_key_env: z.string().min(1).optional(),
    api_version: z.string().min(1).optional(),
  })
  .passthrough();

const triggerSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["gitea", "forgejo", "github", "gitlab", "p4", "svn", "scheduled", "manual"]),
  })
  .passthrough();

const outputChannelSchema = z
  .object({
    name: z.string().min(1),
    kind: z.string().min(1),
    mention_author: z.boolean().optional(),
  })
  .passthrough();

const sandboxSchema = z
  .object({
    kind: z.enum(["native", "docker", "podman", "docker_socket", "k8s_pod"]).optional(),
    engine: z.enum(["auto", "docker", "podman"]).optional(),
    image: z.string().min(1).optional(),
  })
  .strict();

const reviewSchema = z
  .object({
    exclude: z.array(z.string()).optional(),
    commit_strategy: z.enum(["per_commit", "aggregate", "head_only"]).optional(),
  })
  .strict();

const workspaceInstanceSchema = z
  .object({
    source_repo: z
      .object({
        trigger: z.string().min(1),
        repo: z.string().min(1),
      })
      .strict()
      .optional(),
    agent: z
      .object({
        default: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    review: reviewSchema.optional(),
    outputs: z
      .object({
        line_comments: z.array(z.string()).optional(),
        summary: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    sandbox: sandboxSchema.optional(),
  })
  .strict();

const appConfigSchema = z
  .object({
    llm: z
      .object({
        providers: z.array(llmProviderSchema).default([]),
      })
      .passthrough()
      .default({ providers: [] }),
    triggers: z.array(triggerSchema).default([]),
    outputs: z
      .object({
        template_engine: z.enum(["handlebars", "eta"]).default("handlebars"),
        channels: z.array(outputChannelSchema).default([]),
      })
      .passthrough()
      .default({ template_engine: "handlebars", channels: [] }),
    queue: z
      .object({
        kind: z.enum(["memory", "sqlite", "redis", "rabbitmq"]).default("memory"),
      })
      .passthrough()
      .default({ kind: "memory" }),
    agent: z
      .object({
        default: z.string().min(1).default("kilo"),
        timeout_seconds: z.number().int().positive().default(600),
        auto_approve: z.boolean().default(true),
        sandbox: sandboxSchema.default({ kind: "docker", engine: "auto" }),
      })
      .strict()
      .default({
        default: "kilo",
        timeout_seconds: 600,
        auto_approve: true,
        sandbox: { kind: "docker", engine: "auto" },
      }),
    review: z
      .object({
        incremental: z.boolean().default(true),
        skip_lgtm: z.boolean().default(true),
      })
      .passthrough()
      .default({ incremental: true, skip_lgtm: true }),
    workspaces: z
      .object({
        cache: z
          .object({
            max_total_gb: z.number().positive().default(50),
            eviction: z.enum(["lru", "mru", "ttl"]).default("lru"),
            ttl_days: z.number().int().positive().default(30),
          })
          .strict()
          .default({ max_total_gb: 50, eviction: "lru", ttl_days: 30 }),
        defaults: z
          .object({
            sandbox: sandboxSchema.optional(),
            review: reviewSchema.optional(),
          })
          .strict()
          .default({}),
        instances: z.record(workspaceIdSchema, workspaceInstanceSchema).default({}),
      })
      .strict()
      .default({
        cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
        defaults: {},
        instances: {},
      }),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;
export type AppConfigInput = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeValue(base: unknown, override: unknown): unknown {
  if (override === undefined) {
    return base;
  }

  if (Array.isArray(base) && Array.isArray(override)) {
    return override;
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      result[key] = mergeValue(base[key], value);
    }

    return result;
  }

  return override;
}

export function mergeConfigLayers(...layers: AppConfigInput[]): AppConfig {
  const merged = layers.reduce<Record<string, unknown>>((acc, layer) => {
    return mergeValue(acc, layer) as Record<string, unknown>;
  }, {});

  return appConfigSchema.parse(merged);
}

function normalizeConfigDocument(parsed: unknown): AppConfigInput {
  if (parsed == null) {
    return {};
  }

  if (!isPlainObject(parsed)) {
    throw new TypeError("Config file root must be a YAML mapping/object.");
  }

  return parsed;
}

export async function loadConfigFile(path: string): Promise<AppConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = normalizeConfigDocument(parseYaml(raw));

  return appConfigSchema.parse(parsed);
}

export { appConfigSchema };