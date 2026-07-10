# IM Bot Message Contracts

Read this when changing Feishu, WeCom, DingTalk, Slack, or other IM bot rendering, markdown transformation, author mentions, or agent-output repair behavior.

## IM bot message contracts

All IM bot channels (`feishu_bot`, `wecom_bot`, and future channels such as `dingtalk_bot` or `slack_bot`) share a unified contract. Platform-specific differences (card vs markdown payload, mention dialect, signature algorithm) are absorbed by the dispatcher and `im-markdown.ts` transformer layers; the contracts below apply uniformly.

- `publishAggregatedProblems` must include the full `problem.message` and `problem.suggestion` (when present) under each problem line.
- IM reports stay sectioned as **Review target → Summary → Problems**; problem locations must come from structured `aicr.report_problem` data, not prose-only summaries.
- Agent CLI free-form stdout is not a publishable final report; repair to structured JSON/XML tool calls before summary-channel dispatch.
- If the repair result is still prose but explicitly says there are no actionable problems or no reviewable code, normalize it to `aicr.skip` (`lgtm` / `no_reviewable_code`) instead of publishing the generic format-repair fallback to IM.
- Summary text that says issues were found is not a problem record. If `problemCount` is zero, repair or suppress the summary instead of letting `no_problems` policy hide actionable prose without locations. Do the same when skip/summary prose asks a human to provide diff/source context or attribution context; agents must request concrete files via `aicr.fetch_more_context` or verified line attribution via `aicr.try_blame`.
- Built-in IM summaries must include the event username when present, rendering `@username (Display Name)` when both normalized username and display name are available. Platform-native mention tags (`<at>`, `<@user>`, etc.) are handled by the author-resolution layer via `MentionChannelKind`; templates render only the human-readable form.
- `vcs.workspace` is submitter metadata captured from the event payload; do not substitute analysis/client workspaces from adapter configuration into user-visible IM output.
- Long messages are truncated to 500 chars and suggestions to 300 chars with a `...` suffix to stay within platform card/message size limits.
- The truncation helper is internal; do not expose truncation length as user-configurable fields without updating tests and docs.
- Each IM platform uses a dedicated `toXxxMarkdown()` transformer in `packages/outputs/src/im-markdown.ts` to adapt generic Markdown to the platform's supported subset (e.g., Feishu cards flatten headings/tables, WeCom preserves headings, DingTalk converts tables to lists). When adding a new IM channel, implement a matching transformer before wiring the dispatcher.
