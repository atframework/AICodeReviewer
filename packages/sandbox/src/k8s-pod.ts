import type { SandboxBackend } from "./types.js";

export interface K8sPodSandboxOptions {
  readonly namespace?: string;
  readonly image?: string;
  readonly commandAllowlist?: ReadonlySet<string>;
}

export function createK8sPodSandboxBackend(_options: K8sPodSandboxOptions = {}): SandboxBackend {
  throw new TypeError(
    'Sandbox kind "k8s_pod" is not yet implemented. ' +
      "Planned implementation: create a Kubernetes Job Pod via the Kubernetes API, " +
      "mount source/agent/tmp as volumes, and stream logs back. " +
      "Install @kubernetes/client-node and configure kubeconfig to enable this backend.",
  );
}
