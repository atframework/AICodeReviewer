import type { SandboxBackend } from "./types.js";

export interface FirecrackerSandboxOptions {
  readonly image?: string;
  readonly commandAllowlist?: ReadonlySet<string>;
}

export function createFirecrackerSandboxBackend(_options: FirecrackerSandboxOptions = {}): SandboxBackend {
  throw new TypeError(
    'Sandbox kind "firecracker" is not yet implemented. ' +
      "Planned implementation: create a Firecracker microVM via the Firecracker API, " +
      "mount source/agent/tmp as block devices or virtiofs, and stream logs back. " +
      "Install the firecracker binary and configure the API socket to enable this backend.",
  );
}
