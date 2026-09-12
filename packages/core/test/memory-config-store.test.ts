import { describe } from "vitest";

import { createMemoryConfigStore } from "../src/config-store.js";

import { runConfigStoreConformance } from "./config-store-conformance.js";

describe("memory config store", () => {
  runConfigStoreConformance({
    backendKind: "memory",
    makeStore: () => createMemoryConfigStore(),
  });
});
