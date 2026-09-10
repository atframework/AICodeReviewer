import { createMemoryAutoCommitStore } from "../src/memory-auto-commit-store.js";

import { runAutoCommitStoreConformance } from "./auto-commit-store-conformance.js";

runAutoCommitStoreConformance({
  backendKind: "memory",
  makeStore: () => createMemoryAutoCommitStore(),
});
