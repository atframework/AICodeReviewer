# =============================================================================
# AICodeReviewer — Dockerfile
# =============================================================================
#
# Configurable build args (for domestic/China deployment):
#   BASE_IMAGE   — Distro base image for build/runtime stages (default: debian:trixie-slim)
#   NODE_IMAGE   — Official Node.js image used as the Node LTS userspace source
#                  (default: node:lts-trixie-slim, currently Node 24)
#   APT_MIRROR   — Debian apt mirror root for the main archive; security
#                  entries are derived by appending "-security"
#                  (e.g. http://mirrors.ustc.edu.cn/debian)
#   APK_MIRROR   — Deprecated alias for APT_MIRROR (kept for backward compatibility)
#   PERFORCE_APT_DISTRO — Ubuntu codename for the Perforce APT repo (default:
#                  noble). Perforce only publishes Ubuntu dists; the noble
#                  p4-cli build runs unchanged on trixie's newer glibc.
#   NPM_REGISTRY — npm/pnpm registry (e.g. http://mirrors.tencent.com/npm/)
#   NPM_STRICT_SSL — Set to false when using HTTP mirrors
#   PIP_INDEX_URL — pip simple index URL (e.g. https://mirrors.tencent.com/pypi/simple)
#   PIP_TRUSTED_HOST — Optional pip trusted-host for HTTP/private mirrors
#   KUBERNETES_APT_REPO_BASE — kubectl APT repo base ending in core:/stable:
#                  (e.g. https://mirrors.tencent.com/kubernetes_new/core:/stable:)
#   KUBERNETES_APT_REPO_VERSION — Kubernetes minor repo for kubectl (default: v1.36)
#   HELM_APT_REPO / HELM_APT_KEY_URL — Helm Debian package repo and signing key
#   YQ_VERSION / YQ_DOWNLOAD_BASE — Mike Farah yq release version and download base
#   GH_RELEASE_PREFIX — Optional URL prefix for GitHub release downloads of the
#                  pinned static CLI tools (e.g. https://mirror.example.com/ for
#                  ghproxy-style mirrors or an internal cache; default: direct)
#   *_VERSION    — Pinned upstream versions for the static CLI tools installed
#                  from GitHub releases (dust, xh, doggo, jaq, difftastic, ouch,
#                  procs, watchexec, tailspin, erdtree)
# =============================================================================

ARG NODE_IMAGE=node:lts-trixie-slim
ARG BASE_IMAGE=debian:trixie-slim
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
  MIRROR="${MIRROR%/}"; \
  if [ -n "${MIRROR}" ]; then \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
  sed -i \
  -e "s|http://deb.debian.org/debian-security|${MIRROR}-security|g" \
  -e "s|https://deb.debian.org/debian-security|${MIRROR}-security|g" \
  -e "s|http://deb.debian.org/debian|${MIRROR}|g" \
  -e "s|https://deb.debian.org/debian|${MIRROR}|g" \
  /etc/apt/sources.list.d/debian.sources; \
  fi; \
  if [ -f /etc/apt/sources.list ]; then \
  sed -i \
  -e "s|http://deb.debian.org/debian-security|${MIRROR}-security|g" \
  -e "s|https://deb.debian.org/debian-security|${MIRROR}-security|g" \
  -e "s|http://deb.debian.org/debian|${MIRROR}|g" \
  -e "s|https://deb.debian.org/debian|${MIRROR}|g" \
  /etc/apt/sources.list; \
  fi; \
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

