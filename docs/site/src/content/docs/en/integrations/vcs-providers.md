---
title: VCS providers
description: Connect GitHub, Gitea/Forgejo, GitLab, Perforce (P4), and Subversion (SVN) to AICR.
---

AICR ingests review events from two kinds of sources:

- **Webhook providers** — GitHub, Gitea, Forgejo, GitLab. They POST to
  `/webhooks/{gitea,forgejo,github,gitlab}` and are verified by HMAC or token.
- **Trigger providers** — Perforce (P4), Subversion (SVN). A server-side hook
  script POSTs minimal metadata to `/triggers/{p4,svn}`, authenticated by API
  key. AICR then uses its own VCS credentials to fetch the diff.

Both are normalized into one `ReviewEvent`. This page covers the config and
per-provider setup; the auth mechanism for each is summarized in
[Authentication & secrets](/en/configuration/authentication/).

## Webhook providers

### Gitea / Forgejo

Add a trigger and point a repository webhook at AICR.

```yaml
triggers:
  - name: gitea
    kind: gitea              # use "forgejo" for Forgejo instances
    base_url: https://git.example.com
    token_env: AICR_GITEA_TOKEN                 # outbound (post comments, read files)
    webhook_secret_env: AICR_WEBHOOK_SECRET      # inbound (HMAC verification)
    # Optional file filters (omit = analyze everything):
    # watch_path: ["src/", "include/"]
    # include_cr_file: ["**/*.cpp", "**/*.h"]
    # exclude_cr_file: ["**/*.gen.cpp"]
```

Webhook setup in Gitea:

1. **Repository → Settings → Webhooks → Add Webhook → Gitea**
2. **Target URL**: `http://<aicr-host>:8080/webhooks/gitea`
3. **Content type**: `application/json`
4. **Secret**: the same value as `AICR_WEBHOOK_SECRET`
5. **Events**: check **Pull Request**. For automatic re-review when a reviewer
   is requested, also enable the `pull_request_review_request` event; AICR
   triggers on the `review_requested` action and ignores
   `review_request_removed`.

### GitHub

```yaml
triggers:
  - name: github
    kind: github
    base_url: https://github.com     # optional for github.com; set to GHE URL for Enterprise
    token_env: AICR_GITHUB_TOKEN
    webhook_secret_env: AICR_GITHUB_WEBHOOK_SECRET
```

Point a repository webhook at `http://<aicr-host>:8080/webhooks/github`, set the
same HMAC secret as `AICR_GITHUB_WEBHOOK_SECRET`, and subscribe to **Pull
requests**. AICR handles the `pull_request` `review_requested` action as a PR
re-review trigger.

For comment-triggered re-reviews, configure `token_env` (or a GitHub App `app`
block — see below) so AICR can fetch PR head/base SHA and branch details. If
that fetch is unavailable, AICR uses the PR URL from the comment payload as the
dedup identity instead of collapsing unrelated PRs into an `unknown` target.

#### GitHub App authentication (M12)

Instead of a static PAT, configure a GitHub App to let AICR sign an RS256 JWT
and auto-refresh installation tokens (zero new dependencies):

```yaml
triggers:
  - name: github-app
    kind: github
    base_url: https://github.com     # GHE: set to your host; API derived as {base_url}/api/v3
    app:
      app_id: "123456"                # numeric App ID (or use client_id)
      private_key_env: AICR_GITHUB_APP_PRIVATE_KEY   # PEM or base64 PEM
      # private_key_path: /run/secrets/github-app.pem  # alternative: mounted .pem
      # installation_id: "7890123"     # optional; auto-resolved per repo if omitted
    webhook_secret_env: AICR_GITHUB_WEBHOOK_SECRET
```

`app` and `token_env` are mutually exclusive. Channel-level `token_env` takes
priority over the trigger-level `app` token. The trigger `base_url` is the host
(`https://github.com` or a GHE host); AICR derives the REST API base
(`https://api.github.com` or `{host}/api/v3`) for GitHub output channels routed
through this trigger, and leaves configs that already use an `.../api/v3` URL
unchanged. Minimum App permissions: Contents Read, Pull requests Read/Write,
Issues Read/Write, Metadata Read. Subscribe to Pull request, Push, Issue
comment, Issues. `installation` and `installation_repositories` events return
`202 unsupported_event`.

