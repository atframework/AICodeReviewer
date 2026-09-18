/**
 * Config management UI application (architecture §3.16/§8.4, P6 design doc §5/§6).
 *
 * Plain-browser ESM: no framework, no Node APIs. Renders into the frozen
 * dashboard skeleton containers (#config-nav / #config-status / #config-main /
 * #config-editor), drives the paradigm modules (config-ui-runtime,
 * config-form-state, weekly-schedule) as pure state engines, and implements
 * the D7 save contract: CAS changesets with operationId idempotency, 409
 * conflict panel (keep draft, diff, reload / rebase-and-retry with the SAME
 * operationId), lost-response polling of GET /operations/:id, and 202
 * committed_activating surfaced as "stored, activation pending" — never as
 * applied (A12).
 *
 * XSS (A14/D9): every record id, note, and value reaches the DOM through
 * textContent/createTextNode only; the single injected <style> element is a
 * string literal.
 */

import { createConfigApiClient } from "./api-client.js";
import { createRenderer } from "./renderer.js";

/** Route preview target kinds — mirrors the POST /preview-route event DTO enum. */
const PREVIEW_TARGET_KINDS = ["pull_request", "push", "commit", "issue", "manual", "scheduled"];
/** Lost-response recovery: poll GET /operations/:id up to this many times (D7). */
const LOST_RESPONSE_POLLS = 3;
/** Backoff between lost-response polls. */
const LOST_RESPONSE_BACKOFF_MS = 1000;

/**
 * @typedef {object} ConfigAppDeps
 * @property {Document} root Document hosting the dashboard skeleton containers.
 * @property {ReturnType<typeof createConfigApiClient>} api Config admin API client.
 * @property {object} runtime config-ui-runtime module (resolveFieldState …).
 * @property {object} formState config-form-state module (sessions, encode, diff, rebase).
 * @property {object} schedule weekly-schedule module (compile/nextAllowedInstant).
 */

/** @type {{show: () => Promise<void>, hide: () => void}|null} */
let activeApp = null;

/**
 * Initialize the config app with explicit dependencies (tests use this; the
 * dashboard's lazy import path goes through the default export instead).
 *
 * @param {ConfigAppDeps} deps
 * @returns {{show: () => Promise<void>, hide: () => void}}
 */
export function initConfigApp(deps) {
  activeApp = createApp(deps);
  return activeApp;
}

/**
 * Lazily initialize from sibling modules + the dashboard's token storage and
 * call show(). Wired as window.__aicrConfigApp for the dashboard.html hook.
 */
const defaultExport = {
  /** Show the config tab, initializing on first activation. */
  async show() {
    const app = await ensureDefaultApp();
    await app.show();
  },
  /** Hide the editor drawer (draft state is preserved). */
  hide() {
    if (activeApp !== null) activeApp.hide();
  },
};
export default defaultExport;

/**
 * @returns {Promise<{show: () => Promise<void>, hide: () => void}>}
 */
async function ensureDefaultApp() {
  if (activeApp === null) {
    const [runtime, formState, schedule] = await Promise.all([
      import("./config-ui-runtime.js"),
      import("./config-form-state.js"),
      import("./weekly-schedule.js"),
    ]);
    const api = createConfigApiClient({
      getToken: () => {
        try {
          return globalThis.localStorage?.getItem("aicr_token") ?? null;
        } catch {
          return null;
        }
      },
      onUnauthorized: () => {
        if (typeof globalThis.logout === "function") globalThis.logout();
      },
    });
    activeApp = createApp({ root: document, api, runtime, formState, schedule });
  }
  return activeApp;
}

/**
 * @param {ConfigAppDeps} deps
 * @returns {{show: () => Promise<void>, hide: () => void}}
 */
