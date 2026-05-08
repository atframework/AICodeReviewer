import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { normalizeChangedPath, normalizePath, type ReviewEvent } from "@aicr/core";

import type { ChangeRange, ExtraContextRequest, ExtraContextResult, ScopedTree, VcsAdapter, WorkspaceRef } from "./contracts.js";
import { parseUnifiedDiff, type ParsedDiff } from "./diff.js";

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type GitCommandRunner = (args: readonly string[]) => Promise<GitCommandResult>;

export interface GitVcsAdapterOptions {
  readonly repositoryDir: string;
  readonly git?: GitCommandRunner;
  readonly diffFilter?: string;
  readonly allowDeepen?: boolean;
  readonly deepenBy?: number;
  readonly remote?: string;
  readonly remoteUrl?: string;
  readonly token?: string;
}

export interface GitDiffOptions {
  readonly contextLines?: number;
}

const execFileAsync = promisify(execFile);

async function defaultGitRunner(args: readonly string[]): Promise<GitCommandResult> {
  const result = await execFileAsync("git", [...args], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });

  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

function uniqueNormalizedPaths(rootDir: string, paths: readonly string[]): string[] {
  return Array.from(
    new Set(paths.map((pathValue) => normalizeChangedPath(rootDir, pathValue)).filter(Boolean)),
  );
}

