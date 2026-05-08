import { execFile } from "node:child_process";
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

function filterFilesByPatterns(
  files: readonly string[],
  includePatterns: readonly string[] | undefined,
  excludePatterns: readonly string[] | undefined,
): string[] {
  let filtered = [...files];

  if (includePatterns && includePatterns.length > 0) {
    const includeRegexes = includePatterns.map((pattern) => globToRegex(pattern));
    filtered = filtered.filter((file) =>
      includeRegexes.some((regex) => regex.test(file)),
    );
  }

  if (excludePatterns && excludePatterns.length > 0) {
    const excludeRegexes = excludePatterns.map((pattern) => globToRegex(pattern));
    filtered = filtered.filter((file) =>
      !excludeRegexes.some((regex) => regex.test(file)),
    );
  }

  return filtered;
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

  private async runP4(args: readonly string[]): Promise<P4CommandResult> {
    const baseArgs = this.buildBaseArgs();
    return this.p4([...baseArgs, ...args], this.buildEnv());
  }

  async login(): Promise<void> {
    if (!this.password) return;
    await this.runP4(["login"]);
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
