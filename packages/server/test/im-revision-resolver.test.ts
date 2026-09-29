import { describe, expect, it } from "vitest";
import type { VcsAdapter } from "@aicr/vcs";

import { resolveImRevision, validateRevisionFormat } from "../src/im/revision-resolver.js";

/**
 * IM-13 acceptance V01/V04/V08 share: format validation per VCS family and
 * resolution through a trusted adapter mock. Git end-to-end with real
 * repositories runs in the VCS adapter suites.
 */

const GIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const GIT_SHA_UPPER = GIT_SHA.toUpperCase();
const GIT_SHA256 = "a".repeat(64); // SHA-256 full hex

function adapterFor(kind: string, metadata?: Record<string, string | null>): VcsAdapter {
  return {
    kind: kind as VcsAdapter["kind"],
    listChanges: async () => { throw new Error("not used"); },
    ...(metadata !== undefined ? { describeSource: async () => metadata } : {}),
    fetchRevisionCommittedAt: async () => "2026-09-28T00:00:00Z",
  } as VcsAdapter;
}

describe("V01: revision format validation", () => {
  it("accepts complete Git SHA-1 and SHA-256, rejects floating/short/range", () => {
    expect(validateRevisionFormat("git", GIT_SHA)).toBe(true);
    expect(validateRevisionFormat("git", GIT_SHA256)).toBe(true);
    expect(validateRevisionFormat("github", GIT_SHA)).toBe(true);
    expect(validateRevisionFormat("gitlab", GIT_SHA)).toBe(true);

    expect(validateRevisionFormat("git", "HEAD")).toBe(false);
    expect(validateRevisionFormat("git", "main")).toBe(false);
    expect(validateRevisionFormat("git", GIT_SHA.slice(0, 7))).toBe(false);
    expect(validateRevisionFormat("git", `${GIT_SHA}..${GIT_SHA}`)).toBe(false);
    expect(validateRevisionFormat("git", `-${GIT_SHA}`)).toBe(false);
    expect(validateRevisionFormat("git", ` ${GIT_SHA}`)).toBe(false);
    expect(validateRevisionFormat("git", GIT_SHA.toUpperCase())).toBe(true); // hex is case-insensitive at format level
  });

  it("accepts canonical SVN/P4 revisions, rejects zero/negative/floating", () => {
    expect(validateRevisionFormat("svn", "123")).toBe(true);
    expect(validateRevisionFormat("svn", "r123")).toBe(false); // design says rN is stripped by the store
    expect(validateRevisionFormat("svn", "0")).toBe(false);
    expect(validateRevisionFormat("svn", "HEAD")).toBe(false);
    expect(validateRevisionFormat("p4", "456")).toBe(true);
    expect(validateRevisionFormat("p4", "-1")).toBe(false);
  });
});

describe("V04/V05: resolution through the trusted adapter", () => {
  it("resolves a Git commit with full metadata and normalizes to lowercase", async () => {
    const adapter = adapterFor("git", {
      author_username: "alice-dev",
      author_email: "alice@example.invalid",
      title: "feat: add feature",
      url: "https://github.com/org/service/commit/" + GIT_SHA,
      base_revision: "fedcba9876543210fedcba9876543210fedcba98",
    });
    const result = await resolveImRevision(adapter, GIT_SHA_UPPER);
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.revision.revision).toBe(GIT_SHA); // normalized lowercase
    expect(result.revision.author.username).toBe("alice-dev");
    expect(result.revision.title).toBe("feat: add feature");
    expect(result.revision.baseRevision).toBe("fedcba9876543210fedcba9876543210fedcba98");
    expect(result.revision.committedAt).toBe("2026-09-28T00:00:00Z");
  });

  it("rejects invalid formats, missing objects and unavailable metadata", async () => {
    expect((await resolveImRevision(adapterFor("git", {}), "HEAD")).kind).toBe("rejected");
    expect((await resolveImRevision(adapterFor("git", { title: "x" }), "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).kind).toBe("rejected");
    expect((await resolveImRevision(adapterFor("git"), GIT_SHA)).kind).toBe("rejected"); // no describeSource
  });
});
