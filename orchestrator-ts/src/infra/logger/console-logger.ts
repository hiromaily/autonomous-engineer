import type { ILogger, LogContext, LogLevel } from "@/application/ports/logger";
import { LOG_LEVEL_ORDER } from "@/application/ports/logger";

// ANSI escape codes for TTY color output (per level prefix)
const ANSI_PREFIX: Record<LogLevel, string> = {
  debug: "\x1b[90m", // gray
  info: "\x1b[0m", // reset / default white
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
} as const;

const ANSI_RESET = "\x1b[0m";

// Pre-computed uppercase labels to avoid repeated toUpperCase() calls
const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "[DEBUG]",
  info: "[INFO]",
  warn: "[WARN]",
  error: "[ERROR]",
} as const;

/**
 * Concrete `ILogger` implementation that writes to `process.stderr`.
 *
 * - Entries below `minLevel` are silently suppressed.
 * - When `isTTY` is `true`, ANSI escape codes are applied per level.
 * - When `isTTY` is `false`, plain text is emitted: `[LEVEL] message { ...context }`.
 * - Never throws from any method.
 */
export class ConsoleLogger implements ILogger {
  private readonly minLevelIndex: number;
  private readonly isTTY: boolean;

  constructor(minLevel: LogLevel = "info", isTTY?: boolean) {
    this.minLevelIndex = LOG_LEVEL_ORDER.indexOf(minLevel);
    if (isTTY !== undefined) {
      this.isTTY = isTTY;
    } else if (process.env["NO_COLOR"] !== undefined) {
      this.isTTY = false;
    } else if (process.env["FORCE_COLOR"] !== undefined) {
      this.isTTY = true;
    } else {
      this.isTTY = process.stderr.isTTY === true;
    }
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
      const contextStr = context !== undefined ? ` ${JSON.stringify(context)}` : "";
      const body = `${LEVEL_LABEL[level]} ${message}${contextStr}`;
      const line = this.isTTY
        ? `${ANSI_PREFIX[level]}${body}${ANSI_RESET}\n`
        : `${body}\n`;

      process.stderr.write(line);
    } catch {
      // Silently swallow all errors — logging must never crash the application
    }
  }
}
