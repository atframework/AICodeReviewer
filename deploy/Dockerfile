# =============================================================================
# AICodeReviewer — Dockerfile
# =============================================================================
#
# Configurable build args (for domestic/China deployment):
#   BASE_IMAGE   — Distro base image for build/runtime stages (default: ubuntu:24.04)
#   NODE_IMAGE   — Official Node.js image used as the Node 22 userspace source
#                  (default: node:22-bookworm-slim)
#   APT_MIRROR   — Ubuntu apt mirror root (e.g. http://mirrors.ustc.edu.cn/ubuntu)
#   APK_MIRROR   — Deprecated alias for APT_MIRROR (kept for backward compatibility)
#   PERFORCE_APT_DISTRO — Ubuntu codename for Perforce APT repo (default: noble)
#   NPM_REGISTRY — npm/pnpm registry (e.g. http://mirrors.tencent.com/npm/)
#   NPM_STRICT_SSL — Set to false when using HTTP mirrors
#   PIP_INDEX_URL — pip simple index URL (e.g. https://mirrors.tencent.com/pypi/simple)
#   PIP_TRUSTED_HOST — Optional pip trusted-host for HTTP/private mirrors
#   KUBERNETES_APT_REPO_BASE — kubectl APT repo base ending in core:/stable:
#                  (e.g. https://mirrors.tencent.com/kubernetes_new/core:/stable:)
#   KUBERNETES_APT_REPO_VERSION — Kubernetes minor repo for kubectl (default: v1.36)
#   HELM_APT_REPO / HELM_APT_KEY_URL — Helm Debian package repo and signing key
#   YQ_VERSION / YQ_DOWNLOAD_BASE — Mike Farah yq release version and download base
# =============================================================================

ARG NODE_IMAGE=node:22-bookworm-slim
ARG BASE_IMAGE=ubuntu:24.04
FROM ${NODE_IMAGE} AS node-base

# ---------- Build stage ----------
FROM ${BASE_IMAGE} AS build

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_STRICT_SSL=true
ARG APT_MIRROR=
ARG APK_MIRROR=
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_TRUSTED_HOST=
ENV PNPM_HOME=/pnpm
ENV PATH=/usr/local/bin:${PNPM_HOME}:${PATH}
ENV npm_config_registry=${NPM_REGISTRY}
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
ENV npm_config_strict_ssl=${NPM_STRICT_SSL}
ENV PIP_INDEX_URL=${PIP_INDEX_URL}
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_NO_CACHE_DIR=1

USER root

COPY deploy/extra-ca/ /usr/local/share/ca-certificates/

RUN set -eux; \
  export DEBIAN_FRONTEND=noninteractive; \
  export DEBCONF_NONINTERACTIVE_SEEN=true; \
  MIRROR="${APT_MIRROR:-${APK_MIRROR:-}}"; \
  if [ -n "${MIRROR}" ]; then \
  if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
  sed -i \
  -e "s|http://archive.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|http://security.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|https://archive.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|https://security.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|http://ports.ubuntu.com/ubuntu-ports|${MIRROR}|g" \
  -e "s|https://ports.ubuntu.com/ubuntu-ports|${MIRROR}|g" \
  /etc/apt/sources.list.d/ubuntu.sources; \
  fi; \
  if [ -f /etc/apt/sources.list ]; then \
  sed -i \
  -e 's|//ports.ubuntu.com/\? |//ports.ubuntu.com/ubuntu-ports |g' \
  -e "s|http://archive.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|http://security.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|https://archive.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|https://security.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|http://ports.ubuntu.com/ubuntu-ports|${MIRROR}|g" \
  -e "s|https://ports.ubuntu.com/ubuntu-ports|${MIRROR}|g" \
  /etc/apt/sources.list; \
  fi; \
  fi; \
  if [ -f /etc/apt/sources.list.d/ubuntu.sources ] \
  && ! grep -q '^Components: .*universe' /etc/apt/sources.list.d/ubuntu.sources; then \
  sed -i 's/^Components: \(.*\)$/Components: \1 universe/' /etc/apt/sources.list.d/ubuntu.sources; \
  fi; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates; \
  update-ca-certificates; \
  if ! getent group node >/dev/null; then \
  if getent group 1000 >/dev/null; then groupadd node; else groupadd --gid 1000 node; fi; \
  fi; \
  if ! id -u node >/dev/null 2>&1; then \
  if getent passwd 1000 >/dev/null; then useradd --gid node --create-home --shell /bin/bash node; else useradd --uid 1000 --gid node --create-home --shell /bin/bash node; fi; \
  fi; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  curl \
  gnupg \
  pkg-config \
  python-is-python3 \
  python3 \
  python3-dev \
  python3-pip \
  python3-setuptools \
  python3-venv \
  python3-wheel; \
  rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  { \
  echo '[global]'; \
  echo "index-url = ${PIP_INDEX_URL}"; \
  if [ -n "${PIP_TRUSTED_HOST}" ]; then echo "trusted-host = ${PIP_TRUSTED_HOST}"; fi; \
  echo 'disable-pip-version-check = true'; \
  } > /etc/pip.conf

