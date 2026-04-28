import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { assemblePrompt, discoverRepoPromptAssets } from "../src/prompt-manager.js";

async function writeWorkspaceFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(rootDir, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

describe("discoverRepoPromptAssets", () => {
  it("discovers nearest AGENTS, repo-wide instructions, matching path instructions, and active skills", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-"));

    try {
      await writeWorkspaceFile(tempDir, "AGENTS.md", "# Root\nUse small commits and keep APIs stable.\n");
      await writeWorkspaceFile(
        tempDir,
        "src/AGENTS.md",
        "# Source\nDatabase writes under src/ must stay transactional.\n",
      );
      await writeWorkspaceFile(
        tempDir,
        ".github/copilot-instructions.md",
        "# Copilot\nPrefer focused findings over broad summaries.\n",
      );
      await writeWorkspaceFile(
        tempDir,
        ".github/instructions/backend.instructions.md",
        ['---', 'applyTo:', '  - "src/**/*.ts"', '---', '', '# Backend', '', 'Validate auth and transaction boundaries.', ''].join("\n"),
      );
      await writeWorkspaceFile(
        tempDir,
        ".github/instructions/docs.instructions.md",
        ['---', 'applyTo:', '  - "docs/**"', '---', '', '# Docs', '', 'Only applies to docs paths.', ''].join("\n"),
      );
      await writeWorkspaceFile(
        tempDir,
        ".agents/skills/security-check/SKILL.md",
        [
          "---",
          "name: security-check",
          'description: "Review auth boundaries and token handling."',
          "---",
          "",
          "# Security Check",
          "",
          "## Applies To",
          "",
          "- `src/auth/**`",
          "",
          "## Procedure",
          "",
          "- Look for auth bypasses.",
          "",
        ].join("\n"),
      );

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/auth/login.ts"],
      });

      expect(discovery.instructions.map((instruction) => instruction.path)).toEqual(
        expect.arrayContaining([
          "src/AGENTS.md",
          "AGENTS.md",
          ".github/copilot-instructions.md",
          ".github/instructions/backend.instructions.md",
        ]),
      );
      expect(discovery.instructions.find((instruction) => instruction.path === "src/AGENTS.md")?.kind).toBe(
        "nearest_agents",
      );
      expect(discovery.instructions.find((instruction) => instruction.path === "AGENTS.md")?.kind).toBe(
        "root_agents",
      );
      expect(discovery.skills.map((skill) => skill.name)).toEqual(["security-check"]);
      expect(
        discovery.droppedRefs.some(
          (ref) =>
            ref.path === ".github/instructions/docs.instructions.md" &&
            ref.reason.includes("applyTo did not match changed paths"),
        ),
      ).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("drops invalid or unmatched assets and keeps alias instructions while deduping root AGENTS", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-edge-"));

    try {
      await writeWorkspaceFile(tempDir, "AGENTS.md", "# Root\nRoot instructions for the whole repository.\n");
      await writeWorkspaceFile(tempDir, "CLAUDE.md", "# Claude\nCompatible alias instructions.\n");
      await writeWorkspaceFile(
        tempDir,
        ".github/instructions/missing-apply.instructions.md",
        ["---", "title: missing-apply", "---", "", "# Missing", "", "No applyTo here.", ""].join(
          "\n",
        ),
      );
      await writeWorkspaceFile(
        tempDir,
        ".agents/skills/broken-skill/SKILL.md",
        ["---", "name: broken-skill", "---", "", "# Broken", "", "Missing description.", ""].join(
          "\n",
        ),
      );
      await writeWorkspaceFile(
        tempDir,
        ".agents/skills/docs-only/SKILL.md",
        [
          "---",
          "name: docs-only",
          'description: "Only for docs changes."',
          "---",
          "",
          "# Docs Skill",
          "",
          "## Applies To",
          "",
          "- `docs/**`",
          "",
        ].join("\n"),
      );

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["README.md"],
      });

      expect(discovery.instructions.find((instruction) => instruction.path === "AGENTS.md")?.kind).toBe(
        "nearest_agents",
      );
      expect(discovery.instructions.find((instruction) => instruction.path === "CLAUDE.md")?.kind).toBe(
        "alias",
      );
      expect(
        discovery.droppedRefs.some(
          (ref) =>
            ref.kind === "root_agents" &&
            ref.path === "AGENTS.md" &&
            ref.reason.includes("already loaded via nearest AGENTS discovery"),
        ),
      ).toBe(true);
      expect(
        discovery.droppedRefs.some(
          (ref) =>
            ref.kind === "path_instruction" &&
            ref.path === ".github/instructions/missing-apply.instructions.md" &&
            ref.reason.includes("missing applyTo frontmatter"),
        ),
      ).toBe(true);
      expect(
        discovery.droppedRefs.some(
          (ref) =>
            ref.kind === "skill" &&
            ref.path === ".agents/skills/broken-skill/SKILL.md" &&
            ref.reason.includes("missing name/description"),
        ),
      ).toBe(true);
      expect(
        discovery.droppedRefs.some(
          (ref) =>
            ref.kind === "skill" &&
            ref.path === ".agents/skills/docs-only/SKILL.md" &&
            ref.reason.includes("did not match changed paths"),
        ),
      ).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects changed paths that escape the source root", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-bounds-"));

    try {
      await expect(
        discoverRepoPromptAssets({
          sourceRoot: tempDir,
          changedPaths: ["../escape.ts"],
        }),
      ).rejects.toThrow(/must stay within/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats path-instructions and skills with malformed YAML frontmatter as missing metadata instead of crashing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-yaml-"));

    try {
      await writeWorkspaceFile(
        tempDir,
        ".github/instructions/broken.instructions.md",
        ["---", "applyTo: [unterminated", "---", "", "# Broken", "", "Body."].join("\n"),
      );
      await writeWorkspaceFile(
        tempDir,
        ".agents/skills/broken-yaml/SKILL.md",
        ["---", "name: broken", ":::not-yaml", "---", "", "# Broken", ""].join("\n"),
      );

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/auth/login.ts"],
      });

      expect(
        discovery.droppedRefs.some(
          (ref) =>
            ref.kind === "path_instruction" &&
            ref.path === ".github/instructions/broken.instructions.md" &&
            ref.reason.includes("missing applyTo"),
        ),
      ).toBe(true);
      expect(
        discovery.droppedRefs.some(
          (ref) =>
            ref.kind === "skill" &&
            ref.path === ".agents/skills/broken-yaml/SKILL.md" &&
            ref.reason.includes("missing name/description"),
        ),
      ).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("walks parent directories until it finds an AGENTS.md", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-walk-"));

    try {
      await writeWorkspaceFile(
        tempDir,
        "src/feature/AGENTS.md",
        "# Feature\nFeature-level rules apply here.\n",
      );

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/feature/sub/component.ts"],
      });

      const nearest = discovery.instructions.find((instruction) => instruction.kind === "nearest_agents");
      expect(nearest?.path).toBe("src/feature/AGENTS.md");
      expect(nearest?.matchedPaths).toEqual(["src/feature/sub/component.ts"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("assemblePrompt", () => {
  it("renders prompt sections and trims low-priority context to fit the prompt budget", () => {
    const discovery = {
      instructions: [
        {
          kind: "nearest_agents" as const,
          label: "src/AGENTS.md",
          path: "src/AGENTS.md",
          content: "Use transactions for writes.",
          summary: "Use transactions for writes and auth updates.",
          reason: "matches src/auth/login.ts",
          priority: 520,
          specificity: 2,
          matchedPaths: ["src/auth/login.ts"],
        },
        {
          kind: "copilot_instruction" as const,
          label: ".github/copilot-instructions.md",
          path: ".github/copilot-instructions.md",
          content: "Prefer compact output.",
          summary:
            "Prefer compact output and avoid verbose summaries when the diff is already clear and scoped.",
          reason: "repo-wide Copilot instructions",
          priority: 200,
          specificity: 0,
        },
      ],
      skills: [
        {
          kind: "skill" as const,
          label: "security-check",
          name: "security-check",
          description: "Review auth boundaries and token handling.",
          path: ".agents/skills/security-check/SKILL.md",
          content: "Review auth boundaries and token handling.",
          summary:
            "Review auth boundaries and token handling with extra scrutiny for login, session, and token refresh flows.",
          reason: "matches src/auth/login.ts",
          priority: 75,
          specificity: 1,
          matchedPaths: ["src/auth/login.ts"],
          appliesTo: ["src/auth/**"],
        },
      ],
      droppedRefs: [],
      conflicts: [],
    };

    const output = assemblePrompt({
      baseSystemPrompt: [
        "<repo>",
        "{{REPO_INSTRUCTION_SUMMARIES}}",
        "</repo>",
        "<skills>",
        "{{ACTIVE_SKILL_SUMMARIES}}",
        "</skills>",
        "<memory>",
        "{{MEMORY_HINTS}}",
        "</memory>",
        "<task>",
        "{{TASK_CONTEXT}}",
        "</task>",
      ].join("\n"),
      discovery,
      operatorOverrides: [
        "Always emit concise, deterministic findings and avoid praise or filler in summaries.",
      ],
      memoryHints: [
        "This is a deliberately long memory hint that should be trimmed first when the prompt budget gets tight.",
      ],
      taskContext: "Changed files: src/auth/login.ts",
      maxPromptTokens: 110,
    });

    expect(output.systemPrompt).toContain("runtime override 1");
    expect(output.systemPrompt).toContain("src/AGENTS.md");
    expect(output.systemPrompt).not.toContain("deliberately long memory hint");
    expect(output.droppedInstructionRefs.some((ref) => ref.kind === "memory_hint")).toBe(true);
    expect(output.tokenEstimate).toBeLessThanOrEqual(110);
  });

  it("falls back to empty sections and stops trimming when nothing is removable", () => {
    const output = assemblePrompt({
      baseSystemPrompt: [
        "<repo>",
        "{{REPO_INSTRUCTION_SUMMARIES}}",
        "</repo>",
        "<skills>",
        "{{ACTIVE_SKILL_SUMMARIES}}",
        "</skills>",
        "<memory>",
        "{{MEMORY_HINTS}}",
        "</memory>",
        "<task>",
        "{{TASK_CONTEXT}}",
        "</task>",
        "",
        "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      ].join("\n"),
      discovery: {
        instructions: [],
        skills: [],
        droppedRefs: [],
        conflicts: [],
      },
      taskContext: "   ",
      maxPromptTokens: 10,
    });

    expect(output.systemPrompt).toContain("<repo>\n(none)\n</repo>");
    expect(output.systemPrompt).toContain("<skills>\n(none)\n</skills>");
    expect(output.systemPrompt).toContain("<memory>\n(none)\n</memory>");
    expect(output.systemPrompt).toContain("<task>\n(none)\n</task>");
    expect(output.droppedInstructionRefs).toEqual([]);
    expect(output.tokenEstimate).toBeGreaterThan(10);
  });

  it("trims skills before non-override instructions and never removes operator overrides", () => {
    const longSummary = "Long ".repeat(60).trim();
    const longInstructionContent = "L".repeat(800);
    const output = assemblePrompt({
      baseSystemPrompt: [
        "<repo>",
        "{{REPO_INSTRUCTION_SUMMARIES}}",
        "</repo>",
        "<skills>",
        "{{ACTIVE_SKILL_SUMMARIES}}",
        "</skills>",
        "<memory>",
        "{{MEMORY_HINTS}}",
        "</memory>",
        "<task>",
        "{{TASK_CONTEXT}}",
        "</task>",
      ].join("\n"),
      discovery: {
        instructions: [
          {
            kind: "nearest_agents" as const,
            label: "src/AGENTS.md",
            path: "src/AGENTS.md",
            content: longInstructionContent,
            summary: longSummary,
            reason: "matches src/auth/login.ts",
            priority: 520,
            specificity: 2,
            matchedPaths: ["src/auth/login.ts"],
          },
        ],
        skills: [
          {
            kind: "skill" as const,
            label: "skill-one",
            name: "skill-one",
            description: longSummary,
            path: ".agents/skills/skill-one/SKILL.md",
            content: longSummary,
            summary: longSummary,
            reason: "matches src/auth/login.ts",
            priority: 75,
            specificity: 1,
            matchedPaths: ["src/auth/login.ts"],
            appliesTo: ["src/auth/**"],
          },
        ],
        droppedRefs: [],
        conflicts: [],
      },
      operatorOverrides: ["override-must-stay"],
      taskContext: "irrelevant",
      maxPromptTokens: 30,
    });

    expect(output.systemPrompt).toContain("override-must-stay");
    expect(output.activatedSkillRefs).toEqual([]);
    expect(output.droppedInstructionRefs.some((ref) => ref.kind === "skill")).toBe(true);
    expect(
      output.droppedInstructionRefs.some(
        (ref) => ref.kind === "nearest_agents" && ref.label === "src/AGENTS.md",
      ),
    ).toBe(true);
  });
});