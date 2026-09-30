import type { AppConfig, ImCommand } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import { ACTIVE_RUN_STATUSES, findImQueryProjectByAlias, getProjectStats, listImQueryLlmUsage, listImQueryRuns, listImQueryTriggerEvents, listPendingReviewDeferrals } from "@aicr/store";


/**
 * IM query commands (IM-11 query surface): read-only status views assembled
 * from the retained store history, trigger events, pending deferrals and the
 * live-run registry. Every listing is bounded and respects history retention
 * — pruned records answer "不存在或已移除". Repo aliases resolve only through
 * the binding's pre-registered repository targets (A04).
 */

export interface ImQueryServiceOptions {
  readonly store: StoreDb;
  readonly getConfig: () => Promise<AppConfig> | AppConfig;
  readonly now?: () => Date;
}

const LIST_LIMIT = 10;

function formatDateTime(value: Date | null | undefined, now: () => Date): string {
  if (value === null || value === undefined) return "-";
  const deltaMs = now().getTime() - value.getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return value.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function formatShortRevision(revision: string | null): string {
  if (revision === null) return "-";
  return revision.length > 12 ? revision.slice(0, 12) : revision;
}

function shortRepo(repoRef: string): string {
  return repoRef.length > 48 ? `…${repoRef.slice(-45)}` : repoRef;
}

/** Whether any enabled binding on the connection opted into wildcard aliases. */
function bindingAllowsAllRepositories(config: AppConfig, connectionName: string): boolean {
  for (const binding of Object.values(config.im?.command_bindings ?? {})) {
    if (binding.connection === connectionName && binding.enabled === true && binding.allow_all_repositories === true) return true;
  }
  return false;
}

/** Resolves the binding-registered repository target for an alias (A04). */
export function resolveBindingRepository(
  config: AppConfig,
  connectionName: string,
  repoAlias: string,
): { readonly workspaceId: string; readonly sourceTrigger: string; readonly repoRef: string } | undefined {
  for (const binding of Object.values(config.im?.command_bindings ?? {})) {
    if (binding.connection !== connectionName || binding.enabled !== true) continue;
    const target = binding.repositories?.[repoAlias];
    if (target !== undefined) {
      return { workspaceId: target.workspace, sourceTrigger: target.source_trigger, repoRef: target.repo_ref };
    }
  }
  return undefined;
}

function statusEmoji(status: string): string {
  if (status === "succeeded" || status === "published") return "✅";
  if (status === "failed") return "❌";
  if (status === "skipped") return "⏭️";
  return "⏳";
}

export class ImQueryService {
  private readonly options: ImQueryServiceOptions;

  constructor(options: ImQueryServiceOptions) {
    this.options = options;
  }

  private readonly now = (): Date => this.options.now?.() ?? new Date();

  /** Answers one parsed query command with reply text (undefined = no reply). */
  async answer(input: {
    readonly command: ImCommand;
    readonly connectionName: string;
  }): Promise<string> {
    const command = input.command;
    const config = await this.options.getConfig();
    switch (command.kind) {
      case "projects":
        return this.projects();
      case "reviews":
        return this.reviews(command.repoAlias === undefined ? undefined : await this.aliasTarget(config, input.connectionName, command.repoAlias));
      case "commits":
        return this.triggerEvents("commit", await this.aliasTarget(config, input.connectionName, command.repoAlias), command.branch);
      case "prs":
        return this.triggerEvents("pull_request", await this.aliasTarget(config, input.connectionName, command.repoAlias), command.branch);
      case "detail":
        return this.detail(await this.aliasTarget(config, input.connectionName, command.repoAlias), command.revision);
      case "prdetail":
        return this.prDetail(await this.aliasTarget(config, input.connectionName, command.repoAlias), command.prId);
      case "queue":
        return this.queue();
      case "running":
        return await this.running();
      default:
        return "未知查询命令。";
    }
  }

  private async aliasTarget(config: AppConfig, connectionName: string, repoAlias: string) {
    const registered = resolveBindingRepository(config, connectionName, repoAlias);
    if (registered !== undefined) return registered;
    // Wildcard bindings (A15d) resolve remaining aliases against observed projects.
    if (!bindingAllowsAllRepositories(config, connectionName)) return undefined;
    return await this.resolveProjectAlias(repoAlias);
  }

  /** Exact workspace-id or repo-ref match against the projects table. */
  async resolveProjectAlias(repoAlias: string): Promise<{ readonly workspaceId: string; readonly sourceTrigger: string; readonly repoRef: string } | undefined> {
    const project = await findImQueryProjectByAlias(this.options.store, repoAlias).catch(() => undefined);
    if (project === undefined || project.triggerName === null) return undefined;
    return { workspaceId: project.workspaceId, sourceTrigger: project.triggerName, repoRef: project.repoRef };
  }

  private async projects(): Promise<string> {
    const stats = await getProjectStats(this.options.store);
    if (stats.length === 0) return "尚无接入的项目（收到首个评审事件后会出现）。";
    const lines = stats.slice(0, 15).map(project =>
      `- ${project.displayName ?? project.workspaceId}（${shortRepo(project.repoRef)}）触发: ${project.triggerName}，评审 ${project.reviewCount} 次${project.isActive ? "" : " [已停用]"}`,
    );
    return [`接入的项目（${stats.length}）：`, ...lines].join("\n");
  }

  private async reviews(target: { readonly workspaceId: string } | undefined): Promise<string> {
    const runs = await listImQueryRuns(this.options.store, {
      ...(target !== undefined ? { workspaceId: target.workspaceId } : {}),
      limit: LIST_LIMIT,
    });
    if (runs.length === 0) return target === undefined ? "近期没有评审记录。" : "该项目近期没有评审记录。";
    const now = this.now;
    const lines = runs.map(run =>
      `${statusEmoji(run.status)} ${formatShortRevision(run.headSha)} ${run.status}${run.problemCount > 0 ? `（${run.problemCount} 问题）` : ""} ${shortRepo(run.repoRef)} ${formatDateTime(run.startedAt, now)}`,
    );
    return ["近期评审记录：", ...lines].join("\n");
  }

  private async triggerEvents(
    targetKind: "commit" | "pull_request",
    target: { readonly workspaceId: string; readonly repoRef: string } | undefined,
    branch: string | undefined,
  ): Promise<string> {
    if (target === undefined) return "未知的仓库别名（请先在命令绑定中注册 repositories 映射）。";
    const events = await listImQueryTriggerEvents(this.options.store, {
      targetKind,
      workspaceId: target.workspaceId,
      repoRef: target.repoRef,
      ...(branch !== undefined ? { branch } : {}),
      limit: LIST_LIMIT,
    });
    const label = targetKind === "commit" ? "会触发评审的提交" : "会触发评审的 PR/MR";
    if (events.length === 0) {
      return `该项目近期没有${label}${branch !== undefined ? `（分支 ${branch}）` : ""}。`;
    }
    const now = this.now;
    const lines = events.map(event => {
      if (targetKind === "commit") {
        return `- ${event.branch ?? "-"} ${formatDateTime(event.receivedAt, now)}${event.decision === "deferred" ? "（延迟执行）" : ""}`;
      }
      const prId = event.targetUrl?.split("/").filter(Boolean).pop() ?? "-";
      return `- !${prId} ${event.branch ?? "-"} ${formatDateTime(event.receivedAt, now)}${event.decision === "deferred" ? "（延迟执行）" : ""}`;
    });
    return [`${label}（${shortRepo(target.repoRef)}${branch !== undefined ? ` @ ${branch}` : ""}）：`, ...lines].join("\n");
  }

  private async detail(
    target: { readonly workspaceId: string; readonly repoRef: string } | undefined,
    revision: string,
  ): Promise<string> {
    if (target === undefined) return "未知的仓库别名（请先在命令绑定中注册 repositories 映射）。";
    const runs = await listImQueryRuns(this.options.store, {
      workspaceId: target.workspaceId,
      repoRef: target.repoRef,
      limit: 200,
    });
    const run = runs.find(candidate => candidate.headSha === revision
      || (candidate.headSha !== null && revision.length >= 7 && candidate.headSha.startsWith(revision)));
    if (run === undefined) return `未找到 ${revision} 的评审记录（仅保留近期记录，已归档或移除的详情不可查）。`;
    return this.runDetail(run);
  }

  private async prDetail(
    target: { readonly workspaceId: string; readonly repoRef: string } | undefined,
    prId: string,
  ): Promise<string> {
    if (target === undefined) return "未知的仓库别名（请先在命令绑定中注册 repositories 映射）。";
    const runs = await listImQueryRuns(this.options.store, {
      workspaceId: target.workspaceId,
      repoRef: target.repoRef,
      limit: 200,
    });
    const pattern = `%/${prId}`;
    const run = runs.find(candidate => candidate.targetUrl !== null
      && (candidate.targetUrl.endsWith(`/${prId}`) || candidate.targetUrl.includes(`/${prId}#`)));
    void pattern;
    if (run === undefined) return `未找到 PR/MR ${prId} 的评审记录（仅保留近期记录，已归档或移除的详情不可查）。`;
    return this.runDetail(run);
  }

  private async runDetail(run: {
    readonly id: string;
    readonly repoRef: string;
    readonly triggerName: string | null;
    readonly provider: string | null;
    readonly providerModel: string | null;
    readonly status: string;
    readonly problemCount: number;
    readonly durationMs: number | null;
    readonly startedAt: Date | null;
    readonly targetKind: string | null;
    readonly targetUrl: string | null;
    readonly branch: string | null;
    readonly headSha: string | null;
    readonly vcsKind: string | null;
    readonly headCommittedAt: Date | null;
    readonly error: string | null;
    readonly skipReason: string | null;
  }): Promise<string> {
    const now = this.now;
    const usageRows = await listImQueryLlmUsage(this.options.store, run.id);
    const tokensIn = usageRows.reduce((sum, row) => sum + row.tokensIn, 0);
    const tokensOut = usageRows.reduce((sum, row) => sum + row.tokensOut, 0);
    const cached = usageRows.reduce((sum, row) => sum + row.cachedTokens, 0);
    const requests = usageRows.reduce((sum, row) => sum + row.requestCount, 0);
    const cost = usageRows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    const cacheRate = tokensIn > 0 ? Math.round((cached / tokensIn) * 100) : 0;
    const models = [...new Set(usageRows.map(row => `${row.providerId}/${row.modelId}`))].join(", ");
    const lines = [
      `评审详情（${run.status}${run.problemCount > 0 ? `，${run.problemCount} 问题` : ""}）：`,
      `- 仓库: ${shortRepo(run.repoRef)} 分支: ${run.branch ?? "-"}`,
      `- 修订: ${run.headSha ?? "-"}（${run.vcsKind ?? "-"}）提交时间: ${formatDateTime(run.headCommittedAt, now)}`,
      `- 目标: ${run.targetKind ?? "-"}${run.targetUrl !== null ? ` ${run.targetUrl}` : ""}`,
      `- 触发: ${run.triggerName ?? "-"} 开始: ${formatDateTime(run.startedAt, now)}${run.durationMs !== null ? ` 耗时 ${Math.round(run.durationMs / 1000)}s` : ""}`,
      `- 模型: ${models || run.providerModel || "-"}`,
      `- 用量: 输入 ${tokensIn} / 输出 ${tokensOut} token，缓存命中 ${cacheRate}%（${cached}），请求 ${requests} 次${cost > 0 ? `，成本 $${cost.toFixed(4)}` : ""}`,
    ];
    if (run.error !== null) lines.push(`- 错误: ${run.error.slice(0, 120)}`);
    if (run.skipReason !== null) lines.push(`- 跳过原因: ${run.skipReason}`);
    lines.push("- 运行 ID: " + run.id);
    return lines.join("\n");
  }

  private async queue(): Promise<string> {
    const now = this.now;
    const deferrals = await listPendingReviewDeferrals(this.options.store).catch(() => []);
    const lines: string[] = [];
    for (const row of deferrals.slice(0, LIST_LIMIT)) {
      let repo = "-";
      let headSha = "-";
      try {
        const event = JSON.parse(row.reviewEvent) as { repoRef?: string; headSha?: string };
        repo = event.repoRef ?? "-";
        headSha = formatShortRevision(event.headSha ?? null);
      } catch { /* pruned/legacy rows answer with placeholders */ }
      lines.push(`- ${formatShortRevision(headSha)} ${shortRepo(repo)} 计划 ${formatDateTime(row.notBefore, now)}`);
    }
    if (lines.length === 0) return "当前没有排队中的任务。";
    return [`排队中的任务（${deferrals.length}）：`, ...lines].join("\n");
  }

  private async running(): Promise<string> {
    const runs = await listImQueryRuns(this.options.store, { statusIn: ACTIVE_RUN_STATUSES, limit: LIST_LIMIT });
    if (runs.length === 0) return "当前没有进行中的评审。";
    const now = this.now;
    const lines = runs.map(run =>
      `- ${formatShortRevision(run.headSha)} ${shortRepo(run.repoRef)} ${run.status}${run.providerModel ? ` @ ${run.providerModel}` : ""} 开始于 ${formatDateTime(run.startedAt, now)}`,
    );
    return ["进行中的评审：", ...lines].join("\n");
  }
}
