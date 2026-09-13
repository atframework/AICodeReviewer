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

  it("creates a docker_socket backend mapped to docker implementation", async () => {
    const backend = await createSandboxBackend({ kind: "docker_socket" });
    expect(backend.kind).toBe("docker_socket");
  });

  it("throws for k8s_pod with a descriptive message", async () => {
    await expect(createSandboxBackend({ kind: "k8s_pod" })).rejects.toThrow(
      'Sandbox kind "k8s_pod" is not yet implemented',
    );
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

  it("rejects an explicit container kind when preflight finds no engine (H04)", async () => {
    const noEngine = async () => ({ stdout: "", stderr: "not found", exitCode: 127 as number | null });
    await expect(resolveSandboxKind("docker", undefined, noEngine)).rejects.toThrow(
      /explicitly requested but no container engine is available/,
    );
    await expect(resolveSandboxKind("podman", "podman", noEngine)).rejects.toThrow(
      /refusing to silently fall back to native/,
    );
  });

  it("resolves an explicit container kind when an engine is available", async () => {
    const withDocker = async () => ({ stdout: "Docker version 27.0.0", stderr: "", exitCode: 0 as number | null });
    const result = await resolveSandboxKind("docker", undefined, withDocker);
    expect(result).toEqual({ kind: "docker", engine: "docker" });
  });

  it("keeps the native fallback for an unset kind (file trust ceiling preserved)", async () => {
    const noEngine = async () => ({ stdout: "", stderr: "not found", exitCode: 127 as number | null });
    const result = await resolveSandboxKind(undefined, undefined, noEngine);
    expect(result).toEqual({ kind: "native", engine: "auto" });
  });
});
