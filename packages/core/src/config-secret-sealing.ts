import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { ConfigError, stableSerialize } from "./config-format.js";
import { contentHashOf, type ConfigStore, type WriteSnapshotInput, type ConfigRuntimeSnapshotRecord } from "./config-store.js";
import { isPlainObject } from "./utils.js";

// ---------------------------------------------------------------------------
// Literal credential sealing (architecture §3.15)
//
// Registered credential fields accept a literal or an `*_env` reference
// (the two forms are mutually exclusive per field). File config keeps
// literals as-is (operator-owned, like a `.env`); the database document and
// the runtime snapshots are sealed at every persistence boundary so the store
// never sees plaintext secret material. Sealing is AES-256-GCM envelope
// encryption keyed by the deployment-owned AICR_CONFIG_SECRETS_KEY env var;
// AICR_CONFIG_SECRETS_KEY_PREVIOUS lists retired keys (decrypt-only) so a
// rotation does not strand historical revisions/snapshots.
//
// Envelope: enc:v1.<kid>.<base64url nonce>.<base64url ciphertext+tag>
//   kid  — first 8 hex chars of sha256(key); selects the decryption key.
//   AAD  — the literal field name, so ciphertext cannot be transplanted
//          across field types (entity renames keep field names).
// ---------------------------------------------------------------------------

const SEAL_PREFIX = "enc:v1.";
const KEY_ID_HEX_LENGTH = 8;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

/** Environment variable holding the active sealing key (encrypt + decrypt). */
export const CONFIG_SECRETS_KEY_ENV = "AICR_CONFIG_SECRETS_KEY";
/** Comma-separated retired keys accepted for decryption only (rotation). */
export const CONFIG_SECRETS_KEY_PREVIOUS_ENV = "AICR_CONFIG_SECRETS_KEY_PREVIOUS";

/**
 * Literal fields sealed at persistence boundaries and masked on read APIs.
 * Exact key names; the `*_env` siblings name env vars and are never sealed.
 */
export const SEALED_LITERAL_SECRET_FIELDS: ReadonlySet<string> = new Set([
  "api_key",
  "token",
  "webhook_secret",
  "private_key",
  "password",
  "ticket",
  "webhook_url",
  "secret",
  "aws_access_key",
  "aws_secret_key",
  "aws_session_token",
  "google_application_credentials",
]);

/**
 * Literal fields allowed by policy but neither sealed nor masked: usernames
 * are identifiers, and a password hash is not reversible secret material.
 */
export const PLAIN_LITERAL_SECRET_FIELDS: ReadonlySet<string> = new Set([
  "user",
  "username",
  "password_hash",
]);

/** Every accepted literal credential field (sealed ∪ plain). */
export const LITERAL_SECRET_FIELDS: ReadonlySet<string> = new Set([
  ...SEALED_LITERAL_SECRET_FIELDS,
  ...PLAIN_LITERAL_SECRET_FIELDS,
]);

export function isSealedSecretValue(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SEAL_PREFIX);
}

/** Parses one 32-byte key, hex (64 chars) or base64/base64url encoded. */
export function parseConfigSecretsKeyMaterial(raw: string, envName = CONFIG_SECRETS_KEY_ENV): Uint8Array {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return new Uint8Array(Buffer.from(trimmed, "hex"));
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === KEY_BYTES && decoded.toString("base64").replace(/=+$/, "") === trimmed.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/")) {
    return new Uint8Array(decoded);
  }
  throw new ConfigError(
    "secret_sealing_invalid",
    `${envName} must be a 32-byte key, hex (64 chars) or base64 encoded; generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
  );
}

export interface ConfigSecretSealing {
  /** Fingerprint of the active key; diagnostics only, never secret material. */
  readonly keyId: string;
  /** Encrypts a literal for persistence; already-sealed values are authenticated. */
  seal(plaintext: string, field: string): string;
  /** Decrypts a sealed value for runtime use; unsealed values pass through. */
  open(value: string, field: string): string;
  isSealed(value: unknown): value is string;
}

export function createConfigSecretSealing(
  primary: Uint8Array,
  previous: readonly Uint8Array[] = [],
): ConfigSecretSealing {
  if (primary.length !== KEY_BYTES || previous.some((key) => key.length !== KEY_BYTES)) {
    throw new ConfigError("secret_sealing_invalid", `Secret sealing keys must be ${KEY_BYTES} bytes.`);
  }
  const keyIdOf = (key: Uint8Array): string => createHash("sha256").update(key).digest("hex").slice(0, KEY_ID_HEX_LENGTH);
  const primaryId = keyIdOf(primary);
  const keys = new Map<string, Uint8Array>([[primaryId, primary]]);
  for (const retired of previous) {
    const id = keyIdOf(retired);
    if (!keys.has(id)) keys.set(id, retired);
  }
  const aadOf = (field: string): Buffer => Buffer.from(field, "utf8");

  const seal = (plaintext: string, field: string): string => {
    if (isSealedSecretValue(plaintext)) {
      open(plaintext, field);
      return plaintext;
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(primary), nonce);
    cipher.setAAD(aadOf(field));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${SEAL_PREFIX}${primaryId}.${nonce.toString("base64url")}.${ciphertext.toString("base64url")}`;
  };

  const open = (value: string, field: string): string => {
    if (!isSealedSecretValue(value)) return value;
    const parts = value.slice(SEAL_PREFIX.length).split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new ConfigError("secret_sealing_invalid", `Sealed secret at field "${field}" is malformed.`);
    }
    const [kid, nonceText, payloadText] = parts as [string, string, string];
    const key = keys.get(kid);
    if (key === undefined) {
      throw new ConfigError(
        "secrets_key_missing",
        `Sealed secret at field "${field}" was encrypted with key "${kid}", which is not configured; set ${CONFIG_SECRETS_KEY_ENV} (or ${CONFIG_SECRETS_KEY_PREVIOUS_ENV} for a retired key).`,
      );
    }
    const payload = Buffer.from(payloadText, "base64url");
    if (payload.length < 16) {
      throw new ConfigError("secret_sealing_invalid", `Sealed secret at field "${field}" is truncated.`);
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(nonceText, "base64url"));
      decipher.setAAD(aadOf(field));
      decipher.setAuthTag(payload.subarray(payload.length - 16));
      return Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]).toString("utf8");
    } catch {
      throw new ConfigError("secret_sealing_invalid", `Sealed secret at field "${field}" failed authentication; the value was tampered with or sealed for another field.`);
    }
  };

  return { keyId: primaryId, seal, open, isSealed: isSealedSecretValue };
}

