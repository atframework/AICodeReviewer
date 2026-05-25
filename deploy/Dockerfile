# =============================================================================
# AICodeReviewer — Dockerfile
# =============================================================================

# ---------- Build stage ----------
FROM cgr.dev/chainguard/node:latest-dev AS build

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_STRICT_SSL=true
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV npm_config_registry=${NPM_REGISTRY}
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
ENV npm_config_strict_ssl=${NPM_STRICT_SSL}

USER root

# Install python3 and build tools for native module compilation (better-sqlite3)
RUN apk add --no-cache python3 make build-base

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
FROM cgr.dev/chainguard/node:latest-dev AS runtime

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_STRICT_SSL=true
ENV NODE_ENV=production
ENV npm_config_registry=${NPM_REGISTRY}
ENV npm_config_strict_ssl=${NPM_STRICT_SSL}

USER root
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

# Optional Docker CLI for nested container sandbox.
# When the host exposes a Podman docker-compatible socket, the static Docker
# CLI binary can communicate with Podman via the DOCKER_HOST env var.
COPY deploy/docker-static /usr/local/bin/docker
RUN if [ -s /usr/local/bin/docker ]; then chmod +x /usr/local/bin/docker; else rm -f /usr/local/bin/docker; fi

RUN mkdir -p /app/workspaces /app/data /app/logs && chown -R node:node /app/workspaces /app/data /app/logs

USER node

VOLUME ["/app/workspaces", "/app/data", "/app/logs"]

EXPOSE 8080

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["serve", "--config", "/app/config.yaml", "--port", "8080"]
