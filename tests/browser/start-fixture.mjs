/**
 * Browser-fixture launcher (P6; P7 run isolation leg). Resets the throwaway
 * SQLite store, pre-seeds the workspace git clone the real VCS adapter diffs
 * against, hosts the in-process stub gitea services (stub-services.mjs), and
 * starts the real CLI server with the stub agent CLIs on PATH so the
 * Playwright gate exercises production wiring end to end.
 * Invoked by playwright.config.ts webServer; not part of the shipped package.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startStubServices } from "./stub-services.mjs";

// Playwright launches this with the config directory as CWD: resolve every
// path from the repository root explicitly.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = join(repoRoot, "build", "tmp", "browser");
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

// ---------------------------------------------------------------------------
// Pre-seed the legacy-layout workspace clone for default-project/acme_app.
// The real GitVcsAdapter treats this as the remote-tracking clone: it re-points
// origin at the stub gitea (http://127.0.0.1:9399/acme/app.git), fetches (the
// stub advertises zero refs → no-op), then resolves base/head LOCALLY for
// `git diff` / `git show`. Fixed commit metadata keeps the SHAs deterministic;
// the spec reads them from fixture-shas.json for its webhook payload.
// ---------------------------------------------------------------------------
const fixtureRepoDir = join(repoRoot, "workspaces", "default-project", "source", "acme_app");
rmSync(fixtureRepoDir, { recursive: true, force: true });
mkdirSync(fixtureRepoDir, { recursive: true });
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "AICR Browser Fixture",
  GIT_AUTHOR_EMAIL: "browser-fixture@aicr.local",
  GIT_COMMITTER_NAME: "AICR Browser Fixture",
  GIT_COMMITTER_EMAIL: "browser-fixture@aicr.local",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
const git = (args) => execFileSync("git", args, { cwd: fixtureRepoDir, env: gitEnv, encoding: "utf8" }).trim();
git(["init", "-b", "main"]);
git(["config", "core.autocrlf", "false"]);
mkdirSync(join(fixtureRepoDir, "src"), { recursive: true });
// src/index.ts (not a root file) so the change still matches a published
// review.include like ["src/**/*.ts"] left over by config-ui.spec.ts.
writeFileSync(join(fixtureRepoDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
git(["add", "src/index.ts"]);
git(["commit", "-m", "base commit"]);
const baseSha = git(["rev-parse", "HEAD"]);
writeFileSync(join(fixtureRepoDir, "src", "index.ts"), "export const value = 2;\n", "utf8");
git(["add", "src/index.ts"]);
git(["commit", "-m", "head commit"]);
const headSha = git(["rev-parse", "HEAD"]);
git(["remote", "add", "origin", "http://127.0.0.1:9399/acme/app.git"]);
writeFileSync(join(tmpDir, "fixture-shas.json"), `${JSON.stringify({ baseSha, headSha }, null, 2)}\n`, "utf8");

// Stub gitea services must accept connections before the server child's first
// VCS fetch or channel POST.
const stubServices = await startStubServices();

// Stub agent CLI directory. POSIX resolves the committed extensionless shims;
// Windows cannot spawn `.cmd` shims by bare name (libuv only resolves the
// exact name + `.exe`), so on Windows the committed stub-launcher.c is
// compiled once per launch into kilo.exe / opencode.exe, which forward to the
// shared .mjs stubs. Requires clang on PATH (scoop llvm on this workstation).
const stubBinSource = join(repoRoot, "tests", "browser", "fixtures", "stub-bin");
let stubBinDir = stubBinSource;
if (process.platform === "win32") {
  stubBinDir = join(tmpDir, "stub-bin-win");
  mkdirSync(stubBinDir, { recursive: true });
  const launcherSource = join(stubBinSource, "stub-launcher.c");
  for (const name of ["kilo", "opencode"]) {
    execFileSync("clang", [launcherSource, "-O2", "-o", join(stubBinDir, `${name}.exe`)], { stdio: "inherit" });
  }
}

// Windows env keys are case-insensitive: adding a fresh "PATH" next to the
// inherited "Path" would leave the agent child with whichever spelling the
// loader happens to keep (the one without the stubs → spawn kilo ENOENT).
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const env = {
  ...process.env,
  AICR_ADMIN_USERNAME: "admin",
  AICR_ADMIN_PASSWORD: "browser-test-password",
  AICR_BROWSER_LLM_KEY: "browser-dummy-llm-key",
  AICR_BROWSER_GIT_TOKEN: "browser-dummy-git-token",
  AICR_BROWSER_GIT_SECRET: "browser-dummy-git-secret",
  AICR_BROWSER_GIT_SECRET_PREVIEW: "browser-dummy-git-secret-preview",
  // Stub agent CLIs (kilo/opencode) shadow any real installation for the
  // native-sandbox agent path; the agent child inherits this PATH and the
  // invocation-log / release-flag locations through the sandbox spawn env.
  [pathKey]: `${stubBinDir}${process.platform === "win32" ? ";" : ":"}${process.env[pathKey] ?? ""}`,
  AICR_STUB_BIN_DIR: stubBinSource,
  AICR_STUB_AGENT_LOG: join(tmpDir, "stub-agent.log"),
  AICR_STUB_RELEASE_FILE: join(tmpDir, "release.flag"),
};

const child = spawn(
  process.execPath,
  [join(repoRoot, "packages", "cli", "dist", "index.js"), "serve", "--config", join(repoRoot, "tests", "browser", "fixtures", "config.yaml")],
  { env, stdio: "inherit", cwd: repoRoot },
);

const shutdown = (code) => {
  void stubServices.close().finally(() => process.exit(code));
};
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => shutdown(code ?? 1));
