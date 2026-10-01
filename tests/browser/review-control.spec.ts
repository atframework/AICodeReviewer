import { test, expect } from "@playwright/test";

test("operators can re-review, terminate, close and requeue from the dashboard", async ({ page }) => {
  const actions: string[] = [];
  page.on("dialog", dialog => { void dialog.accept(); });
  await page.route("**/api/admin/runs?*", route => route.fulfill({ json: { page: 1, hasMore: false, items: [
    { id: "finished-run", workspaceId: "ws", status: "succeeded", targetKind: "pull_request", headSha: "abc", startedAt: new Date().toISOString() },
    { id: "active-run", workspaceId: "ws", status: "analyzing", headSha: "def", startedAt: new Date().toISOString() },
  ] } }));
  await page.route("**/api/admin/auto-commit/batches?*", route => route.fulfill({ json: { page: 1, hasMore: false, items: [
    { batchId: "queued-batch", workspaceId: "ws", status: "queued", base: "abc", head: "def", attempt: 0, maxAttempts: 2 },
  ] } }));
  await page.route("**/api/admin/runs/live", route => route.fulfill({ json: { serverTime: new Date().toISOString(), runs: [
    { runId: "active-run", workspaceId: "ws", phase: "analyzing", startedAt: new Date().toISOString(), metrics: {} },
  ] } }));
  for (const path of ["runs/finished-run/rereview", "runs/active-run/cancel", "auto-commit/batches/queued-batch/cancel", "auto-commit/batches/queued-batch/requeue"]) {
    await page.route(`**/api/admin/${path}`, route => {
      actions.push(path);
      return route.fulfill({ status: path.endsWith("rereview") ? 202 : 200, json: { ok: true, status: "accepted", runId: "fresh-run" } });
    });
  }
  await page.goto("/dashboard");
  await page.fill("#username", "admin");
  await page.fill("#password", "browser-test-password");
  await page.click("#login-form button[type=submit]");
  await page.click(".tab[data-tab='runs']");
  await expect(page.locator("#runs-table tr")).toHaveCount(2);
  await expect(page.locator("#runs-table tr").first().locator("td")).toHaveCount(12);
  await page.locator("#runs-table").getByRole("button", { name: "Re-review", exact: true }).click();
  await expect.poll(() => actions).toContain("runs/finished-run/rereview");
  await page.locator("#runs-table").getByRole("button", { name: "Terminate", exact: true }).click();
  await expect.poll(() => actions).toContain("runs/active-run/cancel");
  await page.click(".tab[data-tab='live']");
  await page.locator("#live-table").getByRole("button", { name: "Terminate", exact: true }).click();
  await expect.poll(() => actions.filter(action => action === "runs/active-run/cancel").length).toBe(2);
  await page.click(".tab[data-tab='queue']");
  await page.locator("#queue-table").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => actions).toContain("auto-commit/batches/queued-batch/cancel");
  await page.locator("#queue-table").getByRole("button", { name: "Requeue", exact: true }).click();
  await expect.poll(() => actions).toContain("auto-commit/batches/queued-batch/requeue");
});
