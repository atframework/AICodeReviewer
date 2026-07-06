import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const docsRoot = fileURLToPath(new URL("../src/content/docs/", import.meta.url));

// Guard the public/internal boundary called for by docs/ai/documentation-site-plan.md
// §1.1 / §4.0: internal AI/roadmap/architecture docs and maintenance metadata must
// not leak into published user pages. AGENTS.md and .agents/skills/ ARE allowed —
// the contributor guide legitimately points contributors to them.
const forbidden = [
  {
    pattern: /\bdocs\/ai\b/u,
    message: "internal AI/roadmap docs must not be referenced from public docs",
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
    } else if (entry.isFile() && (path.endsWith(".md") || path.endsWith(".mdx"))) {
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
