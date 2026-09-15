/**
 * P7 browser gate: UI-driven config changes fully isolate an in-flight run
 * from a later run (route channel flip + agent.default flip mid-run).
 *
 * Flow (grounded against the live fixture, see tests/browser/start-fixture.mjs):
 * the real CLI server runs with stub kilo/opencode CLIs on PATH (native
 * sandbox agent path) and stub gitea services on 127.0.0.1:9399 (git-main)
 * and :9398 (git-preview). Run 1 is held inside the kilo stub by a release
 * flag while the route's summary channel and the global agent kind are flipped
 * through the UI; run 1 must still publish through the OLD generation
 * (kilo → 9399) and run 2 through the NEW one (opencode → 9398), with
 * distinct persisted config snapshots and zero cross-posts.
 *
 * Selector contract follows tests/browser/config-ui.spec.ts (same renderer).
 */
import { createHmac } from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";

import { test, expect, type Page, type Locator, type APIRequestContext } from "@playwright/test";

const ADMIN = { username: "admin", password: "browser-test-password" };
const GIT_SECRET = "browser-dummy-git-secret-preview";
const TMP_DIR = join(process.cwd(), "build", "tmp", "browser");
const AGENT_LOG = join(TMP_DIR, "stub-agent.log");
const RELEASE_FLAG = join(TMP_DIR, "release.flag");
const KILO_SENTINEL = "KILO-OLD-RUN sentinel";
const OPENCODE_SENTINEL = "OPENCODE-NEW-RUN sentinel";

const requireStore = createRequire(join(process.cwd(), "packages", "store", "package.json"));
type SqliteDatabase = { prepare(sql: string): { all(...args: unknown[]): unknown[] }; close(): void };
const Database = requireStore("better-sqlite3") as new (path: string, options?: { readonly?: boolean }) => SqliteDatabase;

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

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

