import type { ChatCompletionClient, ModelSpec } from "@aicr/llm";

export interface IssueDetails {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly author: string;
  readonly url: string;
  readonly createdAt: string;
  readonly comments: readonly IssueComment[];
  readonly isPullRequest: boolean;
  readonly repository?: IssueRepository;
}

export interface IssueRepository {
  readonly owner: string;
  readonly repo: string;
}

export interface IssueComment {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface TriageDecision {
  readonly action: "keep_open" | "close";
  readonly reason: string;
  readonly category:
    | "valid"
    | "duplicate"
    | "spam"
    | "invalid"
    | "resolved"
    | "out_of_scope"
    | "needs_info"
    | "stale";
}

export interface TriageResult {
  readonly decision: TriageDecision;
  readonly issueNumber: number;
  readonly closed: boolean;
  readonly commentPosted: boolean;
  readonly closeSkippedReason?: "action_not_allowed" | "category_not_allowed" | "dry_run" | "missing_repository";
  readonly llmResponse: string;
}

export interface GiteaApiClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: (
    input: string,
    init?: {
      readonly method?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    },
  ) => Promise<{
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

function defaultFetch(): NonNullable<GiteaApiClientOptions["fetch"]> {
  const candidate = globalThis.fetch;
  if (!candidate) {
    throw new TypeError("No global fetch implementation is available.");
  }
  return candidate as unknown as NonNullable<GiteaApiClientOptions["fetch"]>;
}

export class GiteaApiClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: (
    input: string,
    init?: {
      readonly method?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    },
  ) => Promise<{
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;

  constructor(options: GiteaApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.token = options.token;
    const fetchCandidate = options.fetch;
    if (fetchCandidate) {
      this.fetchImpl = fetchCandidate;
    } else {
      this.fetchImpl = defaultFetch();
    }
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token) {
      headers.authorization = `token ${this.token}`;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gitea API ${method} ${path} returned ${response.status}: ${text}`);
    }

    return response.json();
  }

  async getIssue(owner: string, repo: string, number: number): Promise<IssueDetails> {
    const raw = await this.request(
      "GET",
      `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
    ) as Record<string, unknown>;
    const labels = Array.isArray(raw.labels)
      ? (raw.labels as readonly Record<string, unknown>[]).map(
          (l) => String(l.name ?? ""),
        )
      : [];
    const author = (raw.user as Record<string, unknown> | undefined)?.login ?? "";
    const comments: IssueComment[] = [];

    const commentCount = typeof raw.comments === "number" ? raw.comments : 0;
    if (commentCount > 0) {
      const rawComments = await this.request(
        "GET",
        `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
      ) as unknown[];
      for (const c of rawComments) {
        const comment = c as Record<string, unknown>;
        const commentUser = comment.user as Record<string, unknown> | undefined;
        comments.push({
          author: String(commentUser?.login ?? ""),
          body: String(comment.body ?? ""),
          createdAt: String(comment.created_at ?? ""),
        });
      }
    }

    return {
      number,
      title: String(raw.title ?? ""),
      body: String(raw.body ?? ""),
      state: String(raw.state ?? ""),
      labels,
      author: String(author),
      url: String(raw.html_url ?? ""),
      createdAt: String(raw.created_at ?? ""),
      comments,
      isPullRequest: Boolean(raw.pull_request),
      repository: { owner, repo },
    };
  }

  async closeIssue(
    owner: string,
    repo: string,
    number: number,
  ): Promise<unknown> {
    return this.request(
      "PATCH",
      `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
      { state: "closed" },
    );
  }

  async closePullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<unknown> {
    return this.request(
      "PATCH",
      `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
      { state: "closed" },
    );
  }

  async postIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
      { body },
    );
  }
}

export interface IssueTriageOptions {
  readonly llm: ChatCompletionClient;
  readonly model: ModelSpec;
  readonly giteaClient: GiteaApiClient;
  readonly actions?: readonly "close"[];
  readonly categoriesClose?: readonly TriageDecision["category"][];
  readonly dryRun?: boolean;
  readonly customPrompt?: string;
}

export interface WorkspaceIssueTriagePolicy {
  readonly actions?: readonly "close"[];
  readonly categoriesClose?: readonly TriageDecision["category"][];
  readonly dryRun?: boolean;
  readonly customPrompt?: string;
}

export interface IssueTriageRuntimeOptions extends IssueTriageOptions {
  readonly workspacePolicies?: Readonly<Record<string, WorkspaceIssueTriagePolicy>>;
}

const DEFAULT_CLOSE_CATEGORIES: readonly TriageDecision["category"][] = ["spam", "invalid"];

const DEFAULT_TRIAGE_SYSTEM_PROMPT = `You are an expert issue triage assistant for a software project. Your job is to analyze issues/PRs and determine if they should be kept open or closed.

Analyze the issue/PR content and respond with a JSON object:
{
  "action": "keep_open" | "close",
  "reason": "brief explanation of your decision",
  "category": "valid" | "duplicate" | "spam" | "invalid" | "resolved" | "out_of_scope" | "needs_info" | "stale"
}

Guidelines for closing:
- "spam": Clearly spam, advertising, or completely unrelated content
- "invalid": Not a real bug report or feature request, gibberish, or fundamentally misunderstanding the project
- "duplicate": Clearly a duplicate of an existing issue (if you can identify it from comments)
- "resolved": The issue has been resolved based on comments or the passage of time
- "out_of_scope": Feature requests that are explicitly outside the project's scope
- "stale": Issues with no activity and no clear actionable content

Guidelines for keeping open:
- "valid": Genuine bug reports, feature requests, or questions about the project
- "needs_info": Needs more information from the author but is a legitimate inquiry

IMPORTANT:
- When in doubt, prefer "keep_open". It is better to let humans review than to incorrectly close valid issues.
- Be very careful with non-English issues - they are just as valid as English ones.
- Do not close issues just because they are short or lack detail.
- Respond ONLY with the JSON object, no other text.`;

function buildTriageUserPrompt(issue: IssueDetails): string {
  const parts: string[] = [];
  parts.push(`## ${issue.isPullRequest ? "Pull Request" : "Issue"} #${issue.number}: ${issue.title}`);
  parts.push("");
  parts.push(`**Author:** ${issue.author}`);
  parts.push(`**State:** ${issue.state}`);
  parts.push(`**Labels:** ${issue.labels.length > 0 ? issue.labels.join(", ") : "none"}`);
  parts.push(`**Created:** ${issue.createdAt}`);
  parts.push("");

  if (issue.body) {
    parts.push("### Description");
    parts.push(issue.body);
    parts.push("");
  }

  if (issue.comments.length > 0) {
    parts.push(`### Comments (${issue.comments.length})`);
    for (const comment of issue.comments) {
      parts.push(`**@${comment.author}** (${comment.createdAt}):`);
      parts.push(comment.body);
      parts.push("");
    }
  }

  return parts.join("\n");
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseIssueRepositoryFromUrl(url: string): IssueRepository | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }

  const parts = path.split("/").filter(Boolean);
  const apiRepoIndex = parts.findIndex((part, index) =>
    part === "repos" && parts[index - 1] === "v1" && parts[index - 2] === "api"
  );
  if (apiRepoIndex !== -1 && parts[apiRepoIndex + 1] && parts[apiRepoIndex + 2]) {
    return {
      owner: decodePathSegment(parts[apiRepoIndex + 1]!),
      repo: decodePathSegment(parts[apiRepoIndex + 2]!),
    };
  }

  const issueMarkerIndex = parts.findIndex((part) => part === "issues" || part === "pulls");
  if (issueMarkerIndex >= 2) {
    return {
      owner: decodePathSegment(parts[issueMarkerIndex - 2]!),
      repo: decodePathSegment(parts[issueMarkerIndex - 1]!),
    };
  }

  return undefined;
}

function resolveIssueRepository(issue: IssueDetails): IssueRepository | undefined {
  return issue.repository ?? parseIssueRepositoryFromUrl(issue.url);
}

function getCloseSkippedReason(
  decision: TriageDecision,
  options: IssueTriageOptions,
): TriageResult["closeSkippedReason"] | undefined {
  if (decision.action !== "close") {
    return undefined;
  }

  const actions = options.actions ?? ["close"];
  if (!actions.includes("close")) {
    return "action_not_allowed";
  }

  const categoriesClose = options.categoriesClose ?? DEFAULT_CLOSE_CATEGORIES;
  if (!categoriesClose.includes(decision.category)) {
    return "category_not_allowed";
  }

  if (options.dryRun) {
    return "dry_run";
  }

  return undefined;
}

export function parseTriageDecision(llmResponse: string): TriageDecision {
  const trimmed = llmResponse.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/u);
  if (!jsonMatch) {
    return {
      action: "keep_open",
      reason: "Failed to parse LLM response",
      category: "valid",
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]!) as Record<string, unknown>;
    const action =
      parsed.action === "close" ? "close" : "keep_open";
    const validCategories = new Set([
      "valid",
      "duplicate",
      "spam",
      "invalid",
      "resolved",
      "out_of_scope",
      "needs_info",
      "stale",
    ]);
    const category = validCategories.has(String(parsed.category))
      ? String(parsed.category)
      : "valid";

    return {
      action,
      reason: String(parsed.reason ?? "No reason provided"),
      category: category as TriageDecision["category"],
    };
  } catch {
    return {
      action: "keep_open",
      reason: "Failed to parse LLM response as JSON",
      category: "valid",
    };
  }
}

export async function triageIssue(
  issue: IssueDetails,
  options: IssueTriageOptions,
): Promise<TriageResult> {
  const systemPrompt = options.customPrompt ?? DEFAULT_TRIAGE_SYSTEM_PROMPT;
  const userPrompt = buildTriageUserPrompt(issue);

  const result = await options.llm.complete({
    model: options.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const decision = parseTriageDecision(result.content);

  let closed = false;
  let commentPosted = false;
  let closeSkippedReason = getCloseSkippedReason(decision, options);

  if (decision.action === "close" && !closeSkippedReason) {
    const repository = resolveIssueRepository(issue);

    if (!repository) {
      closeSkippedReason = "missing_repository";
    } else {
      const commentBody = [
        `🤖 **Auto-triage result:** Closing this ${issue.isPullRequest ? "pull request" : "issue"}.`,
        "",
        `**Category:** ${decision.category}`,
        `**Reason:** ${decision.reason}`,
        "",
        "_This action was performed automatically by AICR (AI Code Reviewer). If you believe this was done in error, please reopen and add more context._",
      ].join("\n");

      try {
        await options.giteaClient.postIssueComment(repository.owner, repository.repo, issue.number, commentBody);
        commentPosted = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to post triage comment: ${message}`);
      }

      try {
        if (issue.isPullRequest) {
          await options.giteaClient.closePullRequest(repository.owner, repository.repo, issue.number);
        } else {
          await options.giteaClient.closeIssue(repository.owner, repository.repo, issue.number);
        }
        closed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to close ${issue.isPullRequest ? "pull request" : "issue"}: ${message}`);
      }
    }
  }

  return {
    decision,
    issueNumber: issue.number,
    closed,
    commentPosted,
    ...(closeSkippedReason ? { closeSkippedReason } : {}),
    llmResponse: result.content,
  };
}

export { DEFAULT_TRIAGE_SYSTEM_PROMPT };
