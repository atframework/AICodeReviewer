import type { ReviewEvent } from "@aicr/core";

export interface ChangeRange {
  readonly baseRevision?: string;
  readonly headRevision?: string;
  readonly files: readonly string[];
}

export interface WorkspaceRef {
  readonly id: string;
  readonly sourceDir: string;
}

export interface ScopedTree {
  readonly workspaceId: string;
  readonly rootDir: string;
  readonly fetchedFiles: readonly string[];
}

export interface ExtraContextRequest {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly revision?: string;
  readonly reason: string;
}

export interface ExtraContextResult {
  readonly path: string;
  readonly content: string;
}

export interface AttributionRequest {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly revision?: string;
  readonly reason: string;
}

export interface AttributionEntry {
  readonly line: number;
  readonly revision?: string;
  readonly author?: string;
  readonly authorEmail?: string;
  readonly summary?: string;
}

export type AttributionStatus = "ok" | "not_found" | "partial";

export interface AttributionResult {
  readonly path: string;
  readonly status: AttributionStatus;
  readonly entries: readonly AttributionEntry[];
}

export interface VcsAdapter {
  readonly kind: "git" | "svn" | "p4" | "github" | "gitlab" | "gitea" | "forgejo";
  listChanges(ev: ReviewEvent): Promise<ChangeRange>;
  fetchScoped(range: ChangeRange, ws: WorkspaceRef): Promise<ScopedTree>;
  fetchExtraContext(req: ExtraContextRequest, ws: WorkspaceRef): Promise<ExtraContextResult>;
  fetchAttribution?(req: AttributionRequest, ws: WorkspaceRef): Promise<AttributionResult>;
}