import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { normalizeChangedPath, normalizePath, withTransientIoRetry, type ReviewEvent } from "@aicr/core";

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
  CommitMetadataQuery,
  CommitMetadataRecord,
  CommitMetadataPage,
  ExtraContextRequest,
  ExtraContextResult,
  ScopedTree,
  VcsAdapter,
  WorkspaceRef,
} from "./contracts.js";
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
  /**
   * Resolve a fresh token immediately before every repository sync. Long-lived
   * adapters (auto-commit scheduler) outlive short-lived credentials such as
   * GitHub App installation tokens, so the token must be re-resolved per sync
   * instead of captured once at construction. Takes precedence over `token`
   * for the HTTPS clone/fetch URL when it resolves a value.
   */
  readonly tokenProvider?: () => Promise<string | undefined> | string | undefined;
  /**
   * Re-fetch from the remote on every sync instead of only the first one.
   * Long-lived metadata consumers (auto-commit scheduler) must see history
   * that arrived after the first sync; per-run adapters keep the default.
   */
  readonly alwaysFetch?: boolean;
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

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function getGitErrorText(error: unknown): string {
  const maybeGitError = error as { readonly stdout?: unknown; readonly stderr?: unknown };
  return [
    error instanceof Error ? error.message : String(error),
    typeof maybeGitError.stdout === "string" ? maybeGitError.stdout : "",
    typeof maybeGitError.stderr === "string" ? maybeGitError.stderr : "",
  ].join("\n");
}

function isRevisionRangeError(error: unknown): boolean {
  return /(?:ambiguous argument|bad revision|unknown revision|invalid object name|not a valid object name|needed a single revision)/iu.test(
    getGitErrorText(error),
  );
}

function isGitBlameMissingError(error: unknown): boolean {
  return /(?:no such path|path .* does not exist|does not exist (?:in|at) revision|no such file or directory|bad object header)/iu.test(
    getGitErrorText(error),
  );
}

const GIT_BLAME_HEADER_RE = /^([0-9a-f]{4,64})\s+\d+\s+(\d+)(?:\s+\d+)?$/u;

const LS_TREE_ENTRY_RE = /^(\d{6})\s+(\S+)\s+([0-9a-fA-F]+)\t(.+)$/u;

interface GitlinkEntry {
  readonly path: string;
  readonly commit: string;
}

export function parseLsTreeGitlinks(stdout: string): GitlinkEntry[] {
  const entries: GitlinkEntry[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = LS_TREE_ENTRY_RE.exec(line);
    if (!match) {
      continue;
    }
    const [, mode, , commit, entryPath] = match;
    if (mode === "160000" && commit && entryPath) {
      entries.push({ path: entryPath, commit });
    }
  }
  return entries;
}

