import type {
  ExecutionHaltSummary,
  IImplementationLoopLogger,
  SectionIterationLogEntry,
} from "@/application/ports/implementation-loop";
import type { SectionExecutionRecord } from "@/domain/implementation-loop/types";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes structured NDJSON log entries for implementation loop execution.
 *
 * Each call to `logIteration`, `logSectionComplete`, or `logHaltSummary` appends
 * one JSON line to `.aes/logs/implementation-loop-<planId>.ndjson` (or the given logDir).
 *
 * - Never throws — all filesystem errors are silently swallowed.
 * - Each line is independently parseable (NDJSON / JSON Lines format).
 * - The `type` field distinguishes entry kinds: "iteration" | "section-complete" | "halt-summary".
 */
export class NdjsonImplementationLoopLogger implements IImplementationLoopLogger {
  readonly #logDir: string;
  readonly #planId: string;

  constructor(planId: string, logDir = ".aes/logs") {
    this.#planId = planId;
    this.#logDir = logDir;
  }

  get #logPath(): string {
    return join(this.#logDir, `implementation-loop-${this.#planId}.ndjson`);
  }

  logIteration(entry: SectionIterationLogEntry): void {
    this.#append({ type: "iteration", ...entry });
  }

  logSectionComplete(record: SectionExecutionRecord): void {
    this.#append({ type: "section-complete", ...record });
  }

  logHaltSummary(summary: ExecutionHaltSummary): void {
    this.#append({ type: "halt-summary", ...summary });
  }

  #append(entry: object): void {
    try {
      mkdirSync(this.#logDir, { recursive: true });
      appendFileSync(this.#logPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // Never throw — log failures must not disrupt the implementation loop.
    }
  }
}
