import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const docsRoot = fileURLToPath(new URL("../src/content/docs/", import.meta.url));

const forbidden = [
  {
    pattern: /\bdocs\/ai\b/u,
    message: "internal AI/roadmap docs must not be referenced from public docs",
  },
  {
    pattern: /\bAGENTS\.md\b/u,
    message: "AI-facing repository guidance must be rewritten before publishing",
  },
  {
    pattern: /\.agents\//u,
    message: "agent skill paths must not be referenced from public docs",
  },
  {
    pattern: /\bMigration sources?:|迁移来源/u,
    message: "migration-source notes are maintenance metadata, not user docs",
  },
];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile() && path.endsWith(".md")) {
      yield path;
    }
  }
}

const violations = [];

for (const file of walk(docsRoot)) {
  const displayPath = relative(process.cwd(), file).replaceAll("\\", "/");
  const lines = readFileSync(file, "utf8").split(/\r?\n/u);

  for (const [index, line] of lines.entries()) {
    for (const rule of forbidden) {
      if (rule.pattern.test(line)) {
        violations.push(`${displayPath}:${index + 1}: ${rule.message}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Public documentation content validation failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}
