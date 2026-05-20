# AICodeReviewer Deployment Example

This directory contains a ready-to-edit deployment configuration.

## Quick Start (Docker Compose)

```bash
cd example/

# 1. Create .env from sample and fill in secrets
cp .env.sample .env
# Edit .env: set AICR_LLM_API_KEY, AICR_GITEA_TOKEN, AICR_WEBHOOK_SECRET

# 2. Edit config.yaml: set your Gitea URL, repo, and model

# 3. Build and start
docker compose up -d

# 4. Verify
curl http://localhost:8080/healthz
```

## Quick Start (Local Node.js)

```bash
# From the repository root:

# 1. Install and build
pnpm install
pnpm build

# 2. Set environment variables
source example/.env   # or export them manually

# 3. Start the server
node packages/cli/dist/index.js serve \
  --config example/config.yaml \
  --port 8080
```

## Kilo Code Deployment Verification

Kilo Code is the primary deployment-test agent for AICodeReviewer. The repeatable Kilo CLI path can be used for automation, but a production deployment is not considered verified until at least one end-to-end run has been checked from Kilo Code with the same model and workspace configuration.

### Prerequisites

- Kilo Code installed for interactive verification. The deployment image installs `@kilocode/cli` so the service container has the `kilo` binary for automated runs.
- `agent.default: kilo` in `config.yaml`.
- A test Gitea/GitHub/GitLab PR or a P4 changelist that routes to a non-production output channel.
- Required secrets loaded through environment variables; do not copy token values into `config.yaml` or prompts.

### Verification flow

1. Start AICR locally or in the deployment environment.
2. In Kilo Code, run a review task against the same workspace that the service will use.
3. Confirm that AICR materializes Kilo provider config under the run `agent/` directory and injects the model provider from `llm.fallback_chain`.
4. Confirm Kilo receives the `aicr-output` MCP server config in the materialized `.kilo/kilo.json`, calls AICR tools, and writes `.aicr-output-state.json` in the run `agent/` directory. `aicr.fetch_more_context` requests should either return already mounted source content or be replayed by the orchestrator through VCS fetch and a final follow-up pass.
5. Trigger the review through the normal entry point, such as `/webhooks/gitea` or `/triggers/p4`.
6. Verify the AICR log contains a scheduled run and a completed `reviewRun` with a non-zero `dispatchCount` when an output route is configured.
7. Verify the destination channel received the report: PR/MR line comments, managed issue comments, Feishu card, or WeCom Markdown. A final report that only says the full repository/source is inaccessible should be treated as a failed verification unless it first requested concrete context through `aicr.fetch_more_context` and AICR reran the final pass.

### Automation supplement

Use Kilo CLI for repeatable smoke tests after the Kilo Code check:

```bash
kilo run --auto --model <model-id> --cwd <workspace-agent-dir> --timeout 600
```

The CLI smoke test must use the same model id and provider that AICR translates from `llm.providers` and `llm.fallback_chain`. If the CLI succeeds but Kilo Code fails, treat the deployment as not verified.

## Docker (without Compose)

```bash
# Build
docker build -t aicodereviewer -f deploy/Dockerfile .

# Run
docker run -d \
  --name aicr \
  --env-file example/.env \
  -p 8080:8080 \
  -v $(pwd)/example/config.yaml:/app/config.yaml:ro \
  -v aicr-data:/app/data \
  -v aicr-workspaces:/app/workspaces \
  -v aicr-logs:/app/logs \
  aicodereviewer
```

### Docker Socket backend

`docker_socket` uses the same container contract as `docker` but identifies runs that access the Docker daemon through a Unix socket. Configure it when the service itself runs inside a container that mounts `/var/run/docker.sock`:

```yaml
agent:
  sandbox:
    kind: docker_socket
    engine: docker
    image: ghcr.io/owent/aicr-agent:latest
```

No additional Docker Engine API client is required; AICR still invokes the `docker` CLI and relies on the host socket being available to the service container.

### Nested container sandbox (AICR inside a container)

When AICR itself runs inside a container and you want sandbox-spawned child containers for agent isolation, enable the nested container sandbox in `deploy.sh`:

