/**
 * Execution graph compiler tests (spec §6, tests R01–R07/R11/R12 + legacy
 * compatibility parity with the pre-routing runtime).
 */
import { describe, expect, it } from "vitest";

import {
  compileExecutionGraph,
  resolveAnalysisSelection,
  resolveOutputChannelsForEvent,
  resolveOutputChannelsLegacy,
  resolveOutputChannelsV2,
  resolveRouteForEvent,
  validateRoutingConfig,
  type RoutingEventContext,
} from "../src/config-compiler.js";
import { isConfigError } from "../src/config-format.js";
import { parseEffectiveConfig, type EffectiveConfigV2 } from "../src/config.js";

function configWith(overrides: Record<string, unknown>): EffectiveConfigV2 {
  return parseEffectiveConfig(
    {
      llm: {
        providers: [{ id: "main", kind: "ollama" }],
        model_chain: { default: [{ provider: "main", model: "m", role: "any" }], thorough: [{ provider: "main", model: "m", role: "any" }] },
      },
      triggers: [{ name: "github-main", kind: "github", token_env: "GH_TOKEN" }],
      outputs: {
        channels: [
          { name: "gh-review", kind: "github_pr_review", owner: "acme", repo: "svc", token_env: "GH_TOKEN" },
          { name: "gh-issue", kind: "github_issue", owner: "acme", repo: "svc", token_env: "GH_TOKEN" },
          { name: "chat", kind: "feishu_bot", webhook_url_env: "FEISHU_URL" },
        ],
      },
      workspaces: {
        defaults: {},
        instances: {
          "product-services": {},
          "legacy-ws": { outputs: { line_comments: ["gh-review"] } },
        },
      },
      ...overrides,
    },
    2,
  );
}

const PR_EVENT: RoutingEventContext = { triggerName: "github-main", targetKind: "pull_request", repoRef: "acme/svc-api" };

function rule(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: "r1", enabled: true, priority: 100, workspace: "product-services", ...overrides };
}

