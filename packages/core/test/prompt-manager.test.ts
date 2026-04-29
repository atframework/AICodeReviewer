import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assemblePrompt,
  discoverRepoPromptAssets,
  estimatePromptTokens,
  renderPromptTemplate,
} from "../src/prompt-manager.js";

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

  it("works without a maxPromptTokens budget (no trimming)", () => {
    const output = assemblePrompt({
      baseSystemPrompt: "<repo>\n{{REPO_INSTRUCTION_SUMMARIES}}\n</repo>\n<task>\n{{TASK_CONTEXT}}\n</task>",
      discovery: {
        instructions: [
          {
            kind: "root_agents" as const,
            label: "AGENTS.md",
            path: "AGENTS.md",
            content: "Keep commits small.",
            summary: "Keep commits small and focused.",
            reason: "repo-wide root AGENTS.md",
            priority: 300,
            specificity: 0,
          },
        ],
        skills: [],
        droppedRefs: [],
        conflicts: [],
      },
      taskContext: "Changed files: src/a.ts",
    });

    expect(output.systemPrompt).toContain("Keep commits small");
    expect(output.droppedInstructionRefs).toEqual([]);
    expect(output.tokenEstimate).toBeGreaterThan(0);
  });

  it("preserves conflicts from discovery output", () => {
    const output = assemblePrompt({
      baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
      discovery: {
        instructions: [],
        skills: [],
        droppedRefs: [],
        conflicts: [
          { winner: "src/AGENTS.md", loser: "AGENTS.md", reason: "nearest takes precedence" },
        ],
      },
      taskContext: "test",
    });

    expect(output.conflicts).toHaveLength(1);
    expect(output.conflicts[0]?.winner).toBe("src/AGENTS.md");
  });

  it("renders appliesTo qualifiers for path instructions in the assembled prompt", () => {
    const output = assemblePrompt({
      baseSystemPrompt: "<repo>\n{{REPO_INSTRUCTION_SUMMARIES}}\n</repo>",
      discovery: {
        instructions: [
          {
            kind: "path_instruction" as const,
            label: ".github/instructions/backend.instructions.md",
            path: ".github/instructions/backend.instructions.md",
            content: "Validate auth boundaries.",
            summary: "Validate auth and transaction boundaries.",
            reason: "matches src/auth/login.ts",
            priority: 410,
            specificity: 10,
            matchedPaths: ["src/auth/login.ts"],
            appliesTo: ["src/**/*.ts"],
          },
        ],
        skills: [],
        droppedRefs: [],
        conflicts: [],
      },
      taskContext: "test",
    });

    expect(output.systemPrompt).toContain("applies to `src/**/*.ts`");
    expect(output.repoInstructionSummaries[0]).toContain("applies to `src/**/*.ts`");
  });

  it("handles renderPromptTemplate values containing dollar signs and backslashes", () => {
    const result = renderPromptTemplate("value: {{VAL}}", {
      VAL: "$1\\2",
    });
    expect(result).toBe("value: $1\\2");
  });

  it("assembles the checked-in system prompt without unresolved runtime placeholders", async () => {
    const baseSystemPrompt = await readFile(
      join(process.cwd(), "prompts/system/code-reviewer.system.md"),
      "utf8",
    );

    const output = assemblePrompt({
      baseSystemPrompt,
      discovery: {
        instructions: [],
        skills: [],
        droppedRefs: [],
        conflicts: [],
      },
      taskContext: "Changed files: src/app.ts",
    });

    expect(output.systemPrompt).toContain("<mission>");
    expect(output.systemPrompt).toContain("<tool_protocol>");
    expect(output.systemPrompt).toContain("<task_context>");
    expect(output.systemPrompt).toContain("Changed files: src/app.ts");
    expect(output.systemPrompt).not.toContain("{{REPO_INSTRUCTION_SUMMARIES}}");
    expect(output.systemPrompt).not.toContain("{{ACTIVE_SKILL_SUMMARIES}}");
    expect(output.systemPrompt).not.toContain("{{MEMORY_HINTS}}");
    expect(output.systemPrompt).not.toContain("{{TASK_CONTEXT}}");
  });
});

