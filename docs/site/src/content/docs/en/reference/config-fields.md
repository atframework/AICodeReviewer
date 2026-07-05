---
title: Configuration field reference
description: Exhaustive reference of every config field, organized by top-level namespace and audited against the Zod schema.
---

This page is the exhaustive field reference for `config.yaml`. The code source
of truth is the Zod schema in `packages/core/src/config.ts`. This page is
audited against that schema; when they disagree, **the schema wins**. For the
narrative behind each namespace, follow the linked configuration page.

Each namespace below links to its narrative page and lists every field the
schema validates, with type, default, and a one-line description. Optional
fields without a schema default are marked *—* in the Default column.

## Enum reference

These enum values appear across multiple namespaces and are collected here for
quick lookup.

| Concept | Enum values |
| --- | --- |
| Trigger `kind` | `gitea`, `forgejo`, `github`, `gitlab`, `p4`, `svn`, `scheduled`, `manual` |
| Agent `kind` | `kilo`, `opencode`, `zoo`, `copilot-cli`, `claude-code` |
| Sandbox `kind` | `native`, `docker`, `podman`, `docker_socket`, `k8s_pod`, `firecracker` |
| Sandbox `engine` | `auto`, `docker`, `podman` |
| Queue `kind` | `memory`, `sqlite`, `redis`, `rabbitmq` (reserved) |
| Storage `database.kind` | `sqlite`, `postgres` |
| Storage `cache.kind` | `memory`, `redis`, `none` |
| Storage `object.kind` | `filesystem`, `s3` |
| Model catalog `cache.backend` | `sqlite`, `redis`, `memory` |
| LLM provider `kind` | `openai_compatible`, `azure_openai`, `anthropic`, `vertex_ai`, `bedrock`, `google_ai_studio`, `ollama`, `copilot` |

:::note[Channel `kind` is free-form]
The output channel `kind` field is a free-form string constrained by the
output registry, not a closed enum. Built-in channel kinds include
`gitea_pr_review`, `github_pr_review`, `gitlab_mr_review`, `gitea_issue`,
`gitea_problem_issue`, `github_issue`, `github_problem_issue`, `feishu_bot`,
and `wecom_bot`. The removed `gitea_finding_issue` kind is rejected by
validation; use `gitea_problem_issue`. See
[Output channels](/en/configuration/outputs/).
:::

## `llm`

Narrative: [LLM providers and models](/en/configuration/llm/).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `llm.providers[]` | array | `[]` | LLM provider connections; each has `id`, `kind`, and optional `base_url`, `api_key_env`, `api_version`, `catalog_provider`, `catalog_id` |
| `llm.providers[].id` | string | — | Provider identifier referenced from `fallback_chain` |
| `llm.providers[].kind` | enum | — | Provider kind (see LLM provider enum above) |
| `llm.providers[].base_url` | URL | — | Provider API base URL |
| `llm.providers[].api_key_env` | string | — | Env var name holding the API key |
| `llm.providers[].api_version` | string | — | API version (Azure, etc.) |
| `llm.providers[].catalog_provider` | string | — | Override the models.dev provider id for catalog lookup |
| `llm.providers[].catalog_id` | string | — | Override the models.dev `<provider>/<model>` id for catalog lookup |
| `llm.fallback_chain[]` | array | `[]` | Ordered provider/model entries tried on failure; each has `provider`, `model`, `role` (`light`/`heavy`/`any`) |
| `llm.retry` | object | — | Per-call retry policy |
| `llm.retry.max_attempts` | int > 0 | — | Max attempts per LLM call |
| `llm.retry.respect_retry_after` | boolean | — | Honor `Retry-After` headers |
| `llm.retry.backoff` | object | — | `kind` (`exponential`/`linear`/`constant`), `base_ms`, `max_ms`, `jitter` |
| `llm.retry.give_up_after_seconds` | number > 0 | — | Hard wall-clock give-up |
| `llm.budget` | object | — | Spend caps |
| `llm.budget.per_run_usd` | number ≥ 0 | — | Per-run USD cap |
| `llm.budget.per_repo_daily_usd` | number ≥ 0 | — | Per-repo daily USD cap |
| `llm.per_provider_overrides` | map | — | Per-provider `max_attempts` / `give_up_after_seconds` keyed by provider id |
| `llm.model_catalog` | object | see below | models.dev metadata catalog |

