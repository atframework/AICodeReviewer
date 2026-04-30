export const sandboxPackageName = "@aicr/sandbox";

export type {
  SandboxKind,
  SandboxEngine,
  SandboxSpawnOptions,
  SandboxSpawnResult,
  SandboxMountSpec,
  SandboxWorkspaceLayout,
  SandboxMaterializeResult,
  SandboxBackend,
  SandboxBackendFactory,
  SandboxPreflightResult,
} from "./types.js";

export {
  ALLOWED_COMMANDS,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_TIMEOUT_MS,
  GRACE_PERIOD_MS,
} from "./types.js";

export { createNativeSandboxBackend } from "./native.js";
export { createDockerSandboxBackend, preflightSandbox } from "./docker.js";
export type { DockerSandboxOptions } from "./docker.js";
export { createPodmanSandboxBackend } from "./podman.js";
export type { PodmanSandboxOptions } from "./podman.js";
export { createSandboxBackend, resolveSandboxKind } from "./factory.js";
export type { CreateSandboxOptions } from "./factory.js";