describe("discoverRepoPromptAssets (additional)", () => {
  it("discovers repo-wide skills when no Applies To section is present", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-repo-skill-"));

    try {
      await writeWorkspaceFile(
        tempDir,
        ".agents/skills/general-review/SKILL.md",
        [
          "---",
          "name: general-review",
          'description: "General code review checklist."',
          "---",
          "",
          "# General Review",
          "",
          "## Procedure",
          "",
          "- Check naming conventions.",
          "",
        ].join("\n"),
      );

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/a.ts"],
      });

      expect(discovery.skills).toHaveLength(1);
      expect(discovery.skills[0]?.name).toBe("general-review");
      expect(discovery.skills[0]?.reason).toContain("repo-wide skill");
      expect(discovery.droppedRefs).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers different nearest AGENTS.md for changed paths in different directories", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-multi-agents-"));

    try {
      await writeWorkspaceFile(tempDir, "src/auth/AGENTS.md", "# Auth\nAuth-specific rules.\n");
      await writeWorkspaceFile(tempDir, "src/api/AGENTS.md", "# API\nAPI-specific rules.\n");

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/auth/login.ts", "src/api/endpoint.ts"],
      });

      const nearestInstructions = discovery.instructions.filter(
        (instruction) => instruction.kind === "nearest_agents",
      );
      expect(nearestInstructions).toHaveLength(2);
      expect(nearestInstructions.map((instruction) => instruction.path)).toEqual(
        expect.arrayContaining(["src/auth/AGENTS.md", "src/api/AGENTS.md"]),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers GEMINI.md as an alias instruction", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-gemini-"));

    try {
      await writeWorkspaceFile(tempDir, "GEMINI.md", "# Gemini\nCompatible alias for Gemini.\n");

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/a.ts"],
      });

      expect(discovery.instructions.some((instruction) => instruction.path === "GEMINI.md")).toBe(
        true,
      );
      expect(
        discovery.instructions.find((instruction) => instruction.path === "GEMINI.md")?.kind,
      ).toBe("alias");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns empty results for a source root with no AI assets", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-empty-"));

    try {
      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/a.ts"],
      });

      expect(discovery.instructions).toEqual([]);
      expect(discovery.skills).toEqual([]);
      expect(discovery.droppedRefs).toEqual([]);
      expect(discovery.conflicts).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("dedupes identical changed paths before discovery", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-dedup-"));

    try {
      await writeWorkspaceFile(tempDir, "AGENTS.md", "# Root\nRules.\n");

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/a.ts", "src/a.ts", "./src/a.ts"],
      });

      const nearest = discovery.instructions.find(
        (instruction) => instruction.kind === "nearest_agents",
      );
      expect(nearest?.matchedPaths).toEqual(["src/a.ts"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("aggregates multiple changed paths under the same nearest AGENTS.md", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-multi-paths-"));

    try {
      await writeWorkspaceFile(tempDir, "src/feature/AGENTS.md", "# Feature\nFeature rules.\n");

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/feature/a.ts", "src/feature/b.ts"],
      });

      const nearest = discovery.instructions.find(
        (instruction) => instruction.kind === "nearest_agents",
      );
      expect(nearest?.matchedPaths).toEqual(
        expect.arrayContaining(["src/feature/a.ts", "src/feature/b.ts"]),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts path instruction applyTo as a comma-separated string", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-string-applyto-"));

    try {
      await writeWorkspaceFile(
        tempDir,
        ".github/instructions/backend.instructions.md",
        ['---', 'applyTo: "src/**/*.ts, src/**/*.js"', '---', '', '# Backend', ''].join("\n"),
      );

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/a.js"],
      });

      expect(discovery.instructions.some((i) => i.path === ".github/instructions/backend.instructions.md")).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts skill Applies To entries wrapped in backticks", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-backtick-"));

    try {
      await writeWorkspaceFile(
        tempDir,
        ".agents/skills/api-review/SKILL.md",
        [
          "---",
          "name: api-review",
          'description: "Review API endpoints."',
          "---",
          "",
          "# API Review",
          "",
          "## Applies To",
          "",
          "- `src/api/**`",
          "",
        ].join("\n"),
      );

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/api/endpoint.ts"],
      });

      expect(discovery.skills).toHaveLength(1);
      expect(discovery.skills[0]?.name).toBe("api-review");
      expect(discovery.skills[0]?.appliesTo).toContain("src/api/**");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("estimatePromptTokens", () => {
  it("estimates more tokens for CJK text than for ASCII text of the same length", () => {
    const ascii = "Hello world test";
    const cjk = "你好世界测试";

    expect(estimatePromptTokens(cjk)).toBeGreaterThan(estimatePromptTokens(ascii));
  });

  it("estimates approximately 0.25 tokens per ASCII character", () => {
    const text = "aaaa";
    expect(estimatePromptTokens(text)).toBe(1);
  });

  it("estimates approximately 2 tokens per CJK character", () => {
    const text = "你好";
    expect(estimatePromptTokens(text)).toBe(4);
  });

  it("handles mixed ASCII and CJK text", () => {
    const text = "Hello你好";
    const asciiPart = estimatePromptTokens("Hello");
    const cjkPart = estimatePromptTokens("你好");
    expect(estimatePromptTokens(text)).toBe(asciiPart + cjkPart);
  });

  it("returns 0 for empty string", () => {
    expect(estimatePromptTokens("")).toBe(0);
  });

  it("handles surrogate pairs (emoji / rare CJK) correctly", () => {
    const text = "🎉";
    expect(estimatePromptTokens(text)).toBeGreaterThan(0);
  });
});

