---
title: Troubleshooting
description: Common problems and how to diagnose and fix them.
---

This is a FAQ-style index of the issues most commonly hit when running AICR.
Each entry has a symptom, a diagnosis, and a fix. For deeper background on
the moving parts, follow the cross-links.

A good first step for any deployment issue is the
[`doctor` CLI command](/en/reference/cli/#doctor), which prints Node version,
resolved binary paths, sandbox-engine availability, and config sanity.

## Webhook auth failure (HMAC secret mismatch)

**Symptom:** the VCS reports the webhook delivered a non-2xx, or AICR logs a
signature verification failure; no run is scheduled.

**Diagnosis:** the HMAC secret configured on the VCS side does not match the
env var named in `triggers[].webhook_secret_env`. The two layers of inbound
auth are independent: `/webhooks/*` use HMAC, `/triggers/*` use an API key —
they are never combined on the same request.

**Fix:**

- Confirm the value in `.env` (e.g. `AICR_WEBHOOK_SECRET`) exactly matches the
  **Secret** field in the Gitea/GitHub webhook settings, or the **Secret
  token** for GitLab.
- Gitea/Forgejo verifies `x-gitea-signature-256`; GitHub verifies
  `x-hub-signature-256`; GitLab does a plain token comparison against
  `x-gitlab-token`.
- If `webhook_secret_env` is omitted on the trigger, signature verification
  is skipped (not recommended for production).

See [Authentication & secrets](/en/configuration/authentication/).

## Output channel not publishing

**Symptom:** a review completes with problems but nothing appears in the
destination channel; the run is marked skipped with
`skipReason="no_output_publisher"`.

**Diagnosis:** no summary route selected a publishable channel for that
event. This happens when the event's trigger/target_kind does not match any
`outputs.routes.rules[]` entry and there is no matching workspace-level
`outputs.summary`.

**Fix:** add an `outputs.routes.rules[].summary` rule or a workspace-level
`outputs.summary` entry for the trigger/target. For example, to send GitHub
push reviews to a Feishu bot:

```yaml
outputs:
  routes:
    rules:
      - match:
          trigger: github
          target_kind: push
        summary: [feishu-code-review]
```

If every configured summary channel suppresses a zero-problem result, the run
is instead skipped with `skipReason="no_problems_suppressed"`. See
[Output channels](/en/integrations/output-channels/) for the `no_problems`
policy and routing.

## Agent structured-output repair failure

**Symptom:** the agent produces only natural-language prose; AICR logs a
structured-repair attempt; the IM channel never receives a problem report.

**Diagnosis:** agent free-form stdout is never the final report. When stdout
has no parseable AICR tool payload, AICR asks the agent for a bounded
structured repair pass. If the repair output is still prose but clearly says
there are no actionable problems or no reviewable code, AICR normalizes it to
a skip (`lgtm` / `no_reviewable_code`) instead of publishing a fallback
error summary. Otherwise it falls back to a direct LLM repair call.

**Fix:** this is expected behavior, not a bug — it prevents interim reasoning
from leaking into IM cards and ensures problem locations come from
`aicr.report_problem`. If you expected problems, verify the agent has the
context it needs: it should request files through `aicr.fetch_more_context`
or inspect already-materialized source with read-only shell tools. See
[MCP tools](/en/integrations/mcp-tools/).

## Context overflow (`AgentContextOverflowError`)

**Symptom:** a review fails with `AgentContextOverflowError`, naming the
model limit and requested tokens.

**Diagnosis:** the agent CLI's conversation exceeded the model's context
window. Kilo only auto-compacts for models that declare a `contextWindow`; if
the model catalog is disabled and no `context_window` override is set, Kilo
silently skips compaction and large PRs overflow.

**Fix:**

- Enable `llm.model_catalog.enabled: true` so AICR injects `contextWindow`
  into the agent model info, **or**
- Set `context_window` explicitly under `llm.model_catalog.overrides`.
- For very large diffs, also tune `compression.trigger_tokens` (AICR derives
  a default from the context window when omitted).

See [Agent adapters](/en/integrations/agent-adapters/) for the per-agent
compaction behavior.

## Kilo MCP state not written

**Symptom:** a Kilo review finishes but AICR reports no structured results,
or the run loops / skips / starves.

**Diagnosis:** the Kilo-spawned MCP server wrote `.aicr-output-state.json`
under the wrong directory, so the orchestrator never saw it.

**Fix:**

- The container/sandbox workdir must be `/workspace/agent` (the writable
  agent mount). With any other workdir the state file lands under the image
  workdir (e.g. `/app`) and is missed.
- Confirm `.aicr-output-state.json` appears under the run's `agent/`
  directory after the agent calls an AICR tool.
- AICR clears stale state before each run; if you see "cannot access full
  repository code" published as a final report, a stale state file may have
  leaked — restart the container to reap any orphaned agent processes.

See [MCP tools](/en/integrations/mcp-tools/) for the output-state flow.

## Git / P4 / SVN extra-context fetch failure

**Symptom:** the orchestrator logs `ignored invalid fetch_more_context tool
call`, or the agent reports it cannot access a file the review needs.

**Diagnosis:** `aicr.fetch_more_context` only writes changed files initially.
A related-but-unchanged file the agent asks about (e.g. a header referenced
by a changed `.cpp`) is fetched on demand from VCS at the reviewed revision.
A request for a path that does not exist at that revision is rejected — that
rejection is the signal to stop retrying the path.

**Fix:**

- git: AICR falls back to `git show <revision>:<path>`; if that still fails,
  the path genuinely does not exist at the revision (or is a submodule
  gitlink) and the agent should stop retrying it.
- P4: related files are fetched with `p4 print <path>@<revision>` inside the
  configured depot; paths outside the depot are rejected.
- SVN: related files are fetched from `<repository_url>/<path>@<revision>`;
  URLs outside the configured `repository_url` are rejected.

Do not report missing files as inaccessible — request them through
`aicr.fetch_more_context` and let AICR materialize them.

## Podman rootless / nested container issues

**Symptom:** rootless Podman fails after a reboot or OOM with the misleading
error `"invalid internal status ... could not find any running process"`, or
`podman system migrate` crashes with a nil pointer.

**Diagnosis:** the real cause is storage-layer initialization failure when a
custom `rootless_storage_path` is set in `/etc/containers/storage.conf`, not
a missing pause process.

**Fix:** recover with `podman --storage-driver=overlay system migrate`, and
add `--storage-driver=overlay` to all `podman build/run/rm` commands in your
deploy script. Add a pre-flight check at the top of deploy scripts:

```bash
podman ps || podman --storage-driver=overlay system migrate
```

For nested container sandboxing (AICR itself running in a container), enable
it via `AICR_ENABLE_CONTAINER_SANDBOX=true bash deploy/deploy.sh` and prefer
`sandbox.kind: podman` with `engine: podman`. See
[Podman / rootless](/en/deployment/podman/).

## Feishu / WeCom Markdown rendering

**Symptom:** inline code or fenced code blocks render as literal backticks in
Feishu, or WeCom messages are cut off mid-sentence.

**Diagnosis & fix:**

- **Feishu** requires the JSON card 2.0 schema. AICR sends cards with
  `card.schema = "2.0"` so inline `code`, fenced code blocks with
  language-based highlighting, headings, blockquotes, and tables render
  natively. If you override a Feishu template, keep markdown elements under
  `card.body.elements` and do not downgrade headings/tables to plain text —
  those 1.0-era transforms actively harm 2.0 rendering.
- **WeCom** group-bot messages are truncated to 500 characters and
  suggestions to 300 characters (with a `...` suffix) to stay within size
  limits. Tables are flattened to plain-text rows. AICR applies
  `toWeComMarkdown()` automatically before dispatch.

See [Output channels](/en/integrations/output-channels/) for the per-channel
rendering notes.

## GitHub Pages base-path 404

**Symptom:** this documentation site (or any AICR web UI hosted on GitHub
Pages) returns 404 for assets or deep links.

**Diagnosis:** the Astro `site`, `base`, or `CNAME` setting no longer matches
the production GitHub Pages target. This documentation site is served from the
custom domain root at `https://aicr.atframe.work/`, so it must not use a
project-page `base` path.

**Fix:** in `astro.config.mjs`, keep `site` on the custom domain and do not set
`base`:

```js
export default defineConfig({
  site: "https://aicr.atframe.work",
  // ...
});
```

Keep `public/CNAME` set to `aicr.atframe.work`, and configure repository
Settings > Pages to publish from `gh-pages` / `/` with the same custom domain.

## Reviews hang or get progressively slower

**Symptom:** `durationMs` runs far past `agent.timeout_seconds`, and retries
get slower over time.

**Diagnosis:** an agent binary (e.g. Kilo) `setsid`s its worker subprocesses
into a new session, so a process-group signal does not reach them; they
survive, get reparented to PID 1, hold inherited stdio, and form a
CPU-exhaustion death spiral.

**Fix:** the sandbox kills the whole process tree on timeout, but to recover
a server already stuck in the spiral, **restart the container** so the
runtime reaps all orphaned processes. Ensure the container runs with `--init`
so PID 1 reaps zombies. This is covered in
[Docker Compose deployment](/en/start/docker-compose/).

## Run still references an old config after editing

**Symptom:** you edited `config.yaml` or `.env` but the server still uses
the old values.

**Diagnosis:** config and env files are volume-mounted, not baked into the
image, so they only reload on container restart.

**Fix:** `docker compose restart` (or restart your local `serve` process). A
full image rebuild is only needed for code changes.

## Dashboard shows setup-required / admin not configured

**Symptom:** `/dashboard` returns a setup-required page, or
`POST /api/admin/login` returns 401.

**Diagnosis:** the observability dashboard has a **separate** super-admin
login (`admin.*`) that is independent of webhook HMAC and trigger API keys.
If `admin.username_env` plus `admin.password_env` (or
`admin.password_hash_env`) are not set in `config.yaml`, or the referenced
env vars are empty, the dashboard is disabled.

**Fix:** set the three admin env vars and reference them in `config.yaml`:

```yaml
admin:
  username_env: AICR_ADMIN_USERNAME
  password_hash_env: AICR_ADMIN_PASSWORD_HASH   # sha256:<hex>, preferred
  session_ttl_seconds: 86400                      # 24 hours; the unit is seconds, not minutes
```

Restart the container after editing. Prefer `password_hash_env`
(`sha256:<hex>`) over raw `password_env` for production.

## GitHub issue/comment write-back fails with 403 / 404

**Symptom:** `github_problem_issue` or `github_pr_review` cannot post; the
log shows a 403 or 404 from the GitHub API.

**Diagnosis:** the `token_env` (or channel-level override) for a GitHub
channel that writes back to the repo must be an **outbound** API credential
with repository Issues read/write permission — it is not the webhook secret.
Selecting **Issues** or **Issue comments** in the GitHub webhook event list
only controls which **inbound** events are delivered; it does **not** grant
REST API permissions.

**Fix:**

- For a personal access token: ensure it has `repo` scope (or the fine-grained
  `Issues: Read and write` permission on the target repo).
- For a GitHub App: confirm the App is installed on the target account/organization,
  that every reviewed repository is selected in the installation, and that the App
  has `Contents Read`, `Pull requests Read/Write`, and `Issues Read/Write` permissions.
  Update the repository permission if needed, then **reinstall or refresh the
  installation** before retrying — permission changes do not apply retroactively to
  existing installations.
- Confirm the outbound credential is the resolved GitHub App token or the PAT
  referenced by `triggers[].token_env`, not `AICR_GITHUB_APP_WEBHOOK_SECRET`.
