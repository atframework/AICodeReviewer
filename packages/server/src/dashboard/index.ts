import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedHtml: string | undefined;

export function getDashboardHtml(): string {
  if (!cachedHtml) {
    cachedHtml = readFileSync(join(__dirname, "dashboard.html"), "utf8");
  }
  return cachedHtml;
}
