---
name: workspace-scaffold-maintenance
description: "Use when: adding, removing, or reshaping pnpm workspace packages, package manifests, project references, or shared build wiring; do not use for package-local feature edits that leave the scaffold unchanged."
user-invocable: false
---

# Workspace Scaffold Maintenance

## When to Use

- Add, remove, or rename a package under `packages/*`.
- Change package exports, build scripts, workspace dependencies, or TypeScript project references.
- Adjust shared root configs such as ESLint, Vitest, TypeScript, or Docker build inputs.

## Do Not Use

- For feature-only work inside existing package source files when the workspace scaffold does not change.

## Procedure

1. Update the target package `package.json` (`name`, `type`, `main`, `types`, `exports`, and `build` script) to stay consistent with the workspace pattern.
2. Update the package `tsconfig.json` (`composite`, `rootDir`, `outDir`, `tsBuildInfoFile`, and local `references`) as needed.
3. Update root `tsconfig.json` references and any `workspace:*` dependencies when package relationships change.
4. Check whether the scaffold change also requires updates to `package.json`, `pnpm-workspace.yaml`, `eslint.config.mjs`, `vitest.config.ts`, `.markdownlint.json`, or `deploy/Dockerfile`.
5. Put temporary scaffold helpers, scratch scripts, and debug logs under `../../../build/` rather than the repository root.
6. Keep tests under `packages/*/test/**/*.test.ts` and source files under `packages/*/src/**/*.ts`.
7. Run the repository baseline validation workflow before finishing.
8. If the scaffold pattern itself changed, sync `../../../AGENTS.md`, `../../../docs/ai/AGENTS.repository-baseline.md`, and the relevant maintenance skills.