COPY --from=node-base /usr/local/ /usr/local/

RUN npm install --global pnpm@10.20.0 --registry="${NPM_REGISTRY}" --strict-ssl="${NPM_STRICT_SSL}" \
  && pnpm config set strict-ssl "${NPM_STRICT_SSL}" \
  && pnpm config set store-dir /pnpm/store
WORKDIR /app

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node prompts ./prompts
COPY --chown=node:node templates ./templates
COPY --chown=node:node .markdownlint.json ./

RUN pnpm install --frozen-lockfile \
  && mkdir -p packages/sandbox/node_modules packages/eval/node_modules
RUN pnpm build

# ---------- Runtime stage ----------
FROM ${BASE_IMAGE} AS runtime

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_STRICT_SSL=true
ARG APT_MIRROR=
ARG APK_MIRROR=
ARG PERFORCE_APT_DISTRO=noble
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_TRUSTED_HOST=
ARG KUBERNETES_APT_REPO_BASE=https://pkgs.k8s.io/core:/stable:
ARG KUBERNETES_APT_REPO_VERSION=v1.36
ARG HELM_APT_REPO=https://packages.buildkite.com/helm-linux/helm-debian/any/
ARG HELM_APT_KEY_URL=https://packages.buildkite.com/helm-linux/helm-debian/gpgkey
ARG YQ_VERSION=v4.53.2
ARG YQ_DOWNLOAD_BASE=https://github.com/mikefarah/yq/releases/download
ENV NODE_ENV=production
ENV npm_config_registry=${NPM_REGISTRY}
ENV npm_config_strict_ssl=${NPM_STRICT_SSL}
ENV PIP_INDEX_URL=${PIP_INDEX_URL}
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_NO_CACHE_DIR=1

USER root

COPY deploy/extra-ca/ /usr/local/share/ca-certificates/

