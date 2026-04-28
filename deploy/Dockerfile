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
COPY --chown=node:node .github ./.github
COPY --chown=node:node deploy ./deploy
COPY --chown=node:node packages ./packages
COPY --chown=node:node .markdownlint.json ./
COPY --chown=node:node Plan.md ./

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM cgr.dev/chainguard/node:latest AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /app /app

CMD ["packages/cli/dist/index.js", "--help"]