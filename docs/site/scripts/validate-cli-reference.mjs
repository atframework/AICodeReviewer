// Validate the docs-site CLI reference against the CLI implementation
// (docs/ai/documentation-site-plan.md §7 "CLI help 和文档命令示例一致性检
// 查", M11-P4).
//
// The CLI (packages/cli/src/app.ts) is a hand-rolled parseArgs dispatcher:
//   - accepted flags are the keys of the `parseArgs({ options: {...} })` object;
//   - dispatched commands are the `command === "<name>"` comparisons;
//   - `helpText` is the user-facing help string.
//
// This script extracts all three from source and checks, for both locales of
// reference/cli.md:
//   1. the Commands table matches the dispatched command set;
//   2. helpText lists exactly the accepted flags (stale or missing help rows
//      fail here first);
//   3. every flag mentioned in cli.md flag tables or examples exists in the
//      accepted flag set, and every accepted flag is documented.
//
// Extraction is deliberately regex-based over stable literal shapes; if the
// CLI moves to a framework (commander/yargs), replace this with import-based
// introspection.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appSource = readFileSync(
  fileURLToPath(new URL("../../../packages/cli/src/app.ts", import.meta.url)),
  "utf8",
);

const docsRoot = fileURLToPath(new URL("../src/content/docs/", import.meta.url));
const referencePages = ["en/reference/cli.md", "zh-cn/reference/cli.md"];

const violations = [];

// ---------------------------------------------------------------------------
// Extract accepted flags / dispatched commands / help text from app.ts
// ---------------------------------------------------------------------------

// Brace-depth scan for the `parseArgs({ options: {...} })` object literal; a
// plain `indexOf("},")` truncates at the first single-line option entry.
const optionsAnchor = appSource.indexOf("allowPositionals: true,");
const optionsObjectStart = appSource.indexOf("{", appSource.indexOf("options:", optionsAnchor));
let optionsObjectEnd = -1;
for (let depth = 0, i = optionsObjectStart; i < appSource.length; i += 1) {
  if (appSource[i] === "{") {
    depth += 1;
  } else if (appSource[i] === "}") {
    depth -= 1;
    if (depth === 0) {
      optionsObjectEnd = i;
      break;
    }
  }
}
if (optionsAnchor < 0 || optionsObjectEnd < 0) {
  throw new Error("Could not locate parseArgs options in packages/cli/src/app.ts; update this script.");
}
const optionsBlock = appSource.slice(optionsObjectStart, optionsObjectEnd + 1);
const acceptedFlags = new Set(
  [...optionsBlock.matchAll(/^\s*(?:"([a-z0-9-]+)"|([a-z0-9-]+)):\s*\{\s*type:/gmu)].map(
    (match) => match[1] ?? match[2],
  ),
);
if (acceptedFlags.size === 0) {
  throw new Error("Could not extract parseArgs options from packages/cli/src/app.ts; update this script.");
}

// `subcommand === "clear"` must not match, hence the word boundary.
const dispatchedCommands = new Set(
  [...appSource.matchAll(/\bcommand === "([a-z-]+)"/gu)].map((match) => match[1]),
);
if (dispatchedCommands.size === 0) {
  throw new Error("Could not extract dispatched commands from packages/cli/src/app.ts; update this script.");
}

const helpTextMatch = appSource.match(/const helpText = `([^`]+)`/u);
if (!helpTextMatch) {
  throw new Error("Could not extract helpText from packages/cli/src/app.ts; update this script.");
}
const helpText = helpTextMatch[1];

const helpCommands = new Set(
  [...helpText.matchAll(/^  ([a-z][a-z0-9-]*)\s{2,}\S/gmu)].map((match) => match[1]),
);
// Rows look like `  --config <path>   Description`, `  --dry-run   Desc`,
// or `  --help, -h   Desc`; capture long names only. Value flags may have a
// single space before the description (longest column), so accept `\s+`.
const helpFlags = new Set(
  [...helpText.matchAll(/^  --([a-z0-9-]+)(?: <[^>]+>)?(?:, -[a-z])?\s+\S/gmu)].map(
    (match) => match[1],
  ),
);

// helpText must list exactly the dispatched commands.
for (const command of dispatchedCommands) {
  if (!helpCommands.has(command)) {
    violations.push(`packages/cli/src/app.ts: command \`${command}\` is dispatched but missing from helpText`);
  }
}
for (const command of helpCommands) {
  if (!dispatchedCommands.has(command)) {
    violations.push(`packages/cli/src/app.ts: helpText lists \`${command}\` but it is never dispatched`);
  }
}

