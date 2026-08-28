import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  normalizePath,
  scrubText,
  withTransientIoRetry,
  type ContextRepositoryConfig,
} from "@aicr/core";

import { redactGitSecrets } from "./git.js";
import {
  isP4AuthenticationError,
  isP4DeleteAction,
  isP4FingerprintChangedError,
  isP4TrustError,
} from "./p4.js";

export interface ContextRepoCommandResult {
  readonly stdout: string | Buffer;
  readonly stderr: string;
}

export type ContextRepoCommandRunner = (
  command: string,
  args: readonly string[],
  options?: {
    readonly env?: Readonly<Record<string, string>>;
    readonly stdin?: string;
    readonly stdout?: "text" | "buffer";
  },
) => Promise<ContextRepoCommandResult>;

export interface ContextRepoMaterialization {
  readonly alias: string;
  readonly kind: ContextRepositoryConfig["kind"];
  readonly hostDir: string;
  readonly status: "ok" | "failed";
  readonly resolvedRevision?: string;
  readonly fileCount?: number;
  readonly totalBytes?: number;
  readonly error?: string;
}

export interface MaterializeContextReposOptions {
  readonly contextReposRoot: string;
  readonly repos: readonly ContextRepositoryConfig[];
  readonly run?: ContextRepoCommandRunner;
  readonly resolveEnv?: (name: string) => string | undefined;
  readonly warn?: (entry: Readonly<Record<string, unknown>>) => void;
}

const DEFAULT_MAX_MB = 512;
const MAX_P4_FILES = 5000;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const REPO_CONCURRENCY = 3;
const P4_PRINT_CONCURRENCY = 4;

