/**
 * Unified operational logging port.
 *
 * `ILogger` is the single logging contract consumed by all application and
 * infrastructure components.  Implementations must never throw from any method.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  readonly [key: string]: unknown;
}

export interface ILogger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

/**
 * Ordered array of log levels from lowest to highest severity.
 * Used by `isLevelEnabled` for threshold comparisons.
 */
export const LOG_LEVEL_ORDER: readonly LogLevel[] = ["debug", "info", "warn", "error"] as const;

/**
 * Returns `true` when `candidate` is at or above the `configured` severity.
 */
export function isLevelEnabled(configured: LogLevel, candidate: LogLevel): boolean {
  return LOG_LEVEL_ORDER.indexOf(candidate) >= LOG_LEVEL_ORDER.indexOf(configured);
}