export function parseGitmodulesUrl(content: string, submodulePath: string): string | undefined {
  let sectionPath: string | undefined;
  let sectionUrl: string | undefined;
  let matchedUrl: string | undefined;

  const flush = (): void => {
    if (sectionPath === submodulePath && sectionUrl) {
      matchedUrl = sectionUrl;
    }
    sectionPath = undefined;
    sectionUrl = undefined;
  };

  for (const line of content.split(/\r?\n/u)) {
    if (/^\s*\[submodule\s/u.test(line)) {
      flush();
      continue;
    }
    const pair = /^\s*(path|url)\s*=\s*(\S.*?)\s*$/u.exec(line);
    if (!pair) {
      continue;
    }
    if (pair[1] === "path") {
      sectionPath = pair[2];
    } else {
      sectionUrl = pair[2];
    }
  }
  flush();
  return matchedUrl;
}

export function resolveRelativeGitUrl(
  remoteUrl: string | undefined,
  submoduleUrl: string,
): string {
  if (!/^\.\.?(?:\/|$)/u.test(submoduleUrl)) {
    return submoduleUrl;
  }
  if (!remoteUrl) {
    return submoduleUrl;
  }

  const scpLike = /^([^\s/@]+@[^\s/:]+:)(.+)$/u.exec(remoteUrl);
  if (scpLike) {
    const segments = (scpLike[2] as string).split("/");
    for (const part of submoduleUrl.split("/")) {
      if (part === "..") {
        segments.pop();
      } else if (part !== ".") {
        segments.push(part);
      }
    }
    return `${scpLike[1] as string}${segments.join("/")}`;
  }

  try {
    const base = remoteUrl.endsWith("/") ? remoteUrl : `${remoteUrl}/`;
    return new URL(submoduleUrl, base).toString();
  } catch {
    return submoduleUrl;
  }
}

function formatLsTreeListing(stdout: string): string[] {
  const lines: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = LS_TREE_ENTRY_RE.exec(line);
    if (!match) {
      continue;
    }
    const [, mode, type, , entryPath] = match;
    if (!entryPath) {
      continue;
    }
    const label = mode === "160000" ? "submodule" : type === "tree" ? "dir" : "file";
    lines.push(`- ${label}: ${entryPath}`);
  }
  return lines;
}

interface GitLogMetadataEntry {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly committerName?: string;
  readonly committerEmail?: string;
  readonly paths: readonly string[];
}

/**
 * Parses `git log --format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce
 * --name-only` output: one `\x1e`-prefixed record per commit, header fields
 * `\x1f`-separated on the first line, changed paths on following non-empty
 * lines. Author/committer values are raw (`%an` family), never mailmapped.
 */
export function parseGitLogMetadata(stdout: string): GitLogMetadataEntry[] {
  const entries: GitLogMetadataEntry[] = [];
  for (const chunk of stdout.split("\x1e")) {
    const trimmed = chunk.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
    if (trimmed.length === 0) {
      continue;
    }
    const lines = trimmed.split(/\r?\n/u);
    const header = lines[0] ?? "";
    const fields = header.split("\x1f");
    if (fields.length < 6 || !/^[0-9a-f]{4,64}$/iu.test(fields[0] ?? "")) {
      continue;
    }
    const parents = (fields[1] ?? "").split(/\s+/u).filter((value) => value.length > 0);
    const emptyToUndefined = (value: string | undefined): string | undefined =>
      value !== undefined && value.length > 0 ? value : undefined;
    const authorName = emptyToUndefined(fields[2]);
    const authorEmail = emptyToUndefined(fields[3]);
    const committerName = emptyToUndefined(fields[4]);
    const committerEmail = emptyToUndefined(fields[5]);
    entries.push({
      sha: fields[0] ?? "",
      parents,
      ...(authorName !== undefined ? { authorName } : {}),
      ...(authorEmail !== undefined ? { authorEmail } : {}),
      ...(committerName !== undefined ? { committerName } : {}),
      ...(committerEmail !== undefined ? { committerEmail } : {}),
      paths: lines.slice(1).filter((line) => line.trim().length > 0),
    });
  }
  return entries;
}

export function parseGitBlamePorcelain(stdout: string): AttributionEntry[] {
  const entries: AttributionEntry[] = [];
  const lines = stdout.split(/\r?\n/u);

  let pendingRevision: string | undefined;
  let pendingLine: number | undefined;
  let pendingAuthor: string | undefined;
  let pendingAuthorEmail: string | undefined;
  let pendingSummary: string | undefined;

  const flush = (): void => {
    if (pendingLine === undefined) {
      return;
    }
    entries.push(
      buildAttributionEntry({
        line: pendingLine,
        revision: pendingRevision,
        author: pendingAuthor,
        authorEmail: pendingAuthorEmail,
        summary: pendingSummary,
      }),
    );
    pendingRevision = undefined;
    pendingLine = undefined;
    pendingAuthor = undefined;
    pendingAuthorEmail = undefined;
    pendingSummary = undefined;
  };

  for (const line of lines) {
    const headerMatch = GIT_BLAME_HEADER_RE.exec(line);
    if (headerMatch) {
      flush();
      pendingRevision = headerMatch[1];
      pendingLine = Number(headerMatch[2]);
      continue;
    }

    if (pendingLine === undefined) {
      continue;
    }

    if (line.startsWith("\t")) {
      flush();
      continue;
    }

    if (line.startsWith("author ")) {
      pendingAuthor = line.slice("author ".length);
    } else if (line.startsWith("author-mail ")) {
      pendingAuthorEmail = line
        .slice("author-mail ".length)
        .replace(/^<|>$/gu, "");
    } else if (line.startsWith("summary ")) {
      pendingSummary = line.slice("summary ".length);
    }
  }

  flush();
  return entries;
}

