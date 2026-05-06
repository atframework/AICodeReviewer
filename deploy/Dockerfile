# =============================================================================
# AICodeReviewer — Dockerfile
# =============================================================================

# ---------- Build stage ----------
FROM cgr.dev/chainguard/node:latest-dev AS build

ARG NPM_REGISTRY=https://registry.npmmirror.com/
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV npm_config_registry=${NPM_REGISTRY}
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}

RUN corepack enable \
  && corepack prepare pnpm@10.20.0 --activate \
  && pnpm config set store-dir /pnpm/store
WORKDIR /app

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node prompts ./prompts
COPY --chown=node:node .markdownlint.json ./

RUN pnpm install --frozen-lockfile
RUN pnpm build

# ---------- Runtime stage ----------
FROM cgr.dev/chainguard/node:latest AS runtime

ENV NODE_ENV=production

WORKDIR /app

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
COPY --from=build --chown=node:node /app/prompts ./prompts

# Create workspace directory for cloned repos
RUN mkdir -p /app/workspaces && chown node:node /app/workspaces

# Config is expected at /app/config.yaml — mount or copy it
# Example: docker run -v $(pwd)/config.yaml:/app/config.yaml:ro ...
EXPOSE 8080

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["serve", "--config", "/app/config.yaml", "--port", "8080"]