```bash
AICR_ENABLE_CONTAINER_SANDBOX=true bash deploy/deploy.sh
```

This tells `deploy.sh` to:

1. Download a Docker static binary into the build context (talks to Podman's docker-compatible socket).
2. Mount the host user-level Podman socket into the AICR container.
3. Set `DOCKER_HOST` so the Docker CLI routes to the host Podman daemon.
4. Add `--userns=keep-id --group-add keep-groups` so the container user can access the socket.

When nested container sandboxing is disabled, `deploy.sh` still creates an empty `deploy/docker-static` placeholder in the source build context so clean syncs do not fail the Dockerfile's optional `COPY` step.

Requirements on the host:

```bash
# Enable user-level Podman socket (rootless)
systemctl --user enable --now podman.socket
```

In `config.yaml`, set `sandbox.kind: docker` (the Docker CLI inside the container talks to Podman):

```yaml
agent:
  sandbox:
    kind: docker
    engine: auto
```

See `docs/podman.md` for full details and troubleshooting.

## Configuring Gitea Webhook

After the server is running, add a webhook to your Gitea repository:

1. Go to **Repository → Settings → Webhooks → Add Webhook → Gitea**
2. **Target URL**: `http://<aicr-host>:8080/webhooks/gitea`
3. **Content type**: `application/json`
4. **Secret**: the same value as `AICR_WEBHOOK_SECRET` in your `.env`
5. **Events**: check `Pull Request`
6. Save

---

## Manual Re-review Comment Commands

On supported PR/MR comment events, users can request a fresh review without
changing the branch:

- `/aicr review`
- `/review`

The server translates those comments into normal `ReviewEvent` objects. In async
mode, repeated commands for the same target are coalesced: the current review
finishes first, then AICR runs one final re-review using the latest event.

For GitHub PR comments, configure a trigger `token_env` so AICR can fetch PR
head/base SHA and branch details. If that fetch is unavailable, AICR still uses
the PR URL from the comment payload as the deduplication identity instead of
collapsing unrelated PRs into an `unknown` target.

## PR/MR Summary Update Strategy

`gitea_pr_review` and `github_pr_review` default to
`review_update_strategy: update_existing`. AICR manages one scoped summary
comment per channel, identified by hidden `aicr:managed`, `aicr:scope`, and
`aicr:problems` markers. Later runs update the same comment, keep still-open
issues visible, and move disappeared fingerprints into a Resolved section.

Set `review_update_strategy: always_new` on a PR review channel if you prefer a
new summary comment for every run.

---

## Authentication & Secret Configuration

AICodeReviewer supports **three layers** of authentication:

| Layer             | Scope         | What it protects                                              | Config location                              |
| ----------------- | ------------- | ------------------------------------------------------------- | -------------------------------------------- |
| Webhook HMAC      | Per-trigger   | Verifies inbound webhook is from the real VCS (`/webhooks/*`) | `triggers[].webhook_secret_env`              |
| Server API key    | Global        | Protects `/triggers/*` routes (P4, custom scripts, etc.)      | `server.auth.api_key_env`                    |
| Workspace API key | Per-workspace | Same as server, but with workspace-specific keys              | `workspaces.instances.<id>.auth.api_key_env` |

> **Important**: `/webhooks/*` routes (Gitea, GitHub, GitLab) are protected **only by HMAC**.
> `/triggers/*` routes (P4, etc.) are protected by **API key**.
> These two layers are independent — webhook HMAC and API key are never combined on the same request.

### Layer 1: Webhook HMAC (per-trigger, recommended)

Each trigger kind uses a specific verification mechanism:

| Trigger kind            | Config field         | Mechanism        | HTTP header             | How to set on VCS side        |
| ----------------------- | -------------------- | ---------------- | ----------------------- | ----------------------------- |
| **gitea** / **forgejo** | `webhook_secret_env` | HMAC-SHA256      | `x-gitea-signature-256` | Gitea webhook → Secret field  |
| **github**              | `webhook_secret_env` | HMAC-SHA256      | `x-hub-signature-256`   | GitHub webhook → Secret field |
| **gitlab**              | `webhook_secret_env` | Token comparison | `x-gitlab-token`        | GitLab webhook → Secret token |
| **p4**                  | `server.auth`        | API key          | `x-api-key`             | p4-trigger.sh sends `X-API-Key` header |

GitHub and GitLab can each define **multiple trigger profiles on the same route** (`/webhooks/github` or `/webhooks/gitlab`). Use separate trigger names when repositories need different outbound tokens, webhook secrets, or file filters; AICR picks the final profile by the verified credential plus the repository identity from the webhook payload.

**Generate a secret:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Config example:**

```yaml
triggers:
  - name: gitea
    kind: gitea
    webhook_secret_env: AICR_WEBHOOK_SECRET  # env var holding the secret
```

**If `webhook_secret_env` is omitted, webhook signature verification is skipped** (not recommended for production).

### Layer 2: Server-level API key (triggers only, optional)

Protects `/triggers/*` routes with a shared API key. VCS webhooks (`/webhooks/*`)
are NOT affected — they use HMAC instead (see Layer 1).

Callers of trigger endpoints must send `X-API-Key: <key>` or `Authorization: Bearer <key>`.

```yaml
server:
  auth:
    api_key_env: AICR_API_KEY    # env var holding the global API key
    enabled: true                 # set false to temporarily disable
```

### Layer 3: Per-workspace API key (optional override)

Individual workspaces can have their own API keys:

```yaml
workspaces:
  instances:
    my-repo:
      source_repo: { trigger: gitea, repo: "org/repo" }
      auth:
        api_key_env: AICR_MY_REPO_API_KEY
        enabled: true
```

Both global and workspace keys are accepted — a request is allowed if it matches **any** configured key.

### P4 trigger script with API key

The P4 trigger endpoint (`/triggers/p4`) requires an API key when `server.auth`
is configured. Use the bundled `p4-trigger.sh`; it includes the `X-API-Key`
header and does not run `p4 describe` by default:

```bash
export AICR_URL="http://<aicr-host>:8080"
export AICR_API_KEY="<same value as server.auth.api_key_env>"

/path/to/p4-trigger.sh 12345 submitter-user submitter-client
```

`AICR_DEPOT_PATH` is optional. Leave it unset to use the P4 `depot_path`
configured in AICR server `config.yaml`; set it only when one script must
override the server-side depot for a special case.

Register the trigger with `%change% %user% %client%` so the script can forward
submitter metadata without needing to query P4 from inside the p4d process.
AICR treats the configured P4 client/workspace as the analysis workspace only;
it does not display that value as the submitter workspace when `%client%` is
omitted.

### Quick reference: which secrets go where

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ .env (environment variables — never committed to git)                   │
│                                                                         │
│ ── Inbound: Webhook HMAC secrets (protect /webhooks/*) ──              │
│ AICR_WEBHOOK_SECRET=7f3a...        ← shared with Gitea webhook config  │
│ AICR_GITHUB_WEBHOOK_SECRET=b2c1... ← shared with GitHub webhook config │
│ AICR_GITLAB_WEBHOOK_SECRET=d4e5... ← shared with GitLab webhook config │
│                                                                         │
│ ── Inbound: API key (protects /triggers/* like P4) ──                  │
│ AICR_API_KEY=c6d7e8f9...           ← p4-trigger.sh sends X-API-Key    │
│                                                                         │
│ ── Outbound: AICR calls external services ──                           │
│ AICR_GITEA_TOKEN=4b5d...           ← AICR → Gitea API (post comments) │
│ AICR_P4USER=p4-ci                  ← AICR → P4 server (fetch files)   │
│ AICR_P4PASSWORD=vUF_...            ← AICR → P4 server (fetch files)   │
│ AICR_FEISHU_SECRET=3Ob2...         ← AICR → Feishu API (send cards)   │
│ AICR_LLM_API_KEY=sk-...            ← AICR → LLM API (completions)     │
└─────────────────────────────────────────────────────────────────────────┘
```

## File Reference

| File                          | Purpose                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `config.yaml`                 | Main configuration — LLM, triggers, outputs, workspaces    |
| `.env.sample`                 | All environment variables with descriptions                |
| `docker-compose.yaml`         | Docker Compose stack definition                            |
| `../deploy/Dockerfile`        | Multi-stage Docker build                                   |
| `../docs/ai/index.md`         | AI-facing doc map for roadmap, architecture, and milestones |
| `../docs/output-channels.md`  | MCP report contract and output rendering guide             |

## Adding More Repositories

Add additional entries under `workspaces.instances` in `config.yaml`:

```yaml
workspaces:
  instances:
    my-first-repo:
      source_repo:
        trigger: gitea
        repo: "my-org/first-repo"
      outputs:
        line_comments: [gitea-pr-review]
        summary: [gitea-pr-review]

    my-second-repo:
      source_repo:
        trigger: gitea
        repo: "my-org/second-repo"
      outputs:
        line_comments: [gitea-pr-review]
        summary: [gitea-pr-review]
```

### Per-repo GitHub / GitLab profiles on one webhook route

When two GitHub or GitLab repositories need different auth or filtering rules,
define one trigger profile per repo (or per repo family) and bind each
workspace to the matching `source_repo.trigger`:

```yaml
triggers:
  - name: github-core
    kind: github
    token_env: AICR_GITHUB_CORE_TOKEN
    webhook_secret_env: AICR_GITHUB_CORE_WEBHOOK_SECRET

  - name: github-external
    kind: github
    token_env: AICR_GITHUB_EXTERNAL_TOKEN
    webhook_secret_env: AICR_GITHUB_EXTERNAL_WEBHOOK_SECRET
    include_cr_file: ["**/*.ts", "**/*.tsx"]

workspaces:
  instances:
    core-repo:
      source_repo:
        trigger: github-core
        repo: "my-org/core-repo"

    external-repo:
      source_repo:
        trigger: github-external
        repo: "partner-org/external-repo"
```

This keeps each repo on its own outbound token, webhook secret, and file-filter
set while still using the standard `/webhooks/github` or `/webhooks/gitlab`
endpoint.

## Zero-Problem Output Policy

Use `no_problems.action` to decide whether successful reviews with no actionable
problems should notify each channel. The default sample keeps notification
channels quiet and lets individual workspaces/channels opt in when an audit
trail is required.

```yaml
outputs:
  no_problems: { action: suppress }
  channels:
    - name: feishu-code-review
      kind: feishu_bot
      webhook_url_env: AICR_FEISHU_WEBHOOK
      no_problems: { action: suppress }

workspaces:
  instances:
    critical-service:
      source_repo: { trigger: gitea, repo: "my-org/critical-service" }
      outputs:
        summary: [feishu-code-review]
        channel_overrides:
          feishu-code-review:
            no_problems: { action: publish }
```

If all selected summary channels suppress a zero-problem result, the run is
recorded as skipped with `skipReason="no_problems_suppressed"`.

If an agent repair attempt only returns prose such as “no actionable problems”
or “no reviewable code”, AICR normalizes it to `skipReason="lgtm"` or
`skipReason="no_reviewable_code"` so IM channels do not receive a format-repair
fallback message.

## AICR Label Management

AICR can skip reviews based on labels and auto-tag PRs/MRs/issues when processing.

```yaml
review:
  labels:
    ignore: ["aicr:ignore", "aicr-ignore"]  # skip review if any label matches
    auto_tag: "aicr"                         # fixed tag added when AICR starts
    reviewed_tag: "aicr:reviewed"            # tag added when review completes
```

- **Ignore labels**: Checked at the webhook layer. If a PR/MR/issue carries any
  configured ignore label, AICR returns immediately without scheduling a review.
- **Auto tags**: Applied by output dispatchers (`gitea_pr_review`, `github_pr_review`,
  `gitlab_mr_review`, `gitea_issue`, `gitea_problem_issue`) when publishing results.
  Tags are created automatically if they do not exist.
- **Workspace override**: Set per-workspace `review.labels` to customize behavior
  for individual repositories.

## Managed Problem Issue Lifecycle Limit

`gitea_problem_issue` and `github_problem_issue` reconcile stale managed issues
by listing only the most recent open issues. Configure the cap globally under
`review.problem_issue.max_recent_issues` and override it per workspace when a
repository needs a tighter or looser lifecycle scan.

```yaml
review:
  problem_issue:
    max_recent_issues: 20  # default; valid range is 1..100

workspaces:
  instances:
    latency-sensitive-service:
      review:
        problem_issue:
          max_recent_issues: 10
```

If a repository has more open managed issues than the limit, fingerprints
outside the recent window are not deduplicated or closed in that run. Later
runs, or a temporarily raised cap, can be used for large cleanup runs.

## Non-PR Target Links

Built-in templates render `target.markdownLink` / `target.displayText` instead
of assuming every review is a PR. Gitea, Forgejo, GitHub, and GitLab commit
links are derived from trigger `base_url`, repo, and revision. P4/SVN/internal
systems can provide explicit URL templates:

```yaml
triggers:
  - name: p4-main
    kind: p4
    depot_path: "//depot/main"
    change_url_template: "https://swarm.example.com/changes/{{revision}}"
```

Template variables are URL-encoded before substitution. Use simple revision or
commit variables for path segments, and prefer automatic derivation for Git
providers when possible.

## CLI One-shot Review (dry-run)

Run a single review without starting the server:

```bash
export AICR_LLM_API_KEY=sk-xxx

node packages/cli/dist/index.js review \
  --config example/config.yaml \
  --repo "my-org/my-repo" \
  --provider gitea \
  --source-root . \
  --dry-run
```

---

## P4 (Perforce) Trigger Configuration

AICodeReviewer supports Perforce change-commit triggers. When a changelist is
submitted, P4 calls a script on the server that forwards the change details to
the AICR server.

### 1. Configure the P4 trigger in `config.yaml`

```yaml
triggers:
  - name: p4-main
    kind: p4
    port: "ssl:perforce.corp:1666"       # P4 server address:port
    user_env: AICR_P4USER                 # env var for P4 username
    password_env: AICR_P4PASSWORD         # env var for P4 password or ticket
    depot_path: "//depot/main"            # depot or stream path
    workspace: "aicr-p4-main"             # P4 workspace/client name
    # File filtering (all optional, omit = analyze everything)
    watch_path:
      - "src/"
      - "include/"
    include_cr_file:
      - "**/*.cpp"
      - "**/*.h"
    exclude_cr_file:
      - "**/*.gen.cpp"
      - "**/*.pb.h"
```

Add a workspace that references the P4 trigger:

```yaml
workspaces:
  instances:
    p4-main:
      source_repo:
        trigger: p4-main
        repo: "//depot/main"
      outputs:
        summary: [feishu-code-review]     # or any other output channel
```

### 2. File filtering fields

All three fields are **optional**. When set, they work as a three-stage filter
pipeline applied to the file list before code review:

| Field             | Type       | Description                                                                |
| ----------------- | ---------- | -------------------------------------------------------------------------- |
| `watch_path`      | `string[]` | Only analyze files under these depot-relative sub-paths. Omit = all paths. |
| `include_cr_file` | `string[]` | Glob patterns — a file **must match at least one** pattern to be analyzed. |
| `exclude_cr_file` | `string[]` | Glob patterns — a file matching **any** pattern is **skipped**.            |

**Filter pipeline**: `all changed files` → `watch_path filter` → `include filter` → `exclude filter` → `files to review`

**Glob syntax**:

- `**/*.cpp` — matches `foo.cpp`, `src/foo.cpp`, `a/b/c/foo.cpp` (any depth)
- `*.md` — matches file basenames at any depth, e.g. `readme.md` and `docs/readme.md`
- `src/**` — matches everything under `src/`
- `**/*.pb.*` — matches `foo.pb.h`, `foo.pb.cc`, etc.

**Example** — only review C++/C# source files, excluding generated protobuf code:

```yaml
watch_path:
  - "Client/Projects"
include_cr_file:
  - "*.h"
  - "*.hpp"
  - "*.cpp"
  - "*.cc"
  - "*.cs"
exclude_cr_file:
  - "*.pb.h"
  - "*.pb.cc"
  - "*.pb.go"
```

### 3. Register the trigger on the P4 server

Run `p4 triggers` and add an entry:

```text
aicr-review change-commit //depot/main/... "/path/to/p4-trigger.sh %change% %user% %client%"
```

Keep `%user%` and `%client%` in the trigger command. They are forwarded to AICR
as the changelist author and submitter client for Feishu/WeCom summaries; the
AICR adapter's configured P4 workspace is only the analysis client and is not
used as display-facing submitter metadata.

### 4. Create the trigger script

Copy [`p4-trigger.sh`](p4-trigger.sh) to the **P4 server host** (not inside the
AICR container) and make it executable:

```bash
cp example/p4-trigger.sh /path/to/p4-trigger.sh
chmod +x /path/to/p4-trigger.sh
```

Set these environment variables on the P4 server:

| Variable                | Required | Description                                                                                                                                     |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `AICR_URL`              | Yes      | AICR server address, e.g. `http://10.64.8.2:8090`                                                                                               |
| `AICR_API_KEY`          | Yes      | Must match `server.auth.api_key_env` in `config.yaml`                                                                                           |
| `AICR_DEPOT_PATH`       | No       | Optional depot path override. Leave unset to use the server-side P4 trigger `depot_path` from `config.yaml`.                                    |
| `AICR_P4_COLLECT_FILES` | No       | Default `0`. Keep disabled so the p4d trigger does not run `p4 describe` and does not require local `p4 trust`.                                 |
| `AICR_P4PORT`           | No       | Required only when `AICR_P4_COLLECT_FILES=1`; must be explicit, e.g. `ssl:p4.example.com:1666`.                                                 |
| `AICR_P4USER`           | No       | Optional user override for `AICR_P4_COLLECT_FILES=1`; otherwise the script uses trigger `%user%`, then `P4USER`, but never implicit OS `root`.  |
| `AICR_P4CLIENT`         | No       | Optional client override for `AICR_P4_COLLECT_FILES=1`; otherwise the script uses trigger `%client%`, then `P4CLIENT`.                          |
| `AICR_P4PASSWD`         | No       | Optional password or ticket for `AICR_P4_COLLECT_FILES=1`; use only with an explicit service user if your P4 security level requires login.     |
| `AICR_P4_AUTO_TRUST`    | No       | Optional `1`/`true` for the opt-in file collection mode; default `0`. Otherwise run `p4 trust` once as the trigger OS user.                     |

The script:

1. Posts the changelist number, user, client, and optional depot path to `/triggers/p4`
2. Does **not** run `p4 describe` by default, preventing p4d-side SSL trust prompts from blocking submits
3. Lets AICR fetch changelist details and files using the P4 connection configured in `config.yaml`
4. Warns locally if `%user%` or `%client%` are missing, because AICR will not substitute its analysis workspace as submitter metadata
5. Logs failures locally and exits successfully so the async reviewer never blocks the submit/commit path

During review, AICR keeps the initial P4 fetch scoped to changed files. If the
agent needs more evidence, it must use `aicr.fetch_more_context`: omit `range`
to fetch a full changed file when diff is unavailable, or request a narrowly
related file in the same configured depot when an API contract/call path is
needed. AICR resolves those related P4 files with `p4 print <path>@<change>`;
it does not sync the whole depot.

<details>
<summary>Full script source (p4-trigger.sh)</summary>

See [`p4-trigger.sh`](p4-trigger.sh). The script body is intentionally kept in
one file to avoid documentation drift.

</details>

### 5. Test manually

```bash
# Without API key (will fail if server.auth is enabled):
curl -X POST http://localhost:8080/triggers/p4 \
  -H "Content-Type: application/json" \
  -d '{"change":"12345","user":"testuser","depot_path":"//depot/main","files":["//depot/main/src/main.cpp"]}'

# With API key:
curl -X POST http://localhost:8080/triggers/p4 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"change":"12345","user":"testuser","depot_path":"//depot/main","files":["//depot/main/src/main.cpp"]}'
```

A successful response returns `{"accepted": true, ...}`.

---

## Feishu (飞书) Bot Configuration

AICodeReviewer can push aggregated review problems to a Feishu group via a
custom bot webhook.

### 1. Create a custom bot in Feishu

1. Open the target group → **Settings** → **Group Bots** → **Add Bot** →
   **Custom Bot**
2. Set the bot name and avatar
3. Copy the **webhook URL** (format: `https://open.feishu.cn/open-apis/bot/v2/hook/...`)
4. If you enable **signature verification** (recommended), copy the signing
   secret shown in the bot settings
5. Click **Save**

### 2. Set environment variables

```bash
# Required
export AICR_FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx"

# Required if signature verification is enabled in Feishu bot settings
export AICR_FEISHU_SECRET="your-signing-secret"
```

### 3. Configure the output channel

```yaml
outputs:
  channels:
    - name: feishu-code-review
      kind: feishu_bot
      webhook_url_env: AICR_FEISHU_WEBHOOK   # env var with the webhook URL
      secret_env: AICR_FEISHU_SECRET          # env var with signing secret (required if bot has signature verification)
      mention_author: true                     # @-mention the commit author
      mention_fallback: skip                  # what to do if author can't be resolved: "all" | "skip"
```

### 4. Route review events to Feishu

Use `outputs.routes` to direct specific triggers to the Feishu channel:

```yaml
outputs:
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]
    rules:
      # Route P4 commits to Feishu
      - match:
          trigger: p4-main
          target_kind: commit
        summary: [feishu-code-review]

      # Route GitHub push reviews to Feishu. Without a summary route, runs with
      # problems can be recorded as skipped with skipReason="no_output_publisher".
      - match:
          trigger: github
          target_kind: push
        summary: [feishu-code-review]
```

Or route at the workspace level:

```yaml
workspaces:
  instances:
    p4-main:
      source_repo:
        trigger: p4-main
        repo: "//depot/main"
      outputs:
        summary: [feishu-code-review]
```

### 5. Signature verification notes

When signature verification is enabled on the Feishu bot, every request must
include a `timestamp` and `sign` field. AICodeReviewer computes the signature
automatically using the secret from `secret_env`. The algorithm is:

```text
string_to_sign = timestamp + "\n" + secret
signature = Base64(HMAC-SHA256(key=string_to_sign, message=""))
```

If you see error `19021: sign match fail`, verify that the `secret_env` value
matches the signing secret shown in the Feishu bot configuration page.

---

## WeCom (企业微信) Bot Configuration

AICodeReviewer can push aggregated review problems to a WeCom group via a
group bot webhook.

### 1. Create a group bot in WeCom

1. Open the target group → **Group Settings** → **Group Bots** → **Add Bot**
2. Set the bot name and avatar
3. Copy the **webhook URL** (format: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`)
4. Click **Save**

### 2. Set environment variables

```bash
# Required
export AICR_WECOM_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx"
```

WeCom group bot webhooks do not use HMAC signature verification; no secret env var is needed.

### 3. Configure the output channel

```yaml
outputs:
  channels:
    - name: wecom-ops
      kind: wecom_bot
      webhook_url_env: AICR_WECOM_WEBHOOK
      mention_author: false                    # @-mention the commit author
      mention_fallback: skip                   # what to do if author can't be resolved: "all" | "skip"
      no_problems: { action: suppress }
      # mentioned_mobile_list: ["+86-13800138000"]  # optional: @ specific users by phone
```

### 4. Route review events to WeCom

Use `outputs.routes` to direct specific triggers to the WeCom channel:

```yaml
outputs:
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]
    rules:
      # Route P4 commits to WeCom
      - match:
          trigger: p4-main
          target_kind: commit
        summary: [wecom-ops]
```

Or route at the workspace level:

```yaml
workspaces:
  instances:
    p4-main:
      source_repo:
        trigger: p4-main
        repo: "//depot/main"
      outputs:
        summary: [wecom-ops]
```

### 5. Markdown rendering notes

WeCom group bot messages support a subset of Markdown: headings, bold, links,
inline code, and blockquotes are rendered natively. Tables are flattened to
plain-text rows. Code fences are preserved. AICodeReviewer applies
`toWeComMarkdown()` automatically before dispatch.

Messages are truncated to 500 characters and suggestions to 300 characters
with a `...` suffix to stay within WeCom message size limits.
