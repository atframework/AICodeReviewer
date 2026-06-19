import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { normalizeChangedPath, normalizePath, type ReviewEvent } from "@aicr/core";

import type { ChangeRange, ExtraContextRequest, ExtraContextResult, ScopedTree, VcsAdapter, WorkspaceRef } from "./contracts.js";
import { parseUnifiedDiff, type ParsedDiff } from "./diff.js";
import { filterFilesByPatterns, filterFilesByWatchPath } from "./path-filters.js";

const execFileAsync = promisify(execFile);

export interface P4CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type P4CommandRunner = (
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => Promise<P4CommandResult>;

export type P4LoginRunner = (
  args: readonly string[],
  password: string,
  env?: Readonly<Record<string, string>>,
) => Promise<P4CommandResult>;

export interface P4VcsAdapterOptions {
  readonly repositoryDir: string;
  readonly port?: string;
  readonly user?: string;
  readonly password?: string;
  readonly workspace?: string;
  readonly depot?: string;
  readonly watchPath?: readonly string[];
  readonly includeCrFile?: readonly string[];
  readonly excludeCrFile?: readonly string[];
  readonly p4?: P4CommandRunner;
  readonly p4Login?: P4LoginRunner;
}

async function defaultP4Runner(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<P4CommandResult> {
  const result = await execFileAsync("p4", [...args], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, ...env },
  });

  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

async function defaultP4LoginRunner(
  args: readonly string[],
  password: string,
  env: Readonly<Record<string, string>> = {},
): Promise<P4CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("p4", [...args, "login"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { stdout, stderr };
      if (code === 0) {
        resolvePromise(result);
        return;
      }

      const error = new Error(`p4 login failed with exit code ${code ?? "unknown"}. ${stderr || stdout}`);
      Object.assign(error, result, { code });
      reject(error);
    });
    child.stdin.end(`${password}\n`);
  });
}

function getErrorText(error: unknown): string {
  const candidate = error as { readonly stdout?: unknown; readonly stderr?: unknown };
  return [
    error instanceof Error ? error.message : String(error),
    typeof candidate.stdout === "string" ? candidate.stdout : "",
    typeof candidate.stderr === "string" ? candidate.stderr : "",
  ].join("\n");
}

function isP4AuthenticationError(error: unknown): boolean {
  return /P4PASSWD|Perforce password|not logged in|login required|session has expired|ticket.*expired/iu.test(getErrorText(error));
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function selectLineRange(content: string, startLine: number | undefined, endLine: number | undefined): string {
  if (startLine === undefined && endLine === undefined) {
    return content;
  }

  const lines = content.split(/\r?\n/u);
  const start = startLine ?? 1;
  const end = endLine ?? lines.length;

  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < 1) {
    throw new RangeError("startLine and endLine must be positive integers.");
  }

  if (start > end) {
    throw new RangeError("startLine must be less than or equal to endLine.");
  }

  return lines.slice(start - 1, end).join("\n");
}

function isP4AddAction(action: string | undefined): boolean {
  return action === "add" || action === "branch" || action === "move/add";
}

function isP4DeleteAction(action: string | undefined): boolean {
  return action === "delete" || action === "move/delete";
}

function isDevNullPath(path: string): boolean {
  return path === "/dev/null" || path === "//dev/null";
}

function appendSyntheticUnifiedHeaders(
  target: string[],
  localPath: string,
  action: string | undefined,
): void {
  target.push(`diff --git a/${localPath} b/${localPath}`);

  if (isP4AddAction(action)) {
    target.push("new file mode 100644");
    target.push("--- /dev/null");
    target.push(`+++ b/${localPath}`);
    return;
  }

  if (isP4DeleteAction(action)) {
    target.push("deleted file mode 100644");
    target.push(`--- a/${localPath}`);
    target.push("+++ /dev/null");
    return;
  }

  target.push(`--- a/${localPath}`);
  target.push(`+++ b/${localPath}`);
}

export class P4VcsAdapter implements VcsAdapter {
  readonly kind = "p4" as const;

  private readonly repositoryDir: string;
  private readonly port: string | undefined;
  private readonly user: string | undefined;
  private readonly password: string | undefined;
  private readonly clientWorkspace: string | undefined;
  private readonly depot: string | undefined;
  private readonly watchPath: readonly string[] | undefined;
  private readonly includeCrFile: readonly string[] | undefined;
  private readonly excludeCrFile: readonly string[] | undefined;
  private readonly p4: P4CommandRunner;
  private readonly p4Login: P4LoginRunner;
  private loginAttempted = false;

