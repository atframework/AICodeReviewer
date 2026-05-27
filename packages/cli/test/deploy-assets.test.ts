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

  it("auto-detects a host-side 3128 proxy for build and download steps", () => {
    const script = readRepoFile("deploy/deploy.sh");

    expect(script).toContain("DEFAULT_BUILD_PROXY_PORT=3128");
    expect(script).toContain('BUILD_PROXY_SOURCE="auto-detected host port ${DEFAULT_BUILD_PROXY_PORT}"');
    expect(script).toContain('run_with_build_proxy curl -fsSL -o /tmp/docker.tgz "$DOCKER_TGZ_URL"');
    expect(script).toContain('run_with_build_proxy "$ENGINE_CMD" "${ENGINE_ARGS[@]}" build');
    expect(script).toContain('BUILD_NETWORK_MODE="host"');
    expect(script).toContain('BUILD_ARGS+=(--http-proxy=true)');
    expect(script).toContain('BUILD_ARGS+=(--build-arg "HTTP_PROXY=${BUILD_HTTP_PROXY}" --build-arg "http_proxy=${BUILD_HTTP_PROXY}")');
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

  it("creates the node user without assuming uid or gid 1000 are free", () => {
    const dockerfile = readRepoFile("deploy/Dockerfile");

    expect(dockerfile).toContain("if getent group 1000 >/dev/null; then groupadd node; else groupadd --gid 1000 node; fi;");
    expect(dockerfile).toContain("if getent passwd 1000 >/dev/null; then useradd --gid node --create-home --shell /bin/bash node; else useradd --uid 1000 --gid node --create-home --shell /bin/bash node; fi;");
  });

  it("rewrites Ubuntu apt sources before the first apt update and supports ports variants", () => {
    const dockerfile = readRepoFile("deploy/Dockerfile");

    const buildStage = dockerfile.split("# ---------- Runtime stage ----------")[0] ?? dockerfile;
    const mirrorSwitchIndex = buildStage.indexOf('MIRROR="${APT_MIRROR:-${APK_MIRROR:-}}"; \\');
    const noninteractiveIndex = buildStage.indexOf("export DEBIAN_FRONTEND=noninteractive; \\");
    const firstAptUpdateIndex = buildStage.indexOf("apt-get update; \\");

    expect(dockerfile).toContain("COPY deploy/extra-ca/ /usr/local/share/ca-certificates/");
    expect(dockerfile).toContain('s|//ports.ubuntu.com/\\? |//ports.ubuntu.com/ubuntu-ports |g');
    expect(dockerfile).toContain("s|http://ports.ubuntu.com/ubuntu-ports|${MIRROR}|g");
    expect(dockerfile).toContain("s|https://ports.ubuntu.com/ubuntu-ports|${MIRROR}|g");
    expect(mirrorSwitchIndex).toBeGreaterThan(-1);
    expect(noninteractiveIndex).toBeGreaterThan(-1);
    expect(firstAptUpdateIndex).toBeGreaterThan(-1);
    expect(mirrorSwitchIndex).toBeLessThan(firstAptUpdateIndex);
    expect(noninteractiveIndex).toBeLessThan(firstAptUpdateIndex);
    expect(dockerfile).toContain("export DEBIAN_FRONTEND=noninteractive; \\");
    expect(dockerfile).toContain("export DEBCONF_NONINTERACTIVE_SEEN=true; \\");
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends ca-certificates; \\");
    expect(dockerfile).toContain("update-ca-certificates; \\");
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends \\\n  apt-transport-https \\\n  ca-certificates \\\n  curl \\\n  gnupg; \\");
  });

  it("copies sandbox and eval workspace dependencies into the runtime image", () => {
    const dockerfile = readRepoFile("deploy/Dockerfile");

    expect(dockerfile).toContain("&& mkdir -p packages/sandbox/node_modules packages/eval/node_modules");
    expect(dockerfile).toContain("COPY --from=build --chown=node:node /app/packages/sandbox/node_modules ./packages/sandbox/node_modules");
    expect(dockerfile).toContain("COPY --from=build --chown=node:node /app/packages/eval/node_modules ./packages/eval/node_modules");
  });
});