export function redactGitSecrets(text: string): string {
  return text
    .replace(/(http\.extraHeader=Authorization:\s*(?:token|bearer)\s+)[^\s'"\],]+/giu, "$1***")
    .replace(/(Authorization:\s*(?:token|bearer)\s+)[^\s'"\],]+/giu, "$1***")
    .replace(/(x-access-token:)[^@]+(@)/gu, "$1***$2");
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

function parseHttpRemoteUrl(remoteUrl: string | undefined): URL | undefined {
  if (!remoteUrl) {
    return undefined;
  }

  try {
    const url = new URL(remoteUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
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
  private readonly tokenProvider: GitVcsAdapterOptions["tokenProvider"];
  private readonly alwaysFetch: boolean;
  private repositorySynced = false;
  private readonly submoduleSyncedDirs = new Set<string>();

  constructor(options: GitVcsAdapterOptions) {
    this.repositoryDir = resolve(options.repositoryDir);
    this.git = options.git ?? defaultGitRunner;
    this.diffFilter = options.diffFilter ?? "ACMRT";
    this.allowDeepen = options.allowDeepen ?? false;
    this.deepenBy = options.deepenBy ?? 100;
    this.remote = options.remote ?? "origin";
    this.remoteUrl = options.remoteUrl;
    this.token = options.token;
    this.tokenProvider = options.tokenProvider;
    this.alwaysFetch = options.alwaysFetch ?? false;

    if (!Number.isInteger(this.deepenBy) || this.deepenBy < 1) {
      throw new RangeError("deepenBy must be a positive integer.");
    }
  }

  private async resolveSyncToken(): Promise<string | undefined> {
    if (!this.tokenProvider) {
      return this.token;
    }
    return (await this.tokenProvider()) ?? this.token;
  }

  private authenticatedRemoteUrl(token: string | undefined): string | undefined {
    if (!this.remoteUrl || !token) {
      return this.remoteUrl;
    }

    const url = parseHttpRemoteUrl(this.remoteUrl);
    if (!url) {
      return this.remoteUrl;
    }

    url.username = "x-access-token";
    url.password = token;
    return url.toString();
  }

  private buildGitArgs(args: readonly string[]): string[] {
    if (!this.token) {
      return [...args];
    }
    if (parseHttpRemoteUrl(this.remoteUrl)) {
      return [...args];
    }
    return ["-c", `http.extraHeader=Authorization: token ${this.token}`, ...args];
  }

  private async runGit(
    args: readonly string[],
    options?: { readonly beforeAttempt?: () => Promise<void> },
  ): Promise<GitCommandResult> {
    return withTransientIoRetry(async () => {
      await options?.beforeAttempt?.();
      try {
        return await this.git(this.buildGitArgs(args));
      } catch (error) {
        throw redactGitError(error);
      }
    });
  }

  private async isGitRepository(dir: string = this.repositoryDir): Promise<boolean> {
    try {
      const result = await this.runGit(["-C", dir, "rev-parse", "--is-inside-work-tree"]);
      return result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private async syncRepository(): Promise<void> {
    if (!this.remoteUrl) {
      return;
    }
    if (this.repositorySynced && !this.alwaysFetch) {
      return;
    }

    const authUrl = this.authenticatedRemoteUrl(await this.resolveSyncToken());

    if (await this.isGitRepository()) {
      if (authUrl) {
        await this.runGit(["-C", this.repositoryDir, "remote", "set-url", this.remote, authUrl]);
      }
      await this.runGit(["-C", this.repositoryDir, "fetch", "--prune", this.remote]);
      await this.fetchPrRefs();
      this.repositorySynced = true;
      return;
    }

    await rm(this.repositoryDir, { recursive: true, force: true });
    await mkdir(dirname(this.repositoryDir), { recursive: true });
    await this.runGit(["clone", "--no-checkout", authUrl ?? this.remoteUrl, this.repositoryDir]);
    await this.fetchPrRefs();
    this.repositorySynced = true;
  }

  private async fetchPrRefs(): Promise<void> {
    try {
      await this.runGit([
        "-C", this.repositoryDir, "fetch", this.remote,
        "+refs/pull/*/head:refs/remotes/origin/pr/*",
      ]);
    } catch {
      // Not all remotes expose PR refs; ignore failures.
    }
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

  private async listGitlinkEntries(revision: string, path: string): Promise<GitlinkEntry[]> {
    try {
      const result = await this.runGit([
        "-C",
        this.repositoryDir,
        "ls-tree",
        revision,
        "--",
        normalizePath(path),
      ]);
      return parseLsTreeGitlinks(result.stdout);
    } catch {
      return [];
    }
  }

  private async findGitlinkForPath(revision: string, normalizedPath: string): Promise<GitlinkEntry | undefined> {
    const candidates = [normalizedPath];
    let ancestor = normalizedPath;
    while (ancestor.includes("/")) {
      ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
      candidates.push(ancestor);
    }

    for (const candidate of candidates) {
      const entries = await this.listGitlinkEntries(revision, candidate);
      const hit = entries.find(
        (entry) => entry.path === normalizedPath || normalizedPath.startsWith(`${entry.path}/`),
      );
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  private async readSubmoduleUrl(revision: string, submodulePath: string): Promise<string | undefined> {
    try {
      const result = await this.runGit([
        "-C",
        this.repositoryDir,
        "show",
        `${revision}:.gitmodules`,
      ]);
      return parseGitmodulesUrl(result.stdout, submodulePath);
    } catch {
      return undefined;
    }
  }

  private submoduleCacheDir(url: string): string {
    const key = createHash("sha256").update(url).digest("hex").slice(0, 16);
    return join(dirname(this.repositoryDir), ".aicr-submodules", key);
  }

  private authenticatedSubmoduleUrl(url: string): string {
    if (!this.token) {
      return url;
    }
    const parsed = parseHttpRemoteUrl(url);
    if (!parsed) {
      return url;
    }
    const remoteHost = this.remoteUrl ? parseHttpRemoteUrl(this.remoteUrl)?.host : undefined;
    if (remoteHost && parsed.host !== remoteHost) {
      // Never leak the superproject token to a different host.
      return url;
    }
    parsed.username = "x-access-token";
    parsed.password = this.token;
    return parsed.toString();
  }

  private async ensureSubmoduleRepo(url: string): Promise<string> {
    const dir = this.submoduleCacheDir(url);
    const authUrl = this.authenticatedSubmoduleUrl(url);

    if (await this.isGitRepository(dir)) {
      if (!this.submoduleSyncedDirs.has(dir)) {
        await this.runGit(["-C", dir, "remote", "set-url", "origin", authUrl]);
        await this.runGit(["-C", dir, "fetch", "--prune", "origin"]);
        this.submoduleSyncedDirs.add(dir);
      }
      return dir;
    }

    await mkdir(dirname(dir), { recursive: true });
    await this.runGit(["clone", "--no-checkout", authUrl, dir], {
      // git clone accepts an existing empty directory; remove the target so
      // each transient-failure retry starts from a clean slate after a
      // partial clone.
      beforeAttempt: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    });
    this.submoduleSyncedDirs.add(dir);
    return dir;
  }

  private async ensureSubmoduleCommit(dir: string, commit: string): Promise<boolean> {
    try {
      await this.runGit(["-C", dir, "cat-file", "-e", `${commit}^{commit}`]);
      return true;
    } catch {
      // The pinned commit may be unreachable from advertised refs (e.g. an
      // old force-pushed branch); ask the server for it directly.
    }
    try {
      await this.runGit(["-C", dir, "fetch", "--depth", "1", "origin", commit]);
      await this.runGit(["-C", dir, "cat-file", "-e", `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  private buildSubmoduleNote(
    revision: string,
    requestedPath: string,
    gitlink: GitlinkEntry,
    submoduleUrl: string | undefined,
    detail: string,
  ): string {
    const lines = [
      gitlink.path === requestedPath
        ? `"${requestedPath}" is a git submodule (gitlink) at revision ${revision}.`
        : `"${requestedPath}" is inside the git submodule "${gitlink.path}" at revision ${revision}.`,
      `The submodule "${gitlink.path}" is pinned at commit ${gitlink.commit}.`,
    ];
    if (submoduleUrl) {
      lines.push(`Submodule URL from .gitmodules: ${submoduleUrl}`);
    }
    lines.push(detail, "Do not retry aicr.fetch_more_context for this path.");
    return `${lines.join("\n")}\n`;
  }

  private async fetchSubmoduleContext(
    revision: string,
    requestedPath: string,
    gitlink: GitlinkEntry,
  ): Promise<string> {
    const submoduleUrl = await this.readSubmoduleUrl(revision, gitlink.path);
    const relativePath = requestedPath === gitlink.path
      ? ""
      : requestedPath.slice(gitlink.path.length + 1);

    if (!submoduleUrl) {
      return this.buildSubmoduleNote(
        revision,
        requestedPath,
        gitlink,
        submoduleUrl,
        "No submodule URL is recorded in .gitmodules at this revision, so AICR cannot fetch its contents automatically.",
      );
    }

    const resolvedUrl = resolveRelativeGitUrl(this.remoteUrl, submoduleUrl);
    let repoDir: string;
    try {
      repoDir = await this.ensureSubmoduleRepo(resolvedUrl);
    } catch (error) {
      return this.buildSubmoduleNote(
        revision,
        requestedPath,
        gitlink,
        submoduleUrl,
        `Automatic fetch of the submodule repository failed after retries: ${redactGitSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }

    if (!(await this.ensureSubmoduleCommit(repoDir, gitlink.commit))) {
      return this.buildSubmoduleNote(
        revision,
        requestedPath,
        gitlink,
        submoduleUrl,
        `The pinned commit is not reachable from the submodule remote; its history may have been rewritten.`,
      );
    }

    if (relativePath === "") {
      const listing = await this.runGit(["-C", repoDir, "ls-tree", gitlink.commit]);
      const entries = formatLsTreeListing(listing.stdout);
      return [
        `"${requestedPath}" is a git submodule (gitlink) at revision ${revision}; AICR fetched the submodule repository automatically.`,
        `The submodule "${gitlink.path}" is pinned at commit ${gitlink.commit}.`,
        `Submodule URL from .gitmodules: ${submoduleUrl}`,
        "Root entries at the pinned commit:",
        ...entries,
        `Request a specific file inside the submodule (e.g. "${gitlink.path}/<file>") through aicr.fetch_more_context to read its content at this pinned commit.`,
      ].join("\n") + "\n";
    }

    try {
      const result = await this.runGit([
        "-C",
        repoDir,
        "show",
        `${gitlink.commit}:${normalizePath(relativePath)}`,
      ]);
      return result.stdout;
    } catch {
      return this.buildSubmoduleNote(
        revision,
        requestedPath,
        gitlink,
        submoduleUrl,
        `"${relativePath}" does not exist in the submodule at the pinned commit.`,
      );
    }
  }

  async fetchExtraContext(req: ExtraContextRequest, ws: WorkspaceRef): Promise<ExtraContextResult> {
    const workspaceSourceDir = resolve(ws.sourceDir);
    const normalizedPath = normalizeChangedPath(workspaceSourceDir, req.path);
    const destinationPath = join(workspaceSourceDir, normalizedPath);

    let content: string;
    try {
      content = await readFile(destinationPath, "utf8");
    } catch (error) {
      // fetchScoped only materializes changed files (via per-file `git show`),
      // so related-but-unchanged files the agent asks about are not on disk.
      // Fall back to fetching the path from the head revision and persist it
      // for subsequent reads. Without this, fetch_more_context always ENOENTs
      // and the orchestrator drops the request ("ignored invalid
      // fetch_more_context tool call"), starving the agent of the context it
      // needs to confirm issues.
      if (!isFileNotFoundError(error) || !req.revision) {
        throw error;
      }
      try {
        const result = await this.runGit([
          "-C",
          this.repositoryDir,
          "show",
          `${req.revision}:${normalizePath(normalizedPath)}`,
        ]);
        content = result.stdout;
      } catch (showError) {
        // `git show <rev>:<path>` always fails for submodule gitlinks
        // ("fatal: bad object") because a gitlink is not a blob in the
        // superproject. Detect the gitlink and fetch the submodule
        // repository automatically (with transient-failure retries) so the
        // agent gets real content instead of an opaque orchestrator warning
        // loop ("ignored invalid fetch_more_context tool call").
        const gitlink = await this.findGitlinkForPath(req.revision, normalizedPath);
        if (!gitlink) {
          throw showError;
        }
        content = await this.fetchSubmoduleContext(req.revision, normalizedPath, gitlink);
      }
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, content, "utf8");
    }

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

  async fetchAttribution(req: AttributionRequest, ws: WorkspaceRef): Promise<AttributionResult> {
    const workspaceSourceDir = resolve(ws.sourceDir);
    const normalizedPath = normalizeChangedPath(workspaceSourceDir, req.path);
    const revision = req.revision ?? "HEAD";

    if (revision.length === 0 || revision.startsWith("-")) {
      throw new RangeError("Attribution revision must not be empty or option-like.");
    }

    const useNativeRange =
      Number.isInteger(req.startLine)
      && (req.startLine as number) >= 1
      && Number.isInteger(req.endLine)
      && (req.endLine as number) >= 1
      && (req.startLine as number) <= (req.endLine as number);
    const rangeArgs = useNativeRange
      ? ["-L", `${req.startLine},${req.endLine}`]
      : [];

    await this.syncRepository();

    let stdout: string;
    try {
      const result = await this.runGit([
        "-C",
        this.repositoryDir,
        "blame",
        "--line-porcelain",
        ...rangeArgs,
        revision,
        "--",
        normalizePath(normalizedPath),
      ]);
      stdout = result.stdout;
    } catch (error) {
      if (isRevisionRangeError(error) || isGitBlameMissingError(error)) {
        return { path: normalizedPath, status: "not_found", entries: [] };
      }
      throw error;
    }

    const parsed = parseGitBlamePorcelain(stdout);
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

  /**
   * Bounded first-parent history read for auto-commit scheduling (design
   * §6.1). Walks `base..head` (or from `head`'s root when base is omitted)
   * oldest-first with raw `%an/%ae/%cn/%ce` — never the mailmap-rewritten
   * `%aN/%aE/%cN/%cE` forms. Order keys are ABSOLUTE history positions
   * (`git rev-list --first-parent --count <sha>`), so out-of-order webhook
   * deliveries still order by true history rather than arrival (design
   * §5.2). The cursor carries the last emitted sha and its absolute
   * position; resuming re-derives the remaining range from that sha.
   * Side-branch commits of merges are excluded by `--first-parent`; merges
   * themselves keep their full parent list.
   */
  async listCommitMetadataPage(query: CommitMetadataQuery): Promise<CommitMetadataPage> {
    await this.syncRepository();

    let startIndex = 1;
    let rangeBase = query.baseRevision;
    let historyRewrite: boolean | undefined;
    if (query.cursor) {
      const [cursorSha = "", indexText, rewriteFlag] = query.cursor.split(":");
      const cursorIndex = Number(indexText);
      if (!/^[0-9a-f]{4,64}$/iu.test(cursorSha) || !Number.isInteger(cursorIndex) || cursorIndex < 1) {
        throw new RangeError(`Invalid git metadata cursor "${query.cursor}".`);
      }
      if (rewriteFlag !== undefined && rewriteFlag !== "rewrite" && rewriteFlag !== "linear") {
        throw new RangeError(`Invalid git metadata cursor "${query.cursor}".`);
      }
      historyRewrite = rewriteFlag === undefined ? undefined : rewriteFlag === "rewrite";
      rangeBase = cursorSha;
      startIndex = cursorIndex;
    } else if (rangeBase) {
      // Absolute first-parent position of the base; page records continue
      // from basePosition + 1. `rev-list --count` is one cheap SHA-only walk.
      try {
        const counted = await this.runRevisionRangeCommand([
          "-C",
          this.repositoryDir,
          "rev-list",
          "--first-parent",
          "--count",
          rangeBase,
        ]);
        const basePosition = Number(counted.stdout.trim());
        if (!Number.isSafeInteger(basePosition) || basePosition < 0) {
          throw new Error(`unexpected rev-list count "${counted.stdout.trim()}"`);
        }
        startIndex = basePosition + 1;
      } catch (error) {
        return {
          vcs: "git",
          records: [],
          status: "unavailable",
          unavailableReason: getGitErrorText(error),
        };
      }
    }
    // `git log --max-count` is applied BEFORE `--reverse`, so a single
    // oldest-first log command cannot page correctly. Read the SHA list of
    // the range first (oldest-first, SHA-only output — cheap even for large
    // incremental ranges), then fetch metadata for exactly the page slice
    // with `--no-walk`. A hard enumeration cap turns a pathological range
    // into an explicit blocker instead of an unbounded read (design G08).
    const range = rangeBase ? `${rangeBase}..${query.headRevision}` : query.headRevision;
    const GIT_METADATA_ENUM_CAP = 100_000;
    let shas: string[];
    try {
      const listing = await this.runRevisionRangeCommand([
        "-C",
        this.repositoryDir,
        "rev-list",
        "--first-parent",
        "--reverse",
        `--max-count=${GIT_METADATA_ENUM_CAP}`,
        range,
      ]);
      shas = listing.stdout.split(/\r?\n/u).filter((line) => /^[0-9a-f]{4,64}$/iu.test(line));
      if (shas.length >= GIT_METADATA_ENUM_CAP) {
        return {
          vcs: "git",
          records: [],
          status: "unavailable",
          unavailableReason: `range ${range} exceeds the ${GIT_METADATA_ENUM_CAP}-commit enumeration cap`,
        };
      }
    } catch (error) {
      // Missing endpoints, exhausted shallow history, or unreadable objects
      // are explicit blockers — never an empty range (design G08).
      return {
        vcs: "git",
        records: [],
        status: "unavailable",
        unavailableReason: getGitErrorText(error),
      };
    }

    // A rewind to an ancestor has no newly reachable commits, but it still
    // changes the notified endpoints. Keep the head as a rewrite observation.
    if (!query.cursor && query.baseRevision && shas.length === 0) {
      const endpoints = await this.runRevisionRangeCommand([
        "-C", this.repositoryDir, "rev-parse", `${query.baseRevision}^{commit}`, `${query.headRevision}^{commit}`,
      ]);
      const [baseSha, headSha] = endpoints.stdout.trim().split(/\r?\n/u);
      historyRewrite = baseSha !== headSha;
      if (historyRewrite && headSha) shas = [headSha];
    }
    const pageShas = shas.slice(0, query.maxRecords);
    if (pageShas.length === 0) {
      return { vcs: "git", records: [], status: "complete", ...(historyRewrite !== undefined ? { historyRewrite } : {}) };
    }

    const metadata = await this.runRevisionRangeCommand([
      "-C",
      this.repositoryDir,
      "log",
      "--no-walk",
      "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce",
      "--name-only",
      ...pageShas,
    ]);
    const parsed = parseGitLogMetadata(metadata.stdout);
    const bySha = new Map(parsed.map((entry) => [entry.sha, entry]));
    if (!query.cursor && query.baseRevision && historyRewrite === undefined) {
      const resolved = await this.runRevisionRangeCommand([
        "-C", this.repositoryDir, "rev-parse", "--verify", `${query.baseRevision}^{commit}`,
      ]);
      const first = bySha.get(pageShas[0]!);
      if (first) historyRewrite = first.parents[0] !== resolved.stdout.trim();
    }
    if (!query.cursor && historyRewrite) {
      const counted = await this.runRevisionRangeCommand([
        "-C", this.repositoryDir, "rev-list", "--first-parent", "--count", query.headRevision,
      ]);
      startIndex = Number(counted.stdout.trim()) - shas.length + 1;
    }

    const records: CommitMetadataRecord[] = [];
    let bytes = 0;
    let truncated = false;
    for (const [offset, sha] of pageShas.entries()) {
      const entry = bySha.get(sha);
      if (!entry) {
        return {
          vcs: "git",
          records: [],
          status: "unavailable",
          unavailableReason: `metadata missing for enumerated commit ${sha}`,
        };
      }
      const orderKey = String(startIndex + offset).padStart(12, "0");
      const paths: string[] = [];
      for (const path of entry.paths) {
        if (bytes + path.length + 16 > query.maxBytes) {
          truncated = true;
          break;
        }
        bytes += path.length + 16;
        paths.push(path);
      }
      bytes += 160;
      if (bytes > query.maxBytes && records.length > 0) {
        truncated = true;
        break;
      }
      records.push({
        revision: entry.sha,
        ...(historyRewrite !== undefined ? { historyRewrite } : {}),
        orderKey,
        parents: entry.parents,
        ...(entry.authorName !== undefined ? { authorName: entry.authorName } : {}),
        ...(entry.authorEmail !== undefined ? { authorEmail: entry.authorEmail } : {}),
        ...(entry.committerName !== undefined ? { committerName: entry.committerName } : {}),
        ...(entry.committerEmail !== undefined ? { committerEmail: entry.committerEmail } : {}),
        changedPaths: paths,
      });
    }

    const hasMore = shas.length > pageShas.length || truncated;
    const last = records[records.length - 1];
    const rangeFlag = historyRewrite === undefined ? "" : historyRewrite ? ":rewrite" : ":linear";
    const nextCursor = hasMore ? `${last?.revision ?? rangeBase ?? ""}:${startIndex + records.length}${rangeFlag}` : undefined;
    return {
      vcs: "git",
      records,
      ...(historyRewrite !== undefined ? { historyRewrite } : {}),
      ...(nextCursor ? { nextCursor } : {}),
      status: nextCursor ? "partial" : "complete",
    };
  }

}

export function createGitVcsAdapter(options: GitVcsAdapterOptions): GitVcsAdapter {
  return new GitVcsAdapter(options);
}
