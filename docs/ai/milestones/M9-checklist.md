# M9 Release Checklist

This checklist tracks the remaining M9 deliverables before the release can be considered complete.

## M9 Deliverables

### Documentation

- [x] `CHANGELOG.md` created and populated with M5–M9 entries.
- [x] `docs/ai/architecture.md` §3.8 updated with backend capability matrix (`native`, `docker`, `podman`, `docker_socket`, `k8s_pod`, `firecracker`).
- [x] `example/README.md` includes `docker_socket` configuration example.
- [x] `docs/podman.md` includes rootless troubleshooting guide.
- [x] `development/README.md` created with isolated test environment guidelines.

### Sandbox Backends

- [x] `docker_socket` factory test confirms it maps to the docker backend implementation.
- [x] `k8s_pod` skeleton created with descriptive unimplemented error.
- [x] `firecracker` skeleton created with descriptive unimplemented error.
- [x] `docker_socket` dedicated integration test — verified via container-nested sandbox in AICodeReviewerTest: Docker CLI v27.5.1 inside container, nested `docker run --rm alpine echo sandbox-ok` succeeds, `--network none` blocks DNS, allowlist enforced by code.
- [x] `k8s_pod` capability boundary documented in `architecture.md` §3.8.1 and code stub (`packages/sandbox/src/k8s-pod.ts`): throws descriptive error listing requirements (Kubernetes API, `@kubernetes/client-node`, kubeconfig).
- [x] `firecracker` capability boundary documented in `architecture.md` §3.8.1 and code stub (`packages/sandbox/src/firecracker.ts`): throws descriptive error listing requirements (Firecracker binary, API socket).

### Observability (M8)

- [x] OTel OTLP HTTP trace exporter configured (`packages/core/src/observability.ts`).
- [x] Prometheus metrics endpoint (`/metrics`) with counters and histograms.
- [x] Run snapshot persistence (`runs/<run_id>/run.json`).
- [x] Eval minimal framework (`@aicr/eval`).

### Agent & MCP (M5)

- [x] Runtime bundle materializes MCP tool manifest.
- [x] Kilo adapter injects MCP config into `.kilo/kilo.json`.
- [x] Agent stdout structured repair and direct-LLM fallback.
- [x] MCP state file (`.aicr-output-state.json`) read after agent run.
- [x] Streamable HTTP transport for `@aicr/mcp-output` (post-M9 local contract completed; runtime bundles still default to stdio).

### VCS & Triggers (M6)

- [x] GitHub production e2e verified (auto-created issues and PR analysis).
- [ ] GitLab real repository e2e verification.
- [x] SVN VCS adapter implementation.
- [x] Blame/annotate attribution foundation (`VcsAdapter.fetchAttribution` + git/P4/SVN implementations).
- [ ] Multi-source context selector.

### Version & Packaging

- [x] All workspace packages versioned at `0.1.0`.
- [ ] Version bump and git tag for release (user decision — all packages are `private`, release artifact is the Docker image).
- [x] Release workflow validated: Docker image build via `deploy.sh` → container startup → `/healthz` OK → `/metrics` OK. No `pnpm publish` needed (all packages are `private: true`).

### Deployment Verification

- [x] Podman rootless `--storage-driver=overlay` fix documented and deployed.
- [x] Health check (`/healthz`) confirmed working in production.
- [x] Incremental re-deployment validated: source sync → build → start → healthz/metrics OK on existing test env `/data/disk2/AICodeReviewerTest`.
- [x] Full zero-to-deployment on a completely clean directory (AICodeReviewerTest: rm -rf → mkdir → extract source → write config.yaml/.env → deploy.sh with AICR_ENABLE_CONTAINER_SANDBOX=true → healthz OK, nested sandbox verified).
- [x] Rollback procedure documented in `.agents/skills/remote-deployment/SKILL.md`; `deploy.sh` auto-tags previous image as `:previous`.
- [x] Container-nested sandbox integration verified in AICodeReviewerTest: Docker CLI v27.5.1 inside AICR container, nested `docker run --rm alpine echo sandbox-ok` succeeds, `--network none` blocks DNS, Podman user socket + `DOCKER_HOST` + `userns=keep-id` all correctly configured.

### Final Validation

- [x] ESLint clean.
- [x] TypeScript clean.
- [x] Vitest all passing (1228 tests).
- [x] markdownlint clean.
- [x] Build succeeds (Dockerfile `aicr:test` image built and started).

## Post-M9 Backlog

The following items are intentionally deferred past M9:

1. **GitLab real e2e**: Needs a real GitLab repository with webhook access.
2. **SVN real e2e**: Basic adapter and inbound trigger contract exist; real SVN repository e2e and server-side hook deployment need external system access.
3. **k8s_pod backend**: Requires Kubernetes cluster and `@kubernetes/client-node`.
4. **firecracker backend**: Requires Firecracker binary and API socket.
5. **Multi-source context selector**: Design complete; implementation deferred.
6. **Reflection knowledge migration**: Light mode and thorough-mode minimal aggregation exist; repo convention learning and cross-workspace migration remain deferred pending scope/privacy decisions.

## Sign-off

| Role | Name | Date | Notes |
| --- | --- | --- | --- |
| Tech Lead | | | |
| QA | | | |
| DevOps | | | |

