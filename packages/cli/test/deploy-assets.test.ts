import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("deploy assets", () => {
  it("scopes Podman storage-driver arguments away from Docker engine runs", () => {
    const script = readRepoFile("deploy/deploy.sh");

    expect(script).toContain('ENGINE_BASENAME="$(basename "$ENGINE_CMD")"');
    expect(script).toContain('if [ "$ENGINE_BASENAME" = "podman" ]; then');
    expect(script).toContain("ENGINE_ARGS=(--storage-driver=overlay)");
    expect(script).toContain('if ! "$ENGINE_CMD" "${ENGINE_ARGS[@]}" ps >/dev/null 2>&1; then');
    expect(script).toContain('"$ENGINE_CMD" "${ENGINE_ARGS[@]}" build');
    expect(script).toContain('"$ENGINE_CMD" "${ENGINE_ARGS[@]}" run -d');
    expect(script).toContain('"$ENGINE_CMD" "${ENGINE_ARGS[@]}" exec');
    expect(script).toContain('"$ENGINE_CMD" "${ENGINE_ARGS[@]}" ps --filter');
    expect(script).not.toContain("$ENGINE_CMD $SD_FLAG");
  });

  it("removes the optional Docker CLI placeholder from runtime images when it is empty", () => {
    const dockerfile = readRepoFile("deploy/Dockerfile");

    expect(dockerfile).toContain("COPY deploy/docker-static /usr/local/bin/docker");
    expect(dockerfile).toContain("if [ -s /usr/local/bin/docker ]; then chmod +x /usr/local/bin/docker; else rm -f /usr/local/bin/docker; fi");
  });

  it("ships cloud-native and Podman socket client tooling", () => {
    const dockerfile = readRepoFile("deploy/Dockerfile");
    const script = readRepoFile("deploy/deploy.sh");

    expect(dockerfile).toContain("ARG KUBERNETES_APT_REPO_BASE=https://pkgs.k8s.io/core:/stable:");
    expect(dockerfile).toContain("ARG KUBERNETES_APT_REPO_VERSION=v1.36");
    expect(dockerfile).toContain("ARG HELM_APT_REPO=https://packages.buildkite.com/helm-linux/helm-debian/any/");
    expect(dockerfile).toContain("ARG YQ_VERSION=v4.53.2");
    expect(dockerfile).toContain("  kubectl \\");
    expect(dockerfile).toContain("  helm \\");
    expect(dockerfile).toContain("  podman \\");
    expect(dockerfile).toContain("  buildah \\");
    expect(dockerfile).toContain("  skopeo \\");
    expect(dockerfile).toContain("/usr/local/bin/yq");
    expect(script).toContain('-e "CONTAINER_HOST=unix://$PODMAN_SOCK"');
    expect(script).toContain("--build-arg \"KUBERNETES_APT_REPO_BASE=${KUBERNETES_APT_REPO_BASE}\"");
  });

  it("copies sandbox and eval workspace dependencies into the runtime image", () => {
    const dockerfile = readRepoFile("deploy/Dockerfile");

    expect(dockerfile).toContain("&& mkdir -p packages/sandbox/node_modules packages/eval/node_modules");
    expect(dockerfile).toContain("COPY --from=build --chown=node:node /app/packages/sandbox/node_modules ./packages/sandbox/node_modules");
    expect(dockerfile).toContain("COPY --from=build --chown=node:node /app/packages/eval/node_modules ./packages/eval/node_modules");
  });
});
