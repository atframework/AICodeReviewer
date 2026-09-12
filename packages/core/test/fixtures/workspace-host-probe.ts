import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, statfs, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { buildWorkspaceBinding, computeWorkspaceLayout } from "../../src/config-workspace.js";

/** Run with the host's real filesystem; path.win32/posix string emulation is insufficient. */
export async function verifyWorkspaceHostFilesystem(base: string) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(resolve(base), "layout-"));
  try {
    const bindings = ["Owner/工程", "owner/工程"].map((project) => buildWorkspaceBinding({ definitionId: "services", triggerName: "primary", vcs: "git", canonicalProjectKey: `git:host:${project}`, workPathTemplate: "same-result" }, {}));
    assert.notEqual(bindings[0]!.instanceId, bindings[1]!.instanceId);
    const layouts = bindings.map((binding) => computeWorkspaceLayout(root, binding, "isolated_v2"));
    assert.notEqual(layouts[0]!.sourceRoot, layouts[1]!.sourceRoot);
    for (const [index, layout] of layouts.entries()) {
      const dir = join(layout.instanceRoot, "runs", "run", "source", "long".repeat(22), "path".repeat(22));
      await mkdir(dir, { recursive: true });
      const file = join(dir, "工程-é.txt");
      assert.ok(file.length > 260);
      await writeFile(file, String(index));
      assert.equal(await readFile(file, "utf8"), String(index));
      const contained = relative(await realpath(root), await realpath(file));
      assert.ok(!contained.startsWith(`..${sep}`));
    }
    await writeFile(join(root, "CASE"), "upper");
    await writeFile(join(root, "case"), "lower");
    const caseSensitive = (await readFile(join(root, "CASE"), "utf8")) === "upper";
    const sibling = `${root}-sibling`;
    await mkdir(sibling);
    try {
      await symlink(sibling, join(layouts[0]!.instanceRoot, "outside"), process.platform === "win32" ? "junction" : "dir");
      assert.ok(relative(await realpath(root), await realpath(join(layouts[0]!.instanceRoot, "outside"))).startsWith(`..${sep}`));
    } finally { await rm(sibling, { recursive: true, force: true }); }
    return { platform: process.platform, filesystemType: (await statfs(root)).type, caseSensitive, unicode: true, longPath: true, distinctInstances: true, junctionBoundary: true };
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.env.AICR_WORKSPACE_FS_ROOT) {
  verifyWorkspaceHostFilesystem(process.env.AICR_WORKSPACE_FS_ROOT).then((result) => console.log(JSON.stringify(result)), (error) => { console.error(error); process.exitCode = 1; });
}
