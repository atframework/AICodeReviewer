---
name: workspace-scaffold-maintenance
description: "Maintain pnpm packages, manifests, exports, and TypeScript project references; skip package-local behavior changes."
user-invocable: false
---

# Workspace Scaffold Maintenance

1. Inspect neighboring package manifests and `tsconfig.json` files for the live
   workspace pattern. Update package `name/type/main/types/exports/build`, local
   compiler outputs/references, root references, and `workspace:*` consumers together.
2. Check `pnpm-workspace.yaml`, root scripts, ESLint/Vitest config, and
   `deploy/Dockerfile` for affected discovery/build inputs. Runtime sources/tests
   live under `packages/*/src` and `packages/*/test`.
3. Keep `docs/site` isolated: precise workspace entry, no root TypeScript
   reference, no runtime Docker copy. See
   [build/docs pitfalls](../../../docs/ai/pitfalls/AGENTS.build-and-docs.md).
4. Run [the baseline gates](../../../docs/ai/AGENTS.repository-baseline.md).
   Update the baseline guide only if its routing or conventions changed; do not
   duplicate versions or command tables into root instructions.
