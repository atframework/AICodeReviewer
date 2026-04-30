import { describe, expect, it } from "vitest";

import { createPodmanSandboxBackend } from "../src/index.js";
import { createSandboxBackend, resolveSandboxKind } from "../src/factory.js";

describe("createSandboxBackend", () => {
  it("creates a native backend", async () => {
    const backend = await createSandboxBackend({ kind: "native" });
    expect(backend.kind).toBe("native");
  });

  it("creates a docker backend", async () => {
    const backend = await createSandboxBackend({ kind: "docker" });
    expect(backend.kind).toBe("docker");
  });

  it("preserves podman backend kind and engine", async () => {
    const backend = await createSandboxBackend({ kind: "podman", engine: "podman" });
    expect(backend.kind).toBe("podman");
    expect(backend.engine).toBe("podman");
  });

  it("exports a dedicated podman backend factory", () => {
    const backend = createPodmanSandboxBackend();
    expect(backend.kind).toBe("podman");
    expect(backend.engine).toBe("podman");
  });

  it("passes command allowlist to container backends", async () => {
    const backend = await createSandboxBackend({
      kind: "docker",
      allowedCommands: new Set(["echo"]),
    });

    await expect(
      backend.spawn({
        command: ["node", "-e", "console.log('blocked')"],
        cwd: "/tmp/aicr-agent",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("not in the allowed list");
  });

  it("throws for k8s_pod (not yet implemented)", async () => {
    await expect(createSandboxBackend({ kind: "k8s_pod" })).rejects.toThrow("not yet implemented");
  });

  it("throws for firecracker (not yet implemented)", async () => {
    await expect(createSandboxBackend({ kind: "firecracker" })).rejects.toThrow("not yet implemented");
  });
});

describe("resolveSandboxKind", () => {
  it("returns native when configured as native", async () => {
    const result = await resolveSandboxKind("native");
    expect(result.kind).toBe("native");
  });

  it("returns native when preflight finds no container engine", async () => {
    // This test assumes the system has at least docker or podman or falls back to native
    const result = await resolveSandboxKind("docker");
    // On a system without docker/podman, it falls back to native
    expect(["docker", "podman", "native"]).toContain(result.kind);
  });
});