/**
 * Builds the sealing service from the deployment environment. Returns
 * undefined when no key is configured; callers fail closed only when a
 * sealable literal actually crosses a persistence boundary.
 */
export function resolveConfigSecretSealing(
  envLookup: (name: string) => string | undefined,
): ConfigSecretSealing | undefined {
  const raw = envLookup(CONFIG_SECRETS_KEY_ENV);
  if (raw === undefined || raw.trim() === "") return undefined;
  const retired = (envLookup(CONFIG_SECRETS_KEY_PREVIOUS_ENV) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseConfigSecretsKeyMaterial(entry, CONFIG_SECRETS_KEY_PREVIOUS_ENV));
  return createConfigSecretSealing(parseConfigSecretsKeyMaterial(raw), retired);
}

// ---------------------------------------------------------------------------
// Document walkers (config-shaped roots and database documents alike)
// ---------------------------------------------------------------------------

type LiteralTransform = (value: string, field: string) => string;

function isWebSearchCredentialsMap(ancestors: readonly string[]): boolean {
  return ancestors.at(-1) === "credentials" && ancestors.includes("web_search");
}

/**
 * Applies `transform` to every registered literal secret value reachable from
 * `root`. Shape-agnostic: walks config documents, database documents
 * (globals + entities.*.*.value), entity records and changeset operation
 * payloads alike. The input is never mutated.
 */
export function mapConfigSecretLiterals<T>(root: T, transform: LiteralTransform): T {
  const visit = (value: unknown, ancestors: string[]): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => visit(entry, ancestors));
    }
    if (!isPlainObject(value)) {
      return value;
    }
    if (isWebSearchCredentialsMap(ancestors)) {
      // web_search credentials entries: a plain string stays an env var name;
      // the { value: "..." } form carries a literal to seal/open.
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key,
        isPlainObject(entry) && typeof entry.value === "string"
          ? { ...entry, value: transform(entry.value, "credential") }
          : entry,
      ]));
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (SEALED_LITERAL_SECRET_FIELDS.has(key) && typeof entry === "string") {
        return [key, transform(entry, key)];
      }
      return [key, visit(entry, [...ancestors, key])];
    }));
  };
  return visit(root, []) as T;
}

/** Seals every unsealed literal under root; sealed values pass through (idempotent). */
export function sealConfigSecretLiterals<T>(root: T, sealing: ConfigSecretSealing): T {
  return mapConfigSecretLiterals(root, (value, field) => sealing.seal(value, field));
}

/** Opens every sealed literal under root; unsealed values pass through. */
export function openConfigSecretLiterals<T>(root: T, sealing: ConfigSecretSealing): T {
  return mapConfigSecretLiterals(root, (value, field) => sealing.open(value, field));
}

/** Checks every literal, including ciphertext carried over from an older revision. */
export function validateConfigSecretLiterals(root: unknown, sealing: ConfigSecretSealing | undefined): void {
  mapConfigSecretLiterals(root, (value, field) => {
    if (sealing === undefined) {
      throw new ConfigError("secrets_key_missing", "Persisting literal credentials requires AICR_CONFIG_SECRETS_KEY; configure it or use environment references.");
    }
    return sealing.open(value, field);
  });
}

