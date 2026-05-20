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
- [ ] `docker_socket` dedicated integration test (beyond factory mapping).
- [ ] `k8s_pod` implementation or explicit platform capability boundary documented.
- [ ] `firecracker` implementation or explicit platform capability boundary documented.

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
- [ ] HTTP/SSE transport for `@aicr/mcp-output` (deferred to post-M9).

### VCS & Triggers (M6)

- [x] GitHub production e2e verified (auto-created issues and PR analysis).
- [ ] GitLab real repository e2e verification.
- [ ] SVN VCS adapter implementation.
- [ ] Blame/annotate attribution pipeline.
- [ ] Multi-source context selector.

### Version & Packaging

- [x] All workspace packages versioned at `0.1.0`.
- [ ] Version bump and git tag for release.
- [ ] `pnpm publish` or equivalent release script validated.

### Deployment Verification

- [x] Podman rootless `--storage-driver=overlay` fix documented and deployed.
- [x] Health check (`/healthz`) confirmed working in production.
- [x] Incremental re-deployment validated: source sync → build → start → healthz/metrics OK on existing test env `/data/disk2/AICodeReviewerTest`.
- [ ] Full zero-to-deployment on a completely clean directory (mkdir, write config.yaml, write .env, deploy.sh, healthz).
- [x] Rollback procedure documented in `.agents/skills/remote-deployment/SKILL.md`; `deploy.sh` auto-tags previous image as `:previous`.

### Final Validation

- [x] ESLint clean.
- [x] TypeScript clean.
- [x] Vitest all passing (1188 tests).
- [x] markdownlint clean.
- [x] Build succeeds (Dockerfile `aicr:test` image built and started).

## Post-M9 Backlog

The following items are intentionally deferred past M9:

1. **HTTP/SSE MCP transport**: `@aicr/mcp-output` currently uses stdio via Kilo MCP config injection. HTTP/SSE transport requires MCP SDK investigation.
2. **GitLab real e2e**: Needs a real GitLab repository with webhook access.
3. **SVN adapter**: Config schema reserved; adapter not yet implemented.
4. **k8s_pod backend**: Requires Kubernetes cluster and `@kubernetes/client-node`.
5. **firecracker backend**: Requires Firecracker binary and API socket.
6. **Blame/annotate attribution**: Pipeline design complete; implementation deferred.
7. **Multi-source context selector**: Design complete; implementation deferred.
8. **Memory / reflection**: Schema and extension points reserved; not yet implemented.

## Sign-off

| Role | Name | Date | Notes |
| --- | --- | --- | --- |
| Tech Lead | | | |
| QA | | | |
| DevOps | | | |