### GitLab

```yaml
triggers:
  - name: gitlab
    kind: gitlab
    base_url: https://gitlab.com
    token_env: AICR_GITLAB_TOKEN
    webhook_secret_env: AICR_GITLAB_WEBHOOK_SECRET   # sent as x-gitlab-token
```

GitLab verifies inbound webhooks by token comparison (the
`x-gitlab-token` header), not HMAC.

### Multiple profiles on one webhook route

GitHub and GitLab can each define **multiple trigger profiles on the same
route**. Use separate trigger names when repositories need different outbound
tokens, webhook secrets, or file filters; AICR picks the final profile by the
verified credential plus the repository `full_name` from the webhook payload.

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
      source_repo: { trigger: github-core, repo: "my-org/core-repo" }
    external-repo:
      source_repo: { trigger: github-external, repo: "partner-org/external-repo" }
```

## Trigger providers

Trigger providers don't receive VCS webhooks. Instead, a server-side hook on
the VCS server POSTs minimal metadata (change number, author, client) to AICR,
and AICR uses its **own** configured credentials to fetch the diff. The hook
endpoint is authenticated by the server API key (`X-API-Key` header), not HMAC.

### Perforce (P4)

```yaml
triggers:
  - name: p4-main
    kind: p4
    port: "ssl:perforce.corp:1666"      # prefix ssl: for TLS
    user_env: AICR_P4USER
    password_env: AICR_P4PASSWORD       # password or login ticket
    depot_path: "//depot/main"
    workspace: "aicr-p4-main"           # P4 client name used by AICR (analysis only)
    change_url_template: "https://swarm.example.com/changes/{{revision}}"
    watch_path: ["src/", "include/"]
    include_cr_file: ["**/*.cpp", "**/*.h"]
    exclude_cr_file: ["**/*.gen.cpp", "**/*.pb.h"]
```

Register the trigger with `p4 triggers`:

```text
aicr-review change-commit //depot/main/... "/path/to/p4-trigger.sh %change% %user% %client%"
```

Keep `%user%` and `%client%` in the trigger command — they are forwarded to
AICR as the changelist author and submitter client for report attribution. The
AICR adapter's configured P4 workspace is only the analysis client and is not
used as display-facing submitter metadata.

Copy `example/p4-trigger.sh` to the **P4 server host** (not the AICR container),
make it executable (`chmod +x`), and set these environment variables there:

| Variable | Required | Description |
| --- | --- | --- |
| `AICR_URL` | Yes | AICR server address, e.g. `http://10.64.8.2:8090` |
| `AICR_API_KEY` | Yes | Must match `server.auth.api_key_env` in `config.yaml` |
| `AICR_DEPOT_PATH` | No | Depot path override. Leave unset to use the server-side `depot_path` from `config.yaml`. |
| `AICR_P4_COLLECT_FILES` | No | Default `0`. Keep disabled so the p4d trigger does not run `p4 describe` and does not require local `p4 trust`. |
| `AICR_P4PORT` | No | Required only when `AICR_P4_COLLECT_FILES=1`; must be explicit, e.g. `ssl:p4.example.com:1666`. |
| `AICR_P4USER` | No | Optional user override for the opt-in collect mode; otherwise the script uses trigger `%user%`, then `P4USER` (never implicit OS `root`). |
| `AICR_P4CLIENT` | No | Optional client override for the opt-in collect mode; otherwise trigger `%client%`, then `P4CLIENT`. |
| `AICR_P4PASSWD` | No | Optional password/ticket for the opt-in collect mode; use only with an explicit service user if your P4 security level requires login. |
| `AICR_P4_AUTO_TRUST` | No | Optional `1`/`true` for the opt-in collect mode; default `0`. Otherwise run `p4 trust` once as the trigger OS user. |

