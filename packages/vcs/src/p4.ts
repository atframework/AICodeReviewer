import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { normalizeChangedPath, normalizePath, isTransientIoError, withTransientIoRetry, type ReviewEvent } from "@aicr/core";

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
  CommitMetadataPage,
  CommitMetadataQuery,
  CommitMetadataRecord,
  ExtraContextRequest,
  ExtraContextResult,
  ScopedTree,
  VcsAdapter,
  WorkspaceRef,
} from "./contracts.js";
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

export type P4StdinRunner = (
  args: readonly string[],
  stdin: string,
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
  readonly p4Stdin?: P4StdinRunner;
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
  return defaultP4StdinRunner([...args, "login"], `${password}\n`, env);
}

async function defaultP4StdinRunner(
  args: readonly string[],
  stdin: string,
  env: Readonly<Record<string, string>> = {},
): Promise<P4CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("p4", [...args], {
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

      const error = new Error(`p4 ${args.join(" ")} failed with exit code ${code ?? "unknown"}. ${stderr || stdout}`);
      Object.assign(error, result, { code });
      reject(error);
    });
    child.stdin.end(stdin);
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

export function isP4AuthenticationError(error: unknown): boolean {
  return /P4PASSWD|Perforce password|not logged in|login required|session has expired|ticket.*expired/iu.test(getErrorText(error));
}

export function isP4TrustError(error: unknown): boolean {
  return /P4PORT IDENTIFICATION HAS CHANGED|authenticity of '.*' can't be established|use the 'p4 trust' command/iu.test(getErrorText(error));
}

export function isP4FingerprintChangedError(error: unknown): boolean {
  return /P4PORT IDENTIFICATION HAS CHANGED/iu.test(getErrorText(error));
}

// p4 surfaces network failures as plain stderr text (non-zero exit), not as
// Node error codes, so the generic transient-IO matcher misses them. These
// patterns cover the p4 CLI's network/transport phrasing so runP4 retries
// brief server/network blips instead of failing the whole review.
const P4_TRANSIENT_NETWORK_RES: readonly RegExp[] = [
  /\bTCP (?:connect|receive|send)\b[^\r\n]*\bfailed\b/iu,
  /\bconnect to server failed\b/iu,
  /\bbroken pipe\b/iu,
  /\bconnection (?:reset|closed|refused|timed out)\b/iu,
  /\boperation timed out\b/iu,
  /\bnetwork is unreachable\b/iu,
  /\bno route to host\b/iu,
  /\bhost (?:is\s+)?unreachable\b/iu,
  /\bSSL (?:connect|negotiation|read|write|shutdown) failed\b/iu,
];

export function isP4TransientNetworkError(error: unknown): boolean {
  // Inspect diagnostics only. A partially successful describe/print can carry
  // arbitrary changelist text on stdout, including a quoted error string.
  const text = getErrorDiagnosticText(error);
  return P4_TRANSIENT_NETWORK_RES.some((pattern) => pattern.test(text));
}

