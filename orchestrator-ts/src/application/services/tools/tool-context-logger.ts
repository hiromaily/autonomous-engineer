import type { ILogger } from "@/application/ports/logger";
import type { Logger, ToolInvocationLog } from "@/domain/tools/types";

/**
 * Adapts `ILogger` to the `Logger` interface consumed by `ToolContext`.
 *
 * - `Logger.info(entry)` → `ILogger.debug(...)` — successful invocations are debug-level data
 * - `Logger.error(entry)` with `resultStatus === "runtime"` → `ILogger.error(...)`
 * - `Logger.error(entry)` with any other status → `ILogger.warn(...)`
 */
export class ToolContextLogger implements Logger {
  constructor(private readonly logger: ILogger) {}

  info(entry: ToolInvocationLog): void {
    this.logger.debug(`tool:${entry.toolName}`, {
      inputSummary: entry.inputSummary,
      durationMs: entry.durationMs,
      outputSize: entry.outputSize,
    });
  }

  error(entry: ToolInvocationLog): void {
    const level = entry.resultStatus === "runtime" ? "error" : "warn";
    this.logger[level](`tool:${entry.toolName} failed`, {
      inputSummary: entry.inputSummary,
      durationMs: entry.durationMs,
      errorMessage: entry.errorMessage,
      resultStatus: entry.resultStatus,
    });
  }
}