### `llm.model_catalog`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `llm.model_catalog.enabled` | boolean | `false` | Enable models.dev metadata lookup |
| `llm.model_catalog.source_url` | URL | `https://models.dev/api.json` | Catalog source |
| `llm.model_catalog.refresh_interval_hours` | int > 0 | `24` | Refresh interval |
| `llm.model_catalog.fetch_timeout_ms` | int > 0 | `10000` | Fetch timeout |
| `llm.model_catalog.offline` | boolean | `false` | Never touch the network; use cache + bundled snapshot only |
| `llm.model_catalog.apply_to_model_spec` | boolean | `true` | Merge catalog metadata into the resolved `ModelSpec` |
| `llm.model_catalog.cache.backend` | enum | `sqlite` | Refresh cache backend; `redis` requires `storage.cache.kind: redis` + `redis.url_env` |
| `llm.model_catalog.overrides` | map | `{}` | Hand-edited per-`<provider>/<model>` overrides; explicit values always win over catalog data |

## `triggers`

Narrative: [VCS providers](/en/integrations/vcs-providers/).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `triggers[].name` | string | — | Trigger profile name; referenced from `workspaces.instances.<id>.source_repo.trigger` |
| `triggers[].kind` | enum | — | Trigger kind (see enum table) |
| `triggers[].watch_path` | string[] | — | Only analyze files under these depot/repo-relative subpaths |
| `triggers[].include_cr_file` | string[] | — | Glob patterns; a file must match at least one to be analyzed |
| `triggers[].exclude_cr_file` | string[] | — | Glob patterns; a file matching any is skipped |
| `triggers[].commit_url_template` | string | — | URL template for commit links (variables are URL-encoded) |
| `triggers[].revision_url_template` | string | — | URL template for revision links |
| `triggers[].change_url_template` | string | — | URL template for changelist links (P4 Swarm, etc.) |

Provider-specific fields (`webhook_secret_env`, `token_env`, `port`,
`user_env`, `password_env`, `depot_path`, `workspace`, `repository_url`) are
accepted via `passthrough` validation and documented under
[VCS providers](/en/integrations/vcs-providers/) and
[Authentication & secrets](/en/configuration/authentication/).

## `workspaces`

Narrative: [Configuration overview](/en/configuration/overview/).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `workspaces.cache.max_total_gb` | number > 0 | `50` | Max total workspace cache size in GB |
| `workspaces.cache.eviction` | enum | `lru` | Eviction policy: `lru`, `mru`, `ttl` |
| `workspaces.cache.ttl_days` | int > 0 | `30` | TTL in days for `ttl` eviction |
| `workspaces.defaults` | object | `{}` | Defaults merged into every instance (sandbox, review, agent, outputs, prompt) |
| `workspaces.defaults.sandbox` | object | — | Default sandbox config (see `agent.sandbox`) |
| `workspaces.defaults.review` | object | — | Default review config (see `review`) |
| `workspaces.defaults.agent.default` | enum | — | Default agent kind for this workspace set |
| `workspaces.defaults.outputs` | object | — | Default outputs (see `outputs` workspace fields) |
| `workspaces.defaults.prompt.base_system_prompt_file` | string | — | Custom base system prompt file (deployment-root-relative) |
| `workspaces.defaults.prompt.force_skills` | string[] | — | Skill names always activated, ignoring `Applies To` globs |
| `workspaces.instances` | map | `{}` | Per-workspace instances keyed by workspace id |
| `workspaces.instances.<id>.source_repo.trigger` | string | — | Trigger profile name |
| `workspaces.instances.<id>.source_repo.repo` | string | — | Repository reference |
| `workspaces.instances.<id>.agent.default` | enum | — | Agent kind override |
| `workspaces.instances.<id>.review` | object | — | Review config override (see `review`) |
| `workspaces.instances.<id>.outputs` | object | — | Outputs override |
| `workspaces.instances.<id>.sandbox` | object | — | Sandbox override |
| `workspaces.instances.<id>.triage` | object | — | Issue triage override (Gitea/Forgejo only) |
| `workspaces.instances.<id>.prompt` | object | — | Prompt override (same shape as `workspaces.defaults.prompt`) |
| `workspaces.instances.<id>.auth.api_key_env` | string | — | Per-workspace API key env var |
| `workspaces.instances.<id>.auth.enabled` | boolean | `true` | Toggle per-workspace API key |