  constructor(options: P4VcsAdapterOptions) {
    this.repositoryDir = resolve(options.repositoryDir);
    this.port = options.port;
    this.user = options.user;
    this.password = options.password;
    this.clientWorkspace = options.workspace;
    this.depot = options.depot;
    this.watchPath = options.watchPath;
    this.includeCrFile = options.includeCrFile;
    this.excludeCrFile = options.excludeCrFile;
    this.p4 = options.p4 ?? defaultP4Runner;
    this.p4Login = options.p4Login ?? defaultP4LoginRunner;
  }

  private buildBaseArgs(): string[] {
    const args: string[] = [];
    if (this.port) args.push("-p", this.port);
    if (this.user) args.push("-u", this.user);
    if (this.clientWorkspace) args.push("-c", this.clientWorkspace);
    return args;
  }

  private buildEnv(): Readonly<Record<string, string>> | undefined {
    return this.password ? { P4PASSWD: this.password } : undefined;
  }

  private async runP4Once(args: readonly string[]): Promise<P4CommandResult> {
    const baseArgs = this.buildBaseArgs();
    return this.p4([...baseArgs, ...args], this.buildEnv());
  }

  private async runP4(args: readonly string[]): Promise<P4CommandResult> {
    try {
      return await this.runP4Once(args);
    } catch (error) {
      if (!this.password || this.loginAttempted || !isP4AuthenticationError(error)) {
        throw error;
      }

      await this.login();
      return this.runP4Once(args);
    }
  }

  async login(): Promise<void> {
    if (!this.password) return;
    this.loginAttempted = true;
    await this.p4Login(this.buildBaseArgs(), this.password, this.buildEnv());
  }

