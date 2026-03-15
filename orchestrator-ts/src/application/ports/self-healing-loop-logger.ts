import type { SelfHealingLogEntry } from "@/domain/self-healing/types";

// ---------------------------------------------------------------------------
// ISelfHealingLoopLogger — application port for structured logging
// ---------------------------------------------------------------------------

/**
 * Application port for structured, per-escalation logging in the self-healing loop.
 *
 * Concrete adapters write NDJSON entries to `.aes/logs/self-healing-<planId>.ndjson`
 * using async fire-and-forget writes. They must never throw or propagate write errors
 * to callers — all write failures must be captured internally (e.g. via a counter).
 *
 * **Usage contract for `SelfHealingLoopService`**:
 * The logger is optional. The service holds `ISelfHealingLoopLogger | undefined`
 * and calls `this.#logger?.log(entry)` — never accessing the logger without the
 * optional-chaining guard. This ensures the service never throws when no logger
 * is injected.
 *
 * **Invariants**:
 * - `log()` is always safe to call — implementations must never throw.
 * - All entry types must be JSON-serializable (no functions, no circular refs).
 * - Implementations must not include LLM API keys, credentials, or
 *   workspace-external paths in serialized entries.
 *
 * Requirements: 8.1, 8.3
 */
export interface ISelfHealingLoopLogger {
  /**
   * Emit a structured log entry for the current escalation step.
   *
   * The concrete adapter writes the entry as an NDJSON line via async
   * `appendFile` (never `appendFileSync`). Write errors are captured
   * internally and never re-thrown or forwarded to the caller.
   *
   * @param entry - One of the seven discriminated log entry shapes.
   */
  log(entry: SelfHealingLogEntry): void;
}
