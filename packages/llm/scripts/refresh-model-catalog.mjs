import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "node:https";

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, "../assets/model-catalog/models-dev.json");
const sourceUrl = process.env.AICR_MODEL_CATALOG_SOURCE_URL ?? "https://models.dev/api.json";

function isAllowedCatalogUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const allowedHosts = new Set([
    "models.dev",
    "www.models.dev",
    "raw.githubusercontent.com",
  ]);
  return allowedHosts.has(parsed.hostname);
}

function fetchJson(url) {
  if (!isAllowedCatalogUrl(url)) {
    throw new Error(`Refusing to fetch model catalog from untrusted URL: ${url}`);
  }
  return new Promise((resolvePromise, reject) => {
    let redirectCount = 0;
    const maxRedirects = 0;

    function doFetch(currentUrl) {
      if (redirectCount > maxRedirects) {
        reject(new Error(`Refusing to follow redirects when fetching ${url}`));
        return;
      }
      const req = get(
        currentUrl,
        {
          headers: { "User-Agent": "AICodeReviewer-model-catalog-refresh", Accept: "application/json" },
          timeout: 30000,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            redirectCount += 1;
            if (!isAllowedCatalogUrl(res.headers.location)) {
              reject(new Error(`Refusing to follow redirect to untrusted URL: ${res.headers.location}`));
              return;
            }
            doFetch(res.headers.location);
            res.resume();
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Unexpected status ${res.statusCode} fetching ${currentUrl}`));
            res.resume();
            return;
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            try {
              resolvePromise(JSON.parse(body));
            } catch (error) {
              reject(new Error(`Failed to parse JSON from ${currentUrl}: ${error.message}`));
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error(`Request timed out fetching ${currentUrl}`));
      });
    }

    doFetch(url);
  });
}

const json = await fetchJson(sourceUrl);

if (typeof json !== "object" || json === null || Array.isArray(json)) {
  throw new Error(`Unexpected models.dev api.json shape (expected object keyed by provider id)`);
}

let providerCount = 0;
let modelCount = 0;
for (const provider of Object.values(json)) {
  if (provider && typeof provider === "object" && provider.models && typeof provider.models === "object") {
    providerCount += 1;
    modelCount += Object.keys(provider.models).length;
  }
}

if (modelCount === 0) {
  throw new Error("models.dev api.json contained no models; refusing to write an empty snapshot.");
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(json, null, 0) + "\n", "utf8");

console.log(`model-catalog snapshot written: ${outputPath}`);
console.log(`  providers: ${providerCount}, models: ${modelCount}`);
