/**
 * ESM resolve hooks for repo child processes (P7 process matrix).
 *
 * Child fixtures are loaded through tsx from repository source, but every
 * `@aicr/*` workspace specifier would otherwise resolve to the package
 * `dist/` build output — which is a build artifact, not the source under
 * test. These hooks pin bare `@aicr/<pkg>` imports to
 * `packages/<pkg>/src/index.ts`, mirroring the vitest resolve.alias map in
 * the repository-root vitest.config.ts. Subpath imports do not exist in the
 * workspace (verified); only bare specifiers are rewritten.
 */
export async function resolve(
  specifier: string,
  context: { conditions?: string[]; parentURL?: string },
  nextResolve: (specifier: string, context?: unknown) => Promise<{ url: string }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier.startsWith("@aicr/") && !specifier.slice("@aicr/".length).includes("/")) {
    const pkg = specifier.slice("@aicr/".length);
    // import.meta.url = packages/server/test/fixtures/aicr-source-hooks.mts
    // → ../../../ = packages/ → packages/<pkg>/src/index.ts.
    return { url: new URL(`../../../${pkg}/src/index.ts`, import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
