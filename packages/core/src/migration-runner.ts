/**
 * Namespace-scoped migration runner (architecture §3.14/§9.3, matrix M01–M20).
 *
 * One deployment carries several independently-versioned namespaces in the
 * same database — `store` (business tables), `config` (config revisions),
 * future queue/catalog namespaces. The runner owns the shared
 * `schema_migrations` ledger contract:
 *
 *   namespace TEXT, id TEXT, checksum TEXT, from_version INT,
 *   to_version INT, app_version TEXT, applied_at INT
 *
 * Guarantees:
 * - M04/M06: every apply runs inside the backend's migration lock
 *   (SQLite BEGIN IMMEDIATE, PG pg_advisory_xact_lock) and re-reads the
 *   ledger under that lock, so racing processes apply each step once and a
 *   killed process leaves either the old or the new version, never a half
 *   applied step (each step is one transaction).
 * - M16: a drifted checksum on an applied step, or an applied row whose
 *   `to_version` exceeds the plan's target version (written by a newer
 *   program), refuses startup with `schema_version_unsupported` instead of
 *   writing into an incompatible shape. Legacy rows recorded without a
 *   checksum (bridged from the old name-only `_migrations` table) are
 *   grandfathered: their presence pins the version but drift is not
 *   enforceable retroactively.
 * - Steps form a contiguous chain: a step applies only when the running
 *   version equals `fromVersion`; gaps abort with `migration_failed`.
 */

import { ConfigError } from "./config-format.js";

/** Protocol versions are independent of application semver and schema versions. */
export const MIGRATION_PROTOCOL = Object.freeze({ reader: 1, writer: 1 });

export interface MigrationProtocol {
  readonly reader: number;
  readonly writer: number;
}

export interface MigrationStep {
  /** Stable identifier, e.g. "001_config_initial". Never reused. */
  readonly id: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  /** sha256 hex of the step's content (SQL body); drift detection (M16). */
  readonly checksum: string;
  readonly description?: string | undefined;
  /** Backend-specific body (e.g. `{ sql }`); interpreted by the executor. */
  readonly payload?: unknown;
  /** Omitted by legacy plans: protocol 1, atomic SQL transaction. */
  readonly minReaderProtocol?: number;
  readonly minWriterProtocol?: number;
  readonly transactionMode?: "atomic";
}

export interface AppliedMigration {
  readonly id: string;
  /** null only for bridged legacy rows; skips drift enforcement. */
  readonly checksum: string | null;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly appVersion: string | null;
  readonly appliedAt: number;
  readonly minReaderProtocol?: number;
  readonly minWriterProtocol?: number;
  readonly transactionMode?: "atomic";
}

export interface NamespaceMigrationPlan {
  readonly namespace: string;
  /** Version the plan migrates to (max step toVersion). */
  readonly targetVersion: number;
  readonly steps: readonly MigrationStep[];
}

/**
 * Backend executor. All methods except `withMigrationLock` run inside the
 * transaction/lock the runner opens around the whole apply batch.
 */
export interface MigrationStore {
  readonly backendKind: string;
  /** Creates the ledger table if absent; idempotent, may run unlocked. */
  ensureLedger(): Promise<void>;
  /**
   * Read-only ledger probe: resolves true when the ledger table already
   * exists. `status()`/`check()` use it to stay free of DDL — a missing
   * ledger computes as "every step pending" without running CREATE. Stores
   * without the probe fall back to `ensureLedger` (legacy behavior), so
   * implementing it is what makes a backend's verify path read-only.
   */
  ledgerExists?(): Promise<boolean>;
  /**
   * Runs `fn` under the backend-exclusive migration lock. Implementations
   * MUST make DDL + ledger writes inside `fn` atomic as one unit.
   */
  withMigrationLock<T>(fn: () => Promise<T>): Promise<T>;
  readApplied(namespace: string): Promise<readonly AppliedMigration[]>;
  /** Executes the step's DDL. */
  applyStep(step: MigrationStep): Promise<void>;
  /** Records the step as applied in the same transaction. */
  recordApplied(namespace: string, step: MigrationStep, appVersion: string | null, now: number): Promise<void>;
}

export interface NamespaceMigrationStatus {
  readonly namespace: string;
  /** Highest contiguous applied version (0 = empty). */
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly appliedIds: readonly string[];
  readonly pendingIds: readonly string[];
  /** Applied steps whose recorded checksum differs from the plan (M16). */
  readonly driftedIds: readonly string[];
  /** Highest applied version not present in the plan, if it exceeds target. */
  readonly unknownHigherVersion: number | null;
  readonly protocol: {
    readonly reader: number;
    readonly writer: number;
    readonly requiredReader: number;
    readonly requiredWriter: number;
    readonly compatible: boolean;
  };
}

export interface MigrationCheckResult {
  /** True when no drift and no unknown-higher rows; pending steps allowed. */
  readonly ok: boolean;
  /** Namespaces with pending steps (would be applied by `apply`). */
  readonly needsMigration: readonly string[];
  readonly statuses: readonly NamespaceMigrationStatus[];
}

