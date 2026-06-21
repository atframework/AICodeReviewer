import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { normalizeChangedPath, normalizePath, type ReviewEvent } from "@aicr/core";

import {
  buildAttributionEntry,
  determineAttributionStatus,
  filterAttributionByLineRange,
} from "./attribution.js";
import type {
  AttributionEntry,
  AttributionRequest,
  AttributionResult,
  ChangeRange,
  ExtraContextRequest,
  ExtraContextResult,
  ScopedTree,
  VcsAdapter,
  WorkspaceRef,
} from "./contracts.js";
import { parseUnifiedDiff, type ParsedDiff } from "./diff.js";
import { filterFilesByPatterns, filterFilesByWatchPath } from "./path-filters.js";

export interface SvnCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type SvnCommandRunner = (args: readonly string[]) => Promise<SvnCommandResult>;

export interface SvnVcsAdapterOptions {
  readonly repositoryDir: string;
  readonly repositoryUrl?: string;
  readonly username?: string;
  readonly password?: string;
  readonly trustServerCert?: boolean;
  readonly nonInteractive?: boolean;
  readonly watchPath?: readonly string[];
  readonly includeCrFile?: readonly string[];
  readonly excludeCrFile?: readonly string[];
  readonly svn?: SvnCommandRunner;
}

const execFileAsync = promisify(execFile);

async function defaultSvnRunner(args: readonly string[]): Promise<SvnCommandResult> {
  const result = await execFileAsync("svn", [...args], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });

  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
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

function isUrlLike(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:", "svn:", "svn+ssh:", "file:"].includes(url.protocol);
  } catch {
    return false;
  }
}

const SVN_BLAME_LINE_RE = /^\s*(\d+)\s+(\S+)/u;

function isSvnBlameMissingError(error: unknown): boolean {
  const candidate = error as { readonly stdout?: unknown; readonly stderr?: unknown };
  const text = [
    error instanceof Error ? error.message : String(error),
    typeof candidate.stdout === "string" ? candidate.stdout : "",
    typeof candidate.stderr === "string" ? candidate.stderr : "",
  ].join("\n");

  return /(?:E160013|E200009|path not found|no such file|does not exist|not a working copy|is not under version control)/iu.test(
    text,
  );
}

export function parseSvnBlameForAttribution(stdout: string): AttributionEntry[] {
  const entries: AttributionEntry[] = [];
  let lineNumber = 0;

  for (const line of stdout.split(/\r?\n/u)) {
    const match = SVN_BLAME_LINE_RE.exec(line);
    if (!match) {
      continue;
    }

    lineNumber += 1;
    entries.push(
      buildAttributionEntry({
        line: lineNumber,
        revision: match[1],
        author: match[2],
      }),
    );
  }

  return entries;
}

function appendPathToRepositoryUrl(repositoryUrl: string, path: string): string {
  const base = repositoryUrl.replace(/\/+$/u, "");
  const suffix = normalizePath(path);
  return suffix ? `${base}/${suffix}` : base;
}

function stripRepositoryUrl(repositoryUrl: string | undefined, value: string): string | undefined {
  if (!repositoryUrl) {
    return undefined;
  }

  const base = repositoryUrl.replace(/\/+$/u, "");
  const candidate = value.replace(/\/+$/u, "");
  if (candidate === base) {
    return "";
  }

  if (candidate.startsWith(`${base}/`)) {
    return candidate.slice(base.length + 1);
  }

  return undefined;
}

function buildRevisionArgs(range: ChangeRange): string[] {
  if (range.baseRevision && range.headRevision) {
    return ["-r", `${range.baseRevision}:${range.headRevision}`];
  }

  if (range.headRevision) {
    return ["-c", range.headRevision];
  }

  throw new RangeError("SVN diff requires headRevision or a base/head revision pair.");
}

function redactSvnSecret(text: string, secret: string | undefined): string {
  return secret ? text.replaceAll(secret, "***") : text;
}

export class SvnVcsAdapter implements VcsAdapter {
  readonly kind = "svn" as const;

  private readonly repositoryDir: string;
  private readonly repositoryUrl: string | undefined;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly trustServerCert: boolean;
  private readonly nonInteractive: boolean;
  private readonly watchPath: readonly string[] | undefined;
  private readonly includeCrFile: readonly string[] | undefined;
  private readonly excludeCrFile: readonly string[] | undefined;
  private readonly svn: SvnCommandRunner;

  constructor(options: SvnVcsAdapterOptions) {
    this.repositoryDir = resolve(options.repositoryDir);
    this.repositoryUrl = options.repositoryUrl;
    this.username = options.username;
    this.password = options.password;
    this.trustServerCert = options.trustServerCert ?? false;
    this.nonInteractive = options.nonInteractive ?? true;
    this.watchPath = options.watchPath;
    this.includeCrFile = options.includeCrFile;
    this.excludeCrFile = options.excludeCrFile;
    this.svn = options.svn ?? defaultSvnRunner;
  }

  private buildBaseArgs(): string[] {
    const args: string[] = [];
    if (this.nonInteractive) {
      args.push("--non-interactive");
    }
    if (this.trustServerCert) {
      args.push("--trust-server-cert");
    }
    if (this.username) {
      args.push("--username", this.username);
    }
    if (this.password) {
      args.push("--password", this.password, "--no-auth-cache");
    }
    return args;
  }

