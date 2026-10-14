---
name: output-channel-contracts
description: "Maintain channel policy, templates, target links, mentions, and managed-issue publication; skip agent configuration or VCS fetching."
user-invocable: false
---

# Output Channel Guidance

Trace changes through `packages/core/src/config.ts`, server bootstrap/orchestrator,
`packages/outputs/src/index.ts`, `template-engine.ts`, and relevant tests.
Read only the corresponding section of `docs/output-channels.md` or architecture
§3.9–3.10 and §3.16 (v2 routing/runtime generation) when its design is needed.

## Shared invariants

- For Slack/Discord/Telegram, read [the protocol contract](../../../docs/design/slack-discord-telegram.md)
  and [official sources](../../../docs/ai/sources/slack-discord-telegram.md).
  For author reminders, trace channel mappings/API or file directory through
  `resolveSocialImAuthorId`, formatters and raw HTTP. Bot send permissions alone
  cannot resolve authors. Slack API profiles need users:read (email also needs
  users:read.email); Discord member lists need Server Members Intent; Telegram
  has no complete member-list API. Keep mapped IDs, file member keys and command
  actors separate. Insert native controls after escaping, reserve truncation
  space and allow only the resolved Discord user. API snapshots must be complete;
  failed refreshes suppress mentions. Cover actual payloads and old/new config
  publication in social mention tests and `runtime-generation.test.ts`.
  Review overlays copy AppConfig; use the generation's stable IM node as the
  registry owner (`imConnectionRegistryFor`) so per-client directory TTLs and
  readiness survive successive runs without leaking into a new generation.
  For batch authorization, `conversation_users` uses authenticated command context
  in explicit shared conversations; never substitute `any`, display names or
  inferred membership. Keep direct chats excluded and status ownership intact.
  Trace config → `SocialImClient` → raw HTTP → journal/outbox, and callback →
  current authorization → durable worker. ACK is admission only; missing receipts
  or expired `sending` leases remain unknown. Registration defaults to dry-run
  and never runs during bootstrap. Keep live-account evidence separate from fixtures.

  For setup failures, compare Slack's actual Bot token scopes with `scopes.bot`;
  user scopes and an uninstalled manifest change do not grant Bot permissions.
  Also verify the slash command definition, its Request URL and actual client
  invocation; the `commands` scope alone does not define `/aicr`.
  Select HTTP or Socket Mode explicitly; the app-wide switch must match the
  configured receiver. HTTP requires its saved slash URL and signing secret.
  Socket Mode requires a connections:write App-Level Token, verified hello App ID,
  envelope ACK and one receiving instance. Trace `slack-socket-mode.ts` through
  `processVerifiedSocialCommand`; never synthesize HTTP signatures or duplicate
  admission. Use the pinned SDK, explicit proxy dispatcher and silent SDK logger.
  Preserve other app settings; unsupported event/interactive envelopes are ACK-only.
  Cover real SDK handshake, identity rejection, hot reload, drain and reconnect
  with `slack-socket-mode.test.ts`. Connection logs do not prove command delivery.
  A Slack challenge-parameter error belongs to Events API URL verification;
  configure the command's Slash Commands URL and preserve existing App Agent
  event endpoints. This callback accepts form commands, not Events API JSON.
  For Discord, verify the app/guild command and Interactions Endpoint URL, then
  select its slash command and fill the `command` option. Both return initial replies inline
  (`social-callback.ts`), while Telegram uses the reply outbox. An absent inbox
  row may mean rejection before admission; require callback status/client error
  evidence before changing authentication, readiness or outbound permissions.
  Start the HTTP admission deadline before asynchronous generation/config reads
  in `callback-routes.ts`; carry that same deadline through body reads and the
  transaction. A late config result must not admit work after a 503. Cover stalled
  and rejected capture with `social-im-callbacks.test.ts`.
  For periodic `destination_not_ready`, trace cache expiry and refresh timing.
  Refresh before expiry and retain the original deadline during pending reads;
  successful checks renew it, failed checks revoke it. Share in-flight reads for
  the same client/destination so overlapping checks cannot overwrite each other
  out of order; release the pending entry on success and failure. Keep callbacks
  free of metadata network calls. Cover overlap, pending refresh, expiry and failure with
  `social-im-readiness.test.ts` and outputs `social-im.test.ts`.
  Never log raw callback bodies, signatures, response URLs or interaction tokens.
  If Telegram commands yield no updates and no message link is available, use the
  [documented membership-event check](../../../docs/site/src/content/docs/en/integrations/telegram.md)
  before webhook registration. Verify the exact Bot and group; preserve privacy
  and pending updates. Runtime registration still accepts `message` only, as
  covered by `social-im-registration.test.ts`; never add a target from its display name alone.

- Resolve empty-result policy per channel: built-in → `outputs.no_problems` →
  channel → workspace defaults → instance. `review.skip_lgtm` is review guidance,
  not output routing. Errors and managed lifecycle checks have separate rules.
- Resolve template sources in order: channel `templates.{problem,summary}` named
  reference into `outputs.templates` → workspace `templates/` directory lookup →
  built-in template. Named documents are markdown with optional frontmatter;
  only the body is rendered, and template text is never secret-sealed or redacted.
  Verify document create/update/restore and preview/audit paths, including names
  such as `token`/`example_env` and credential-shaped example text. Keep the
  exemption scoped to document bodies; real credential fields still seal/mask.