export interface MigrationApplyResult {
  readonly appliedByNamespace: Readonly<Record<string, readonly string[]>>;
  readonly statuses: readonly NamespaceMigrationStatus[];
}

/**
 * Pure status computation, exported for read-only reporters (the migrate
 * CLI `--status`/`--check` modes compose it without opening a writable
 * ledger or running ensureLedger).
 */
export function computeNamespaceMigrationStatus(namespace: string, plan: NamespaceMigrationPlan, applied: readonly AppliedMigration[], protocol: MigrationProtocol = MIGRATION_PROTOCOL): NamespaceMigrationStatus {
  const planIds = new Map(plan.steps.map((step) => [step.id, step]));
  const drifted: string[] = [];
  let unknownHigher: number | null = null;
  let current = 0;
  let requiredReader = 1;
  let requiredWriter = 1;
  let validProtocol = true;

  for (const item of [...plan.steps, ...applied]) {
    const reader = item.minReaderProtocol === undefined ? 1 : item.minReaderProtocol;
    const writer = item.minWriterProtocol === undefined ? 1 : item.minWriterProtocol;
    if (!Number.isSafeInteger(reader) || reader < 1 || !Number.isSafeInteger(writer) || writer < 1 ||
        (item.transactionMode !== undefined && item.transactionMode !== "atomic")) validProtocol = false;
    requiredReader = Math.max(requiredReader, reader);
    requiredWriter = Math.max(requiredWriter, writer);
  }

  const ordered = [...applied].sort((a, b) => a.toVersion - b.toVersion);
  const seen = new Set<string>();
  for (const row of ordered) {
    const step = planIds.get(row.id);
    if (step === undefined) {
      if (row.toVersion > plan.targetVersion && (unknownHigher === null || row.toVersion > unknownHigher)) {
        unknownHigher = row.toVersion;
      } else {
        drifted.push(row.id);
      }
      continue;
    }
    if (seen.has(row.id) || row.fromVersion !== step.fromVersion || row.toVersion !== step.toVersion ||
        row.fromVersion !== current || (row.checksum !== null && row.checksum !== step.checksum) ||
        (row.minReaderProtocol ?? 1) !== (step.minReaderProtocol ?? 1) ||
        (row.minWriterProtocol ?? 1) !== (step.minWriterProtocol ?? 1)) {
      drifted.push(row.id);
    }
    seen.add(row.id);
    if (row.toVersion > current) current = row.toVersion;
  }

  const appliedIds = new Set(applied.map((row) => row.id));
  const pendingIds = plan.steps.filter((step) => !appliedIds.has(step.id)).map((step) => step.id);

  return {
    namespace,
    currentVersion: current,
    targetVersion: plan.targetVersion,
    appliedIds: ordered.map((row) => row.id),
    pendingIds,
    driftedIds: drifted,
    unknownHigherVersion: unknownHigher,
    protocol: { ...protocol, requiredReader, requiredWriter,
      compatible: validProtocol && protocol.reader >= requiredReader && protocol.writer >= requiredWriter },
  };
}

function refuseUnsafeStatus(status: NamespaceMigrationStatus): void {
  if (!status.protocol.compatible) {
    throw new ConfigError("schema_version_unsupported",
      `Namespace "${status.namespace}" requires reader/writer protocol ${status.protocol.requiredReader}/${status.protocol.requiredWriter}; this program supports ${status.protocol.reader}/${status.protocol.writer}. Stop and drain incompatible processes before upgrading.`);
  }
  if (status.driftedIds.length > 0) {
    throw new ConfigError(
      "schema_version_unsupported",
      `Migration ledger drift in namespace "${status.namespace}": ${status.driftedIds.join(", ")} checksum(s) no longer match this program (M16).`,
    );
  }
  if (status.unknownHigherVersion !== null) {
    throw new ConfigError(
      "schema_version_unsupported",
      `Namespace "${status.namespace}" was migrated to version ${status.unknownHigherVersion} by a newer program; refusing to write (M16).`,
    );
  }
}

export interface MigrationRunnerOptions {
  readonly appVersion?: string | null | undefined;
  readonly now?: (() => number) | undefined;
  readonly protocol?: MigrationProtocol;
}

export class MigrationRunner {
  readonly #store: MigrationStore;
  readonly #plans: readonly NamespaceMigrationPlan[];
  readonly #appVersion: string | null;
  readonly #now: () => number;
  readonly #protocol: MigrationProtocol;

