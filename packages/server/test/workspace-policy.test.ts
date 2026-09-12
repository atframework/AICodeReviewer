import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createReviewEvent, prepareReviewPrompt, reviewMemoryScope } from "@aicr/core";
import { createTemplateResolver } from "@aicr/outputs";
import { createStoreDb, readReflectionMemory, softDeleteMissingProjects, writeReflectionMemory } from "@aicr/store";

describe("workspace policy and memory isolation (W01/L13)", () => {
  it("loads old operator assets read-only and gives explicit project assets precedence", async () => {
    await mkdir("build/tmp", { recursive: true });
    const base = await mkdtemp(resolve("build/tmp/policy-"));
    const policyRoot = join(base, "definition");
    const sourceRoot = join(base, "instance", "runs", "run", "source");
    const skillPath = ".agents/skills/policy/SKILL.md";
    const operatorSkill = "---\nname: policy\ndescription: Operator policy\n---\nOperator-only skill.\n";
    try {
      await mkdir(join(policyRoot, ".agents/skills/policy"), { recursive: true });
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(join(policyRoot, "AGENTS.md"), "Operator-only instructions.");
      await writeFile(join(policyRoot, skillPath), operatorSkill);
      const event = createReviewEvent({ workspaceId: "definition", triggerName: "primary", provider: "github", targetKind: "push", repoRef: "group/app", author: {}, reason: "fixture" });
      const input = { reviewEvent: event, sourceRoot, policyRoot, baseSystemPrompt: "{{REPO_INSTRUCTION_SUMMARIES}}\n{{ACTIVE_SKILL_SUMMARIES}}\n{{TASK_CONTEXT}}" };
      const fallback = await prepareReviewPrompt(input);
      expect(fallback.discovery.instructions.some((entry) => entry.content.includes("Operator-only"))).toBe(true);
      expect(fallback.discovery.skills.map((entry) => entry.name)).toEqual(["policy"]);
      await mkdir(join(sourceRoot, ".agents/skills/policy"), { recursive: true });
      await writeFile(join(sourceRoot, "AGENTS.md"), "Project instructions.");
      await writeFile(join(sourceRoot, skillPath), operatorSkill.replace("Operator-only", "Project-only"));
      const explicit = await prepareReviewPrompt(input);
      expect(explicit.discovery.instructions.filter((entry) => entry.path === "AGENTS.md")).toHaveLength(1);
      expect(explicit.discovery.instructions.some((entry) => entry.content.includes("Project instructions"))).toBe(true);
      expect(explicit.discovery.skills.map((entry) => entry.content)).toEqual([expect.stringContaining("Project-only")]);
      expect(await readFile(join(policyRoot, skillPath), "utf8")).toBe(operatorSkill);
      const legacyTemplates = join(policyRoot, "templates");
      const instanceTemplates = join(base, "instance", "templates");
      await mkdir(legacyTemplates, { recursive: true });
      await mkdir(instanceTemplates, { recursive: true });
      await writeFile(join(legacyTemplates, "summary.md.hbs"), "Legacy {{summary}}");
      const resolver = createTemplateResolver({ channelKind: "github_pr_review", workspaceTemplatesDir: instanceTemplates, fallbackWorkspaceTemplatesDirs: [legacyTemplates] });
      expect(resolver.resolveTemplate("summary")).toContain("Legacy");
      await writeFile(join(instanceTemplates, "summary.md.hbs"), "Instance {{summary}}");
      expect(resolver.resolveTemplate("summary")).toContain("Instance");
      expect(await readFile(join(legacyTemplates, "summary.md.hbs"), "utf8")).toBe("Legacy {{summary}}");
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it("keeps same-definition project memories separate in the real sqlite store", async () => {
    const store = createStoreDb(":memory:");
    try {
      const event = (instanceId: string) => ({ workspaceId: "services", resolution: { kind: "match" as const, definitionId: "services", binding: { definitionId: "services", instanceId, workPath: "same-path" } } });
      for (const id of ["instance-a", "instance-b"]) await writeReflectionMemory(store, [{ workspaceId: reviewMemoryScope(event(id)), fingerprint: "same-fingerprint", content: id, sourceRunId: id, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }]);
      expect((await readReflectionMemory(store, reviewMemoryScope(event("instance-a")))).map((entry) => entry.content)).toEqual(["instance-a"]);
      expect((await readReflectionMemory(store, reviewMemoryScope(event("instance-b")))).map((entry) => entry.content)).toEqual(["instance-b"]);
      expect(await readReflectionMemory(store, "services")).toEqual([]);
      store.sqlite.prepare("INSERT INTO projects (workspace_id, trigger_name, repo_ref, created_at) VALUES (?, ?, ?, ?)").run("services", "primary", "group/a", Date.now());
      expect(await softDeleteMissingProjects(store, [], ["services"])).toBe(0);
      expect(await softDeleteMissingProjects(store, [], [])).toBe(1);
    } finally { store.sqlite.close(); }
  });
});
