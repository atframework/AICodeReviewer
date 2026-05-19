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

  it("constructs an OpenTelemetry SDK with diagnostics enabled", () => {
    const sdk = createOtelSdk({ serviceName: "aicr-test", enableOtelDiagnostics: true });
    expect(sdk).toBeDefined();
  });

  it("creates a logger with trace level", () => {
    const logger = createDefaultLogger({ logLevel: "trace" });
    expect(logger.level).toBe("trace");
  });

  it("creates a logger with warn level", () => {
    const logger = createDefaultLogger({ logLevel: "warn" });
    expect(logger.level).toBe("warn");
  });

  it("creates a logger with error level", () => {
    const logger = createDefaultLogger({ logLevel: "error" });
    expect(logger.level).toBe("error");
  });

  it("creates a logger with fatal level", () => {
    const logger = createDefaultLogger({ logLevel: "fatal" });
    expect(logger.level).toBe("fatal");
  });

  it("constructs SDK with both serviceName and diagnostics", () => {
    const sdk = createOtelSdk({ serviceName: "full-test", enableOtelDiagnostics: true });
    expect(sdk).toBeDefined();
  });

  it("constructs SDK with OTLP exporter from environment variables", () => {
    const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const originalHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer test";

    try {
      const sdk = createOtelSdk({ serviceName: "otel-env-test" });
      expect(sdk).toBeDefined();
    } finally {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
      process.env.OTEL_EXPORTER_OTLP_HEADERS = originalHeaders;
    }
  });
});
