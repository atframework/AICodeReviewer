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

## Fresh or nested-sandbox deployment

Use a new isolated test root, container/image name and port; do not delete or copy
production state as setup. Read `deploy.sh` for supported `AICR_*` variables.
For nested containers verify the host socket, access permissions, engine client,
socket env and actual child launch. A mounted engine socket grants host-user
container control; retain the intended trust boundary. Verify only the configured
engine path, and record from-scratch acceptance separately from production health.
