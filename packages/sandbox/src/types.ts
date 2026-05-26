export type SandboxKind =
  | "native"
  | "docker"
  | "podman"
  | "docker_socket"
  | "k8s_pod"
  | "firecracker";

export type SandboxEngine = "auto" | "docker" | "podman";

export interface SandboxSpawnOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
}

export interface SandboxSpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface SandboxMountSpec {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly readOnly?: boolean;
}

export interface SandboxWorkspaceLayout {
  readonly sourceDir?: string;
  readonly agentDir: string;
  readonly tmpDir: string;
  readonly extraMounts?: readonly SandboxMountSpec[];
}

export interface SandboxMaterializeResult {
  readonly agentDir: string;
  readonly tmpDir: string;
  readonly mountSpecs: readonly SandboxMountSpec[];
}

export interface SandboxBackend {
  readonly kind: SandboxKind;
  readonly engine?: SandboxEngine;
  spawn(options: SandboxSpawnOptions): Promise<SandboxSpawnResult>;
  materializeFs(layout: SandboxWorkspaceLayout): Promise<SandboxMaterializeResult>;
  teardown(): Promise<void>;
}

export interface SandboxBackendFactory {
  readonly kind: SandboxKind;
  create(options?: Readonly<Record<string, unknown>>): SandboxBackend;
}

export interface SandboxPreflightResult {
  readonly engine: "docker" | "podman";
  readonly available: boolean;
  readonly version?: string;
}

export const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "git",
  "git-lfs",
  "svn",
  "p4",
  "jq",
  "rg",
  "fd",
  "bat",
  "grep",
  "sed",
  "awk",
  "find",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "diff",
  "sort",
  "uniq",
  "cut",
  "tr",
  "xargs",
  "curl",
  "wget",
  "patch",
  "tar",
  "gzip",
  "gunzip",
  "zcat",
  "bzip2",
  "bunzip2",
  "bzcat",
  "xz",
  "unxz",
  "xzcat",
  "zstd",
  "unzstd",
  "zstdcat",
  "lz4",
  "unlz4",
  "lz4cat",
  "unzip",
  "zip",
  "node",
  "npx",
  "npm",
  "pnpm",
  "kilo",
  "claude",
  "copilot",
  "roo",
  "opencode",
]);

export const DEFAULT_SANDBOX_IMAGE = "ghcr.io/owent/aicr-agent:latest";
export const DEFAULT_TIMEOUT_MS = 600_000;
export const GRACE_PERIOD_MS = 5_000;