function normalizeGitOutputPaths(repositoryDir: string, stdout: string): string[] {
  return uniqueNormalizedPaths(
    repositoryDir,
    stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function requireRevisionPair(range: ChangeRange): { baseRevision: string; headRevision: string } {
  if (!range.baseRevision || !range.headRevision) {
    throw new RangeError("Git diff requires both baseRevision and headRevision.");
  }

  return {
    baseRevision: range.baseRevision,
    headRevision: range.headRevision,
  };
}

function buildRevisionRange(baseRevision: string, headRevision: string): string {
  return `${baseRevision}..${headRevision}`;
}

function ensurePositiveLine(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
}

function isRevisionRangeError(error: unknown): boolean {
  const maybeGitError = error as { readonly stdout?: unknown; readonly stderr?: unknown };
  const text = [
    error instanceof Error ? error.message : String(error),
    typeof maybeGitError.stdout === "string" ? maybeGitError.stdout : "",
    typeof maybeGitError.stderr === "string" ? maybeGitError.stderr : "",
  ].join("\n");

  return /(?:ambiguous argument|bad revision|unknown revision|invalid object name|not a valid object name|needed a single revision)/iu.test(
    text,
  );
}

function redactGitSecrets(text: string): string {
  return text
    .replace(/(http\.extraHeader=Authorization:\s*(?:token|bearer)\s+)[^\s'"\],]+/giu, "$1***")
    .replace(/(Authorization:\s*(?:token|bearer)\s+)[^\s'"\],]+/giu, "$1***");
}

function redactGitError(error: unknown): Error {
  const source = error as {
    readonly stdout?: unknown;
    readonly stderr?: unknown;
    readonly code?: unknown;
    readonly errno?: unknown;
    readonly syscall?: unknown;
    readonly path?: unknown;
  };
  const sanitized = new Error(redactGitSecrets(error instanceof Error ? error.message : String(error)));
  sanitized.name = error instanceof Error ? error.name : "Error";
  const target = sanitized as Error & Record<string, unknown>;

  if (typeof source.stdout === "string") {
    target.stdout = redactGitSecrets(source.stdout);
  }
  if (typeof source.stderr === "string") {
    target.stderr = redactGitSecrets(source.stderr);
  }
  if (source.code !== undefined) {
    target.code = source.code;
  }
  if (source.errno !== undefined) {
    target.errno = source.errno;
  }
  if (typeof source.syscall === "string") {
    target.syscall = source.syscall;
  }
  if (typeof source.path === "string") {
    target.path = source.path;
  }

  return sanitized;
}

export class GitVcsAdapter implements VcsAdapter {
  readonly kind = "git" as const;

  private readonly repositoryDir: string;
  private readonly git: GitCommandRunner;
  private readonly diffFilter: string;
  private readonly allowDeepen: boolean;
  private readonly deepenBy: number;
  private readonly remote: string;
  private readonly remoteUrl: string | undefined;
  private readonly token: string | undefined;
  private repositorySynced = false;

  constructor(options: GitVcsAdapterOptions) {
    this.repositoryDir = resolve(options.repositoryDir);
    this.git = options.git ?? defaultGitRunner;
    this.diffFilter = options.diffFilter ?? "ACMRT";
    this.allowDeepen = options.allowDeepen ?? false;
    this.deepenBy = options.deepenBy ?? 100;
    this.remote = options.remote ?? "origin";
    this.remoteUrl = options.remoteUrl;
    this.token = options.token;

    if (!Number.isInteger(this.deepenBy) || this.deepenBy < 1) {
      throw new RangeError("deepenBy must be a positive integer.");
    }
  }

  private buildGitArgs(args: readonly string[]): string[] {
    return this.token
      ? ["-c", `http.extraHeader=Authorization: token ${this.token}`, ...args]
      : [...args];
  }

  private async runGit(args: readonly string[]): Promise<GitCommandResult> {
    try {
      return await this.git(this.buildGitArgs(args));
    } catch (error) {
      throw redactGitError(error);
    }
  }

  private async isGitRepository(): Promise<boolean> {
    try {
      const result = await this.runGit(["-C", this.repositoryDir, "rev-parse", "--is-inside-work-tree"]);
      return result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private async syncRepository(): Promise<void> {
    if (!this.remoteUrl || this.repositorySynced) {
      return;
    }

    if (await this.isGitRepository()) {
      await this.runGit(["-C", this.repositoryDir, "fetch", "--prune", this.remote]);
      this.repositorySynced = true;
      return;
    }

    await rm(this.repositoryDir, { recursive: true, force: true });
    await mkdir(dirname(this.repositoryDir), { recursive: true });
    await this.runGit(["clone", "--no-checkout", this.remoteUrl, this.repositoryDir]);
    this.repositorySynced = true;
  }

  private async runRevisionRangeCommand(args: readonly string[]): Promise<GitCommandResult> {
    try {
      return await this.runGit(args);
    } catch (error) {
      if (!this.allowDeepen || !isRevisionRangeError(error)) {
        throw error;
      }

      await this.runGit(["-C", this.repositoryDir, "fetch", `--deepen=${this.deepenBy}`, this.remote]);
      return this.runGit(args);
    }
  }

  async listChanges(ev: ReviewEvent): Promise<ChangeRange> {
    const eventFiles = ev.changedFiles ? uniqueNormalizedPaths(this.repositoryDir, ev.changedFiles) : [];

    if (!ev.baseSha || !ev.headSha) {
      if (eventFiles.length > 0) {
        return { files: eventFiles };
      }

      throw new RangeError("Git listChanges requires base/head revisions or ReviewEvent.changedFiles.");
    }

    await this.syncRepository();

    let files: string[];
    try {
      const result = await this.runRevisionRangeCommand([
        "-C",
        this.repositoryDir,
        "diff",
        "--name-only",
        `--diff-filter=${this.diffFilter}`,
        buildRevisionRange(ev.baseSha, ev.headSha),
        "--",
      ]);
      files = normalizeGitOutputPaths(this.repositoryDir, result.stdout);
    } catch (error) {
      if (eventFiles.length === 0) {
        throw error;
      }
      files = [];
    }

    return {
      baseRevision: ev.baseSha,
      headRevision: ev.headSha,
      files: files.length > 0 ? files : eventFiles,
    };
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

    await this.syncRepository();

    for (const filePath of uniqueNormalizedPaths(workspaceSourceDir, range.files)) {
      try {
        const result = await this.runGit([
          "-C",
          this.repositoryDir,
          "show",
          `${revision}:${normalizePath(filePath)}`,
        ]);
        const destinationPath = join(workspaceSourceDir, filePath);
        await mkdir(dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, result.stdout, "utf8");
        fetchedFiles.push(filePath);
      } catch {
        // Deleted files and binary blobs may not be materializable as UTF-8 source text.
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
    ensurePositiveLine(startLine, "startLine");
    ensurePositiveLine(endLine, "endLine");

    if (startLine > endLine) {
      throw new RangeError("startLine must be less than or equal to endLine.");
    }

    const selectedLines = content.split(/\r?\n/u).slice(startLine - 1, endLine);
    return {
      path: normalizedPath,
      content: selectedLines.join("\n"),
    };
  }

  async diff(range: ChangeRange, options: GitDiffOptions = {}): Promise<ParsedDiff> {
    await this.syncRepository();
    const { baseRevision, headRevision } = requireRevisionPair(range);
    const args = [
      "-C",
      this.repositoryDir,
      "diff",
      `--unified=${options.contextLines ?? 3}`,
      buildRevisionRange(baseRevision, headRevision),
      "--",
      ...uniqueNormalizedPaths(this.repositoryDir, range.files),
    ];
    const result = await this.runRevisionRangeCommand(args);

    return parseUnifiedDiff(result.stdout);
  }
}

export function createGitVcsAdapter(options: GitVcsAdapterOptions): GitVcsAdapter {
  return new GitVcsAdapter(options);
}
