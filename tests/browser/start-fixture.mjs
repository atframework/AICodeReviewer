/**
 * Browser-fixture launcher (P6). Resets the throwaway SQLite store and starts
 * the real CLI server so the Playwright gate exercises production wiring.
 * Invoked by playwright.config.ts webServer; not part of the shipped package.
 */
import { rmSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Playwright launches this with the config directory as CWD: resolve every
// path from the repository root explicitly.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = join(repoRoot, "build", "tmp", "browser");
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const env = {
  ...process.env,
  AICR_ADMIN_USERNAME: "admin",
  AICR_ADMIN_PASSWORD: "browser-test-password",
  AICR_BROWSER_LLM_KEY: "browser-dummy-llm-key",
  AICR_BROWSER_GIT_TOKEN: "browser-dummy-git-token",
  AICR_BROWSER_GIT_SECRET: "browser-dummy-git-secret",
};

const child = spawn(
  process.execPath,
  [join(repoRoot, "packages", "cli", "dist", "index.js"), "serve", "--config", join(repoRoot, "tests", "browser", "fixtures", "config.yaml")],
  { env, stdio: "inherit", cwd: repoRoot },
);

process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code ?? 1));
