import { describe, expect, it } from "vitest";
import { verifyWorkspaceHostFilesystem } from "./fixtures/workspace-host-probe.js";

describe("native workspace filesystem (L14)", () => {
  it("uses host Unicode, long paths, case behavior and link boundaries", async () => {
    const result = await verifyWorkspaceHostFilesystem("build/tmp/workspace-fs");
    expect(result).toMatchObject({ platform: process.platform, unicode: true, longPath: true, distinctInstances: true, junctionBoundary: true });
  });
});
