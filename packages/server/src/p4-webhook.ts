import { createReviewEvent, type ReviewEvent } from "@aicr/core";
import { z } from "zod";

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
    client: z.string().optional(),
    description: z.string().optional(),
    path: z.string().optional(),
    depot_path: z.string().optional(),
    files: z.array(z.string()).optional(),
    status: z.string().optional(),
    old_change: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export function translateP4TriggerToReviewEvent(
  payload: unknown,
  config: P4TriggerConfig,
): ReviewEvent | null {
  const parsed = p4TriggerPayloadSchema.parse(payload);
  const changeNumber = String(parsed.change ?? parsed.changelist ?? parsed.cl ?? "");
  const user = parsed.user ?? "";
  const client = parsed.client ?? "";
  const _description = parsed.description ?? "";
  const depotPath = parsed.depot_path || parsed.path || config.depot || "";
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
      displayName: client || undefined,
    },
    url: depotPath ? `p4://${depotPath.replace(/^\/\//u, "")}@${changeNumber}` : undefined,
    reason: `p4:change-commit:${changeNumber}`,
    rawEventName: "change-commit",
    depotPath: depotPath || undefined,
    ...(config.workspace ? { p4Workspace: config.workspace } : {}),
  });
}