  private async runSvn(args: readonly string[]): Promise<SvnCommandResult> {
    try {
      return await this.svn([...this.buildBaseArgs(), ...args]);
    } catch (error) {
      const source = error as { readonly stdout?: unknown; readonly stderr?: unknown };
      const sanitized = new Error(redactSvnSecret(error instanceof Error ? error.message : String(error), this.password));
      sanitized.name = error instanceof Error ? error.name : "Error";
      const target = sanitized as Error & Record<string, unknown>;
      if (typeof source.stdout === "string") {
        target.stdout = redactSvnSecret(source.stdout, this.password);
      }
      if (typeof source.stderr === "string") {
        target.stderr = redactSvnSecret(source.stderr, this.password);
      }
      throw sanitized;
    }
  }

  private targetForPath(path = ""): string {
    if (this.repositoryUrl) {
      return appendPathToRepositoryUrl(this.repositoryUrl, path);
    }

    return path ? join(this.repositoryDir, normalizePath(path)) : this.repositoryDir;
  }

  private toLocalPath(path: string): string {
    const trimmed = path.trim();
    const fromUrl = stripRepositoryUrl(this.repositoryUrl, trimmed);
    if (fromUrl !== undefined) {
      return normalizePath(fromUrl);
    }

    if (isUrlLike(trimmed)) {
      throw new RangeError("SVN path must stay within the configured repository_url.");
    }

    return normalizeChangedPath(this.repositoryDir, trimmed);
  }

  private parseSummarizeOutput(stdout: string): string[] {
    const files: string[] = [];
    for (const rawLine of stdout.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const match = /^[A-Z!~?\s]{1,8}\s+(.+)$/u.exec(line);
      const rawPath = match?.[1]?.trim();
      if (!rawPath) {
        continue;
      }

      files.push(this.toLocalPath(rawPath));
    }

    return files;
  }

  private applyFilters(files: readonly string[]): string[] {
    let result = filterFilesByWatchPath(files, this.watchPath);
    result = filterFilesByPatterns(result, this.includeCrFile, this.excludeCrFile);
    return Array.from(new Set(result));
  }

  async listChanges(ev: ReviewEvent): Promise<ChangeRange> {
    const eventFiles = ev.changedFiles ? this.applyFilters(ev.changedFiles.map((file) => this.toLocalPath(file))) : [];

    if (!ev.headSha) {
      if (eventFiles.length > 0) {
        return { files: eventFiles };
      }

      throw new RangeError("SVN listChanges requires headSha or ReviewEvent.changedFiles.");
    }

    try {
      const result = await this.runSvn([
        "diff",
        "--summarize",
        ...buildRevisionArgs({
          ...(ev.baseSha ? { baseRevision: ev.baseSha } : {}),
          headRevision: ev.headSha,
          files: [],
        }),
        this.targetForPath(),
      ]);
      const files = this.applyFilters(this.parseSummarizeOutput(result.stdout));
      return {
        ...(ev.baseSha ? { baseRevision: ev.baseSha } : {}),
        headRevision: ev.headSha,
        files: files.length > 0 ? files : eventFiles,
      };
    } catch (error) {
      if (eventFiles.length === 0) {
        throw error;
      }
      return {
        ...(ev.baseSha ? { baseRevision: ev.baseSha } : {}),
        headRevision: ev.headSha,
        files: eventFiles,
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

    for (const filePath of this.applyFilters(range.files.map((file) => this.toLocalPath(file)))) {
      const safeLocalPath = normalizeChangedPath(workspaceSourceDir, filePath);
      const destinationPath = join(workspaceSourceDir, safeLocalPath);

      try {
        await rm(destinationPath, { recursive: true, force: true });
        const result = await this.runSvn([
          "cat",
          "-r",
          revision,
          this.targetForPath(safeLocalPath),
        ]);
        await mkdir(dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, result.stdout, "utf8");
        fetchedFiles.push(safeLocalPath);
      } catch (error) {
        console.warn(JSON.stringify({
          level: "warn",
          msg: "svn cat failed",
          path: filePath,
          revision,
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        }));
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

      const result = await this.runSvn([
        "cat",
        "-r",
        req.revision,
        this.targetForPath(normalizedPath),
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

  async fetchAttribution(req: AttributionRequest, ws: WorkspaceRef): Promise<AttributionResult> {
    const workspaceSourceDir = resolve(ws.sourceDir);
    const requestedLocalPath = this.toLocalPath(req.path);
    const normalizedPath = normalizeChangedPath(workspaceSourceDir, requestedLocalPath);

    const blameArgs = [
      ...(req.revision ? ["-r", req.revision] : []),
      this.targetForPath(normalizedPath),
    ];

    let stdout: string;
    try {
      const result = await this.runSvn(["blame", ...blameArgs]);
      stdout = result.stdout;
    } catch (error) {
      if (isSvnBlameMissingError(error)) {
        return { path: normalizedPath, status: "not_found", entries: [] };
      }
      throw error;
    }

    const parsed = parseSvnBlameForAttribution(stdout);
    if (parsed.length === 0) {
      return { path: normalizedPath, status: "not_found", entries: [] };
    }

    const filtered = filterAttributionByLineRange(parsed, req.startLine, req.endLine);
    if (filtered.length === 0) {
      return { path: normalizedPath, status: "not_found", entries: [] };
    }

    return {
      path: normalizedPath,
      status: determineAttributionStatus(filtered),
      entries: filtered,
    };
  }

  async diff(range: ChangeRange): Promise<ParsedDiff> {
    const revisionArgs = buildRevisionArgs(range);
    const files = this.applyFilters(range.files.map((file) => this.toLocalPath(file)));
    const targets = files.length > 0 ? files.map((file) => this.targetForPath(file)) : [this.targetForPath()];
    const result = await this.runSvn([
      "diff",
      "--git",
      ...revisionArgs,
      ...targets,
    ]);

    return parseUnifiedDiff(result.stdout);
  }
}

export function createSvnVcsAdapter(options: SvnVcsAdapterOptions): SvnVcsAdapter {
  return new SvnVcsAdapter(options);
}