async function defaultRunner(
  command: string,
  args: readonly string[],
  options?: {
    readonly env?: Readonly<Record<string, string>>;
    readonly stdin?: string;
    readonly stdout?: "text" | "buffer";
  },
): Promise<ContextRepoCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      command,
      [...args],
      {
        encoding: options?.stdout === "buffer" ? "buffer" : "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 50 * 1024 * 1024,
        ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise({ stdout, stderr: String(stderr) });
      },
    );

    if (options?.stdin !== undefined && child.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

function defaultWarn(entry: Readonly<Record<string, unknown>>): void {
  console.warn(JSON.stringify({ level: "warn", ...entry }));
}

function getCommandErrorText(error: unknown): string {
  const maybeCommandError = error as {
    readonly stdout?: unknown;
    readonly stderr?: unknown;
  };
  return [
    error instanceof Error ? error.message : String(error),
    typeof maybeCommandError.stdout === "string" || Buffer.isBuffer(maybeCommandError.stdout)
      ? String(maybeCommandError.stdout)
      : "",
    typeof maybeCommandError.stderr === "string" || Buffer.isBuffer(maybeCommandError.stderr)
      ? String(maybeCommandError.stderr)
      : "",
  ].join("\n");
}

function scrubError(error: unknown): Error {
  return new Error(redactGitSecrets(scrubText(getCommandErrorText(error)).text));
}

interface MaterializeDeps {
  readonly run: ContextRepoCommandRunner;
  readonly resolveEnv: (name: string) => string | undefined;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const current = cursor;
      cursor += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await fn(items[current]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runGit(
  deps: MaterializeDeps,
  repo: ContextRepositoryConfig,
  args: readonly string[],
  options?: { readonly beforeAttempt?: () => Promise<void> },
): Promise<ContextRepoCommandResult> {
  const token = repo.token_env ? deps.resolveEnv(repo.token_env) : undefined;
  const useHeader = token !== undefined && token !== "" && /^https?:\/\//iu.test(repo.url ?? "");
  // The token travels via GIT_CONFIG_* env instead of `-c http.extraHeader`
  // argv so it never appears in the process table; the transient env config
  // is also never written into the cloned .git/config.
  const env = useHeader
    ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: token ${token}`,
      }
    : undefined;

  return withTransientIoRetry(async () => {
    await options?.beforeAttempt?.();
    try {
      return await deps.run("git", [...args], env ? { env } : {});
    } catch (error) {
      throw scrubError(error);
    }
  });
}

async function materializeGitRepo(
  deps: MaterializeDeps,
  repo: ContextRepositoryConfig,
  targetDir: string,
): Promise<string | undefined> {
  const cloneArgs = ["clone", "--depth", "1"];
  if (repo.ref) {
    cloneArgs.push("--branch", repo.ref);
  }
  cloneArgs.push(repo.url as string, targetDir);
  await runGit(deps, repo, cloneArgs, {
    // git clone accepts an existing empty directory; recreate it so each
    // retry attempt starts from a clean slate after a partial clone.
    beforeAttempt: async () => {
      await rm(targetDir, { recursive: true, force: true });
      await mkdir(targetDir, { recursive: true });
    },
  });

  const head = await runGit(deps, repo, ["-C", targetDir, "rev-parse", "HEAD"]);
  return String(head.stdout).trim() || undefined;
}

async function materializeSvnRepo(
  deps: MaterializeDeps,
  repo: ContextRepositoryConfig,
  targetDir: string,
): Promise<string | undefined> {
  const runSvn = (args: readonly string[]) =>
    withTransientIoRetry(async () => {
      try {
        return await deps.run("svn", args);
      } catch (error) {
        throw scrubError(error);
      }
    });

  const exportArgs = ["export", "--quiet", "--non-interactive", "--no-auth-cache"];
  if (repo.revision !== undefined) {
    exportArgs.push("--revision", String(repo.revision));
  }
  exportArgs.push(repo.repository_url as string, targetDir);
  await runSvn(exportArgs);

  if (repo.revision !== undefined) {
    return String(repo.revision);
  }

  try {
    const info = await runSvn(["info", "--show-item", "revision", repo.repository_url as string]);
    return String(info.stdout).trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseP4FilesList(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^(\S+)#\d+\s+-\s+(\S+)\s/u.exec(line.trim());
    if (!match) {
      continue;
    }
    if (isP4DeleteAction(match[2])) {
      continue;
    }
    paths.push(match[1]!);
  }
  return paths;
}

function toP4RelativePath(depotRoot: string, depotPath: string): string | undefined {
  const prefix = `${depotRoot}/`;
  if (!depotPath.startsWith(prefix)) {
    return undefined;
  }
  const relative = normalizePath(depotPath.slice(prefix.length));
  if (!relative || relative.startsWith("../") || relative.includes("/../")) {
    return undefined;
  }
  return relative;
}

async function materializeP4Repo(
  deps: MaterializeDeps,
  repo: ContextRepositoryConfig,
  targetDir: string,
  maxBytes: number,
): Promise<string | undefined> {
  const password = repo.password_env
    ? deps.resolveEnv(repo.password_env)
    : repo.ticket_env
      ? deps.resolveEnv(repo.ticket_env)
      : undefined;
  const env = password ? { P4PASSWD: password } : undefined;

  const baseArgs: string[] = [];
  if (repo.port) {
    baseArgs.push("-p", repo.port);
  }
  if (repo.user_env) {
    const user = deps.resolveEnv(repo.user_env);
    if (user) {
      baseArgs.push("-u", user);
    }
  }

  const runP4Once = (args: readonly string[], stdin?: string, bufferStdout = false) =>
    deps.run("p4", [...baseArgs, ...args], {
      ...(env ? { env } : {}),
      ...(stdin !== undefined ? { stdin } : {}),
      ...(bufferStdout ? { stdout: "buffer" as const } : {}),
    });

  const trust = async () => {
    try {
      await runP4Once(["trust", "-y"]);
    } catch (error) {
      if (isP4FingerprintChangedError(error)) {
        await runP4Once(["trust", "-y", "-f"]);
        return;
      }
      throw error;
    }
  };

  let loginAttempted = false;
  const runP4 = (
    args: readonly string[],
    options?: { readonly stdin?: string; readonly bufferStdout?: boolean },
  ): Promise<ContextRepoCommandResult> =>
    withTransientIoRetry(async () => {
      let trustRetried = false;
      for (;;) {
        try {
          return await runP4Once(args, options?.stdin, options?.bufferStdout ?? false);
        } catch (error) {
          if (isP4TrustError(error) && !trustRetried) {
            trustRetried = true;
            await trust();
            continue;
          }
          if (!password || loginAttempted || !isP4AuthenticationError(error)) {
            throw scrubError(error);
          }
          loginAttempted = true;
          try {
            await runP4Once(["login"], `${password}\n`);
          } catch (loginError) {
            throw scrubError(loginError);
          }
        }
      }
    });

  const depot = (repo.depot_path as string).replace(/\/+$/u, "");
  const revisionSuffix = repo.revision !== undefined ? `@${repo.revision}` : "";
  const filesList = await runP4(["files", "-e", `${depot}${revisionSuffix}`]);
  const depotPaths = parseP4FilesList(String(filesList.stdout));
  if (depotPaths.length > MAX_P4_FILES) {
    throw new RangeError(
      `context repository '${repo.alias}' lists ${depotPaths.length} files, exceeding the ${MAX_P4_FILES} file cap; ` +
        "narrow the depot_path or split it into multiple aliases.",
    );
  }
  const depotRoot = depot.endsWith("/...") ? depot.slice(0, -"/...".length) : depot;

  let cumulativeBytes = 0;
  await mapWithConcurrency(depotPaths, P4_PRINT_CONCURRENCY, async (depotPath) => {
    const relative = toP4RelativePath(depotRoot, depotPath);
    if (!relative) {
      return;
    }
    const printed = await runP4(["print", "-q", `${depotPath}${revisionSuffix}`], {
      bufferStdout: true,
    });
    cumulativeBytes += printed.stdout.length;
    if (cumulativeBytes > maxBytes) {
      throw new RangeError(
        `context repository '${repo.alias}' exceeded the size cap during p4 export; ` +
          "narrow the depot_path or raise max_mb.",
      );
    }
    const destination = join(targetDir, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, printed.stdout);
  });

  if (repo.revision !== undefined) {
    return String(repo.revision);
  }

  try {
    const changes = await runP4(["changes", "-m", "1", depot]);
    const match = /Change\s+(\d+)/iu.exec(String(changes.stdout));
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function measureDirectory(rootDir: string): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        fileCount += 1;
        totalBytes += (await stat(fullPath)).size;
      }
    }));
  };

  await walk(rootDir);
  return { fileCount, totalBytes };
}

async function sweepStaleAliases(
  contextReposRoot: string,
  aliases: ReadonlySet<string>,
  warn: (entry: Readonly<Record<string, unknown>>) => void,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(contextReposRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || aliases.has(entry.name)) {
      continue;
    }
    const staleDir = join(contextReposRoot, entry.name);
    warn({ msg: "removing stale context repository directory", alias: entry.name });
    await rm(staleDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function materializeContextRepositories(
  options: MaterializeContextReposOptions,
): Promise<readonly ContextRepoMaterialization[]> {
  const deps: MaterializeDeps = {
    run: options.run ?? defaultRunner,
    resolveEnv: options.resolveEnv ?? ((name) => process.env[name]),
  };
  const warn = options.warn ?? defaultWarn;

  await mkdir(options.contextReposRoot, { recursive: true });
  await sweepStaleAliases(
    options.contextReposRoot,
    new Set(options.repos.map((repo) => repo.alias)),
    warn,
  );

  return mapWithConcurrency(options.repos, REPO_CONCURRENCY, async (repo) => {
    const targetDir = join(options.contextReposRoot, repo.alias);
    const maxMb = repo.max_mb ?? DEFAULT_MAX_MB;

    try {
      await rm(targetDir, { recursive: true, force: true });
      await mkdir(targetDir, { recursive: true });

      let resolvedRevision: string | undefined;
      if (repo.kind === "git") {
        resolvedRevision = await materializeGitRepo(deps, repo, targetDir);
      } else if (repo.kind === "svn") {
        resolvedRevision = await materializeSvnRepo(deps, repo, targetDir);
      } else {
        resolvedRevision = await materializeP4Repo(deps, repo, targetDir, maxMb * 1024 * 1024);
      }

      const { fileCount, totalBytes } = await measureDirectory(targetDir);
      if (totalBytes > maxMb * 1024 * 1024) {
        throw new RangeError(
          `context repository '${repo.alias}' materialized ${Math.ceil(totalBytes / 1024 / 1024)}MB, exceeding the ${maxMb}MB cap; ` +
            "narrow the depot_path/repository_url/ref or raise max_mb.",
        );
      }

      return {
        alias: repo.alias,
        kind: repo.kind,
        hostDir: targetDir,
        status: "ok" as const,
        ...(resolvedRevision ? { resolvedRevision } : {}),
        fileCount,
        totalBytes,
      };
    } catch (error) {
      const scrubbed = scrubError(error);
      await rm(targetDir, { recursive: true, force: true }).catch(() => {});
      warn({
        msg: "context repository materialization failed",
        alias: repo.alias,
        kind: repo.kind,
        error: scrubbed.message.slice(0, 500),
      });
      return {
        alias: repo.alias,
        kind: repo.kind,
        hostDir: targetDir,
        status: "failed" as const,
        error: scrubbed.message.slice(0, 500),
      };
    }
  });
}
