// Explicit local opt-in only. Vitest itself never reads development secrets.
import { execFileSync, spawn } from "node:child_process";

const [service, protocol = "openai_compatible"] = process.argv.slice(2);
if (!["feishu", "zhipu", "kimi"].includes(service) ||
    !["openai_compatible", "anthropic"].includes(protocol) || process.argv.length > 4) {
  throw new Error("Usage: node tests/services/with-local-secrets.mjs feishu|zhipu|kimi [openai_compatible|anthropic]");
}
const env = { ...process.env };
function secret(field) {
  try {
    return execFileSync(process.platform === "win32" ? "yq.exe" : "yq",
      ["-er", `${field} | select(tag == "!!str" and length > 0)`, "development/secret/secret.yaml"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, windowsHide: true }).trim();
  } catch {
    throw new Error(`Cannot read required secret field ${field}; check yq and the local secret file.`);
  }
}
let test;
if (service === "feishu") {
  for (const [name, field] of Object.entries({
    APP_ID: "app_id", APP_SECRET: "app_secret", RECEIVE_ID: "receive_id",
  })) env[`AICR_FEISHU_TEST_${name}`] = secret(`.channel.feishu_app.${field}`);
  test = "packages/outputs/test/feishu-app-live.test.ts";
} else {
  const prefix = `AICR_${service.toUpperCase()}_TEST_`;
  const field = service === "zhipu" ? "zhipu" : "kimi_coding_backup";
  let baseUrl = secret(`.llm.provider.${field}.baseURL`).replace(/\/+$/u, "");
  if (protocol === "anthropic") {
    const pairs = {
      "https://open.bigmodel.cn/api/coding/paas/v4": "https://open.bigmodel.cn/api/anthropic",
      "https://api.kimi.com/coding/v1": "https://api.kimi.com/coding",
    };
    if (!pairs[baseUrl]) throw new Error("Unknown protocol mapping; export the test environment explicitly.");
    baseUrl = pairs[baseUrl];
  }
  env[`${prefix}BASE_URL`] = baseUrl;
  env[`${prefix}API_KEY`] = secret(`.llm.provider.${field}.token`);
  env[`${prefix}KIND`] = protocol;
  // Keep each manual invocation limited to its selected provider.
  for (const key of Object.keys(env)) {
    if (key.startsWith(`AICR_${service === "zhipu" ? "KIMI" : "ZHIPU"}_TEST_`)) delete env[key];
  }
  test = "packages/llm/test/providers-live.test.ts";
}
const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", test, "--maxWorkers=1", "--reporter=verbose", "--silent=false"],
  { env, stdio: "inherit", windowsHide: true });
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
