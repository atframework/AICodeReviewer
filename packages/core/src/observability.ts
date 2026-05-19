import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import pino, { type Logger, type LoggerOptions } from "pino";

export interface ObservabilityOptions {
  readonly serviceName?: string;
  readonly logLevel?: LoggerOptions["level"];
  readonly enableOtelDiagnostics?: boolean;
}

export function createDefaultLogger(options: ObservabilityOptions = {}): Logger {
  return pino({
    name: options.serviceName ?? "aicr",
    level: options.logLevel ?? "info",
  });
}

function parseOtelHeaders(raw?: string): Record<string, string> | undefined {
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx > 0) {
      headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

let otelDiagnosticsLoggerConfigured = false;

export function createOtelSdk(options: ObservabilityOptions = {}): NodeSDK {
  if (options.enableOtelDiagnostics && !otelDiagnosticsLoggerConfigured) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
    otelDiagnosticsLoggerConfigured = true;
  }

  const exporterOptions: { url?: string; headers?: Record<string, string> } = {};
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    exporterOptions.url = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  }
  const headers = parseOtelHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  if (headers) {
    exporterOptions.headers = headers;
  }

  const traceExporter = new OTLPTraceExporter(exporterOptions);

  return new NodeSDK({
    serviceName: options.serviceName ?? "aicr",
    traceExporter,
  });
}
