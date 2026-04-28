import { describe, expect, it } from "vitest";

import { createDefaultLogger, createOtelSdk } from "../src/observability.js";

describe("observability", () => {
  it("creates a pino logger with the configured service name and level", () => {
    const logger = createDefaultLogger({ serviceName: "aicr-test", logLevel: "debug" });

    expect(typeof logger.info).toBe("function");
    expect(logger.level).toBe("debug");
  });

  it("falls back to default service name and level", () => {
    const logger = createDefaultLogger();

    expect(typeof logger.warn).toBe("function");
    expect(logger.level).toBe("info");
  });

  it("constructs an OpenTelemetry SDK without throwing", () => {
    const sdk = createOtelSdk({ serviceName: "aicr-test" });
    expect(sdk).toBeDefined();
  });
});