describe("validateRoutingConfig", () => {
  it("rejects duplicate rule ids with the entity path", () => {
    const config = configWith({ routing: { rules: [rule({}), rule({})] } });
    expect(() => validateRoutingConfig(config)).toThrowError(
      expect.objectContaining({ code: "duplicate_entity" }) as Error,
    );
  });

  it("rejects a rule targeting an unknown workspace (R03)", () => {
    const config = configWith({ routing: { rules: [rule({ workspace: "missing" })] } });
    expect(() => validateRoutingConfig(config)).toThrowError(
      expect.objectContaining({ code: "invalid_reference" }) as Error,
    );
  });

  it("rejects unknown model groups, channels and triggers", () => {
    expect(() =>
      validateRoutingConfig(configWith({ routing: { rules: [rule({ analysis: { model_chain: "ghost" } })] } })),
    ).toThrowError(expect.objectContaining({ code: "invalid_reference" }) as Error);
    expect(() =>
      validateRoutingConfig(configWith({ routing: { rules: [rule({ outputs: { summary: ["ghost"] } })] } })),
    ).toThrowError(expect.objectContaining({ code: "invalid_reference" }) as Error);
    expect(() =>
      validateRoutingConfig(configWith({ routing: { rules: [rule({ match: { triggers: ["ghost"] } })] } })),
    ).toThrowError(expect.objectContaining({ code: "invalid_reference" }) as Error);
  });

  it("rejects inline PR channels pinned to non-PR targets (R07)", () => {
    const config = configWith({
      routing: {
        rules: [rule({ match: { target_kinds: ["push"] }, outputs: { line_comments: ["gh-review"] } })],
      },
    });
    expect(() => validateRoutingConfig(config)).toThrowError(
      expect.objectContaining({ code: "routing_invalid" }) as Error,
    );
    // Same channel on a pull_request target is valid; issue channels are fine for push.
    expect(() =>
      validateRoutingConfig(
        configWith({
          routing: { rules: [rule({ match: { target_kinds: ["push"] }, outputs: { summary: ["gh-issue"] } })] },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a trigger controlled by both routing generations (R12)", () => {
    const config = configWith({
      outputs: {
        channels: [{ name: "gh-review", kind: "github_pr_review", owner: "a", repo: "b", token_env: "T" }],
        routes: { rules: [{ match: { trigger: "github-main" }, line_comments: ["gh-review"] }] },
      },
      routing: { rules: [rule({ match: { triggers: ["github-main"] } })] },
    });
    expect(() => validateRoutingConfig(config)).toThrowError(
      expect.objectContaining({ code: "routing_conflict" }) as Error,
    );
  });
});

describe("route resolution", () => {
  it("matches AND conditions with OR list elements and priority order (R01)", () => {
    const config = configWith({
      routing: {
        rules: [
          rule({ id: "low", priority: 10, match: { triggers: ["github-main"] } }),
          rule({
            id: "high",
            priority: 100,
            match: { triggers: ["github-main"], target_kinds: ["pull_request"], source: { repo_ref: { glob: "acme/*" } } },
          }),
        ],
      },
    });
    const graph = compileExecutionGraph(config);
    expect(graph.mode).toBe("v2");
    const hit = resolveRouteForEvent(graph, PR_EVENT);
    expect(hit).toEqual({ status: "matched", rule: expect.objectContaining({ id: "high" }) });
    // Repo outside the glob falls to the lower-priority trigger-wide rule.
    const other = resolveRouteForEvent(graph, { ...PR_EVENT, repoRef: "other/repo" });
    expect(other).toEqual({ status: "matched", rule: expect.objectContaining({ id: "low" }) });
    // Push events match only the low rule (high requires pull_request).
    const push = resolveRouteForEvent(graph, { ...PR_EVENT, targetKind: "push" });
    expect(push).toEqual({ status: "matched", rule: expect.objectContaining({ id: "low" }) });
  });

  it("raises ambiguous_route on a top-priority tie with conflicting outcomes (R02)", () => {
    const config = configWith({
      routing: {
        rules: [
          rule({ id: "a", priority: 100, match: { triggers: ["github-main"] } }),
          rule({ id: "b", priority: 100, workspace: "legacy-ws", match: { triggers: ["github-main"] } }),
        ],
      },
    });
    const graph = compileExecutionGraph(config);
    expect(() => resolveRouteForEvent(graph, PR_EVENT)).toThrowError(
      expect.objectContaining({ code: "ambiguous_route" }) as Error,
    );
  });

  it("accepts a top-priority tie when outcomes are identical", () => {
    const config = configWith({
      routing: {
        rules: [
          rule({ id: "a", priority: 100, match: { triggers: ["github-main"] } }),
          rule({ id: "b", priority: 100, match: { target_kinds: ["pull_request"] } }),
        ],
      },
    });
    const resolution = resolveRouteForEvent(compileExecutionGraph(config), PR_EVENT);
    expect(resolution.status).toBe("matched");
  });

  it("returns none without a match — no implicit workspace fallback (R06/R11)", () => {
    const config = configWith({
      routing: { rules: [rule({ match: { triggers: ["github-main"], source: { repo_ref: { exact: "acme/only" } } } })] },
    });
    const graph = compileExecutionGraph(config);
    expect(resolveRouteForEvent(graph, { ...PR_EVENT, repoRef: "acme/other" })).toEqual({ status: "none" });
  });

  it("disabled rules never match", () => {
    const config = configWith({ routing: { rules: [rule({ enabled: false })] } });
    expect(resolveRouteForEvent(compileExecutionGraph(config), PR_EVENT)).toEqual({ status: "none" });
  });

  it("a rule without repo_ref still requires admission context only — repoRef may be absent", () => {
    const config = configWith({ routing: { rules: [rule({ match: { triggers: ["github-main"] } })] } });
    const resolution = resolveRouteForEvent(compileExecutionGraph(config), { triggerName: "github-main", targetKind: "push" });
    expect(resolution.status).toBe("matched");
    // But a repo_ref condition on an event without a repoRef cannot match.
    const gated = configWith({
      routing: { rules: [rule({ match: { source: { repo_ref: { glob: "*" } } } })] },
    });
    expect(
      resolveRouteForEvent(compileExecutionGraph(gated), { triggerName: "github-main", targetKind: "push" }),
    ).toEqual({ status: "none" });
  });
});

describe("analysis layering (R04)", () => {
  it("layers global → defaults → instance → route with arrays replaced", () => {
    const config = configWith({
      llm: {
        providers: [{ id: "main", kind: "ollama" }],
        model_chain: { default: [{ provider: "main", model: "m", role: "any" }], thorough: [{ provider: "main", model: "m", role: "any" }] },
        default_model_chain: "default",
      },
      review: { max_files: 50, output_language: "zh-CN", include: ["**/*"] },
      workspaces: {
        defaults: { model_chain: "thorough", review: { output_language: "en" } },
        instances: { "product-services": { model_chain: "default", review: { max_files: 10 } } },
      },
      routing: {
        rules: [rule({ analysis: { model_chain: "thorough", review: { max_patch_bytes: 1000 } } })],
      },
    });
    const graph = compileExecutionGraph(config);
    const hit = resolveRouteForEvent(graph, PR_EVENT);
    if (hit.status !== "matched") throw new Error("expected a match");
    const selection = resolveAnalysisSelection(config, hit.rule.workspace, hit.rule);
    expect(selection.modelChain).toBe("thorough"); // route wins
    expect(selection.triageModelChain).toBe("thorough"); // falls back to main chain name
    expect(selection.review).toMatchObject({
      max_files: 10, // instance over global
      output_language: "en", // defaults over global
      max_patch_bytes: 1000, // route explicit
      include: ["**/*"], // global array survives (no layer replaced it)
    });
  });

  it("workspace instance beats defaults and llm.default_model_chain; triage falls back to main", () => {
    const config = configWith({
      llm: {
        providers: [{ id: "main", kind: "ollama" }],
        model_chain: { default: [{ provider: "main", model: "m", role: "any" }], thorough: [{ provider: "main", model: "m", role: "any" }] },
        default_model_chain: "thorough",
      },
      workspaces: { defaults: { model_chain: "default" }, instances: { ws: { model_chain: "thorough" } } },
    });
    const selection = resolveAnalysisSelection(config, "ws");
    expect(selection.modelChain).toBe("thorough");
    expect(selection.triageModelChain).toBe("thorough");
  });
});

describe("output channel selection", () => {
  it("v2: [] closes a kind, undefined inherits (R05)", () => {
    const config = configWith({
      outputs: {
        channels: [{ name: "chat", kind: "feishu_bot", webhook_url_env: "U" }],
        routes: { default: { summary: ["chat"] } },
      },
      workspaces: {
        defaults: { outputs: { summary: ["chat"] } },
        instances: { ws: { outputs: { line_comments: [], summary: [] } } },
      },
      routing: { rules: [rule({ workspace: "ws", outputs: { line_comments: ["chat"] } })] },
    });
    const graph = compileExecutionGraph(config);
    const hit = resolveRouteForEvent(graph, PR_EVENT);
    if (hit.status !== "matched") throw new Error("expected a match");
    // Route explicit list wins.
    expect(resolveOutputChannelsV2(config, "ws", "line_comments", hit.rule)).toEqual(["chat"]);
    // Instance [] would close when no route list exists.
    expect(resolveOutputChannelsV2(config, "ws", "summary", undefined)).toEqual([]);
    // Defaults inherit through when instance/route leave the kind undefined.
    const config2 = configWith({
      outputs: { channels: [{ name: "chat", kind: "feishu_bot", webhook_url_env: "U" }] },
      workspaces: { defaults: { outputs: { summary: ["chat"] } }, instances: { ws: {} } },
      routing: { rules: [rule({ workspace: "ws" })] },
    });
    expect(resolveOutputChannelsV2(config2, "ws", "summary", undefined)).toEqual(["chat"]);
  });

  it("v2: no match means empty channels — no first-channel fallback (R06)", () => {
    const config = configWith({ routing: { rules: [rule({ workspace: "ws" })] } });
    expect(resolveOutputChannelsV2(config, "ws", "line_comments", undefined)).toEqual([]);
  });

  it("legacy: first matching route rule wins, empty arrays fall through (R05 parity)", () => {
    const base = {
      outputs: {
        channels: [{ name: "gh-review", kind: "github_pr_review", owner: "a", repo: "b", token_env: "T" }],
        routes: {
          rules: [
            { match: { trigger: "github-main", target_kind: "pull_request" }, line_comments: ["gh-review"] },
            { match: { trigger: "github-main" }, line_comments: [] },
          ],
          default: { line_comments: ["gh-review"] },
        },
      },
      workspaces: { defaults: {}, instances: { ws: {} } },
    };
    const config = parseEffectiveConfig(base, 1);
    // Matched rule with non-empty list wins.
    expect(resolveOutputChannelsLegacy(config, PR_EVENT, "ws", "line_comments")).toEqual(["gh-review"]);
    // Empty rule list falls through to the default layer (legacy semantics).
    const push = { ...PR_EVENT, targetKind: "push" as const };
    expect(resolveOutputChannelsLegacy(config, push, "ws", "line_comments")).toEqual(["gh-review"]);
  });

  it("legacy: line_comments falls back to the first *_pr_review channel", () => {
    const config = parseEffectiveConfig(
      {
        outputs: { channels: [{ name: "gh-review", kind: "github_pr_review", owner: "a", repo: "b", token_env: "T" }] },
        workspaces: { defaults: {}, instances: { ws: {} } },
      },
      1,
    );
    expect(resolveOutputChannelsLegacy(config, PR_EVENT, "ws", "line_comments")).toEqual(["gh-review"]);
    expect(resolveOutputChannelsLegacy(config, PR_EVENT, "ws", "summary")).toEqual([]);
  });

  it("unified entry dispatches by graph mode", () => {
    const legacy = parseEffectiveConfig(
      {
        outputs: { channels: [{ name: "gh-review", kind: "github_pr_review", owner: "a", repo: "b", token_env: "T" }] },
        workspaces: { defaults: {}, instances: { ws: {} } },
      },
      1,
    );
    const legacyGraph = compileExecutionGraph(legacy);
    expect(legacyGraph.mode).toBe("legacy");
    expect(resolveOutputChannelsForEvent(legacy, legacyGraph, PR_EVENT, "ws", "line_comments")).toEqual(["gh-review"]);

    const v2 = configWith({ routing: { rules: [rule({ workspace: "product-services" })] } });
    const v2Graph = compileExecutionGraph(v2);
    expect(resolveOutputChannelsForEvent(v2, v2Graph, PR_EVENT, "product-services", "line_comments")).toEqual([]);
  });
});

describe("v2 effective schema", () => {
  it("rejects routing in a v1 document and accepts it at v2", () => {
    expect(() => parseEffectiveConfig({ routing: { rules: [] } }, 1)).toThrow();
    expect(() => parseEffectiveConfig({ routing: { rules: [] } }, 2)).not.toThrow();
  });

  it("routing rule values validate shape (matcher union, analysis subset)", () => {
    expect(() =>
      parseEffectiveConfig(
        { routing: { rules: [rule({ match: { source: { repo_ref: { exact: "a", glob: "b" } } } })] } },
        2,
      ),
    ).toThrow();
    expect(() =>
      parseEffectiveConfig({ routing: { rules: [rule({ analysis: { provider: "x" } })] } }, 2),
    ).toThrow();
  });

  it("isConfigError distinguishes compiler errors", () => {
    const config = configWith({
      routing: {
        rules: [
          rule({ id: "a", priority: 5, match: { triggers: ["github-main"] } }),
          rule({ id: "b", priority: 5, workspace: "legacy-ws", match: { triggers: ["github-main"] } }),
        ],
      },
    });
    try {
      resolveRouteForEvent(compileExecutionGraph(config), PR_EVENT);
      expect.unreachable();
    } catch (error) {
      expect(isConfigError(error, "ambiguous_route")).toBe(true);
    }
  });
});
