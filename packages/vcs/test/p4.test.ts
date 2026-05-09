import { describe, it, expect } from "vitest";

import { createReviewEvent, type ReviewEvent } from "@aicr/core";

import { createP4VcsAdapter, P4VcsAdapter, type P4CommandResult, type P4CommandRunner } from "../src/p4.js";
import type { ChangeRange } from "../src/contracts.js";

function createMockP4Runner(responses: Record<string, P4CommandResult>) {
  return async (args: readonly string[]): Promise<P4CommandResult> => {
    const key = args.join(" ");
    for (const [pattern, result] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        return result;
      }
    }
    return { stdout: "", stderr: "" };
  };
}

function makeEvent(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
  return createReviewEvent({
    triggerName: "p4-main",
    provider: "p4",
    workspaceId: "p4-workspace",
    targetKind: "commit",
    repoRef: "//depot/main",
    headSha: "12345",
    reason: "p4:change-commit:12345",
    author: { username: "testuser" },
    ...overrides,
  });
}

const describeOutput = `Change 12345 by testuser@testclient on 2026/05/07 10:00:00

\tTest commit

Affected files ...

... //depot/main/src/foo.cpp#2 edit
... //depot/main/src/bar.h#1 add
... //depot/main/README.md#3 delete
`;

const _printOutput = `//depot/main/src/foo.cpp#2 - edit change 12345 (text)
#include <iostream>
int main() { return 0; }
`;

const _diffOutputOldStyle = `Change 12345 by testuser@testclient on 2026/05/07 10:00:00

\tTest commit

Affected files ...

... //depot/main/src/foo.cpp#2 edit

==== //depot/main/src/foo.cpp#2 (text) ====

4c4
< old line
---
> new line
`;

const diffOutputUnified = `Change 12345 by testuser@testclient on 2026/05/07 10:00:00

\tTest commit

Affected files ...

... //depot/main/src/foo.cpp#2 edit

==== //depot/main/src/foo.cpp#2 (text) ====

--- //depot/main/src/foo.cpp#2\t2026/05/07 09:55:00
+++ //depot/main/src/foo.cpp#2\t2026/05/07 10:00:00
@@ -4,1 +4,1 @@
 old line
-old line
+new line
`;

const diffOutputMultiFile = `Change 12345 by testuser@testclient on 2026/05/07 10:00:00

\tTest commit

Affected files ...

... //depot/main/src/foo.cpp#2 edit
... //depot/main/src/bar.h#1 add

==== //depot/main/src/foo.cpp#2 (text) ====

--- //depot/main/src/foo.cpp#2\t2026/05/07 09:55:00
+++ //depot/main/src/foo.cpp#2\t2026/05/07 10:00:00
@@ -1,3 +1,3 @@
 #include <iostream>
-int main() { return 1; }
+int main() { return 0; }
 // end

==== //depot/main/src/bar.h#1 (text) ====

--- //dev/null\t1970-01-01 00:00:00
+++ //depot/main/src/bar.h\t2026/05/07 10:00:00
@@ -0,0 +1,5 @@
+#pragma once
+struct Bar {
+    int x;
+    int y;
+};
`;

const diffOutputP4NativeUnified = `Change 12345 by testuser@testclient on 2026/05/07 10:00:00

  Test commit

Affected files ...

... //depot/main/src/foo.cpp#2 edit
... //depot/main/src/bar.h#1 add
... //depot/main/src/skip.cs#2 edit

==== //depot/main/src/foo.cpp#2 (text+C) ====
@@ -1,2 +1,3 @@
 context
-old value
+new value
+extra value

==== //depot/main/src/bar.h#1 (text) ====
@@ -0,0 +1,2 @@
+#pragma once
+void bar();

==== //depot/main/src/skip.cs#2 (text) ====
@@ -1,1 +1,1 @@
-old
+new
`;

