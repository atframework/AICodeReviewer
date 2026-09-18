/**
 * Generic ConfigUiSpec DOM renderer (architecture §3.16, P6 design doc §6/D8/D9).
 *
 * Plain-browser ESM, zero dependencies beyond the sibling paradigm module.
 * The document is injected for testability; every dynamic string reaches the
 * DOM exclusively through createElement/textContent (A14/XSS: no innerHTML
 * with data anywhere in this file).
 *
 * Controls implemented per architecture §3.16: text, number (raw string kept in the
 * input, parsed via parseNumberInput), toggle, select (with "(inherit)"
 * sentinel for inherit-or-override bindings), multiselect (checkbox list for
 * ≤12 options, one-per-line textarea + validation above), ordered-list
 * (up/down/remove icon buttons, Alt+ArrowUp/Down keyboard move, nested
 * itemFields for schedule rules and model group entries), map (key/value rows
 * with duplicate-key inline errors), secret-ref (datalist + presence hint),
 * matcher (exact/glob/regex + pattern + ignore_case), path-template
 * (variable-completion dropdown fed by the "path_template_variables" source).
 */

import { parseNumberInput, readRowField, writeRowField } from "./config-ui-runtime.js";

/**
 * @typedef {object} ConfigFieldHandlers
 * @property {(fieldId: string, value: unknown) => void} onValueChange Commits a control-shaped value.
 * @property {(fieldId: string, inherit: boolean) => void} [onInheritChange] Flips an inherit-or-override binding.
 * @property {(fieldId: string, present: boolean) => void} [onPresentChange] Flips present/absent for optional entity fields.
 * @property {(fieldId: string, op: object) => void} [onListOp] ConfigListOperation for object-row ordered-lists.
 * @property {(fieldId: string, op: object) => void} [onMapOp] ConfigMapOperation for map controls.
 */

/**
 * @typedef {object} RenderedControl
 * @property {HTMLElement} element Control root.
 * @property {HTMLElement|null} focusable Element receiving id/aria-describedby (null for composite groups).
 * @property {string[]} localErrorIds Ids of role=alert nodes the control maintains itself.
 */

/** Sentinel option value marking the inherited state of a select control. */
const INHERIT_SENTINEL = "__aicr_inherit__";
/** Checkbox-list multiselect cutoff (spec: above this a textarea is used). */
const MULTISELECT_CHECKBOX_LIMIT = 12;

let dialogSeq = 0;

/**
 * Create a renderer bound to one document.
 *
 * @param {Document} doc Injected document (browser document or test double).
 * @returns {{
 *   renderField: (field: object, state: object, draftField: object|undefined, handlers: ConfigFieldHandlers, options?: {idPrefix?: string}) => HTMLElement,
 *   renderSection: (section: object, fieldElements: readonly HTMLElement[]) => HTMLElement,
 *   renderEntityTable: (options: object) => HTMLElement,
 *   badge: (text: string, kind: string) => HTMLElement,
 *   errorBanner: (message: string) => HTMLElement,
 *   confirmDialog: (options: {title: string, body: string|Node, actions: readonly {id: string, label: string, tone?: string}[], onAction: (id: string) => void}) => HTMLElement,
 *   diffView: (entries: readonly object[]) => HTMLElement,
 *   renderRoutePreviewPanel: (options: {triggers: readonly (string|{value: string, label?: string})[], targetKinds: readonly string[], onPreview: (event: object) => void}) => {element: HTMLElement, showResult: (node: Node) => void, showError: (message: string) => void, setBusy: (busy: boolean) => void},
 *   renderRoutePreviewResult: (result: object) => HTMLElement,
 * }}
 */
