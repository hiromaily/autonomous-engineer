import type { ILogger, LogContext, LogLevel } from "@/application/ports/logger";
import { LOG_LEVEL_ORDER } from "@/application/ports/logger";
import { appendFileSync } from "node:fs";

/**
 * `ILogger` implementation that writes log entries as NDJSON to a file.
 *
 * - Entries below `minLevel` are silently suppressed.
 * - Each entry is written as a single JSON line: `{"level","ts","message","context?"}`.
 * - Uses synchronous `appendFileSync` so entries are written immediately without
 *   buffering or async coordination.
 * - Never throws from any method.
 */
export class NdjsonFileLogger implements ILogger {
  private readonly minLevelIndex: number;

  constructor(
    private readonly filePath: string,
    minLevel: LogLevel = "debug",
  ) {
    this.minLevelIndex = LOG_LEVEL_ORDER.indexOf(minLevel);
  }

  debug(message: string, context?: LogContext): void {
    this.write("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LOG_LEVEL_ORDER.indexOf(level) < this.minLevelIndex) return;

    try {
      const entry: Record<string, unknown> = {
        level,
        ts: new Date().toISOString(),
        message,
        ...(context !== undefined ? { context } : {}),
      };
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // Silently swallow all errors — logging must never crash the application
    }
  }
}