function createApp({ root, api, runtime, formState, schedule }) {
  const renderer = createRenderer(root);
  renderer.setItemOptionsResolver((_parentField, itemField, value) =>
    runtime.resolveItemOptions(itemField, value, state.references),
  );
  const state = {
    initialized: false,
    spec: null,
    view: null,
    /** Curated LLM provider presets from GET /schema (no credentials). */
    providerPresets: [],
    references: {},
    pageId: null,
    /** @type {Map<string, {session: object, baseInput: object, operationId: string, fieldNodes: Map<string, HTMLElement>, previewNodes: Map<string, HTMLElement>}>} */
    pageSessions: new Map(),
    /** @type {Map<string, Map<string, boolean>>} section open state per editor context, survives full page rebuilds. */
    sectionStates: new Map(),
    /** @type {readonly string[]} Global dotted prefixes where the database wins over the file. */
    databasePriorityPrefixes: [],
    /** @type {{templates: readonly object[], prompts: readonly object[]}} Read-only built-in assets (copy sources). */
    builtinAssets: { templates: [], prompts: [] },
    drawer: null,
    fieldErrors: [],
    message: null,
    status: null,
    statusFailed: null,
    saving: false,
    pending: null,
    staged: new Map(),
    stagedOperationId: null,
    revisions: [],
    revisionsExhausted: false,
  };
  const els = { nav: null, status: null, main: null, editor: null };

  // -------------------------------------------------------------------------
  // Small DOM helpers (dynamic text via textContent only — A14)
  // -------------------------------------------------------------------------

  function el(tag, className, text) {
    const node = root.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clearChildren(node) {
    while (node.firstChild !== null) node.removeChild(node.firstChild);
  }

  function button(className, label, onClick) {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function ensureContainers() {
    if (els.nav !== null) return;
    els.nav = root.getElementById("config-nav");
    els.status = root.getElementById("config-status");
    els.main = root.getElementById("config-main");
    els.editor = root.getElementById("config-editor");
    if (els.nav === null || els.status === null || els.main === null || els.editor === null) {
      throw new Error("config dashboard skeleton containers are missing (config-nav/config-status/config-main/config-editor)");
    }
  }

  function injectStyles() {
    if (root.getElementById("cfg-styles") !== null) return;
    const style = root.createElement("style");
    style.id = "cfg-styles";
    style.textContent = CONFIG_APP_STYLES;
    root.head.append(style);
  }

  async function show() {
    ensureContainers();
    injectStyles();
    if (state.initialized) {
      renderStatusBar();
      // The editor container was hidden on hide(); restore an open drawer so
      // its draft survives top-level tab switches.
      if (state.drawer !== null) renderDrawer();
      return;
    }
    setLoading(true);
    try {
      const [schema, view] = await Promise.all([api.getSchema(), api.getView()]);
      state.spec = schema !== null && typeof schema === "object" ? schema.uiSpec : null;
      state.providerPresets =
        schema !== null && typeof schema === "object" && Array.isArray(schema.providerPresets)
          ? schema.providerPresets.filter(
              (preset) =>
                preset !== null &&
                typeof preset === "object" &&
                typeof preset.id === "string" &&
                typeof preset.kind === "string" &&
                typeof preset.baseUrl === "string",
            )
          : [];
      state.view = view;
      state.databasePriorityPrefixes =
        schema !== null && typeof schema === "object" && Array.isArray(schema.databasePriorityPrefixes)
          ? schema.databasePriorityPrefixes.filter((prefix) => typeof prefix === "string" && prefix.length > 0)
          : [];
      state.builtinAssets =
        schema !== null && typeof schema === "object" && schema.builtinAssets !== null && typeof schema.builtinAssets === "object"
          ? {
              templates: Array.isArray(schema.builtinAssets.templates) ? schema.builtinAssets.templates : [],
              prompts: Array.isArray(schema.builtinAssets.prompts) ? schema.builtinAssets.prompts : [],
            }
          : { templates: [], prompts: [] };
      if (state.spec === null || !Array.isArray(state.spec.pages)) {
        throw new Error("The schema response does not carry a uiSpec.");
      }
      state.initialized = true;
      buildNav();
      renderStatusBar();
      const first = state.spec.pages[0];
      if (first !== undefined) await selectPage(first.id);
    } catch (error) {
      showFatalError(error);
    } finally {
      setLoading(false);
    }
  }

  function hide() {
    if (els.editor !== null) els.editor.hidden = true;
  }

  function setLoading(on) {
    if (els.main === null) return;
    els.main.setAttribute("aria-busy", String(on));
    if (on) {
      clearChildren(els.main);
      els.main.append(el("div", "cfg-empty", "Loading configuration…"));
    }
  }

  function showFatalError(error) {
    clearChildren(els.main);
    els.main.append(renderer.errorBanner(errorMessage(error, "Failed to load the configuration UI.")));
    els.main.append(button("cfg-btn cfg-btn-ghost", "Retry", () => void show()));
  }

  // -------------------------------------------------------------------------
  // Status bar + messages (aria-live per U23)
  // -------------------------------------------------------------------------

  function headRevision() {
    const head = state.view !== null && typeof state.view === "object" ? state.view.head : null;
    return head !== null && typeof head === "object" && typeof head.activeRevision === "number" ? head.activeRevision : null;
  }

  function renderStatusBar() {
    if (els.status === null) return;
    clearChildren(els.status);
    const line = el("div", "cfg-status-line");
    const revision = headRevision();
    line.append(el("span", "cfg-status-item", `Revision ${revision ?? "—"}`));
    const namespace = state.view !== null && typeof state.view.namespace === "string" ? state.view.namespace : "—";
    line.append(el("span", "cfg-status-item", `namespace ${namespace}`));
    const digest = state.view !== null && typeof state.view.fileDigest === "string" ? state.view.fileDigest.slice(0, 8) : "—";
    line.append(el("span", "cfg-status-item", `file ${digest}`));
    if (state.status !== null) {
      const admission = state.status.admission;
      if (admission !== null && typeof admission === "object" && admission.available === true) {
        line.append(el("span", "cfg-status-item", `runtime revision ${admission.databaseRevision ?? "—"}`));
      } else {
        line.append(el("span", "cfg-status-item cfg-status-warn", "runtime admission unavailable"));
      }
    } else if (state.statusFailed !== null) {
      line.append(el("span", "cfg-status-item cfg-status-warn", `status: ${state.statusFailed}`));
    }
    els.status.append(line);
    const message = el("div", "cfg-status-msg");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    if (state.message !== null) {
      message.textContent = state.message.text;
      if (state.message.tone === "error") message.classList.add("cfg-msg-error");
      else if (state.message.tone === "ok") message.classList.add("cfg-msg-ok");
      else if (state.message.tone === "warn") message.classList.add("cfg-msg-warn");
    }
    els.status.append(message);
    if (state.pending) {
      els.status.append(button("cfg-btn cfg-btn-ghost", "Check pending save", () => void resolveLostResponse(state.pending.payload, state.pending.context)));
    }
    if (state.staged.size > 0) {
      const panel = el("div", "cfg-panel");
      panel.append(el("div", "cfg-field-note", `${state.staged.size} staged edits — published together`));
      for (const [key, entry] of state.staged) panel.append(el("div", "cfg-field-note", `${key}: ${entry.operations.map(op => op.op).join(", ")}`));
      const save = button("cfg-btn cfg-btn-primary", "Publish staged changes", () => void publishStaged());
      save.disabled = state.saving || state.pending !== null;
      const discard = button("cfg-btn cfg-btn-ghost", "Discard staged changes", () => {
        for (const key of state.staged.keys()) {
          if (key.startsWith("page/")) state.pageSessions.delete(key.slice(5));
        }
        if (state.drawer?.record && state.staged.has(`${state.drawer.page.entity.collection}/${state.drawer.record.id}`)) closeDrawer();
        state.staged.clear(); state.stagedOperationId = null; refreshStagedReferences(); renderPage(); renderStatusBar();
      });
      discard.disabled = state.saving || state.pending !== null;
      panel.append(save, discard);
      els.status.append(panel);
    }
  }

  function setStatusMessage(text, tone) {
    state.message = { text, tone };
    renderStatusBar();
  }

  // -------------------------------------------------------------------------
  // Navigation + page dispatch
  // -------------------------------------------------------------------------

  function currentPage() {
    if (state.spec === null) return null;
    return state.spec.pages.find((page) => page.id === state.pageId) ?? null;
  }

  function buildNav() {
    clearChildren(els.nav);
    for (const page of state.spec.pages) {
      const item = el("button", "cfg-nav-item", page.label);
      item.type = "button";
      if (page.id === state.pageId) {
        item.classList.add("cfg-active");
        item.setAttribute("aria-current", "page");
      }
      item.addEventListener("click", () => void selectPage(page.id));
      els.nav.append(item);
    }
  }

  async function selectPage(id) {
    if (id !== state.pageId && state.drawer !== null) {
      // The drawer belongs to the page it was opened on; never leak it into
      // another sub-tab. Unsaved edits follow the same discard confirmation
      // as an explicit close; cancelling keeps the user on the current page.
      if (!state.drawer.readonly && state.drawer.session.dirty === true) {
        openConfirm({
          title: "Discard unsaved changes?",
          body: "The draft in this editor has not been saved. Switching pages discards every edit made since the editor was opened.",
          confirmLabel: "Discard",
          danger: true,
          onConfirm: () => {
            closeDrawer();
            void selectPage(id);
          },
        });
        return;
      }
      closeDrawer();
    }
    state.pageId = id;
    state.fieldErrors = [];
    buildNav();
    await ensureReferences(currentPage());
    renderPage();
    if (id === "versions" && state.status === null && state.statusFailed === null) void loadStatus();
  }

  /** Fetch every optionsSource used by the page's fields (errors captured per source, U19). */
  async function ensureReferences(page) {
    if (page === null) return;
    const needed = new Set();
    const collect = (field) => {
      if (typeof field.optionsSource === "string") needed.add(field.optionsSource);
      if (Array.isArray(field.itemFields)) field.itemFields.forEach(collect);
    };
    for (const section of page.sections) section.fields.forEach(collect);
    const missing = [...needed];
    if (missing.length === 0) return;
    await Promise.all(
      missing.map(async (source) => {
        try {
          const result = await api.getOptions(source);
          state.references[source] = { source, options: Array.isArray(result.options) ? result.options : [] };
        } catch (error) {
          state.references[source] = { source, options: [], error: errorMessage(error, "Failed to load options.") };
        }
      }),
    );
    refreshStagedReferences();
  }

  function refreshStagedReferences() {
    for (const [source, reference] of Object.entries(state.references)) {
      const options = reference.options.filter(option => option.staged !== true);
      for (const entry of state.staged.values()) {
        for (const operation of entry.operations) {
          if (operation.op === "create" && operation.collection === source) {
            options.push({ value: operation.record.name, label: `${operation.record.name} (staged)`, staged: true });
          }
        }
      }
      state.references[source] = { ...reference, options };
    }
  }

  function renderPage() {
    clearChildren(els.main);
    const page = currentPage();
    if (page === null) return;
    if (page.id === "versions") {
      renderVersionsPage();
      return;
    }
    if (page.entity !== undefined) renderEntitySection(page);
    if (page.id === "routing") renderRoutePreviewSection();
    if (page.id === "routing") renderLegacyRoutesSection();
    if (page.globals === true || page.entity === undefined) renderGlobalsSection(page);
  }

  // -------------------------------------------------------------------------
  // Shared editor mechanics (drawer + globals pages)
  // -------------------------------------------------------------------------

  function allFields(page) {
    const fields = [];
    for (const section of page.sections) fields.push(...section.fields);
    return fields;
  }

  function lastToken(path) {
    return Array.isArray(path) && path.length > 0 ? String(path[path.length - 1]) : "";
  }

  function getAtPath(value, path) {
    let current = value;
    for (const token of path) {
      if (current === null || typeof current !== "object") return undefined;
      current = current[token];
    }
    return current;
  }

  function isScheduleRulesField(field) {
    if (field.control !== "ordered-list" || !Array.isArray(field.itemFields)) return false;
    const tokens = field.itemFields.map((item) => lastToken(item.path));
    return tokens.includes("days") && tokens.includes("windows");
  }

  /**
   * Next-execution preview for weekly-schedule composites (D8), computed via
   * the served weekly-schedule module. Returns null for non-schedule fields.
   */
  function schedulePreviewNode(page, field, session) {
    if (!isScheduleRulesField(field)) return null;
    const node = el("div", "cfg-field-note cfg-schedule-preview");
    updateSchedulePreview(node, page, field, session);
    return node;
  }

  function updateSchedulePreview(node, page, field, session) {
    const draftField = session.draft.fields[field.id];
    const rows = draftField !== undefined && Array.isArray(draftField.value) ? draftField.value : [];
    const itemFields = Array.isArray(field.itemFields) ? field.itemFields : [];
    const daysField = itemFields.find((item) => lastToken(item.path) === "days");
    const windowsField = itemFields.find((item) => lastToken(item.path) === "windows");
    const windowFields = windowsField !== undefined && Array.isArray(windowsField.itemFields) ? windowsField.itemFields : [];
    const startField = windowFields.find((item) => lastToken(item.path) === "start");
    const endField = windowFields.find((item) => lastToken(item.path) === "end");
    const timezonePath = [...field.path.slice(0, -1), "timezone"];
    const timezoneField = allFields(page).find(
      (candidate) => candidate.path.length === timezonePath.length && candidate.path.every((token, at) => token === timezonePath[at]),
    );
    const timezoneDraft = timezoneField !== undefined ? session.draft.fields[timezoneField.id] : undefined;
    const timezone =
      typeof timezoneDraft?.value === "string" && timezoneDraft.value.length > 0
        ? timezoneDraft.value
        : typeof timezoneDraft?.effectiveValue === "string" && timezoneDraft.effectiveValue.length > 0
          ? timezoneDraft.effectiveValue
          : "UTC";
    try {
      if (daysField === undefined || windowsField === undefined || startField === undefined || endField === undefined) {
        throw new Error("schedule shape mismatch");
      }
      const rules = rows
        .filter((row) => row !== null && typeof row === "object")
        .map((row) => {
          const windows = Array.isArray(runtime.readRowField(row, windowsField)) ? runtime.readRowField(row, windowsField) : [];
          return {
            days: Array.isArray(runtime.readRowField(row, daysField)) ? runtime.readRowField(row, daysField).filter((day) => typeof day === "string") : [],
            windows: windows
              .filter((entry) => entry !== null && typeof entry === "object")
              .map((entry) => ({
                start: runtime.readRowField(entry, startField) ?? "",
                end: runtime.readRowField(entry, endField) ?? "",
              })),
          };
        });
      const compiled = schedule.compileWeeklySchedule({ timezone, rules });
      if (compiled.unrestricted === true) {
        node.textContent = "No rules — execution is allowed at any time.";
        return;
      }
      const next = schedule.nextAllowedInstant(compiled, Date.now());
      node.textContent = `Next execution: ${new Date(next).toLocaleString()} (${timezone}).`;
    } catch {
      node.textContent = "Enter a valid schedule (HH:MM windows, valid IANA timezone) to preview the next execution.";
    }
  }

  /**
   * Render one editor field against a session and wire all handlers.
   * @param {object} editor {page, session, setSession, fieldNodes, previewNodes, rerender, updateSaveState}
   */
  function renderEditorField(editor, field) {
    const draftField = editor.session.draft.fields[field.id];
    const wrap = el("div", "cfg-editor-field");
    if (draftField === undefined) {
      wrap.hidden = true;
      return wrap;
    }
    const fieldState = runtime.resolveFieldState(editor.page, field.id, editor.session.draft, state.references, state.fieldErrors);
    const node = renderer.renderField(field, fieldState, draftField, editorHandlers(editor));
    wrap.append(node);
    const preview = schedulePreviewNode(editor.page, field, editor.session);
    if (preview !== null) {
      wrap.append(preview);
      editor.previewNodes.set(field.id, preview);
    }
    editor.fieldNodes.set(field.id, wrap);
    return wrap;
  }

  function editorHandlers(editor) {
    const structural = (fieldId) => {
      editor.updateSaveState();
      refreshDependents(editor, fieldId);
      editor.rerender();
    };
    return {
      onValueChange(fieldId, value) {
        editor.setSession(formState.sessionSetValue(editor.session, fieldId, value));
        if (editor.page.entity?.kindField && fieldId.endsWith(`:${editor.page.entity.kindField}`)) {
          structural(fieldId);
          return;
        }
        editor.updateSaveState();
        refreshDependents(editor, fieldId);
        refreshSchedulePreview(editor, fieldId);
      },
      onInheritChange(fieldId, inherit) {
        const current = editor.session.draft.fields[fieldId]?.inherit === true;
        if (current !== inherit) {
          editor.setSession(formState.sessionToggleInherit(editor.session, fieldId));
          structural(fieldId);
        }
      },
      onPresentChange(fieldId, present) {
        editor.setSession(formState.sessionSetPresent(editor.session, fieldId, present));
        structural(fieldId);
      },
      onListOp(fieldId, op) {
        editor.setSession(formState.sessionListOp(editor.session, fieldId, op));
        if (op.type === "set") {
          // Value-level row edit: keep focus, just refresh dependent state.
          editor.updateSaveState();
          refreshDependents(editor, fieldId);
          refreshSchedulePreview(editor, fieldId);
        } else {
          structural(fieldId);
        }
      },
      onMapOp(fieldId, op) {
        editor.setSession(formState.sessionMapOp(editor.session, fieldId, op));
        if (op.type === "setKey" || op.type === "setValue") {
          editor.updateSaveState();
          refreshDependents(editor, fieldId);
        } else {
          structural(fieldId);
        }
      },
    };
  }

  /** Re-render fields whose visibleWhen depends on the changed field. */
  function refreshDependents(editor, changedFieldId) {
    const touchedSections = new Set();
    for (const field of allFields(editor.page)) {
      if (field.visibleWhen === undefined || field.visibleWhen.field !== changedFieldId) continue;
      const old = editor.fieldNodes.get(field.id);
      if (old === undefined) continue;
      const section = old.closest("details.cfg-section");
      const next = renderEditorField(editor, field);
      old.replaceWith(next);
      if (section !== null) touchedSections.add(section);
    }
    for (const section of touchedSections) syncOneSectionVisibility(section);
  }

  function refreshSchedulePreview(editor, changedFieldId) {
    for (const field of allFields(editor.page)) {
      const node = editor.previewNodes.get(field.id);
      if (node === undefined) continue;
      if (field.id === changedFieldId || lastToken(field.path) === "rules" || changedFieldId.endsWith("timezone")) {
        updateSchedulePreview(node, editor.page, field, editor.session);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Entity pages: table + actions (D-contract)
  // -------------------------------------------------------------------------

  function collectionRecords(page) {
    const kind = page.entity.kind;
    const collections = state.view !== null && typeof state.view === "object" ? state.view.collections : null;
    const collection = collections !== null && typeof collections === "object" ? collections[kind] : null;
    return {
      records: collection !== null && typeof collection === "object" && Array.isArray(collection.records) ? collection.records : [],
      truncated: collection !== null && typeof collection === "object" && collection.nextOffset !== null && collection.nextOffset !== undefined,
    };
  }

  function renderEntitySection(page) {
    const { records, truncated } = collectionRecords(page);
    const header = el("div", "cfg-page-head");
    header.append(el("h2", "cfg-page-title", page.label));
    const kindLabel = page.entity.kind.replace(/_/g, " ");
    header.append(button("cfg-btn cfg-btn-primary", `New ${kindLabel}`, () => openEntityDrawer(page, null, { readonly: false })));
    els.main.append(header);
    if (truncated) {
      els.main.append(el("div", "cfg-field-note", "Showing the first page of records only; use the filter to narrow down."));
    }

    /** @type {Map<string, {prev: object|undefined, next: object|undefined}>} */
    let reorder = new Map();
    if (page.id === "routing") {
      const sorted = records.slice().sort((a, b) => priorityOf(a) - priorityOf(b));
      sorted.forEach((record, index) => {
        reorder.set(record.id, { prev: sorted[index - 1], next: sorted[index + 1] });
      });
    }
    const swappable = (record, neighbor) => record.readonly !== true && neighbor !== undefined && neighbor.readonly !== true;

    const actions = [
      { id: "edit", label: "Edit", title: "Edit this database record", when: (record) => record.readonly !== true && record.shadowedByFile !== true },
      { id: "view", label: "View", title: "Inspect this file-owned record", when: (record) => record.readonly === true },
      { id: "disable", label: "Disable", title: "Disable immediately (one changeset)", when: (record) => record.readonly !== true && record.shadowedByFile !== true && record.enabled !== false },
      { id: "enable", label: "Enable", title: "Enable immediately (one changeset)", when: (record) => record.readonly !== true && record.shadowedByFile !== true && record.enabled === false },
      { id: "delete", label: "Delete", title: "Delete this database record", tone: "danger", when: (record) => record.readonly !== true },
    ];
    if (page.id === "routing") {
      actions.push(
        {
          id: "route-up",
          label: "↑",
          title: "Evaluate earlier (swap priority with the rule above)",
          when: (record) => swappable(record, reorder.get(record.id)?.prev),
        },
        {
          id: "route-down",
          label: "↓",
          title: "Evaluate later (swap priority with the rule below)",
          when: (record) => swappable(record, reorder.get(record.id)?.next),
        },
      );
    }

    const table = renderer.renderEntityTable({
      records,
      actions,
      emptyText: `No ${page.label.toLowerCase()} configured yet.`,
      onAction: (actionId, record) => void onEntityAction(page, actionId, record, reorder),
    });
    els.main.append(table);
    renderBuiltinAssetsSection(page);
  }

  /**
   * Read-only built-in assets on the Templates/Prompts pages: built-ins are
   * never stored or edited; each offers "Copy as new database config".
   */
  function renderBuiltinAssetsSection(page) {
    const assets = page.id === "templates" ? state.builtinAssets.templates : page.id === "prompts" ? state.builtinAssets.prompts : [];
    if (assets.length === 0) return;
    els.main.append(renderer.renderBuiltinAssets({
      title: page.id === "templates" ? "Built-in templates (read-only)" : "Built-in prompts (read-only)",
      assets,
      onCopy: (asset) => openBuiltinCopyDrawer(page, asset),
    }));
  }

  /** Open the create drawer prefilled with a built-in asset's document. */
  function openBuiltinCopyDrawer(page, asset) {
    if (state.saving || state.pending !== null) return;
    const document = typeof asset.document === "string" ? asset.document : "";
    openCopyDrawer(page, {
      id: typeof asset.id === "string" && asset.id.length > 0 ? asset.id : "built-in",
      name: "",
      enabled: true,
      source: "builtin",
      readonly: true,
      shadowedByFile: false,
      value: document,
      effectiveValue: document,
    });
  }

  function priorityOf(record) {
    const value = record !== null && typeof record === "object" ? record.value : null;
    return value !== null && typeof value === "object" && typeof value.priority === "number" ? value.priority : 0;
  }

  async function onEntityAction(page, actionId, record, reorder) {
    if (state.saving || state.pending !== null) return;
    const collection = page.entity.collection;
    if (actionId === "edit") {
      openEntityDrawer(page, record, { readonly: false });
      return;
    }
    if (actionId === "view") {
      openEntityDrawer(page, record, { readonly: true });
      return;
    }
    if (actionId === "disable" || actionId === "enable") {
      const operation = formState.buildEntityAction({
        type: "set-enabled",
        collection,
        recordId: record.id,
        enabled: actionId === "enable",
      });
      await submitChangeset({ operations: [operation], operationId: newOperationId(), context: { kind: "action", page } });
      return;
    }
    if (actionId === "delete") {
      openConfirm({
        title: `Delete ${record.id}?`,
        body: `This removes the database record "${record.id}" from the ${collection} collection. File-owned configuration is unaffected. The change is validated and published atomically.`,
        confirmLabel: "Delete",
        danger: true,
        onConfirm: async () => {
          const operation = formState.buildEntityAction({ type: "delete", collection, recordId: record.id });
          await submitChangeset({ operations: [operation], operationId: newOperationId(), context: { kind: "action", page } });
        },
      });
      return;
    }
    if (actionId === "route-up" || actionId === "route-down") {
      const neighbor = actionId === "route-up" ? reorder.get(record.id)?.prev : reorder.get(record.id)?.next;
      if (neighbor === undefined) return;
      const mine = deepClone(record.value);
      const theirs = deepClone(neighbor.value);
      const myPriority = priorityOf(record);
      mine.priority = priorityOf(neighbor);
      theirs.priority = myPriority;
      await submitChangeset({
        operations: [
          { op: "update", collection, recordId: record.id, value: mine },
          { op: "update", collection, recordId: neighbor.id, value: theirs },
        ],
        operationId: newOperationId(),
        context: { kind: "action", page },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Editor drawer (create / edit / view / copy-as-new)
  // -------------------------------------------------------------------------

  function entityBaseInput(record) {
    return {
      record: record ?? null,
      baseRevision: headRevision(),
      fileDigest: typeof state.view.fileDigest === "string" ? state.view.fileDigest : "",
    };
  }

  function openEntityDrawer(page, record, options) {
    if (state.saving || state.pending !== null) return;
    const staged = record && state.staged.get(`${page.entity.collection}/${record.id}`);
    const baseInput = staged?.baseInput ?? entityBaseInput(record);
    const session = staged?.session ?? formState.createEditorSession(page, baseInput);
    state.drawer = {
      page,
      record,
      readonly: options.readonly === true,
      session,
      baseInput,
      operationId: newOperationId(),
      fieldNodes: new Map(),
      previewNodes: new Map(),
      copiedFrom: options.copiedFrom,
      copiedRefs: options.copiedRefs ?? [],
      appliedPresetId: null,
      panelHost: null,
    };
    renderDrawer();
  }

  /**
   * D-contract: file-owned records offer "Copy as new database config" — a
   * create draft prefilled from a deep clone of record.value with a new empty
   * id plus a hint listing carried-over references.
   */
  function openCopyDrawer(page, record) {
    const clone = deepClone(record.value);
    const synthetic = {
      id: "",
      name: "",
      enabled: true,
      source: "database",
      readonly: false,
      shadowedByFile: false,
      value: clone,
      effectiveValue: deepClone(record.value),
    };
    let session = formState.createEditorSession(page, {
      record: synthetic,
      baseRevision: headRevision(),
      fileDigest: typeof state.view.fileDigest === "string" ? state.view.fileDigest : "",
    });
    // Turn the decoded edit-draft into a CREATE draft: clear the scope record
    // id and blank the entity id field so the user picks a fresh name.
    const scope = session.draft.scope;
    if (scope.kind === "entity") {
      session = { ...session, draft: { ...session.draft, scope: { ...scope, recordId: null } } };
    }
    const idField = page.entity.idField;
    if (typeof idField === "string") {
      const idFormField = allFields(page).find((field) => field.path.length === 1 && field.path[0] === idField);
      if (idFormField !== undefined) session = formState.sessionSetValue(session, idFormField.id, "");
    }
    const copiedRefs = allFields(page)
      .filter((field) => typeof field.optionsSource === "string")
      .map((field) => ({ label: field.label, value: getAtPath(clone, field.path) }))
      .filter((entry) => entry.value !== undefined && entry.value !== "" && !(Array.isArray(entry.value) && entry.value.length === 0))
      .map((entry) => `${entry.label}: ${Array.isArray(entry.value) ? entry.value.join(", ") : String(entry.value)}`);
    state.drawer = {
      page,
      record: null,
      readonly: false,
      session,
      baseInput: entityBaseInput(null),
      operationId: newOperationId(),
      fieldNodes: new Map(),
      previewNodes: new Map(),
      copiedFrom: record.id,
      copiedRefs,
      appliedPresetId: null,
      panelHost: null,
    };
    renderDrawer();
  }

  /**
   * Prefill a NEW provider draft from a curated preset (schema providerPresets).
   * Only the advertised connection fields are written; the user can still edit every
   * value before saving, and the preset never touches existing records.
   */
  function applyProviderPreset(drawer, presetId) {
    const preset = state.providerPresets.find((candidate) => candidate.id === presetId);
    if (preset === undefined) return;
    let session = drawer.session;
    if (typeof preset.kind === "string" && preset.kind !== "" && session.kind !== preset.kind) {
      session = formState.sessionSwitchKind(session, preset.kind);
    }
    const assignments = [
      ["provider:id", preset.id],
      ["provider:base_url", preset.baseUrl],
      ["provider:api_key_env", preset.apiKeyEnv],
      ["provider:catalog_provider", preset.catalogProvider],
    ];
    const literalKey = session.draft.fields["provider:api_key"];
    for (const [fieldId, value] of assignments) {
      // A literal key and an env reference are mutually exclusive. Keep an
      // explicitly entered literal instead of creating an invalid draft.
      if (fieldId === "provider:api_key_env" && literalKey?.mode === "present" && literalKey.value) {
        session = formState.sessionSetPresent(session, fieldId, false);
        continue;
      }
      if (typeof value !== "string" || value === "") continue;
      if (session.draft.fields[fieldId] === undefined) continue;
      session = formState.sessionSetValue(session, fieldId, value);
    }
    drawer.session = session;
    drawer.appliedPresetId = preset.id;
    renderDrawer();
  }

  function presetNoteText(preset) {
    const parts = [
      `kind: ${preset.kind}`,
      `base_url: ${preset.baseUrl}`,
      `api_key_env: ${preset.apiKeyEnv}`,
      `catalog_provider: ${preset.catalogProvider}`,
    ];
    if (Array.isArray(preset.suggestedModels) && preset.suggestedModels.length > 0) {
      parts.push(`models: ${preset.suggestedModels.join(", ")}`);
    }
    if (typeof preset.docsUrl === "string" && preset.docsUrl !== "") {
      parts.push(`docs: ${preset.docsUrl}`);
    }
    if (typeof preset.note === "string" && preset.note !== "") {
      parts.push(preset.note);
    }
    return parts.join(" — ");
  }

  function renderPresetPicker(drawer) {
    const wrap = el("div", "cfg-field cfg-provider-preset");
    const label = el("label", "cfg-field-label", "Platform preset");
    const select = el("select", "cfg-input");
    select.id = "cfg-provider-preset";
    label.htmlFor = select.id;
    const placeholder = el("option", undefined, "— prefill from a known platform (Kimi, Zhipu, Z.AI, Alibaba, Tencent, DeepSeek) —");
    placeholder.value = "";
    select.append(placeholder);
    for (const preset of state.providerPresets) {
      const option = el("option", undefined, typeof preset.label === "string" && preset.label !== "" ? preset.label : preset.id);
      option.value = preset.id;
      if (drawer.appliedPresetId === preset.id) option.selected = true;
      select.append(option);
    }
    const note = el("div", "cfg-field-note");
    note.dataset.role = "preset-note";
    const selected = state.providerPresets.find((candidate) => candidate.id === select.value);
    note.textContent = selected !== undefined ? presetNoteText(selected) : "Apply preset fills id, kind, base_url, api_key_env and catalog_provider. An entered API key is kept instead of adding an env reference. Save publishes the draft.";
    select.addEventListener("change", () => {
      const next = state.providerPresets.find((candidate) => candidate.id === select.value);
      note.textContent = next !== undefined ? presetNoteText(next) : "";
    });
    const apply = button("cfg-btn cfg-btn-ghost", "Apply preset", () => {
      if (select.value !== "") applyProviderPreset(drawer, select.value);
    });
    apply.dataset.role = "apply-preset";
    wrap.append(label, select, apply, note);
    return wrap;
  }

  function drawerEditor() {
    const drawer = state.drawer;
    return {
      page: drawer.page,
      // Live getter: value edits do not re-render, so a later structural
      // change must read the CURRENT session, not a creation-time snapshot —
      // otherwise it silently discards pending value edits.
      get session() {
        return drawer.session;
      },
      setSession(next) {
        drawer.session = next;
      },
      fieldNodes: drawer.fieldNodes,
      previewNodes: drawer.previewNodes,
      rerender: renderDrawer,
      updateSaveState: updateDrawerSaveState,
    };
  }

  /**
   * Open/closed state of collapsible sections. Reads the current DOM; when it
   * has no rendered sections yet (fresh page build), falls back to the last
   * persisted state for this context so saves/page rebuilds never collapse
   * what the user opened.
   */
  function captureSectionState(host, key) {
    const found = new Map();
    for (const details of host.querySelectorAll("details.cfg-section[data-section-id]")) {
      found.set(details.dataset.sectionId, details.open);
    }
    if (found.size > 0) state.sectionStates.set(key, found);
    return state.sectionStates.get(key) ?? null;
  }

  function restoreSectionState(host, state) {
    if (state === null || state === undefined) return;
    for (const details of host.querySelectorAll("details.cfg-section[data-section-id]")) {
      const open = state.get(details.dataset.sectionId);
      if (open !== undefined) details.open = open;
    }
  }

  /**
   * Hide a rendered section when every field inside it is invisible
   * (kind-mismatch or visibleWhen), so kind-specific pages stay focused.
   */
  function syncOneSectionVisibility(details) {
    details.hidden = details.querySelector(".cfg-section-body .cfg-field:not([hidden])") === null;
  }

  function syncSectionVisibility(host) {
    if (host === null || host === undefined) return;
    for (const details of host.querySelectorAll("details.cfg-section")) syncOneSectionVisibility(details);
  }

  function renderDrawer() {
    const drawer = state.drawer;
    if (drawer === null) return;
    const sectionState = captureSectionState(els.editor, `drawer:${drawer.page.id}`);
    clearChildren(els.editor);
    els.editor.hidden = false;
    const box = el("div", "cfg-drawer");
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape") requestCloseDrawer();
    });

    const title = el("h2", "cfg-drawer-title");
    title.tabIndex = -1;
    if (drawer.copiedFrom !== undefined && drawer.copiedFrom !== null) {
      title.textContent = `New database config (copied from ${drawer.copiedFrom})`;
    } else if (drawer.readonly) {
      title.textContent = `View ${drawer.record.id}`;
    } else if (drawer.record !== null) {
      title.textContent = `Edit ${drawer.record.id}`;
    } else {
      title.textContent = `New ${drawer.page.entity.kind.replace(/_/g, " ")}`;
    }
    box.append(title);

    if (drawer.copiedRefs.length > 0) {
      const hint = el("div", "cfg-field-note");
      hint.textContent = `References carried over — verify they fit the new record: ${drawer.copiedRefs.join("; ")}`;
      box.append(hint);
    }

    // Curated platform presets (GET /schema → providerPresets) prefill a NEW
    // provider draft; existing records are never rewritten by a preset.
    if (
      drawer.page.id === "providers" &&
      drawer.record === null &&
      drawer.copiedFrom === undefined &&
      !drawer.readonly &&
      state.providerPresets.length > 0
    ) {
      box.append(renderPresetPicker(drawer));
    }

    const kindField = drawer.page.entity.kindField;
    const kindOptions = drawer.page.entity.kindOptions;
    if (typeof kindField === "string" && Array.isArray(kindOptions) && kindOptions.length > 0 && !drawer.readonly) {
      const row = el("div", "cfg-field");
      const label = el("label", "cfg-field-label", "Kind");
      const select = el("select", "cfg-input");
      select.id = "cfg-drawer-kind";
      label.htmlFor = select.id;
      for (const kind of kindOptions) {
        const option = el("option", undefined, kind);
        option.value = kind;
        if (drawer.session.kind === kind) option.selected = true;
        select.append(option);
      }
      select.addEventListener("change", () => {
        drawer.session = formState.sessionSwitchKind(drawer.session, select.value);
        renderDrawer();
      });
      row.append(label, select);
      box.append(row);
    }

    if (Array.isArray(drawer.session.removedOnSave) && drawer.session.removedOnSave.length > 0) {
      const note = el("div", "cfg-panel cfg-panel-warn");
      note.setAttribute("role", "status");
      note.textContent = `Fields not used by this kind will be removed on save: ${drawer.session.removedOnSave.join(", ")}`;
      box.append(note);
    }

    const panelHost = el("div", "cfg-drawer-panels");
    box.append(panelHost);
    drawer.panelHost = panelHost;

    const editor = drawerEditor();
    for (const section of drawer.page.sections) {
      const fieldEls = section.fields.map((field) => renderEditorField(editor, field));
      box.append(renderer.renderSection(section, fieldEls));
    }
    restoreSectionState(box, sectionState);
    syncSectionVisibility(box);

    const bar = el("div", "cfg-savebar");
    if (drawer.readonly) {
      bar.append(el("span", "cfg-field-note", "Owned by the config file — file entries take precedence over database records with the same name."));
      bar.append(
        button("cfg-btn cfg-btn-primary", "Copy as new database config", () => openCopyDrawer(drawer.page, drawer.record)),
      );
      bar.append(button("cfg-btn cfg-btn-ghost", "Close", () => closeDrawer()));
    } else {
      const save = button("cfg-btn cfg-btn-primary", "Save", () => void saveDrawer());
      save.dataset.role = "save";
      const cancel = button("cfg-btn cfg-btn-ghost", "Cancel", () => requestCloseDrawer());
      bar.append(save, button("cfg-btn cfg-btn-ghost", "Stage changes", () => stageEditor({ kind: "drawer", drawer })), cancel);
    }
    box.append(bar);
    els.editor.append(box);
    updateDrawerSaveState();
    title.focus();
  }

  function updateDrawerSaveState() {
    const drawer = state.drawer;
    if (drawer === null || els.editor === null) return;
    const save = els.editor.querySelector("[data-role=save]");
    if (save !== null) save.disabled = state.saving || state.pending !== null || drawer.session.dirty !== true;
    for (const node of els.editor.querySelectorAll(".cfg-editor-field")) node.inert = state.saving || state.pending !== null;
    const kind = els.editor.querySelector("#cfg-drawer-kind");
    if (kind) kind.disabled = state.saving || state.pending !== null;
  }

  async function saveDrawer() {
    if (!validateLocalFields({ kind: "drawer", drawer: state.drawer })) return;
    const drawer = state.drawer;
    if (drawer === null) return;
    let operations;
    try { ({ operations } = formState.sessionEncode(drawer.session, drawer.baseInput)); }
    catch (error) { showContextBanner({ kind: "drawer", drawer }, renderer.errorBanner(errorMessage(error, "Invalid draft."))); return; }
    if (operations.length === 0) {
      setStatusMessage("No changes to save.", "warn");
      return;
    }
    await submitChangeset({ operations, operationId: drawer.operationId, context: { kind: "drawer", drawer } });
  }

  function requestCloseDrawer() {
    const drawer = state.drawer;
    if (drawer === null) return;
    if (!drawer.readonly && drawer.session.dirty === true) {
      openConfirm({
        title: "Discard unsaved changes?",
        body: "The draft in this editor has not been saved. Discarding loses every edit made since the editor was opened.",
        confirmLabel: "Discard",
        danger: true,
        onConfirm: () => closeDrawer(),
      });
      return;
    }
    closeDrawer();
  }

  function closeDrawer() {
    state.drawer = null;
    state.fieldErrors = [];
    clearChildren(els.editor);
    els.editor.hidden = true;
  }

  // -------------------------------------------------------------------------
  // Globals pages (agent / review / queue / workspaces defaults / advanced …)
  // -------------------------------------------------------------------------

  function globalsBaseInput() {
    return {
      fields: state.view !== null && Array.isArray(state.view.fields) ? state.view.fields : [],
      baseRevision: headRevision(),
      fileDigest: typeof state.view.fileDigest === "string" ? state.view.fileDigest : "",
    };
  }

  function renderGlobalsSection(page) {
    let entry = state.pageSessions.get(page.id);
    if (entry === undefined) {
      const staged = state.staged.get(`page/${page.id}`);
      const baseInput = staged?.baseInput ?? globalsBaseInput();
      entry = {
        session: staged?.session ?? formState.createEditorSession(page, baseInput),
        baseInput,
        operationId: newOperationId(),
        fieldNodes: new Map(),
        previewNodes: new Map(),
      };
      state.pageSessions.set(page.id, entry);
    }
    const readonly = page.id === "advanced";
    if (page.entity === undefined) {
      const header = el("div", "cfg-page-head");
      header.append(el("h2", "cfg-page-title", page.label));
      els.main.append(header);
      if (readonly) {
        els.main.append(el("div", "cfg-field-note", "Bootstrap-owned and schema-only settings — edit the config file to change these."));
      }
    }
    const editor = {
      page,
      // Live getter — see drawerEditor: structural ops must never apply
      // against a stale session snapshot.
      get session() {
        return entry.session;
      },
      setSession(next) {
        entry.session = next;
      },
      fieldNodes: entry.fieldNodes,
      previewNodes: entry.previewNodes,
      rerender: () => renderGlobalsFields(page, entry),
      updateSaveState: () => updateGlobalsSaveState(page, entry),
    };
    const host = el("div", "cfg-globals");
    const fieldsHost = el("div", "cfg-globals-fields");
    host.append(fieldsHost);
    const panelHost = el("div", "cfg-globals-panels");
    host.append(panelHost);
    if (!readonly) {
      const bar = el("div", "cfg-savebar cfg-savebar-sticky");
      const dirtyNote = el("span", "cfg-field-note");
      dirtyNote.dataset.role = "dirty-note";
      const save = button("cfg-btn cfg-btn-primary", "Save page changes", () => void saveGlobals(page));
      save.dataset.role = "save";
      const reset = button("cfg-btn cfg-btn-ghost", "Discard page edits", () => requestResetGlobals(page));
      bar.append(dirtyNote, save, button("cfg-btn cfg-btn-ghost", "Stage page changes", () => stageEditor({ kind: "globals", page, entry })), reset);
      const dbResettable = resettableDbPrefixes(page);
      if (dbResettable.length > 0) {
        bar.append(button("cfg-btn cfg-btn-ghost", "Reset database overrides", () => requestResetDatabaseOverrides(page, dbResettable)));
      }
      host.append(bar);
    }
    els.main.append(host);
    entry.fieldsHost = fieldsHost;
    entry.panelHost = panelHost;
    entry.editor = editor;
    renderGlobalsFields(page, entry);
  }

  /** Database-priority prefixes that own at least one globals field on this page. */
  function resettableDbPrefixes(page) {
    const roots = new Set();
    // The served section JSON drops the layout scope; globals fields are
    // identified by id — "<root>:<rest>" from the document root — while entity
    // fields start with the entity kind prefix (see scopedGlobalFields).
    const entityPrefix = page.entity !== undefined && typeof page.entity.kind === "string" ? `${page.entity.kind}:` : null;
    for (const section of page.sections) {
      for (const field of section.fields ?? []) {
        if (typeof field.id !== "string") continue;
        if (entityPrefix !== null && field.id.startsWith(entityPrefix)) continue;
        const separator = field.id.indexOf(":");
        if (separator > 0) roots.add(field.id.slice(0, separator));
      }
    }
    return state.databasePriorityPrefixes.filter((prefix) => roots.has(prefix.split(".")[0]));
  }

  /** Prefixes that currently hold at least one database-sourced leaf value. */
  function prefixesWithDatabaseValues(prefixes) {
    const fields = state.view !== null && typeof state.view === "object" && Array.isArray(state.view.fields) ? state.view.fields : [];
    return prefixes.filter((prefix) => fields.some((field) =>
      field !== null && typeof field === "object" && typeof field.path === "string" &&
      (field.path === prefix || field.path.startsWith(`${prefix}.`) || field.path.startsWith(`${prefix}[`)) &&
      field.source === "database"));
  }

  function requestResetDatabaseOverrides(page, prefixes) {
    const active = prefixesWithDatabaseValues(prefixes);
    if (active.length === 0) {
      setStatusMessage("No database overrides to reset on this page.", "warn");
      return;
    }
    openConfirm({
      title: "Reset database overrides?",
      body: `Database values for ${active.join(", ")} and unsaved page edits will be removed; the config file or schema defaults take over.`,
      confirmLabel: "Reset",
      danger: true,
      onConfirm: () => void submitChangeset({
        operations: active.map((prefix) => ({ op: "unset", path: prefix.split(".") })),
        operationId: newOperationId(),
        context: { kind: "globals", page, entry: state.pageSessions.get(page.id), resetPrefixes: active },
      }),
    });
  }

  function renderGlobalsFields(page, entry) {
    if (entry.fieldsHost === undefined) return;
    const sectionState = captureSectionState(entry.fieldsHost, `page:${page.id}`);
    clearChildren(entry.fieldsHost);
    entry.fieldNodes.clear();
    for (const section of page.sections) {
      const fieldEls = section.fields.map((field) => renderEditorField(entry.editor, field));
      entry.fieldsHost.append(renderer.renderSection(section, fieldEls));
    }
    restoreSectionState(entry.fieldsHost, sectionState);
    syncSectionVisibility(entry.fieldsHost);
    updateGlobalsSaveState(page, entry);
  }

  function updateGlobalsSaveState(page, entry) {
    if (els.main === null || page.id === "advanced") return;
    const host = entry.panelHost?.parentElement ?? els.main;
    const save = host.querySelector("[data-role=save]");
    if (save !== null) save.disabled = state.saving || state.pending !== null || entry.session.dirty !== true;
    if (entry.fieldsHost) entry.fieldsHost.inert = state.saving || state.pending !== null;
    const note = host.querySelector("[data-role=dirty-note]");
    if (note !== null) note.textContent = entry.session.dirty === true ? "Unsaved changes" : "No changes";
  }

  async function saveGlobals(page) {
    const entry = state.pageSessions.get(page.id);
    if (entry === undefined) return;
    if (!validateLocalFields({ kind: "globals", entry })) return;
    let operations;
    try { ({ operations } = formState.sessionEncode(entry.session, entry.baseInput)); }
    catch (error) { showContextBanner({ kind: "globals", entry }, renderer.errorBanner(errorMessage(error, "Invalid draft."))); return; }
    if (operations.length === 0) {
      setStatusMessage("No changes to save.", "warn");
      return;
    }
    await submitChangeset({ operations, operationId: entry.operationId, context: { kind: "globals", page, entry } });
  }

  function requestResetGlobals(page) {
    const entry = state.pageSessions.get(page.id);
    if (entry === undefined) return;
    const reset = () => {
      state.pageSessions.delete(page.id);
      renderPage();
    };
    if (entry.session.dirty === true) {
      openConfirm({
        title: "Discard page edits?",
        body: "Every unsaved edit on this page will be lost.",
        confirmLabel: "Discard",
        danger: true,
        onConfirm: reset,
      });
      return;
    }
    reset();
  }

  // -------------------------------------------------------------------------
  // Routing extras: preview panel (D8)
  // -------------------------------------------------------------------------

  function stageEditor(context) {
    if (state.saving || state.pending !== null) return;
    if (!validateLocalFields(context)) return;
    const entry = context.kind === "drawer" ? context.drawer : context.entry;
    try {
      const { operations } = formState.sessionEncode(entry.session, entry.baseInput);
      const previous = state.staged.values().next().value;
      if (previous && (previous.baseRevision !== entry.baseInput.baseRevision || previous.fileDigest !== entry.baseInput.fileDigest)) {
        throw new Error("Staged edits must share the same revision. Publish or discard the existing staged changes first.");
      }
      const scope = entry.session.draft.scope;
      const created = operations.find(op => op.op === "create");
      if (scope.kind === "entity" && scope.recordId === null && !created) return;
      const key = scope.kind === "entity" ? `${scope.collection}/${scope.recordId ?? created.record.id}` : `page/${context.page.id}`;
      // Reopen from the immutable staged session and its original CAS base.
      // Encode the complete accumulated draft once; merging full-record update
      // operations loses earlier fields and cannot represent reverting an edit.
      if (!entry.session.dirty || operations.length === 0) state.staged.delete(key);
      else state.staged.set(key, { operations, session: entry.session, baseInput: entry.baseInput,
        baseRevision: entry.baseInput.baseRevision, fileDigest: entry.baseInput.fileDigest });
      state.stagedOperationId = state.staged.size > 0 ? newOperationId() : null;
      refreshStagedReferences();
      if (context.kind === "drawer") closeDrawer();
      else { state.pageSessions.delete(context.page.id); renderPage(); }
      renderStatusBar();
    } catch (error) { showContextBanner(context, renderer.errorBanner(errorMessage(error, "Could not stage this edit."))); }
  }

  async function publishStaged() {
    if (state.saving || state.pending !== null) return;
    const entries = [...state.staged.values()];
    if (entries.length === 0) return;
    const payload = { baseRevision: entries[0].baseRevision, fileDigest: entries[0].fileDigest,
      operationId: state.stagedOperationId, operations: entries.flatMap(entry => entry.operations) };
    await submitChangeset({ ...payload, context: { kind: "staged" }, retryPayload: payload });
  }

  function renderRoutePreviewSection() {
    const triggerRecords = state.view?.collections?.trigger?.records;
    const triggers = Array.isArray(triggerRecords) ? triggerRecords.map((record) => String(record.name ?? record.id)) : [];
    const panel = renderer.renderRoutePreviewPanel({
      triggers,
      targetKinds: PREVIEW_TARGET_KINDS,
      onPreview: (event) => void runRoutePreview(panel, event),
    });
    els.main.append(el("p", "cfg-field-note", "Preview includes staged changes. Stage open edits first; preview does not publish them."), panel.element);
  }

  /** Read-only legacy outputs.routes summary (effective merged view). */
  function renderLegacyRoutesSection() {
    const view = state.view !== null && typeof state.view === "object" ? state.view : null;
    const globals = view !== null && view.globals !== null && typeof view.globals === "object" ? view.globals : null;
    const outputs = globals !== null && globals.outputs !== null && typeof globals.outputs === "object" ? globals.outputs : null;
    const routes = outputs !== null && outputs.routes !== null && typeof outputs.routes === "object" ? outputs.routes : null;
    const defaultRoute = routes !== null && routes.default !== null && typeof routes.default === "object" ? routes.default : undefined;
    const rules = routes !== null && Array.isArray(routes.rules) ? routes.rules.filter((rule) => rule !== null && typeof rule === "object") : [];
    if (defaultRoute === undefined && rules.length === 0) return;
    const sources = new Set();
    for (const field of Array.isArray(view?.fields) ? view.fields : []) {
      if (typeof field?.path === "string" && (field.path === "outputs.routes" || field.path.startsWith("outputs.routes.")) && typeof field.source === "string") {
        sources.add(field.source);
      }
    }
    els.main.append(renderer.renderLegacyRoutesPanel({ defaultRoute, rules, sources: [...sources] }));
  }

  async function runRoutePreview(panel, event) {
    panel.setBusy(true);
    try {
      const entries = [...state.staged.values()];
      const draft = entries.length === 0 ? undefined : { baseRevision: entries[0].baseRevision, fileDigest: entries[0].fileDigest,
        operations: entries.flatMap(entry => entry.operations) };
      const result = await api.previewRoute(event, draft);
      panel.showResult(renderer.renderRoutePreviewResult(result));
    } catch (error) {
      panel.showError(errorMessage(error, "Route preview failed."));
    } finally {
      panel.setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Versions page: status + revision history + restore
  // -------------------------------------------------------------------------

  async function loadStatus() {
    try {
      state.status = await api.getStatus();
      state.statusFailed = null;
    } catch (error) {
      state.status = null;
      state.statusFailed = errorMessage(error, "status unavailable");
    }
    renderStatusBar();
    if (state.pageId === "versions") renderPage();
  }

  async function loadRevisions(before) {
    try {
      const result = await api.listRevisions(before === undefined ? {} : { before });
      const rows = Array.isArray(result.revisions) ? result.revisions : [];
      if (before === undefined) {
        state.revisions = rows;
      } else {
        state.revisions = [...state.revisions, ...rows];
      }
      state.revisionsExhausted = rows.length === 0;
    } catch (error) {
      state.revisionsExhausted = true;
      setStatusMessage(errorMessage(error, "Failed to load revisions."), "error");
    }
    if (state.pageId === "versions") renderPage();
  }

  function renderVersionsPage() {
    const header = el("div", "cfg-page-head");
    header.append(el("h2", "cfg-page-title", "Versions"));
    els.main.append(header);

    // --- status panel (readiness: admission availability + instance flags)
    const statusPanel = el("div", "cfg-panel");
    statusPanel.append(el("h3", "cfg-subtitle", "Runtime status"));
    if (state.status !== null) {
      const list = el("dl", "cfg-dl");
      const head = state.status.head;
      list.append(el("dt", undefined, "Head revision"));
      list.append(el("dd", undefined, String(head?.activeRevision ?? "—")));
      const admission = state.status.admission;
      list.append(el("dt", undefined, "Admission"));
      if (admission !== null && typeof admission === "object" && admission.available === true) {
        list.append(el("dd", undefined, `available (database revision ${admission.databaseRevision ?? "—"})`));
      } else {
        const reason = admission !== null && typeof admission === "object" ? admission.reason : null;
        list.append(el("dd", undefined, `unavailable${typeof reason === "string" ? `: ${reason}` : ""}`));
      }
      statusPanel.append(list);
      const instances = Array.isArray(state.status.instances) ? state.status.instances : [];
      if (instances.length > 0) {
        statusPanel.append(el("h4", "cfg-dl-title", "Instances"));
        const rows = el("ul", "cfg-instances");
        for (const instance of instances) {
          const item = el("li");
          item.append(el("span", "mono", String(instance.instanceId ?? "unknown")));
          item.append(
            renderer.badge(instance.ready === true ? "ready" : "not ready", instance.ready === true ? "ok" : "warn"),
          );
          rows.append(item);
        }
        statusPanel.append(rows);
      }
    } else {
      statusPanel.append(
        el("div", "cfg-field-note", state.statusFailed !== null ? `Status unavailable: ${state.statusFailed}` : "Loading status…"),
      );
    }
    statusPanel.append(button("cfg-btn cfg-btn-ghost", "Refresh status", () => void loadStatus()));
    els.main.append(statusPanel);

    // --- revisions table
    if (state.revisions.length === 0 && !state.revisionsExhausted) {
      const loading = el("div", "cfg-empty", "Loading revisions…");
      els.main.append(loading);
      void loadRevisions();
      return;
    }
    const scroll = el("div", "table-scroll");
    const table = el("table", "cfg-table");
    const headRow = el("tr");
    for (const heading of ["Revision", "Parent", "Actor", "Time", "Operation", "Actions"]) headRow.append(el("th", undefined, heading));
    const thead = el("thead");
    thead.append(headRow);
    const tbody = el("tbody");
    if (state.revisions.length === 0) {
      const row = el("tr");
      const cell = el("td", "cfg-empty", "No revisions yet — saves create the first one.");
      cell.colSpan = 6;
      row.append(cell);
      tbody.append(row);
    }
    for (const revision of state.revisions) {
      const row = el("tr");
      row.append(el("td", "mono", String(revision.revision ?? "")));
      row.append(el("td", "mono", String(revision.parentRevision ?? "—")));
      row.append(el("td", undefined, String(revision.actor ?? "")));
      const time = typeof revision.createdAt === "string" ? new Date(revision.createdAt) : null;
      row.append(el("td", undefined, time !== null && !Number.isNaN(time.getTime()) ? time.toLocaleString() : ""));
      const operationId = typeof revision.operationId === "string" ? revision.operationId : "";
      row.append(el("td", "mono", operationId.length > 8 ? operationId.slice(0, 8) : operationId));
      const actions = el("td", "cfg-actions-cell");
      actions.append(
        button("cfg-btn cfg-btn-sm cfg-btn-ghost", "View", () => void showRevisionDetail(revision.revision)),
        button("cfg-btn cfg-btn-sm cfg-btn-ghost", "Restore", () =>
          openConfirm({
            title: `Restore revision ${revision.revision}?`,
            body: `Creates a NEW revision whose content matches revision ${revision.revision}, with the current head as parent. File locks and reference checks still apply.`,
            confirmLabel: "Restore",
            danger: false,
            onConfirm: () => restoreRevision(revision.revision),
          }),
        ),
      );
      row.append(actions);
      tbody.append(row);
    }
    table.append(thead, tbody);
    scroll.append(table);
    els.main.append(scroll);
    if (!state.revisionsExhausted && state.revisions.length > 0) {
      const oldest = state.revisions[state.revisions.length - 1];
      els.main.append(
        button("cfg-btn cfg-btn-ghost", "Load older revisions", () => void loadRevisions(oldest.revision)),
      );
    }
    const detail = el("div", "cfg-revision-detail");
    detail.dataset.role = "revision-detail";
    els.main.append(detail);
  }

  /** Redacted audit diff → diffView entries (names/paths only per S06). */
  function auditDiffEntries(audit) {
    const entries = [];
    for (const entry of audit) {
      const diff = entry !== null && typeof entry === "object" ? entry.redactedDiff : null;
      if (diff === null || typeof diff !== "object") continue;
      const entities = diff.entities;
      if (entities !== null && typeof entities === "object") {
        for (const id of entities.added ?? []) entries.push({ path: String(id), change: "added" });
        for (const id of entities.changed ?? []) entries.push({ path: String(id), change: "changed" });
        for (const id of entities.removed ?? []) entries.push({ path: String(id), change: "removed" });
      }
      const globals = diff.globals;
      if (globals !== null && typeof globals === "object") {
        for (const path of globals.set ?? []) entries.push({ path: String(path), change: "changed" });
        for (const path of globals.unset ?? []) entries.push({ path: String(path), change: "removed" });
      }
      if (typeof diff.restoredFromRevision === "number") {
        entries.push({ path: "(restore)", change: "changed", before: undefined, after: `revision ${diff.restoredFromRevision}` });
      }
    }
    return entries;
  }

  async function showRevisionDetail(revisionNumber) {
    const host = els.main.querySelector("[data-role=revision-detail]");
    if (host === null) return;
    clearChildren(host);
    host.append(el("div", "cfg-field-note", `Loading revision ${revisionNumber}…`));
    try {
      const result = await api.getRevision(revisionNumber);
      clearChildren(host);
      host.append(el("h3", "cfg-subtitle", `Revision ${revisionNumber}`));
      const audit = Array.isArray(result.audit) ? result.audit : [];
      host.append(renderer.diffView(auditDiffEntries(audit)));
      for (const entry of audit) {
        const meta = el("div", "cfg-field-note");
        const refs = Array.isArray(entry.entityRefs) ? entry.entityRefs.join(", ") : "";
        meta.textContent = `${entry.action ?? "change"} by ${entry.actor ?? "unknown"} at ${entry.timestamp ?? "?"}${refs.length > 0 ? ` — ${refs}` : ""}`;
        host.append(meta);
      }
    } catch (error) {
      clearChildren(host);
      host.append(renderer.errorBanner(errorMessage(error, "Failed to load the revision.")));
    }
  }

  async function restoreRevision(revisionNumber, operationId = newOperationId(), retryPayload) {
    if (state.saving || (state.pending !== null && retryPayload === undefined)) return;
    const payload = retryPayload ?? { baseRevision: headRevision(), fileDigest: state.view.fileDigest, operationId, restoreRevision: revisionNumber };
    state.saving = true;
    renderStatusBar();
    try {
      const result = await api.restore(revisionNumber, {
        baseRevision: payload.baseRevision,
        fileDigest: payload.fileDigest,
        operationId: payload.operationId,
      });
      await handleCommitted(result.revision, { kind: "versions" });
    } catch (error) {
      if (error.kind === "activating") {
        state.pending = { payload, context: { kind: "versions" } };
        showActivatingPanel(error, { kind: "versions" });
      } else if (error.kind === "conflict") {
        setStatusMessage(`Restore failed: the head moved to revision ${error.headRevision ?? "?"} — reload and retry.`, "error");
        state.revisions = [];
        state.revisionsExhausted = false;
        await refreshView();
        renderPage();
      } else if (error.kind === "network") {
        await resolveLostResponse(
          payload,
          { kind: "versions" },
        );
      } else {
        setStatusMessage(errorMessage(error, "Restore failed."), "error");
      }
    } finally {
      state.saving = false;
    }
  }

  // -------------------------------------------------------------------------
  // D7 changeset flow: commit / conflict / activating / lost response
  // -------------------------------------------------------------------------

  async function refreshView() {
    state.view = await api.getView();
    state.references = {};
    await ensureReferences(currentPage());
    renderStatusBar();
  }

  async function submitChangeset({ operations, operationId, context, retryPayload }) {
    if (state.saving || (state.pending !== null && retryPayload === undefined)) return;
    if (state.staged.size > 0 && context.kind !== "staged") {
      setStatusMessage("Stage this edit to include it, or publish/discard the existing staged changes first.", "warn"); return;
    }
    state.saving = true;
    updateDrawerSaveState();
    if (context.kind === "globals") updateGlobalsSaveState(context.page, context.entry);
    renderStatusBar();
    const base = context.kind === "drawer" ? context.drawer.baseInput : context.kind === "globals" ? context.entry.baseInput : null;
    const payload = retryPayload ?? {
      baseRevision: base ? base.baseRevision : headRevision(),
      fileDigest: base ? base.fileDigest : state.view.fileDigest,
      operationId,
      operations,
    };
    try {
      const result = await api.saveChangeset(payload);
      await handleCommitted(result.revision, context);
    } catch (error) {
      await handleSaveError(error, payload, context);
    } finally {
      state.saving = false;
      renderStatusBar();
      updateDrawerSaveState();
      for (const [id, entry] of state.pageSessions) updateGlobalsSaveState(state.spec.pages.find(page => page.id === id), entry);
      renderStatusBar();
    }
  }

  async function handleCommitted(revision, context) {
    state.pending = null;
    state.revisions = [];
    state.revisionsExhausted = false;
    state.status = null;
    if (context.kind === "staged") { state.staged.clear(); state.stagedOperationId = null; }
    const number = revision !== null && typeof revision === "object" ? revision.revision : revision;
    state.fieldErrors = [];
    setStatusMessage(`Saved as revision ${number ?? "?"} — new tasks use it now`, "ok");
    try { await refreshView(); }
    catch { setStatusMessage(`Saved as revision ${number} — refreshing the view failed. Reload before editing again.`, "warn"); }
    if (context.kind === "drawer") {
      const page = context.drawer.page;
      state.drawer = null;
      clearChildren(els.editor);
      els.editor.hidden = true;
      state.pageId = page.id;
      buildNav();
      renderPage();
      return;
    }
    if (context.kind === "globals") {
      state.pageSessions.delete(context.page.id);
    }
    renderPage();
  }

  async function handleSaveError(error, payload, context) {
    if (error.kind !== "network" && error.kind !== "activating") state.pending = null;
    if (error !== null && typeof error === "object" && error.kind === "conflict") {
      await showConflictPanel(error, payload, context);
      return;
    }
    if (error !== null && typeof error === "object" && error.kind === "activating") {
      state.pending = { payload, context };
      showActivatingPanel(error, context);
      return;
    }
    if (error !== null && typeof error === "object" && error.kind === "network") {
      await resolveLostResponse(payload, context);
      return;
    }
    if (error !== null && typeof error === "object" && error.kind === "invalid") {
      state.fieldErrors = (Array.isArray(error.fields) ? error.fields : []).map((field) => ({
        message: typeof field.message === "string" ? field.message : "Invalid value.",
        ...(typeof field.code === "string" ? { code: field.code } : {}),
        ...(Array.isArray(field.path)
          ? { path: field.path.map(String) }
          : typeof field.path === "string"
            ? { path: field.path.split(".").filter((token) => token.length > 0) }
            : {}),
        ...(field.entity !== null && typeof field.entity === "object" ? { entity: field.entity } : {}),
      }));
      rerenderContext(context);
      showContextBanner(context, renderer.errorBanner(errorMessage(error, "The change was rejected.")));
      return;
    }
    showContextBanner(context, renderer.errorBanner(errorMessage(error, "Save failed.")));
  }

  /** 409: keep the draft, show head + diff, offer reload / rebase-and-retry. */
  async function showConflictPanel(error, payload, context) {
    let fresh;
    try {
      fresh = await api.getView();
    } catch (reloadError) {
      showContextBanner(
        context,
        renderer.errorBanner(
          `Conflict at revision ${error.headRevision ?? "?"}; reloading the latest view failed: ${errorMessage(reloadError, "network error")}`,
        ),
      );
      return;
    }
    const panel = el("div", "cfg-panel cfg-panel-conflict");
    panel.setAttribute("role", "alert");
    panel.append(el("h3", "cfg-subtitle", "Revision conflict"));
    panel.append(
      el(
        "p",
        "cfg-field-note",
        `The configuration head moved to revision ${error.headRevision ?? "?"} while you were editing. Your draft is preserved.`,
      ),
    );
    if (context.kind === "drawer" || context.kind === "globals") {
      panel.append(renderer.diffView(computeConflictDiff(fresh, context)));
      const retry = button("cfg-btn cfg-btn-primary", "Keep my changes and retry", () => void rebaseAndRetry(fresh, payload, context));
      const reload = button("cfg-btn cfg-btn-ghost", "Reload latest", () => void reloadLatest(fresh, context));
      const bar = el("div", "cfg-dialog-actions");
      bar.append(retry, reload);
      panel.append(bar);
    } else if (context.kind === "staged") {
      panel.append(button("cfg-btn cfg-btn-primary", "Keep staged changes and retry", () => {
        const retry = { ...payload, baseRevision: fresh.head?.activeRevision ?? null, fileDigest: fresh.fileDigest };
        void submitChangeset({ ...retry, context, retryPayload: retry });
      }));
      panel.append(renderer.diffView(payload.operations.map(op => ({ path: op.recordId ?? op.record?.name ?? op.path?.join("."), change: op.op }))));
    } else {
      const reload = button("cfg-btn cfg-btn-ghost", "Reload latest", () => void reloadLatest(fresh, context));
      panel.append(reload);
    }
    showContextBanner(context, panel);
  }

  function computeConflictDiff(fresh, context) {
    if (context.resetPrefixes !== undefined) {
      const before = {};
      for (const field of fresh.fields ?? []) {
        if (field.source === "database" && context.resetPrefixes.some(prefix =>
          field.path === prefix || field.path.startsWith(`${prefix}.`) || field.path.startsWith(`${prefix}[`))) {
          before[field.path] = field.effectiveValue;
        }
      }
      return formState.diffConfigValues(before, {});
    }
    if (context.kind === "drawer") {
      const drawer = context.drawer;
      const kind = drawer.page.entity.kind;
      const records = fresh?.collections?.[kind]?.records;
      const recordId = drawer.record !== null ? drawer.record.id : null;
      const serverRecord = recordId !== null && Array.isArray(records) ? records.find((record) => record.id === recordId) : undefined;
      const { operations } = formState.sessionEncode(drawer.session, drawer.baseInput);
      const update = operations.find((operation) => operation.op === "update" || operation.op === "create");
      const draftValue = update !== undefined ? (update.op === "create" ? update.record?.value : update.value) : undefined;
      return formState.diffConfigValues(serverRecord?.value, draftValue, "record");
    }
    // globals: flat {path: value} projections of the edited paths
    const entry = context.entry;
    const { operations } = formState.sessionEncode(entry.session, entry.baseInput);
    const before = {};
    const after = {};
    const baseFields = Array.isArray(fresh.fields) ? fresh.fields : [];
    for (const operation of operations) {
      if (operation.op !== "set" && operation.op !== "unset") continue;
      const key = operation.path.join(".");
      const base = baseFields.find((field) => field.path === key);
      before[key] = base?.effectiveValue;
      after[key] = operation.op === "set" ? operation.value : undefined;
    }
    return formState.diffConfigValues(before, after);
  }

  /** Rebase onto the fresh view and resubmit with the SAME operationId (D7). */
  async function rebaseAndRetry(fresh, payload, context) {
    state.view = fresh;
    renderStatusBar();
    let operations;
    if (context.kind === "drawer") {
      const drawer = context.drawer;
      const kind = drawer.page.entity.kind;
      const records = fresh?.collections?.[kind]?.records;
      const recordId = drawer.record !== null ? drawer.record.id : null;
      const freshRecord = recordId !== null && Array.isArray(records) ? records.find((record) => record.id === recordId) ?? null : null;
      const freshInput = {
        record: freshRecord,
        baseRevision: headRevision(),
        fileDigest: typeof fresh.fileDigest === "string" ? fresh.fileDigest : "",
      };
      try { drawer.session = formState.rebaseSession(drawer.session, freshInput); }
      catch (error) { showContextBanner(context, renderer.errorBanner(errorMessage(error, "Cannot rebase this record."))); return; }
      drawer.baseInput = freshInput;
      operations = formState.sessionEncode(drawer.session, drawer.baseInput).operations;
    } else {
      const entry = context.entry;
      const freshInput = globalsBaseInput();
      entry.session = context.resetPrefixes === undefined ? formState.rebaseSession(entry.session, freshInput)
        : formState.createEditorSession(context.page, freshInput);
      entry.baseInput = freshInput;
      operations = context.resetPrefixes === undefined ? formState.sessionEncode(entry.session, entry.baseInput).operations
        : prefixesWithDatabaseValues(context.resetPrefixes).map(prefix => ({ op: "unset", path: prefix.split(".") }));
    }
    if (operations.length === 0) {
      setStatusMessage("Your changes are already reflected in the latest revision.", "ok");
      rerenderContext(context);
      return;
    }
    await submitChangeset({ operations, operationId: payload.operationId, context });
  }

  /** Discard the draft and reload the latest server state. */
  async function reloadLatest(fresh, context) {
    state.view = fresh;
    renderStatusBar();
    if (context.kind === "drawer") {
      const drawer = context.drawer;
      const kind = drawer.page.entity.kind;
      const records = fresh?.collections?.[kind]?.records;
      const recordId = drawer.record !== null ? drawer.record.id : null;
      const freshRecord = recordId !== null && Array.isArray(records) ? records.find((record) => record.id === recordId) ?? null : null;
      if (freshRecord === null && recordId !== null) {
        // Record vanished upstream: drop the drawer entirely.
        setStatusMessage("The record no longer exists in the latest revision.", "warn");
        closeDrawer();
        renderPage();
        return;
      }
      const freshInput = {
        record: freshRecord,
        baseRevision: headRevision(),
        fileDigest: typeof fresh.fileDigest === "string" ? fresh.fileDigest : "",
      };
      drawer.session = formState.createEditorSession(drawer.page, freshInput);
      drawer.baseInput = freshInput;
      drawer.operationId = newOperationId();
      state.fieldErrors = [];
      renderDrawer();
      renderPage();
      return;
    }
    if (context.kind === "globals") {
      state.pageSessions.delete(context.page.id);
    }
    state.fieldErrors = [];
    renderPage();
  }

  /** 202 committed_activating: durable but NOT live — never shown as applied. */
  function showActivatingPanel(error, context) {
    const revision = error.revision !== null && typeof error.revision === "object" ? error.revision.revision : undefined;
    const panel = el("div", "cfg-panel cfg-panel-warn");
    panel.setAttribute("role", "status");
    panel.append(el("h3", "cfg-subtitle", "Stored, activation pending"));
    panel.append(
      el(
        "p",
        "cfg-field-note",
        `The change was stored${revision !== undefined ? ` as revision ${revision}` : ""} but the runtime has not activated it yet. It is NOT in effect — track activation on the versions page.`,
      ),
    );
    panel.append(
      button("cfg-btn cfg-btn-ghost", "Open version status", () => {
        void selectPage("versions");
        void loadStatus();
      }),
    );
    showContextBanner(context, panel);
    setStatusMessage("Stored, activation pending — not yet in effect.", "warn");
    if (state.pending) panel.append(button("cfg-btn cfg-btn-ghost", "Check activation", () => void resolveLostResponse(state.pending.payload, context)));
  }

  /**
   * Network failure after POST: the change may or may not have landed. Poll
   * GET /operations/:operationId (D7 — never blindly resubmit).
   */
  async function resolveLostResponse(payload, context) {
    state.pending = { payload, context };
    renderStatusBar();
    showContextBanner(context, infoPanel("Connection lost while saving — checking whether the change was committed…"));
    for (let attempt = 0; attempt < LOST_RESPONSE_POLLS; attempt += 1) {
      await sleep(LOST_RESPONSE_BACKOFF_MS);
      try {
        const operation = await api.getOperation(payload.operationId);
        await handleCommitted(operation.revision, context);
        updateDrawerSaveState();
        return;
      } catch (error) {
        if (error !== null && typeof error === "object" && error.kind === "activating") {
          showActivatingPanel(error, context);
          return;
        }
        if (error !== null && typeof error === "object" && error.kind === "http" && error.status === 404) {
          offerResubmit(payload, context);
          return;
        }
        if (error !== null && typeof error === "object" && error.kind === "network") continue;
        showContextBanner(context, renderer.errorBanner(errorMessage(error, "Could not determine the save outcome.")));
        return;
      }
    }
    const panel = infoPanel("The save outcome is still unknown. Check again before resubmitting to avoid duplicates.");
    const check = button("cfg-btn cfg-btn-ghost", "Check again", () => void resolveLostResponse(payload, context));
    panel.append(check);
    showContextBanner(context, panel);
  }

  /** A missing operation can still be in flight; an exact retry remains idempotent. */
  function offerResubmit(payload, context) {
    const panel = infoPanel("The operation is not recorded yet. An exact retry uses the same operation id and payload, even if the first request is still in flight.");
    panel.append(
      button("cfg-btn cfg-btn-primary", "Resubmit", async () => {
        if (typeof payload.restoreRevision === "number") {
          await restoreRevision(payload.restoreRevision, payload.operationId, payload);
          return;
        }
        await submitChangeset({ operations: payload.operations, operationId: payload.operationId, context, retryPayload: payload });
      }),
    );
    showContextBanner(context, panel);
  }

  function infoPanel(message) {
    const panel = el("div", "cfg-panel cfg-panel-info");
    panel.setAttribute("role", "status");
    panel.append(el("p", "cfg-field-note", message));
    return panel;
  }

  /** Place a panel/banner where the current editing context will see it. */
  function validateLocalFields(context) {
    const host = context.kind === "drawer" ? els.editor : context.entry.fieldsHost;
    const flagged = host?.querySelectorAll('[data-local-validation]:not([hidden])') ?? [];
    for (const node of flagged) {
      // Errors inside a hidden field (kind-mismatch or visibleWhen) do not
      // block saving — the encoder drops or ignores those values.
      const fieldWrap = node.closest(".cfg-field");
      if (fieldWrap !== null && fieldWrap.hidden) continue;
      showContextBanner(context, renderer.errorBanner("Correct the invalid field values before saving or staging."));
      return false;
    }
    return true;
  }

  function showContextBanner(context, node) {
    if (context.kind === "drawer" && context.drawer.panelHost !== null && context.drawer.panelHost !== undefined) {
      clearChildren(context.drawer.panelHost);
      context.drawer.panelHost.append(node);
      return;
    }
    if (context.kind === "globals" && context.entry?.panelHost !== undefined) {
      clearChildren(context.entry.panelHost);
      context.entry.panelHost.append(node);
      return;
    }
    els.main.prepend(node);
  }

  function rerenderContext(context) {
    if (context.kind === "drawer") renderDrawer();
    else renderPage();
  }

  // -------------------------------------------------------------------------
  // Confirm dialog + misc
  // -------------------------------------------------------------------------

  function openConfirm({ title, body, confirmLabel, danger, onConfirm }) {
    const dialog = renderer.confirmDialog({
      title,
      body,
      actions: [
        { id: "cancel", label: "Cancel" },
        { id: "confirm", label: confirmLabel, tone: danger ? "danger" : "primary" },
      ],
      onAction: (id) => {
        dialog.remove();
        if (id === "confirm") void onConfirm();
      },
    });
    root.body.append(dialog);
  }

  function errorMessage(error, fallback) {
    if (error !== null && typeof error === "object" && typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    return fallback;
  }

  function deepClone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  function newOperationId() {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
    return `op-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  return { show, hide };
}

/**
 * Config-app-specific styles; reuses the dashboard CSS variables. Injected
 * once as a literal string (no dynamic data — D9).
 */
const CONFIG_APP_STYLES = `
#tab-config.active{display:grid;grid-template-columns:180px 1fr;gap:1rem;align-items:start}
#config-nav{display:flex;flex-direction:column;gap:0.25rem;position:sticky;top:1rem}
#config-status{grid-column:2;display:flex;flex-direction:column;gap:0.25rem;min-height:2rem}
#config-main{grid-column:2;min-width:0}
#config-editor{grid-column:2;min-width:0}
#config-editor[hidden]{display:none}
.cfg-nav-item{background:transparent;border:1px solid transparent;color:var(--muted);text-align:left;padding:0.375rem 0.75rem;border-radius:6px;cursor:pointer;font-size:0.875rem}
.cfg-nav-item:hover{color:var(--text);border-color:var(--border)}
.cfg-nav-item.cfg-active{color:var(--accent);border-color:var(--accent);background:rgba(59,130,246,0.08)}
.cfg-status-line{display:flex;gap:1rem;flex-wrap:wrap;font-size:0.8125rem;color:var(--muted)}
.cfg-status-warn{color:var(--yellow)}
.cfg-status-msg{font-size:0.8125rem;min-height:1.25rem}
.cfg-msg-ok{color:var(--green)}
.cfg-msg-warn{color:var(--yellow)}
.cfg-msg-error{color:var(--red)}
.cfg-page-head{display:flex;justify-content:space-between;align-items:center;gap:0.75rem;margin-bottom:0.75rem;flex-wrap:wrap}
.cfg-page-title{font-size:1rem;font-weight:600}
.cfg-subtitle{font-size:0.9375rem;font-weight:600;margin:0.75rem 0 0.5rem}
.cfg-btn{display:inline-flex;align-items:center;justify-content:center;padding:0.5rem 1rem;border:none;border-radius:6px;font-size:0.875rem;cursor:pointer;background:var(--border);color:var(--text)}
.cfg-btn:disabled{opacity:0.55;cursor:not-allowed}
.cfg-btn:hover:not(:disabled){opacity:0.85}
.cfg-btn-sm{padding:0.25rem 0.625rem;font-size:0.75rem}
.cfg-btn-primary{background:var(--accent);color:#fff}
.cfg-btn-danger{background:var(--red);color:#fff}
.cfg-btn-ghost{background:transparent;border:1px solid var(--border);color:var(--muted)}
.cfg-btn-link{background:transparent;border:none;color:var(--accent);font-size:0.75rem;padding:0.125rem 0}
.cfg-icon-btn{background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer;font-size:0.75rem;line-height:1;padding:0.25rem 0.375rem}
.cfg-icon-btn:disabled{opacity:0.4;cursor:not-allowed}
.cfg-icon-btn:hover:not(:disabled){color:var(--text);border-color:var(--muted)}
.cfg-field{margin-bottom:0.875rem;min-width:0}
.cfg-provider-preset{display:grid;grid-template-columns:minmax(8rem,auto) minmax(16rem,1fr) auto;gap:0.5rem;align-items:center;border:1px dashed var(--border);border-radius:8px;padding:0.625rem}
.cfg-provider-preset .cfg-field-note{grid-column:1/-1;overflow-wrap:anywhere}
.cfg-provider-preset select{min-width:0;max-width:100%}
.cfg-field-head{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;flex-wrap:wrap}
.cfg-field-label{font-size:0.8125rem;color:var(--muted)}
.cfg-field-note{font-size:0.75rem;color:var(--muted);margin-top:0.125rem}
.cfg-field-absent{display:flex;align-items:center;gap:0.5rem}
.cfg-field-inherited{font-size:0.8125rem;color:var(--muted);font-style:italic}
.cfg-field-error{color:var(--red);font-size:0.75rem;margin-top:0.125rem}
.cfg-input{width:100%;padding:0.5rem 0.625rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:0.875rem}
.cfg-input:focus{outline:none;border-color:var(--accent)}
.cfg-input:disabled{opacity:0.6;cursor:not-allowed}
.cfg-textarea{font-family:"SF Mono","Fira Code",monospace;font-size:0.8125rem;resize:vertical}
.cfg-toggle{display:flex;align-items:center;gap:0.5rem}
.cfg-toggle-label{font-size:0.8125rem}
.cfg-checklist{display:flex;flex-direction:column;gap:0.25rem}
.cfg-checklist-row{display:flex;align-items:center;gap:0.5rem}
.cfg-checklist-label{font-size:0.8125rem;display:inline-flex;align-items:center;gap:0.375rem}
.cfg-segment{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden}
.cfg-segment-btn{background:transparent;border:none;color:var(--muted);font-size:0.75rem;padding:0.25rem 0.625rem;cursor:pointer}
.cfg-segment-btn.cfg-active{background:rgba(59,130,246,0.15);color:var(--accent)}
.cfg-section{border:1px solid var(--border);border-radius:8px;margin-bottom:0.75rem;background:var(--card)}
.cfg-section-title{padding:0.625rem 0.875rem;font-size:0.875rem;font-weight:600;cursor:pointer;user-select:none}
.cfg-section-body{padding:0 0.875rem 0.875rem}
.cfg-badge{display:inline-block;padding:0.125rem 0.5rem;border-radius:9999px;font-size:0.6875rem;font-weight:500;margin-right:0.25rem}
.cfg-badge-ok{background:rgba(34,197,94,0.15);color:var(--green)}
.cfg-badge-warn{background:rgba(234,179,8,0.15);color:var(--yellow)}
.cfg-badge-danger{background:rgba(239,68,68,0.15);color:var(--red)}
.cfg-badge-muted{background:rgba(148,163,184,0.15);color:var(--muted)}
.cfg-badge-file{background:rgba(249,115,22,0.15);color:var(--orange)}
.cfg-badge-database{background:rgba(59,130,246,0.15);color:var(--accent)}
.cfg-badge-added{background:rgba(34,197,94,0.15);color:var(--green)}
.cfg-badge-removed{background:rgba(239,68,68,0.15);color:var(--red)}
.cfg-badge-changed{background:rgba(234,179,8,0.15);color:var(--yellow)}
.cfg-banner{padding:0.625rem 0.875rem;border-radius:8px;margin-bottom:0.75rem;font-size:0.8125rem}
.cfg-banner-error{background:rgba(239,68,68,0.12);border:1px solid var(--red);color:var(--red)}
.cfg-panel{border:1px solid var(--border);border-radius:8px;padding:0.875rem;margin-bottom:0.75rem;background:var(--card)}
.cfg-panel-conflict{border-color:var(--yellow)}
.cfg-panel-warn{border-color:var(--yellow)}
.cfg-panel-info{border-color:var(--accent)}
.cfg-drawer{border:1px solid var(--border);border-radius:8px;background:var(--card);padding:1rem;margin-bottom:1rem}
.cfg-drawer-title{font-size:1rem;font-weight:600;margin-bottom:0.75rem;outline:none}
.cfg-savebar{display:flex;align-items:center;gap:0.5rem;margin-top:0.75rem;flex-wrap:wrap}
.cfg-savebar-sticky{position:sticky;bottom:0;background:var(--card);border-top:1px solid var(--border);padding:0.625rem 0.625rem;z-index:5}
.cfg-entity{margin-bottom:1rem}
.cfg-filter{max-width:20rem;margin-bottom:0.5rem}
.cfg-empty{color:var(--muted);font-size:0.8125rem;padding:0.5rem 0.5rem}
.cfg-state-cell{white-space:nowrap}
.cfg-actions-cell{white-space:nowrap}
.cfg-actions-cell .cfg-btn{margin-right:0.25rem}
.cfg-olist-rows{list-style:none;display:flex;flex-direction:column;gap:0.5rem;margin-bottom:0.5rem}
.cfg-olist-row{display:flex;gap:0.5rem;align-items:flex-start;border:1px solid var(--border);border-radius:6px;padding:0.5rem}
.cfg-olist-row:focus{outline:none;border-color:var(--accent)}
.cfg-olist-controls{display:flex;flex-direction:column;gap:0.25rem}
.cfg-olist-rowbody{flex:1;min-width:0}
.cfg-olist-scalar{flex:1}
.cfg-map{display:flex;flex-direction:column;gap:0.5rem}
.cfg-map-row{display:grid;grid-template-columns:minmax(8rem,1fr) 2fr auto;gap:0.5rem;align-items:start}
.cfg-var-dropdown{position:absolute;z-index:20;background:var(--card);border:1px solid var(--border);border-radius:6px;max-height:12rem;overflow-y:auto;min-width:16rem;box-shadow:0 8px 24px rgba(0,0,0,0.4)}
.cfg-var-option{padding:0.375rem 0.625rem;font-size:0.8125rem;cursor:pointer}
.cfg-var-option.cfg-active,.cfg-var-option:hover{background:rgba(59,130,246,0.12)}
.cfg-var-name{font-family:"SF Mono","Fira Code",monospace}
.cfg-var-label{color:var(--muted)}
.cfg-pathtpl{position:relative}
.cfg-matcher{display:grid;grid-template-columns:8rem 1fr auto;gap:0.5rem;align-items:center}
.cfg-dialog-overlay{position:fixed;inset:0;background:rgba(2,6,23,0.7);display:flex;align-items:center;justify-content:center;z-index:100;padding:1rem}
.cfg-dialog{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.25rem;max-width:32rem;width:100%}
.cfg-dialog-title{font-size:1rem;font-weight:600;margin-bottom:0.5rem}
.cfg-dialog-body{font-size:0.875rem;color:var(--muted);margin-bottom:1rem;overflow-wrap:anywhere}
.cfg-dialog-actions{display:flex;gap:0.5rem;justify-content:flex-end}
.cfg-preview{margin-top:1rem}
.cfg-preview-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.75rem;margin-bottom:0.625rem}
.cfg-preview-field{display:flex;flex-direction:column;gap:0.25rem}
.cfg-preview-result{margin-top:0.75rem}
.cfg-preview-result-body{display:flex;flex-direction:column;gap:0.25rem}
.cfg-dl{display:grid;grid-template-columns:minmax(8rem,auto) 1fr;gap:0.125rem 0.75rem;font-size:0.8125rem}
.cfg-dl dt{color:var(--muted)}
.cfg-dl dd{overflow-wrap:anywhere}
.cfg-dl-block{margin-bottom:0.375rem}
.cfg-dl-title{font-size:0.8125rem;font-weight:600;color:var(--muted);margin-top:0.375rem}
.cfg-candidates{margin-left:1.25rem;font-size:0.8125rem}
.cfg-instances{list-style:none;display:flex;flex-direction:column;gap:0.25rem;font-size:0.8125rem;margin-bottom:0.5rem}
.cfg-schedule-preview{margin-top:0.25rem}
.cfg-revision-detail{margin-top:1rem}
.cfg-document{font-family:"SF Mono","Fira Code",monospace;font-size:0.8125rem;resize:vertical;min-height:16rem;white-space:pre}
.cfg-builtin-asset{border:1px solid var(--border);border-radius:6px;margin-bottom:0.5rem;padding:0.375rem 0.625rem}
.cfg-builtin-asset-summary{display:flex;align-items:center;justify-content:space-between;gap:0.75rem;cursor:pointer;flex-wrap:wrap}
.cfg-builtin-asset-id{font-family:"SF Mono","Fira Code",monospace;font-size:0.8125rem;overflow-wrap:anywhere}
.cfg-builtin-asset-document{max-height:24rem;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:0.625rem;font-size:0.75rem;white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:720px){
.cfg-provider-preset{grid-template-columns:minmax(0,1fr)}
#tab-config.active{grid-template-columns:1fr}
#config-nav{flex-direction:row;overflow-x:auto;position:static}
#config-status,#config-main,#config-editor{grid-column:1}
.cfg-map-row{grid-template-columns:1fr}
.cfg-matcher{grid-template-columns:1fr}
}
`;
