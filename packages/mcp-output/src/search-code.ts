import { spawn } from "node:child_process";

/**
 * `aicr.search_code` — indexed repository search backed by tgrep.
 *
 * Shared by the MCP server process (external agent CLIs) and the in-process
 * tool registry (native-llm path), so both agents get identical search
 * behavior. The index itself is owned by the AICR server (per-workspace
 * persistent cache, refreshed on revision change / TTL, swept when unused);
 * this module only executes bounded read-only queries against it.
 *
 * tgrep binary and index are optional: when they are unavailable the tool
 * returns a degraded message instead of throwing, and the review prompt tells
 * the agent to fall back to `rg`.
 */

export const TGREP_INDEX_DIR_ENV = "AICR_TGREP_INDEX_DIR";
export const TGREP_SOURCE_DIR_ENV = "AICR_TGREP_SOURCE_DIR";

export interface SearchCodeInput {
  /** Regular expression (tgrep/ripgrep syntax). */
  readonly pattern: string;
  /** Optional glob restricting matched files (e.g. "*.rs"). */
  readonly path_glob?: string;
  readonly case_insensitive?: boolean;
  /** Maximum matches returned; default 50, hard cap 200. */
  readonly max_results?: number;
}

export interface SearchCodeOptions {
  readonly indexDir: string;
  readonly sourceDir: string;
  readonly timeoutMs?: number;
  readonly spawnProcess?: typeof spawn;
}

export type SearchCodeHandler = (input: SearchCodeInput) => Promise<string>;

export const searchCodeInputSchema = {
  type: "object",
  required: ["pattern"],
  properties: {
    pattern: { type: "string" },
    path_glob: { type: "string" },
    case_insensitive: { type: "boolean" },
    max_results: { type: "integer", minimum: 1, maximum: 200 },
  },
} as const;

export function parseSearchCodeInput(input: unknown): SearchCodeInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("aicr.search_code input must be an object.");
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.pattern !== "string" || raw.pattern.trim().length === 0) {
    throw new TypeError("aicr.search_code pattern must be a non-empty string.");
  }
  if (raw.pattern.length > 500) {
    throw new TypeError(
      "aicr.search_code pattern must not exceed 500 characters.",
    );
  }
  if (
    raw.path_glob !== undefined &&
    (typeof raw.path_glob !== "string" || raw.path_glob.length === 0)
  ) {
    throw new TypeError(
      "aicr.search_code path_glob must be a non-empty string.",
    );
  }
  if (
    raw.case_insensitive !== undefined &&
    typeof raw.case_insensitive !== "boolean"
  ) {
    throw new TypeError("aicr.search_code case_insensitive must be a boolean.");
  }
  let maxResults: number | undefined;
  if (raw.max_results !== undefined) {
    if (
      !Number.isInteger(raw.max_results) ||
      Number(raw.max_results) < 1 ||
      Number(raw.max_results) > 200
    ) {
      throw new TypeError(
        "aicr.search_code max_results must be an integer in 1..200.",
      );
    }
    maxResults = Number(raw.max_results);
  }
  return {
    pattern: raw.pattern,
    ...(typeof raw.path_glob === "string" ? { path_glob: raw.path_glob } : {}),
    ...(typeof raw.case_insensitive === "boolean"
      ? { case_insensitive: raw.case_insensitive }
      : {}),
    ...(maxResults !== undefined ? { max_results: maxResults } : {}),
  };
}

/** Hard output bound: matches are line-oriented; keep the prompt budget safe. */
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

function capOutput(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  const truncated = Buffer.from(text, "utf8")
    .subarray(0, MAX_OUTPUT_BYTES)
    .toString("utf8");
  return `${truncated}\n… output truncated at ${MAX_OUTPUT_BYTES} bytes; narrow the pattern or path_glob.`;
}

/**
 * Execute one bounded tgrep query. Returns the raw matches, a "(no matches)"
 * marker, or a degraded guidance string when tgrep/index is unavailable.
 * Never throws for environment failures — search must not fail a review.
 */
export async function executeTgrepSearch(
  input: SearchCodeInput,
  options: SearchCodeOptions,
): Promise<string> {
  const args = [
    "--index-path",
    options.indexDir,
    "--heading",
    "--max-count",
    String(Math.min(input.max_results ?? 50, 200)),
    ...(input.case_insensitive ? ["--ignore-case"] : []),
    ...(input.path_glob ? ["--glob", input.path_glob] : []),
    "--",
    input.pattern,
    options.sourceDir,
  ];
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (text: string): void => {
      if (!settled) {
        settled = true;
        resolve(text);
      }
    };
    let child;
    try {
      child = (options.spawnProcess ?? spawn)("tgrep", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(
        "tgrep is unavailable in this environment; use `rg` on the materialized files instead.",
      );
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        "tgrep search timed out; narrow the pattern or use `rg` on the materialized files.",
      );
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES * 2) {
        child.kill("SIGKILL");
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(
        "tgrep is unavailable in this environment; use `rg` on the materialized files instead.",
      );
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish(stdout.trim().length > 0 ? capOutput(stdout) : "(no matches)");
        return;
      }
      if (code === 1 && stdout.trim().length === 0) {
        finish("(no matches)");
        return;
      }
      finish(
        `tgrep search failed (${stderr.trim().split("\n")[0] ?? `exit ${code}`}); use \`rg\` on the materialized files instead.`,
      );
    });
  });
}

/** Resolve the handler from process env (MCP server side) or undefined. */
export function searchCodeHandlerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SearchCodeHandler | undefined {
  const indexDir = env[TGREP_INDEX_DIR_ENV];
  const sourceDir = env[TGREP_SOURCE_DIR_ENV];
  if (!indexDir || !sourceDir) return undefined;
  return (input) => executeTgrepSearch(input, { indexDir, sourceDir });
}
