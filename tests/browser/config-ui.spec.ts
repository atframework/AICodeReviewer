/**
 * P6 browser gate (A14/U-series): drives the management UI in Chromium against
 * the real CLI server (playwright.config.ts webServer → start-fixture.mjs).
 *
 * Selector contract (grounded against the live fixture, 2026-09-14):
 * - dashboard login: #username/#password/#login-form; tabs: .tab[data-tab]
 * - config shell: #config-nav button (page nav), #config-status (revision bar),
 *   #config-main (page body), #config-editor (drawer host, hidden until open)
 * - drawer: .cfg-drawer-title, fields [data-field-id="<page>:<path>"] with a
 *   single input/select/textarea control; optional fields start absent behind
 *   a "Set value" button; actions "Save"/"Cancel"/"Close"/
 *   "Copy as new database config"
 * - conflict: .cfg-panel-conflict with "Keep my changes and retry" /
 *   "Reload latest"
 */
import { test, expect, type Page, type Locator, type APIRequestContext } from "@playwright/test";

const ADMIN = { username: "admin", password: "browser-test-password" };

async function login(page: Page): Promise<void> {
  await page.goto("/dashboard");
  await page.fill("#username", ADMIN.username);
  await page.fill("#password", ADMIN.password);
  await page.click("#login-form button[type=submit]");
  await expect(page.locator(".tab[data-tab='config']")).toBeVisible();
}

async function openConfigTab(page: Page, navLabel?: string): Promise<void> {
  await page.click(".tab[data-tab='config']");
  await expect(page.locator("#config-nav button", { hasText: "Providers" })).toBeVisible();
  if (navLabel !== undefined) {
    await page.click(`#config-nav button:has-text("${navLabel}")`);
  }
}

async function bearerToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const token = localStorage.getItem("aicr_token");
    if (token === null) throw new Error("dashboard token missing");
    return token;
  });
}

async function apiLogin(request: APIRequestContext): Promise<string> {
  const response = await request.post("/api/admin/login", { data: ADMIN });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { token?: string };
  expect(typeof body.token).toBe("string");
  return body.token as string;
}

interface ConfigView {
  head: { activeRevision: number } | null;
  fileDigest: string;
}

test("kind-specific sections hide in file views, database drafts and channel views", async ({ page }) => {
  await login(page);
  await openConfigTab(page, "Triggers");
  const drawer = page.locator("#config-editor");
  await page.locator("#config-main tbody tr", { hasText: "git-main" }).getByRole("button", { name: "View", exact: true }).click();
  for (const field of ["trigger:port", "trigger:app.app_id", "trigger:repository_url"]) {
    const hiddenField = drawer.locator(`[data-field-id="${field}"]`);
    await expect(hiddenField).toHaveCount(1);
    await expect(hiddenField).toBeHidden();
  }
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "New trigger", exact: true }).click();
  await drawer.locator("#cfg-drawer-kind").selectOption("p4");
  for (const field of ["trigger:app.app_id", "trigger:base_url", "trigger:repository_url"]) {
    const hiddenField = drawer.locator(`[data-field-id="${field}"]`);
    await expect(hiddenField).toHaveCount(1);
    await expect(hiddenField).toBeHidden();
    const section = drawer.locator("details.cfg-section", { has: page.locator(`[data-field-id="${field}"]`) });
    await expect(section).toHaveCount(1);
    await expect(section).toBeHidden();
  }
  await cancelDrawerAndDiscard(page);
  await openConfigTab(page, "Channels");
  await page.locator("#config-main tbody tr", { hasText: "pr-comments" }).getByRole("button", { name: "View", exact: true }).click();
  await expect(drawer.locator('[data-field-id="channel:issue_mode"]')).toBeHidden();
  await expect(drawer.locator('[data-field-id="channel:webhook_url"]')).toBeHidden();
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
});

test("Overview is the landing page after login and reload, and Live remains available", async ({ page }) => {
  const liveRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/runs/live")) liveRequests.push(request.url());
  });
  await login(page);
  await expect(page.locator("#tab-overview")).toBeVisible();
  await expect(page.locator(".tab.active")).toHaveAttribute("data-tab", "overview");
  await expect(page.locator("#tab-live")).toBeHidden();
  await expect(page.locator("#refresh-indicator")).toContainText("Updated");
  expect(liveRequests).toHaveLength(0);
  await page.click(".tab[data-tab='live']");
  await expect(page.locator("#tab-live")).toBeVisible();
  await expect.poll(() => liveRequests.length).toBe(1);
  liveRequests.length = 0;
  await page.reload();
  await expect(page.locator("#tab-overview")).toBeVisible();
  await expect(page.locator("#tab-live")).toBeHidden();
  await expect(page.locator("#refresh-indicator")).toContainText("Updated");
  expect(liveRequests).toHaveLength(0);
});

test("Runs, Events and Queue request server pages and stop at the last page", async ({ page }) => {
  for (const [tab, endpoint] of [["runs", "runs"], ["events", "events"], ["queue", "auto-commit/batches"]]) {
    await page.route(`**/api/admin/${endpoint}?*`, async route => {
      const params = new URL(route.request().url()).searchParams;
      expect(params.get("limit")).toBe("20");
      const current = Number(params.get("page"));
      const items = Array.from({ length: current === 1 ? 20 : 1 }, (_, index) => ({
        id: `${tab}-${current}-${index}`, batchId: `${tab}-${current}-${index}`, workspaceId: `workspace-page-${current}`,
        triggerName: "test", status: "completed", decision: "queued", eventName: "push", members: [],
        createdAt: Date.now(), receivedAt: new Date().toISOString(), startedAt: new Date().toISOString(),
      }));
      await route.fulfill({ json: { items, page: current, hasMore: current === 1 } });
    });
  }
  await login(page);
  for (const tab of ["runs", "events", "queue"]) {
    await page.click(`.tab[data-tab='${tab}']`);
    await expect(page.locator(`#${tab}-table tr`)).toHaveCount(20);
    await expect(page.locator(`#${tab}-prev`)).toBeDisabled();
    await page.click(`#${tab}-next`);
    await expect(page.locator(`#${tab}-table tr`)).toHaveCount(1);
    await expect(page.locator(`#${tab}-table`)).toContainText("workspace-page-2");
    await expect(page.locator(`#${tab}-next`)).toBeDisabled();
    await page.click(`#${tab}-prev`);
    await expect(page.locator(`#${tab}-table tr`)).toHaveCount(20);
  }
});

test("P6 regression: config tab can be reopened", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await login(page);
  await openConfigTab(page);
  await page.click(".tab[data-tab='overview']");
  await openConfigTab(page);
  expect(errors).toEqual([]);
});

