import type { AgentSpawnMcpServer } from "./types.js";

interface CanonicalLocalServer {
  readonly type: "local";
  readonly command: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

interface CanonicalRemoteServer {
  readonly type: "remote";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function asLocal(config: Readonly<Record<string, unknown>>): CanonicalLocalServer | undefined {
  if (config.type !== "local" || !Array.isArray(config.command)) return undefined;
  const [executable] = config.command;
  if (
    typeof executable !== "string" ||
    executable.trim().length === 0 ||
    !config.command.every((part): part is string => typeof part === "string") ||
    (config.environment !== undefined && !isStringRecord(config.environment))
  ) {
    return undefined;
  }
  const command = config.command;
  const environment = config.environment;
  return { type: "local", command, ...(environment ? { environment } : {}) };
}

function asRemote(config: Readonly<Record<string, unknown>>): CanonicalRemoteServer | undefined {
  if (
    config.type !== "remote" ||
    typeof config.url !== "string" ||
    config.url.trim().length === 0 ||
    (config.headers !== undefined && !isStringRecord(config.headers))
  ) {
    return undefined;
  }
  const headers = config.headers;
  return { type: "remote", url: config.url, ...(headers ? { headers } : {}) };
}

/**
 * Converts the canonical kilo/opencode MCP server config into the Claude Code shape
 * used by `--mcp-config` / `.mcp.json`: local servers become `stdio` entries with a
 * string command plus args array; remote servers become `http` entries.
 * Verified against code.claude.com/docs/en/cli-reference (2026-08).
 */
export function toClaudeCodeMcpServersJson(
  servers: readonly AgentSpawnMcpServer[],
): string | undefined {
  const converted: Record<string, unknown> = {};
  for (const server of servers) {
    const local = asLocal(server.config);
    if (local) {
      converted[server.name] = {
        type: "stdio",
        command: local.command[0],
        args: local.command.slice(1),
        ...(local.environment ? { env: local.environment } : {}),
      };
      continue;
    }
    const remote = asRemote(server.config);
    if (remote) {
      converted[server.name] = {
        type: "http",
        url: remote.url,
        ...(remote.headers ? { headers: remote.headers } : {}),
      };
    }
  }
  if (Object.keys(converted).length === 0) return undefined;
  return JSON.stringify({ mcpServers: converted });
}

/**
 * Converts the canonical MCP server config into the oh-my-pi shape used by
 * `~/.omp/agent/mcp.json` (resolved through PI_CODING_AGENT_DIR): local servers
 * become `stdio` entries with a string command plus args array; remote servers
 * become `http` entries. Verified against omp docs/mcp-config.md (2026-08).
 */
export function toOhMyPiMcpServersJson(
  servers: readonly AgentSpawnMcpServer[],
): string | undefined {
  const converted: Record<string, unknown> = {};
  for (const server of servers) {
    const local = asLocal(server.config);
    if (local) {
      converted[server.name] = {
        command: local.command[0],
        args: local.command.slice(1),
        ...(local.environment ? { env: local.environment } : {}),
      };
      continue;
    }
    const remote = asRemote(server.config);
    if (remote) {
      converted[server.name] = {
        type: "http",
        url: remote.url,
        ...(remote.headers ? { headers: remote.headers } : {}),
      };
    }
  }
  if (Object.keys(converted).length === 0) return undefined;
  return JSON.stringify({ mcpServers: converted });
}
/**
 * Converts the canonical MCP server config into the GitHub Copilot CLI shape used by
 * `--additional-mcp-config` and mcp-config.json: local servers keep the `local` type
 * with a string command plus args array and default to all tools exposed.
 * Verified against docs.github.com Copilot CLI reference (2026-08).
 */
export function toCopilotCliMcpServersJson(
  servers: readonly AgentSpawnMcpServer[],
): string | undefined {
  const converted: Record<string, unknown> = {};
  for (const server of servers) {
    const local = asLocal(server.config);
    if (local) {
      converted[server.name] = {
        type: "local",
        command: local.command[0],
        args: local.command.slice(1),
        tools: ["*"],
        ...(local.environment ? { env: local.environment } : {}),
      };
      continue;
    }
    const remote = asRemote(server.config);
    if (remote) {
      converted[server.name] = {
        type: "http",
        url: remote.url,
        tools: ["*"],
        ...(remote.headers ? { headers: remote.headers } : {}),
      };
    }
  }
  if (Object.keys(converted).length === 0) return undefined;
  return JSON.stringify({ mcpServers: converted });
}