RUN set -eux; \
  export DEBIAN_FRONTEND=noninteractive; \
  export DEBCONF_NONINTERACTIVE_SEEN=true; \
  MIRROR="${APT_MIRROR:-${APK_MIRROR:-}}"; \
  if [ -n "${MIRROR}" ]; then \
  if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
  sed -i \
  -e "s|http://archive.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|http://security.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|https://archive.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|https://security.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|http://ports.ubuntu.com/ubuntu-ports|${MIRROR}|g" \
  -e "s|https://ports.ubuntu.com/ubuntu-ports|${MIRROR}|g" \
  /etc/apt/sources.list.d/ubuntu.sources; \
  fi; \
  if [ -f /etc/apt/sources.list ]; then \
  sed -i \
  -e 's|//ports.ubuntu.com/\? |//ports.ubuntu.com/ubuntu-ports |g' \
  -e "s|http://archive.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|http://security.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|https://archive.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|https://security.ubuntu.com/ubuntu|${MIRROR}|g" \
  -e "s|http://ports.ubuntu.com/ubuntu-ports|${MIRROR}|g" \
  -e "s|https://ports.ubuntu.com/ubuntu-ports|${MIRROR}|g" \
  /etc/apt/sources.list; \
  fi; \
  fi; \
  if [ -f /etc/apt/sources.list.d/ubuntu.sources ] \
  && ! grep -q '^Components: .*universe' /etc/apt/sources.list.d/ubuntu.sources; then \
  sed -i 's/^Components: \(.*\)$/Components: \1 universe/' /etc/apt/sources.list.d/ubuntu.sources; \
  fi; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
  apt-transport-https \
  ca-certificates \
  curl \
  gnupg; \
  update-ca-certificates; \
  apt-get update; \
  mkdir -p /etc/apt/keyrings; \
  mkdir -p /usr/share/keyrings; \
  curl -fsSL https://package.perforce.com/perforce.pubkey | gpg --dearmor -o /usr/share/keyrings/perforce.gpg; \
  chmod a+r /usr/share/keyrings/perforce.gpg; \
  KUBERNETES_APT_REPO="${KUBERNETES_APT_REPO_BASE%/}/${KUBERNETES_APT_REPO_VERSION}/deb/"; \
  curl -fsSL "${KUBERNETES_APT_REPO}Release.key" | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg; \
  chmod a+r /etc/apt/keyrings/kubernetes-apt-keyring.gpg; \
  curl -fsSL "${HELM_APT_KEY_URL}" | gpg --dearmor -o /usr/share/keyrings/helm.gpg; \
  chmod a+r /usr/share/keyrings/helm.gpg; \
  echo "deb [signed-by=/usr/share/keyrings/perforce.gpg] https://package.perforce.com/apt/ubuntu ${PERFORCE_APT_DISTRO} release" > /etc/apt/sources.list.d/perforce.list; \
  echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] ${KUBERNETES_APT_REPO} /" > /etc/apt/sources.list.d/kubernetes.list; \
  echo "deb [signed-by=/usr/share/keyrings/helm.gpg] ${HELM_APT_REPO} any main" > /etc/apt/sources.list.d/helm-stable-debian.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
  bat \
  buildah \
  bsdextrautils \
  build-essential \
  bzip2 \
  clang \
  clang-format \
  clang-tidy \
  cmake \
  cppcheck \
  diffutils \
  dnsutils \
  fd-find \
  file \
  gawk \
  gdb \
  git \
  git-lfs \
  gzip \
  helm \
  inotify-tools \
  iproute2 \
  iputils-ping \
  jq \
  kubectl \
  less \
  lsof \
  lz4 \
  netcat-openbsd \
  ninja-build \
  openssh-client \
  openssl \
  p4-cli \
  patch \
  pkg-config \
  podman \
  procps \
  psmisc \
  python-is-python3 \
  python3 \
  python3-dev \
  python3-pip \
  python3-setuptools \
  python3-venv \
  python3-wheel \
  ripgrep \
  rsync \
  sed \
  shellcheck \
  skopeo \
  sqlite3 \
  strace \
  subversion \
  tar \
  tcpdump \
  time \
  tree \
  universal-ctags \
  unzip \
  valgrind \
  wget \
  xxd \
  xz-utils \
  zip \
  zstd; \
  yq_arch="$(dpkg --print-architecture)"; \
  case "${yq_arch}" in \
  amd64) yq_platform=linux_amd64 ;; \
  arm64) yq_platform=linux_arm64 ;; \
  armhf) yq_platform=linux_arm ;; \
  i386) yq_platform=linux_386 ;; \
  *) echo "Unsupported yq architecture: ${yq_arch}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "${YQ_DOWNLOAD_BASE}/${YQ_VERSION}/yq_${yq_platform}" -o /usr/local/bin/yq; \
  chmod +x /usr/local/bin/yq; \
  rm -rf /var/lib/apt/lists/*; \
  if ! getent group node >/dev/null; then \
  if getent group 1000 >/dev/null; then groupadd node; else groupadd --gid 1000 node; fi; \
  fi; \
  if ! id -u node >/dev/null 2>&1; then \
  if getent passwd 1000 >/dev/null; then useradd --gid node --create-home --shell /bin/bash node; else useradd --uid 1000 --gid node --create-home --shell /bin/bash node; fi; \
  fi

COPY --from=node-base /usr/local/ /usr/local/

RUN set -eux; \
  { \
  echo '[global]'; \
  echo "index-url = ${PIP_INDEX_URL}"; \
  if [ -n "${PIP_TRUSTED_HOST}" ]; then echo "trusted-host = ${PIP_TRUSTED_HOST}"; fi; \
  echo 'disable-pip-version-check = true'; \
  } > /etc/pip.conf

