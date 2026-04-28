import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
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

export function createOtelSdk(options: ObservabilityOptions = {}): NodeSDK {
  if (options.enableOtelDiagnostics) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  return new NodeSDK({
    serviceName: options.serviceName ?? "aicr",
  });
}