The script does **not** run `p4 describe` by default, preventing p4d-side SSL
trust prompts from blocking submits. It logs failures locally and exits
successfully so the async reviewer never blocks the submit path.

Test the endpoint manually once the server is running:

```bash
# With API key (required when server.auth is enabled):
curl -X POST http://localhost:8080/triggers/p4 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"change":"12345","user":"testuser","depot_path":"//depot/main","files":["//depot/main/src/main.cpp"]}'
```

A successful response returns `{"accepted": true, ...}`.

### Subversion (SVN)

```yaml
triggers:
  - name: svn-main
    kind: svn
    repository_url: "https://svn.example.com/repos/project/trunk"  # required
    username_env: AICR_SVN_USER         # optional
    password_env: AICR_SVN_PASSWORD     # optional
    trust_server_cert: false            # keep false unless you pin trust externally
    revision_url_template: "https://svn.example.com/viewvc/project?view=revision&revision={{revision}}"
    watch_path: ["src/", "include/"]
    include_cr_file: ["**/*.cpp", "**/*.h"]
    exclude_cr_file: ["**/*.gen.cpp"]
```

`repository_url` is **required** for `/triggers/svn`. The post-commit hook
forwards only revision metadata; AICR uses the server-side `repository_url`
plus its own SVN credentials to fetch the diff. Payload repository URL fields
are ignored so an inbound hook cannot switch the reviewed repository.

Install a `post-commit` hook in the SVN repository `hooks/` directory:

```bash
#!/bin/bash
REPOS="$1"
REV="$2"
export AICR_URL="http://<aicr-host>:8080"
export AICR_API_KEY="<same value as server.auth.api_key_env>"
/path/to/svn-trigger.sh "$REPOS" "$REV"
```

Copy `example/svn-trigger.sh` to the SVN server host, make it executable
(`chmod +x`). The script needs `jq` and `svnlook` (both present in the SVN
server environment): `svnlook` reads author, log message, and changed paths,
then the script encodes them as JSON and POSTs to `/triggers/svn`. It does not
send a repository URL — AICR always uses the server-side `repository_url`.

Test the endpoint manually once the server is running:

```bash
# With API key (required when server.auth is enabled):
curl -X POST http://localhost:8080/triggers/svn \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"revision":"123","author":"testuser","files":["src/app.cpp"]}'
```

A successful response returns `{"accepted": true, ...}`.

## File filtering

All providers share the same three-stage filter pipeline, applied to the
changed-file list before review:

```text
all changed files → watch_path → include_cr_file → exclude_cr_file → files to review
```

| Field | Type | Behavior |
| --- | --- | --- |
| `watch_path` | `string[]` | Only analyze files under these depot/repository-relative sub-paths. Omit = all paths. |
| `include_cr_file` | `string[]` | Glob patterns; a file **must match at least one** to be analyzed. |
| `exclude_cr_file` | `string[]` | Glob patterns; a file matching **any** pattern is **skipped**. |

Glob syntax:

- `**/*.cpp` — matches `foo.cpp`, `src/foo.cpp`, `a/b/c/foo.cpp` (any depth)
- `*.md` — matches file basenames at any depth
- `src/**` — matches everything under `src/`
- `**/*.pb.*` — matches `foo.pb.h`, `foo.pb.cc`, etc.

## Manual re-review via comments

On supported PR/MR comment events, users can request a fresh review without
pushing a new commit:

- `/aicr review`
- `/review`

In async mode, repeated commands for the same target are coalesced: the
current review finishes first, then AICR runs one final re-review using the
latest event.

## Target links for non-PR reviews

Built-in templates render `target.markdownLink` / `target.displayText` instead
of assuming every review is a PR. Git commit links are derived from
`base_url` + repo + revision automatically. P4 and SVN can provide explicit
URL templates:

```yaml
triggers:
  - name: p4-main
    kind: p4
    change_url_template: "https://swarm.example.com/changes/{{revision}}"
  - name: svn-main
    kind: svn
    revision_url_template: "https://svn.example.com/viewvc/project?view=revision&revision={{revision}}"
```

Template variables are URL-encoded before substitution.