# Normalize Debian/Ubuntu command names so prompts and skills can consistently
# refer to `fd` / `bat` even though the distro packages ship `fdfind` / `batcat`.
RUN set -eux; \
  if command -v fdfind >/dev/null 2>&1; then \
  ln -sf "$(command -v fdfind)" /usr/local/bin/fd; \
  fi; \
  if command -v batcat >/dev/null 2>&1; then \
  ln -sf "$(command -v batcat)" /usr/local/bin/bat; \
  fi

WORKDIR /app

RUN npm install --global @kilocode/cli@7.2.40 --registry="${NPM_REGISTRY}" --strict-ssl="${NPM_STRICT_SSL}"

COPY --from=build --chown=node:node /app/packages/cli/package.json ./packages/cli/package.json
COPY --from=build --chown=node:node /app/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=node:node /app/packages/server/package.json ./packages/server/package.json
COPY --from=build --chown=node:node /app/packages/llm/package.json ./packages/llm/package.json
COPY --from=build --chown=node:node /app/packages/vcs/package.json ./packages/vcs/package.json
COPY --from=build --chown=node:node /app/packages/outputs/package.json ./packages/outputs/package.json
COPY --from=build --chown=node:node /app/packages/mcp-output/package.json ./packages/mcp-output/package.json
COPY --from=build --chown=node:node /app/packages/sandbox/package.json ./packages/sandbox/package.json
COPY --from=build --chown=node:node /app/packages/agents/package.json ./packages/agents/package.json
COPY --from=build --chown=node:node /app/packages/store/package.json ./packages/store/package.json
COPY --from=build --chown=node:node /app/packages/eval/package.json ./packages/eval/package.json
COPY --from=build --chown=node:node /app/packages/cli/dist ./packages/cli/dist
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/server/dist ./packages/server/dist
COPY --from=build --chown=node:node /app/packages/llm/dist ./packages/llm/dist
COPY --from=build --chown=node:node /app/packages/llm/assets ./packages/llm/assets
COPY --from=build --chown=node:node /app/packages/vcs/dist ./packages/vcs/dist
COPY --from=build --chown=node:node /app/packages/outputs/dist ./packages/outputs/dist
COPY --from=build --chown=node:node /app/packages/mcp-output/dist ./packages/mcp-output/dist
COPY --from=build --chown=node:node /app/packages/sandbox/dist ./packages/sandbox/dist
COPY --from=build --chown=node:node /app/packages/agents/dist ./packages/agents/dist
COPY --from=build --chown=node:node /app/packages/store/dist ./packages/store/dist
COPY --from=build --chown=node:node /app/packages/eval/dist ./packages/eval/dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/cli/node_modules ./packages/cli/node_modules
COPY --from=build --chown=node:node /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build --chown=node:node /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build --chown=node:node /app/packages/llm/node_modules ./packages/llm/node_modules
COPY --from=build --chown=node:node /app/packages/vcs/node_modules ./packages/vcs/node_modules
COPY --from=build --chown=node:node /app/packages/outputs/node_modules ./packages/outputs/node_modules
COPY --from=build --chown=node:node /app/packages/mcp-output/node_modules ./packages/mcp-output/node_modules
COPY --from=build --chown=node:node /app/packages/sandbox/node_modules ./packages/sandbox/node_modules
COPY --from=build --chown=node:node /app/packages/agents/node_modules ./packages/agents/node_modules
COPY --from=build --chown=node:node /app/packages/store/node_modules ./packages/store/node_modules
COPY --from=build --chown=node:node /app/packages/eval/node_modules ./packages/eval/node_modules
COPY --from=build --chown=node:node /app/prompts ./prompts
COPY --from=build --chown=node:node /app/templates ./templates

# Optional Docker CLI for nested container sandbox compatibility. The runtime
# image also ships the Podman CLI; deploy.sh sets CONTAINER_HOST for native
# Podman socket access and DOCKER_HOST for Docker-compatible clients.
COPY deploy/docker-static /usr/local/bin/docker
RUN if [ -s /usr/local/bin/docker ]; then chmod +x /usr/local/bin/docker; else rm -f /usr/local/bin/docker; fi

RUN mkdir -p /app/workspaces /app/data /app/logs && chown -R node:node /app/workspaces /app/data /app/logs

USER node

VOLUME ["/app/workspaces", "/app/data", "/app/logs"]

EXPOSE 8080

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["serve", "--config", "/app/config.yaml", "--port", "8080"]
