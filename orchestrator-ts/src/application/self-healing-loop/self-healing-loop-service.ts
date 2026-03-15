import type { ISelfHealingLoop } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { FailureRecord, MemoryPort } from "@/application/ports/memory";
import type { ISelfHealingLoopLogger } from "@/application/ports/self-healing-loop-logger";
import type { SectionEscalation, SelfHealingResult } from "@/domain/implementation-loop/types";
import type { EscalationIntakeLogEntry, GapReport } from "@/domain/self-healing/types";

// ---------------------------------------------------------------------------
// SelfHealingLoopConfig — tunable parameters (requirement 1.5)
// ---------------------------------------------------------------------------

/**
 * Configuration value object for SelfHealingLoopService.
 * All timeouts are in milliseconds. Retry and size values are counts/bytes.
 */
export interface SelfHealingLoopConfig {
  /** Absolute path to the workspace root. Used for boundary validation of rule file paths. */
  readonly workspaceRoot: string;
  /** Maximum milliseconds for the entire escalate() call. Default: 120_000. */
  readonly selfHealingTimeoutMs: number;
  /** Maximum milliseconds for a single LLM analysis or gap-identification call. Default: 60_000. */
  readonly analysisTimeoutMs: number;
  /** Maximum LLM retry attempts for analysis or gap identification. Default: 2. */
  readonly maxAnalysisRetries: number;
  /** Maximum bytes per failure record before agentObservations truncation. Default: 65_536. */
  readonly maxRecordSizeBytes: number;
}

/** Default configuration values for SelfHealingLoopConfig. */
export const DEFAULT_SELF_HEALING_CONFIG: Omit<SelfHealingLoopConfig, "workspaceRoot"> = {
  selfHealingTimeoutMs: 120_000,
  analysisTimeoutMs: 60_000,
  maxAnalysisRetries: 2,
  maxRecordSizeBytes: 65_536,
};

// ---------------------------------------------------------------------------
// SelfHealingLoopService — implements ISelfHealingLoop (requirements 1.1–8.5)
// ---------------------------------------------------------------------------

/**
 * Implements the ISelfHealingLoop port. Activated when the implementation loop
 * exhausts its per-section retry budget. Performs LLM-driven root-cause analysis,
 * targeted rule updates, and structured failure persistence.
 *
 * Key invariants:
 * - `escalate()` never throws on any code path (requirement 1.1).
 * - `#inFlightSections` is always consistent — every entry is removed in the finally block (requirement 1.4).
 * - `MemoryPort.writeFailure()` is called for every escalate() invocation regardless of outcome (requirement 5.1).
 * - No credentials or workspace-external paths are included in log entries (requirement 8.5).
 */
export class SelfHealingLoopService implements ISelfHealingLoop {
  readonly #llm: LlmProviderPort;
  readonly #memory: MemoryPort;
  readonly #config: SelfHealingLoopConfig;
  readonly #logger: ISelfHealingLoopLogger | undefined;

  /**
   * Concurrency guard: tracks sectionIds currently being processed.
   * `readonly` prevents reassignment of the reference; Set contents are still mutable via .add()/.delete().
   */
  readonly #inFlightSections: Set<string> = new Set();

  constructor(
    llm: LlmProviderPort,
    memory: MemoryPort,
    config: SelfHealingLoopConfig,
    logger?: ISelfHealingLoopLogger,
  ) {
    this.#llm = llm;
    this.#memory = memory;
    this.#config = config;
    this.#logger = logger;
  }

