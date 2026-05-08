import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { normalizeChangedPath, normalizePath, type ReviewEvent } from "@aicr/core";

import type { ChangeRange, ExtraContextRequest, ExtraContextResult, ScopedTree, VcsAdapter, WorkspaceRef } from "./contracts.js";
import { parseUnifiedDiff, type ParsedDiff } from "./diff.js";

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

function filterFilesByPatterns(
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

function filterFilesByWatchPath(files: readonly string[], watchPath: readonly string[] | undefined): string[] {
  if (!watchPath || watchPath.length === 0) {
    return [...files];
  }

  const normalizedWatchPath = watchPath.map((wp) => normalizePath(wp));
  return files.filter((file) =>
    normalizedWatchPath.some((wp) => file === wp || file.startsWith(`${wp}/`)),
  );
}

export class P4VcsAdapter implements VcsAdapter {
  readonly kind = "p4" as const;

  private readonly repositoryDir: string;
  private readonly port: string | undefined;
  private readonly user: string | undefined;
  private readonly password: string | undefined;
  private readonly p4workspace: string | undefined;
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
    this.p4workspace = options.workspace;
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
    if (this.p4workspace) args.push("-c", this.p4workspace);
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
    } catch {
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
      try {
        let depotPath = filePath.startsWith("//") ? filePath : normalizedPath;
        if (this.depot && !depotPath.startsWith("//")) {
          const depotBase = this.depot.replace(/\/+$/u, "");
          depotPath = `${depotBase}/${normalizedPath.replace(/^\/+/u, "")}`;
        }

        const result = await this.runP4([
          "print",
          "-q",
          `${depotPath}@${revision}`,
        ]);

        const safeLocalPath = normalizeChangedPath(workspaceSourceDir, normalizedPath);
        const destinationPath = join(workspaceSourceDir, safeLocalPath);
        await mkdir(dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, result.stdout, "utf8");
        fetchedFiles.push(safeLocalPath);
      } catch {
        // Binary or deleted files may not be printable
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
    const normalizedPath = normalizeChangedPath(workspaceSourceDir, req.path);
    const content = await readFile(join(workspaceSourceDir, normalizedPath), "utf8");

    if (req.startLine === undefined && req.endLine === undefined) {
      return { path: normalizedPath, content };
    }

    const startLine = req.startLine ?? 1;
    const endLine = req.endLine ?? content.split(/\r?\n/u).length;
    const selectedLines = content.split(/\r?\n/u).slice(startLine - 1, endLine);
    return {
      path: normalizedPath,
      content: selectedLines.join("\n"),
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
      return this.parseP4DiffOutput(result.stdout);
    } catch {
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

  private parseP4DiffOutput(stdout: string): ParsedDiff {
    const unifiedLines: string[] = [];
    const lines = stdout.split(/\r?\n/u);
    let inDiff = false;
    let currentFile = "";

    for (const line of lines) {
      if (/^==== \/\/.*====/u.test(line)) {
        inDiff = false;
        continue;
      }

      const fileHeader = /^--- .*####.*####/u.test(line);
      if (fileHeader) {
        inDiff = true;
        const parts = line.split(/\s+/u);
        if (parts.length >= 4) {
          currentFile = this.depotToLocalPath(parts[1]!) ?? parts[1]!;
          unifiedLines.push(`diff --git a/${currentFile} b/${currentFile}`);
        }
        continue;
      }

      if (inDiff) {
        if (/^\d+[,\d]*[acd][,\d]*\d+$/u.test(line)) {
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
