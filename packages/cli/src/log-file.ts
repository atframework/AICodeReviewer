import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

const DEFAULT_LOG_FILE = "aicr.log";
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const DEFAULT_MAX_AGE_DAYS = 7;

export interface RotatingFileWriterOptions {
  readonly logDir: string;
  readonly fileName?: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly maxAgeDays?: number;
  readonly now?: () => Date;
}

export interface FileLogTeeEnvironment {
  readonly AICR_LOG_DIR?: string;
  readonly AICR_LOG_FILE?: string;
  readonly AICR_LOG_MAX_SIZE_BYTES?: string;
  readonly AICR_LOG_MAX_FILES?: string;
  readonly AICR_LOG_MAX_AGE_DAYS?: string;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/gu, "-");
}

function toBuffer(chunk: string | Uint8Array): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
}

export class RotatingFileWriter {
  private readonly logDir: string;
  private readonly fileName: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly maxAgeMs: number;
  private readonly now: () => Date;
  private readonly currentPath: string;
  private readonly rotatedPrefix: string;
  private readonly rotatedSuffix: string;
  private currentSize: number;

  constructor(options: RotatingFileWriterOptions) {
    this.logDir = options.logDir;
    this.fileName = options.fileName ?? DEFAULT_LOG_FILE;
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
    this.maxAgeMs = Math.max(1, options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.currentPath = join(this.logDir, this.fileName);

    const extension = extname(this.fileName);
    const base = extension ? this.fileName.slice(0, -extension.length) : this.fileName;
    this.rotatedPrefix = `${base}-`;
    this.rotatedSuffix = extension;

    mkdirSync(this.logDir, { recursive: true });
    this.currentSize = existsSync(this.currentPath) ? statSync(this.currentPath).size : 0;
    this.cleanup();
  }

  write(chunk: string | Uint8Array): void {
    const buffer = toBuffer(chunk);
    let offset = 0;

    while (offset < buffer.length) {
      if (this.currentSize >= this.maxBytes || this.currentFileExpired()) {
        this.rotate();
      }

      const available = Math.max(1, this.maxBytes - this.currentSize);
      const slice = buffer.subarray(offset, Math.min(buffer.length, offset + available));
      appendFileSync(this.currentPath, slice);
      this.currentSize += slice.length;
      offset += slice.length;
    }
  }

  cleanup(): void {
    const cutoffMs = this.now().getTime() - this.maxAgeMs;
    for (const file of this.listRotatedFiles()) {
      if (file.mtimeMs < cutoffMs) {
        unlinkSync(file.path);
      }
    }

    const rotatedFiles = this.listRotatedFiles()
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const rotatedCapacity = Math.max(0, this.maxFiles - 1);
    for (const file of rotatedFiles.slice(rotatedCapacity)) {
      unlinkSync(file.path);
    }
  }

  private rotate(): void {
    if (existsSync(this.currentPath) && statSync(this.currentPath).size > 0) {
      const targetPath = this.nextRotatedPath();
      renameSync(this.currentPath, targetPath);
    }

    this.currentSize = 0;
    this.cleanup();
  }

  private currentFileExpired(): boolean {
    if (!existsSync(this.currentPath) || this.currentSize === 0) {
      return false;
    }

    return statSync(this.currentPath).mtimeMs < this.now().getTime() - this.maxAgeMs;
  }

  private nextRotatedPath(): string {
    const stamp = timestampForFile(this.now());
    let candidate = join(this.logDir, `${this.rotatedPrefix}${stamp}${this.rotatedSuffix}`);
    let suffix = 1;
    while (existsSync(candidate)) {
      candidate = join(this.logDir, `${this.rotatedPrefix}${stamp}-${suffix}${this.rotatedSuffix}`);
      suffix += 1;
    }
    return candidate;
  }

  private listRotatedFiles(): Array<{ readonly path: string; readonly mtimeMs: number }> {
    return readdirSync(this.logDir, { withFileTypes: true })
      .filter((entry) =>
        entry.isFile() &&
        entry.name.startsWith(this.rotatedPrefix) &&
        entry.name.endsWith(this.rotatedSuffix),
      )
      .map((entry) => {
        const path = join(this.logDir, entry.name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      });
  }
}

let installed = false;

export function installFileLogTeeFromEnv(
  env: FileLogTeeEnvironment = process.env,
): RotatingFileWriter | undefined {
  if (installed) {
    return undefined;
  }

  const rawFile = env.AICR_LOG_FILE ?? DEFAULT_LOG_FILE;
  const fileHasDirectory = rawFile.includes("/") || rawFile.includes("\\") || isAbsolute(rawFile);
  const logDir = env.AICR_LOG_DIR ?? (fileHasDirectory ? dirname(rawFile) : undefined);
  if (!logDir) {
    return undefined;
  }

  const writer = new RotatingFileWriter({
    logDir,
    fileName: basename(rawFile),
    maxBytes: parsePositiveInteger(env.AICR_LOG_MAX_SIZE_BYTES, DEFAULT_MAX_BYTES),
    maxFiles: parsePositiveInteger(env.AICR_LOG_MAX_FILES, DEFAULT_MAX_FILES),
    maxAgeDays: parsePositiveInteger(env.AICR_LOG_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS),
  });

  const originalStdoutWrite = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;
  const originalStderrWrite = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
  let warned = false;

  function writeFileCopy(chunk: unknown): void {
    try {
      if (typeof chunk === "string" || chunk instanceof Uint8Array) {
        writer.write(chunk);
      }
    } catch (error) {
      if (!warned) {
        warned = true;
        originalStderrWrite(`AICR file logging failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    writeFileCopy(chunk);
    return originalStdoutWrite(chunk, ...args);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    writeFileCopy(chunk);
    return originalStderrWrite(chunk, ...args);
  }) as typeof process.stderr.write;

  installed = true;
  return writer;
}
