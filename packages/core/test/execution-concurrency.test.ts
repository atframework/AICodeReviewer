import { describe, expect, it } from "vitest";
import { ExecutionConcurrency } from "../src/execution-concurrency.js";

describe("shared execution concurrency", () => {
  it("admits an idle workspace past a busy workspace and shares the global limit", async () => {
    const pool = new ExecutionConcurrency(() => ({ global: 2, workspace: 1 }));
    const p4 = pool.tryAcquire("p4-main")!;
    const starts: string[] = [];
    const pending = pool.run("p4-main", async () => { starts.push("p4-second"); });
    const github = Promise.withResolvers<void>();
    const active = pool.run("github-atsf4g-co", async () => { starts.push("github"); await github.promise; });
    await Promise.resolve();
    expect(starts).toEqual(["github"]);
    expect(pool.available).toBe(false);
    expect(pool.tryAcquire("svn")).toBeUndefined();
    github.resolve();
    await active;
    expect(starts).toEqual(["github"]);
    p4();
    p4(); // A duplicated release cannot create an extra permit.
    await pending;
    expect(starts).toEqual(["github", "p4-second"]);
    expect(pool.blockedWorkspaceIds()).toEqual([]);
  });

  it("applies increases and decreases at admission, releasing on failures", async () => {
    let global = 1;
    let workspace = 1;
    const pool = new ExecutionConcurrency(() => ({ global, workspace }));
    const first = pool.tryAcquire("a")!;
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const second = pool.run("a", async () => { entered.resolve(); await finish.promise; throw new Error("failed"); });
    const rejection = expect(second).rejects.toThrow("failed");
    global = 2;
    workspace = 2;
    pool.refresh();
    await entered.promise;
    global = 1;
    first();
    expect(pool.tryAcquire("b")).toBeUndefined();
    finish.resolve();
    await rejection;
    expect(pool.tryAcquire("b")).toBeTypeOf("function");
  });
});