  constructor(store: MigrationStore, plans: readonly NamespaceMigrationPlan[], options: MigrationRunnerOptions = {}) {
    this.#store = store;
    this.#plans = plans;
    this.#appVersion = options.appVersion ?? null;
    this.#now = options.now ?? Date.now;
    this.#protocol = { ...(options.protocol ?? MIGRATION_PROTOCOL) };
    if (![this.#protocol.reader, this.#protocol.writer].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new ConfigError("migration_failed", "Reader/writer protocol versions must be positive safe integers.");
    }
    const namespaces = new Set<string>();
    for (const plan of plans) {
      if (namespaces.has(plan.namespace)) {
        throw new ConfigError("migration_failed", `Duplicate migration namespace "${plan.namespace}".`);
      }
      namespaces.add(plan.namespace);
      for (const step of plan.steps) {
        if (![step.minReaderProtocol ?? 1, step.minWriterProtocol ?? 1].every(value => Number.isSafeInteger(value) && value > 0) ||
            (step.transactionMode !== undefined && step.transactionMode !== "atomic")) {
          throw new ConfigError("migration_failed", `Migration "${step.id}" has an invalid protocol or unsupported transaction mode.`);
        }
      }
      if (!Number.isSafeInteger(plan.targetVersion) || plan.targetVersion < 0 ||
          (plan.steps.length === 0 ? plan.targetVersion !== 0 : plan.steps[0]!.fromVersion !== 0 || plan.steps.at(-1)!.toVersion !== plan.targetVersion) ||
          new Set(plan.steps.map((step) => step.id)).size !== plan.steps.length ||
          plan.steps.some((step) => !Number.isSafeInteger(step.fromVersion) || !Number.isSafeInteger(step.toVersion) || step.toVersion !== step.fromVersion + 1)) {
        throw new ConfigError("migration_failed", `Migration chain in namespace "${plan.namespace}" is not contiguous or has invalid versions/ids.`);
      }
      for (let i = 1; i < plan.steps.length; i += 1) {
        const prev = plan.steps[i - 1]!;
        const step = plan.steps[i]!;
        if (step.fromVersion !== prev.toVersion) {
          throw new ConfigError(
            "migration_failed",
            `Migration chain in namespace "${plan.namespace}" is not contiguous at "${step.id}".`,
          );
        }
      }
    }
  }

  /**
   * Reads the ledger without locking; safe for status reporting. When the
   * store provides `ledgerExists`, a missing ledger reports every step as
   * pending without executing any DDL (the migrate=verify startup gate and
   * the CLI `--status`/`--check` modes must not mutate the database).
   */
  async status(): Promise<readonly NamespaceMigrationStatus[]> {
    if (this.#store.ledgerExists !== undefined) {
      if (!(await this.#store.ledgerExists())) {
        return this.#plans.map((plan) => computeNamespaceMigrationStatus(plan.namespace, plan, [], this.#protocol));
      }
    } else {
      await this.#store.ensureLedger();
    }
    const statuses: NamespaceMigrationStatus[] = [];
    for (const plan of this.#plans) {
      const applied = await this.#store.readApplied(plan.namespace);
      statuses.push(computeNamespaceMigrationStatus(plan.namespace, plan, applied, this.#protocol));
    }
    return statuses;
  }

  /** Dry-run: reports pending work and refuses drifted/unknown state. */
  async check(): Promise<MigrationCheckResult> {
    const statuses = await this.status();
    for (const status of statuses) refuseUnsafeStatus(status);
    return {
      ok: true,
      needsMigration: statuses.filter((status) => status.pendingIds.length > 0).map((status) => status.namespace),
      statuses,
    };
  }

  /**
   * Applies pending steps. The ledger is re-read inside the migration lock
   * so a concurrent winner is observed, not overwritten (M04).
   */
  async apply(): Promise<MigrationApplyResult> {
    return this.#store.withMigrationLock(async () => {
      await this.#store.ensureLedger();
      const appliedByNamespace: Record<string, readonly string[]> = {};
      const statuses: NamespaceMigrationStatus[] = [];
      for (const plan of this.#plans) {
        const applied = await this.#store.readApplied(plan.namespace);
        const status = computeNamespaceMigrationStatus(plan.namespace, plan, applied, this.#protocol);
        refuseUnsafeStatus(status);

        const appliedIds = new Set(applied.map((row) => row.id));
        let runningVersion = status.currentVersion;
        const justApplied: string[] = [];
        for (const step of plan.steps) {
          if (appliedIds.has(step.id)) continue;
          if (step.fromVersion !== runningVersion) {
            throw new ConfigError(
              "migration_failed",
              `Cannot apply "${step.id}" in namespace "${plan.namespace}": running version ${runningVersion}, expected ${step.fromVersion}.`,
            );
          }
          await this.#store.applyStep(step);
          await this.#store.recordApplied(plan.namespace, step, this.#appVersion, this.#now());
          runningVersion = step.toVersion;
          justApplied.push(step.id);
        }
        appliedByNamespace[plan.namespace] = justApplied;
        statuses.push(computeNamespaceMigrationStatus(plan.namespace, plan, [
          ...applied,
          ...plan.steps
            .filter((step) => justApplied.includes(step.id))
            .map((step) => ({
              id: step.id,
              checksum: step.checksum,
              fromVersion: step.fromVersion,
              toVersion: step.toVersion,
              appVersion: this.#appVersion,
              appliedAt: this.#now(),
              minReaderProtocol: step.minReaderProtocol ?? 1,
              minWriterProtocol: step.minWriterProtocol ?? 1,
              transactionMode: step.transactionMode ?? "atomic",
            })),
        ], this.#protocol));
      }
      return { appliedByNamespace, statuses };
    });
  }
}