describe("renderPromptTemplate", () => {
  it("replaces all placeholders in the template", () => {
    const template = "<task>\n{{TASK_CONTEXT}}\n</task>\n<repo>\n{{REPO_INSTRUCTION_SUMMARIES}}\n</repo>";
    const result = renderPromptTemplate(template, {
      TASK_CONTEXT: "review target",
      REPO_INSTRUCTION_SUMMARIES: "instruction list",
    });

    expect(result).toContain("review target");
    expect(result).toContain("instruction list");
    expect(result).not.toContain("{{TASK_CONTEXT}}");
    expect(result).not.toContain("{{REPO_INSTRUCTION_SUMMARIES}}");
  });

  it("leaves unmatched placeholders unchanged", () => {
    const template = "<task>\n{{UNKNOWN_PLACEHOLDER}}\n</task>";
    const result = renderPromptTemplate(template, {});

    expect(result).toContain("{{UNKNOWN_PLACEHOLDER}}");
  });

  it("replaces all occurrences of the same placeholder", () => {
    const template = "{{TASK}} and {{TASK}} again";
    const result = renderPromptTemplate(template, { TASK: "review" });

    expect(result).toBe("review and review again");
  });
});

describe("discoverRepoPromptAssets conflict detection", () => {
  it("detects duplicate skill names and records conflicts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-skill-conflict-"));

    try {
      await writeWorkspaceFile(
        tempDir,
        ".agents/skills/security-check/SKILL.md",
        ["---", "name: security-check", 'description: "First security skill."', "---", "", "# First", ""].join("\n"),
      );
      await writeWorkspaceFile(
        tempDir,
        ".agents/skills/security-check-alt/SKILL.md",
        ["---", "name: security-check", 'description: "Second security skill."', "---", "", "# Second", ""].join("\n"),
      );

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/auth/login.ts"],
      });

      expect(discovery.conflicts.length).toBeGreaterThanOrEqual(1);
      expect(discovery.conflicts.some((c) => c.reason.includes("duplicate skill name"))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("detects overlapping path-instructions for the same changed paths", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-path-conflict-"));

    try {
      await writeWorkspaceFile(
        tempDir,
        ".github/instructions/backend.instructions.md",
        ['---', 'applyTo:', '  - "src/**/*.ts"', '---', '', '# Backend', ''].join("\n"),
      );
      await writeWorkspaceFile(
        tempDir,
        ".github/instructions/auth.instructions.md",
        ['---', 'applyTo:', '  - "src/auth/**/*.ts"', '---', '', '# Auth', ''].join("\n"),
      );

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/auth/login.ts"],
      });

      expect(discovery.instructions.filter((i) => i.kind === "path_instruction")).toHaveLength(2);
      expect(discovery.conflicts.length).toBeGreaterThanOrEqual(1);
      expect(discovery.conflicts.some((c) => c.reason.includes("overlapping path-instructions"))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("detects alias vs copilot-instruction conflicts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-alias-conflict-"));

    try {
      await writeWorkspaceFile(tempDir, "CLAUDE.md", "# Claude\nAlias instructions.\n");
      await writeWorkspaceFile(tempDir, ".github/copilot-instructions.md", "# Copilot\nCopilot instructions.\n");

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/a.ts"],
      });

      expect(discovery.conflicts.length).toBeGreaterThanOrEqual(1);
      expect(discovery.conflicts.some((c) => c.reason.includes("copilot-instruction takes precedence"))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns no conflicts for a clean source root", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-clean-"));

    try {
      await writeWorkspaceFile(tempDir, "AGENTS.md", "# Root\nRoot rules.\n");

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/a.ts"],
      });

      expect(discovery.conflicts).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses nearest AGENTS.md reason with matched paths for non-root files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-reason-"));

    try {
      await writeWorkspaceFile(
        tempDir,
        "src/feature/AGENTS.md",
        "# Feature\nFeature-level rules.\n",
      );

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["src/feature/sub/file.ts"],
      });

      const nearest = discovery.instructions.find((i) => i.kind === "nearest_agents");
      expect(nearest?.reason).toContain("matches src/feature/sub/file.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("walks up to root directory boundary when searching for AGENTS.md", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-prompt-manager-root-boundary-"));

    try {
      await writeWorkspaceFile(tempDir, "AGENTS.md", "# Root\nRoot rules.\n");

      const discovery = await discoverRepoPromptAssets({
        sourceRoot: tempDir,
        changedPaths: ["deeply/nested/file.ts"],
      });

      expect(discovery.instructions.some((i) => i.kind === "nearest_agents" && i.path === "AGENTS.md")).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});