  async listChanges(ev: ReviewEvent): Promise<ChangeRange> {
    const changeNumber = ev.headSha;
    if (!changeNumber) {
      throw new RangeError("P4 listChanges requires headSha (changelist number).");
    }

    const eventFiles = ev.changedFiles
      ? ev.changedFiles.map((f) => this.toLocalPath(f))
      : undefined;

    if (eventFiles && eventFiles.length > 0) {
      const filtered = this.applyFilters(eventFiles);
      return {
        headRevision: changeNumber,
        ...(ev.baseSha ? { baseRevision: ev.baseSha } : {}),
        files: filtered,
      };
    }

    try {
      const result = await this.runP4([
        "describe",
        "-s",
        changeNumber,
      ]);
      const files = this.parseDescribeOutput(result.stdout);
      const filtered = this.applyFilters(files);

      return {
        headRevision: changeNumber,
        ...(ev.baseSha ? { baseRevision: ev.baseSha } : {}),
        files: filtered,
      };
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn",
        msg: "p4 describe -s failed in listChanges",
        changeNumber,
        error: error instanceof Error ? error.message : String(error),
      }));
      return {
        headRevision: changeNumber,
        ...(ev.baseSha ? { baseRevision: ev.baseSha } : {}),
        files: eventFiles ?? [],
      };
    }
  }

  async fetchScoped(range: ChangeRange, ws: WorkspaceRef): Promise<ScopedTree> {
    const workspaceSourceDir = resolve(ws.sourceDir);
    const fetchedFiles: string[] = [];
    const revision = range.headRevision;

    if (!revision) {
      return {
        workspaceId: ws.id,
        rootDir: workspaceSourceDir,
        fetchedFiles,
      };
    }

    for (const filePath of range.files) {
      const normalizedPath = this.toLocalPath(filePath);
      const safeLocalPath = normalizeChangedPath(workspaceSourceDir, normalizedPath);
      const destinationPath = join(workspaceSourceDir, safeLocalPath);
      let depotPath = filePath.startsWith("//") ? filePath : normalizedPath;
      if (this.depot && !depotPath.startsWith("//")) {
        const depotBase = this.depot.replace(/\/+$/u, "");
        depotPath = `${depotBase}/${normalizedPath.replace(/^\/+/u, "")}`;
      }

      try {
        await rm(destinationPath, { recursive: true, force: true });
        const result = await this.runP4([
          "print",
          "-q",
          `${depotPath}@${revision}`,
        ]);

        await mkdir(dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, result.stdout, "utf8");
        fetchedFiles.push(safeLocalPath);
      } catch (error) {
        const errorText = getErrorText(error);
        if (/no such file\(s\)/iu.test(errorText)) {
          console.warn(JSON.stringify({
            level: "warn",
            msg: "p4 print failed: file not found at revision",
            depotPath: `${depotPath}@${revision}`,
            localPath: normalizedPath,
            error: errorText.slice(0, 500),
          }));
        } else {
          console.warn(JSON.stringify({
            level: "warn",
            msg: "p4 print failed",
            depotPath: `${depotPath}@${revision}`,
            localPath: normalizedPath,
            error: errorText.slice(0, 500),
          }));
        }
      }
    }

    return {
      workspaceId: ws.id,
      rootDir: workspaceSourceDir,
      fetchedFiles,
    };
  }

  async fetchExtraContext(req: ExtraContextRequest, ws: WorkspaceRef): Promise<ExtraContextResult> {
    const workspaceSourceDir = resolve(ws.sourceDir);
    const requestedLocalPath = this.toLocalPath(req.path);
    const normalizedPath = normalizeChangedPath(workspaceSourceDir, requestedLocalPath);
    const destinationPath = join(workspaceSourceDir, normalizedPath);
    let content: string;

    try {
      content = await readFile(destinationPath, "utf8");
    } catch (error) {
      if (!isFileNotFoundError(error) || !req.revision) {
        throw error;
      }

      const depotPath = this.toDepotPrintPath(req.path, normalizedPath);
      const result = await this.runP4([
        "print",
        "-q",
        `${depotPath}@${req.revision}`,
      ]);
      content = result.stdout;

      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, content, "utf8");
    }

    return {
      path: normalizedPath,
      content: selectLineRange(content, req.startLine, req.endLine),
    };
  }

  async diff(range: ChangeRange): Promise<ParsedDiff> {
    const revision = range.headRevision;
    if (!revision) {
      return { files: [] };
    }

    try {
      const result = await this.runP4([
        "describe",
        "-du",
        revision,
      ]);
      const parsed = this.parseP4DiffOutput(result.stdout);
      const filtered = this.filterDiffToRange(parsed, range.files);
      if (filtered.files.length === 0 && result.stdout.length > 0) {
        console.warn(JSON.stringify({
          level: "warn",
          msg: "p4 diff parsed empty but stdout was non-empty",
          revision,
          stdoutPreview: result.stdout.slice(0, 800).replaceAll("\n", " "),
          parsedFileCount: parsed.files.length,
          filterInputFiles: range.files,
          depot: this.depot,
        }));
      }
      return filtered;
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn",
        msg: "p4 describe -du failed",
        revision,
        error: getErrorText(error).slice(0, 500),
      }));
      return { files: [] };
    }
  }

  private parseDescribeOutput(stdout: string): string[] {
    const files: string[] = [];
    const lines = stdout.split(/\r?\n/u);
    const filePattern = /^\.{3}\s+(\/\/[^#]+)#\d+\s+(add|edit|delete|integrate|branch|move\/add|move\/delete)/u;

    for (const line of lines) {
      const match = filePattern.exec(line.trim());
      if (match) {
        const depotFile = match[1];
        if (depotFile) {
          const localPath = this.depotToLocalPath(depotFile);
          if (localPath) {
            files.push(localPath);
          }
        }
      }
    }

    return files;
  }

  private depotToLocalPath(depotPath: string): string | undefined {
    const depotBase = this.depot?.replace(/\/+$/u, "") ?? "";
    if (depotBase && depotPath.startsWith(`${depotBase}/`)) {
      return normalizePath(depotPath.slice(depotBase.length + 1));
    }

    const match = /\/\/([^/]+)\/(.+)/u.exec(depotPath);
    if (match?.[2]) {
      return normalizePath(match[2]);
    }

    return normalizePath(depotPath);
  }

  private toLocalPath(path: string): string {
    if (path.startsWith("//")) {
      return this.depotToLocalPath(path) ?? normalizePath(path);
    }

    return normalizePath(path);
  }

  private toDepotPrintPath(requestPath: string, localPath: string): string {
    if (requestPath.startsWith("//")) {
      const depotBase = this.depot?.replace(/\/+$/u, "");
      if (depotBase && requestPath !== depotBase && !requestPath.startsWith(`${depotBase}/`)) {
        throw new RangeError("fetchExtraContext path must stay within the configured P4 depot path.");
      }

      return requestPath;
    }

    if (!this.depot) {
      return localPath;
    }

    const depotBase = this.depot.replace(/\/+$/u, "");
    return `${depotBase}/${localPath.replace(/^\/+/u, "")}`;
  }

  private collectDescribeActions(lines: readonly string[]): ReadonlyMap<string, string> {
    const actions = new Map<string, string>();
    const filePattern = /^\.{3}\s+(\/\/[^#]+)#\d+\s+(\S+)/u;

    for (const line of lines) {
      const match = filePattern.exec(line.trim());
      if (!match) {
        continue;
      }

      const depotFile = match[1];
      const action = match[2];
      if (!depotFile || !action) {
        continue;
      }

      const localPath = this.depotToLocalPath(depotFile);
      if (localPath) {
        actions.set(localPath, action);
      }
    }

    return actions;
  }

  private filterDiffToRange(diff: ParsedDiff, files: readonly string[]): ParsedDiff {
    if (files.length === 0) {
      return diff;
    }

    const allowed = new Set(files.map((file) => this.toLocalPath(file)));
    return {
      files: diff.files.filter((file) =>
        [file.newPath, file.oldPath]
          .filter((path): path is string => Boolean(path))
          .some((path) => allowed.has(normalizePath(path))),
      ),
    };
  }

  private parseP4DiffOutput(stdout: string): ParsedDiff {
    const unifiedLines: string[] = [];
    const lines = stdout.split(/\r?\n/u);
    const describeActions = this.collectDescribeActions(lines);
    let inDiff = false;
    let oldIsDevNull = false;
    let pendingLocalPath: string | undefined;
    let pendingAction: string | undefined;

    for (const line of lines) {
      const separatorMatch = /^==== (\/\/[^#\s]+)(?:#\d+)?\s+.*====$/u.exec(line);
      if (separatorMatch?.[1]) {
        inDiff = false;
        oldIsDevNull = false;
        pendingLocalPath = this.depotToLocalPath(separatorMatch[1]) ?? normalizePath(separatorMatch[1]);
        pendingAction = describeActions.get(pendingLocalPath);
        continue;
      }

      const headerMatch = /^--- ((?:\/\/|\/)[^#\s]+)(?:#\d+)?(?:\s|####|$)/u.exec(line);
      if (headerMatch && !inDiff) {
        inDiff = true;
        oldIsDevNull = isDevNullPath(headerMatch[1]!);
        if (!oldIsDevNull) {
          const localPath = this.depotToLocalPath(headerMatch[1]!) ?? normalizePath(headerMatch[1]!);
          unifiedLines.push(`diff --git a/${localPath} b/${localPath}`);
          unifiedLines.push(`--- a/${localPath}`);
        }
        continue;
      }

      if (inDiff && /^\+\+\+ /u.test(line)) {
        if (/^\+\+\+ \/dev\/null/u.test(line) || /^\+\+\+ \/\/dev\/null\b/u.test(line)) {
          unifiedLines.push("+++ /dev/null");
        } else {
          const plusMatch = /^\+\+\+ ((?:\/\/|\/)[^#\s]+)(?:#\d+)?(?:\s|####|$)/u.exec(line);
          if (plusMatch?.[1]) {
            const localPath = this.depotToLocalPath(plusMatch[1]) ?? normalizePath(plusMatch[1]);
            if (oldIsDevNull) {
              unifiedLines.push(`diff --git a/${localPath} b/${localPath}`);
              unifiedLines.push("--- /dev/null");
              unifiedLines.push(`+++ b/${localPath}`);
            } else {
              unifiedLines.push(`+++ b/${localPath}`);
            }
          }
        }
        continue;
      }

      if (!inDiff && pendingLocalPath && /^@@ /u.test(line)) {
        appendSyntheticUnifiedHeaders(unifiedLines, pendingLocalPath, pendingAction);
        inDiff = true;
      }

      if (inDiff) {
        if (/^\d+[,\d]*[acd][,\d]*\d+$/u.test(line)) {
          continue;
        }
        if (line === "") {
          continue;
        }
        unifiedLines.push(line);
      }
    }

    return parseUnifiedDiff(unifiedLines.join("\n"));
  }

  private applyFilters(files: string[]): string[] {
    let result = filterFilesByWatchPath(files, this.watchPath);
    result = filterFilesByPatterns(result, this.includeCrFile, this.excludeCrFile);
    return result;
  }
}

export function createP4VcsAdapter(options: P4VcsAdapterOptions): P4VcsAdapter {
  return new P4VcsAdapter(options);
}
