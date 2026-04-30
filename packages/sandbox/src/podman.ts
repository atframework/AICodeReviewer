import { createDockerSandboxBackend, type DockerSandboxOptions } from "./docker.js";
import type { SandboxBackend } from "./types.js";

export type PodmanSandboxOptions = Omit<DockerSandboxOptions, "kind" | "engine">;

export function createPodmanSandboxBackend(options: PodmanSandboxOptions = {}): SandboxBackend {
  return createDockerSandboxBackend({
    ...options,
    kind: "podman",
    engine: "podman",
  });
}
