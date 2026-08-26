import assert from "node:assert/strict";
import test from "node:test";

import { isSchemaLeafDocumented, resolveRelativeRoute } from "./validation-helpers.mjs";

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

test("relative routes drop the page slug for non-index pages", () => {
  assert.equal(
    resolveRelativeRoute("/en/configuration/llm/", false, "./outputs/"),
    "/en/configuration/outputs/",
  );
});