test("P6 regression: switching config pages closes the drawer and confirms dirty drafts", async ({ page }) => {
  await login(page);
  await openConfigTab(page);
  const drawer = page.locator("#config-editor");

  await expect(page).toHaveTitle("AICodeReviewer Admin");
  await expect(page.locator(".header h1")).toHaveText("AICodeReviewer Admin");
  await page.locator("#config-main tbody tr", { hasText: "file-llm" }).getByRole("button", { name: "View", exact: true }).click();
  await expect(drawer.locator(".cfg-drawer-title")).toHaveText("View file-llm");
  await page.locator("#config-nav").getByRole("button", { name: "Triggers", exact: true }).click();
  await expect(drawer).toBeHidden();
  for (const heading of ["View file-llm", "Kind-specific", "Catalog metadata", "Request overrides"]) {
    await expect(page.getByText(heading, { exact: true })).toHaveCount(0);
  }
  await page.locator("#config-nav").getByRole("button", { name: "Providers", exact: true }).click();

  // Create a provider so a record row exists.
  await page.getByRole("button", { name: "New provider", exact: true }).click();
  await drawer.locator("#cfg-drawer-kind").selectOption("ollama");
  await setTextField(drawer, "provider:id", "drawer-leak-provider");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).toBeHidden();

  // A clean drawer (and its provider-specific sections) closes on page switch.
  // Kind-specific fields only exist for vertex/bedrock/google/anthropic kinds,
  // so an ollama drawer hides that section entirely; Catalog metadata stays.
  await page.locator("#config-main tbody tr", { hasText: "drawer-leak-provider" }).getByRole("button", { name: "Edit", exact: true }).click();
  await expect(drawer.locator(".cfg-drawer-title")).toHaveText("Edit drawer-leak-provider");
  await expect(drawer.getByText("Kind-specific", { exact: true })).toBeHidden();
  await expect(drawer.getByText("Catalog metadata", { exact: true })).toBeVisible();
  await page.locator("#config-nav").getByRole("button", { name: "Triggers", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator(".cfg-dialog")).toHaveCount(0);
  await expect(page.locator("#config-nav button.cfg-active")).toHaveText("Triggers");

  // A dirty drawer holds the switch behind a discard confirmation.
  await page.locator("#config-nav").getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("button", { name: "New provider", exact: true }).click();
  await setTextField(drawer, "provider:id", "dirty-provider");
  await page.click(".tab[data-tab='overview']");
  await expect(drawer).toBeHidden();
  await openConfigTab(page);
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-field-id="provider:id"] input')).toHaveValue("dirty-provider");
  await page.locator("#config-nav").getByRole("button", { name: "Triggers", exact: true }).click();
  const dialog = page.locator(".cfg-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Discard unsaved changes?");
  // Cancel keeps the current page and the draft.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".cfg-dialog")).toHaveCount(0);
  await expect(drawer.locator(".cfg-drawer-title")).toHaveText("New provider");
  await expect(page.locator("#config-nav button.cfg-active")).toHaveText("Providers");
  // Discard closes the drawer and lands on the requested page.
  await page.locator("#config-nav").getByRole("button", { name: "Triggers", exact: true }).click();
  await page.locator(".cfg-dialog").getByRole("button", { name: "Discard", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator("#config-nav button.cfg-active")).toHaveText("Triggers");
});

test("Agent page offers the built-in direct LLM mode", async ({ page }) => {
  await login(page);
  await openConfigTab(page, "Agent");
  const row = await ensureFieldVisible(page, "agent:default");
  await row.getByRole("button", { name: "Set value" }).click();
  const select = row.locator("select");
  await expect(select.locator('option[value="native-llm"]')).toHaveCount(1);
  await select.selectOption("native-llm");
  await expect(select).toHaveValue("native-llm");
});

test("search credentials can be edited as masked literals and removed", async ({ page, request }) => {
  const token = await apiLogin(request);
  const before = await apiView(request, token);
  const seeded = await request.post("/api/admin/config/changesets", { headers: { Authorization: `Bearer ${token}` }, data: {
    baseRevision: before.head?.activeRevision ?? null, fileDigest: before.fileDigest, operationId: "search-literal-seed",
    operations: [{ op: "set", path: ["agent", "web_search", "credentials"], value: { exa: { value: "browser-search-secret" } } }],
  } });
  expect(seeded.status()).toBe(200);
  await login(page);
  await openConfigTab(page, "Agent");
  const field = page.locator('[data-field-id="agent:web_search.credentials.*"]');
  await field.evaluate(node => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true; });
  await expect(field.locator('input[type="password"]')).toHaveValue("");
  await field.locator('input[type="password"]').fill("replacement-search-secret");
  await page.getByRole("button", { name: "Save page changes", exact: true }).click();
  await expect(page.locator("#config-status")).toContainText("Saved as revision");
  await page.reload();
  await openConfigTab(page, "Agent");
  await field.evaluate(node => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true; });
  await expect(field.locator('input[type="password"]')).toHaveValue("");
  await field.getByRole("button", { name: "Remove entry", exact: true }).click();
  await page.getByRole("button", { name: "Save page changes", exact: true }).click();
  await expect(page.locator("#config-status")).toContainText("Saved as revision");
  const view = await (await request.get("/api/admin/config", { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(view.globals.agent.web_search.credentials).toEqual({});
});

test("literal provider keys survive unrelated edits and can be replaced or removed", async ({ page, request }) => {
  await login(page);
  await openConfigTab(page);
  const drawer = page.locator("#config-editor");
  const secret = drawer.locator('[data-field-id="provider:api_key"]');
  await page.getByRole("button", { name: "New provider", exact: true }).click();
  await setTextField(drawer, "provider:id", "literal-provider");
  await setTextField(drawer, "provider:api_key", "browser-literal-key");
  await expect(secret.locator("input")).toHaveAttribute("type", "password");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).toBeHidden();
  const edit = async () => {
    await page.locator("#config-main tbody tr", { hasText: "literal-provider" }).getByRole("button", { name: "Edit", exact: true }).click();
    await expect(secret.locator("input")).toHaveValue("");
    await expect(secret.locator("input")).toHaveAttribute("placeholder", "(set — never displayed)");
  };
  await edit();
  await setTextField(drawer, "provider:base_url", "http://127.0.0.1:9/v1");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).toBeHidden();
  await edit();
  await secret.locator("input").fill("replacement-literal-key");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).toBeHidden();
  await edit();
  await secret.getByRole("button", { name: "Clear stored value", exact: true }).click();
  await expect(secret).toContainText("Empty after editing removes the stored value.");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).toBeHidden();
  const response = await request.get("/api/admin/config", { headers: { authorization: `Bearer ${await bearerToken(page)}` } });
  const view = await response.json();
  const record = view.collections.provider.records.find((entry: { name: string }) => entry.name === "literal-provider");
  expect(record.value).not.toHaveProperty("api_key");
  expect(JSON.stringify(view)).not.toContain("browser-literal-key");
  expect(JSON.stringify(view)).not.toContain("replacement-literal-key");
});

test("P6 regression: staged provider and model group publish atomically and row edits persist", async ({ page, request }) => {
  await login(page);
  await openConfigTab(page);
  const token = await bearerToken(page);
  const before = await apiView(request, token);
  const drawer = page.locator("#config-editor");
  await page.getByRole("button", { name: "New provider", exact: true }).click();
  await drawer.locator("#cfg-drawer-kind").selectOption("ollama");
  await setTextField(drawer, "provider:id", "staged-ollama");
  await drawer.getByRole("button", { name: "Stage changes", exact: true }).click();
  expect((await apiView(request, token)).head).toEqual(before.head);
  await page.locator("#config-nav").getByRole("button", { name: "Model groups", exact: true }).click();
  await page.getByRole("button", { name: "New model group", exact: true }).click();
  await setTextField(drawer, "model_group:$name", "staged-group");
  await drawer.getByRole("button", { name: "Add Model entries row", exact: true }).click();
  await drawer.locator('[data-field-id="model_group:entries[].provider"] select').selectOption("staged-ollama");
  await setTextField(drawer, "model_group:entries[].model", "model-one");
  await drawer.locator('[data-field-id="model_group:entries[].role"] select').selectOption("any");
  await setTextField(drawer, "model_group:entries[].overrides.seed", "7");
  await drawer.getByRole("button", { name: "Stage changes", exact: true }).click();
  expect((await apiView(request, token)).head).toEqual(before.head);
  await page.getByRole("button", { name: "Publish staged changes", exact: true }).click();
  await expect.poll(async () => (await apiView(request, token)).head?.activeRevision).toBe((before.head?.activeRevision ?? 0) + 1);
  await page.locator("#config-main tbody tr", { hasText: "staged-group" }).getByRole("button", { name: "Edit", exact: true }).click();
  await expect(drawer.locator('[data-field-id="model_group:entries[].model"] input')).toHaveValue("model-one");
  await expect(drawer.locator('[data-field-id="model_group:entries[].overrides.seed"] input')).toHaveValue("7");
  const response = await request.get("/api/admin/config", { headers: { Authorization: `Bearer ${token}` } });
  const view = await response.json();
  expect(view.collections.model_group.records.find((record: { name: string }) => record.name === "staged-group").value)
    .toEqual([{ provider: "staged-ollama", model: "model-one", role: "any", overrides: { seed: 7 } }]);
});