Workspace ids must not collide with the reserved keys `cache`, `defaults`,
`instances`.

## `outputs`

Narrative: [Output channels and routing](/en/configuration/outputs/).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `outputs.template_engine` | enum | `handlebars` | Template engine: `handlebars` or `eta` |
| `outputs.no_problems` | object | — | Global zero-problem policy |
| `outputs.no_problems.action` | enum | — | `publish`, `suppress`, or `publish_if_summary` |
| `outputs.channels[]` | array | `[]` | Output channel definitions |
| `outputs.channels[].name` | string | — | Channel name used in routes and template resolution |
| `outputs.channels[].kind` | string | — | Channel kind (free-form; constrained by the output registry) |
| `outputs.channels[].trigger` | string | — | Trigger name this channel is bound to |
| `outputs.channels[].mention_author` | boolean | — | `@`-mention the resolved commit author |
| `outputs.channels[].mention_fallback` | enum | — | `all` or `skip` when the author cannot be resolved |
| `outputs.channels[].no_problems` | object | — | Per-channel zero-problem policy |
| `outputs.channels[].commit_url_template` | string | — | Commit link template |
| `outputs.channels[].revision_url_template` | string | — | Revision link template |
| `outputs.channels[].change_url_template` | string | — | Changelist link template |
| `outputs.channels[].marker_prefix` | string | — | Managed-issue title prefix (default `[AICR]`) |
| `outputs.channels[].marker_label` | string | — | Hidden body marker scoping managed issues |
| `outputs.channels[].label_ids` | int[] | — | Gitea label IDs to attach |
| `outputs.channels[].labels` | string[] | — | GitHub label names to attach |
| `outputs.channels[].issue_mode` | enum | — | `per_problem`, `consolidated`, `per_commit` |
| `outputs.channels[].resolved_action` | enum | — | `none`, `close`, `mark_resolved`, `delete` (Gitea only) |
| `outputs.channels[].assign_committer` | boolean | — | Add the review author as assignee |
| `outputs.channels[].owners_file` | string | — | Owners file path (default `OWNERS`) |
| `outputs.channels[].add_owners_as_assignees` | boolean | — | Add matched OWNERS entries as assignees |
| `outputs.channels[].severity_label_prefix` | string | — | Auto-create/attach a severity label such as `aicr:problem:high` |
| `outputs.channels[].severity_label_colors` | map | — | Severity-to-color map for auto-created labels |
| `outputs.channels[].review_mode` | enum | — | `auto`, `review`, `comment` |
| `outputs.channels[].review_event` | enum | — | `COMMENT` or `REQUEST_CHANGES` |
| `outputs.channels[].review_update_strategy` | enum | — | `always_new` or `update_existing` |
| `outputs.channels[].notify_feishu` | object | — | Issue-created Feishu notification (`webhook_url_env`, optional `secret_env`) |
| `outputs.author_resolution` | object | — | `email_mappings` map and `email_blacklist` array |
| `outputs.routes.default` | object | — | Default route applied when no rule matches |
| `outputs.routes.rules[]` | array | `[]` | Ordered routing rules |
| `outputs.routes.rules[].match.trigger` | string | — | Trigger name to match |
| `outputs.routes.rules[].match.target_kind` | enum | — | Target kind (`pull_request`, `merge_request`, `push`, `commit`, etc.); `pr` is normalized to `pull_request` |
| `outputs.routes.rules[].line_comments` | string[] | — | Channel names to receive line-comment output |
| `outputs.routes.rules[].summary` | string[] | — | Channel names to receive summary output |