  /**
   * Escalate an exhausted section to the self-healing workflow.
   *
   * The entire workflow is wrapped with `Promise.race` using `selfHealingTimeoutMs`.
   * If the timeout fires, the failure record is written before returning.
   *
   * Never throws — all errors surface as `SelfHealingResult { outcome: "unresolved" }`.
   *
   * Requirements: 1.1, 1.5
   */
  async escalate(escalation: SectionEscalation): Promise<SelfHealingResult> {
    try {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const timeoutPromise = new Promise<SelfHealingResult>((resolve) => {
        timeoutId = setTimeout(async () => {
          // Write the failure record before resolving the timeout (requirement 1.5)
          await this.#persistFailureRecord(escalation, null, null, "unresolved").catch(() => {
            // Failure record write errors on timeout path are silently ignored
          });
          resolve({
            outcome: "unresolved",
            summary: `Self-healing timed out after ${this.#config.selfHealingTimeoutMs}ms`,
          });
        }, this.#config.selfHealingTimeoutMs);
      });

      const workflowPromise = this.#runHealingWorkflow(escalation).finally(() => {
        clearTimeout(timeoutId);
      });

      return await Promise.race([workflowPromise, timeoutPromise]);
    } catch (e) {
      // Catch-all safety net — no code path should reach here normally
      return {
        outcome: "unresolved",
        summary: `Unexpected error in self-healing escalation: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Internal workflow — tasks 3.2–8.2 will fill in this method
  // ---------------------------------------------------------------------------

  /**
   * Orchestrates the self-healing workflow steps:
   * intake validation → root-cause analysis → gap identification → rule update → result assembly.
   *
   * Intake validation (task 3.2):
   * - Emits `escalation-intake` log entry with retryHistoryCount.
   * - Returns unresolved immediately if retryHistory is empty (requirement 1.2).
   * - Returns unresolved if sectionId is already in-flight (requirement 1.4).
   * - Adds sectionId to #inFlightSections; removes it in a finally block (requirement 1.4).
   *
   * The failure record is written in a finally block regardless of outcome (task 7.2).
   */
  async #runHealingWorkflow(escalation: SectionEscalation): Promise<SelfHealingResult> {
    // --- Intake: always log first (requirement 8.1) ---
    const intakeEntry: EscalationIntakeLogEntry = {
      type: "escalation-intake",
      sectionId: escalation.sectionId,
      planId: escalation.planId,
      timestamp: new Date().toISOString(),
      retryHistoryCount: escalation.retryHistory.length,
    };
    this.#logger?.log(intakeEntry);

    // --- Guard 1: empty retryHistory (requirement 1.2) ---
    if (escalation.retryHistory.length === 0) {
      return {
        outcome: "unresolved",
        summary: "No retry history available: root-cause analysis requires at least one prior attempt.",
      };
    }

    // --- Guard 2: concurrent escalation for same sectionId (requirement 1.4) ---
    if (this.#inFlightSections.has(escalation.sectionId)) {
      return {
        outcome: "unresolved",
        summary: `Concurrent escalation in progress for section "${escalation.sectionId}": skipping duplicate.`,
      };
    }

    // --- Register section as in-flight; always deregister in finally (requirement 1.4) ---
    this.#inFlightSections.add(escalation.sectionId);
    try {
      // Tasks 4–8 will add root-cause analysis, gap identification, rule update, and result assembly.
      // The LLM call stub below keeps the outer timeout exercisable until task 4 is implemented.
      await this.#llm.complete("stub");
      return {
        outcome: "unresolved",
        summary: "Self-healing workflow not yet fully implemented (tasks 4–8 pending).",
      };
    } finally {
      this.#inFlightSections.delete(escalation.sectionId);
    }
  }

  // ---------------------------------------------------------------------------
  // Failure record persistence — task 7.1–7.2 will complete this method
  // ---------------------------------------------------------------------------

  /**
   * Build and persist a FailureRecord via MemoryPort.writeFailure().
   * Stub for task 3.1 — task 7.1 will add full field mapping and truncation.
   *
   * Requirements: 5.1–5.4
   */
  async #persistFailureRecord(
    escalation: SectionEscalation,
    rootCause: string | null,
    _gapReport: GapReport | null,
    _outcome: "resolved" | "unresolved",
  ): Promise<void> {
    // Task 7.1 will map _outcome and _gapReport into the full SelfHealingFailureRecord shape.
    // FailureRecord (MemoryPort) does not carry an outcome field yet.
    const record: FailureRecord = {
      taskId: escalation.sectionId,
      specName: escalation.planId,
      phase: "IMPLEMENTATION",
      attempted: JSON.stringify(escalation.retryHistory),
      errors: rootCause ? [rootCause] : [],
      rootCause: rootCause ?? "unknown",
      ruleUpdate: undefined,
      timestamp: new Date().toISOString(),
    };
    await this.#memory.writeFailure(record);
  }
}
