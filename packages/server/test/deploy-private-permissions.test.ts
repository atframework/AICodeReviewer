import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("deployment data permissions", () => {
  it.skipIf(process.platform === "win32").each(["podman", "docker"])("preserves private identities and backups with %s", engine => {
    const source = readFileSync(new URL("../../../deploy/deploy.sh", import.meta.url), "utf8");
    const start = source.indexOf("ensure_writable_tree() {");
    const end = source.indexOf("\n}", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const root = mkdtempSync(join(tmpdir(), "aicr-private-permissions-"));
    try {
      const data = join(root, "data", "db");
      const privateRoot = join(data, "private");
      const backupRoot = join(data, "build", "deploy");
      for (const dir of [data, privateRoot, backupRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const member = join(privateRoot, "members.yaml");
      const backup = join(backupRoot, "members.before.yaml");
      const store = join(data, "store.db");
      for (const file of [member, backup, store]) writeFileSync(file, "fixture", { mode: 0o600 });
      const functionFile = join(root, "permissions.sh");
      writeFileSync(functionFile, `${source.slice(start, end + 2)}\n`);
      const enginePath = join(root, "engine");
      writeFileSync(enginePath, '#!/bin/sh\n[ "$1" = unshare ] || exit 1\nshift\nexec "$@"\n');
      chmodSync(enginePath, 0o700);
      execFileSync("bash", ["-c", '. "$FUNCTION_FILE"\nensure_writable_tree "$DEPLOY_DIR/data/db"'], {
        env: { ...process.env, DEPLOY_DIR: root, FUNCTION_FILE: functionFile, ENGINE_BASENAME: engine, ENGINE_CMD: enginePath },
      });
      expect(statSync(privateRoot).mode & 0o777).toBe(0o700);
      expect(statSync(join(data, "build")).mode & 0o777).toBe(0o700);
      expect(statSync(member).mode & 0o777).toBe(0o600);
      expect(statSync(backup).mode & 0o777).toBe(0o600);
      expect(statSync(data).mode & 0o777).toBe(0o777);
      expect(statSync(store).mode & 0o777).toBe(0o666);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
