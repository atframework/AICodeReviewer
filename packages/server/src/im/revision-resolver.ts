import type { VcsAdapter } from "@aicr/vcs";

/**
 * IM-13 fixed-revision resolver (design §7.2, acceptance V01–V08): validates
 * that a requested revision is a complete, immutable commit object within the
 * authorized repository's reachable range, and returns trusted metadata
 * (author, timestamps, URLs). Floating refs (branch/tag/HEAD), short SHAs,
 * ranges, and non-commit objects are rejected — the target is fixed before
 * any LLM or workspace work begins.
 */

export interface ResolvedImRevision {
  readonly revision: string;
  readonly baseRevision: string | null;
  readonly author: { readonly username?: string | undefined; readonly email?: string | undefined };
  readonly title: string | undefined;
  readonly url: string | undefined;
  readonly committedAt: string | undefined;
}

export type ImRevisionResolution =
  | { readonly kind: "resolved"; readonly revision: ResolvedImRevision }
  | { readonly kind: "rejected"; readonly reason: "invalid_format" | "not_found" | "not_commit" | "metadata_unavailable" };

const GIT_FULL_SHA_RE = /^[0-9a-fA-F]{40}$/u;
const GIT_FULL_SHA256_RE = /^[0-9a-fA-F]{64}$/u;
const SVN_REVISION_RE = /^[0-9]+$/u;
const P4_CHANGELIST_RE = /^[0-9]+$/u;

/**
 * Validates the revision format per VCS family before any I/O:
 * Git requires a complete 40/64-hex object ID; SVN and P4 accept canonical
 * positive decimal integers. Sign, whitespace and range expressions are
 * rejected outright (never silently resolved by the adapter).
 */
export function validateRevisionFormat(vcsKind: string, revision: string): boolean {
  if (vcsKind === "git" || vcsKind === "github" || vcsKind === "gitlab" || vcsKind === "gitea" || vcsKind === "forgejo") {
    return GIT_FULL_SHA_RE.test(revision) || GIT_FULL_SHA256_RE.test(revision);
  }
  if (vcsKind === "svn") return SVN_REVISION_RE.test(revision) && Number.parseInt(revision, 10) > 0;
  if (vcsKind === "p4") return P4_CHANGELIST_RE.test(revision) && Number.parseInt(revision, 10) > 0;
  return false;
}

/**
 * Resolves a fixed revision through the trusted VCS adapter. The adapter's
 * `describeSource` provides immutable metadata; the base revision for
 * non-merge commits is the first parent (V02).
 */
export async function resolveImRevision(adapter: VcsAdapter, revision: string): Promise<ImRevisionResolution> {
  if (!validateRevisionFormat(adapter.kind, revision)) {
    return { kind: "rejected", reason: "invalid_format" };
  }

  // Canonicalize Git to lowercase (V01: the adapter may accept mixed case,
  // but the stored target must be normalized).
  const normalized = adapter.kind === "git" || adapter.kind === "github" || adapter.kind === "gitlab" || adapter.kind === "gitea" || adapter.kind === "forgejo"
    ? revision.toLowerCase()
    : revision;

  if (adapter.describeSource === undefined) {
    return { kind: "rejected", reason: "metadata_unavailable" };
  }

  let metadata: Readonly<Record<string, string | null>>;
  try {
    metadata = await adapter.describeSource(normalized);
  } catch {
    return { kind: "rejected", reason: "not_found" };
  }

  // The adapter returning no trusted descriptor means the object does not
  // exist or is not reachable within the authorized scope. Each family has
  // its own descriptor shape: Git commits carry author/title fields, P4
  // carries the submitted-changelist descriptor (status "submitted" is
  // enforced by the adapter), SVN carries the repository identity.
  const gitFamily = adapter.kind === "git" || adapter.kind === "github" || adapter.kind === "gitlab" || adapter.kind === "gitea" || adapter.kind === "forgejo";
  const hasTrustedDescriptor = gitFamily
    ? "author_name" in metadata || "author_username" in metadata || "title" in metadata
    : adapter.kind === "p4"
      ? "change" in metadata
      : adapter.kind === "svn"
        ? "repository_url" in metadata || "repository_uuid" in metadata
        : false;
  if (!hasTrustedDescriptor) {
    return { kind: "rejected", reason: "not_found" };
  }

  const baseRevision = metadata.base_revision ?? null;
  const resolved: ResolvedImRevision = {
    revision: normalized,
    baseRevision: baseRevision !== null && baseRevision !== undefined ? String(baseRevision) : null,
    author: {
      // Trusted author per family (V03/V05): Git descriptors carry
      // author_name/author_email, P4 records the submitter as user, SVN's
      // `svn info` descriptor carries repository identity only.
      ...(metadata.author_username !== undefined && metadata.author_username !== null ? { username: String(metadata.author_username) }
        : metadata.author_name !== undefined && metadata.author_name !== null ? { username: String(metadata.author_name) }
          : adapter.kind === "p4" && metadata.user !== undefined && metadata.user !== null ? { username: String(metadata.user) }
            : {}),
      ...(metadata.author_email !== undefined && metadata.author_email !== null ? { email: String(metadata.author_email) } : {}),
    },
    title: metadata.title !== undefined && metadata.title !== null ? String(metadata.title) : undefined,
    url: metadata.url !== undefined && metadata.url !== null ? String(metadata.url) : undefined,
    committedAt: adapter.fetchRevisionCommittedAt !== undefined
      ? await adapter.fetchRevisionCommittedAt(normalized).catch(() => undefined)
      : undefined,
  };
  return { kind: "resolved", revision: resolved };
}