# NOTE: docs/site is a workspace package but its directory is intentionally not
# COPYed into the runtime image. pnpm install silently skips workspace importers
# whose directories are absent, so Astro/Starlight never enters the runtime
# image. Do not add docs/site here. Root `pnpm build` is filtered to packages/*
# (see package.json) and will not build the docs site.

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
ARG GH_RELEASE_PREFIX=
ARG DUST_VERSION=v1.2.5
ARG XH_VERSION=v0.26.2
ARG DOGGO_VERSION=v1.4.0
ARG JAQ_VERSION=v3.1.1
ARG DIFFTASTIC_VERSION=0.70.0
ARG OUCH_VERSION=0.8.2
ARG PROCS_VERSION=v0.14.12
ARG WATCHEXEC_VERSION=v2.7.0
ARG TAILSPIN_VERSION=7.0.0
ARG ERDTREE_VERSION=v3.1.2
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
  MIRROR="${MIRROR%/}"; \
  if [ -n "${MIRROR}" ]; then \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
  sed -i \
  -e "s|http://deb.debian.org/debian-security|${MIRROR}-security|g" \
  -e "s|https://deb.debian.org/debian-security|${MIRROR}-security|g" \
  -e "s|http://deb.debian.org/debian|${MIRROR}|g" \
  -e "s|https://deb.debian.org/debian|${MIRROR}|g" \
  /etc/apt/sources.list.d/debian.sources; \
  fi; \
  if [ -f /etc/apt/sources.list ]; then \
  sed -i \
  -e "s|http://deb.debian.org/debian-security|${MIRROR}-security|g" \
  -e "s|https://deb.debian.org/debian-security|${MIRROR}-security|g" \
  -e "s|http://deb.debian.org/debian|${MIRROR}|g" \
  -e "s|https://deb.debian.org/debian|${MIRROR}|g" \
  /etc/apt/sources.list; \
  fi; \
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
  # Perforce's APT repo only publishes Ubuntu codename dists (verified: the
  # newest is noble); the noble p4-cli build runs unchanged on trixie's newer
  # glibc, so the repo path stays apt/ubuntu.
  echo "deb [signed-by=/usr/share/keyrings/perforce.gpg] https://package.perforce.com/apt/ubuntu ${PERFORCE_APT_DISTRO} release" > /etc/apt/sources.list.d/perforce.list; \
  echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] ${KUBERNETES_APT_REPO} /" > /etc/apt/sources.list.d/kubernetes.list; \
  echo "deb [signed-by=/usr/share/keyrings/helm.gpg] ${HELM_APT_REPO} any main" > /etc/apt/sources.list.d/helm-stable-debian.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
  aria2 \
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
  duf \
  eza \
  fd-find \
  file \
  fzf \
  gawk \
  gdb \
  git \
  git-delta \
  git-lfs \
  gzip \
  helm \
  hexyl \
  hyperfine \
  inotify-tools \
  iproute2 \
  iputils-ping \
  jq \
  kubectl \
  less \
  lnav \
  lsof \
  lz4 \
  miller \
  netcat-openbsd \
  ninja-build \
  openssh-client \
  openssl \
  p4-cli \
  patch \
  pigz \
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
  sd \
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
  ugrep \
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

# Normalize Debian command names so prompts and skills can consistently
# refer to `fd` / `bat` even though the distro packages ship `fdfind` / `batcat`.
RUN set -eux; \
  if command -v fdfind >/dev/null 2>&1; then \
  ln -sf "$(command -v fdfind)" /usr/local/bin/fd; \
  fi; \
  if command -v batcat >/dev/null 2>&1; then \
  ln -sf "$(command -v batcat)" /usr/local/bin/bat; \
  fi

