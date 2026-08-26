// Module-resolution hook for validating docs against TypeScript sources.
//
// The runtime packages import siblings via their emitted `.js` names (tsc
// `moduleResolution: nodenext`), so `packages/*/src/*.ts` files contain
// `import ... from "./sibling.js"` specifiers. Node's native type stripping
// (Node >= 23.6) can load those `.ts` sources directly, but it cannot resolve
// the `.js` names against `.ts` files. This hook rewrites repo-internal
// relative `.js` specifiers coming from `packages/*/src/` to `.ts` so doc
// validation scripts can import schemas straight from source without building
// the packages first — validation always sees the current schema, never a
// stale dist artifact.

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js") &&
    context.parentURL !== undefined &&
    /[\\/]packages[\\/][^\\/]+[\\/]src[\\/]/u.test(new URL(context.parentURL).pathname)
  ) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    } catch {
      // Fall through: the `.js` file may legitimately exist (compiled output).
    }
  }

  return nextResolve(specifier, context);
}
