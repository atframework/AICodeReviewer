import { createReviewEvent, type ReviewEvent } from "@aicr/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export interface P4TriggerConfig {
  readonly triggerName: string;
  readonly workspaceId: string;
  readonly port?: string;
  readonly user?: string;
  readonly password?: string;
  readonly depot?: string;
  readonly workspace?: string;
  readonly watchPath?: readonly string[];
  readonly includeCrFile?: readonly string[];
  readonly excludeCrFile?: readonly string[];
}

const p4TriggerPayloadSchema = z
  .object({
    change: z.union([z.string(), z.number()]).optional(),
    changelist: z.union([z.string(), z.number()]).optional(),
    cl: z.union([z.string(), z.number()]).optional(),
    user: z.string().optional(),
    username: z.string().optional(),
    submitter: z.string().optional(),
    p4_user: z.string().optional(),
    client: z.string().optional(),
    submitter_client: z.string().optional(),
    p4_client: z.string().optional(),
    description: z.string().optional(),
    path: z.string().optional(),
    depot_path: z.string().optional(),
    files: z.array(z.string()).optional(),
    status: z.string().optional(),
    old_change: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return "";
}

function buildP4Args(config: P4TriggerConfig): string[] {
  const args: string[] = [];
  if (config.port) {
    args.push("-p", config.port);
  }
  if (config.user) {
    args.push("-u", config.user);
  }
  if (config.workspace) {
    args.push("-c", config.workspace);
  }

  return args;
}

function buildP4Env(config: P4TriggerConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (config.password) {
    env.P4PASSWD = config.password;
  }

  return env;
}

export function translateP4TriggerToReviewEvent(
  payload: unknown,
  config: P4TriggerConfig,
): ReviewEvent | null {
  const parsed = p4TriggerPayloadSchema.parse(payload);
  const changeNumber = String(parsed.change ?? parsed.changelist ?? parsed.cl ?? "");
  const user = firstNonEmpty(parsed.user, parsed.username, parsed.submitter, parsed.p4_user);
  const submitterWorkspace = firstNonEmpty(parsed.client, parsed.submitter_client, parsed.p4_client);
  const _description = parsed.description ?? "";
  const depotPath = firstNonEmpty(parsed.depot_path, parsed.path, config.depot);
  const changedFiles = parsed.files ?? [];

  if (!changeNumber) {
    return null;
  }

  return createReviewEvent({
    triggerName: config.triggerName,
    provider: "p4",
    workspaceId: config.workspaceId,
    targetKind: "commit",
    repoRef: depotPath || config.depot || `p4-${config.triggerName}`,
    baseSha: parsed.old_change ? String(parsed.old_change) : undefined,
    headSha: changeNumber,
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    author: {
      username: user || undefined,
    },
    url: depotPath ? `p4://${depotPath.replace(/^\/\//u, "")}@${changeNumber}` : undefined,
    reason: `p4:change-commit:${changeNumber}`,
    rawEventName: "change-commit",
    sourcePath: depotPath || undefined,
    ...(submitterWorkspace ? { submitterWorkspace } : {}),
  });
}

export type P4DescribeRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string }>;

async function defaultP4DescribeRunner(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync("p4", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env,
  });

  return { stdout };
}

export async function enrichP4ReviewEvent(
  event: ReviewEvent,
  config: P4TriggerConfig,
  runner: P4DescribeRunner = defaultP4DescribeRunner,
): Promise<ReviewEvent> {
  const needsAuthor = !event.author?.username;
  const needsWorkspace = event.submitterWorkspace === undefined;

  if (!needsAuthor && !needsWorkspace) {
    return event;
  }

  if (!event.headSha) {
    return event;
  }

  if (!config.port && !config.user && !config.password && !config.workspace) {
    return event;
  }

  const args = [...buildP4Args(config), "describe", "-s", event.headSha];

  try {
    const { stdout } = await runner(args, buildP4Env(config));

    const firstLine = stdout.split(/\r?\n/u)[0] ?? "";
    const match = /^Change \d+ by ([^@]+)@(\S+)/u.exec(firstLine);

    if (match) {
      const username = match[1];
      const client = match[2];

      if (needsAuthor && username) {
        event = createReviewEvent({
          ...event,
          author: {
            ...event.author,
            username,
          },
        });
      }

      if (needsWorkspace && client) {
        event = createReviewEvent({
          ...event,
          submitterWorkspace: client,
        });
      }
    }
  } catch {
    // Fallback query failed; keep the original event.
  }

  return event;
}