async function apiStatusRevision(request: APIRequestContext, token: string): Promise<number | null> {
  const response = await request.get("/api/admin/config/status", { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { manager?: { databaseRevision?: number | null } };
  return body.manager?.databaseRevision ?? null;
}

/**
 * Shared-namespace hygiene: config-ui.spec.ts publishes a weekly PR execution
 * window (review.pull_request.schedule.rules — M16 durable deferral) that
 * would defer this spec's review to the next window instead of executing it.
 * Clear the schedule when present; standalone runs skip the extra revision.
 */
async function clearPrExecutionWindow(request: APIRequestContext, token: string): Promise<void> {
  const view = await request.get("/api/admin/config", { headers: { Authorization: `Bearer ${token}` } });
  expect(view.status()).toBe(200);
  const body = (await view.json()) as { fileDigest: string; globals?: { review?: { pull_request?: { schedule?: { rules?: unknown[] } } } } };
  const rules = body.globals?.review?.pull_request?.schedule?.rules;
  if (!Array.isArray(rules) || rules.length === 0) return;
  const baseRevision = await apiStatusRevision(request, token);
  const response = await request.post("/api/admin/config/changesets", {
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: {
      baseRevision,
      operationId: `op-clear-window-${Math.random().toString(36).slice(2, 10)}`,
      fileDigest: body.fileDigest,
      operations: [{ op: "unset", path: ["review", "pull_request", "schedule"] }],
    },
  });
  expect(response.status()).toBe(200);
}

/** Fill a drawer/globals text field, opening the "Set value" absent state first. */
async function setTextField(host: Locator, fieldId: string, value: string): Promise<void> {
  const row = host.locator(`[data-field-id="${fieldId}"]`);
  const control = row.locator("input,textarea").first();
  if ((await control.count()) === 0 || !(await control.isVisible())) {
    await row.getByRole("button", { name: "Set value" }).click();
  }
  await row.locator("input,textarea").first().fill(value);
}


/** Select a drawer/globals option, expanding collapsed sections and the
 * "Set value" absent state first. */
async function setSelectField(host: Locator, fieldId: string, value: string): Promise<void> {
  const section = host.locator(`details:has([data-field-id="${fieldId}"])`).first();
  if ((await section.count()) > 0 && (await section.getAttribute("open")) === null) {
    await section.locator("summary").first().click();
  }
  const row = host.locator(`[data-field-id="${fieldId}"]`);
  const control = row.locator("select").first();
  if ((await control.count()) === 0 || !(await control.isVisible())) {
    await row.getByRole("button", { name: "Set value" }).click();
  }
  const select = row.locator("select").first();
  if (await select.isDisabled()) {
    // Inherit-or-override fields gate the control behind the segmented
    // Inherit/Override source switch (renderer.js buildBindingControl).
    await row.getByRole("button", { name: "Override", exact: true }).click();
  }
  await select.selectOption(value);
}


/** Open a checkbox-list multiselect (absent state) and return its field row. */
async function multiselectRow(host: Locator, fieldId: string): Promise<Locator> {
  const row = host.locator(`[data-field-id="${fieldId}"]`);
  const setValue = row.getByRole("button", { name: "Set value", exact: true });
  if (await setValue.count()) await setValue.click();
  return row;
}

async function captured(request: APIRequestContext, port: number): Promise<CapturedRequest[]> {
  const response = await request.get(`http://127.0.0.1:${port}/__captured`);
  expect(response.status()).toBe(200);
  return (await response.json()) as CapturedRequest[];
}

function reviewPosts(requests: readonly CapturedRequest[]): CapturedRequest[] {
  return requests.filter((entry) => entry.method === "POST" && entry.url.includes("/api/v1/") && entry.url.includes("/reviews"));
}

function agentLogBinaries(): string[] {
  if (!existsSync(AGENT_LOG)) return [];
  const content = readFileSync(AGENT_LOG, "utf8").trim();
  if (content === "") return [];
  return content.split("\n").map((line) => (JSON.parse(line) as { binary: string }).binary);
}

test("P7: UI route/agent changes mid-run fully isolate the old and new runs", async ({ page, request }) => {
  test.setTimeout(120_000);
  const shas = JSON.parse(readFileSync(join(TMP_DIR, "fixture-shas.json"), "utf8")) as { baseSha: string; headSha: string };

  await login(page);
  // Cleanup must run BEFORE the config tab loads: an out-of-band revision
  // after the UI has read its baseline would 409 the first UI publish.
  const token = await bearerToken(page);
  await clearPrExecutionWindow(request, token);
  await openConfigTab(page, "Channels");
  const head0 = (await apiStatusRevision(request, token)) ?? 0;
  const drawer = page.locator("#config-editor");
  // E01: create the actual provider/group/workspace through the UI, then
  // execute the published route against a local Git repository and agent CLI.
  await page.locator("#config-nav").getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("button", { name: "New provider", exact: true }).click();
  await drawer.locator("#cfg-drawer-kind").selectOption("ollama");
  await setTextField(drawer, "provider:id", "iso-provider");
  await setTextField(drawer, "provider:base_url", "http://127.0.0.1:9/v1");
  await drawer.getByRole("button", { name: "Stage changes", exact: true }).click();
  await page.locator("#config-nav").getByRole("button", { name: "Model groups", exact: true }).click();
  await page.getByRole("button", { name: "New model group", exact: true }).click();
  await setTextField(drawer, "model_group:$name", "iso-group");
  await drawer.getByRole("button", { name: "Add Model entries row", exact: true }).click();
  await setSelectField(drawer, "model_group:entries[].provider", "iso-provider");
  await setTextField(drawer, "model_group:entries[].model", "iso-old-model");
  await setSelectField(drawer, "model_group:entries[].role", "any");
  await drawer.getByRole("button", { name: "Stage changes", exact: true }).click();
  await page.locator("#config-nav").getByRole("button", { name: "Workspaces", exact: true }).click();
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await setTextField(drawer, "workspace:$name", "iso-workspace");
  const matchSection = drawer.locator('details:has([data-field-id="workspace:match"])');
  if (await matchSection.getAttribute("open") === null) await matchSection.locator("summary").click();
  const match = drawer.locator('[data-field-id="workspace:match"]');
  await match.getByRole("button", { name: "Override", exact: true }).click();
  await match.getByRole("button", { name: "Add Match row", exact: true }).click();
  await (await multiselectRow(match, "workspace:match[].triggers")).getByRole("checkbox", { name: "git-preview", exact: true }).check();
  await drawer.getByRole("button", { name: "Stage changes", exact: true }).click();
  await page.locator("#config-nav").getByRole("button", { name: "Channels", exact: true }).click();
  for (const [name, trigger] of [["c-iso-a", "git-main"], ["c-iso-b", "git-preview"]] as const) {
    await page.getByRole("button", { name: "New channel", exact: true }).click();
    await drawer.locator("#cfg-drawer-kind").selectOption("gitea_pr_review");
    await setTextField(drawer, "channel:name", name);
    await setSelectField(drawer, "channel:trigger", trigger);
    await setSelectField(drawer, "channel:no_problems.action", "publish");
    await setSelectField(drawer, "channel:review_update_strategy", "always_new");
    await drawer.getByRole("button", { name: "Stage changes", exact: true }).click();
  }
  await page.getByRole("button", { name: "Publish staged changes", exact: true }).click();
  await expect.poll(async () => apiStatusRevision(request, token)).toBe(head0 + 1);

  // Route r-iso: database workspace iso-workspace, pull_request on git-preview,
  // iso-group model chain, summary → c-iso-a (channels must be published first
  // or the outputs.summary checklist has no options). Drawer Save publishes
  // immediately (head +1).
  await page.locator("#config-nav").getByRole("button", { name: "Routing", exact: true }).click();
  await page.getByRole("button", { name: "New route", exact: true }).click();
  await setTextField(drawer, "route:id", "r-iso");
  await setSelectField(drawer, "route:workspace", "iso-workspace");
  await (await multiselectRow(drawer, "route:match.triggers")).getByRole("checkbox", { name: "git-preview", exact: true }).check();
  await (await multiselectRow(drawer, "route:match.target_kinds")).getByRole("checkbox", { name: "pull_request", exact: true }).check();
  await setSelectField(drawer, "route:analysis.model_chain", "iso-group");
  await (await multiselectRow(drawer, "route:outputs.summary")).getByRole("checkbox", { name: "c-iso-a", exact: true }).check();
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect.poll(async () => apiStatusRevision(request, token)).toBe(head0 + 2);

  const previewResponse = await request.post("/api/admin/config/preview-route", {
    headers: { Authorization: `Bearer ${token}` },
    data: { event: { triggerName: "git-preview", targetKind: "pull_request", repoRef: "acme/app" } },
  });
  expect(previewResponse.status()).toBe(200);
  const preview = await previewResponse.json();
  expect(preview).toMatchObject({ status: "matched", workspace: "iso-workspace", analysis: { modelChain: "iso-group" } });
  const sourceRoot = resolve(preview.layout.sourceRoot);
  const relativeRoot = relative(TMP_DIR, sourceRoot);
  expect(isAbsolute(relativeRoot) || relativeRoot.startsWith(".."), JSON.stringify({ sourceRoot, temporaryRoot: TMP_DIR })).toBe(false);
  cpSync(join(TMP_DIR, "workspaces", "default-project", "source", "acme_app"), sourceRoot, { recursive: true });

  // --- Step 2: fire webhook 1; the kilo stub holds the run in flight. ------
  const webhookBody = JSON.stringify({
    action: "opened",
    repository: { full_name: "acme/app" },
    pull_request: { number: 7, base: { sha: shas.baseSha, ref: "main" }, head: { sha: shas.headSha, ref: "feature" }, user: { login: "fixture-author" } },
  });
  const fireWebhook = () => request.post("/webhooks/gitea", {
    data: webhookBody,
    headers: {
      "content-type": "application/json",
      "x-gitea-event": "pull_request",
      "x-gitea-signature": createHmac("sha256", GIT_SECRET).update(webhookBody).digest("hex"),
    },
  });
  const webhook1 = fireWebhook();
  // The agent log is a cross-process condition (webhook → scheduling → VCS →
  // bundle → exe spawn → stub write); the 10 s expect default flakes on cold
  // full-suite starts, so these polls get an explicit 60 s budget.
  await expect.poll(agentLogBinaries, { message: "kilo stub invocation should be logged", timeout: 60_000 }).toEqual(["kilo"]);

  // --- Step 3: flip route → c-iso-b and agent.default → opencode via UI. ---
  await page.locator("#config-nav").getByRole("button", { name: "Routing", exact: true }).click();
  await page.locator("#config-main tbody tr", { hasText: "r-iso" }).getByRole("button", { name: "Edit", exact: true }).click();
  const summaryRow = drawer.locator('[data-field-id="route:outputs.summary"]');
  await summaryRow.getByRole("checkbox", { name: "c-iso-a", exact: true }).uncheck();
  await summaryRow.getByRole("checkbox", { name: "c-iso-b", exact: true }).check();
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect.poll(async () => apiStatusRevision(request, token)).toBe(head0 + 3);

  await page.locator("#config-nav").getByRole("button", { name: "Providers", exact: true }).click();
  await page.locator("#config-main tbody tr", { hasText: "iso-provider" }).getByRole("button", { name: "Edit", exact: true }).click();
  await setTextField(drawer, "provider:base_url", "http://127.0.0.1:8/v1");
  await drawer.getByRole("button", { name: "Stage changes", exact: true }).click();
  await page.locator("#config-nav").getByRole("button", { name: "Model groups", exact: true }).click();
  await page.locator("#config-main tbody tr", { hasText: "iso-group" }).getByRole("button", { name: "Edit", exact: true }).click();
  await setTextField(drawer, "model_group:entries[].model", "iso-new-model");
  await drawer.getByRole("button", { name: "Stage changes", exact: true }).click();
  await page.getByRole("button", { name: "Publish staged changes", exact: true }).click();
  await expect.poll(async () => apiStatusRevision(request, token)).toBe(head0 + 4);

  await page.locator("#config-nav").getByRole("button", { name: "Agent", exact: true }).click();
  await setSelectField(page.locator("#config-main"), "agent:default", "opencode");
  await page.locator("#config-main").getByRole("button", { name: "Save page changes", exact: true }).click();
  await expect(page.locator("#config-status")).toContainText("Saved as revision");
  await expect.poll(async () => apiStatusRevision(request, token)).toBe(head0 + 5);

  // --- Step 4: release run 1; both runs complete (background mode). --------
  writeFileSync(RELEASE_FLAG, "go\n");
  const response1 = await webhook1;
  expect(response1.status()).toBe(202);
  await expect.poll(async () => reviewPosts(await captured(request, 9399)).length, { message: "run 1 review POST on 9399" }).toBe(1);

  const response2 = await fireWebhook();
  expect(response2.status()).toBe(202);
  await expect.poll(async () => reviewPosts(await captured(request, 9398)).length, { message: "run 2 review POST on 9398" }).toBe(1);
  await expect.poll(agentLogBinaries, { message: "opencode stub invocation should be logged", timeout: 60_000 }).toEqual(["kilo", "opencode"]);

  // --- Step 5: isolation assertions. ----------------------------------------
  const posts9399 = reviewPosts(await captured(request, 9399));
  const posts9398 = reviewPosts(await captured(request, 9398));
  expect(posts9399.map((entry) => entry.url)).toEqual(["/api/v1/repos/acme/app/pulls/7/reviews"]);
  expect(posts9398.map((entry) => entry.url)).toEqual(["/api/v1/repos/acme/app/pulls/7/reviews"]);
  expect(posts9399[0]!.body).toContain(KILO_SENTINEL);
  expect(posts9399[0]!.body).not.toContain(OPENCODE_SENTINEL);
  expect(posts9398[0]!.body).toContain(OPENCODE_SENTINEL);
  expect(posts9398[0]!.body).not.toContain(KILO_SENTINEL);

  // Persisted state: two succeeded runs, and the two execution generations
  // (rev head0+2 at run 1 admission, rev head0+5 at run 2 admission) persisted
  // as DISTINCT snapshots with the second pinned at the new head.
  await expect.poll(async () => {
    const db = new Database(join(TMP_DIR, "aicr.sqlite"), { readonly: true });
    try {
      return db.prepare("SELECT COUNT(*) AS n FROM review_runs WHERE workspace_id = 'iso-workspace' AND status = 'succeeded'").all() as { n: number }[];
    } finally {
      db.close();
    }
  }, { message: "two succeeded run rows" }).toEqual([{ n: 2 }]);
  const db = new Database(join(TMP_DIR, "aicr.sqlite"), { readonly: true });
  try {
    const runs = db.prepare("SELECT status, trigger_name, head_sha FROM review_runs ORDER BY started_at").all() as { status: string; trigger_name: string; head_sha: string }[];
    expect(runs).toEqual([
      { status: "succeeded", trigger_name: "git-preview", head_sha: shas.headSha },
      { status: "succeeded", trigger_name: "git-preview", head_sha: shas.headSha },
    ]);
    const snapshots = db.prepare("SELECT id, database_revision FROM config_runtime_snapshots WHERE database_revision >= ? ORDER BY database_revision").all(head0 + 1) as { id: string; database_revision: number }[];
    const revisions = snapshots.map((row) => row.database_revision);
    expect(revisions).toContain(head0 + 2);
    expect(revisions).toContain(head0 + 5);
    expect(new Set(snapshots.map((row) => row.id)).size).toBe(snapshots.length);
  } finally {
    db.close();
  }
  expect(await apiStatusRevision(request, token)).toBe(head0 + 5);
  const launches = readFileSync(AGENT_LOG, "utf8").trim().split("\n").map(line => JSON.parse(line) as { argv: string[]; cwd: string; providerBaseUrl: string });
  expect(launches).toHaveLength(2);
  expect(launches[0]!.argv).toContain("iso-provider/iso-old-model");
  expect(launches[1]!.argv).toContain("iso-provider/iso-new-model");
  expect(launches.map(launch => launch.providerBaseUrl)).toEqual(["http://127.0.0.1:9/v1", "http://127.0.0.1:8/v1"]);
  const completed = readFileSync(join(TMP_DIR, "cli-events.log"), "utf8").split("\n").flatMap(line => {
    try { const entry = JSON.parse(line); return entry.msg === "trigger processing completed" ? [entry] : []; } catch { return []; }
  });
  expect(completed.map(entry => entry.reviewRun.configVersion.databaseRevision)).toEqual([head0 + 2, head0 + 5]);
  expect(completed.map(entry => entry.reviewRun.configVersion.routeId)).toEqual(["r-iso", "r-iso"]);
  expect(completed[0].reviewRun.configVersion.configSnapshotId).not.toBe(completed[1].reviewRun.configVersion.configSnapshotId);

  // --- Step 6: cleanup — restore agent.default and reset the stub captures. -
  await setSelectField(page.locator("#config-main"), "agent:default", "kilo");
  await page.locator("#config-main").getByRole("button", { name: "Save page changes", exact: true }).click();
  await expect(page.locator("#config-status")).toContainText("Saved as revision");
  await expect.poll(async () => apiStatusRevision(request, token)).toBe(head0 + 6);
  await request.get("http://127.0.0.1:9399/__reset");
  await request.get("http://127.0.0.1:9398/__reset");
});
