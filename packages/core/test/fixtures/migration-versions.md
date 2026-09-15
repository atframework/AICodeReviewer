# Historical migration fixture

`migration-c5d221c.mjs.txt` contains the actual configuration store, document
validator and migration code from commit
`c5d221c5fc54bf5322f9eaa4c900937ddc267bd1` (the P2/P3 baseline). The adjacent JSON
manifest records the full revision, bundler version, ten source hashes and the
bundle hash. The process test verifies the artifact hash before loading it.
Git pins LF for this fixture so checkout line endings cannot change its bytes.

The fixture is bundled JavaScript stored with a `.txt` suffix to keep historical
code outside current compilation and lint discovery. Tests copy it into their
private `build/tmp/` directory and load it as ESM. They use the current lockfile's
`better-sqlite3`, `pg`, `ioredis` and `zod` dependencies. This tests historical
application code against current drivers; it does not certify the complete old
release's dependency or operating-system environment.

## Rebuilding the pinned artifact

Use `git show <full-revision>:<path>` to extract unmodified source bytes into
`build/tmp/p8-historical-source/packages/core/src/`. Do not export the current
working tree or replace old modules with current ones. Generate a sibling
`entry.ts` exporting:

```typescript
export { createSqliteConfigStore, createConfigStoreMigrationPlan } from "./packages/core/src/sqlite-config-store.ts";
export { createPgConfigStore, createPgConfigStoreMigrationPlan, createPgConfigMigrationStore } from "./packages/core/src/pg-config-store.ts";
export { createRedisConfigStore } from "./packages/core/src/redis-config-store.ts";
export { MigrationRunner } from "./packages/core/src/migration-runner.ts";
export { createSqliteMigrationStore } from "./packages/core/src/sqlite-migration-store.ts";
export { validateDatabaseDocument } from "./packages/core/src/config-source.ts";
```

Run esbuild 0.28.2 from the repository root with that entry and
`bundle: true, format: "esm", platform: "node", packages: "external",
write: false, metafile: true`. Preserve its output bytes, hash them with SHA-256,
and derive `sourceHashes` from the original bytes of the source modules listed
in `metafile.inputs`. Review source and artifact changes together; changing the
baseline requires a new named fixture and compatibility assessment.

## Evidence boundaries

`migration-version-process.test.ts` starts separate old/current processes:

- SQLite/PostgreSQL: old write → normal old process exit → current schema
  upgrade and read/write → old restart refuses the higher schema.
- SQLite/PostgreSQL: an old process holds a real write/advisory transaction;
  current initialization fails within its lock timeout. After the old process
  commits and exits, current initialization succeeds with its data intact.
- Redis: old/current readers consume document formats 1–2; an old writer's stale
  CAS fails and a refreshed CAS succeeds without overwriting another revision.
- Current document validation rejects format 3 before committing any new head.

PostgreSQL and Redis legs require the dedicated test endpoints documented in the
[repository baseline](../../../../docs/ai/AGENTS.repository-baseline.md).
Process drain with actual CLI startup is separately covered by
`packages/cli/test/serve-shutdown-process.test.ts`; accepted work, final run
persistence and durable deferrals are covered in server tests. No test asserts
that a migration lock can fence an arbitrary idle legacy process.
