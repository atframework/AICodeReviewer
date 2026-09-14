/**
 * Config admin API client (spec §8.3/§8.4, P6 design doc §6).
 *
 * Plain-browser ESM: no framework, no Node APIs. Every method fetches the
 * relative "api/admin/config[/...]" surface (path_prefix safe), attaches the
 * admin Bearer token when present, speaks JSON, and normalizes failures to a
 * single {@link ConfigApiError} shape:
 *
 * - network failure      → { kind: "network" }
 * - 401                  → onUnauthorized() is invoked, then { kind: "http", status: 401 }
 * - 409 revision race    → { kind: "conflict", headRevision }
 * - 202 stored-not-live  → { kind: "activating", revision, stage } (D7: NEVER shown as applied)
 * - 400 field/validation → { kind: "invalid", fields: [{ path, entity, code, message }] }
 * - anything else        → { kind: "http", status, code }
 *
 * All dynamic text is returned as data; this module never builds HTML.
 */

/**
 * @typedef {object} ConfigApiError
 * @property {"network"|"http"|"conflict"|"invalid"|"activating"} kind
 * @property {number} [status] HTTP status when a response was received.
 * @property {string} [code] Server error code (body.error / body.code).
 * @property {string} message Human-readable, server-scrubbed message.
 * @property {{path: unknown, entity: unknown, code: string|undefined, message: string}[]} [fields]
 *           Field-level issues for kind "invalid" (A20 mapping input).
 * @property {number|null} [headRevision] Current head for kind "conflict".
 * @property {unknown} [revision] Revision metadata for kind "activating".
 * @property {string} [stage] Activation stage for kind "activating".
 */

/**
 * @typedef {object} ConfigApiClientDeps
 * @property {() => string|null|undefined} getToken Returns the current admin token (or null).
 * @property {() => void} onUnauthorized Invoked on every 401 before the error is thrown.
 */

/**
 * @typedef {object} ConfigChangesetPayload
 * @property {number|null} baseRevision Head revision the changeset is based on (CAS).
 * @property {string} fileDigest SHA-256 of the server's file configuration.
 * @property {string} operationId Idempotency key (crypto.randomUUID()); reused on retry.
 * @property {readonly object[]} operations ConfigChangesetOperation list.
 */

/** Base path for every request; relative so a deployment path_prefix keeps working. */
const API_BASE = "api/admin/config";

/**
 * Create a client for the config admin API.
 *
 * @param {ConfigApiClientDeps} deps
 * @returns {{
 *   getView: () => Promise<object>,
 *   getSchema: () => Promise<object>,
 *   getOptions: (source: string) => Promise<{source: string, options: object[]}>,
 *   validate: (payload: {baseRevision?: number|null, fileDigest?: string, operations: readonly object[]}) => Promise<object>,
 *   previewRoute: (event: object, draft?: object) => Promise<object>,
 *   saveChangeset: (payload: ConfigChangesetPayload) => Promise<object>,
 *   getOperation: (operationId: string) => Promise<object>,
 *   listRevisions: (params?: {before?: number}) => Promise<{revisions: object[]}>,
 *   getRevision: (revision: number) => Promise<object>,
 *   restore: (revision: number, payload: {baseRevision: number|null, fileDigest: string, operationId: string}) => Promise<object>,
 *   getStatus: () => Promise<object>,
 * }}
 */