describe("P4VcsAdapter", () => {
  describe("constructor", () => {
    it("creates adapter with required options", () => {
      const adapter = createP4VcsAdapter({ repositoryDir: "/tmp/test" });
      expect(adapter.kind).toBe("p4");
    });

    it("creates adapter with all options", () => {
      const adapter = createP4VcsAdapter({
        repositoryDir: "/tmp/test",
        port: "perforce:1666",
        user: "testuser",
        password: "testpass",
        workspace: "test-ws",
        depot: "//depot/main",
        watchPath: ["src/"],
        includeCrFile: ["**/*.cpp"],
        excludeCrFile: ["**/*.gen.cpp"],
      });
      expect(adapter.kind).toBe("p4");
    });
  });

  describe("listChanges", () => {
    it("returns changed files from describe output", async () => {
      const mockP4 = createMockP4Runner({
        "describe -s 12345": { stdout: describeOutput, stderr: "" },
      });
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        p4: mockP4,
      });

      const range = await adapter.listChanges(makeEvent());
      expect(range.headRevision).toBe("12345");
      expect(range.files).toContain("src/foo.cpp");
      expect(range.files).toContain("src/bar.h");
      expect(range.files).toContain("README.md");
    });

    it("uses event changedFiles when describe fails", async () => {
      const mockP4 = createMockP4Runner({});
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        p4: mockP4,
      });

      const range = await adapter.listChanges(
        makeEvent({ changedFiles: ["src/a.cpp", "src/b.cpp"] }),
      );
      expect(range.files).toEqual(["src/a.cpp", "src/b.cpp"]);
    });

    it("converts depot paths from trigger changedFiles before filtering", async () => {
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        watchPath: ["src/"],
        includeCrFile: ["**/*.cpp"],
        p4: createMockP4Runner({}),
      });

      const range = await adapter.listChanges(
        makeEvent({ changedFiles: ["//depot/main/src/a.cpp", "//depot/main/docs/readme.md"] }),
      );

      expect(range.files).toEqual(["src/a.cpp"]);
    });

    it("filters files by include patterns", async () => {
      const mockP4 = createMockP4Runner({
        "describe -s 12345": { stdout: describeOutput, stderr: "" },
      });
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        includeCrFile: ["**/*.cpp"],
        p4: mockP4,
      });

      const range = await adapter.listChanges(makeEvent());
      expect(range.files).toEqual(["src/foo.cpp"]);
    });

    it("matches slashless include and exclude patterns against basenames at any depth", async () => {
      const mockP4 = createMockP4Runner({
        "describe -s 12345": {
          stdout: `Change 12345 by testuser@testclient on 2026/05/07 10:00:00

Affected files ...

... //depot/main/Client/Projects/Prx/Source/Foo.cpp#2 edit
... //depot/main/Client/Projects/Prx/Source/Foo.pb.h#1 edit
... //depot/main/Client/Projects/Prx/Content/Icon.uasset#1 edit
`,
          stderr: "",
        },
      });
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        watchPath: ["Client/Projects"],
        includeCrFile: ["*.cpp", "*.h"],
        excludeCrFile: ["*.pb.h"],
        p4: mockP4,
      });

      const range = await adapter.listChanges(makeEvent());
      expect(range.files).toEqual(["Client/Projects/Prx/Source/Foo.cpp"]);
    });

    it("filters files by exclude patterns", async () => {
      const mockP4 = createMockP4Runner({
        "describe -s 12345": { stdout: describeOutput, stderr: "" },
      });
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        excludeCrFile: ["**/*.md"],
        p4: mockP4,
      });

      const range = await adapter.listChanges(makeEvent());
      expect(range.files).toContain("src/foo.cpp");
      expect(range.files).toContain("src/bar.h");
      expect(range.files).not.toContain("README.md");
    });

    it("logs in with the configured password and retries when p4 reports an invalid ticket", async () => {
      let describeAttempts = 0;
      let loginCalls = 0;
      const mockP4: P4CommandRunner = async (args, env) => {
        if (args.join(" ").includes("describe -s 12345")) {
          describeAttempts += 1;
          expect(env).toEqual({ P4PASSWD: "secret-password" });
          if (describeAttempts === 1) {
            throw Object.assign(new Error("Perforce password (P4PASSWD) invalid or unset."), {
              stderr: "Perforce password (P4PASSWD) invalid or unset.",
            });
          }
          return { stdout: describeOutput, stderr: "" };
        }
        return { stdout: "", stderr: "" };
      };
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        password: "secret-password",
        p4: mockP4,
        p4Login: async (args, password, env) => {
          loginCalls += 1;
          expect(args).not.toContain("login");
          expect(password).toBe("secret-password");
          expect(env).toEqual({ P4PASSWD: "secret-password" });
          return { stdout: "User logged in.", stderr: "" };
        },
      });

      const range = await adapter.listChanges(makeEvent());
      expect(loginCalls).toBe(1);
      expect(describeAttempts).toBe(2);
      expect(range.files).toContain("src/foo.cpp");
    });

    it("filters files by watch path", async () => {
      const mockP4 = createMockP4Runner({
        "describe -s 12345": { stdout: describeOutput, stderr: "" },
      });
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        watchPath: ["src/"],
        p4: mockP4,
      });

      const range = await adapter.listChanges(makeEvent());
      expect(range.files).toContain("src/foo.cpp");
      expect(range.files).toContain("src/bar.h");
      expect(range.files).not.toContain("README.md");
    });

    it("throws when headSha is missing", async () => {
      const adapter = new P4VcsAdapter({ repositoryDir: "/tmp/test" });
      await expect(adapter.listChanges(makeEvent({ headSha: undefined }))).rejects.toThrow(
        "P4 listChanges requires headSha",
      );
    });
  });

  describe("fetchScoped", () => {
    it("fetches files via p4 print", async () => {
      const mockP4 = createMockP4Runner({
        "print -q": { stdout: "file content here", stderr: "" },
      });
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        p4: mockP4,
      });

      const range: ChangeRange = {
        headRevision: "12345",
        files: ["src/foo.cpp"],
      };

      const result = await adapter.fetchScoped(range, {
        id: "test-ws",
        sourceDir: "/tmp/test/source",
      });

      expect(result.fetchedFiles).toContain("src/foo.cpp");
    });

    it("returns empty when no revision", async () => {
      const adapter = new P4VcsAdapter({ repositoryDir: "/tmp/test" });
      const range: ChangeRange = { files: ["a.cpp"] };

      const result = await adapter.fetchScoped(range, {
        id: "test-ws",
        sourceDir: "/tmp/test/source",
      });

      expect(result.fetchedFiles).toEqual([]);
    });

    it("skips files that fail to print", async () => {
      const mockP4 = async (args: readonly string[]): Promise<P4CommandResult> => {
        if (args.join(" ").includes("missing.cpp")) {
          throw new Error("no such file");
        }
        return { stdout: "content", stderr: "" };
      };
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        p4: mockP4,
      });

      const range: ChangeRange = {
        headRevision: "12345",
        files: ["src/exists.cpp", "src/missing.cpp"],
      };

      const result = await adapter.fetchScoped(range, {
        id: "test-ws",
        sourceDir: "/tmp/test/source",
      });

      expect(result.fetchedFiles).toEqual(["src/exists.cpp"]);
    });
  });

  describe("fetchExtraContext", () => {
    it("reads file from workspace source dir", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const tmpDir = join(process.cwd(), "build", "test-p4-ctx");

      await mkdir(join(tmpDir, "src"), { recursive: true });
      await writeFile(join(tmpDir, "src", "foo.cpp"), "line1\nline2\nline3\n", "utf8");

      const adapter = new P4VcsAdapter({ repositoryDir: tmpDir });
      const result = await adapter.fetchExtraContext(
        { path: "src/foo.cpp", startLine: 2, endLine: 3, reason: "test" },
        { id: "ws", sourceDir: tmpDir },
      );

      expect(result.content).toBe("line2\nline3");
    });
  });

  describe("diff", () => {
    it("parses unified diff from p4 describe -du", async () => {
      const mockP4 = createMockP4Runner({
        "describe -du 12345": { stdout: diffOutputUnified, stderr: "" },
      });
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        p4: mockP4,
      });

      const result = await adapter.diff({ headRevision: "12345", files: ["src/foo.cpp"] });
      expect(result.files.length).toBe(1);
      expect(result.files[0]?.oldPath).toBe("src/foo.cpp");
      expect(result.files[0]?.newPath).toBe("src/foo.cpp");
      expect(result.files[0]?.hunks.length).toBe(1);
      expect(result.files[0]?.hunks[0]?.lines.length).toBe(3);
      expect(result.files[0]?.hunks[0]?.lines[1]?.kind).toBe("delete");
      expect(result.files[0]?.hunks[0]?.lines[2]?.kind).toBe("add");
    });

    it("parses multi-file unified diff", async () => {
      const mockP4 = createMockP4Runner({
        "describe -du 12345": { stdout: diffOutputMultiFile, stderr: "" },
      });
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        p4: mockP4,
      });

      const result = await adapter.diff({ headRevision: "12345", files: ["src/foo.cpp", "src/bar.h"] });
      expect(result.files.length).toBe(2);

      expect(result.files[0]?.oldPath).toBe("src/foo.cpp");
      expect(result.files[0]?.newPath).toBe("src/foo.cpp");
      expect(result.files[0]?.hunks[0]?.lines.length).toBe(4);

      expect(result.files[1]?.status).toBe("added");
      expect(result.files[1]?.newPath).toBe("src/bar.h");
      expect(result.files[1]?.hunks[0]?.lines.length).toBe(5);
    });

    it("parses native p4 unified diff hunks without explicit file headers", async () => {
      const mockP4 = createMockP4Runner({
        "describe -du 12345": { stdout: diffOutputP4NativeUnified, stderr: "" },
      });
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        p4: mockP4,
      });

      const result = await adapter.diff({ headRevision: "12345", files: ["src/foo.cpp", "src/bar.h"] });

      expect(result.files.length).toBe(2);
      expect(result.files[0]?.status).toBe("modified");
      expect(result.files[0]?.oldPath).toBe("src/foo.cpp");
      expect(result.files[0]?.newPath).toBe("src/foo.cpp");
      expect(result.files[0]?.hunks[0]?.lines.map((line) => line.kind)).toEqual([
        "context",
        "delete",
        "add",
        "add",
      ]);
      expect(result.files[1]?.status).toBe("added");
      expect(result.files[1]?.oldPath).toBeUndefined();
      expect(result.files[1]?.newPath).toBe("src/bar.h");
      expect(result.files.map((file) => file.newPath ?? file.oldPath)).not.toContain("src/skip.cs");
    });

    it("returns empty when no revision", async () => {
      const adapter = new P4VcsAdapter({ repositoryDir: "/tmp/test" });
      const result = await adapter.diff({ files: ["a.cpp"] });
      expect(result.files).toEqual([]);
    });

    it("returns empty when p4 describe fails", async () => {
      const mockP4 = async (): Promise<P4CommandResult> => {
        throw new Error("connection failed");
      };
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        p4: mockP4,
      });

      const result = await adapter.diff({ headRevision: "99999", files: ["a.cpp"] });
      expect(result.files).toEqual([]);
    });

    it("handles empty diff output gracefully", async () => {
      const mockP4 = createMockP4Runner({
        "describe -du 12345": {
          stdout: `Change 12345 by testuser@testclient on 2026/05/07 10:00:00

\tTest commit

Affected files ...

... //depot/main/src/binary.png#1 add

==== //depot/main/src/binary.png#1 (binary) ====
`,
          stderr: "",
        },
      });
      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        depot: "//depot/main",
        p4: mockP4,
      });

      const result = await adapter.diff({ headRevision: "12345", files: ["src/binary.png"] });
      expect(result.files).toEqual([]);
    });
  });

  describe("buildBaseArgs", () => {
    it("includes port and user when set", async () => {
      const capturedArgs: string[][] = [];
      const mockP4 = async (args: readonly string[]): Promise<P4CommandResult> => {
        capturedArgs.push([...args]);
        return { stdout: describeOutput, stderr: "" };
      };

      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        port: "perforce:1666",
        user: "testuser",
        workspace: "test-ws",
        p4: mockP4,
      });

      await adapter.listChanges(makeEvent());
      expect(capturedArgs.length).toBeGreaterThan(0);
      const baseArgs = capturedArgs[0]!;
      expect(baseArgs).toContain("-p");
      expect(baseArgs).toContain("perforce:1666");
      expect(baseArgs).toContain("-u");
      expect(baseArgs).toContain("testuser");
      expect(baseArgs).toContain("-c");
      expect(baseArgs).toContain("test-ws");
    });

    it("passes configured password as P4PASSWD environment", async () => {
      const capturedEnv: Array<Readonly<Record<string, string>> | undefined> = [];
      const mockP4: P4CommandRunner = async (_args, env) => {
        capturedEnv.push(env);
        return { stdout: describeOutput, stderr: "" };
      };

      const adapter = new P4VcsAdapter({
        repositoryDir: "/tmp/test",
        password: "secret-ticket",
        p4: mockP4,
      });

      await adapter.listChanges(makeEvent());
      expect(capturedEnv[0]).toEqual({ P4PASSWD: "secret-ticket" });
    });
  });
});
