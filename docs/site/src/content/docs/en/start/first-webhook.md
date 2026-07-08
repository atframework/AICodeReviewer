---
title: Your first webhook review
description: Wire a Gitea webhook into AICR, trigger the first PR review, and verify the run was scheduled.
---

This page walks through wiring a Gitea webhook into a running AICR server,
triggering the first pull-request review, and confirming the run was
scheduled and completed. For the full per-provider reference, see
[VCS providers](/en/integrations/vcs-providers/); for the auth model behind
webhook secrets, see [Authentication & secrets](/en/configuration/authentication/).

## Prerequisites

- AICR is running and `curl http://<aicr-host>:8080/healthz` returns `ok`.
  See [Quick start](/en/start/quick-start/).
- A [dry-run review](/en/start/dry-run/) already succeeded against a local
  checkout, so the LLM, agent, and sandbox are known-good.
- A Gitea repository you can administer.

## 1. Configure the trigger and a workspace

In `config.yaml`, declare the Gitea trigger and bind a workspace to it. The
trigger references the webhook secret by env-var **name**; the actual secret
value lives in `.env`.

```yaml
triggers:
  - name: gitea
    kind: gitea
    webhook_secret_env: AICR_WEBHOOK_SECRET
    base_url: https://gitea.example.com

outputs:
  channels:
    - name: gitea-pr-review
      kind: gitea_pr_review
      trigger: gitea
      token_env: AICR_GITEA_TOKEN
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]

workspaces:
  instances:
    my-repo:
      source_repo:
        trigger: gitea
        repo: "my-org/my-repo"
      outputs:
        line_comments: [gitea-pr-review]
        summary: [gitea-pr-review]
```

Generate a strong webhook secret and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```bash
# .env
AICR_WEBHOOK_SECRET=<generated-secret>
AICR_GITEA_TOKEN=<token-with-repo-read+comment-scope>
```

Restart the server so the new config takes effect:

```bash
docker compose restart   # or restart your local `serve` process
```

## 2. Add the webhook in Gitea

In the Gitea repository:

1. Go to **Repository → Settings → Webhooks → Add Webhook → Gitea**.
2. **Target URL**: `http://<aicr-host>:8080/webhooks/gitea`.
3. **Content type**: `application/json`.
4. **Secret**: paste the exact value of `AICR_WEBHOOK_SECRET` from your
   `.env`. A mismatch is the most common cause of webhook auth failure — see
   [Troubleshooting](/en/troubleshooting/).
5. **Events**: check **Pull Request**. To trigger an active re-review when a
   reviewer is requested, also enable the Gitea/Forgejo
   `pull_request_review_request` event; AICR fires on the `review_requested`
   action and ignores `review_request_removed`.
6. Save.

:::note[GitHub]
If you use a GitHub App, configure the App's **Webhook URL** to
`/webhooks/github`, set the **Webhook secret** to the same value as
`AICR_GITHUB_APP_WEBHOOK_SECRET`, and select the repositories AICR should access.
Subscribe to **Pull requests**, **Push**, **Issue comment**, and **Issues**. AICR
handles the `pull_request` `review_requested` action as a PR re-review trigger.

If you use a personal access token, point a repository webhook at `/webhooks/github`,
set the same HMAC secret, and subscribe to **Pull requests**.
:::

## 3. Trigger the first review

Open a pull request in the repository (or push a new commit to an existing
PR). Gitea will deliver a `pull_request` event to AICR.

For a push/commit event instead, push directly to a branch — AICR reviews
the commit range. Branch-create and branch-delete events (all-zero SHAs) are
skipped automatically.

You can also trigger a manual re-review at any time by commenting on the PR:

```text
/aicr review
```

In async mode, repeated `/aicr review` commands for the same target are
coalesced: the in-flight review finishes first, then AICR runs one final
re-review with the latest event.

## 4. Verify the run was scheduled

Watch the server logs for a scheduled run and a completed `reviewRun`:

```bash
docker compose logs -f | grep -E "reviewRun|dispatchCount"
```

Then check the destination:

- The PR should have an AICR review or summary comment (managed comments
  carry hidden `<!-- aicr:managed=pr-review -->` markers).
- If you configured a summary route to Feishu/WeCom, the IM channel should
  receive the aggregated report.

A final report that only says the full repository/source is inaccessible is
a **failed** verification unless the agent first requested concrete context
through `aicr.fetch_more_context` and AICR reran the final pass. See
[MCP tools](/en/integrations/mcp-tools/) for that flow.

## 5. Inspect a run (optional)

If you enabled the dashboard, visit `http://<aicr-host>:8080/dashboard` to
see the run in the recent-runs list, or read `/metrics` for process-level
counters. Run snapshots live under `workspaces/<workspace_id>/runs/<run_id>/`
— see [Dashboard and logs](/en/start/dashboard/).

## Next steps

- [Output channels](/en/integrations/output-channels/) — routing problems and
  summaries to PR comments, issues, and IM cards.
- [Troubleshooting](/en/troubleshooting/) — diagnosing webhook auth failures
  and "no output publisher" skips.