export function createRenderer(doc) {
  /**
   * Dynamic-options resolver for ordered-list row item fields (injected by the
   * app once the form runtime is loaded; resolves against live references).
   * @type {undefined | ((parentField: object, itemField: object, value: unknown) => {options: readonly object[], error?: string})}
   */
  let itemOptionsResolver;
  /**
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElement}
   */
  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** @param {string} id @returns {string} DOM-id-safe token. */
  function sanitizeId(id) {
    return id.replace(/[^A-Za-z0-9_-]+/g, "-");
  }

  /**
   * Icon button per D8: real <button type=button>, aria-label + title tooltip,
   * text glyph only (no emoji).
   * @param {string} glyph
   * @param {string} label
   * @param {string} title
   * @returns {HTMLButtonElement}
   */
  function iconButton(glyph, label, title) {
    const button = /** @type {HTMLButtonElement} */ (el("button", "cfg-icon-btn", glyph));
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = title;
    return button;
  }

  /**
   * Short human rendering of an arbitrary config value (text only).
   * @param {unknown} value
   * @returns {string}
   */
  function displayValue(value) {
    if (value === undefined) return "—";
    if (typeof value === "string") return value === "" ? '""' : value;
    try {
      const text = JSON.stringify(value);
      if (text === undefined) return String(value);
      return text.length > 140 ? `${text.slice(0, 137)}…` : text;
    } catch {
      return String(value);
    }
  }

  /**
   * Colored pill. Kind is sanitized into the class name; text via textContent.
   * @param {string} text
   * @param {string} kind
   * @returns {HTMLElement}
   */
  function badge(text, kind) {
    const safeKind = String(kind).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    return el("span", `cfg-badge cfg-badge-${safeKind}`, text);
  }

  /**
   * Page-level error banner (U23: role=alert).
   * @param {string} message
   * @returns {HTMLElement}
   */
  function errorBanner(message) {
    const node = el("div", "cfg-banner cfg-banner-error", message);
    node.setAttribute("role", "alert");
    return node;
  }

  /**
   * Render one spec field. Returns a wrapper div; invisible fields render as
   * a hidden placeholder so the draft is preserved untouched (architecture §3.16).
   *
   * @param {object} field ConfigUiField.
   * @param {object} state ConfigFieldState from resolveFieldState.
   * @param {object|undefined} draftField ConfigDraftField (tolerates absence).
   * @param {ConfigFieldHandlers} handlers
   * @param {{idPrefix?: string}} [options] idPrefix scopes nested row control ids.
   * @returns {HTMLElement}
   */
  function renderField(field, state, draftField, handlers, options) {
    const idPrefix = options !== undefined && typeof options.idPrefix === "string" ? options.idPrefix : "";
    const domId = `${idPrefix}cfg-f-${sanitizeId(field.id)}`;
    const wrap = el("div", "cfg-field");
    wrap.dataset.fieldId = field.id;
    if (state.visible === false) {
      wrap.hidden = true;
      return wrap;
    }
    const disabled = state.disabled === true;
    const inherited = draftField !== undefined && draftField.inherit === true;
    const controlDisabled = disabled || inherited;
    if (disabled && typeof state.disabledReason === "string") wrap.title = state.disabledReason;

    const label = el("label", "cfg-field-label", field.label);
    label.id = `${domId}-label`;
    const head = el("div", "cfg-field-head");
    head.append(label);
    if (field.optional === true) head.append(badge("optional", "muted"));
    if (field.binding === "inherit-or-override") {
      head.append(buildBindingControl(field, draftField, disabled, state.disabledReason, handlers));
    }
    wrap.append(head);

    if (typeof field.capability === "string" && field.capability.length > 0) {
      wrap.append(el("div", "cfg-field-note", field.capability));
    }
    const provenance = provenanceNote(field, draftField);
    if (provenance !== null) wrap.append(el("div", "cfg-field-note", provenance));

    // Present/absent: optional entity fields may stay absent (schema default).
    const mode = draftField !== undefined && typeof draftField.mode === "string" ? draftField.mode : "present";
    if (field.optional === true && field.binding === "value" && mode === "absent") {
      const row = el("div", "cfg-field-absent");
      row.append(el("span", "cfg-field-note", "Not set — the schema default applies."));
      const setButton = el("button", "cfg-btn cfg-btn-ghost", "Set value");
      setButton.type = "button";
      setButton.disabled = disabled;
      if (disabled && typeof state.disabledReason === "string") setButton.title = state.disabledReason;
      setButton.addEventListener("click", () => handlers.onPresentChange?.(field.id, true));
      row.append(setButton);
      wrap.append(row);
      appendStateError(wrap, domId, state, null);
      return wrap;
    }

    if (inherited && field.control !== "select") {
      const line = el("div", "cfg-field-inherited", `Inheriting: ${displayValue(draftField?.effectiveValue)}`);
      wrap.append(line);
    }

    const control = buildControl(field, state, draftField?.value, controlDisabled, domId, handlers, idPrefix);
    if (disabled && typeof state.disabledReason === "string") {
      if (control.focusable !== null) control.focusable.title = state.disabledReason;
    }
    if (control.focusable !== null) {
      label.htmlFor = domId;
    } else {
      control.element.setAttribute("role", control.element.getAttribute("role") ?? "group");
      control.element.setAttribute("aria-labelledby", label.id);
    }
    wrap.append(control.element);

    // "Clear" affordance for optional, currently-present entity fields.
    if (field.optional === true && field.binding === "value" && mode === "present" && !controlDisabled) {
      const clearButton = el("button", "cfg-btn cfg-btn-link", "Clear (use default)");
      clearButton.type = "button";
      clearButton.addEventListener("click", () => handlers.onPresentChange?.(field.id, false));
      wrap.append(clearButton);
    }

    appendStateError(wrap, domId, state, control);
    return wrap;
  }

  /**
   * Inherit/Override segmented control (two buttons, aria-pressed).
   * @param {object} field
   * @param {object|undefined} draftField
   * @param {boolean} disabled
   * @param {string|undefined} disabledReason
   * @param {ConfigFieldHandlers} handlers
   * @returns {HTMLElement}
   */
  function buildBindingControl(field, draftField, disabled, disabledReason, handlers) {
    const inherited = draftField !== undefined && draftField.inherit === true;
    const group = el("div", "cfg-segment");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", `${field.label} value source`);
    for (const [text, value] of /** @type {const} */ ([["Inherit", true], ["Override", false]])) {
      const button = el("button", "cfg-segment-btn", text);
      button.type = "button";
      button.setAttribute("aria-pressed", String(value === inherited));
      if (value === inherited) button.classList.add("cfg-active");
      button.disabled = disabled;
      if (disabled && typeof disabledReason === "string") button.title = disabledReason;
      button.addEventListener("click", () => handlers.onInheritChange?.(field.id, value));
      group.append(button);
    }
    return group;
  }

  /**
   * Provenance/effective-value note for layered fields.
   * @param {object} field
   * @param {object|undefined} draftField
   * @returns {string|null}
   */
  function provenanceNote(field, draftField) {
    if (draftField === undefined) return null;
    if (field.binding === "inherit-or-override" && draftField.inherit === true) {
      return null; // the "Inheriting:" line covers it
    }
    const overridden = Array.isArray(draftField.overriddenValues) ? draftField.overriddenValues : [];
    if (overridden.length > 0) {
      const sources = overridden.map((entry) => `${entry.source}: ${displayValue(entry.value)}`).join("; ");
      return `Overrides ${sources}`;
    }
    if (draftField.provenance === "file") return "Set by the config file (read-only layer below).";
    return null;
  }

  /**
   * Append the role=alert state error node and finish aria-describedby wiring.
   * @param {HTMLElement} wrap
   * @param {string} domId
   * @param {object} state
   * @param {RenderedControl|null} control
   */
  function appendStateError(wrap, domId, state, control) {
    const errorId = `${domId}-error`;
    const messages = [];
    if (typeof state.error === "string" && state.error.length > 0) messages.push(state.error);
    if (typeof state.optionsError === "string" && state.optionsError.length > 0) messages.push(state.optionsError);
    const errorNode = el("div", "cfg-field-error", messages.join(" "));
    errorNode.id = errorId;
    errorNode.setAttribute("role", "alert");
    if (messages.length === 0) errorNode.hidden = true;
    wrap.append(errorNode);
    if (control !== null && control.focusable !== null) {
      const describedBy = [...control.localErrorIds, errorId].join(" ");
      control.focusable.setAttribute("aria-describedby", describedBy);
    }
  }

  /**
   * Dispatch to the ten architecture §3.16 controls.
   * @param {object} field
   * @param {object} state
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @param {string} idPrefix
   * @returns {RenderedControl}
   */
  function buildControl(field, state, value, disabled, domId, handlers, idPrefix) {
    switch (field.control) {
      case "text":
        return buildText(field, value, disabled, domId, handlers);
      case "document":
        return buildDocument(field, value, disabled, domId, handlers);
      case "number":
        return buildNumber(field, value, disabled, domId, handlers);
      case "toggle":
        return buildToggle(field, value, disabled, domId, handlers);
      case "select":
        return buildSelect(field, state, value, disabled, domId, handlers);
      case "multiselect":
        return buildMultiselect(field, state, value, disabled, domId, handlers);
      case "ordered-list":
        return buildOrderedList(field, state, value, disabled, domId, handlers, idPrefix);
      case "map":
        return buildMap(field, value, disabled, domId, handlers);
      case "secret-ref":
        return buildSecretRef(field, state, value, disabled, domId, handlers);
      case "secret-value":
        return buildSecretValue(field, value, disabled, domId, handlers);
      case "matcher":
        return buildMatcher(field, value, disabled, domId, handlers);
      case "path-template":
        return buildPathTemplate(field, state, value, disabled, domId, handlers);
      default:
        return buildText(field, value, disabled, domId, handlers);
    }
  }

  /**
   * @param {object} field
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {RenderedControl}
   */
  function buildText(field, value, disabled, domId, handlers) {
    const input = /** @type {HTMLInputElement} */ (el("input", "cfg-input"));
    input.type = "text";
    input.id = domId;
    input.value = typeof value === "string" ? value : "";
    input.disabled = disabled;
    input.addEventListener("input", () => handlers.onValueChange(field.id, input.value));
    return { element: input, focusable: input, localErrorIds: [] };
  }

  /**
   * Multi-line markdown document editor (template/prompt record values).
   * @param {object} field
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {RenderedControl}
   */
  function buildDocument(field, value, disabled, domId, handlers) {
    const textarea = /** @type {HTMLTextAreaElement} */ (el("textarea", "cfg-input cfg-textarea cfg-document"));
    textarea.id = domId;
    textarea.rows = 16;
    textarea.spellcheck = false;
    textarea.value = typeof value === "string" ? value : "";
    textarea.disabled = disabled;
    textarea.setAttribute("aria-label", `${field.label} (markdown document)`);
    textarea.addEventListener("input", () => handlers.onValueChange(field.id, textarea.value));
    return { element: textarea, focusable: textarea, localErrorIds: [] };
  }

  /**
   * Number keeps the raw string in the input; only successful parses reach the
   * draft (U06: "" is absent, never 0).
   * @param {object} field
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {RenderedControl}
   */
  function buildNumber(field, value, disabled, domId, handlers) {
    const box = el("div", "cfg-number");
    const input = /** @type {HTMLInputElement} */ (el("input", "cfg-input"));
    input.type = "text";
    input.inputMode = "decimal";
    input.id = domId;
    input.value = typeof value === "number" ? String(value) : "";
    input.disabled = disabled;
    const localError = el("div", "cfg-field-error");
    localError.dataset.localValidation = "true";
    localError.id = `${domId}-nan`;
    localError.setAttribute("role", "alert");
    localError.hidden = true;
    input.addEventListener("input", () => {
      const parsed = parseNumberInput(input.value);
      if (parsed.ok) {
        localError.hidden = true;
        handlers.onValueChange(field.id, parsed.value);
      } else if (parsed.reason === "empty") {
        localError.hidden = true;
        handlers.onValueChange(field.id, undefined);
      } else {
        localError.textContent = "Enter a finite number.";
        localError.hidden = false;
      }
    });
    box.append(input, localError);
    return { element: box, focusable: input, localErrorIds: [localError.id] };
  }

  /**
   * @param {object} field
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {RenderedControl}
   */
  function buildToggle(field, value, disabled, domId, handlers) {
    const row = el("div", "cfg-toggle");
    const input = /** @type {HTMLInputElement} */ (el("input", "cfg-toggle-input"));
    input.type = "checkbox";
    input.id = domId;
    input.checked = value === true;
    input.disabled = disabled;
    // The header label (htmlFor=domId) already names this checkbox — no
    // second label here, or the text would render twice.
    input.addEventListener("change", () => handlers.onValueChange(field.id, input.checked));
    row.append(input);
    return { element: row, focusable: input, localErrorIds: [] };
  }

  /**
   * Single select. Inherit-or-override bindings in the inherited state carry a
   * "(inherit)" sentinel option; a vanished current value is shown as
   * "(missing)" instead of silently defaulting to the first option (U19).
   * @param {object} field
   * @param {object} state
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {RenderedControl}
   */
  function buildSelect(field, state, value, disabled, domId, handlers) {
    const select = /** @type {HTMLSelectElement} */ (el("select", "cfg-input"));
    select.id = domId;
    select.disabled = disabled;
    const current = typeof value === "string" ? value : undefined;
    const inherited = field.binding === "inherit-or-override" && current === undefined;
    if (field.binding === "inherit-or-override" && inherited) {
      const sentinel = el("option", undefined, "(inherit)");
      sentinel.value = INHERIT_SENTINEL;
      select.append(sentinel);
    }
    let found = current === undefined;
    const options = Array.isArray(state.options) ? state.options : [];
    for (const option of options) {
      const node = el("option", undefined, typeof option.label === "string" ? option.label : option.value);
      node.value = option.value;
      if (option.disabled === true) node.disabled = true;
      if (current === option.value) {
        node.selected = true;
        found = true;
      }
      select.append(node);
    }
    if (!found && current !== undefined) {
      const missing = el("option", undefined, `${current} (missing)`);
      missing.value = current;
      missing.selected = true;
      select.append(missing);
    }
    if (current === undefined && !inherited) {
      const placeholder = el("option", undefined, "(not set)");
      placeholder.value = "";
      placeholder.selected = true;
      select.prepend(placeholder);
    }
    if (inherited) select.value = INHERIT_SENTINEL;
    select.addEventListener("change", () => {
      if (select.value === INHERIT_SENTINEL) {
        handlers.onInheritChange?.(field.id, true);
        return;
      }
      // Value first, then the inherit flip: the flip may re-render the editor,
      // and the toggled draft must already carry the picked value (U05).
      handlers.onValueChange(field.id, select.value === "" ? undefined : select.value);
      if (field.binding === "inherit-or-override" && inherited) handlers.onInheritChange?.(field.id, false);
    });
    return { element: select, focusable: select, localErrorIds: [] };
  }

  /**
   * Multiselect: checkbox list at ≤12 options (user order preserved by
   * append-on-check), one-per-line textarea with validation above.
   * @param {object} field
   * @param {object} state
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {RenderedControl}
   */
  function buildMultiselect(field, state, value, disabled, domId, handlers) {
    let values = Array.isArray(value) ? value.filter((entry) => typeof entry === "string" || typeof entry === "number") : [];
    const options = Array.isArray(state.options) ? state.options : [];
    if (options.length > 0 && options.length <= MULTISELECT_CHECKBOX_LIMIT && field.valueKind !== "number[]") {
      const list = el("div", "cfg-checklist");
      const known = new Set(options.map((option) => option.value));
      const entries = [
        ...options.map((option) => ({ value: option.value, label: option.label, disabled: option.disabled === true, missing: false })),
        ...values
          .filter((entry) => !known.has(entry))
          .map((entry) => ({ value: entry, label: `${entry} (missing)`, disabled: false, missing: true })),
      ];
      entries.forEach((entry, index) => {
        const row = el("div", "cfg-checklist-row");
        const checkbox = /** @type {HTMLInputElement} */ (el("input"));
        checkbox.type = "checkbox";
        const checkboxId = `${domId}-${index}-${sanitizeId(entry.value)}`;
        checkbox.id = checkboxId;
        checkbox.checked = values.includes(entry.value);
        checkbox.disabled = disabled || entry.disabled;
        const text = el("label", "cfg-checklist-label", typeof entry.label === "string" ? entry.label : entry.value);
        text.htmlFor = checkboxId;
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            values = values.includes(entry.value) ? values : [...values, entry.value];
          } else {
            values = values.filter((item) => item !== entry.value);
          }
          handlers.onValueChange(field.id, values);
        });
        row.append(checkbox, text);
        list.append(row);
      });
      if (entries.length === 0) list.append(el("div", "cfg-field-note", "No options available."));
      return { element: list, focusable: null, localErrorIds: [] };
    }
    const box = el("div", "cfg-multitext");
    const textarea = /** @type {HTMLTextAreaElement} */ (el("textarea", "cfg-input cfg-textarea"));
    textarea.id = domId;
    textarea.rows = 8;
    textarea.disabled = disabled;
    textarea.value = values.join("\n");
    textarea.setAttribute("aria-label", `${field.label} (one entry per line)`);
    const localError = el("div", "cfg-field-error");
    localError.dataset.localValidation = "true";
    localError.id = `${domId}-unknown`;
    localError.setAttribute("role", "alert");
    localError.hidden = true;
    textarea.addEventListener("change", () => {
      const lines = textarea.value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (field.valueKind === "number[]" && lines.some(line => !parseNumberInput(line).ok)) {
        localError.textContent = "Enter finite numbers, one per line.";
        localError.hidden = false;
        return;
      }
      const deduped = [...new Set(field.valueKind === "number[]" ? lines.map(Number) : lines)];
      handlers.onValueChange(field.id, deduped);
      if (options.length > 0 && state.optionsError === undefined) {
        const known = new Set(options.map((option) => option.value));
        const unknown = deduped.filter((entry) => !known.has(entry));
        if (unknown.length > 0) {
          localError.textContent = `Unknown entries: ${unknown.join(", ")}`;
          localError.hidden = false;
          return;
        }
      }
      localError.hidden = true;
    });
    box.append(textarea, localError);
    return { element: box, focusable: textarea, localErrorIds: [localError.id] };
  }

  /**
   * Next row id mirroring the form-state `r<N>` scheme (max numeric suffix + 1)
   * for rows the renderer materializes locally inside nested lists.
   * @param {readonly unknown[]} rows
   * @returns {string}
   */
  function nextRowId(rows) {
    let max = 0;
    for (const row of rows) {
      if (row !== null && typeof row === "object") {
        const id = /** @type {Record<string, unknown>} */ (row)._rowId;
        if (typeof id === "string") {
          const match = /^r(\d+)$/.exec(id);
          if (match !== null) max = Math.max(max, Number(match[1]));
        }
      }
    }
    return `r${max + 1}`;
  }

  /**
   * @param {unknown} row
   * @param {number} index
   * @returns {string}
   */
  function rowKeyOf(row, index) {
    if (row !== null && typeof row === "object") {
      const id = /** @type {Record<string, unknown>} */ (row)._rowId;
      if (typeof id === "string") return id;
    }
    return `#${index}`;
  }

  /**
   * Apply a ConfigListOperation to a nested array locally (nested lists such
   * as schedule windows cannot be addressed by sessionListOp directly; the
   * parent row value is replaced wholesale via a "set" op).
   * @param {readonly unknown[]} rows
   * @param {object} op
   * @returns {unknown[]}
   */
  function applyListOpLocally(rows, op, field) {
    if (op.type === "insert") {
      const row = { ...(typeof op.row === "object" && op.row !== null ? op.row : {}), _rowId: nextRowId(rows) };
      const index = op.index === undefined ? rows.length : Math.min(Math.max(Math.trunc(op.index), 0), rows.length);
      return [...rows.slice(0, index), row, ...rows.slice(index)];
    }
    const index = rows.findIndex((row, at) => rowKeyOf(row, at) === op.rowId);
    if (index < 0) return rows.slice();
    if (op.type === "remove") return [...rows.slice(0, index), ...rows.slice(index + 1)];
    if (op.type === "move") {
      const to = Math.min(Math.max(Math.trunc(op.toIndex), 0), rows.length - 1);
      const next = rows.slice();
      const [moved] = next.splice(index, 1);
      next.splice(to, 0, moved);
      return next;
    }
    if (op.type === "set") {
      const next = rows.slice();
      const row = next[index];
      next[index] = writeRowField(row, field, op.itemFieldId, op.value);
      return next;
    }
    return rows.slice();
  }

  /**
   * Ordered-list with up/down/remove icon buttons, add, and Alt+ArrowUp/Down
   * keyboard move (D8 — no drag). Object rows render their itemFields
   * recursively (schedule rules, match rules, model group entries); scalar
   * lists are rebuilt wholesale via onValueChange (form-state contract).
   * @param {object} field
   * @param {object} state
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @param {string} idPrefix
   * @returns {RenderedControl}
   */
  function buildOrderedList(field, state, value, disabled, domId, handlers, idPrefix) {
    const rows = Array.isArray(value) ? value : [];
    const itemFields = Array.isArray(field.itemFields) ? field.itemFields : [];
    const objectRows = itemFields.length > 0;
    const box = el("div", "cfg-olist");
    const list = el("ol", "cfg-olist-rows");

    const moveRow = (from, to) => {
      if (disabled || to < 0 || to >= rows.length) return;
      if (objectRows) {
        handlers.onListOp?.(field.id, { type: "move", rowId: rowKeyOf(rows[from], from), toIndex: to });
      } else {
        const next = rows.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        handlers.onValueChange(field.id, next);
      }
    };
    const removeRow = (index) => {
      if (objectRows) {
        handlers.onListOp?.(field.id, { type: "remove", rowId: rowKeyOf(rows[index], index) });
      } else {
        handlers.onValueChange(field.id, rows.filter((_, at) => at !== index));
      }
    };

    rows.forEach((row, index) => {
      const rowKey = rowKeyOf(row, index);
      const item = el("li", "cfg-olist-row");
      item.tabIndex = 0;
      item.dataset.rowId = rowKey;
      const controls = el("div", "cfg-olist-controls");
      const up = iconButton("↑", "Move row up", "Move up (Alt+ArrowUp)");
      up.disabled = disabled || index === 0;
      up.addEventListener("click", () => moveRow(index, index - 1));
      const down = iconButton("↓", "Move row down", "Move down (Alt+ArrowDown)");
      down.disabled = disabled || index === rows.length - 1;
      down.addEventListener("click", () => moveRow(index, index + 1));
      const remove = iconButton("✕", "Remove row", "Remove row");
      remove.disabled = disabled;
      remove.addEventListener("click", () => removeRow(index));
      controls.append(up, down, remove);
      item.append(controls);

      const body = el("div", "cfg-olist-rowbody");
      if (objectRows) {
        for (const itemField of itemFields) {
          body.append(renderNestedItemField(field, row, rowKey, itemField, disabled, handlers, idPrefix));
        }
      } else {
        body.append(buildScalarRow(field, row, index, rows, disabled, domId, handlers));
      }
      item.append(body);
      item.addEventListener("keydown", (event) => {
        if (!event.altKey) return;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          moveRow(index, index - 1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          moveRow(index, index + 1);
        }
      });
      list.append(item);
    });
    box.append(list);

    const add = el("button", "cfg-btn cfg-btn-ghost", "＋ Add");
    add.type = "button";
    add.disabled = disabled;
    add.setAttribute("aria-label", `Add ${field.label} row`);
    add.title = "Add row";
    add.addEventListener("click", () => {
      if (objectRows) {
        handlers.onListOp?.(field.id, { type: "insert" });
      } else {
        handlers.onValueChange(field.id, [...rows, ""]);
      }
    });
    box.append(add);
    if (rows.length === 0) box.append(el("div", "cfg-field-note", "No entries yet."));
    return { element: box, focusable: null, localErrorIds: [] };
  }

  /**
   * One row of an object-row ordered-list: render each itemField with
   * handlers that translate nested edits into parent list "set" ops.
   * @param {object} parentField
   * @param {unknown} row
   * @param {string} rowKey
   * @param {object} itemField
   * @param {boolean} disabled
   * @param {ConfigFieldHandlers} handlers
   * @param {string} idPrefix
   * @returns {HTMLElement}
   */
  function renderNestedItemField(parentField, row, rowKey, itemField, disabled, handlers, idPrefix) {
    let itemValue = readRowField(row, itemField);
    const host = el("div", "cfg-nested-field");
    const commit = (next, structural = false) => {
      itemValue = next;
      handlers.onListOp?.(parentField.id, { type: "set", rowId: rowKey, itemFieldId: itemField.id, value: next });
      if (structural) render();
    };
    const render = () => {
    const nestedDraft = {
      id: itemField.id,
      mode: itemValue === undefined ? "absent" : "present",
      inherit: false,
      value: itemValue,
      effectiveValue: undefined,
      provenance: "none",
      overriddenValues: [],
    };
    const resolvedOptions = itemOptionsResolver?.(parentField, itemField, itemValue);
    const nestedState = {
      visible: true,
      disabled,
      options: resolvedOptions?.options ?? (Array.isArray(itemField.options) ? itemField.options : []),
      ...(resolvedOptions?.error !== undefined ? { optionsError: resolvedOptions.error } : {}),
    };
    /** @type {ConfigFieldHandlers} */
    const nestedHandlers = {
      onValueChange: (_fieldId, next) => {
        commit(next);
      },
      onPresentChange: (_fieldId, present) => commit(present ? itemField.hasDefault ? itemField.defaultValue : ["map", "ordered-list", "multiselect"].includes(itemField.control) ? [] : "" : undefined, true),
      onListOp: (_fieldId, op) => {
        const current = Array.isArray(itemValue) ? itemValue : [];
        const next = applyListOpLocally(current, op, itemField);
        commit(next, op.type !== "set");
      },
      onMapOp: (_fieldId, op) => {
        const current = Array.isArray(itemValue) ? itemValue : [];
        const next = applyMapOpLocally(current, op);
        commit(next, op.type === "insert" || op.type === "remove");
      },
    };
    host.replaceChildren(renderField(itemField, nestedState, nestedDraft, nestedHandlers, { idPrefix: `${idPrefix}${sanitizeId(rowKey)}-` }));
    };
    render();
    return host;
  }

  /**
   * Scalar ordered-list row editor (string[] / number[] without itemFields).
   * @param {object} field
   * @param {unknown} row
   * @param {number} index
   * @param {readonly unknown[]} rows
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {HTMLElement}
   */
  function buildScalarRow(field, row, index, rows, disabled, domId, handlers) {
    const box = el("div", "cfg-olist-scalar");
    const input = /** @type {HTMLInputElement} */ (el("input", "cfg-input"));
    input.type = "text";
    input.id = `${domId}-row-${index}`;
    input.setAttribute("aria-label", `${field.label} row ${index + 1}`);
    input.value = typeof row === "string" || typeof row === "number" ? String(row) : "";
    input.disabled = disabled;
    const localError = el("div", "cfg-field-error");
    localError.dataset.localValidation = "true";
    localError.setAttribute("role", "alert");
    localError.hidden = true;
    input.addEventListener("change", () => {
      const next = rows.slice();
      if (field.valueKind === "number[]") {
        const parsed = parseNumberInput(input.value);
        if (!parsed.ok) {
          localError.textContent = parsed.reason === "empty" ? "Remove the row instead of leaving it empty." : "Enter a finite number.";
          localError.hidden = false;
          return;
        }
        localError.hidden = true;
        next[index] = parsed.value;
      } else {
        next[index] = input.value;
      }
      handlers.onValueChange(field.id, next);
    });
    box.append(input, localError);
    return box;
  }

  /**
   * Apply a ConfigMapOperation to a nested map array locally (same rationale
   * as applyListOpLocally).
   * @param {readonly unknown[]} entries
   * @param {object} op
   * @returns {unknown[]}
   */
  function applyMapOpLocally(entries, op) {
    if (op.type === "insert") {
      return [...entries, { _rowId: nextRowId(entries), key: typeof op.key === "string" ? op.key : "", value: "" }];
    }
    const index = entries.findIndex((row, at) => rowKeyOf(row, at) === op.rowId);
    if (index < 0) return entries.slice();
    if (op.type === "remove") return [...entries.slice(0, index), ...entries.slice(index + 1)];
    const next = entries.slice();
    const row = next[index];
    const base = row !== null && typeof row === "object" ? row : {};
    if (op.type === "setKey") next[index] = { ...base, key: op.key };
    else if (op.type === "setValue") next[index] = { ...base, value: op.value };
    return next;
  }

  /**
   * Map control: key/value rows, order-preserving, duplicate keys flagged
   * inline (U09 — never silently merged).
   * @param {object} field
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {RenderedControl}
   */
  function buildMap(field, value, disabled, domId, handlers) {
    const entries = Array.isArray(value) ? value : [];
    const keyCounts = new Map();
    for (const entry of entries) {
      if (entry !== null && typeof entry === "object") {
        const key = /** @type {Record<string, unknown>} */ (entry).key;
        if (typeof key === "string" && key.length > 0) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
      }
    }
    const box = el("div", "cfg-map");
    entries.forEach((entry, index) => {
      const record = entry !== null && typeof entry === "object" ? /** @type {Record<string, unknown>} */ (entry) : {};
      const rowId = rowKeyOf(entry, index);
      const key = typeof record.key === "string" ? record.key : "";
      const row = el("div", "cfg-map-row");

      const keyBox = el("div", "cfg-map-key");
      const keyInput = /** @type {HTMLInputElement} */ (el("input", "cfg-input"));
      keyInput.type = "text";
      keyInput.id = `${domId}-key-${index}`;
      keyInput.setAttribute("aria-label", `${field.label} key ${index + 1}`);
      keyInput.value = key;
      keyInput.disabled = disabled;
      keyInput.addEventListener("input", () => handlers.onMapOp?.(field.id, { type: "setKey", rowId, key: keyInput.value }));
      keyBox.append(keyInput);
      if (key.length === 0) {
        const required = el("div", "cfg-field-error", "Key required.");
        required.dataset.localValidation = "true";
        required.setAttribute("role", "alert");
        keyBox.append(required);
      } else if ((keyCounts.get(key) ?? 0) > 1) {
        const dup = el("div", "cfg-field-error", "Duplicate key.");
        dup.dataset.localValidation = "true";
        dup.setAttribute("role", "alert");
        keyBox.append(dup);
      }
      row.append(keyBox);

      row.append(buildMapValue(field, record.value, rowId, index, disabled, domId, handlers));

      const remove = iconButton("✕", "Remove entry", "Remove entry");
      remove.disabled = disabled;
      remove.addEventListener("click", () => handlers.onMapOp?.(field.id, { type: "remove", rowId }));
      row.append(remove);
      box.append(row);
    });
    const add = el("button", "cfg-btn cfg-btn-ghost", "＋ Add");
    add.type = "button";
    add.disabled = disabled;
    add.setAttribute("aria-label", `Add ${field.label} entry`);
    add.title = "Add entry";
    add.addEventListener("click", () => handlers.onMapOp?.(field.id, { type: "insert" }));
    box.append(add);
    if (entries.length === 0) box.append(el("div", "cfg-field-note", "No entries yet."));
    return { element: box, focusable: null, localErrorIds: [] };
  }

  /**
   * Value side of a map row, typed by field.mapValueKind.
   * @param {object} field
   * @param {unknown} entryValue
   * @param {string} rowId
   * @param {number} index
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {HTMLElement}
   */
  function buildMapValue(field, entryValue, rowId, index, disabled, domId, handlers) {
    if (field.mapValueKind === "credential") {
      const box = el("div", "cfg-map-value");
      const mode = /** @type {HTMLSelectElement} */ (el("select", "cfg-input"));
      mode.setAttribute("aria-label", `${field.label} source ${index + 1}`);
      for (const [value, label] of [["env", "Environment variable"], ["literal", "Literal value"]]) {
        const choice = el("option", "", label);
        choice.value = value;
        mode.append(choice);
      }
      mode.value = entryValue !== null && typeof entryValue === "object" ? "literal" : "env";
      mode.disabled = disabled;
      const host = el("div");
      const render = (value) => {
        host.replaceChildren();
        const change = (_id, next) => handlers.onMapOp?.(field.id, {
          type: "setValue", rowId, value: mode.value === "literal" ? { value: next } : next,
        });
        const control = mode.value === "literal"
          ? buildSecretValue(field, value?.value, disabled, `${domId}-value-${index}`, { onValueChange: change })
          : buildText(field, value, disabled, `${domId}-value-${index}`, { onValueChange: change });
        host.append(control.element);
      };
      mode.addEventListener("change", () => {
        const value = mode.value === "literal" ? { value: "" } : "";
        handlers.onMapOp?.(field.id, { type: "setValue", rowId, value });
        render(value);
      });
      render(entryValue);
      box.append(mode, host);
      return box;
    }
    if (field.itemFields) {
      const host = el("div", "cfg-map-fields");
      let current = entryValue ?? {};
      const nestedHandlers = { onListOp: (_id, op) => {
        current = writeRowField(current, field, op.itemFieldId, op.value);
        handlers.onMapOp?.(field.id, { type: "setValue", rowId, value: current });
      } };
      for (const item of field.itemFields) host.append(renderNestedItemField(field, current, rowId, item, disabled, nestedHandlers, `${domId}-`));
      return host;
    }
    const box = el("div", "cfg-map-value");
    const localError = el("div", "cfg-field-error");
    localError.dataset.localValidation = "true";
    localError.setAttribute("role", "alert");
    localError.hidden = true;
    if (field.mapValueKind === "record") {
      const textarea = /** @type {HTMLTextAreaElement} */ (el("textarea", "cfg-input cfg-textarea"));
      textarea.rows = 3;
      textarea.id = `${domId}-value-${index}`;
      textarea.setAttribute("aria-label", `${field.label} value ${index + 1} (JSON)`);
      textarea.value = entryValue === undefined ? "" : JSON.stringify(entryValue);
      textarea.disabled = disabled;
      textarea.addEventListener("change", () => {
        try {
          const parsed = textarea.value.trim() === "" ? {} : JSON.parse(textarea.value);
          localError.hidden = true;
          handlers.onMapOp?.(field.id, { type: "setValue", rowId, value: parsed });
        } catch {
          localError.textContent = "Invalid JSON.";
          localError.hidden = false;
        }
      });
      box.append(textarea, localError);
      return box;
    }
    const input = /** @type {HTMLInputElement} */ (el("input", "cfg-input"));
    input.type = "text";
    input.id = `${domId}-value-${index}`;
    input.setAttribute("aria-label", `${field.label} value ${index + 1}`);
    input.value = typeof entryValue === "string" || typeof entryValue === "number" ? String(entryValue) : "";
    input.disabled = disabled;
    input.addEventListener("change", () => {
      if (field.mapValueKind === "number") {
        const parsed = parseNumberInput(input.value);
        if (!parsed.ok) {
          localError.textContent = "Enter a finite number.";
          localError.hidden = false;
          return;
        }
        localError.hidden = true;
        handlers.onMapOp?.(field.id, { type: "setValue", rowId, value: parsed.value });
        return;
      }
      handlers.onMapOp?.(field.id, { type: "setValue", rowId, value: input.value });
    });
    box.append(input, localError);
    return box;
  }

  /**
   * Secret reference: env NAME only, datalist from the secret_envs options
   * source, presence hint (architecture §3.16 — values never leave/enter the API).
   * @param {object} field
   * @param {object} state
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {RenderedControl}
   */
  function buildSecretRef(field, state, value, disabled, domId, handlers) {
    const box = el("div", "cfg-secret");
    const input = /** @type {HTMLInputElement} */ (el("input", "cfg-input"));
    input.type = "text";
    input.id = domId;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = typeof value === "string" ? value : "";
    input.disabled = disabled;
    const listId = `${domId}-secrets`;
    input.setAttribute("list", listId);
    const datalist = el("datalist");
    datalist.id = listId;
    const options = Array.isArray(state.options) ? state.options : [];
    for (const option of options) {
      const node = el("option");
      node.value = option.value;
      if (typeof option.label === "string") node.label = option.label;
      datalist.append(node);
    }
    const hint = el("div", "cfg-field-note");
    const updateHint = () => {
      const current = input.value.trim();
      if (current.length === 0) {
        hint.textContent = "Not set.";
        return;
      }
      const match = options.find((option) => option.value === current);
      if (match === undefined) {
        hint.textContent = "Name is not in the allowed reference list.";
      } else if (match.disabled === true) {
        hint.textContent = "Referenced variable is missing in the environment.";
      } else {
        hint.textContent = "Reference present in the environment.";
      }
    };
    input.addEventListener("input", () => {
      handlers.onValueChange(field.id, input.value);
      updateHint();
    });
    updateHint();
    box.append(input, datalist, hint);
    return { element: box, focusable: input, localErrorIds: [] };
  }

  /**
   * Literal credential input (password-style). A server-masked value renders
   * as an empty input with a "set" placeholder: the draft keeps the mask
   * sentinel, which the encoder strips so the stored secret survives the
   * save; typing replaces it; clearing after typing removes it (null).
   * @param {object} field
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {RenderedControl}
   */
  function buildSecretValue(field, value, disabled, domId, handlers) {
    const box = el("div", "cfg-secret");
    const input = /** @type {HTMLInputElement} */ (el("input", "cfg-input"));
    input.type = "password";
    input.id = domId;
    input.autocomplete = "new-password";
    input.spellcheck = false;
    const masked = typeof value === "string" && (value === "configured" || value === "•••" || /<redacted>/iu.test(value));
    input.value = masked ? "" : (typeof value === "string" ? value : "");
    input.disabled = disabled;
    if (masked) {
      input.placeholder = "(set — never displayed)";
    }
    const hint = el("div", "cfg-field-note");
    let edited = false;
    const updateHint = () => {
      if (masked && !edited) {
        hint.textContent = "A value is stored but never shown. Leave blank to keep it, or type a new value to replace it.";
        return;
      }
      hint.textContent = input.value.length === 0 ? "Empty after editing removes the stored value." : "";
    };
    input.addEventListener("input", () => {
      edited = true;
      handlers.onValueChange(field.id, input.value);
      updateHint();
    });
    updateHint();
    box.append(input, hint);
    const clear = el("button", "cfg-btn cfg-btn-ghost", "Clear stored value");
    clear.type = "button";
    clear.disabled = disabled;
    clear.addEventListener("click", () => {
      edited = true;
      input.value = "";
      input.placeholder = "";
      handlers.onValueChange(field.id, "");
      updateHint();
    });
    box.append(clear);
    return { element: box, focusable: input, localErrorIds: [] };
  }

  /**
   * Matcher composite: { mode: exact|glob|regex, pattern, ignore_case } —
   * encoded by the paradigm module to exactly one of {exact}/{glob}/{regex}.
   * @param {object} field
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {RenderedControl}
   */
  function buildMatcher(field, value, disabled, domId, handlers) {
    const current = value !== null && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : {};
    const state_ = {
      mode: current.mode === "glob" || current.mode === "regex" ? current.mode : "exact",
      pattern: typeof current.pattern === "string" ? current.pattern : "",
      ignore_case: current.ignore_case === true,
    };
    const commit = () => handlers.onValueChange(field.id, { ...state_ });
    const box = el("div", "cfg-matcher");

    const modeSelect = /** @type {HTMLSelectElement} */ (el("select", "cfg-input"));
    modeSelect.id = domId;
    modeSelect.setAttribute("aria-label", `${field.label} match mode`);
    modeSelect.disabled = disabled;
    for (const mode of ["exact", "glob", "regex"]) {
      const option = el("option", undefined, mode);
      option.value = mode;
      if (state_.mode === mode) option.selected = true;
      modeSelect.append(option);
    }

    const pattern = /** @type {HTMLInputElement} */ (el("input", "cfg-input"));
    pattern.type = "text";
    pattern.id = `${domId}-pattern`;
    pattern.setAttribute("aria-label", `${field.label} pattern`);
    pattern.value = state_.pattern;
    pattern.disabled = disabled;

    const patternError = el("div", "cfg-field-error", "Pattern is required.");
    patternError.dataset.localValidation = "true";
    patternError.setAttribute("role", "alert");
    patternError.hidden = state_.pattern.length > 0;

    const ignoreRow = el("label", "cfg-checklist-label");
    const ignore = /** @type {HTMLInputElement} */ (el("input"));
    ignore.type = "checkbox";
    ignore.id = `${domId}-ignore-case`;
    ignore.checked = state_.ignore_case;
    ignore.disabled = disabled || state_.mode === "exact";
    ignoreRow.append(ignore, doc.createTextNode(" Ignore case"));
    ignoreRow.htmlFor = `${domId}-ignore-case`;

    modeSelect.addEventListener("change", () => {
      state_.mode = modeSelect.value;
      ignore.disabled = disabled || state_.mode === "exact";
      commit();
    });
    pattern.addEventListener("input", () => {
      state_.pattern = pattern.value;
      patternError.hidden = pattern.value.length > 0;
      commit();
    });
    ignore.addEventListener("change", () => {
      state_.ignore_case = ignore.checked;
      commit();
    });
    box.append(modeSelect, pattern, patternError, ignoreRow);
    return { element: box, focusable: pattern, localErrorIds: [] };
  }

  /**
   * Path template with variable completion: typing "{{…" opens a dropdown fed
   * by the path_template_variables options source; picking a variable inserts
   * a validated segment/default expression at the cursor (D8).
   * @param {object} field
   * @param {object} state
   * @param {unknown} value
   * @param {boolean} disabled
   * @param {string} domId
   * @param {ConfigFieldHandlers} handlers
   * @returns {RenderedControl}
   */
  function buildPathTemplate(field, state, value, disabled, domId, handlers) {
    const box = el("div", "cfg-pathtpl");
    const input = /** @type {HTMLInputElement} */ (el("input", "cfg-input"));
    input.type = "text";
    input.id = domId;
    input.value = typeof value === "string" ? value : "";
    input.disabled = disabled;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    const listId = `${domId}-vars`;
    input.setAttribute("aria-controls", listId);
    const dropdown = el("div", "cfg-var-dropdown");
    dropdown.id = listId;
    dropdown.setAttribute("role", "listbox");
    dropdown.hidden = true;
    const options = Array.isArray(state.options) ? state.options : [];
    let matches = [];
    let activeIndex = -1;

    const close = () => {
      dropdown.hidden = true;
      dropdown.replaceChildren();
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      matches = [];
      activeIndex = -1;
    };
    const fragment = () => {
      const cursor = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, cursor);
      const match = /\{\{([A-Za-z0-9_.]*)$/.exec(before);
      if (match === null) return null;
      return { prefix: match[1] ?? "", start: cursor - match[0].length, cursor };
    };
    const setActive = (index) => {
      activeIndex = index;
      dropdown.querySelectorAll("[role=option]").forEach((node, at) => {
        node.classList.toggle("cfg-active", at === index);
        if (at === index) input.setAttribute("aria-activedescendant", node.id);
      });
    };
    const insert = (option, frag) => {
      const inserted = option.insertText ?? `{{segment ${option.value}}}`;
      const next = input.value.slice(0, frag.start) + inserted + input.value.slice(frag.cursor);
      input.value = next;
      const position = frag.start + inserted.length;
      input.setSelectionRange(position, position);
      handlers.onValueChange(field.id, next);
      close();
    };
    const refresh = () => {
      const frag = fragment();
      if (frag === null || disabled) {
        close();
        return;
      }
      matches = options.filter((option) => !option.disabled && option.value.startsWith(frag.prefix)).slice(0, 20);
      if (matches.length === 0) {
        close();
        return;
      }
      dropdown.replaceChildren();
      matches.forEach((option, index) => {
        const item = el("div", "cfg-var-option");
        item.id = `${listId}-${index}`;
        item.setAttribute("role", "option");
        item.append(el("span", "cfg-var-name", option.value));
        if (typeof option.label === "string" && option.label.length > 0) {
          item.append(el("span", "cfg-var-label", ` — ${option.label}`));
        }
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          insert(option, frag);
        });
        dropdown.append(item);
      });
      dropdown.hidden = false;
      input.setAttribute("aria-expanded", "true");
      setActive(0);
    };
    input.addEventListener("input", () => {
      handlers.onValueChange(field.id, input.value);
      refresh();
    });
    input.addEventListener("keydown", (event) => {
      if (dropdown.hidden) return;
      const frag = fragment();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((activeIndex + 1) % matches.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((activeIndex - 1 + matches.length) % matches.length);
      } else if (event.key === "Enter" && frag !== null && activeIndex >= 0 && matches[activeIndex] !== undefined) {
        event.preventDefault();
        insert(matches[activeIndex], frag);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });
    input.addEventListener("blur", () => {
      setTimeout(close, 150);
    });
    box.append(input, dropdown);
    return { element: box, focusable: input, localErrorIds: [] };
  }

  /**
   * Collapsible section wrapper (native details/summary; spec sections may
   * start collapsed).
   * @param {object} section ConfigUiSection.
   * @param {readonly HTMLElement[]} fieldElements Rendered fields in order.
   * @returns {HTMLElement}
   */
  function renderSection(section, fieldElements) {
    const details = /** @type {HTMLDetailsElement} */ (el("details", "cfg-section"));
    details.dataset.sectionId = section.id;
    if (section.collapsed !== true) details.open = true;
    details.append(el("summary", "cfg-section-title", section.label));
    const body = el("div", "cfg-section-body");
    for (const node of fieldElements) body.append(node);
    details.append(body);
    return details;
  }

  /**
   * Entity list table: id/name, source badge, state badges, note excerpt,
   * per-row actions; filter box matches the id substring (case-insensitive).
   * @param {object} options
   * @param {readonly object[]} options.records ConfigEntityRecordView rows.
   * @param {readonly {id: string, label: string, title?: string, tone?: string, when?: (record: object) => boolean}[]} options.actions
   * @param {(actionId: string, record: object) => void} options.onAction
   * @param {string} [options.emptyText]
   * @param {string} [options.filterLabel]
   * @returns {HTMLElement}
   */
  function renderEntityTable(options) {
    const records = Array.isArray(options.records) ? options.records : [];
    const actions = Array.isArray(options.actions) ? options.actions : [];
    const box = el("div", "cfg-entity");
    const filter = /** @type {HTMLInputElement} */ (el("input", "cfg-input cfg-filter"));
    filter.type = "search";
    const filterLabel = options.filterLabel ?? "Filter by id";
    filter.setAttribute("aria-label", filterLabel);
    filter.placeholder = filterLabel;
    box.append(filter);

    const scroll = el("div", "table-scroll");
    const table = el("table", "cfg-table");
    const headRow = el("tr");
    for (const heading of ["Id", "Source", "State", "Note", "Actions"]) headRow.append(el("th", undefined, heading));
    const thead = el("thead");
    thead.append(headRow);
    const tbody = el("tbody");
    table.append(thead, tbody);
    scroll.append(table);
    box.append(scroll);

    const renderRows = () => {
      const query = filter.value.trim().toLowerCase();
      const shown = records.filter((record) => {
        if (query.length === 0) return true;
        const id = typeof record.id === "string" ? record.id : "";
        const name = typeof record.name === "string" ? record.name : "";
        return id.toLowerCase().includes(query) || name.toLowerCase().includes(query);
      });
      while (tbody.firstChild !== null) tbody.removeChild(tbody.firstChild);
      if (shown.length === 0) {
        const row = el("tr");
        const cell = el("td", "cfg-empty", options.emptyText ?? "No records.");
        cell.colSpan = 5;
        row.append(cell);
        tbody.append(row);
        return;
      }
      for (const record of shown) {
        const row = el("tr");
        const idCell = el("td");
        idCell.append(el("div", "mono", typeof record.id === "string" ? record.id : ""));
        if (typeof record.name === "string" && record.name !== record.id) {
          idCell.append(el("div", "cell-sub", record.name));
        }
        row.append(idCell);
        const sourceCell = el("td");
        sourceCell.append(badge(record.source === "file" ? "file" : "database", record.source === "file" ? "file" : "database"));
        row.append(sourceCell);
        const stateCell = el("td", "cfg-state-cell");
        stateCell.append(badge(record.enabled === false ? "disabled" : "enabled", record.enabled === false ? "warn" : "ok"));
        if (record.readonly === true) stateCell.append(badge("readonly", "muted"));
        if (record.shadowedByFile === true) stateCell.append(badge("shadowed", "warn"));
        row.append(stateCell);
        const noteCell = el("td", "cell-sub");
        const note = typeof record.note === "string" ? record.note : "";
        noteCell.textContent = note.length > 80 ? `${note.slice(0, 77)}…` : note;
        row.append(noteCell);
        const actionCell = el("td", "cfg-actions-cell");
        for (const action of actions) {
          if (typeof action.when === "function" && !action.when(record)) continue;
          const button = el("button", `cfg-btn cfg-btn-sm ${action.tone === "danger" ? "cfg-btn-danger" : "cfg-btn-ghost"}`, action.label);
          button.type = "button";
          button.title = typeof action.title === "string" ? action.title : action.label;
          button.addEventListener("click", () => options.onAction(action.id, record));
          actionCell.append(button);
        }
        row.append(actionCell);
        tbody.append(row);
      }
    };
    filter.addEventListener("input", renderRows);
    renderRows();
    return box;
  }

  /**
   * Modal confirmation dialog (role=dialog, aria-modal; Escape cancels when a
   * "cancel" action exists).
   * @param {object} options
   * @param {string} options.title
   * @param {string|Node} options.body
   * @param {readonly {id: string, label: string, tone?: string}[]} options.actions
   * @param {(id: string) => void} options.onAction
   * @returns {HTMLElement}
   */
  function confirmDialog(options) {
    const overlay = el("div", "cfg-dialog-overlay");
    const dialog = el("div", "cfg-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const titleId = `cfg-dialog-title-${(dialogSeq += 1)}`;
    dialog.setAttribute("aria-labelledby", titleId);
    const heading = el("h2", "cfg-dialog-title", options.title);
    heading.id = titleId;
    dialog.append(heading);
    const body = el("div", "cfg-dialog-body");
    if (typeof options.body === "string") body.textContent = options.body;
    else if (options.body !== undefined && options.body !== null) body.append(options.body);
    dialog.append(body);
    const bar = el("div", "cfg-dialog-actions");
    for (const action of options.actions) {
      const button = el(
        "button",
        `cfg-btn ${action.tone === "danger" ? "cfg-btn-danger" : action.tone === "primary" ? "cfg-btn-primary" : "cfg-btn-ghost"}`,
        action.label,
      );
      button.type = "button";
      button.addEventListener("click", () => options.onAction(action.id));
      bar.append(button);
    }
    dialog.append(bar);
    overlay.append(dialog);
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && options.actions.some((action) => action.id === "cancel")) {
        options.onAction("cancel");
      }
    });
    return overlay;
  }

  /**
   * Redacted diff rendering (ConfigDiffEntry list from form-state, or entries
   * mapped from a revision's redactedDiff; values may be absent — the audit
   * trail carries names/paths only, S06).
   * @param {readonly object[]} entries {path, change: added|removed|changed, before?, after?}
   * @returns {HTMLElement}
   */
  function diffView(entries) {
    const box = el("div", "cfg-diff");
    if (!Array.isArray(entries) || entries.length === 0) {
      box.append(el("div", "cfg-empty", "No differences."));
      return box;
    }
    const scroll = el("div", "table-scroll");
    const table = el("table", "cfg-table");
    const headRow = el("tr");
    for (const heading of ["Path", "Change", "Before", "After"]) headRow.append(el("th", undefined, heading));
    const thead = el("thead");
    thead.append(headRow);
    const tbody = el("tbody");
    for (const entry of entries) {
      const row = el("tr");
      row.append(el("td", "mono", typeof entry.path === "string" ? entry.path : ""));
      const changeCell = el("td");
      const change = typeof entry.change === "string" ? entry.change : "changed";
      changeCell.append(badge(change, change === "added" ? "ok" : change === "removed" ? "danger" : "warn"));
      row.append(changeCell);
      row.append(el("td", "mono", displayValue(entry.before)));
      row.append(el("td", "mono", displayValue(entry.after)));
      tbody.append(row);
    }
    table.append(thead, tbody);
    scroll.append(table);
    box.append(scroll);
    return box;
  }

  /**
   * Route preview composite (D8): fixture event form (trigger, target_kind,
   * repo_ref, branch) plus a result pane. onPreview receives the event DTO;
   * the caller feeds outcomes back via showResult/showError.
   * @param {object} options
   * @param {readonly (string|{value: string, label?: string})[]} options.triggers
   * @param {readonly string[]} options.targetKinds
   * @param {(event: object) => void} options.onPreview
   * @returns {{element: HTMLElement, showResult: (node: Node) => void, showError: (message: string) => void, setBusy: (busy: boolean) => void}}
   */
  function renderRoutePreviewPanel(options) {
    const box = el("section", "cfg-preview");
    box.append(el("h3", "cfg-subtitle", "Route preview"));
    const form = el("form", "cfg-preview-form");

    const triggerSelect = /** @type {HTMLSelectElement} */ (el("select", "cfg-input"));
    triggerSelect.id = "cfg-preview-trigger";
    const triggerLabel = el("label", "cfg-field-label", "Trigger");
    triggerLabel.htmlFor = triggerSelect.id;
    for (const entry of options.triggers) {
      const value = typeof entry === "string" ? entry : entry.value;
      const label = typeof entry === "string" ? entry : entry.label ?? entry.value;
      const node = el("option", undefined, label);
      node.value = value;
      triggerSelect.append(node);
    }

    const kindSelect = /** @type {HTMLSelectElement} */ (el("select", "cfg-input"));
    kindSelect.id = "cfg-preview-target-kind";
    const kindLabel = el("label", "cfg-field-label", "Target kind");
    kindLabel.htmlFor = kindSelect.id;
    for (const kind of options.targetKinds) {
      const node = el("option", undefined, kind);
      node.value = kind;
      kindSelect.append(node);
    }

    const repoInput = /** @type {HTMLInputElement} */ (el("input", "cfg-input"));
    repoInput.type = "text";
    repoInput.id = "cfg-preview-repo-ref";
    const repoLabel = el("label", "cfg-field-label", "Repository ref (optional)");
    repoLabel.htmlFor = repoInput.id;

    const branchInput = /** @type {HTMLInputElement} */ (el("input", "cfg-input"));
    branchInput.type = "text";
    branchInput.id = "cfg-preview-branch";
    const branchLabel = el("label", "cfg-field-label", "Branch (optional)");
    branchLabel.htmlFor = branchInput.id;

    const submit = el("button", "cfg-btn cfg-btn-primary", "Preview");
    submit.type = "submit";
    submit.disabled = options.triggers.length === 0;

    const fields = el("div", "cfg-preview-fields");
    for (const [label, control] of [
      [triggerLabel, triggerSelect],
      [kindLabel, kindSelect],
      [repoLabel, repoInput],
      [branchLabel, branchInput],
    ]) {
      const cell = el("div", "cfg-preview-field");
      cell.append(label, control);
      fields.append(cell);
    }
    form.append(fields, submit);
    if (options.triggers.length === 0) {
      form.append(el("div", "cfg-field-note", "No triggers configured — add a trigger before previewing routes."));
    }
    box.append(form);

    const pane = el("div", "cfg-preview-result");
    pane.setAttribute("aria-live", "polite");
    box.append(pane);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (triggerSelect.value.length === 0) return;
      const previewEvent = {
        triggerName: triggerSelect.value,
        targetKind: kindSelect.value,
        ...(repoInput.value.trim().length > 0 ? { repoRef: repoInput.value.trim() } : {}),
        ...(branchInput.value.trim().length > 0 ? { branch: branchInput.value.trim() } : {}),
      };
      options.onPreview(previewEvent);
    });

    return {
      element: box,
      showResult(node) {
        pane.replaceChildren(node);
      },
      showError(message) {
        pane.replaceChildren(errorBanner(message));
      },
      setBusy(busy) {
        submit.disabled = busy || options.triggers.length === 0;
        if (busy) pane.replaceChildren(el("div", "cfg-field-note", "Evaluating route…"));
      },
    };
  }

  /**
   * Definition-list helper for preview result sections.
   * @param {string} title
   * @param {unknown} value Object rendered as dt/dd pairs; scalars as one row.
   * @returns {HTMLElement}
   */
  function definitionBlock(title, value) {
    const box = el("div", "cfg-dl-block");
    box.append(el("h4", "cfg-dl-title", title));
    const list = el("dl", "cfg-dl");
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, entry] of Object.entries(value)) {
        list.append(el("dt", undefined, key));
        list.append(el("dd", undefined, displayValue(entry)));
      }
      if (Object.keys(value).length === 0) {
        list.append(el("dt", undefined, "—"));
        list.append(el("dd", undefined, "empty"));
      }
    } else {
      list.append(el("dt", undefined, title));
      list.append(el("dd", undefined, displayValue(value)));
    }
    box.append(list);
    return box;
  }

  /**
   * Render a POST /preview-route result: matched chains as definition lists
   * (workspace/layout/variables/analysis/outputs); ambiguous results list the
   * conflicting rule ids.
   * @param {object} result ConfigRoutePreview.
   * @returns {HTMLElement}
   */
  function renderRoutePreviewResult(result) {
    const box = el("div", "cfg-preview-result-body");
    if (result === null || typeof result !== "object") {
      box.append(el("div", "cfg-empty", "No result."));
      return box;
    }
    const status = typeof result.status === "string" ? result.status : "unknown";
    box.append(badge(status, status === "matched" ? "ok" : "warn"));
    if (status === "matched") {
      if (typeof result.routeRuleId === "string") box.append(definitionBlock("Route rule", result.routeRuleId));
      const workspace = typeof result.workspace === "string" ? result.workspace : "";
      const instance = typeof result.workspaceInstanceId === "string" ? ` (instance ${result.workspaceInstanceId})` : "";
      box.append(definitionBlock("Workspace", `${workspace}${instance}`));
      box.append(definitionBlock("Layout kind", result.layoutKind));
      box.append(definitionBlock("Layout", result.layout));
      if (result.variables !== undefined && result.variables !== null) {
        box.append(definitionBlock("Variables", result.variables));
      }
      box.append(definitionBlock("Analysis", result.analysis));
      box.append(definitionBlock("Outputs", result.outputs));
      if (typeof result.note === "string" && result.note.length > 0) {
        box.append(el("p", "cfg-field-note", result.note));
      }
      return box;
    }
    box.append(el("p", "cfg-field-note", typeof result.detail === "string" ? result.detail : "No matching route."));
    if (status === "ambiguous" && Array.isArray(result.candidates) && result.candidates.length > 0) {
      box.append(el("div", "cfg-field-note", "Conflicting rules:"));
      const list = el("ul", "cfg-candidates");
      for (const candidate of result.candidates) list.append(el("li", "mono", String(candidate)));
      box.append(list);
    }
    return box;
  }

  /**
   * Read-only legacy `outputs.routes` summary for the Routing page: default
   * route plus ordered rules, with a provenance note. Editing stays on the
   * Channels page globals section.
   * @param {object} options
   * @param {object|undefined} options.defaultRoute Legacy default route.
   * @param {readonly object[]} options.rules Ordered legacy rules.
   * @param {readonly string[]} options.sources Provenance sources (file/database/default).
   * @returns {HTMLElement}
   */
  function renderLegacyRoutesPanel(options) {
    const box = el("section", "cfg-panel cfg-legacy-routes");
    box.append(el("h3", "cfg-subtitle", "Legacy routes (outputs.routes)"));
    const sources = options.sources.length > 0 ? options.sources.join(", ") : "unknown";
    box.append(el("p", "cfg-field-note", `Effective merged view (source: ${sources}). Edit legacy routes on the Channels page.`));
    const table = el("table", "cfg-table");
    const head = el("thead");
    const headRow = el("tr");
    for (const label of ["Rule", "Trigger", "Target kind", "Line comments", "Summary"]) headRow.append(el("th", undefined, label));
    head.append(headRow);
    table.append(head);
    const body = el("tbody");
    const appendRoute = (label, route) => {
      const row = el("tr");
      const match = route !== null && typeof route === "object" ? route.match : undefined;
      const trigger = match !== null && typeof match === "object" && typeof match.trigger === "string" ? match.trigger : "(all triggers)";
      const targetKind = match !== null && typeof match === "object" && typeof match.target_kind === "string" ? match.target_kind : "(all kinds)";
      const channels = (key) => {
        const value = route !== null && typeof route === "object" ? route[key] : undefined;
        return Array.isArray(value) && value.length > 0 ? value.join(", ") : "—";
      };
      row.append(el("td", undefined, label), el("td", undefined, trigger), el("td", undefined, targetKind), el("td", undefined, channels("line_comments")), el("td", undefined, channels("summary")));
      body.append(row);
    };
    if (options.defaultRoute !== undefined) appendRoute("default", options.defaultRoute);
    options.rules.forEach((rule, index) => appendRoute(`#${index + 1}`, rule));
    table.append(body);
    box.append(table);
    return box;
  }

  /**
   * Read-only built-in asset list (Templates/Prompts pages): each asset shows
   * its document and offers "Copy as new database config".
   * @param {object} options
   * @param {string} options.title Section title.
   * @param {readonly object[]} options.assets Built-in assets ({id, name?, document}).
   * @param {(asset: object) => void} options.onCopy Copy handler.
   * @returns {HTMLElement}
   */
  function renderBuiltinAssets(options) {
    const box = el("section", "cfg-panel cfg-builtin-assets");
    box.append(el("h3", "cfg-subtitle", options.title));
    box.append(el("p", "cfg-field-note", "Built-in assets ship with the server and cannot be edited. Copy one to create a managed database override."));
    for (const asset of options.assets) {
      const details = el("details", "cfg-builtin-asset");
      const summary = el("summary", "cfg-builtin-asset-summary");
      const label = typeof asset.name === "string" && asset.name.length > 0 ? `${asset.id} — ${asset.name}` : String(asset.id);
      summary.append(el("span", "cfg-builtin-asset-id", label));
      const copy = /** @type {HTMLButtonElement} */ (el("button", "cfg-btn cfg-btn-ghost", "Copy as new database config"));
      copy.type = "button";
      copy.addEventListener("click", (event) => {
        event.preventDefault();
        options.onCopy(asset);
      });
      summary.append(copy);
      details.append(summary);
      const pre = el("pre", "cfg-builtin-asset-document");
      pre.textContent = typeof asset.document === "string" ? asset.document : "";
      details.append(pre);
      box.append(details);
    }
    return box;
  }

  return {
    renderField,
    renderSection,
    renderEntityTable,
    badge,
    errorBanner,
    confirmDialog,
    diffView,
    renderRoutePreviewPanel,
    renderRoutePreviewResult,
    renderLegacyRoutesPanel,
    renderBuiltinAssets,
    /**
     * @param {(parentField: object, itemField: object, value: unknown) => {options: readonly object[], error?: string}} resolver
     */
    setItemOptionsResolver(resolver) {
      itemOptionsResolver = resolver;
    },
  };
}
