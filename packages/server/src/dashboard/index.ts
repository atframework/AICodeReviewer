import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DASHBOARD_ENABLED_PLACEHOLDER = "__AICR_DASHBOARD_ENABLED__";
const DASHBOARD_DISABLED_MESSAGE_PLACEHOLDER = "__AICR_DASHBOARD_DISABLED_MESSAGE__";
const DEFAULT_DISABLED_MESSAGE = "Observability dashboard is not configured. Set AICR_ADMIN_USERNAME with AICR_ADMIN_PASSWORD or AICR_ADMIN_PASSWORD_HASH, then restart the server.";

let cachedTemplate: string | undefined;

export interface DashboardHtmlOptions {
  readonly enabled: boolean;
  readonly disabledMessage?: string;
}

function getDashboardTemplate(): string {
  if (!cachedTemplate) {
    cachedTemplate = readFileSync(join(__dirname, "dashboard.html"), "utf8");
  }
  return cachedTemplate;
}

export function getDashboardHtml(options: DashboardHtmlOptions = { enabled: true }): string {
  return getDashboardTemplate()
    .replaceAll(DASHBOARD_ENABLED_PLACEHOLDER, options.enabled ? "true" : "false")
    .replaceAll(
      DASHBOARD_DISABLED_MESSAGE_PLACEHOLDER,
      JSON.stringify(options.disabledMessage ?? DEFAULT_DISABLED_MESSAGE),
    );
}
