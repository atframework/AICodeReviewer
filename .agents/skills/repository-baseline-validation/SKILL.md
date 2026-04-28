---
name: repository-baseline-validation
description: "Validate repository-wide build, lint, test, markdown, Docker, and root tooling changes. Use when touching shared config, CI, Docker, docs, or workspace topology; do not use for isolated package-only feature edits."
user-invocable: false
---

# Repository Baseline Validation

## When to Use

- After changing root tooling files, CI, Docker, repository-wide docs, or workspace topology.
- After adding, removing, or renaming workspace packages.
- Before closing work that changes shared build, lint, test, or markdown gates.

## Do Not Use

- For package-local feature work that leaves shared tooling and workspace structure untouched.

## Procedure

1. Check the current baseline in `../../../docs/ai/AGENTS.repository-baseline.md`.
2. If workspace topology changed, verify package manifests, local `tsconfig.json` files, and root `tsconfig.json` references together.
3. Run validation in this order: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm markdownlint`, `pnpm build`.
4. Treat failures as baseline regressions; fix the root cause instead of broadening ignore patterns or weakening strict flags.
5. Put temporary validation helpers, logs, and captured output under `../../../build/` instead of scattering scratch files in the repository root.
6. If repository-wide conventions changed, update `../../../AGENTS.md`, `../../../docs/ai/AGENTS.repository-baseline.md`, and any affected skills in the same change.
7. Summarize which gates were run, which failed, and which shared files were touched.
