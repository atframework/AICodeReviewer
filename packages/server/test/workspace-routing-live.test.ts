import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createMemoryAutoCommitStore, parseConfigDocumentText, type WorkspaceResolution } from "@aicr/core";
import { P4VcsAdapter, SvnVcsAdapter, type VcsAdapter } from "@aicr/vcs";
import { describe, expect, it } from "vitest";
import { AutoCommitRuntime } from "../src/auto-commit-runtime.js";
import { RoutingReceiptResolver, type RoutingTriggerProfile } from "../src/routing-resolver.js";
import { createWorkspaceRuntime } from "../src/workspace-runtime.js";

async function verifySplit(kind: "p4" | "svn", root: string, adapter: VcsAdapter, profile: RoutingTriggerProfile) {
  const config = parseConfigDocumentText(`triggers: [{name: primary, kind: ${kind}}]\nworkspaces:\n  instances:\n    shared-policy:\n      match: [{triggers: [primary]}]\n      work_path: same-result\n`).config;
  const workspaceRuntime = createWorkspaceRuntime(config, root);
  const store = createMemoryAutoCommitStore();
  const runtime = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) });
  const envelope = { revision: "1", user: "untrusted-hint", client: "untrusted-client" };
  const eventName = kind === "p4" ? "change-commit" : "post-commit";
  const accepted = await runtime.acceptRouting({ provider: kind, eventName, triggerName: "primary", envelope, now: 1000 });
  const resolver = new RoutingReceiptResolver({ config, store, runtime, workspaceRuntime, adapterFor: () => adapter, profileFor: () => profile });
  await resolver.resolveDue(2000);
  const parent = await store.getRoutingReceipt(accepted.receipt.routingId);
  expect(parent?.terminalError).toBeNull();
  expect(parent?.completedAt, parent?.note ?? undefined).toBe(2000);
  expect(parent?.convertedReceiptIds).toHaveLength(2);
  const receipts = await Promise.all(parent!.convertedReceiptIds.map((id) => store.getReceipt(id)));
  const resolutions = receipts.map((entry) => entry!.receipt.resolution as WorkspaceResolution & { kind: "match" });
  expect(new Set(resolutions.map((entry) => entry.binding.instanceId)).size).toBe(2);
  expect(resolutions.map((entry) => entry.binding.workPath)).toEqual(["same-result", "same-result"]);
  for (const resolution of resolutions) {
    const fields = resolution.variables[kind] as Record<string, string | null>;
    expect(fields[kind === "p4" ? "user" : "author"]).toBe("alice");
    expect(fields[kind === "p4" ? "change" : "revision"]).toBe("1");
    if (kind === "p4") { expect(fields.client).toBe("submitter"); expect(fields.stream).toBeNull(); }
    else { expect(fields.repository_uuid).toEqual(expect.any(String)); expect(fields.branch).toBe("trunk"); }
  }
  expect((await runtime.acceptRouting({ provider: kind, eventName, triggerName: "primary", envelope, now: 3000 })).receipt.routingId).toBe(parent!.routingId);
  await resolver.resolveDue(4000);
  expect((await store.getRoutingReceipt(parent!.routingId))?.convertedReceiptIds).toEqual(parent!.convertedReceiptIds);
}

describe("real VCS multi-project admission (W14/W15/V06-V10)", () => {
  it.skipIf(!process.env.AICR_SVN_TEST_EXECUTABLE)("splits one SVN revision using explicit roots and svn info identity", async () => {
    await mkdir("build/tmp", { recursive: true });
    const base = await mkdtemp(resolve("build/tmp/svn-workspace-live-"));
    const svn = process.env.AICR_SVN_TEST_EXECUTABLE!;
    const admin = join(svn, "..", process.platform === "win32" ? "svnadmin.exe" : "svnadmin");
    const repo = join(base, "repo");
    const tree = join(base, "tree");
    const url = pathToFileURL(repo).href;
    execFileSync(admin, ["create", repo]);
    for (const name of ["app-a", "app-b"]) {
      await mkdir(join(tree, name, "trunk"), { recursive: true });
      await writeFile(join(tree, name, "trunk", "file.txt"), name);
    }
    execFileSync(svn, ["import", "-q", "--username", "alice", "-m", "two projects", tree, url]);
    await verifySplit("svn", base, new SvnVcsAdapter({ repositoryDir: tree, repositoryUrl: url }), { workspaceId: "shared-policy", repositoryUrl: url,
      projectRoots: ["app-a", "app-b"].map((project) => ({ prefix: `/${project}/trunk`, project, branch: "trunk" })) });
  });

  it.skipIf(!process.env.AICR_P4D_TEST_EXECUTABLE)("splits a submitted changelist across two classic depot scopes", async () => {
    await mkdir("build/tmp", { recursive: true });
    const base = await mkdtemp(resolve("build/tmp/p4-workspace-live-"));
    const serverRoot = join(base, "server");
    const clientRoot = join(base, "client");
    await mkdir(serverRoot); await mkdir(clientRoot);
    const port = "127.0.0.1:18673";
    const server = spawn(process.env.AICR_P4D_TEST_EXECUTABLE!, ["-r", serverRoot, "-p", port, "-L", join(base, "p4d.log")], { windowsHide: true, stdio: "ignore" });
    const p4 = (args: string[], input?: string) => execFileSync("p4", ["-p", port, "-u", "alice", "-c", "submitter", ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...(input ? { input } : {}) });
    try {
      let ready = false;
      for (let i = 0; i < 30; i++) { try { p4(["info"]); ready = true; break; } catch { await delay(100); } }
      expect(ready).toBe(true);
      p4(["client", "-i"], `Client: submitter\nOwner: alice\nRoot: ${clientRoot}\nView:\n\t//depot/... //submitter/...\n`);
      for (const name of ["app-a", "app-b"]) {
        await mkdir(join(clientRoot, name)); await writeFile(join(clientRoot, name, "file.txt"), name);
        p4(["add", join(clientRoot, name, "file.txt")]);
      }
      p4(["submit", "-d", "two projects"]);
      await verifySplit("p4", base, new P4VcsAdapter({ repositoryDir: join(base, "service"), port, user: "alice", workspace: "service", depot: "//depot" }), { workspaceId: "shared-policy", scopes: ["//depot/app-a", "//depot/app-b"] });
    } finally { try { p4(["admin", "stop"]); } catch { server.kill(); } }
  });
});