function isP4RetryableError(error: unknown): boolean {
  return isP4TransientNetworkError(error) || isTransientIoError(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getErrorDiagnosticText(error: unknown): string {
  const candidate = error as { readonly stderr?: unknown };
  return [
    error instanceof Error ? error.message : String(error),
    typeof candidate.stderr === "string" ? candidate.stderr : "",
  ].join("\n");
}

function isP4NoSuchFileError(error: unknown): boolean {
  return /\bno such file(?:\(s\))?(?:[.!]|\s|$)/iu.test(getErrorDiagnosticText(error));
}

function isP4ClientUnknownError(error: unknown, client: string): boolean {
  return new RegExp(`Client '${escapeRegExp(client)}' unknown`, "iu").test(getErrorDiagnosticText(error));
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

export function isP4DeleteAction(action: string | undefined): boolean {
  return action === "delete" || action === "move/delete";
}

function isDevNullPath(path: string): boolean {
  return path === "/dev/null" || path === "//dev/null";
}

const P4_ANNOTATE_LINE_RE = /^(\d+):/u;

export function parseP4AnnotateForAttribution(stdout: string): AttributionEntry[] {
  const entries: AttributionEntry[] = [];
  let lineNumber = 0;

  for (const line of stdout.split(/\r?\n/u)) {
    const match = P4_ANNOTATE_LINE_RE.exec(line);
    if (!match) {
      continue;
    }

    lineNumber += 1;
    entries.push(
      buildAttributionEntry({
        line: lineNumber,
        revision: match[1],
      }),
    );
  }

  return entries;
}

interface P4DescribeAttribution {
  readonly author?: string;
  readonly summary?: string;
}

export function parseP4DescribeForAttribution(
  stdout: string,
): ReadonlyMap<string, P4DescribeAttribution> {
  const map = new Map<string, P4DescribeAttribution>();
  let currentClist: string | null = null;
  let summaryCaptured = false;

  for (const line of stdout.split(/\r?\n/u)) {
    const headerMatch = /^Change (\d+) by (\S+)@/u.exec(line);
    if (headerMatch) {
      const clist = headerMatch[1];
      const author = headerMatch[2];
      if (clist && author) {
        currentClist = clist;
        map.set(clist, { author });
      } else {
        currentClist = null;
      }
      summaryCaptured = false;
      continue;
    }

    if (!currentClist || summaryCaptured) {
      continue;
    }

    const summaryMatch = /^\t\s*(.+?)\s*$/u.exec(line);
    const summary = summaryMatch?.[1];
    if (summary) {
      const existing = map.get(currentClist);
      map.set(currentClist, { ...existing, summary });
      summaryCaptured = true;
    }
  }

  return map;
}

/**
 * Hard enumeration cap for one `p4 changes` metadata read. `p4 changes`
 * lists newest-first and has no ascending mode, so an ascending page can
 * only be cut from a complete enumeration of the range; the cap turns a
 * pathological range into an explicit `unavailable` blocker instead of an
 * unbounded read (mirrors the git adapter, design G08).
 */
const P4_METADATA_ENUM_CAP = 100_000;

/**
 * Minimum maxBytes budget below which the per-page `p4 describe -s` path
 * read is skipped entirely — a smaller budget cannot hold a meaningful
 * path summary, and changedPaths is advisory (continuity and source
 * fields never depend on it).
 */
const P4_METADATA_MIN_DESCRIBE_BYTES = 4096;

interface P4ChangeMetadataEntry {
  readonly change: string;
  readonly user?: string;
  readonly client?: string;
}

/**
 * Parse `p4 changes -s submitted` output lines of the documented form
 * `Change N on YYYY/MM/DD by user@client 'desc'`. User and Client are
 * parsed separately (design §6.1); an empty or missing identity part maps
 * to `undefined` — never a substituted default.
 */
function parseP4ChangesMetadata(stdout: string): P4ChangeMetadataEntry[] {
  const entries: P4ChangeMetadataEntry[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const headerMatch = /^Change (\d+) on /u.exec(line);
    const change = headerMatch?.[1];
    if (!change) {
      continue;
    }
    const identityMatch = /^Change \d+ on \S+ by (\S+) '/u.exec(line);
    const identity = identityMatch?.[1];
    let user: string | undefined;
    let client: string | undefined;
    if (identity !== undefined) {
      const atIndex = identity.indexOf("@");
      if (atIndex >= 0) {
        user = identity.slice(0, atIndex) || undefined;
        client = identity.slice(atIndex + 1) || undefined;
      }
    }
    entries.push({
      change,
      ...(user !== undefined ? { user } : {}),
      ...(client !== undefined ? { client } : {}),
    });
  }
  return entries;
}

/**
 * Parse batched `p4 describe -s C1 C2 ...` output into per-changelist
 * depot paths (`... //depot/path#rev action` lines under each
 * `Change N by user@client on ...` header). Paths stay in raw depot form.
 */
function parseP4DescribeFilePaths(stdout: string): ReadonlyMap<string, readonly string[]> {
  const byChange = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    const headerMatch = /^Change (\d+) by /u.exec(line);
    const change = headerMatch?.[1];
    if (change) {
      current = [];
      byChange.set(change, current);
      continue;
    }
    if (!current) {
      continue;
    }
    const fileMatch = /^\.\.\. (\/\/[^#\s]+)#\d+ /u.exec(line);
    const path = fileMatch?.[1];
    if (path) {
      current.push(path);
    }
  }
  return byChange;
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

/**
 * Synthesize a unified add/delete entry from the surviving endpoint's
 * content. `p4 diff2` never emits content for a `<none>` endpoint (verified
 * against p4d 2025.1: the `-u` pass omits add/delete pairs entirely), so
 * the batch path prints the endpoint revision to keep added/deleted code
 * reviewable (design §6: 按已核验动作和端点内容转换). Binary payloads
 * (NUL probe) keep a hunkless entry, as do empty files — matching git's
 * representation of those cases.
 */
function appendEndpointContentEntry(
  target: string[],
  localPath: string,
  action: "add" | "delete",
  content: string,
): void {
  appendSyntheticUnifiedHeaders(target, localPath, action);
  if (content.length === 0 || content.includes("\0")) {
    return;
  }

  const normalized = content.replace(/\r\n/gu, "\n");
  const hasTrailingNewline = normalized.endsWith("\n");
  const body = hasTrailingNewline ? normalized.slice(0, -1) : normalized;
  const lines = body.split("\n");
  const marker = action === "add" ? "+" : "-";
  target.push(
    action === "add"
      ? `@@ -0,0 +1,${lines.length} @@`
      : `@@ -1,${lines.length} +0,0 @@`,
  );
  for (const line of lines) {
    target.push(`${marker}${line}`);
  }
  if (!hasTrailingNewline) {
    target.push("\\ No newline at end of file");
  }
}

/**
 * One `====` pair from default `p4 diff2` output (verified against p4d
 * 2025.1). `kind: "content"` blocks carry content differences (hunks are
 * read from the `-u` pass); add/delete blocks have a `<none>` endpoint and
 * get their content synthesized from `p4 print` of the surviving endpoint
 * (see `appendEndpointContentEntry`); everything else (binary,
 * filetype-only change) keeps a hunkless entry so the net diff never
 * silently drops the file.
 */
interface P4Diff2Block {
  readonly depotPath: string;
  readonly kind: "content" | "endpoint";
  readonly action: "add" | "delete" | undefined;
}

/**
 * Parse default (non-`-u`) `p4 diff2` output. Header form observed on p4d
 * 2025.1 (paths may contain spaces; `#` is illegal in p4 filenames):
 * `==== <none> - //path#N ====`, `==== //path#M - <none> ====`,
 * `==== //path#M (text) - //path#N (text) ==== content`.
 * Ed-script payload lines of content blocks are skipped — hunks come from
 * the `-u` pass. Any unrecognized header or non-empty output without
 * headers is a loud parse failure, never an silently empty diff.
 */
function parseP4Diff2Pairs(stdout: string, baseRevision: string, headRevision: string): P4Diff2Block[] {
  // Closing marker is `====` normally but `===` when the right endpoint is
  // `<none>` (byte-verified p4d 2025.1 quirk).
  const headerPattern =
    /^==== (?:(<none>)|(\/\/.+?)#(\d+)(?: \(([^)]*)\))?) - (?:(<none>)|(\/\/.+?)#(\d+)(?: \(([^)]*)\))?) ={3,4}(?:\s+(.*))?$/u;
  const blocks: P4Diff2Block[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith("==== ")) {
      continue;
    }
    const match = headerPattern.exec(line);
    if (!match) {
      throw new Error(
        `p4 diff2 @${baseRevision}..@${headRevision} parse failure: unrecognized header "${line.slice(0, 200)}".`,
      );
    }
    const [, oldNone, oldPath, , oldType, newNone, newPath, , newType, summary] = match;
    if (oldNone && newNone) {
      throw new Error(
        `p4 diff2 @${baseRevision}..@${headRevision} parse failure: both endpoints <none> in "${line.slice(0, 200)}".`,
      );
    }
    // `identical` pairs (same file revision at both endpoints, observed on
    // p4d 2025.1 for wildcard ranges) are not changes.
    if (summary === "identical") {
      continue;
    }
    const depotPath = newPath ?? oldPath;
    if (!depotPath) {
      continue;
    }
    // Binary pairs keep a hunkless entry even when the summary says
    // `content` (real payload: `(... files differ ...)`); the -u pass
    // cannot represent them.
    const binary = [oldType, newType].some((type) => type?.includes("binary"));
    if (!oldNone && !newNone && !binary && summary === "content") {
      blocks.push({ depotPath, kind: "content", action: undefined });
      continue;
    }
    blocks.push({
      depotPath,
      kind: "endpoint",
      action: oldNone ? "add" : newNone ? "delete" : undefined,
    });
  }
  if (blocks.length === 0 && stdout.trim().length > 0) {
    throw new Error(
      `p4 diff2 @${baseRevision}..@${headRevision} parse failure: output has no file headers: `
      + stdout.slice(0, 300).replaceAll("\n", " "),
    );
  }
  return blocks;
}

/**
 * Parse `p4 diff2 -u` output into per-file hunk lines keyed by depot path.
 * Real p4d 2025.1 emits `--- //path\t<timestamp>` / `+++ //path\t<timestamp>`
 * headers (no `====` separators, no `#rev` suffixes) followed by `@@`
 * sections; add/delete/binary pairs never appear. The returned lines start
 * at the first `@@`; callers add git-style `---`/`+++` headers themselves.
 */
function parseP4Diff2Unified(
  stdout: string,
  baseRevision: string,
  headRevision: string,
): ReadonlyMap<string, readonly string[]> {
  const byPath = new Map<string, string[]>();
  let currentPath: string | undefined;
  let sawPlus = false;
  for (const line of stdout.split(/\r?\n/u)) {
    const minusMatch = /^--- ((?:\/\/).+?)(?:#\d+)?(?:\t.*)?$/u.exec(line);
    if (minusMatch?.[1]) {
      currentPath = minusMatch[1];
      sawPlus = false;
      if (!byPath.has(currentPath)) {
        byPath.set(currentPath, []);
      }
      continue;
    }
    if (/^\+\+\+ /u.test(line)) {
      const plusMatch = /^\+\+\+ ((?:\/\/).+?)(?:#\d+)?(?:\t.*)?$/u.exec(line);
      if (!plusMatch?.[1] || plusMatch[1] !== currentPath) {
        throw new Error(
          `p4 diff2 -u @${baseRevision}..@${headRevision} parse failure: +++ header "${line.slice(0, 200)}" does not match the preceding --- header.`,
        );
      }
      sawPlus = true;
      continue;
    }
    // Binary pairs appear as a bare `Binary files X and Y differ` line
    // outside any ---/+++ block (verified on p4d 2025.1); the pair itself
    // is already a hunkless entry from the enumeration pass.
    if (/^Binary files \/\/.+ and \/\/.+ differ$/u.test(line)) {
      continue;
    }
    if (currentPath === undefined || !sawPlus) {
      if (line.trim().length > 0) {
        throw new Error(
          `p4 diff2 -u @${baseRevision}..@${headRevision} parse failure: content before first file header: "${line.slice(0, 200)}".`,
        );
      }
      continue;
    }
    byPath.get(currentPath)?.push(line);
  }
  return byPath;
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
  private readonly p4Stdin: P4StdinRunner;
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
    this.p4Stdin = options.p4Stdin ?? defaultP4StdinRunner;
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
    return withTransientIoRetry(async () => {
      let trustRetried = false;
      let clientRecreated = false;
      for (;;) {
        try {
          return await this.runP4Once(args);
        } catch (error) {
          if (isP4TrustError(error) && !trustRetried) {
            trustRetried = true;
            await this.trust();
            continue;
          }

          if (this.clientWorkspace && !clientRecreated && isP4ClientUnknownError(error, this.clientWorkspace)) {
            clientRecreated = true;
            await this.recreateClientWorkspace();
            continue;
          }

          if (!this.password || this.loginAttempted || !isP4AuthenticationError(error)) {
            throw error;
          }

          await this.login();
        }
      }
    }, {
      isRetryable: isP4RetryableError,
      onRetry: (error, nextAttempt, delayMs) => {
        console.warn(JSON.stringify({
          level: "warn",
          msg: "transient p4 network failure; retrying",
          command: args[0],
          nextAttempt,
          delayMs,
          error: getErrorText(error).slice(0, 300),
        }));
      },
    });
  }

  private async trust(): Promise<void> {
    console.warn(JSON.stringify({
      level: "warn",
      msg: "p4 server fingerprint untrusted; running p4 trust -y",
      port: this.port,
      user: this.user,
    }));
    try {
      await this.p4([...this.buildBaseArgs(), "trust", "-y"], this.buildEnv());
    } catch (error) {
      if (!isP4FingerprintChangedError(error)) {
        throw error;
      }
      console.warn(JSON.stringify({
        level: "warn",
        msg: "p4 fingerprint changed; forcing replacement with p4 trust -y -f",
        port: this.port,
        user: this.user,
      }));
      await this.p4([...this.buildBaseArgs(), "trust", "-y", "-f"], this.buildEnv());
    }
  }

  private buildClientSpec(client: string): string {
    const depotBase = this.depot?.replace(/\/+$/u, "") ?? "";
    const viewDepot = depotBase.startsWith("//") ? depotBase : "//depot";
    const lines = [
      `Client: ${client}`,
      ...(this.user ? [`Owner: ${this.user}`] : []),
      "Description: Auto-created by AICR for read-only analysis.",
      `Root: ${this.repositoryDir}`,
      "Options: noallwrite noclobber nocompress unlocked nomodtime normdir",
      "LineEnd: local",
      "View:",
      `\t${viewDepot}/... //${client}/...`,
      "",
    ];
    return lines.join("\n");
  }

  private async recreateClientWorkspace(): Promise<void> {
    const client = this.clientWorkspace;
    if (!client) {
      return;
    }
    console.warn(JSON.stringify({
      level: "warn",
      msg: "p4 client workspace unknown on server; recreating via p4 client -i",
      port: this.port,
      user: this.user,
      client,
    }));
    await this.p4Stdin(
      [...this.buildBaseArgs(), "client", "-i"],
      this.buildClientSpec(client),
      this.buildEnv(),
    );
  }

  async login(): Promise<void> {
    if (!this.password) return;
    try {
      await this.p4Login(this.buildBaseArgs(), this.password, this.buildEnv());
    } catch (error) {
      if (!isP4TrustError(error)) {
        throw error;
      }
      await this.trust();
      await this.p4Login(this.buildBaseArgs(), this.password, this.buildEnv());
    }
    this.loginAttempted = true;
  }

  async listChanges(ev: ReviewEvent): Promise<ChangeRange> {
    const changeNumber = ev.headSha;
    if (!changeNumber) {
      throw new RangeError("P4 listChanges requires headSha (changelist number).");
    }

    if (ev.baseSha && ev.baseSha !== changeNumber) {
      const blocks = await this.listBatchDiffBlocks(ev.baseSha, changeNumber);
      return {
        baseRevision: ev.baseSha,
        headRevision: changeNumber,
        files: this.applyFilters(blocks.map((block) => this.toLocalPath(block.depotPath))),
      };
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
      if (isP4RetryableError(error)) {
        throw error;
      }
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
        if (isP4NoSuchFileError(error)) {
          // The file is genuinely gone at this revision (e.g. deleted and
          // re-added later); skipping it is correct.
          console.warn(JSON.stringify({
            level: "warn",
            msg: "p4 print failed: file not found at revision",
            depotPath: `${depotPath}@${revision}`,
            localPath: normalizedPath,
            error: errorText.slice(0, 500),
          }));
          continue;
        }
        // Anything else (network failures after retries, auth, permission)
        // must fail the run visibly instead of yielding a hollow review over
        // missing content.
        throw error;
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

  async fetchAttribution(req: AttributionRequest, ws: WorkspaceRef): Promise<AttributionResult> {
    const workspaceSourceDir = resolve(ws.sourceDir);
    const requestedLocalPath = this.toLocalPath(req.path);
    const normalizedPath = normalizeChangedPath(workspaceSourceDir, requestedLocalPath);
    const depotPath = this.toDepotPrintPath(req.path, normalizedPath);
    const annotateTarget = req.revision ? `${depotPath}@${req.revision}` : depotPath;

    let annotateStdout: string;
    try {
      const result = await this.runP4(["annotate", "-c", annotateTarget]);
      annotateStdout = result.stdout;
    } catch (error) {
      if (isP4NoSuchFileError(error)) {
        return { path: normalizedPath, status: "not_found", entries: [] };
      }
      throw error;
    }

    const annotated = parseP4AnnotateForAttribution(annotateStdout);
    if (annotated.length === 0) {
      return { path: normalizedPath, status: "not_found", entries: [] };
    }

    const uniqueChangelists = Array.from(
      new Set(annotated.map((entry) => entry.revision).filter((value): value is string => Boolean(value))),
    );

    let describeMap: ReadonlyMap<string, P4DescribeAttribution> = new Map();
    if (uniqueChangelists.length > 0) {
      try {
        const describeResult = await this.runP4(["describe", "-s", ...uniqueChangelists]);
        describeMap = parseP4DescribeForAttribution(describeResult.stdout);
      } catch {
        // Best-effort: keep changelist-only attribution and mark partial.
      }
    }

    const merged = annotated.map((entry) => {
      const describe = entry.revision ? describeMap.get(entry.revision) : undefined;
      return buildAttributionEntry({
        line: entry.line,
        revision: entry.revision,
        author: describe?.author,
        summary: describe?.summary,
      });
    });

    const filtered = filterAttributionByLineRange(merged, req.startLine, req.endLine);
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
    const revision = range.headRevision;
    if (!revision) {
      return { files: [] };
    }

    // Batch path (design §6.5/G03): a distinct base changelist means a
    // multi-CL batch. describe -du covers only the single head CL and
    // would drop earlier member CLs, so the net diff must come from the
    // endpoint file revisions via diff2.
    if (range.baseRevision && range.baseRevision !== revision) {
      return this.diffBatch(range.baseRevision, revision, range.files);
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
      if (isP4RetryableError(error)) {
        throw error;
      }
      console.warn(JSON.stringify({
        level: "warn",
        msg: "p4 describe -du failed",
        revision,
        error: getErrorText(error).slice(0, 500),
      }));
      return { files: [] };
    }
  }

  /**
   * Net diff of a batch over the configured depot scope (never `//...`).
   * Enumerate only differing headers with -Od -q; filter candidates before
   * reading per-file hunks or endpoint content. Verified against real p4d:
   * - `path@=N` is rejected ("A revision range cannot be used here"); the
   *   state-as-of-changelist syntax is `path@N`, and `@0` is the empty
   *   depot state before CL1.
   * - Default (non-`-u`) output enumerates every pair with `====` headers,
   *   including add/delete (`<none>` endpoint) and binary pairs; content
   *   differences follow in ed-script form.
   * - `-u` output carries unified hunks only for content-change pairs;
   *   add/delete/binary pairs are omitted entirely, so `-u` can never be
   *   the only source — a batch whose members only add files would
   *   otherwise look like "no changes" (design G03).
   * - Add/delete entries get their hunk synthesized from `p4 print` of the
   *   surviving endpoint revision (design §6: 按已核验动作和端点内容转换);
   *   binary or empty endpoints keep the hunkless header entry.
   * The enumeration is authoritative for both listChanges and the diff file
   * set/actions; per-file -u supplies only the selected text hunks.
   * Missing endpoint CLs, permission-hidden files, and transport failures
   * propagate — a failed batch read must never be mistaken for "no
   * changes".
   */
  private async diffBatch(
    baseRevision: string,
    headRevision: string,
    files: readonly string[],
  ): Promise<ParsedDiff> {
    const allowed = files.length > 0 ? new Set(files.map((file) => this.toLocalPath(file))) : undefined;
    const blocks = (await this.listBatchDiffBlocks(baseRevision, headRevision))
      .filter((block) => !allowed || allowed.has(this.toLocalPath(block.depotPath)));
    const unifiedLines: string[] = [];
    for (const block of blocks) {
      const localPath = this.toLocalPath(block.depotPath);
      if (block.kind === "content") {
        const unified = await this.runP4([
          "diff2", "-u", `${block.depotPath}@${baseRevision}`, `${block.depotPath}@${headRevision}`,
        ]);
        const hunks = parseP4Diff2Unified(unified.stdout, baseRevision, headRevision).get(block.depotPath);
        if (!hunks) {
          throw new Error(
            `p4 diff2 @${baseRevision}..@${headRevision} inconsistency: content pair "${block.depotPath}" missing from -u output.`,
          );
        }
        unifiedLines.push(`diff --git a/${localPath} b/${localPath}`);
        unifiedLines.push(`--- a/${localPath}`);
        unifiedLines.push(`+++ b/${localPath}`);
        unifiedLines.push(...hunks);
        continue;
      }
      if (block.action === "add" || block.action === "delete") {
        const endpointRevision = block.action === "add" ? headRevision : baseRevision;
        const printed = await this.runP4(["print", "-q", `${block.depotPath}@${endpointRevision}`]);
        appendEndpointContentEntry(unifiedLines, localPath, block.action, printed.stdout);
        continue;
      }
      appendSyntheticUnifiedHeaders(unifiedLines, localPath, block.action);
    }
    return this.filterDiffToRange(parseUnifiedDiff(unifiedLines.join("\n")), files);
  }

  private async listBatchDiffBlocks(baseRevision: string, headRevision: string): Promise<P4Diff2Block[]> {
    if (!/^\d+$/u.test(baseRevision) || !/^\d+$/u.test(headRevision)) {
      throw new RangeError(
        `P4 batch diff requires numeric changelist endpoints, got base "${baseRevision}" head "${headRevision}".`,
      );
    }
    const depotBase = this.depot?.replace(/\/+$/u, "");
    if (!depotBase) {
      throw new RangeError(
        "P4 batch diff requires a configured depot scope (options.depot); refusing to diff2 the whole server.",
      );
    }
    const scope = `${depotBase}/...`;
    // A large depot's identical headers alone can exceed maxBuffer. Enumerate
    // differing headers only, then fetch content after candidate filtering.
    const enumerated = await this.runP4(["diff2", "-Od", "-q", `${scope}@${baseRevision}`, `${scope}@${headRevision}`]);
    return parseP4Diff2Pairs(enumerated.stdout, baseRevision, headRevision);
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
        throw new RangeError("path must stay within the configured P4 depot path.");
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

  /**
   * Bounded submitted-changelist metadata read for auto-commit scheduling
   * (design §6.1). The range `(base, head]` (or `(_, head]` without base)
   * is enumerated with one scope-limited `p4 changes -s submitted`, then
   * the page slice is read oldest-first; the cursor carries the last
   * emitted CL so the next page resumes at cursor+1 without overlap. CL
   * numbers are monotonic, so the padded CL is a globally sortable order
   * key. User and Client come from the changelist record itself (never
   * `-u`/`-c` filtered, never substituted); changed paths are an advisory
   * summary from one batched `p4 describe -s` under the byte budget.
   */
  async listCommitMetadataPage(query: CommitMetadataQuery): Promise<CommitMetadataPage> {
    if (!/^\/\//u.test(query.scopeRef)) {
      throw new RangeError(`P4 metadata scope "${query.scopeRef}" must be a depot path (//...).`);
    }
    if (!/^\d+$/u.test(query.headRevision)) {
      throw new RangeError(`P4 metadata headRevision "${query.headRevision}" must be a changelist number.`);
    }
    if (query.baseRevision !== undefined && !/^\d+$/u.test(query.baseRevision)) {
      throw new RangeError(`P4 metadata baseRevision "${query.baseRevision}" must be a changelist number.`);
    }
    if (query.maxRecords < 1) {
      throw new RangeError("P4 metadata maxRecords must be at least 1.");
    }

    let rangeBase = query.baseRevision;
    if (query.cursor !== undefined) {
      if (!/^\d+$/u.test(query.cursor)) {
        throw new RangeError(`Invalid P4 metadata cursor "${query.cursor}".`);
      }
      // Resume after the last emitted CL: the cursor becomes the exclusive
      // lower endpoint, so the next page starts at cursor+1 with no overlap.
      rangeBase = query.cursor;
    }

    if (rangeBase !== undefined && Number(rangeBase) >= Number(query.headRevision)) {
      return { vcs: "p4", records: [], status: "complete" };
    }

    // Real p4d rejects a bare depot path with a revision range
    // ("//depot - must refer to client ... or a depot"); the range needs a
    // wildcard filespec (verified against p4d 2025.1).
    const scopeBase = query.scopeRef.replace(/\/\.\.\.$/u, "").replace(/\/+$/u, "");
    const range = rangeBase !== undefined
      ? `${scopeBase}/...@>${rangeBase},@<=${query.headRevision}`
      : `${scopeBase}/...@<=${query.headRevision}`;

    let listed: P4CommandResult;
    try {
      listed = await this.runP4(["changes", "-s", "submitted", "-m", String(P4_METADATA_ENUM_CAP), range]);
    } catch (error) {
      // Permission-hidden history, unreadable scopes, or transport/auth
      // failures are explicit blockers — never an empty range (design G08).
      return {
        vcs: "p4",
        records: [],
        status: "unavailable",
        unavailableReason: getErrorDiagnosticText(error).slice(0, 500),
      };
    }

    const enumerated = parseP4ChangesMetadata(listed.stdout);
    if (enumerated.length >= P4_METADATA_ENUM_CAP) {
      return {
        vcs: "p4",
        records: [],
        status: "unavailable",
        unavailableReason: `range ${range} exceeds the ${P4_METADATA_ENUM_CAP}-changelist enumeration cap`,
      };
    }
    // p4 changes lists newest-first; the page walks oldest-first.
    enumerated.reverse();
    const pageEntries = enumerated.slice(0, query.maxRecords);

    let pathsByChange: ReadonlyMap<string, readonly string[]> = new Map();
    if (pageEntries.length > 0 && query.maxBytes >= P4_METADATA_MIN_DESCRIBE_BYTES) {
      try {
        const described = await this.runP4(["describe", "-s", ...pageEntries.map((entry) => entry.change)]);
        pathsByChange = parseP4DescribeFilePaths(described.stdout);
      } catch {
        // changedPaths is advisory: a failed describe must not break
        // continuity or the recorded source fields.
      }
    }

    const records: CommitMetadataRecord[] = [];
    let bytes = 0;
    let budgetExhausted = false;
    for (const entry of pageEntries) {
      bytes += 160;
      const paths: string[] = [];
      if (!budgetExhausted) {
        for (const path of pathsByChange.get(entry.change) ?? []) {
          if (bytes + path.length + 16 > query.maxBytes) {
            budgetExhausted = true;
            break;
          }
          bytes += path.length + 16;
          paths.push(path);
        }
      }
      records.push({
        revision: entry.change,
        orderKey: entry.change.padStart(12, "0"),
        parents: [],
        ...(entry.user !== undefined ? { p4User: entry.user } : {}),
        ...(entry.client !== undefined ? { p4Client: entry.client } : {}),
        changedPaths: paths,
      });
    }

    const hasMore = enumerated.length > pageEntries.length;
    const last = records[records.length - 1];
    return {
      vcs: "p4",
      records,
      ...(hasMore && last ? { nextCursor: last.revision } : {}),
      status: hasMore ? "partial" : "complete",
    };
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
