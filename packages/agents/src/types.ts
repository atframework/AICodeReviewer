import type { ModelSpec } from "@aicr/llm";

export type AgentKind = "kilo" | "opencode" | "roo" | "copilot-cli" | "claude-code";

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

export interface AgentAdapter {
  readonly kind: AgentKind;
  detect(): Promise<AgentDetectResult>;
  buildCommand(task: string, options: AgentSpawnOptions): readonly string[];
  materializeConfig(model: ModelSpec, workingDir: string): Promise<AgentMaterializeResult>;
}

export interface AgentSpawnOptions {
  readonly workingDir: string;
  readonly timeoutMs?: number;
  readonly model?: ModelSpec;
  readonly autoApprove?: boolean;
  readonly task: string;
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