export function createConfigApiClient({ getToken, onUnauthorized }) {
  /**
   * @param {string} method
   * @param {string} path Path relative to API_BASE ("" for the view root).
   * @param {unknown} [body] JSON body; undefined for GET.
   * @returns {Promise<any>} Parsed response body.
   */
  async function request(method, path, body) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = typeof getToken === "function" ? getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = path === "" || path.startsWith("?") ? API_BASE + path : `${API_BASE}/${path}`;
    /** @type {Response} */
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw normalizedError({
        kind: "network",
        message: `Network request failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const parsed = await readJson(response);
    if (response.status === 401) {
      if (typeof onUnauthorized === "function") onUnauthorized();
      throw normalizedError({
        kind: "http",
        status: 401,
        code: bodyCode(parsed),
        message: bodyMessage(parsed, "Authentication required."),
      });
    }
    // D7/A12: committed_activating is durable but NOT live — surface it as its
    // own kind so callers can never mistake it for an applied change.
    if (response.status === 202) {
      throw normalizedError({
        kind: "activating",
        status: 202,
        code: bodyCode(parsed),
        message: bodyMessage(parsed, "Change stored; runtime activation is still pending."),
        ...(parsed !== null && typeof parsed === "object"
          ? {
              revision: /** @type {Record<string, unknown>} */ (parsed).revision,
              stage: /** @type {Record<string, unknown>} */ (parsed).stage,
            }
          : {}),
      });
    }
    if (response.status === 409) {
      throw normalizedError({
        kind: "conflict",
        status: 409,
        code: bodyCode(parsed),
        message: bodyMessage(parsed, "The configuration changed while you were editing."),
        headRevision:
          parsed !== null && typeof parsed === "object" && typeof /** @type {Record<string, unknown>} */ (parsed).headRevision === "number"
            ? /** @type {Record<string, unknown>} */ (parsed).headRevision
            : null,
      });
    }
    if (response.status === 400) {
      throw normalizedError({
        kind: "invalid",
        status: 400,
        code: bodyCode(parsed),
        message: bodyMessage(parsed, "The change was rejected."),
        ...(() => {
          const fields = extractFieldIssues(parsed);
          return fields.length > 0 ? { fields } : {};
        })(),
      });
    }
    if (!response.ok) {
      throw normalizedError({
        kind: "http",
        status: response.status,
        code: bodyCode(parsed),
        message: bodyMessage(parsed, `Request failed with status ${response.status}.`),
      });
    }
    if (parsed === null || typeof parsed !== "object") {
      throw normalizedError({ kind: "network", message: "The response body was incomplete. Check the operation before retrying." });
    }
    return parsed;
  }

  return {
    /** GET / — redacted config view: head, fileDigest, collections, globals, fields. */
    async getView() {
      const view = await request("GET", "?limit=200");
      let offset = 0;
      for (;;) {
        const pending = Object.values(view.collections).map(collection => collection.nextOffset).filter(value => value !== null);
        if (pending.length === 0) return view;
        const nextOffset = Math.min(...pending);
        if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) throw normalizedError({ kind: "http", message: "Invalid configuration page cursor." });
        const next = await request("GET", `?limit=200&offset=${nextOffset}`);
        if (next.head?.activeRevision !== view.head?.activeRevision || next.fileDigest !== view.fileDigest) {
          throw normalizedError({ kind: "conflict", message: "Configuration changed while loading pages. Reload the view." });
        }
        for (const [kind, collection] of Object.entries(view.collections)) {
          if (collection.nextOffset === null) continue;
          const page = next.collections[kind];
          collection.records.push(...page.records);
          collection.nextOffset = page.nextOffset;
        }
        offset = nextOffset;
      }
    },
    /** GET /schema — protocol version plus the ConfigUiSpec (uiSpec key). */
    getSchema() {
      return request("GET", "schema");
    },
    /**
     * GET /options/:source — dynamic options for one optionsSource id.
     * @param {string} source Options source id from the uiSpec.
     */
    getOptions(source) {
      return request("GET", `options/${encodeURIComponent(source)}`);
    },
    /**
     * POST /validate — side-effect-free changeset validation (A09).
     * `baseRevision` is accepted for call-site symmetry but never transmitted:
     * the server DTO is strict and only takes { fileDigest?, operations }.
     * @param {{baseRevision?: number|null, fileDigest?: string, operations: readonly object[]}} payload
     */
    validate(payload) {
      return request("POST", "validate", {
        ...(payload.fileDigest !== undefined ? { fileDigest: payload.fileDigest } : {}),
        operations: payload.operations,
      });
    },
    /**
     * POST /preview-route — pure routing/workspace/model/outputs explanation.
     * @param {object} event ConfigRoutePreviewEvent fixture description.
     */
    previewRoute(event, draft) {
      return request("POST", "preview-route", { event, ...(draft ? { draft } : {}) });
    },
    /**
     * POST /changesets — atomic publish. 409 → conflict, 202 → activating,
     * network failure → caller polls getOperation with the same operationId (D7).
     * @param {ConfigChangesetPayload} payload
     */
    saveChangeset(payload) {
      return request("POST", "changesets", {
        baseRevision: payload.baseRevision,
        fileDigest: payload.fileDigest,
        operationId: payload.operationId,
        operations: payload.operations,
      });
    },
    /**
     * GET /operations/:operationId — lost-response recovery probe (D7).
     * @param {string} operationId
     */
    getOperation(operationId) {
      return request("GET", `operations/${encodeURIComponent(operationId)}`);
    },
    /**
     * GET /revisions — audit history, newest first.
     * @param {{before?: number}} [params] `before` paginates to older revisions.
     */
    listRevisions(params) {
      const before = params !== undefined && typeof params.before === "number" ? `?before=${params.before}` : "";
      return request("GET", `revisions${before}`);
    },
    /**
     * GET /revisions/:revision — one revision document + redacted audit diff.
     * @param {number} revision
     */
    getRevision(revision) {
      return request("GET", `revisions/${encodeURIComponent(String(revision))}`);
    },
    /**
     * POST /revisions/:revision/restore — creates a NEW revision with the
     * current head as parent; still file-locked and reference-checked.
     * @param {number} revision
     * @param {{baseRevision: number|null, fileDigest: string, operationId: string}} payload
     */
    restore(revision, payload) {
      return request("POST", `revisions/${encodeURIComponent(String(revision))}/restore`, {
        baseRevision: payload.baseRevision,
        fileDigest: payload.fileDigest,
        operationId: payload.operationId,
      });
    },
    /** GET /status — head, admission availability, per-instance ready flags. */
    getStatus() {
      return request("GET", "status");
    },
  };
}

/**
 * @param {ConfigApiError} error
 * @returns {ConfigApiError}
 */
function normalizedError(error) {
  return error;
}

/**
 * Parse a response body as JSON, tolerating empty/non-JSON payloads.
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * @param {unknown} body
 * @returns {string|undefined}
 */
function bodyCode(body) {
  if (body === null || typeof body !== "object") return undefined;
  const record = /** @type {Record<string, unknown>} */ (body);
  const code = record.error ?? record.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * @param {unknown} body
 * @param {string} fallback
 * @returns {string}
 */
function bodyMessage(body, fallback) {
  if (body !== null && typeof body === "object") {
    const message = /** @type {Record<string, unknown>} */ (body).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

/**
 * Map a 400 body to uniform field issues: A20 ConfigError bodies carry
 * top-level { path?, entity?, code, message }; DTO failures carry issues[].
 * @param {unknown} body
 * @returns {{path: unknown, entity: unknown, code: string|undefined, message: string}[]}
 */
function extractFieldIssues(body) {
  if (body === null || typeof body !== "object") return [];
  const record = /** @type {Record<string, unknown>} */ (body);
  const fields = [];
  if (record.path !== undefined || record.entity !== undefined) {
    fields.push({
      path: record.path,
      entity: record.entity,
      code: bodyCode(record),
      message: bodyMessage(record, "Invalid field value."),
    });
  }
  if (Array.isArray(record.issues)) {
    for (const issue of record.issues) {
      if (issue === null || typeof issue !== "object") continue;
      const entry = /** @type {Record<string, unknown>} */ (issue);
      fields.push({
        path: entry.path,
        entity: entry.entity,
        code: typeof entry.code === "string" ? entry.code : undefined,
        message: typeof entry.message === "string" ? entry.message : "Invalid field value.",
      });
    }
  }
  return fields;
}
