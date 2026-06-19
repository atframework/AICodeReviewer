import { normalizePath } from "@aicr/core";

export function filterFilesByWatchPath(files: readonly string[], watchPath: readonly string[] | undefined): string[] {
  if (!watchPath || watchPath.length === 0) {
    return [...files];
  }

  const normalizedWatchPath = watchPath.map((wp) => normalizePath(wp));
  return files.filter((file) =>
    normalizedWatchPath.some((wp) => file === wp || file.startsWith(`${wp}/`)),
  );
}

export function filterFilesByPatterns(
  files: readonly string[],
  includePatterns: readonly string[] | undefined,
  excludePatterns: readonly string[] | undefined,
): string[] {
  let filtered = [...files];

  if (includePatterns && includePatterns.length > 0) {
    const includeMatchers = includePatterns.map((pattern) => createGlobMatcher(pattern));
    filtered = filtered.filter((file) =>
      includeMatchers.some((matches) => matches(file)),
    );
  }

  if (excludePatterns && excludePatterns.length > 0) {
    const excludeMatchers = excludePatterns.map((pattern) => createGlobMatcher(pattern));
    filtered = filtered.filter((file) =>
      !excludeMatchers.some((matches) => matches(file)),
    );
  }

  return filtered;
}

function createGlobMatcher(pattern: string): (file: string) => boolean {
  const normalizedPattern = normalizePath(pattern);
  const regex = globToRegex(normalizedPattern);
  const matchBasename = !normalizedPattern.includes("/");

  return (file: string) => {
    if (regex.test(file)) {
      return true;
    }

    if (!matchBasename) {
      return false;
    }

    return regex.test(file.split("/").at(-1) ?? file);
  };
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*\*/gu, "<<<GLOBSTAR>>>")
    .replace(/\*/gu, "<<<GLOB>>>")
    .replace(/\?/gu, "<<<QUESTION>>>");

  const withGlobstar = escaped
    .replace(/<<<GLOBSTAR>>>\//gu, "(?:.*/)?")
    .replace(/<<<GLOBSTAR>>>/gu, ".*")
    .replace(/<<<GLOB>>>/gu, "[^/]*")
    .replace(/<<<QUESTION>>>/gu, "[^/]");

  return new RegExp(`^${withGlobstar}$`, "u");
}
