# VCS Context and Batch Diffs

Read for Git/SVN/P4 context, attribution, or diff changes. Sources and tests:
`packages/vcs/src/{git,svn,p4}.ts`, `packages/vcs/test/`, and orchestrator context tests.

## Git and attribution

- Scoped fetch materializes changed files only. Missing related files need
  `git show <headRevision>:<path>` fallback, then persistence into the workspace;
  do not treat a failed disk read as proof the repository lacks the file.
- Gitlinks are not blobs. On show failure inspect the path and its ancestors with
  `ls-tree`; use the submodule's pinned commit and `.gitmodules` URL. Resolve
  relative URLs against the parent remote, pass tokens only to same-host HTTP(S),
  and redact failure notes. Exact gitlink requests return a root tree listing;
  descendants return the requested file. Do not recursively fetch all submodules.
- Submodule retries must recover partial clone directories and fetch the pinned
  commit even when not reachable from advertised refs. An unavailable URL/commit
  yields an explanatory redacted response, not an unbounded warning/retry loop.
- Validate command parsers against real Git/SVN/P4 output. Git blame porcelain
  uses both four-field group-start and three-field coalesced headers; accept the
  optional fourth field. Synthetic three-field-only fixtures missed that defect.
- SVN diff paths must equal the scope-relative paths used by fetch/context and
  finding publication. Remove SVN revision labels only from patch headers;
  `(nonexistent)` denotes an absent side. Derive the scope prefix from pinned
  `info --xml`, never a basename match. Compare explicit `--old`/`--new` trees
  and omit directory targets covered by child paths: copied-file ancestry and
  directory headers otherwise misattribute or duplicate patches. Verify exact
  paths/statuses with `svn-live-repo.test.ts` and real review/output with
  `svn-multiproject-live.test.ts`; accepting a matching prefix conceals defects.
  CLI semantics: [SVN diff reference](https://svnbook.red-bean.com/en/1.7/svn.ref.svn.c.diff.html).

## P4 diagnostics and recovery

- Routing descriptors require a pinned submitted changelist. Only its recorded
  stream is historical evidence; do not infer one from depot segments or the
  submitter's current client. User/client disagreement between metadata reads
  must retry durably. SVN identity comes from revision-pinned `info --xml` at the
  configured URL; strip credentials and require explicit project/branch roots.
  See VCS `source-descriptors.test.ts` and server `workspace-routing-live.test.ts`.

- `p4 trust -y` does not replace a mismatched rotated fingerprint; the existing
  automatic-trust path needs its explicit force-replacement fallback. Keep the
  deploy and trigger paths consistent when editing that behavior.
- Recreate only the configured missing client, once per command, using the
  spawn-based stdin runner. Match escaped client identity in message/stderr;
  changelist descriptions or partial stdout can quote errors and must not trigger
  destructive client-spec replacement. Root is adapter repositoryDir and View
  maps the configured depot; do not create unrelated source directories.
- P4 network failures often arrive as stderr phrases instead of Node codes.
  Preserve bounded P4/shared transient retry and propagate persistent outages
  through list/diff/fetch/context; they must not become an empty LGTM review.
  Treat only genuine diagnostic `no such file(s)` as absent files, never quoted
  stdout. Keep transport patterns distinct from not-found checks.
- Tests that reach a real CLI via app-level fixtures must not point the
  trigger config at a fake hostname: on hosts where the binary is installed,
  `p4 describe` enrichment (`enrichP4ReviewEvent` via the default runner)
  stalls on the TCP connect timeout (~20 s) and the test dies at the 5 s
  default instead of failing fast. Use a loopback discard port
  (`127.0.0.1:1`) — instant ECONNREFUSED with the binary present, ENOENT
  without it. See `auto-commit-webhook.test.ts` P4 cases.

## P4 batch endpoints

- List and diff use the same base/head endpoint enumeration:
  `diff2 -Od -q <scope>@base <scope>@head`. Head-only `describe` loses earlier
  members; unfiltered wildcard output can overflow runner buffers.
- Filter paths before per-file diff/print so excluded binary SDK payloads are
  never read. `diff2 -u` omits adds/deletes; synthesize hunks from the surviving
  endpoint. Binary/NUL and empty contents remain hunkless file entries.
- Keep numeric `@N` endpoints and three-equals delete headers. Propagate diff
  errors before model/publication calls. Test listChanges→diff, excluded payloads,
  actual tool output, and the real server when changing P4 batch semantics.