## `agent`

Narrative: [Agent and sandbox](/en/configuration/agent/).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `agent.default` | enum | `kilo` | Default agent kind |
| `agent.timeout_seconds` | int > 0 | `600` | Hard per-run timeout; on timeout the whole process tree is killed |
| `agent.auto_approve` | boolean | `true` | Auto-approve agent tool actions |
| `agent.sandbox` | object | `{ kind: "docker", engine: "auto" }` | Sandbox backend |
| `agent.sandbox.kind` | enum | — | Sandbox kind (see enum table) |
| `agent.sandbox.engine` | enum | — | Container engine selection |
| `agent.sandbox.image` | string | — | Container image to use |
| `agent.context_compaction` | object | `{ auto: true, prune: true }` | Conversation-level auto-compaction injected into each agent |
| `agent.context_compaction.auto` | boolean | `true` | Enable auto-compaction |
| `agent.context_compaction.threshold_percent` | int 1–100 | — | Compaction trigger threshold |
| `agent.context_compaction.prune` | boolean | `true` | Prune compacted history |

## `review`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `review.languages_auto_detect` | boolean | — | Auto-detect review languages |
| `review.include` | string[] | — | Glob patterns to include |
| `review.exclude` | string[] | — | Glob patterns to exclude |
| `review.max_files` | int > 0 | — | Max files per review |
| `review.max_patch_bytes` | int > 0 | — | Max patch size in bytes |
| `review.incremental` | boolean | — | Incremental review |
| `review.skip_lgtm` | boolean | — | Skip reviews that look clean |
| `review.output_language` | string | — | Output language for summaries (e.g. `zh-CN`) |
| `review.commit_strategy` | enum | — | `per_commit`, `aggregate`, `head_only` |
| `review.log_thinking` | boolean | — | Log model thinking traces |
| `review.git.allow_deepen` | boolean | — | Allow `git fetch --deepen` for shallow clones |
| `review.labels.ignore` | string[] | — | Labels that skip review |
| `review.labels.auto_tag` | string | — | Fixed tag added when AICR starts |
| `review.labels.reviewed_tag` | string | — | Tag added when review completes |
| `review.problem_issue.max_recent_issues` | int 1–100 | — | Cap on recent managed issues reconciled per run |
| `review.fetch_extra.max_bytes` | int > 0 | — | Max bytes fetched per extra-context request |
| `review.fetch_extra.max_files` | int > 0 | — | Max files fetched per extra-context request |
| `review.fetch_extra.allow_paths` | string[] | — | Allowed path globs for extra-context fetch |
| `review.reflection.enabled` | boolean | — | Enable reflection memory |
| `review.reflection.mode` | enum | — | `off`, `light`, `thorough` |
| `review.reflection.memory.max_size_kb` | int > 0 | — | Max memory size in KB |
| `review.reflection.memory.max_entries` | int > 0 | — | Max memory entries |
| `review.reflection.memory.retention_days` | int > 0 | — | Memory TTL in days |

## `queue`

