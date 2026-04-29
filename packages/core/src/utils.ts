import { relative, resolve } from "node:path";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function normalizePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/+/gu, "/")
    .replace(/^\/+|\/+$/gu, "");
}

export function normalizeChangedPath(sourceRoot: string, changedPath: string): string {
  const absolutePath = resolve(sourceRoot, changedPath);
  const relativePath = normalizePath(relative(sourceRoot, absolutePath));

  if (!relativePath || relativePath.startsWith("../") || relativePath === "..") {
    throw new RangeError(`Changed path ${changedPath} must stay within ${sourceRoot}`);
  }

  return relativePath;
}
