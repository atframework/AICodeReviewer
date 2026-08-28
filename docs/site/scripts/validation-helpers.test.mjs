import assert from "node:assert/strict";
import test from "node:test";

import {
  displayWidth,
  extractFencedBlocks,
  extractFrontmatter,
  extractMachineTokens,
  frontmatterValue,
  isSchemaLeafDocumented,
  pngDimensions,
  resolveRelativeRoute,
  stripCommentLines,
} from "./validation-helpers.mjs";

test("schema coverage only accepts exact rows or explicit subtree summaries", () => {
  const fields = new Set(["llm.retry"]);
  const summaries = new Set(["llm.model_catalog.overrides"]);

  assert.equal(isSchemaLeafDocumented("llm.retry.max_attempts", fields, summaries), false);
  assert.equal(
    isSchemaLeafDocumented("llm.model_catalog.overrides.<id>.context_window", fields, summaries),
    true,
  );
  fields.add("llm.retry.max_attempts");
  assert.equal(isSchemaLeafDocumented("llm.retry.max_attempts", fields, summaries), true);
});

test("relative routes keep the source directory for index pages", () => {
  assert.equal(
    resolveRelativeRoute("/en/development/", true, "../reference/cli/"),
    "/en/reference/cli/",
  );
  assert.equal(
    resolveRelativeRoute("/en/", true, "./start/quick-start/"),
    "/en/start/quick-start/",
  );
});


test("display width counts East-Asian characters double", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("存储"), 4);
  assert.equal(displayWidth("配置 storage"), 4 + 1 + 7);
  assert.equal(displayWidth("常见问题。"), 10);
});

test("frontmatter extraction handles CRLF and quotes", () => {
  const source = "---\r\ntitle: 存储\r\ndescription: \"配置 storage\"\r\n---\r\n\r\nbody";
  const fm = extractFrontmatter(source);
  assert.equal(frontmatterValue(fm, "title"), "存储");
  assert.equal(frontmatterValue(fm, "description"), "配置 storage");
  assert.equal(extractFrontmatter("no frontmatter"), null);
  assert.equal(frontmatterValue(fm, "missing"), undefined);
});

test("fenced blocks expose language tag and body", () => {
  const blocks = extractFencedBlocks("```yaml\nserver:\r\n  host: 0.0.0.0\r\n```\n\n```\nbare\n```\n");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].info, "yaml");
  assert.equal(blocks[1].info, "");
  assert.ok(blocks[0].body.includes("server:"));
});

test("machine tokens ignore comments and translated prose", () => {
  const en = stripCommentLines("AICR_WEBHOOK_SECRET=x # shared secret\nserver:\n  host: 0.0.0.0");
  const zh = stripCommentLines("AICR_WEBHOOK_SECRET=x # 与 webhook 共享\nserver:\n  host: 0.0.0.0");
  assert.deepEqual(extractMachineTokens(en), extractMachineTokens(zh));

  const drifted = stripCommentLines("AICR_WEBHOOK_SECRET=x\nservers:\n  host: 0.0.0.0");
  assert.notDeepEqual(extractMachineTokens(en), extractMachineTokens(drifted));
});

test("machine tokens collect keys, env vars, flags, and paths", () => {
  const tokens = extractMachineTokens("kind: github\n--mode json\nAICR_API_KEY=k\n/webhooks/gitea");
  assert.deepEqual(tokens, [
    "env:AICR_API_KEY",
    "flag:--mode",
    "key:kind",
    "path:/webhooks/gitea",
  ]);
});

test("png dimensions read the IHDR chunk and reject non-PNG input", () => {
  // Minimal valid 1x1 PNG.
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
      "01f15c4890000000d4944415478da6360000002000154a24f6d0" +
      "000000049454e44ae426082",
    "hex",
  );
  assert.deepEqual(pngDimensions(png), { width: 1, height: 1 });
  assert.equal(pngDimensions(Buffer.from("not a png")), null);
});

test("relative routes drop the page slug for non-index pages", () => {
  assert.equal(
    resolveRelativeRoute("/en/configuration/llm/", false, "./outputs/"),
    "/en/configuration/outputs/",
  );
});
