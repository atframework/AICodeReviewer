---
name: repository-baseline-validation
description: "Use when: validating repository-wide build, lint, test, markdown, Docker, docs, CI, root tooling, or workspace topology changes; do not use for isolated package-only feature edits."
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
3. Run validation in this order (see environment notes below for Windows workarounds):
   - Lint
   - Typecheck
   - Tests
   - Markdownlint
   - Build
   - Eval fixture validation (`aicr eval --validate-only`) after build
4. Run targeted checks while iterating, then restart the complete applicable sequence after the final edit. On Linux/CI, `pnpm ci` is the final runtime gate; on Windows, run the table commands in order because PowerShell may block pnpm's `.ps1` shim.
5. Confirm each command actually exercised its target (for example, Markdownlint reports discovered files and Vitest reports test files/tests). A silent or no-op exit code 0 is not a passing gate.
6. Treat failures as baseline regressions; fix the root cause instead of broadening ignore patterns or weakening strict flags.
7. Put temporary validation helpers, logs, and captured output under the repository `build/` directory (e.g. `build/tmp/`, `build/logs/`) instead of scattering scratch files in the repository root. Ensure the subdirectory exists before writing.
8. If repository-wide conventions or AI-doc routing changed, update `../../../AGENTS.md`, `../../../docs/ai/AGENTS.repository-baseline.md`, `../../../docs/ai/index.md`, and any affected skills in the same change.
9. When touching public/shared modules, verify generic entry points do not duplicate platform literal lists or expose platform-specific field names; platform names belong in config contracts, docs/examples, tests, and platform-specific adapters.
10. Summarize which gates were run, which failed, and which shared files were touched.

## Environment: Windows PowerShell workarounds

On Windows, PowerShell execution policy blocks `.ps1` scripts by default. Use `node` to invoke CLI tools directly:

| Tool         | Windows command                                                                                                             | Linux/CI command    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Lint         | `node node_modules/eslint/bin/eslint.js . --max-warnings=0`                                                                 | `pnpm lint`         |
| Typecheck    | `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false`                                                      | `pnpm typecheck`    |
| Test         | `node node_modules/vitest/vitest.mjs run --coverage`                                                                        | `pnpm test`         |
| Markdownlint | `node node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs`                                                             | `pnpm markdownlint` |
| Build        | `cmd /c "pnpm build"`                                                                                                       | `pnpm build`        |
| Eval fixtures | `node packages/cli/dist/index.js eval --validate-only`                                                                      | `pnpm eval:validate` |

Always try the `node` direct invocation first if `pnpm` or `npx` fails with a PowerShell security error.