/** Random nonces must not turn snapshot retries or concurrent recovery into conflicts. */
export async function writeSealedConfigSnapshot(
  store: ConfigStore,
  input: WriteSnapshotInput,
  sealing: ConfigSecretSealing | undefined,
): Promise<ConfigRuntimeSnapshotRecord> {
  validateConfigSecretLiterals(input.sanitizedEffectiveConfig, sealing);
  const open = (value: unknown): unknown => sealing ? openConfigSecretLiterals(value, sealing) : value;
  const reuse = (existing: ConfigRuntimeSnapshotRecord): ConfigRuntimeSnapshotRecord => {
    if (existing.namespace !== input.namespace || existing.databaseRevision !== input.databaseRevision
      || existing.fileDigest !== input.fileDigest || existing.resolverVersion !== input.resolverVersion
      || contentHashOf(existing.sanitizedEffectiveConfig) !== existing.contentHash
      || stableSerialize(open(existing.sanitizedEffectiveConfig)) !== stableSerialize(open(input.sanitizedEffectiveConfig))) {
      throw new ConfigError("snapshot_invalid", "The immutable config snapshot has different content.");
    }
    return existing;
  };
  const existing = await store.readSnapshot(input.id);
  if (existing !== null) return reuse(existing);
  const stored = sealing ? sealConfigSecretLiterals(input.sanitizedEffectiveConfig, sealing) : input.sanitizedEffectiveConfig;
  try {
    return await store.writeSnapshot({ ...input, sanitizedEffectiveConfig: stored, contentHash: contentHashOf(stored) });
  } catch (error) {
    const raced = await store.readSnapshot(input.id);
    if (raced !== null) return reuse(raced);
    throw error;
  }
}

/** True when any registered literal field holds a value a sealer would seal. */
export function containsSealableSecrets(root: unknown): boolean {
  return detectSecretLiteral(root, (value) => !isSealedSecretValue(value));
}

/** True when any sealed literal is present under root. */
export function containsSealedSecrets(root: unknown): boolean {
  return detectSecretLiteral(root, isSealedSecretValue);
}

function detectSecretLiteral(root: unknown, predicate: (value: string) => boolean): boolean {
  let found = false;
  mapConfigSecretLiterals(root, (value) => {
    if (predicate(value)) found = true;
    return value;
  });
  return found;
}

/**
 * Entity-update semantics for literal secret fields. Admin read APIs mask
 * stored literals as `<redacted>`, so editors omit untouched secret fields
 * from the replacement value. To keep that round-trip lossless:
 *   - a registered literal field ABSENT from `next` carries the stored value;
 *   - an explicit JSON null CLEARS the field (removed before validation);
 *   - anything else replaces wholesale.
 * Applies recursively (notify_feishu/app/auth nesting, context_repositories
 * entries paired by alias, web_search credentials { value } entries paired by
 * provider id). Non-secret fields keep wholesale-replace semantics.
 * `baseAncestors` carries the key path when the walk starts at a subtree
 * (e.g. a global set on agent.web_search), so nested credential maps keep
 * their context.
 */
export function carryOverSecretLiterals(stored: unknown, next: unknown, baseAncestors: readonly string[] = []): unknown {
  const visit = (oldValue: unknown, newValue: unknown, ancestors: readonly string[]): unknown => {
    if (Array.isArray(newValue)) {
      if (!Array.isArray(oldValue)) return newValue.map((entry) => visit(undefined, entry, ancestors));
      const aliasOf = (entry: unknown): string | undefined =>
        isPlainObject(entry) && typeof entry.alias === "string" ? entry.alias : undefined;
      const pairable = oldValue.every((entry) => aliasOf(entry) !== undefined)
        && newValue.every((entry) => aliasOf(entry) !== undefined);
      if (!pairable) return newValue.map((entry) => visit(undefined, entry, ancestors));
      const oldByAlias = new Map(oldValue.map((entry) => [aliasOf(entry)!, entry]));
      return newValue.map((entry) => visit(oldByAlias.get(aliasOf(entry)!), entry, ancestors));
    }
    if (!isPlainObject(newValue)) return newValue;
    const oldObject = isPlainObject(oldValue) ? oldValue : {};
    const credentialMap = ancestors.at(-1) === "credentials" && ancestors.includes("web_search");
    // Keys explicitly nulled are clears, not omissions: never carry them over.
    const cleared = new Set(Object.entries(newValue)
      .filter(([, child]) => child === null)
      .map(([key]) => key));
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(newValue)) {
      if (child === undefined) continue;
      if (child === null && (LITERAL_SECRET_FIELDS.has(key) || credentialMap)) continue;
      result[key] = visit(oldObject[key], child, [...ancestors, key]);
    }
    for (const [key, child] of Object.entries(oldObject)) {
      if (Object.hasOwn(result, key) || cleared.has(key) || child === undefined) continue;
      const credentialValue = key === "value" && isWebSearchCredentialsMap(ancestors.slice(0, -1));
      if (SEALED_LITERAL_SECRET_FIELDS.has(key) || key === "password_hash" || credentialValue) {
        result[key] = child;
        continue;
      }
      if (credentialMap && isPlainObject(child) && typeof child.value === "string") result[key] = child;
    }
    return result;
  };
  return visit(stored, next, baseAncestors);
}