- Derive target context before rendering. Use PR/MR, commit, P4/SVN revision,
  scheduled/manual labels accurately; when no safe URL exists use a plain label.
  Validate allowed template variables and untrusted values.
- Ignore labels gate reception per event. Auto/reviewed tags belong to publishing,
  with global/workspace overrides and platform label resolution. Gitea managed
  issues include creation labels in `body.labels`.
- Test mixed-channel suppression/publication and relevant PR/non-PR templates.
  Local `raw.collected` results are pending, not delivery receipts; classify the
  actual flush or durable receipt for the same channel. Unflushed collection
  remains unknown, and repeated social summaries reuse the first flush outcome.
  For reply outbox exceptions, distinguish failure before POST from ambiguous
  sends: persist bounded pre-send retry/backoff, retain post-send fencing, and
  log fixed codes only. Cover both sides in `social-im-replies.test.ts`.
  Sync affected config/examples, output docs, public locales and roadmap entries;
  run applicable final gates from the repository baseline.
- For routing changes, compare preview with actual publisher calls in old/new
  generations. Legacy `outputs.routes.rules[].match.repo_ref` is an exact,
  case-sensitive repository reference and intersects trigger/target kind;
  keep narrower rules before broad rules and verify unrelated repos retain
  their selected channels in both core selection and bootstrap publishing.
  Trace `resolveOutputChannelsLegacy` and `routeMatchesEvent`; workspace
  output lists cannot override a non-empty matching legacy route.
  v2 route rules match on `target_kinds`, `triggers`, and
  `source.repo_ref` (`routingRuleMatchSchema` in `config.ts`, compiled by
  `config-compiler.ts`). Each event resolves publishers through the
  generation-scoped `outputPublisherResolver` (option declared at
  `review-orchestrator.ts:176`, invoked per event at ~3590 with
  `{ sourceRoot }`), falling back to an explicit `outputPublisher` when set.
  In v2 an explicit empty list closes that output kind; disabling
  the last rule must retain v2 semantics (runtime-generation/runtime-http tests).

## Conditional references

- `wecom_app` channels (implemented): connection references `im.connections`;
  recipients or one appchat target; reports split into UTF-8-safe 2048-byte
  parts with per-part publication receipts; only `40014`/`42001` refresh the
  token once; `wecom_bot` mobile mentions ride a bounded text reminder
  (text is the only surface with `mentioned_mobile_list`) and business
  `errcode != 0` fails the dispatch. See the channel table in
  [output contracts](../../../docs/output-channels.md).
- External member files (implemented): `member_directory.source: file` gives
  wecom_bot/wecom_app/feishu_bot typed native mentions — scoped vcs_accounts,
  author_mappings, guess-off defaults, one pinned snapshot per report, mobile
  members via one bounded text reminder. See
  [member-directory design](../../../docs/design/member-directory.md) and
  `resolveFileDirectoryMention` in server bootstrap.
- IM callbacks or command-triggered reviews: read the
  [IM design](../../../docs/design/im-integrations.md) and its
  [source record](../../../docs/ai/sources/im-integrations.md); load the
  [directory design](../../../docs/design/member-directory.md) only for file
  identity/reload work. Callback admission, the IM review worker, the reply
  outbox and report-card action buttons (feishu_app groups, wecom_app
  recipients) are wired; verify behavior changes against the
  [implementation specification](../../../docs/design/im-implementation-spec.md)
  and [acceptance IDs](../../../docs/design/im-acceptance.md). Do not treat
  proposed APIs as existing runtime; real-platform delivery is still
  unverified (see the roadmap in [AI docs](../../../docs/ai/index.md)).
  Keep mention identity separate from callback authorization; distinguish
  webhook bots, applications and API bots before selecting protocol behavior.
  On publication recovery, reuse the journaled card action id and await the
  send-side binding; a new opaque id changes the request and can duplicate a
  confirmed card. Reject malformed/oversized checkpoints before remote writes
  and retain the last durable journal. Check fresh-journal send counts in
  `im-card-issuance.test.ts` and failure fencing in `im-review-execution.test.ts`.
- PR buffering, update markers, duplicate collection, error summaries, or Markdown
  repair: [output pitfalls](../../../docs/ai/pitfalls/AGENTS.outputs.md).
- IM card/Markdown payloads, mentions, truncation, or structured repair:
  [IM message rules](references/im-bot-message-contracts.md).
  Directory identity guessing also changes the dedicated server prompt and
  model-group selection; check static/database publication and old/new runs.
  For Feishu application authentication, directory permissions or API payloads,
  also check the [Feishu source record](../../../docs/ai/sources/feishu.md).
- Managed issue scopes, `resolved_action`, file coverage, commit ancestry,
  diagnostic retention or resolution analysis:
  [managed issues](references/managed-problem-issues.md). Check `max_recent_issues`
  pagination, including a short Gitea page with a `Link: rel="next"` header.
- Automatic batch publication recovery:
  [scheduling](../../../docs/ai/pitfalls/AGENTS.scheduling.md) and
  [remote API specifications](../../../docs/ai/sources/publication-reconciliation.md). Check actual raw
  publisher calls, multiple summaries, lease/persistence interruption and
  buffered versus delivered output. A completed checkpoint replays local
  accounting only; publication-only recovery retains the original model usage.
  Exercise lost remote responses and local receipts with fresh journal/store
  instances; an unknown result cannot authorize a new non-idempotent write.
