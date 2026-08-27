import type { ModelSpec } from "@aicr/llm";

export type AgentKind = "kilo" | "opencode" | "zoo" | "copilot-cli" | "claude-code" | "pi" | "oh-my-pi";

export interface AgentDetectResult {
  readonly available: boolean;
  readonly binary: string;
  readonly version?: string;
}

export interface AgentMaterializeResult {
  readonly configFiles: ReadonlyMap<string, string>;
  readonly envVars: Readonly<Record<string, string>>;
  readonly workingDir: string;
}

export interface AgentSpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface AgentCompactionOptions {
  readonly auto: boolean;
  readonly thresholdPercent?: number;
  readonly prune?: boolean;
}

export interface AgentWebSearchSearxngOptions {
  readonly endpoint?: string;
  readonly categories?: string;
  readonly engines?: string;
  readonly language?: string;
  readonly safesearch?: number;
}

export interface AgentWebSearchOptions {
  readonly enabled: boolean;
  /** Ordered provider ids: full chain for omp, supported-backend selector for kilo/opencode. */
  readonly providers?: readonly string[];
  /** omp search provider ids removed from the chain (`providers.webSearchExclude`). */
  readonly exclude?: readonly string[];
  /** Per-provider search transport timeout in seconds (`providers.webSearchTimeoutSeconds`, omp caps at 300). */
  readonly timeoutSeconds?: number;
  /**
   * Credential provider id -> env var name that holds the secret on the AICR host.
   * Each supporting adapter injects its native env var with a `${VAR}` reference;
   * disabled runs inject none, and secrets never persist in the runtime bundle.
   */
  readonly credentials?: Readonly<Record<string, string>>;
  readonly searxng?: AgentWebSearchSearxngOptions;
}

export interface AgentMaterializeOptions {
  readonly compaction?: AgentCompactionOptions;
  readonly webSearch?: AgentWebSearchOptions;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  detect(): Promise<AgentDetectResult>;
  buildCommand(task: string, options: AgentSpawnOptions): readonly string[];
  buildStdin?(task: string, options: AgentSpawnOptions): string;
  materializeConfig(
    model: ModelSpec,
    workingDir: string,
    options?: AgentMaterializeOptions,
  ): Promise<AgentMaterializeResult>;
}

export interface AgentSpawnMcpServer {
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface AgentSpawnOptions {
  readonly workingDir: string;
  readonly timeoutMs?: number;
  readonly model?: ModelSpec;
  readonly autoApprove?: boolean;
  readonly task: string;
  /**
   * MCP servers materialized into the runtime bundle, so adapters that wire MCP via
   * command-line flags (instead of config files) can emit adapter-native MCP config.
   * The config shape is the canonical kilo/opencode form:
   * `{ "type": "local", "command": [...] }` or `{ "type": "remote", "url": "..." }`.
   */
  readonly mcpServers?: readonly AgentSpawnMcpServer[];
  /**
   * Web search control for adapters whose only surface is the command line
   * (claude-code `--disallowedTools`, copilot-cli `--excluded-tools`).
   */
  readonly webSearch?: AgentWebSearchOptions;
}

export interface AgentProfileConfig {
  readonly id: string;
  readonly detect: {
    readonly binary: string;
    readonly versionArgs?: readonly string[];
  };
  readonly files: {
    readonly config: string;
    readonly skillsDir: string;
    readonly mcpConfig?: string;
  };
  readonly command: {
    readonly template: readonly string[];
    readonly stdin: "task" | "none";
  };
  readonly autoApprove: {
    readonly flags: readonly string[];
    readonly refuseIfMissing: boolean;
  };
}

export interface ModelConfigTranslation {
  readonly providerId: string;
  readonly modelId: string;
  readonly configJson: string;
  readonly envVars: Readonly<Record<string, string>>;
  readonly cliFlags: readonly string[];
}

export interface ModelTranslator {
  translate(model: ModelSpec): ModelConfigTranslation;
}
