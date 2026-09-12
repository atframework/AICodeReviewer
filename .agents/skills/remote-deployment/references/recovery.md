# Deployment Recovery and Issue Repair

Read only the section matching the observed failure. Inspect live state before
acting; an old incident's cause is a hypothesis until reproduced.

## Build, service and engine failures

| Symptom | Verify / action |
| --- | --- |
| New image lacks a changed Dockerfile feature | Check deployment-root `deploy/` was refreshed from source; compare actual build input and logs |
| Config rejected or mounted files unreadable | Check redacted schema errors, env names, encoding, bind mounts and permissions |
| LFS pointer abort | Hydrate the working tree and recreate the source archive; never package via unsmudged git archive |
| Rootless `invalid internal status` | Inspect storage.conf and selected driver; on the existing overlay setup use `podman --storage-driver=overlay system migrate`, then restart/verify affected containers |
| Reviews slow after timeouts | Inspect orphan/zombie descendants, process-tree kill behavior and outer `--init`; restart via the service owner when authorized |
| Service does not recover after crash | Verify generated restart policy and rootless linger/boot setup; preserve deploy.sh's restart args |
| Port still bound after restart | Identify owner and wait for release, then start the managed container; do not kill unrelated processes |
| Nested engine permission error | Check host socket/unit, keep-id/group access, SELinux label handling, CONTAINER_HOST/DOCKER_HOST and the selected client |
| omp fails without Bun or install stalls | Check Dockerfile's Bun install and omp `--ignore-scripts` handling for optional download-heavy dependencies |
| Build proxy works on host only | Check listener/ACL and script's host-network build path; explicit loopback proxy must be reachable from RUN steps |

When stopping a stalled build, identify only processes from that invocation.
Buffered SSH output alone is not proof of a hang. Version evidence belongs in
[source records](../../../../docs/ai/source-index.md); do not turn a checked
version into an installation pin unless the Dockerfile actually pins it.

## Rollback

1. Verify the previous image exists and record current mounts, env-file paths,
   ports, network/socket options and service owner. `deploy.sh` preserves a
   `:previous` image; that does not restore config/database state automatically.
2. Stop the owning systemd/compose service before replacing its container so it
   cannot restart a competing instance. Use the previous image with the original
   deployment options, including `--init`, restart policy and data bind mounts.
3. Recheck local/proxy health and logs. State whether service management was
   restored or a temporary plain container is running; plan the return to the
   normal deploy-script-managed service. Do not prescribe a generic partial
   `podman run` command that omits the live deployment's options.

## Managed issue repair

Use the normal output path when possible. Before an authorized one-time repair:

1. Diagnose coverage using successful/failed stored runs, reviewed files, issue
   commit markers and actual webhook ranges. One push can contain multiple
   commits. Replay only a delivery whose range is still appropriate; stale
   head replay can publish problems already fixed by later code.
2. Re-fetch every target's state, markers, fingerprints and body hash immediately
   before writing. Abort on drift. Resolve credentials from that output channel's
   exact trigger binding, not an arbitrary App configuration.
3. Inspect API error payloads: one connector's 403 is that writer's boundary.
   If the deployed App is the authorized fallback, use existing trigger-auth/token
   service code in the runtime. Keep short-lived tokens in memory, never logs/files.
4. Deduplicate lifecycle comments, preserve unrelated body sections and modify
   only preconditioned targets. Snapshot an unrelated issue to detect scope mistakes.
5. Re-fetch targets and verify states, markers, comments and fingerprints; confirm
   the unrelated snapshot is unchanged. Failed review notices must not close issues
   through ordinary empty-result reconciliation.