Narrative: [Queue and retry](/en/configuration/queue/).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `queue.kind` | enum | `memory` | Queue backend |
| `queue.sqlite.path` | string | — | SQLite queue DB path |
| `queue.sqlite.lock_ttl_seconds` | int > 0 | — | Stale-running job reclaim TTL |
| `queue.workers.concurrency` | int > 0 | — | Global worker concurrency |
| `queue.workers.per_workspace_concurrency` | int > 0 | — | Per-workspace concurrency cap |
| `queue.workers.lock_ttl_seconds` | int > 0 | — | Worker lock TTL |
| `queue.rate_limit.per_provider_rps` | map | — | Per-provider requests-per-second cap |
| `queue.retry.attempts` | int > 0 | — | Trigger-level retry attempts (legacy `max_attempts` normalized) |
| `queue.retry.backoff` | object | — | `kind`, `base_ms`, `max_ms`, `jitter` |
| `queue.dead_letter.enabled` | boolean | — | Enable dead-letter handling |
| `queue.dead_letter.max_age_hours` | int > 0 | — | Max age before dead-lettering |

## `storage`

Narrative: [Storage](/en/configuration/storage/).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `storage.database.kind` | enum | `sqlite` | Database backend (`sqlite` or `postgres`) |
| `storage.database.sqlite.path` | string | `/app/data/aicr.sqlite` | SQLite DB path |
| `storage.database.postgres.url_env` | string | — | Postgres connection-string env var |
| `storage.cache.kind` | enum | `memory` | Cache backend |
| `storage.cache.redis.url_env` | string | — | Redis connection-string env var |
| `storage.cache.ttl_seconds` | int > 0 | — | Cache TTL |
| `storage.object.kind` | enum | `filesystem` | Object storage backend |
| `storage.object.filesystem.root` | string | `/app/data/objects` | Filesystem object root |
| `storage.object.s3.endpoint_url_env` | string | — | S3-compatible endpoint env var (AWS S3, MinIO, RustFS) |
| `storage.object.s3.bucket` | string | — | Bucket name |
| `storage.object.s3.region_env` | string | — | Region env var |
| `storage.object.s3.access_key_id_env` | string | — | Access key id env var |
| `storage.object.s3.secret_access_key_env` | string | — | Secret access key env var |
| `storage.object.s3.force_path_style` | boolean | — | Use path-style addressing (MinIO/RustFS) |
| `storage.retention.deleted_project_grace_days` | int ≥ 0 | `30` | Soft-deleted project grace period before hard delete |

## `compression`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `compression.trigger_tokens` | int > 0 | — | Token threshold that triggers diff compression |
| `compression.max_input_ratio` | number 0–1 | — | Max input ratio before compression |
| `compression.summarize_model_role` | string | — | Model role used for summarize stage (`light`/`heavy`/`any`) |
| `compression.keep_hunks_top_k` | int > 0 | — | Number of highest-risk hunks to keep verbatim |
| `compression.context_lines` | int > 0 | — | Context lines retained around kept hunks |
| `compression.per_model_overrides` | map | — | Per-model `trigger_tokens` overrides |

When `compression` is omitted, bootstrap derives a default
`trigger_tokens = min(131072, floor(contextWindow × 0.6))` from the review
model's context window.

## `server`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `server.port` | int > 0 | `8080` | HTTP listen port |
| `server.hostname` | string | `0.0.0.0` | Listen hostname |
| `server.trust_proxy` | boolean \| enum \| string[] | `false` | Trust proxy setting (`loopback`/`linklocal`/`uniquelocal` or CIDR list) |
| `server.base_url` | string | — | External base URL |
| `server.path_prefix` | string | — | URL path prefix (reverse-proxy subpath) |
| `server.auth.api_key_env` | string | — | Global API key env var (protects `/triggers/*`) |
| `server.auth.enabled` | boolean | `true` | Toggle global API key |

## `admin`

Narrative: [Dashboard and logs](/en/start/dashboard/).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `admin.username_env` | string | `AICR_ADMIN_USERNAME` | Admin username env var |
| `admin.password_env` | string | `AICR_ADMIN_PASSWORD` | Admin password env var |
| `admin.password_hash_env` | string | — | Admin password hash env var (`sha256:<hex>`); takes precedence over `password_env` |
| `admin.session_ttl_seconds` | int > 0 | `86400` | Session TTL in seconds (not minutes) |
