import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DASHBOARD_ENABLED_PLACEHOLDER = "__AICR_DASHBOARD_ENABLED__";
const DASHBOARD_DISABLED_MESSAGE_PLACEHOLDER = "__AICR_DASHBOARD_DISABLED_MESSAGE__";
const DEFAULT_DISABLED_MESSAGE = "The admin dashboard is not configured. Set AICR_ADMIN_USERNAME with AICR_ADMIN_PASSWORD or AICR_ADMIN_PASSWORD_HASH, then restart the server.";

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

export interface DashboardClientAsset {
  readonly content: string;
  readonly contentType: string;
}

/** Strict allowlist: flat lowercase names only — no separators, no traversal. */
const CLIENT_ASSET_NAME_PATTERN = /^[a-z0-9-]+\.js$/u;
const CLIENT_ASSET_CONTENT_TYPE = "application/javascript; charset=utf-8";

const clientAssetCache = new Map<string, DashboardClientAsset | null>();

/**
 * Serves a compiled dashboard client module from `dist/dashboard/client`
 * (produced by the build copy step). Names outside the allowlist and files
 * absent from disk — e.g. unbuilt dev checkouts — both yield null so the
 * route can answer 404 without exposing filesystem detail.
 */
export function getDashboardClientAsset(name: string, baseDir: string = join(__dirname, "client")): DashboardClientAsset | null {
  if (!CLIENT_ASSET_NAME_PATTERN.test(name)) return null;
  const cacheKey = `${baseDir}\n${name}`;
  const cached = clientAssetCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let asset: DashboardClientAsset | null;
  try {
    asset = { content: readFileSync(join(baseDir, name), "utf8"), contentType: CLIENT_ASSET_CONTENT_TYPE };
  } catch {
    asset = null;
  }
  clientAssetCache.set(cacheKey, asset);
  return asset;
}
