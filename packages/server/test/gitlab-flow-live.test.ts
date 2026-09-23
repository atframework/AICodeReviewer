/**
 * Real-GitLab end-to-end acceptance (Plan GitLab leg):
 *   push -> queue persist -> review -> gitlab_problem_issue publication;
 *   MR filter -> publication target/identity verification;
 *   out-of-window MR -> persisted deferral -> SIGTERM -> restart -> recovery
 *   publication in the next window.
 *
 * The serve subprocess is the real CLI (`packages/cli/src/index.ts`) so the
 * restart leg exercises cross-process persistence, not in-memory timers. The
 * model is a loopback fake OpenAI-compatible endpoint returning a fixed
 * review; every other hop (GitLab API, webhooks, git clone, issue writes)
 * hits the disposable container from tests/services/with-gitlab.sh.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { closeStoreDb, createStoreDb, listPendingReviewDeferrals } from "@aicr/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const baseUrl = process.env.AICR_GITLAB_TEST_URL;
const token = process.env.AICR_GITLAB_TEST_TOKEN;
const enabled = Boolean(baseUrl || token);
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "packages/cli/src/index.ts");

const WEBHOOK_SECRET = "gitlab-live-secret";
const FAKE_PROBLEM = {
  file: "src/app.ts", line: 1, severity: "high", category: "correctness",
  message: "Acceptance fixture finding.", suggestion: "Keep the boundary checked.",
};

type Issue = {
  iid: number;
  title: string;
  description: string;
  state: string;
  assignees: { username: string }[] | null;
};

interface ServerHandle {
  readonly proc: ChildProcess;
  output(): string;
  stop(): Promise<void>;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((done) => server.once("listening", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected ephemeral TCP port");
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return address.port;
}

describe.skipIf(!enabled)("GitLab serve end-to-end with a disposable real service", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  const projects: number[] = [];
  let author: { id: number; username: string; email: string };

  async function api(path: string, method = "GET", body?: unknown): Promise<Response> {
    const response = await fetch(`${baseUrl}/api/v4${path}`, {
      method, headers: { "PRIVATE-TOKEN": token!, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
    return response;
  }

  async function poll<T>(read: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await delay(3000);
    }
  }

  function startFakeLlm(): Promise<{ port: number; requests: () => number }> {
    let requests = 0;
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        requests += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({ summary: "Acceptance review summary.", problems: [FAKE_PROBLEM] }),
            },
          }],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    return new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") reject(new Error("Expected LLM port"));
        cleanups.push(async () => {
          server.closeAllConnections();
          await new Promise<void>((closed) => server.close(() => closed()));
        });
        done({ port: (address as { port: number }).port, requests: () => requests });
      });
    });
  }

  async function writeConfig(
    dir: string,
    options: { port: number; llmPort: number; scheduleYaml?: string },
  ): Promise<void> {
    await mkdir(join(dir, "prompts/system"), { recursive: true });
    await writeFile(join(dir, "prompts/system/code-reviewer.system.md"), "You are a fixture reviewer.\n");
    const yaml = [
      "server:",
      '  hostname: "0.0.0.0"',
      `  port: ${options.port}`,
      // Admin auth must use the env form: resolveAdminAuthConfig ignores a
      // literal username, and without admin auth bootstrap skips the
      // observability store entirely (needsStore=false), which silently
      // downgrades review deferrals to memory-only.
      "admin:",
      "  username_env: AICR_LIVE_ADMIN_USERNAME",
      "  password_env: AICR_LIVE_ADMIN_PASSWORD",
      "storage:",
      "  database:",
      "    kind: sqlite",
      `    sqlite: { path: "${join(dir, "store.sqlite").replaceAll("\\", "/")}" }`,
      "queue:",
      "  kind: sqlite",
      `  sqlite: { path: "${join(dir, "queue.sqlite").replaceAll("\\", "/")}" }`,
      "triggers:",
      "  - name: gitlab-main",
      "    kind: gitlab",
      `    base_url: "${baseUrl}"`,
      "    token_env: AICR_GITLAB_LIVE_TOKEN",
      `    webhook_secret: ${WEBHOOK_SECRET}`,
      "outputs:",
      // Push batches rebuild the review author from sealed git evidence
      // (reviewEventForBatch), dropping the webhook actor; the designed
      // identity channel back to a platform user is email_mappings.
      "  author_resolution:",
      "    email_mappings:",
      `      "${author.email}": ${author.username}`,
      "  channels:",
      "    - name: gitlab-issues",
      "      kind: gitlab_problem_issue",
      "      trigger: gitlab-main",
      "      issue_mode: consolidated",
      "      resolved_action: none",
      "      assign_committer: true",
      "  routes:",
      "    default:",
      "      summary: [gitlab-issues]",
      "llm:",
      "  providers:",
      "    - id: fake",
      "      kind: openai_compatible",
      `      base_url: "http://127.0.0.1:${options.llmPort}/v1"`,
      "      api_key: fake-key",
      "  model_chain:",
      "    default:",
      "      - { provider: fake, model: fixture-model, role: any }",
      // native-llm selects the direct-LLM completion path: no agent CLI and no
      // sandbox container, so the review hits the loopback fake provider above.
      "agent:",
      "  default: native-llm",
      "review:",
      "  auto_commit:",
      "    delay_seconds: 0",
      options.scheduleYaml ?? "",
      "workspaces:",
      "  instances:",
      "    main:",
      "      match: [{ triggers: [gitlab-main] }]",
      "",
    ].filter((line) => line !== "").join("\n");
    await writeFile(join(dir, "config.yaml"), yaml);
  }

  async function startServer(dir: string, port: number): Promise<ServerHandle> {
    const proc = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, "serve", "--config", "config.yaml", "--port", String(port)], {
      cwd: dir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AICR_GITLAB_LIVE_TOKEN: token!,
        AICR_LIVE_ADMIN_USERNAME: "admin",
        AICR_LIVE_ADMIN_PASSWORD: randomBytes(12).toString("hex"),
      },
    });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => { output += String(chunk); });
    proc.stderr?.on("data", (chunk: Buffer) => { output += String(chunk); });
    const handle: ServerHandle = {
      proc,
      output: () => output,
      async stop() {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        const exited = new Promise<void>((done) => proc.once("exit", () => done()));
        proc.kill("SIGTERM");
        const timeout = delay(30000).then(() => "timeout" as const);
        if (await Promise.race([exited.then(() => "exit" as const), timeout]) === "timeout") {
          proc.kill("SIGKILL");
          await exited;
        }
      },
    };
    const deadline = Date.now() + 120000;
    while (!output.includes("AICR server listening on port")) {
      if (proc.exitCode !== null) throw new Error(`serve exited before ready (code ${proc.exitCode}):\n${output}`);
      if (Date.now() > deadline) {
        await handle.stop();
        throw new Error(`serve did not become ready within 120s:\n${output}`);
      }
      await delay(200);
    }
    cleanups.push(() => handle.stop());
    return handle;
  }

  async function fixture(): Promise<{ id: number; path: string }> {
    const name = `acceptance-${randomUUID().slice(0, 8)}`;
    const project = await (await api("/projects", "POST", {
      name, visibility: "private", initialize_with_readme: true,
    })).json() as { id: number; path_with_namespace: string };
    projects.push(project.id);
    // GitLab only assigns project members; non-member ids are silently dropped.
    await api(`/projects/${project.id}/members`, "POST", { user_id: author.id, access_level: 30 });
    return { id: project.id, path: project.path_with_namespace };
  }

  async function commitFile(projectId: number, branch: string, content: string, path = "src/app.ts"): Promise<void> {
    await api(`/projects/${projectId}/repository/files/${encodeURIComponent(path)}`, "POST", {
      branch, content, commit_message: `fixture ${randomUUID().slice(0, 8)}`,
      author_name: author.username, author_email: author.email,
    });
  }

  async function installWebhook(projectId: number, serverPort: number, options: { pushEvents?: boolean } = {}): Promise<void> {
    await api(`/projects/${projectId}/hooks`, "POST", {
      url: `http://host.containers.internal:${serverPort}/webhooks/gitlab`,
      token: WEBHOOK_SECRET,
      push_events: options.pushEvents ?? true, merge_requests_events: true, note_events: false,
      enable_ssl_verification: false,
    });
  }

  async function waitForManagedIssue(projectId: number, timeoutMs: number, server?: ServerHandle): Promise<Issue> {
    try {
      return await poll(async () => {
        const issues = await (await api(`/projects/${projectId}/issues?state=opened`)).json() as Issue[];
        return issues.find((issue) => issue.description.includes("<!-- aicr:managed=problem-issue -->"));
      }, timeoutMs, `managed issue on project ${projectId}`);
    } catch (error) {
      if (server) {
        throw new Error(`${(error as Error).message}\n--- serve output ---\n${server.output()}`, { cause: error });
      }
      throw error;
    }
  }

  beforeAll(async () => {
    if (!baseUrl || !token) throw new Error("Set both AICR_GITLAB_TEST_URL and AICR_GITLAB_TEST_TOKEN");
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      throw new Error("Live fixture requires a disposable loopback HTTP GitLab instance");
    }
    // The serve subprocess lives on the host loopback; GitLab's outbound
    // request guard must allow the local webhook target (researched setting).
    await api("/application/settings", "PUT", { allow_local_requests_from_web_hooks_and_services: true });
    const username = `aicr-author-${randomUUID().slice(0, 8)}`;
    const created = await (await api("/users", "POST", {
      username, email: `${username}@example.invalid`, name: username,
      password: randomBytes(24).toString("hex"), skip_confirmation: true,
    })).json() as { id: number };
    author = { id: created.id, username, email: `${username}@example.invalid` };
    await settleWebhookDelivery();
  }, 420000);

  // Sidekiq workers cache application settings per process, so loopback
  // webhook deliveries stay blocked ("URL is blocked" in web_hook_logs) for
  // up to a few minutes after the PUT above. Fire probe pushes at a bare
  // listener until one arrives, proving the delivery path (settings, routing,
  // host reachability) before any leg depends on it.
  async function settleWebhookDelivery(): Promise<void> {
    let delivered = false;
    const listener = createServer((_req, res) => {
      delivered = true;
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      listener.once("error", rejectListen);
      listener.listen(0, "0.0.0.0", () => resolveListen());
    });
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("probe listener has no port");
    const probe = await (await api("/projects", "POST", {
      name: `probe-${randomUUID().slice(0, 8)}`, visibility: "private", initialize_with_readme: true,
    })).json() as { id: number };
    projects.push(probe.id);
    try {
      await installWebhook(probe.id, address.port);
      const deadline = Date.now() + 360000;
      for (let round = 0; !delivered; round++) {
        await commitFile(probe.id, "main", `probe ${round}\n`, `probe-${round}.txt`);
        await poll(async () => (delivered ? true : undefined), 15000, "probe webhook delivery")
          .catch(() => undefined);
        if (!delivered && Date.now() > deadline) throw new Error("webhook delivery never arrived");
      }
    } finally {
      await new Promise<void>((resolveClose) => listener.close(() => resolveClose()));
    }
  }

  afterAll(async () => {
    const failures: string[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch { failures.push("cleanup"); }
    }
    for (const id of projects) {
      try { await api(`/projects/${id}`, "DELETE"); } catch { failures.push(String(id)); }
    }
    if (author) {
      try { await api(`/users/${author.id}`, "DELETE"); } catch { failures.push(author.username); }
    }
    // NB: allow_local_requests stays enabled. Toggling it off here races the
    // per-process settings cache in sidekiq workers: the next suite's
    // beforeAll re-enables it, but a worker with the stale cached "false"
    // then blocks the webhook delivery ("URL is blocked: Requests to the
    // link local network are not allowed"). The instance is disposable.
    expect(failures, "fixture cleanup failures").toEqual([]);
  }, 120000);

  it("push: persistent enqueue then managed issue publication with the webhook actor assigned", { timeout: 420000 }, async () => {
    const root = resolve("build/tmp");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "gitlab-flow-push-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const llm = await startFakeLlm();
    const port = await reservePort();
    await writeConfig(dir, { port, llmPort: llm.port });
    const server = await startServer(dir, port);
    const project = await fixture();
    await installWebhook(project.id, port);
    // GitLab webhook delivery is at-most-once, and on a cold instance the
    // sidekiq per-process settings cache keeps blocking loopback deliveries
    // ("URL is blocked" in web_hook_logs) for ~2 minutes after the suite
    // enables local requests. Re-fire the push trigger (new path per attempt,
    // the API rejects recreating an existing file) until delivery works.
    let issue: Issue | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 4 && issue === undefined; attempt++) {
      const path = attempt === 0 ? "src/app.ts" : `src/app-retry-${attempt}.ts`;
      await commitFile(project.id, "main", `export const pushValue = ${attempt + 1};\n`, path);
      try {
        issue = await waitForManagedIssue(project.id, 80000, attempt === 3 ? server : undefined);
      } catch (error) {
        lastError = error;
      }
    }
    if (issue === undefined) throw lastError;

    expect(issue.description).toContain("Acceptance review summary.");
    expect(issue.description).toContain("Acceptance fixture finding.");
    // 发布核对目标与身份: the issue landed on the pushed project, and the
    // assignee is the commit author resolved through email_mappings (git
    // author evidence), proving the full identity chain end-to-end.
    expect((issue.assignees ?? []).map((user) => user.username)).toContain(author.username);
    expect(llm.requests()).toBeGreaterThan(0);
    // 持久入队证据: sqlite queue store exists and holds the accepted receipt.
    expect((await stat(join(dir, "queue.sqlite"))).size).toBeGreaterThan(0);
    expect(server.output()).not.toContain("auto-commit store is in-memory");
  });

  it("merge request: filtered event publishes to the target project with actor identity", { timeout: 420000 }, async () => {
    const root = resolve("build/tmp");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "gitlab-flow-mr-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const llm = await startFakeLlm();
    const port = await reservePort();
    await writeConfig(dir, { port, llmPort: llm.port });
    const server = await startServer(dir, port);
    const project = await fixture();
    // Only MR events drive this leg: the fixture branch commit would otherwise
    // fire a push webhook whose auto-commit review races the MR review, and
    // its git-evidence author (email_mappings) would claim the assignee.
    await installWebhook(project.id, port, { pushEvents: false });
    const branch = `topic-${randomUUID().slice(0, 8)}`;
    await api(`/projects/${project.id}/repository/branches`, "POST", { branch, ref: "main" });
    await commitFile(project.id, branch, "export const mrValue = 2;\n");
    await api(`/projects/${project.id}/merge_requests`, "POST", {
      source_branch: branch, target_branch: "main", title: "Acceptance MR",
    });

    const issue = await waitForManagedIssue(project.id, 240000, server);

    expect(issue.description).toContain("Acceptance review summary.");
    expect((issue.assignees ?? []).map((user) => user.username)).toContain("root");
  });

  it("out-of-window MR persists, survives SIGTERM, and publishes in the next window", { timeout: 900000 }, async () => {
    // Window opens ~100s from now for 30 minutes, computed in UTC with a
    // midnight wrap guard so the leg is valid at any wall-clock instant.
    const now = Date.now();
    const start = new Date(now + 100000);
    const end = new Date(now + 100000 + 30 * 60000);
    const fmt = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
    const sameDay = start.getUTCDate() === end.getUTCDate();
    const ruleGroups = sameDay
      ? [`        - days: [${DAYS[start.getUTCDay()]}]\n          windows: [{ start: "${fmt(start)}", end: "${fmt(end)}" }]`,]
      : [
          `        - days: [${DAYS[start.getUTCDay()]}]\n          windows: [{ start: "${fmt(start)}", end: "24:00" }]`,
          `        - days: [${DAYS[end.getUTCDay()]}]\n          windows: [{ start: "00:00", end: "${fmt(end)}" }]`,
        ];
    const scheduleYaml = [
      "  pull_request:",
      "    schedule:",
      "      timezone: UTC",
      "      rules:",
      ...ruleGroups,
    ].join("\n");

    const root = resolve("build/tmp");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "gitlab-flow-window-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const llm = await startFakeLlm();
    const port = await reservePort();
    await writeConfig(dir, { port, llmPort: llm.port, scheduleYaml });
    const first = await startServer(dir, port);
    const project = await fixture();
    // Push events stay off here: the branch commit would otherwise publish its
    // own issue through the (ungated) auto-commit path before the window,
    // contaminating the deferral evidence.
    await installWebhook(project.id, port, { pushEvents: false });
    const branch = `window-${randomUUID().slice(0, 8)}`;
    await api(`/projects/${project.id}/repository/branches`, "POST", { branch, ref: "main" });
    await commitFile(project.id, branch, "export const windowValue = 3;\n");
    await api(`/projects/${project.id}/merge_requests`, "POST", {
      source_branch: branch, target_branch: "main", title: "Window MR",
    });

    // The event must land in the durable deferral table, not a process timer.
    const storePath = join(dir, "store.sqlite");
    const store = createStoreDb(storePath);
    try {
      await poll(async () => {
        const rows = await listPendingReviewDeferrals(store);
        return rows.length > 0 ? rows : undefined;
      }, 120000, "persisted deferral row").catch((error: unknown) => {
        throw new Error(`${(error as Error).message}\n--- serve output ---\n${first.output()}`);
      });
    } finally {
      await closeStoreDb(store);
    }
    await first.stop();

    // A new process recovers the row and waits for the window itself.
    const restarted = await startServer(dir, port);
    const waitForWindow = Math.max(0, start.getTime() - Date.now()) + 300000;
    const issue = await waitForManagedIssue(project.id, waitForWindow, restarted);

    expect(issue.description).toContain("Acceptance review summary.");
    expect((issue.assignees ?? []).map((user) => user.username)).toContain("root");
  });
});
