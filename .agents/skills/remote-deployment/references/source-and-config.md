# Deployment Source and Configuration

Read for source synchronization, config migration, or a fresh deployment.
Resolve placeholders from the selected host and live state; do not copy an old
host snapshot or secrets into a committed helper.

## Source staging

- `<deploy-dir>` contains `source/`, root `deploy/` + `deploy.sh`, mounted
  `config.yaml`/`.env`, and persistent `data/{workspaces,db,logs}`.
- Package the authorized working-tree state, including relevant uncommitted files.
  Hydrate LFS before packaging and verify snapshot/image files are not pointers.
  `git archive` does not smudge LFS. Exclude `.git`, dependencies, generated
  output, `build/`, secrets and host-only config; inspect the archive manifest.
- On Windows prefer available `rsync`, or a tarball under `build/deploy/` plus
  SCP. Keep the archive outside its own input tree. Do not assume rsync exists.
- Stage source into a fresh task-owned remote directory. Verify extraction and
  the exact deletion/replacement scope before swapping `source/`; preserve
  deployment config/data. Track removed source files so stale files do not survive.
- Refresh `source/deploy/.` into root `deploy/` and `source/deploy/deploy.sh` into
  root `deploy.sh` before building. The two copies have different roles.
- Use the configured SSH identity and host-key policy. Do not universally disable
  host-key verification. For multi-line remote commands transfer a script instead
  of nesting PowerShell/SSH/Python quoting.

## Config edits

- Inspect the actual source text and resolved schema. Preserve YAML anchors,
  aliases, comments, environment references and unrelated values. Prefer a parser
  with round-trip support or a unique, exact-block replacement with preconditions;
  generic load/dump can discard those structures. Abort on zero/multiple matches.
- Write UTF-8 without BOM, compare the redacted diff, parse the result and run
  AICR config validation before restart. Never print the complete secret file.
  Local helpers and logs belong in `build/tmp/` and `build/logs/`.
- Check deployed legacy keys/channel kinds against current schema when migrations
  change them. Passthrough acceptance can hide ignored settings; check consumers.
  Admin TTL is `session_ttl_seconds`, and catalog provider IDs need deterministic
  resolution against the shipped snapshot.
- Restart through the current owner: systemd unit, compose project, or plain
  engine. For rootless port-release races, stop/start after confirming the port
  is free. Recheck health and logs after the configuration is loaded.
- For missing callback access records, inspect the running proxy's log writer
  path and container mounts. A log can exist only inside the container, so an
  empty host directory does not prove requests never arrived. Read bounded
  records and allowlist time, method, callback path, status and duration;
  exclude headers, raw bodies, signatures and response URLs.
- Atomic file replacement must preserve container read access as well as mode.
  Check the image's runtime UID/GID and rootless mappings; validate the mounted
  config with that identity before restart. Private backup modes are not active
  config modes. A stopped SQLite WAL database can require new sidecars even for
  a readonly connection: copy the stopped DB and WAL into private task staging
  for validation, retaining a read-only production mount. Never use immutable
  reads that omit pending WAL transactions to check config heads.
- If outbound Node API reads time out while host reads succeed, verify with the
  deployed client before changing credentials. Existing proxy env vars may need
  `NODE_USE_ENV_PROXY=1` on supported Node versions; preserve proxy/bypass settings
  and verify local health plus platform metadata after the owning-service restart.
  Build proxy detection is separate. See [runtime proxy sources](../../../../docs/ai/sources/shell-and-tooling.md#node-runtime-http-proxy)
  and `SocialImClient.refreshReadiness`; do not send messages as a connectivity probe.
  For another config phase, use a fresh validation-copy directory and checkpoint;
  never reuse a stopped database copy from an earlier activation.
- Preserve runtime-owned `0700` directories and `0600` files for member lists
  under `data/db/private` and task backups under `data/db/build`. Recursive
  permission repair must prune these subtrees; verify modes after deployment.
  See `ensure_writable_tree` and `deploy-private-permissions.test.ts`.
- Name pre-migration DB/config backups with a unique second-resolution path and
  confirm the target differs from any cleanup path before removing superseded
  partials; a same-minute collision has silently deleted a fresh backup.
- With database configuration enabled, inspect the durable head before preparing
  a file update. A healthy revision 0 `legacy_import` baseline can have no head;
  prepare its first publication with `baseRevision: null` and `current: {}` through
  `prepareConfigPublication`/`publishConfig`. Preserve the legacy snapshot used
  by older tasks. For an existing head, retain its revision and database document;
  a changed file digest fails admission closed (`file_config_mismatch`) until a
  matching changeset is published. See the
  [runtime manager](../../../../packages/server/src/runtime-config.ts),
  [admin publication path](../../../../packages/server/src/config-api.ts), and
  [H12 baseline test](../../../../packages/server/test/runtime-config.test.ts).

## Retention after a successful deployment

- Inventory AICR release directories, archives, config/DB backup copies and image
  IDs before deleting anything. Keep the active release and at most two newest
  recoverable historical releases, with matching config, env, deployment assets
  and image identities. Protect those images before `deploy.sh` replaces the
  `:previous` tag. Do not remove recovery material during a failed rollout.
- Remove superseded bundles, extracted staging trees, duplicate config/DB
  backups and unused AICR images only after service and configuration checks
  pass. Verify every resolved cleanup path lies inside the selected deployment
  root and every image belongs to AICR and is unused by retained containers.
  Use explicit paths/image IDs; never run a global image/system/volume prune on
  a shared host. Build layers needed by retained images are not old releases.
- Preserve live databases, workspaces, logs, secrets and configuration revisions
  or snapshots referenced by queued work. Their runtime retention rules are
  separate from deployment backup retention; do not delete database rows to
  satisfy the two-release limit. Remove task-owned temporary secret copies when
  no longer needed, and record the retained versions and reclaimed space.

## Fresh or nested-sandbox deployment

Use a new isolated test root, container/image name and port; do not delete or copy
production state as setup. Read `deploy.sh` for supported `AICR_*` variables.
For nested containers verify the host socket, access permissions, engine client,
socket env and actual child launch. A mounted engine socket grants host-user
container control; retain the intended trust boundary. Verify only the configured
engine path, and record from-scratch acceptance separately from production health.

## Slack Socket Mode cutover

Read App-Level Token through local yq into private task staging, never tool output or source archives.
Validate candidate config and env before cutover; retain the HTTP URL/signing secret for rollback.
The deployed receiver explicitly proxies apps.connections.open and WebSocket through undici.
Verify hello identity, reconnect, active receiver count and real command ACK separately.
The app-wide console switch also reroutes events/interactions; a Bot/App-Level Token cannot update the App Manifest.
For retries or diagnostics, keep SDK raw logs disabled and emit fixed status metadata only.
