import { describe, expect, it } from "vitest";

import type {
  AttributionEntry,
  AttributionRequest,
  AttributionResult,
  ChangeRange,
  ExtraContextRequest,
  ExtraContextResult,
  ScopedTree,
  VcsAdapter,
  WorkspaceRef,
} from "../src/contracts.js";
import { vcsPackageName } from "../src/index.js";

describe("vcs contracts", () => {
  it("exports the package name", () => {
    expect(vcsPackageName).toBe("@aicr/vcs");
  });

  it("allows constructing a valid ChangeRange", () => {
    const range: ChangeRange = {
      baseRevision: "abc123",
      headRevision: "def456",
      files: ["src/index.ts", "README.md"],
    };

    expect(range.files).toHaveLength(2);
    expect(range.baseRevision).toBe("abc123");
  });

  it("allows constructing a ChangeRange with only files", () => {
    const range: ChangeRange = {
      files: ["src/a.ts"],
    };

    expect(range.baseRevision).toBeUndefined();
    expect(range.headRevision).toBeUndefined();
  });

  it("allows constructing a valid WorkspaceRef", () => {
    const ws: WorkspaceRef = {
      id: "gitea-internal-owent-example",
      sourceDir: "/var/lib/aicr/workspaces/gitea-internal-owent-example/source",
    };

    expect(ws.id).toBe("gitea-internal-owent-example");
  });

  it("allows constructing a valid ScopedTree", () => {
    const tree: ScopedTree = {
      workspaceId: "ws-1",
      rootDir: "/var/lib/aicr/workspaces/ws-1/source",
      fetchedFiles: ["src/a.ts", "src/b.ts"],
    };

    expect(tree.fetchedFiles).toHaveLength(2);
  });

  it("allows constructing a valid ExtraContextRequest", () => {
    const req: ExtraContextRequest = {
      path: "src/auth/login.ts",
      startLine: 10,
      endLine: 50,
      reason: "agent requested more context for auth flow",
    };

    expect(req.startLine).toBe(10);
    expect(req.endLine).toBe(50);
  });

  it("allows constructing an ExtraContextRequest with only required fields", () => {
    const req: ExtraContextRequest = {
      path: "src/index.ts",
      reason: "review scope",
    };

    expect(req.startLine).toBeUndefined();
    expect(req.endLine).toBeUndefined();
  });

  it("allows constructing a valid ExtraContextResult", () => {
    const result: ExtraContextResult = {
      path: "src/auth/login.ts",
      content: "export function login() { ... }",
    };

    expect(result.content).toContain("login");
  });

  it("allows constructing a valid AttributionRequest", () => {
    const req: AttributionRequest = {
      path: "src/auth/login.ts",
      startLine: 10,
      endLine: 50,
      revision: "def456",
      reason: "agent requested authorship for auth flow",
    };

    expect(req.startLine).toBe(10);
    expect(req.revision).toBe("def456");
  });

  it("allows constructing an AttributionRequest with only required fields", () => {
    const req: AttributionRequest = {
      path: "src/index.ts",
      reason: "attribution for whole file",
    };

    expect(req.startLine).toBeUndefined();
    expect(req.endLine).toBeUndefined();
    expect(req.revision).toBeUndefined();
  });

  it("allows constructing AttributionEntry and AttributionResult with best-effort fields", () => {
    const entry: AttributionEntry = {
      line: 12,
      revision: "abc123",
      author: "alice",
      authorEmail: "alice@example.com",
      summary: "fix login flow",
    };

    expect(entry.author).toBe("alice");

    const partial: AttributionEntry = { line: 13 };
    expect(partial.revision).toBeUndefined();

    const result: AttributionResult = {
      path: "src/auth/login.ts",
      status: "partial",
      entries: [entry, partial],
    };

    expect(result.status).toBe("partial");
    expect(result.entries).toHaveLength(2);
  });

  it("supports all VcsAdapter kind values defined in Plan.md §3.2", () => {
    const kinds: VcsAdapter["kind"][] = [
      "git",
      "svn",
      "p4",
      "github",
      "gitlab",
      "gitea",
      "forgejo",
    ];

    expect(kinds).toHaveLength(7);
  });

  it("allows implementing a mock VcsAdapter that satisfies the interface", () => {
    const mockAdapter: VcsAdapter = {
      kind: "git",
      listChanges: async () => ({
        baseRevision: "base",
        headRevision: "head",
        files: ["src/a.ts"],
      }),
      fetchScoped: async (_range, ws) => ({
        workspaceId: ws.id,
        rootDir: ws.sourceDir,
        fetchedFiles: ["src/a.ts"],
      }),
      fetchExtraContext: async (req) => ({
        path: req.path,
        content: "extra context content",
      }),
    };

    expect(mockAdapter.kind).toBe("git");
    expect(typeof mockAdapter.listChanges).toBe("function");
    expect(typeof mockAdapter.fetchScoped).toBe("function");
    expect(typeof mockAdapter.fetchExtraContext).toBe("function");
  });

  it("does not require fetchAttribution on a mock VcsAdapter (best-effort attribution)", () => {
    const mockAdapter: VcsAdapter = {
      kind: "github",
      listChanges: async () => ({ files: [] }),
      fetchScoped: async (_range, ws) => ({
        workspaceId: ws.id,
        rootDir: ws.sourceDir,
        fetchedFiles: [],
      }),
      fetchExtraContext: async (req) => ({ path: req.path, content: "" }),
    };

    expect(mockAdapter.fetchAttribution).toBeUndefined();
  });

  it("allows implementing fetchAttribution on a mock VcsAdapter", async () => {
    const mockAdapter: VcsAdapter = {
      kind: "git",
      listChanges: async () => ({ files: [] }),
      fetchScoped: async (_range, ws) => ({
        workspaceId: ws.id,
        rootDir: ws.sourceDir,
        fetchedFiles: [],
      }),
      fetchExtraContext: async (req) => ({ path: req.path, content: "" }),
      fetchAttribution: async (req) => ({
        path: req.path,
        status: "ok",
        entries: [{ line: 1, revision: "abc", author: "alice" }],
      }),
    };

    const result = await mockAdapter.fetchAttribution(
      { path: "src/a.ts", reason: "test" },
      { id: "ws", sourceDir: "/tmp/ws/source" },
    );

    expect(result.status).toBe("ok");
    expect(result.entries[0]?.author).toBe("alice");
  });
});
