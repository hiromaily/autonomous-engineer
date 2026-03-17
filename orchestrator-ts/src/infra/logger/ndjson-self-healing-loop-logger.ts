import type { ISelfHealingLoopLogger } from "@/application/ports/self-healing-loop-logger";
import type { SelfHealingLogEntry } from "@/domain/self-healing/types";
import { appendNdjsonLine } from "@/infra/utils/ndjson";
import { join } from "node:path";

/**
 * Writes structured NDJSON log entries for each self-healing escalation.
 *
 * Each call to `log()` appends one JSON line to
 * `.aes/logs/self-healing-<planId>.ndjson` (or the given logDir) using an
 * async fire-and-forget write.  The write never blocks the caller and never
 * throws — all filesystem errors are captured in `writeErrorCount`.
 *
 * **Security invariants**:
 * - LLM API keys, credentials, and workspace-external paths must never be
 *   included in log entries before calling `log()`.  The logger itself
 *   serializes entries as-is; callers are responsible for sanitizing data.
 *
 * Requirements: 8.1, 8.3, 8.5
 */
export class NdjsonSelfHealingLoopLogger implements ISelfHealingLoopLogger {
  readonly #logDir: string;
  readonly #planId: string;
  #writeErrorCount = 0;

  constructor(planId: string, logDir = ".aes/logs") {
    this.#planId = planId;
    this.#logDir = logDir;
  }

  /** Number of write errors captured since construction (observable for diagnostics). */
  get writeErrorCount(): number {
    return this.#writeErrorCount;
  }

  get #logPath(): string {
    return join(this.#logDir, `self-healing-${this.#planId}.ndjson`);
  }

  /**
   * Emit one NDJSON line for the given log entry.
   *
   * The write is async fire-and-forget: the method returns `void` immediately
   * and the filesystem write proceeds in the background.  Errors are captured
   * in `writeErrorCount` and never propagated to callers.
   */
  log(entry: SelfHealingLogEntry): void {
    this.#append(entry);
  }

  #append(entry: object): void {
    appendNdjsonLine(this.#logPath, entry).catch(() => {
      this.#writeErrorCount++;
    });
  }
}