test("P6 regression: repeated staging preserves entity edits and one atomic publication", async ({ page, request }) => {
  const token = await apiLogin(request);
  const initial = await apiView(request, token);
  const created = await request.post("/api/admin/config/changesets", { headers: { Authorization: `Bearer ${token}` }, data: {
    baseRevision: initial.head?.activeRevision ?? null, fileDigest: initial.fileDigest, operationId: "stage-repeat-create",
    operations: [{ op: "create", collection: "providers", record: { id: "stage-repeat", name: "stage-repeat", enabled: true,
      value: { id: "stage-repeat", kind: "ollama", timeout_ms: 1000 } } }],
  } });
  expect(created.status()).toBe(200);
  await login(page);
  await openConfigTab(page);
  const before = await apiView(request, token);
  const drawer = page.locator("#config-editor");
  const edit = () => page.locator("#config-main tbody tr", { hasText: "stage-repeat" })
    .getByRole("button", { name: "Edit", exact: true }).click();
  await edit();
  await setTextField(drawer, "provider:timeout_ms", "24000");
  await drawer.getByRole("button", { name: "Stage changes", exact: true }).click();
  await edit();
  await setTextField(drawer, "provider:max_retries", "3");
  await drawer.getByRole("button", { name: "Stage changes", exact: true }).click();
  expect((await apiView(request, token)).head).toEqual(before.head);
  await page.getByRole("button", { name: "Publish staged changes", exact: true }).click();
  await expect(page.locator("#config-status")).toContainText("Saved as revision");
  const response = await request.get("/api/admin/config", { headers: { Authorization: `Bearer ${token}` } });
  const view = await response.json();
  expect(view.head.activeRevision).toBe(before.head!.activeRevision + 1);
  expect(view.collections.provider.records.find((record: { id: string }) => record.id === "stage-repeat").value)
    .toMatchObject({ timeout_ms: 24000, max_retries: 3 });
});

test("P6 regression: restaging globals can revert a field and discard the remaining draft", async ({ page, request }) => {
  const token = await apiLogin(request);
  const initial = await apiView(request, token);
  const seeded = await request.post("/api/admin/config/changesets", { headers: { Authorization: `Bearer ${token}` }, data: {
    baseRevision: initial.head?.activeRevision ?? null, fileDigest: initial.fileDigest, operationId: "stage-globals-seed",
    operations: [{ op: "set", path: ["review", "max_files"], value: 55 },
      { op: "set", path: ["review", "output_language"], value: "en-US" }],
  } });
  expect(seeded.status()).toBe(200);
  await login(page);
  await openConfigTab(page, "Review");
  const before = await apiView(request, token);
  const main = page.locator("#config-main");
  const stage = () => main.getByRole("button", { name: "Stage page changes", exact: true }).click();
  await ensureFieldVisible(page, "review:max_files");
  await setTextField(main, "review:max_files", "56");
  await stage();
  await main.locator('[data-field-id="review:output_language"] select').selectOption("zh-CN");
  await stage();
  await setTextField(main, "review:max_files", "55");
  await stage();
  expect((await apiView(request, token)).head).toEqual(before.head);
  await page.getByRole("button", { name: "Publish staged changes", exact: true }).click();
  await expect(page.locator("#config-status")).toContainText("Saved as revision");
  const response = await request.get("/api/admin/config", { headers: { Authorization: `Bearer ${token}` } });
  const view = await response.json();
  expect(view.head.activeRevision).toBe(before.head!.activeRevision + 1);
  expect(view.globals.review).toMatchObject({ max_files: 55, output_language: "zh-CN" });
  await setTextField(main, "review:max_files", "57");
  await stage();
  await page.getByRole("button", { name: "Discard staged changes", exact: true }).click();
  await expect(main.locator('[data-field-id="review:max_files"] input')).toHaveValue("55");
  expect((await apiView(request, token)).head?.activeRevision).toBe(view.head.activeRevision);
});

test("P6 regression: nested weekly windows and multiple weekdays survive consecutive edits", async ({ page, request }) => {
  await login(page);
  await openConfigTab(page, "Review");
  const rules = await ensureFieldVisible(page, "review:pull_request.schedule.rules");
  await rules.getByRole("button", { name: "Set value", exact: true }).click();
  await rules.getByRole("button", { name: "Add Rules row", exact: true }).click();
  const days = rules.locator('[data-field-id="review:pull_request.schedule.rules[].days"]');
  await days.getByRole("button", { name: "Set value", exact: true }).click();
  await days.getByRole("checkbox", { name: "mon", exact: true }).check();
  await days.getByRole("checkbox", { name: "tue", exact: true }).check();
  const windows = rules.locator('[data-field-id="review:pull_request.schedule.rules[].windows"]');
  await windows.getByRole("button", { name: "Set value", exact: true }).click();
  await windows.getByRole("button", { name: "Add Windows row", exact: true }).click();
  await setTextField(windows, "review:pull_request.schedule.rules[].windows[].start", "09:00");
  await setTextField(windows, "review:pull_request.schedule.rules[].windows[].end", "10:00");
  await windows.getByRole("button", { name: "Add Windows row", exact: true }).click();
  const rows = windows.locator(":scope > .cfg-field-head ~ .cfg-olist > ol > li");
  // Scope the second window independently; editing it must retain the first.
  const second = rows.nth(1);
  await setTextField(second, "review:pull_request.schedule.rules[].windows[].start", "14:00");
  await setTextField(second, "review:pull_request.schedule.rules[].windows[].end", "15:00");
  await page.locator("#config-main").getByRole("button", { name: "Save page changes", exact: true }).click();
  await expect(page.locator("#config-status")).toContainText("Saved as revision");
  const token = await bearerToken(page);
  const response = await request.get("/api/admin/config", { headers: { Authorization: `Bearer ${token}` } });
  expect((await response.json()).globals.review.pull_request.schedule.rules).toEqual([
    { days: ["mon", "tue"], windows: [{ start: "09:00", end: "10:00" }, { start: "14:00", end: "15:00" }] },
  ]);
});

test("P6 regression: free-form include patterns can be entered and saved", async ({ page }) => {
  await login(page);
  await openConfigTab(page, "Review");
  const include = await ensureFieldVisible(page, "review:include");
  const set = include.getByRole("button", { name: "Set value", exact: true });
  if (await set.count()) await set.click();
  await include.locator("textarea").fill("src/**/*.ts\nlib/**/*.js");
  await page.locator("#config-main").getByRole("button", { name: "Save page changes", exact: true }).click();
  await expect(include.locator("textarea")).toHaveValue("src/**/*.ts\nlib/**/*.js");
  await expect(page.locator("#config-status")).toContainText("Saved as revision");
});

test("P6 regression: activation pending disables another save and preserves its status", async ({ page }) => {
  await login(page);
  await openConfigTab(page, "Review");
  await page.route("**/api/admin/config/changesets", route => route.fulfill({ status: 202, json: { status: "committed_activating", revision: { revision: 999 } } }));
  const row = await ensureFieldVisible(page, "review:max_files");
  const set = row.getByRole("button", { name: "Set value", exact: true });
  if (await set.count()) await set.click();
  await row.locator("input").fill("47");
  const save = page.locator("#config-main").getByRole("button", { name: "Save page changes", exact: true });
  await save.click();
  await expect(page.locator("#config-main")).toContainText("Stored, activation pending");
  await expect(save).toBeDisabled();
  await expect(page.locator("#config-status")).not.toContainText("new tasks use it now");
});