// helpText must list exactly the accepted flags.
for (const flag of acceptedFlags) {
  if (!helpFlags.has(flag)) {
    violations.push(`packages/cli/src/app.ts: flag \`--${flag}\` is accepted but missing from helpText`);
  }
}
for (const flag of helpFlags) {
  if (!acceptedFlags.has(flag)) {
    violations.push(`packages/cli/src/app.ts: helpText lists \`--${flag}\` but parseArgs rejects it`);
  }
}

// ---------------------------------------------------------------------------
// Parse reference/cli.md (both locales)
// ---------------------------------------------------------------------------

function extractDocFlags(source) {
  const flags = new Set();
  for (const match of source.matchAll(/`--([a-z0-9-]+)[^`]*`/gu)) {
    flags.add(match[1]);
  }
  return flags;
}

function extractDocCommands(source) {
  const commands = new Set();
  // Command rows look like: | [`serve`](#serve) | ... | or | `help` | ... |
  // inside the Commands table; `aicr <command>` occurrences in prose also
  // count. Only names followed by flag tables matter, so collect the linked
  // section headers (`## serve`) as the authoritative documented set.
  for (const match of source.matchAll(/^## ([a-z-]+)\s*$/gmu)) {
    commands.add(match[1]);
  }
  return commands;
}

const documentedCommandsByLocale = new Map();

for (const relativePath of referencePages) {
  const source = readFileSync(`${docsRoot}${relativePath}`, "utf8");

  const docCommands = extractDocCommands(source);
  documentedCommandsByLocale.set(relativePath, docCommands);
  for (const command of dispatchedCommands) {
    if (command !== "help" && !docCommands.has(command)) {
      violations.push(`${relativePath}: command \`${command}\` has no \`## ${command}\` section`);
    }
  }
  for (const command of docCommands) {
    if (command === "commands" || command === "global-options") {
      continue; // section headers that are not commands
    }
    if (!dispatchedCommands.has(command)) {
      violations.push(`${relativePath}: documented command \`${command}\` does not exist in the CLI`);
    }
  }

  const docFlags = extractDocFlags(source);
  for (const flag of docFlags) {
    if (!acceptedFlags.has(flag)) {
      violations.push(`${relativePath}: documented flag \`--${flag}\` is not accepted by the CLI`);
    }
  }
  for (const flag of acceptedFlags) {
    if (!docFlags.has(flag)) {
      violations.push(`${relativePath}: accepted flag \`--${flag}\` is not documented`);
    }
  }
}

// Locale parity: both pages document the same command sections.
const [enCommands, zhCommands] = [...documentedCommandsByLocale.values()];
for (const command of enCommands) {
  if (!zhCommands.has(command)) {
    violations.push(`zh-cn/reference/cli.md: command section \`${command}\` exists in en but not zh-cn`);
  }
}
for (const command of zhCommands) {
  if (!enCommands.has(command)) {
    violations.push(`en/reference/cli.md: command section \`${command}\` exists in zh-cn but not en`);
  }
}

if (violations.length > 0) {
  console.error("CLI reference validation failed:");
  for (const message of violations) {
    console.error(`- ${message}`);
  }
  process.exit(1);
}

console.log(
  `CLI reference OK: ${dispatchedCommands.size} commands and ${acceptedFlags.size} flags consistent across helpText and en + zh-cn reference pages.`,
);
