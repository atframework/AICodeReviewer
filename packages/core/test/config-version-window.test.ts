import { describe, expect, it } from "vitest";

import { parseEffectiveConfig } from "../src/config.js";
import { validateDatabaseDocument } from "../src/config-source.js";
import { prepareConfigPublication } from "../src/config-publish.js";

describe("configuration reader/writer window", () => {
  it.each([0, -1, 1.5, 3, Number.NaN, Number.POSITIVE_INFINITY])("rejects unsupported format %s before reading or preparing a write", (formatVersion) => {
    for (const run of [
      () => validateDatabaseDocument({}, formatVersion),
      () => parseEffectiveConfig({}, formatVersion),
      () => prepareConfigPublication({ namespace: "test", baseRevision: null, operationId: "bad-version", actor: "test",
        fileDigest: "a".repeat(64), current: {}, operations: [], formatVersion }),
    ]) {
      expect(run).toThrowError(expect.objectContaining({ code: "unsupported_config_version" }));
    }
  });

  it.each([1, 2])("preserves supported document format %s", (version) => {
    expect(validateDatabaseDocument({}, version)).toEqual({});
  });
});
