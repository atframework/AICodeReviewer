import type { SandboxBackend, SandboxKind, SandboxEngine } from "./types.js";
import { createNativeSandboxBackend } from "./native.js";
import { createDockerSandboxBackend, preflightSandbox } from "./docker.js";
import { createPodmanSandboxBackend } from "./podman.js";

export interface CreateSandboxOptions {
  readonly kind: SandboxKind;
  readonly engine?: SandboxEngine;
  readonly image?: string;
  readonly allowedCommands?: ReadonlySet<string>;
}

export async function createSandboxBackend(
  options: CreateSandboxOptions,
): Promise<SandboxBackend> {
  switch (options.kind) {
    case "native": {
      const nativeOpts = options.allowedCommands ? { allowedCommands: options.allowedCommands } : {};
      return createNativeSandboxBackend(nativeOpts);
    }

    case "docker":
    case "docker_socket": {
      const dockerOpts: {
        kind: Extract<SandboxKind, "docker" | "docker_socket">;
        image?: string;
        engine?: SandboxEngine;
        commandAllowlist?: ReadonlySet<string>;
      } = { kind: options.kind };
      if (options.image) dockerOpts.image = options.image;
      if (options.engine) dockerOpts.engine = options.engine;
      if (options.allowedCommands) dockerOpts.commandAllowlist = options.allowedCommands;
      return createDockerSandboxBackend(dockerOpts);
    }

    case "podman": {
      const podmanOpts: {
        image?: string;
        commandAllowlist?: ReadonlySet<string>;
      } = {};
      if (options.image) podmanOpts.image = options.image;
      if (options.allowedCommands) podmanOpts.commandAllowlist = options.allowedCommands;
      return createPodmanSandboxBackend(podmanOpts);
    }

    case "k8s_pod":
    case "firecracker":
      throw new TypeError(`Sandbox kind "${options.kind}" is not yet implemented.`);
  }
}

export async function resolveSandboxKind(
  configuredKind?: SandboxKind,
  configuredEngine?: SandboxEngine,
): Promise<{ kind: SandboxKind; engine: SandboxEngine }> {
  if (configuredKind && configuredKind !== "docker" && configuredKind !== "podman") {
    return { kind: configuredKind, engine: configuredEngine ?? "auto" };
  }

  const preferredEngine = configuredKind === "podman" ? "podman" : configuredEngine;
  const preflight = await preflightSandbox(preferredEngine);
  if (preflight.available) {
    const resolvedEngine = preflight.engine;
    const kind: SandboxKind = configuredKind ?? "docker";
    return { kind, engine: resolvedEngine };
  }

  return { kind: "native", engine: "auto" };
}

export { createNativeSandboxBackend } from "./native.js";
export { createDockerSandboxBackend, preflightSandbox } from "./docker.js";
export type { DockerSandboxOptions } from "./docker.js";
export { createPodmanSandboxBackend } from "./podman.js";
export type { PodmanSandboxOptions } from "./podman.js";