# Modern CLI tools installed from pinned upstream GitHub release static
# binaries: either unpackaged in Debian trixie (doggo, jaq, difftastic, ouch,
# watchexec, erdtree) or deliberately newer than the trixie apt build (dust,
# xh, procs, tailspin). Pinned versions keep builds reproducible; bump the
# *_VERSION args above to upgrade. Upstream only publishes amd64/arm64 Linux
# artifacts, so other architectures skip this layer.
# GH_RELEASE_PREFIX optionally prefixes every release URL for ghproxy-style
# mirrors or internal caches on networks that cannot reach github.com directly
# (the deploy.sh build-proxy autodetect also covers these downloads).
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "${arch}" in \
  amd64) tarch=x86_64; jaq_asset=jaq-x86_64-unknown-linux-musl; difft_target=x86_64-unknown-linux-musl ;; \
  arm64) tarch=aarch64; jaq_asset=jaq-aarch64-unknown-linux-gnu; difft_target=aarch64-unknown-linux-gnu ;; \
  *) echo "Skipping GitHub-release CLI extras on unsupported arch: ${arch}"; exit 0 ;; \
  esac; \
  mkdir -p /tmp/mtcli; \
  cd /tmp/mtcli; \
  gh_dl() { curl -fsSL "${GH_RELEASE_PREFIX}https://github.com/$1/releases/download/$2/$3" -o "$3"; }; \
  gh_dl bootandy/dust "${DUST_VERSION}" "dust-${DUST_VERSION}-${tarch}-unknown-linux-musl.tar.gz"; \
  tar xzf "dust-${DUST_VERSION}-${tarch}-unknown-linux-musl.tar.gz"; \
  install -m 0755 "dust-${DUST_VERSION}-${tarch}-unknown-linux-musl/dust" /usr/local/bin/dust; \
  gh_dl ducaale/xh "${XH_VERSION}" "xh-${XH_VERSION}-${tarch}-unknown-linux-musl.tar.gz"; \
  tar xzf "xh-${XH_VERSION}-${tarch}-unknown-linux-musl.tar.gz"; \
  install -m 0755 "xh-${XH_VERSION}-${tarch}-unknown-linux-musl/xh" /usr/local/bin/xh; \
  gh_dl mr-karan/doggo "${DOGGO_VERSION}" "doggo-linux-${tarch}.tar.gz"; \
  mkdir -p doggo-pkg; \
  tar xzf "doggo-linux-${tarch}.tar.gz" -C doggo-pkg; \
  install -m 0755 doggo-pkg/doggo /usr/local/bin/doggo; \
  gh_dl 01mf02/jaq "${JAQ_VERSION}" "${jaq_asset}"; \
  install -m 0755 "${jaq_asset}" /usr/local/bin/jaq; \
  gh_dl Wilfred/difftastic "${DIFFTASTIC_VERSION}" "difft-${difft_target}.tar.gz"; \
  mkdir -p difft-pkg; \
  tar xzf "difft-${difft_target}.tar.gz" -C difft-pkg; \
  install -m 0755 difft-pkg/difft /usr/local/bin/difft; \
  gh_dl ouch-org/ouch "${OUCH_VERSION}" "ouch-${tarch}-unknown-linux-musl.tar.gz"; \
  tar xzf "ouch-${tarch}-unknown-linux-musl.tar.gz"; \
  install -m 0755 "ouch-${tarch}-unknown-linux-musl/ouch" /usr/local/bin/ouch; \
  gh_dl dalance/procs "${PROCS_VERSION}" "procs-${PROCS_VERSION}-${tarch}-linux.zip"; \
  mkdir -p procs-pkg; \
  unzip -q "procs-${PROCS_VERSION}-${tarch}-linux.zip" -d procs-pkg; \
  install -m 0755 procs-pkg/procs /usr/local/bin/procs; \
  gh_dl watchexec/watchexec "${WATCHEXEC_VERSION}" "watchexec-${WATCHEXEC_VERSION#v}-${tarch}-unknown-linux-musl.tar.xz"; \
  tar xJf "watchexec-${WATCHEXEC_VERSION#v}-${tarch}-unknown-linux-musl.tar.xz"; \
  install -m 0755 "watchexec-${WATCHEXEC_VERSION#v}-${tarch}-unknown-linux-musl/watchexec" /usr/local/bin/watchexec; \
  gh_dl bensadeh/tailspin "${TAILSPIN_VERSION}" "tailspin-${tarch}-unknown-linux-musl.tar.gz"; \
  mkdir -p tailspin-pkg; \
  tar xzf "tailspin-${tarch}-unknown-linux-musl.tar.gz" -C tailspin-pkg; \
  install -m 0755 tailspin-pkg/tspin /usr/local/bin/tspin; \
  ln -sf /usr/local/bin/tspin /usr/local/bin/tailspin; \
  gh_dl solidiquis/erdtree "${ERDTREE_VERSION}" "erd-${ERDTREE_VERSION}-${tarch}-unknown-linux-musl.tar.gz"; \
  mkdir -p erd-pkg; \
  tar xzf "erd-${ERDTREE_VERSION}-${tarch}-unknown-linux-musl.tar.gz" -C erd-pkg; \
  install -m 0755 erd-pkg/erd /usr/local/bin/erd; \
  cd /; \
  rm -rf /tmp/mtcli

WORKDIR /app

# Agent CLIs are installed unpinned so every build ships the latest published
# release. CLI_REFRESH is a cache-buster: deploy.sh passes a build timestamp so
# these layers never come from the build cache (otherwise the first "latest"
# would be served forever). Version-specific behavior notes live in
# docs/ai/AGENTS.known-pitfalls.md as "verified against vX" records.
ARG CLI_REFRESH=0
RUN echo "cli refresh: ${CLI_REFRESH}" \
  && npm install --global @kilocode/cli --registry="${NPM_REGISTRY}" --strict-ssl="${NPM_STRICT_SSL}"

# oh-my-pi (`omp`) ships alongside Kilo so `agent.default: oh-my-pi` works with
# the native sandbox inside this runtime image; container sandbox images are
# separate and do not include it. Its bundle requires the Bun runtime
# (engines: bun >= 1.3.14), installed from the registry so the platform binary
# uses the same mirror/proxy path as the rest of the image.
RUN npm install --global bun --registry="${NPM_REGISTRY}" --strict-ssl="${NPM_STRICT_SSL}"
# --ignore-scripts skips onnxruntime-node's optional postinstall download,
# which stalls indefinitely behind restrictive egress and only powers omp's
# non-essential local-embedding features; everything else in the tree ships
# prebuilt binaries via registry packages.
RUN npm install --global --ignore-scripts @oh-my-pi/pi-coding-agent --registry="${NPM_REGISTRY}" --strict-ssl="${NPM_STRICT_SSL}"

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