test("P6 regression: invalid numeric input blocks a save until corrected", async ({ page }) => {
  await login(page);
  await openConfigTab(page, "Review");
  const row = await ensureFieldVisible(page, "review:max_files");
  await setTextField(page.locator("#config-main"), "review:max_files", "51");
  await row.locator("input").fill("invalid");
  let saves = 0;
  page.on("request", request => { if (request.url().endsWith("/changesets")) saves += 1; });
  await page.getByRole("button", { name: "Save page changes", exact: true }).click();
  await expect(page.locator("#config-main")).toContainText("Correct the invalid field values");
  expect(saves).toBe(0);
  await row.locator("input").fill("52");
  await page.getByRole("button", { name: "Save page changes", exact: true }).click();
  await expect(page.locator("#config-status")).toContainText("Saved as revision");
  expect(saves).toBe(1);
});

test("P6 regression: response loss retries exactly the original changeset", async ({ page }) => {
  await login(page);
  await openConfigTab(page, "Review");
  const payloads: unknown[] = [];
  await page.route("**/api/admin/config/changesets", async route => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) await route.abort();
    else await route.continue();
  });
  await ensureFieldVisible(page, "review:max_files");
  await setTextField(page.locator("#config-main"), "review:max_files", "53");
  await page.getByRole("button", { name: "Save page changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resubmit", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect(page.locator("#config-status")).toContainText("Saved as revision");
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
});

test("P6 regression: saving another page cannot advance a dirty draft's revision", async ({ page }) => {
  await login(page);
  await openConfigTab(page, "Review");
  await ensureFieldVisible(page, "review:max_files");
  await setTextField(page.locator("#config-main"), "review:max_files", "54");
  await page.locator("#config-nav").getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("button", { name: "New provider", exact: true }).click();
  const drawer = page.locator("#config-editor");
  await drawer.locator("#cfg-drawer-kind").selectOption("ollama");
  await setTextField(drawer, "provider:id", "cross-page-provider");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).toBeHidden();
  await page.locator("#config-nav").getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "Save page changes", exact: true }).click();
  await expect(page.locator(".cfg-panel-conflict")).toContainText("Revision conflict");
  await expect(page.locator('[data-field-id="review:max_files"] input')).toHaveValue("54");
});

test("P6 regression: a lost restore response retries the same request and refreshes history", async ({ page }) => {
  await login(page);
  await openConfigTab(page);
  await page.getByRole("button", { name: "New provider", exact: true }).click();
  const drawer = page.locator("#config-editor");
  await drawer.locator("#cfg-drawer-kind").selectOption("ollama");
  await setTextField(drawer, "provider:id", "restore-retry-provider");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).toBeHidden();
  const payloads: { baseRevision: number }[] = [];
  await page.route("**/api/admin/config/revisions/*/restore", async route => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) await route.abort();
    else await route.continue();
  });
  await page.locator("#config-nav").getByRole("button", { name: "Versions", exact: true }).click();
  await page.locator("#config-main tbody tr").first().getByRole("button", { name: "Restore", exact: true }).click();
  await page.locator(".cfg-dialog").getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect(page.locator("#config-status")).toContainText("Saved as revision");
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
  await expect(page.locator("#config-main tbody tr").first().locator("td").first()).toHaveText(String(payloads[0]!.baseRevision + 1));
});

test("P6 regression: template completion and staged routing preview use runtime semantics without publishing", async ({ page, request }) => {
  await login(page);
  await openConfigTab(page, "Workspaces");
  const token = await bearerToken(page);
  const before = await apiView(request, token);
  const drawer = page.locator("#config-editor");
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await setTextField(drawer, "workspace:$name", "preview-workspace");
  await drawer.locator('[data-field-id="workspace:work_path"]').getByRole("button", { name: "Override", exact: true }).click();
  await setTextField(drawer, "workspace:work_path", "{{git.rep");
  await drawer.getByRole("option").filter({ hasText: "git.repository" }).click();
  await expect(drawer.locator('[data-field-id="workspace:work_path"] input')).toHaveValue("{{segment git.repository}}");
  const match = drawer.locator('[data-field-id="workspace:match"]');
  const matchSection = drawer.locator('details:has([data-field-id="workspace:match"])');
  if (await matchSection.getAttribute("open") === null) await matchSection.locator("summary").click();
  await match.getByRole("button", { name: "Override", exact: true }).click();
  await match.getByRole("button", { name: "Add Match row", exact: true }).click();
  const triggers = match.locator('[data-field-id="workspace:match[].triggers"]');
  await triggers.getByRole("button", { name: "Set value", exact: true }).click();
  await triggers.getByRole("checkbox", { name: "git-preview", exact: true }).check();
  await drawer.getByRole("button", { name: "Stage changes", exact: true }).click();
  await page.locator("#config-nav").getByRole("button", { name: "Routing", exact: true }).click();
  await page.getByRole("button", { name: "New route", exact: true }).click();
  await setTextField(drawer, "route:id", "preview-route");
  const workspace = drawer.locator('[data-field-id="route:workspace"]');
  await workspace.locator("select").selectOption("preview-workspace");
  await drawer.getByRole("button", { name: "Stage changes", exact: true }).click();
  await page.locator("#cfg-preview-repo-ref").fill("acme/app");
  await page.locator("#cfg-preview-trigger").selectOption("git-preview");
  const previewRequest = page.waitForRequest(request => request.url().endsWith("/preview-route"));
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  expect((await previewRequest).postDataJSON().draft.operations[0]).toMatchObject({ record: { value: {
    match: [{ triggers: ["git-preview"] }], work_path: "{{segment git.repository}}",
  } } });
  await expect(page.locator(".cfg-preview-result")).toContainText("preview-workspace");
  await expect(page.locator(".cfg-preview-result")).toContainText("preview-route");
  expect((await apiView(request, token)).head).toEqual(before.head);
});

async function apiView(request: APIRequestContext, token: string): Promise<ConfigView> {
  const response = await request.get("/api/admin/config", { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200);
  return (await response.json()) as ConfigView;
}

async function apiStatusRevision(request: APIRequestContext, token: string): Promise<number | null> {
  const response = await request.get("/api/admin/config/status", { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { manager?: { databaseRevision?: number | null } };
  return body.manager?.databaseRevision ?? null;
}

/** Fill a drawer/globals field, opening the "Set value" absent state first. */
async function setTextField(host: Locator, fieldId: string, value: string): Promise<void> {
  const row = host.locator(`[data-field-id="${fieldId}"]`);
  const control = row.locator("input,textarea").first();
  if ((await control.count()) === 0 || !(await control.isVisible())) {
    await row.getByRole("button", { name: "Set value" }).click();
  }
  await row.locator("input,textarea").first().fill(value);
}

/** Expand the collapsible <details> section containing a field (spec sections may start collapsed). */
async function ensureFieldVisible(page: Page, fieldId: string): Promise<Locator> {
  const row = page.locator(`#config-main [data-field-id="${fieldId}"]`);
  await row.waitFor({ state: "attached" });
  const section = page.locator(`#config-main details:has([data-field-id="${fieldId}"])`).first();
  if ((await section.count()) > 0 && (await section.getAttribute("open")) === null) {
    await section.locator("summary").first().click();
  }
  return row;
}

async function saveDrawerAndWaitRevision(page: Page, request: APIRequestContext, previousHead: number | null): Promise<number> {
  const drawer = page.locator("#config-editor");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  const token = await bearerToken(page);
  await expect
    .poll(async () => apiStatusRevision(request, token), { message: "published revision should reach the runtime manager" })
    .toBe((previousHead ?? 0) + 1);
  await expect(drawer).toBeHidden();
  return (previousHead ?? 0) + 1;
}

/** Cancel a drawer; a dirty draft raises the discard confirmation first. */
async function cancelDrawerAndDiscard(page: Page): Promise<void> {
  const drawer = page.locator("#config-editor");
  await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
  const dialog = page.locator(".cfg-dialog");
  if ((await dialog.count()) > 0) {
    await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  }
  await expect(drawer).toBeHidden();
}

test.describe.serial("config management UI (P6 browser gate)", () => {
  test("config tab loads with page navigation and the revision status bar", async ({ page }) => {
    await login(page);
    await openConfigTab(page);
    const nav = page.locator("#config-nav");
    for (const label of ["Providers", "Model groups", "Triggers", "Channels", "Routing", "Agent", "Review", "Workspaces", "Queue", "Advanced", "Versions"]) {
      await expect(nav.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    const status = page.locator("#config-status");
    await expect(status).toContainText("namespace browser-test");
    await expect(status).toContainText("file ");
    // Providers page: the file-owned record shows source/state badges.
    const row = page.locator("#config-main tbody tr", { hasText: "file-llm" });
    await expect(row).toContainText("file");
    await expect(row).toContainText("enabled");
    await expect(row).toContainText("readonly");
  });

  test("file-owned provider is read-only with provenance and copy-as-new flow", async ({ page }) => {
    await login(page);
    await openConfigTab(page);
    const drawer = page.locator("#config-editor");
    await page.locator("#config-main tbody tr", { hasText: "file-llm" }).getByRole("button", { name: "View" }).click();
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("View file-llm");
    // U16: file source renders the record read-only — every control disabled.
    const controls = drawer.locator("[data-field-id] input, [data-field-id] select, [data-field-id] textarea");
    expect(await controls.count()).toBeGreaterThan(0);
    for (const control of await controls.all()) {
      await expect(control).toBeDisabled();
    }
    await expect(drawer.getByRole("button", { name: "Save" })).toHaveCount(0);
    // D-contract: copy as new database config → editable create draft.
    await drawer.getByRole("button", { name: "Copy as new database config" }).click();
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("New database config (copied from file-llm)");
    const idInput = drawer.locator('[data-field-id="provider:id"] input');
    await expect(idInput).toBeEnabled();
    await expect(idInput).toHaveValue("");
    // The copied base URL is prefilled but the new id must be chosen explicitly.
    await drawer.getByRole("button", { name: "Cancel" }).click();
    // Dirty drafts confirm before discarding.
    const discard = page.locator(".cfg-dialog", { hasText: "Discard unsaved changes?" });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Discard" }).click();
    await expect(drawer).toBeHidden();
  });

  test("E03: copy-as-new of a file-owned provider saves as a database record", async ({ page, request }) => {
    await login(page);
    await openConfigTab(page);
    const drawer = page.locator("#config-editor");
    await page.locator("#config-main tbody tr", { hasText: "file-llm" }).getByRole("button", { name: "View" }).click();
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("View file-llm");
    await drawer.getByRole("button", { name: "Copy as new database config" }).click();
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("New database config (copied from file-llm)");
    // The id must be chosen explicitly; base URL and env reference carry over.
    const idInput = drawer.locator('[data-field-id="provider:id"] input');
    await expect(idInput).toBeEnabled();
    await expect(idInput).toHaveValue("");
    await expect(drawer.locator('[data-field-id="provider:base_url"] input')).toHaveValue("http://127.0.0.1:9/v1");
    await expect(drawer.locator('[data-field-id="provider:api_key_env"] input')).toHaveValue("AICR_BROWSER_LLM_KEY");
    await idInput.fill("copied-llm");
    await drawer.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#config-status")).toContainText("Saved as revision");
    await expect(drawer).toBeHidden();
    // The copy landed as a database-sourced record (fail-closed grant in the fixture).
    const token = await bearerToken(page);
    const response = await request.get("/api/admin/config", { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status()).toBe(200);
    const view = await response.json();
    const copied = view.collections.provider.records.find((record: { name: string }) => record.name === "copied-llm");
    expect(copied).toMatchObject({ source: "database", readonly: false });
    expect(copied.value).toMatchObject({
      id: "copied-llm", kind: "openai_compatible",
      base_url: "http://127.0.0.1:9/v1", api_key_env: "AICR_BROWSER_LLM_KEY",
    });
    // The file-owned original is untouched: badges and the read-only View drawer.
    const row = page.locator("#config-main tbody tr", { hasText: "file-llm" });
    await expect(row).toContainText("file");
    await expect(row).toContainText("readonly");
    await row.getByRole("button", { name: "View" }).click();
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("View file-llm");
    const controls = drawer.locator("[data-field-id] input, [data-field-id] select, [data-field-id] textarea");
    expect(await controls.count()).toBeGreaterThan(0);
    for (const control of await controls.all()) {
      await expect(control).toBeDisabled();
    }
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toBeHidden();
  });

  test("provider CRUD publishes revisions that take effect immediately", async ({ page, request }) => {
    await login(page);
    await openConfigTab(page);
    const drawer = page.locator("#config-editor");
    const token = await bearerToken(page);
    const headBefore = await apiStatusRevision(request, token);

    // Create (the fixture declares a fail-closed secret_refs grant for exactly
    // this id/destination pair).
    await page.getByRole("button", { name: "New provider" }).click();
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("New provider");
    // Create drafts start enabled with the first kind preselected (U14).
    await expect(drawer.locator("#cfg-drawer-kind")).toHaveValue("openai_compatible");
    await setTextField(drawer, "provider:id", "db-provider");
    await setTextField(drawer, "provider:base_url", "http://127.0.0.1:9/v1");
    await setTextField(drawer, "provider:api_key_env", "AICR_BROWSER_LLM_KEY");
    const rev1 = await saveDrawerAndWaitRevision(page, request, headBefore);
    const row = page.locator("#config-main tbody tr", { hasText: "db-provider" });
    await expect(row).toContainText("database");

    // Edit: set a numeric timeout (not a destination field → grant unaffected).
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("Edit db-provider");
    await setTextField(drawer, "provider:timeout_ms", "45000");
    const rev2 = await saveDrawerAndWaitRevision(page, request, rev1);
    void rev2;

    // Disable / enable are one-changeset immediate actions.
    await row.getByRole("button", { name: "Disable" }).click();
    await expect(row).toContainText("disabled");
    await row.getByRole("button", { name: "Enable" }).click();
    await expect(row).not.toContainText("disabled");

    // Delete with explicit confirmation.
    page.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "Delete" }).click();
    const confirm = page.locator(".cfg-dialog, [role='dialog'], .cfg-panel", { hasText: "Delete db-provider" });
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#config-main tbody tr", { hasText: "db-provider" })).toHaveCount(0);
  });

  test("revision conflict keeps the draft and rebase-retry publishes it", async ({ page, request, browser }) => {
    await login(page);
    await openConfigTab(page);
    const drawer = page.locator("#config-editor");
    // Arrange: a database provider to edit.
    await page.getByRole("button", { name: "New provider" }).click();
    await setTextField(drawer, "provider:id", "db-provider");
    await setTextField(drawer, "provider:base_url", "http://127.0.0.1:9/v1");
    await setTextField(drawer, "provider:api_key_env", "AICR_BROWSER_LLM_KEY");
    const token = await bearerToken(page);
    const head0 = await apiStatusRevision(request, token);
    const rev1 = await saveDrawerAndWaitRevision(page, request, head0);

    // Open the edit drawer (captures baseRevision = rev1 in the draft).
    await page.locator("#config-main tbody tr", { hasText: "db-provider" }).getByRole("button", { name: "Edit" }).click();
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("Edit db-provider");
    await setTextField(drawer, "provider:timeout_ms", "30000");

    // Concurrent writer moves the head via the API (second client).
    const token2 = await apiLogin(request);
    const view = await apiView(request, token2);
    const concurrent = await request.post("/api/admin/config/changesets", {
      headers: { Authorization: `Bearer ${token2}` },
      data: {
        baseRevision: rev1,
        fileDigest: view.fileDigest,
        operationId: `conflict-${Date.now()}`,
        operations: [
          { op: "update", collection: "providers", recordId: "db-provider", value: { id: "db-provider", kind: "openai_compatible", base_url: "http://127.0.0.1:9/v1", api_key_env: "AICR_BROWSER_LLM_KEY", timeout_ms: 99000 } },
        ],
      },
    });
    expect(concurrent.status()).toBe(200);

    // The stale drawer save conflicts: the draft is preserved with a diff.
    await drawer.getByRole("button", { name: "Save", exact: true }).click();
    const conflict = drawer.locator(".cfg-panel-conflict");
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText("Revision conflict");
    await expect(conflict).toContainText("Your draft is preserved");
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("Edit db-provider");

    // Rebase-and-retry with the same operation id publishes the draft.
    await conflict.getByRole("button", { name: "Keep my changes and retry" }).click();
    await expect.poll(async () => apiStatusRevision(request, token)).toBe(rev1 + 2);
    await expect(drawer).toBeHidden();

    // Cleanup.
    page.once("dialog", (dialog) => void dialog.accept());
    await page.locator("#config-main tbody tr", { hasText: "db-provider" }).getByRole("button", { name: "Delete" }).click();
    const confirm = page.locator(".cfg-dialog, [role='dialog'], .cfg-panel", { hasText: "Delete db-provider" });
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#config-main tbody tr", { hasText: "db-provider" })).toHaveCount(0);
    void browser;
  });

  test("provider preset prefills a new provider draft and stays editable", async ({ page, request }) => {
    await login(page);
    await openConfigTab(page);
    const drawer = page.locator("#config-editor");

    await page.getByRole("button", { name: "New provider" }).click();
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("New provider");
    const picker = drawer.locator("#cfg-provider-preset");
    await expect(picker).toBeVisible();
    await expect(picker.locator("option", { hasText: "Anthropic-compatible" }).first()).toBeAttached();
    const token = await bearerToken(page);
    const headBefore = await apiStatusRevision(request, token);
    await picker.selectOption("deepseek");
    await expect(drawer.locator('[data-field-id="provider:id"] input')).toHaveValue("");
    await drawer.getByRole("button", { name: "Apply preset" }).click();
    await expect(drawer.locator("#cfg-drawer-kind")).toHaveValue("openai_compatible");

    // Anthropic-compatible preset switches the kind and prefills the endpoint.
    await picker.selectOption("kimi-for-coding-anthropic");
    await expect(drawer.locator("[data-role='preset-note']")).toContainText("https://api.kimi.com/coding");
    await drawer.getByRole("button", { name: "Apply preset" }).click();
    await expect(drawer.locator("#cfg-drawer-kind")).toHaveValue("anthropic");
    await expect(drawer.locator('[data-field-id="provider:id"] input')).toHaveValue("kimi-for-coding-anthropic");
    await expect(drawer.locator('[data-field-id="provider:base_url"] input')).toHaveValue("https://api.kimi.com/coding");
    await expect(drawer.locator('[data-field-id="provider:api_key_env"] input')).toHaveValue("KIMI_API_KEY");
    await expect(drawer.locator('[data-field-id="provider:catalog_provider"] input')).toHaveValue("kimi-for-coding");

    // Prefilled drafts remain editable: point the env reference at the fixture
    // secret so publish validation accepts it, then save.
    await setTextField(drawer, "provider:api_key_env", "AICR_BROWSER_LLM_KEY");
    expect(await apiStatusRevision(request, token)).toBe(headBefore);
    await saveDrawerAndWaitRevision(page, request, headBefore);
    const row = page.locator("#config-main tbody tr", { hasText: "kimi-for-coding-anthropic" });
    await expect(row).toContainText("database");

    // Edit drawers of existing records do not offer the preset picker.
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("Edit kimi-for-coding-anthropic");
    await expect(drawer.locator("#cfg-provider-preset")).toHaveCount(0);
    await expect(drawer.locator("#cfg-drawer-kind")).toHaveValue("anthropic");
    await expect(drawer.locator('[data-field-id="provider:base_url"] input')).toHaveValue("https://api.kimi.com/coding");
    await expect(drawer.locator('[data-field-id="provider:catalog_provider"] input')).toHaveValue("kimi-for-coding");
    await drawer.getByRole("button", { name: "Cancel", exact: true }).click();

    // Cleanup.
    page.once("dialog", (dialog) => void dialog.accept());
    await page.locator("#config-main tbody tr", { hasText: "kimi-for-coding-anthropic" }).getByRole("button", { name: "Delete" }).click();
    const confirmDelete = page.locator(".cfg-dialog, [role='dialog'], .cfg-panel", { hasText: "Delete kimi-for-coding-anthropic" });
    await confirmDelete.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("#config-main tbody tr", { hasText: "kimi-for-coding-anthropic" })).toHaveCount(0);
  });

  test("provider preset preserves a literal key without adding a conflicting env reference", async ({ page }) => {
    await login(page);
    await openConfigTab(page);
    const drawer = page.locator("#config-editor");
    await page.getByRole("button", { name: "New provider", exact: true }).click();
    await drawer.locator("#cfg-provider-preset").selectOption("deepseek");
    await drawer.getByRole("button", { name: "Apply preset" }).click();
    await setTextField(drawer, "provider:api_key", "preset-literal-key");
    await drawer.locator("#cfg-provider-preset").selectOption("kimi-for-coding-anthropic");
    await drawer.getByRole("button", { name: "Apply preset" }).click();
    await expect(drawer.locator('[data-field-id="provider:api_key"] input')).toHaveValue("preset-literal-key");
    await expect(drawer.locator('[data-field-id="provider:api_key_env"] input')).toHaveCount(0);
    await setTextField(drawer, "provider:id", "preset-literal-provider");
    await drawer.getByRole("button", { name: "Save", exact: true }).click();
    await expect(drawer).toBeHidden();
    const row = page.locator("#config-main tbody tr", { hasText: "preset-literal-provider" });
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(drawer.locator('[data-field-id="provider:api_key_env"] input')).toHaveCount(0);
    await expect(drawer.locator('[data-field-id="provider:api_key"]')).toContainText("A value is stored");
    await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await page.locator(".cfg-dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(row).toHaveCount(0);
  });

  test("workspace defaults support explicit inherit/override round-trips", async ({ page }) => {
    await login(page);
    await openConfigTab(page, "Workspaces");
    const main = page.locator("#config-main");
    const row = await ensureFieldVisible(page, "workspaces:defaults.review.max_files");
    // Override the inherited/default value, save, then return to inherit.
    // Note: input values never appear in textContent — assert control state.
    await row.getByRole("button", { name: "Override" }).click();
    await row.locator("input").first().fill("42");
    await main.getByRole("button", { name: "Save page changes" }).click();
    await expect(page.locator("#config-status")).toContainText("Saved as revision");
    await expect(row.locator("input").first()).toHaveValue("42");
    await expect(row.getByRole("button", { name: "Override" })).toHaveAttribute("aria-pressed", "true");
    await row.getByRole("button", { name: "Inherit" }).click();
    await main.getByRole("button", { name: "Save page changes" }).click();
    await expect(page.locator("#config-status")).toContainText("Saved as revision");
    await expect(row.getByRole("button", { name: "Inherit" })).toHaveAttribute("aria-pressed", "true");
  });
  test("configuration content renders as inert text (no HTML injection)", async ({ page }) => {
    await login(page);
    await openConfigTab(page, "Review");
    const main = page.locator("#config-main");
    const payload = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
    const row = await ensureFieldVisible(page, "review:labels.auto_tag");
    await row.getByRole("button", { name: "Set value" }).click();
    await row.locator("input").first().fill(payload);
    await main.getByRole("button", { name: "Save page changes" }).click();
    await expect(page.locator("#config-status")).toContainText("Saved as revision");
    // The saved value re-renders as inert text/data, never as markup.
    const rendered = await ensureFieldVisible(page, "review:labels.auto_tag");
    await expect(rendered.locator("input").first()).toHaveValue(payload);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await rendered.locator("img").count()).toBe(0);
  });

  test("narrow viewport keeps navigation, tables and the editor usable", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await login(page);
    await openConfigTab(page);
    // Collapsed layout: the nav switches to a horizontal strip.
    await expect(page.locator("#config-nav")).toHaveCSS("flex-direction", "row");
    await expect(page.locator("#config-nav button", { hasText: "Providers" })).toBeVisible();
    // Entity tables live in a horizontal scroll container.
    await expect(page.locator("#config-main .table-scroll")).toBeVisible();
    // The drawer still opens and closes.
    await page.locator("#config-main tbody tr", { hasText: "file-llm" }).getByRole("button", { name: "View" }).click();
    const drawer = page.locator("#config-editor");
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("View file-llm");
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toBeHidden();
    await page.getByRole("button", { name: "New provider", exact: true }).click();
    const preset = drawer.locator(".cfg-provider-preset");
    await expect(preset).toBeVisible();
    expect(await preset.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("ordered-list rows move with keyboard (Alt+Arrow)", async ({ page }) => {
    await login(page);
    await openConfigTab(page, "Model groups");
    await page.getByRole("button", { name: "New model group" }).click();
    const drawer = page.locator("#config-editor");
    await expect(drawer.locator(".cfg-drawer-title")).toHaveText("New model group");
    await setTextField(drawer, "model_group:$name", "kb-group");
    const list = drawer.locator('[data-field-id="model_group:entries"]');
    // Two rows with distinct models.
    for (const model of ["model-a", "model-b"]) {
      await list.getByRole("button", { name: "Add Model entries row" }).click();
      const rowItem = list.locator("ol li, .cfg-olist-row").last();
      await rowItem.locator("select").first().selectOption("file-llm");
      await rowItem.locator("input").first().fill(model);
    }
    const firstRow = list.locator("ol li, .cfg-olist-row").first();
    await expect(firstRow.locator("input").first()).toHaveValue("model-a");
    // Keyboard move: focus the first row, Alt+ArrowDown swaps the order.
    await firstRow.focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(list.locator("ol li, .cfg-olist-row").first().locator("input").first()).toHaveValue("model-b");
    await drawer.getByRole("button", { name: "Cancel" }).click();
  });

  test("route preview evaluates a sample event against published routing", async ({ page }) => {
    await login(page);
    await openConfigTab(page, "Routing");
    const main = page.locator("#config-main");
    await main.locator("#cfg-preview-repo-ref").fill("acme/app");
    await main.getByRole("button", { name: "Preview" }).click();
    // The fixture workspace binds trigger git-main + repo acme/app → match.
    await expect(main).toContainText("default-project");
  });

  test("versions page lists revisions and restore publishes a new head", async ({ page, request }) => {
    await login(page);
    await openConfigTab(page);
    const drawer = page.locator("#config-editor");
    // Arrange two revisions: create then edit a provider.
    await page.getByRole("button", { name: "New provider" }).click();
    await setTextField(drawer, "provider:id", "db-provider");
    await setTextField(drawer, "provider:base_url", "http://127.0.0.1:9/v1");
    await setTextField(drawer, "provider:api_key_env", "AICR_BROWSER_LLM_KEY");
    const token = await bearerToken(page);
    const head0 = await apiStatusRevision(request, token);
    const rev1 = await saveDrawerAndWaitRevision(page, request, head0);
    await page.locator("#config-main tbody tr", { hasText: "db-provider" }).getByRole("button", { name: "Edit" }).click();
    await setTextField(drawer, "provider:timeout_ms", "12345");
    await saveDrawerAndWaitRevision(page, request, rev1);

    await openConfigTab(page, "Versions");
    const main = page.locator("#config-main");
    await expect(main).toContainText("Head revision");
    const rows = main.locator("tbody tr");
    // The namespace accumulates revisions from earlier tests; the newest head is listed first.
    await expect(rows.first().locator("td").first()).toHaveText(String(rev1 + 1));
    // View shows the redacted audit detail (entity ids per S06); Restore publishes a new head.
    await rows.first().getByRole("button", { name: "View" }).click();
    await expect(main.locator("[data-role=revision-detail]")).toContainText("db-provider");
    await rows.first().getByRole("button", { name: "Restore" }).click();
    const confirm = page.locator(".cfg-dialog, [role='dialog'], .cfg-panel");
    await confirm.getByRole("button", { name: /Restore/ }).click();
    await expect.poll(async () => apiStatusRevision(request, token)).toBe(rev1 + 2);
  });

  test("database-priority prefixes stay editable and reset to file/default values", async ({ page, request }) => {
    const token = await apiLogin(request);
    const initial = await apiView(request, token);
    const seeded = await request.post("/api/admin/config/changesets", {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        baseRevision: initial.head?.activeRevision ?? null,
        fileDigest: initial.fileDigest,
        operationId: "db-priority-reset-seed",
        operations: [{ op: "set", path: ["review", "max_files"], value: 61 }],
      },
    });
    expect(seeded.status()).toBe(200);

    await login(page);

    // §3.15 exception: agent is a database-priority prefix, so the fixture's
    // file-owned agent.sandbox.kind stays editable instead of locking.
    await openConfigTab(page, "Agent");
    const sandboxKind = page.locator('#config-main [data-field-id="agent:sandbox.kind"] select');
    await expect(sandboxKind).toBeVisible();
    await expect(sandboxKind).toBeEnabled();
    await expect(sandboxKind).toHaveValue("native");

    // Review shows the seeded database value; the reset button clears every
    // database override under the page's database-priority prefixes.
    await openConfigTab(page, "Review");
    const maxFiles = await ensureFieldVisible(page, "review:max_files");
    await expect(maxFiles.locator("input")).toHaveValue("61");
    // A second editor changes the head after this page froze its revision.
    const concurrent = await apiView(request, token);
    const changed = await request.post("/api/admin/config/changesets", {
      headers: { Authorization: `Bearer ${token}` },
      data: { baseRevision: concurrent.head?.activeRevision ?? null, fileDigest: concurrent.fileDigest,
        operationId: "db-priority-reset-conflict", operations: [{ op: "set", path: ["review", "max_files"], value: 75 }] },
    });
    expect(changed.status()).toBe(200);
    await page.locator("#config-main").getByRole("button", { name: "Reset database overrides", exact: true }).click();
    await page.locator(".cfg-dialog").getByRole("button", { name: "Reset", exact: true }).click();
    const conflict = page.locator("#config-main .cfg-panel-conflict");
    await expect(conflict).toContainText("75");
    expect((await apiView(request, token)).globals.review?.max_files).toBe(75);
    await conflict.getByRole("button", { name: "Keep my changes and retry", exact: true }).click();
    await expect(page.locator("#config-status")).toContainText("Saved as revision");
    // The override is gone: the effective value falls back to the schema default.
    expect((await apiView(request, token)).globals.review?.max_files).toBe(2000);

    // Nothing left to reset: the button warns instead of publishing.
    await page.locator("#config-main").getByRole("button", { name: "Reset database overrides", exact: true }).click();
    await expect(page.locator("#config-status")).toContainText("No database overrides to reset");
  });

  test("history retention overrides YAML and resets to YAML or defaults", async ({ page, request }) => {
    const token = await apiLogin(request);
    const initial = await apiView(request, token);
    const sections = ["recent_runs", "events", "queue"];
    const response = await request.post("/api/admin/config/changesets", {
      headers: { Authorization: `Bearer ${token}` },
      data: { baseRevision: initial.head?.activeRevision ?? null, fileDigest: initial.fileDigest,
        operationId: "history-retention-browser", operations: sections.flatMap(section => [
          { op: "set", path: ["storage", "retention", section, "max_count"], value: 1200 },
          { op: "set", path: ["storage", "retention", section, "max_age_months"], value: 9 },
        ]) },
    });
    expect(response.status()).toBe(200);
    await login(page);
    await openConfigTab(page, "Advanced");
    for (const section of sections) {
      for (const [field, value] of [["max_count", "1200"], ["max_age_months", "9"]]) {
        const row = await ensureFieldVisible(page, `storage:retention.${section}.${field}`);
        await expect(row.locator("input")).toBeEnabled();
        await expect(row.locator("input")).toHaveValue(value!);
      }
    }
    await expect(page.locator('#config-main [data-field-id="storage:database.kind"] select')).toBeDisabled();
    const editableCount = await ensureFieldVisible(page, "storage:retention.events.max_count");
    await editableCount.locator("input").fill("1300");
    await page.locator("#config-main").getByRole("button", { name: "Save page changes", exact: true }).click();
    await expect(page.locator("#config-status")).toContainText("Saved as revision");
    await page.reload();
    await openConfigTab(page, "Advanced");
    await expect((await ensureFieldVisible(page, "storage:retention.events.max_count")).locator("input")).toHaveValue("1300");
    await page.locator("#config-main").getByRole("button", { name: "Reset database overrides", exact: true }).click();
    await page.locator(".cfg-dialog").getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.locator("#config-status")).toContainText("Saved as revision");
    for (const [section, count, months] of [["recent_runs", "2000", "6"], ["events", "1500", "3"], ["queue", "1000", "6"]]) {
      const countRow = await ensureFieldVisible(page, `storage:retention.${section}.max_count`);
      if (section !== "events") {
        // Optional parents remain absent after reset, preserving old snapshot
        // canonicalization. The editor offers the consumer default on Set value.
        await expect(countRow).toContainText("Not set");
        await countRow.getByRole("button", { name: "Set value", exact: true }).click();
      }
      await expect(countRow.locator("input")).toHaveValue(count!);
      const ageRow = await ensureFieldVisible(page, `storage:retention.${section}.max_age_months`);
      if (section !== "events") await ageRow.getByRole("button", { name: "Set value", exact: true }).click();
      await expect(ageRow.locator("input")).toHaveValue(months!);
    }
    // The default previews above were never saved as database overrides.
    await page.reload();
  });

  test("templates and prompts pages manage documents and copy built-in assets", async ({ page, request }) => {
    const token = await apiLogin(request);
    await login(page);
    const drawer = page.locator("#config-editor");

    // Templates: create a markdown document with frontmatter metadata.
    await openConfigTab(page, "Templates");
    await page.getByRole("button", { name: "New template", exact: true }).click();
    await setTextField(drawer, "template:$name", "browser-summary");
    await setTextField(drawer, "template:*", "---\nname: 浏览器汇总\n---\nSummary {{run.id}}\n");
    await drawer.getByRole("button", { name: "Save", exact: true }).click();
    await expect(drawer).toBeHidden();

    // Roundtrip: the document loads back verbatim.
    await page.locator("#config-main tbody tr", { hasText: "browser-summary" }).getByRole("button", { name: "Edit", exact: true }).click();
    await expect(drawer.locator('[data-field-id="template:*"] textarea')).toHaveValue("---\nname: 浏览器汇总\n---\nSummary {{run.id}}\n");
    await cancelDrawerAndDiscard(page);

    // Built-in templates are read-only copy sources; copying prefills a create draft.
    const builtinTemplate = page.locator("#config-main .cfg-builtin-asset", { hasText: "gitea_pr_review/summary" });
    await expect(builtinTemplate).toBeVisible();
    await builtinTemplate.getByRole("button", { name: "Copy as new database config", exact: true }).click();
    await expect(drawer.locator(".cfg-drawer-title")).toContainText("copied from gitea_pr_review/summary");
    await expect(drawer.locator('[data-field-id="template:*"] textarea')).toHaveValue(/AI Code Review Summary/);
    await setTextField(drawer, "template:$name", "browser-builtin-copy");
    await drawer.getByRole("button", { name: "Save", exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.locator("#config-main tbody tr", { hasText: "browser-builtin-copy" })).toBeVisible();

    // Prompts: create + roundtrip; the built-in base prompt ships as a copy source.
    await openConfigTab(page, "Prompts");
    await page.getByRole("button", { name: "New prompt", exact: true }).click();
    await setTextField(drawer, "prompt:$name", "team-extra");
    await setTextField(drawer, "prompt:*", "Extra review rules for the team.\n");
    await drawer.getByRole("button", { name: "Save", exact: true }).click();
    await expect(drawer).toBeHidden();
    await page.locator("#config-main tbody tr", { hasText: "team-extra" }).getByRole("button", { name: "Edit", exact: true }).click();
    await expect(drawer.locator('[data-field-id="prompt:*"] textarea')).toHaveValue("Extra review rules for the team.\n");
    await cancelDrawerAndDiscard(page);
    const builtinPrompt = page.locator("#config-main .cfg-builtin-asset", { hasText: "code-reviewer" });
    await expect(builtinPrompt).toBeVisible();
    await builtinPrompt.getByRole("button", { name: "Copy as new database config", exact: true }).click();
    await expect(drawer.locator('[data-field-id="prompt:*"] textarea')).not.toHaveValue("");
    await cancelDrawerAndDiscard(page);

    // Named references: options endpoints serve the created entities.
    const templateOptions = await (await request.get("/api/admin/config/options/templates", { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(templateOptions.options.map((option: { value: string }) => option.value)).toContain("browser-summary");
    const promptOptions = await (await request.get("/api/admin/config/options/prompts", { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(promptOptions.options.map((option: { value: string }) => option.value)).toContain("team-extra");

    // Channel drawer: templates.problem select lists the created template.
    await openConfigTab(page, "Channels");
    await page.getByRole("button", { name: "New channel", exact: true }).click();
    await drawer.locator("#cfg-drawer-kind").selectOption("gitea_issue");
    const templateSection = drawer.locator("details", { has: page.locator('[data-field-id="channel:templates.problem"]') }).first();
    if ((await templateSection.getAttribute("open")) === null) await templateSection.locator("summary").first().click();
    const problemField = drawer.locator('[data-field-id="channel:templates.problem"]');
    await problemField.getByRole("button", { name: "Set value" }).click();
    await expect(problemField.locator("select option", { hasText: "browser-summary" })).toHaveCount(1);
    await cancelDrawerAndDiscard(page);

    // Workspace drawer: prompt.system_prompt select lists the created prompt.
    // Instance fields use the Inherit/Override segment instead of "Set value".
    await openConfigTab(page, "Workspaces");
    await page.getByRole("button", { name: "New workspace", exact: true }).click();
    const systemPromptField = drawer.locator('[data-field-id="workspace:prompt.system_prompt"]');
    await expect(systemPromptField.locator("select option", { hasText: "team-extra" })).toHaveCount(1);
    await systemPromptField.getByRole("button", { name: "Override", exact: true }).click();
    await systemPromptField.locator("select").selectOption("team-extra");
    await expect(systemPromptField.locator("select")).toHaveValue("team-extra");
    await cancelDrawerAndDiscard(page);
  });
});
