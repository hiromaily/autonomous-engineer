import type { AgentLoopResult, IAgentEventBus } from "@/application/ports/agent-loop";
import type { IContextEngine } from "@/application/ports/context";
import type {
  ImplementationLoopEvent,
  ReviewCheckResult,
  ReviewOutcome,
  ReviewResult,
  SectionEscalation,
  SectionExecutionRecord,
  SelfHealingResult,
} from "@/domain/implementation-loop/types";
import type { Task, TaskPlan } from "@/domain/planning/types";

// Re-export shared domain types for convenience so consumers can import from one place.
export type {
  ReviewCheckResult,
  ReviewFeedbackItem,
  ReviewOutcome,
  ReviewResult,
  SectionEscalation,
  SelfHealingResult,
} from "@/domain/implementation-loop/types";

// ---------------------------------------------------------------------------
// QualityGate types
// ---------------------------------------------------------------------------

/**
 * A single named quality gate check — describes the shell command to run,
 * whether failure blocks the commit, and an optional working directory.
 */
export type QualityGateCheck = Readonly<{
  /** Display name used in log entries and review check results. */
  name: string;
  /** Shell command to invoke (e.g., `"bun run lint"`, `"bun test"`). */
  command: string;
  /**
   * When `true`, a non-zero exit code causes `ReviewResult.outcome` to be `"failed"`.
   * When `false`, failure is captured as an advisory feedback item but does not block commit.
   */
  required: boolean;
  /** Optional working directory to run the command in. Defaults to process cwd when absent. */
  workingDirectory?: string;
}>;

/** Configuration for a set of named quality gate checks. */
export type QualityGateConfig = Readonly<{
  checks: ReadonlyArray<QualityGateCheck>;
}>;

// ---------------------------------------------------------------------------
// IQualityGate — port for running quality gate checks
// ---------------------------------------------------------------------------

/**
 * Port for executing a configured set of quality gate checks via the tool executor.
 * Implementations must never throw — all errors surface as `ReviewCheckResult` entries.
 */
export interface IQualityGate {
  /**
   * Run all checks in the given config.
   * Returns one `ReviewCheckResult` per check; never throws.
   */
  run(config: QualityGateConfig): Promise<ReadonlyArray<ReviewCheckResult>>;
}

// ---------------------------------------------------------------------------
// IReviewEngine — port for evaluating agent loop output
// ---------------------------------------------------------------------------

/**
 * Port for evaluating the output of an agent loop run against quality criteria.
 * Implementations must be stateless and must never commit side effects.
 */
export interface IReviewEngine {
  /**
   * Evaluate the agent loop result for a given task section.
   * Returns a `ReviewResult` covering requirement alignment, design consistency,
   * and code quality checks.
   * Never throws — LLM or tool failures surface as failed `ReviewResult` entries.
   */
  review(
    result: AgentLoopResult,
    section: Task,
    config: QualityGateConfig,
  ): Promise<ReviewResult>;
}

// ---------------------------------------------------------------------------
// SectionPersistenceStatus
// ---------------------------------------------------------------------------

/**
 * The set of status values that `IPlanStore` accepts for section state writes.
 * Includes `"escalated-to-human"` introduced by the implementation loop.
 */
export type SectionPersistenceStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "escalated-to-human";

// ---------------------------------------------------------------------------
// IPlanStore — port for reading and writing section execution state
// ---------------------------------------------------------------------------

/**
 * Port for reading task plans and persisting section execution status.
 *
 * **Write-Ownership Protocol**: `PlanFileStore` is the single physical writer for plan JSON files.
 * Write access is partitioned by execution phase:
 * - `TaskPlanningService` (spec7) writes during the `"planning"` phase.
 * - `ImplementationLoopService` (spec9) writes during the `"implementation"` phase.
 * These phases never run concurrently within a single `aes run` invocation, so no locking is required.
 *
 * **Deserialization tolerance**: Implementations must preserve unknown status values rather than
 * coercing them, so that `TaskPlanningService` does not corrupt implementation-loop state if it
 * ever re-reads a plan after the implementation phase completes.
 */
export interface IPlanStore {
  /**
   * Load the task plan with the given ID.
   * Returns `null` when no plan with that ID exists in the store.
   */
  loadPlan(planId: string): Promise<TaskPlan | null>;

  /**
   * Update the execution status of a single section within the given plan.
   * Never throws — persistence failures are logged but do not propagate.
   */
  updateSectionStatus(
    planId: string,
    sectionId: string,
    status: SectionPersistenceStatus,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// SectionIterationLogEntry and ExecutionHaltSummary
// ---------------------------------------------------------------------------

/**
 * Structured log entry emitted for each implement-review-improve cycle.
 * Must be fully JSON-serializable (no circular refs, no functions).
 */
export type SectionIterationLogEntry = Readonly<{
  planId: string;
  sectionId: string;
  /** 1-based iteration counter for this section. */
  iterationNumber: number;
  reviewOutcome: ReviewOutcome;
  gateCheckResults: ReadonlyArray<ReviewCheckResult>;
  /** Git commit SHA, present only when this iteration resulted in a commit. */
  commitSha?: string;
  durationMs: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
}>;

/**
 * Consolidated summary emitted when the implementation loop halts due to escalation or failure.
 * Must be fully JSON-serializable.
 */
export type ExecutionHaltSummary = Readonly<{
  planId: string;
  /** IDs of all sections that reached `"completed"` status before the halt. */
  completedSections: ReadonlyArray<string>;
  /** IDs of all sections whose changes were committed to git before the halt. */
  committedSections: ReadonlyArray<string>;
  /** The section whose failure triggered the halt. */
  haltingSectionId: string;
  /** Human-readable description of why the loop halted. */
  reason: string;
  /** ISO 8601 timestamp of the halt event. */
  timestamp: string;
}>;

// ---------------------------------------------------------------------------
// IImplementationLoopLogger — port for structured logging
// ---------------------------------------------------------------------------

/**
 * Port for structured, per-iteration and per-section execution logging.
 * Implementations write NDJSON to `.aes/logs/implementation-loop-<planId>.ndjson`.
 * A no-op implementation is provided for tests.
 *
 * Invariant: all entry types must be JSON-serializable (no functions, no circular refs).
 * Preconditions: none — all methods are always safe to call.
 */
export interface IImplementationLoopLogger {
  /** Record the outcome of a single implement-review-improve iteration. */
  logIteration(entry: SectionIterationLogEntry): void;

  /** Record the final state of a section that reached a terminal status. */
  logSectionComplete(record: SectionExecutionRecord): void;

  /** Record a consolidated halt summary when the loop stops before completing all sections. */
  logHaltSummary(summary: ExecutionHaltSummary): void;
}

// ---------------------------------------------------------------------------
// IImplementationLoopEventBus — port for lifecycle event emission
// ---------------------------------------------------------------------------

/**
 * Port for emitting implementation-loop lifecycle events to the workflow engine.
 *
 * Ordering guarantee: events are emitted synchronously; implementations must not buffer or drop events.
 * Consumed by `WorkflowEngine` for `plan:completed` and `plan:halted` transitions.
 */
export interface IImplementationLoopEventBus {
  /** Emit an implementation-loop lifecycle event synchronously. */
  emit(event: ImplementationLoopEvent): void;
}

// ---------------------------------------------------------------------------
// ISelfHealingLoop — optional port for spec10 escalation
// ---------------------------------------------------------------------------

/**
 * Optional port for escalating exhausted task sections to the spec10 self-healing loop.
 *
 * This port is optional: `ImplementationLoopService` receives `ISelfHealingLoop | undefined`
 * and falls back gracefully when absent (marks section as `"failed"`, emits `plan:halted`).
 */
export interface ISelfHealingLoop {
  /**
   * Escalate an exhausted section to the self-healing loop.
   * Returns a `SelfHealingResult` indicating whether the issue was resolved.
   * On `"resolved"`: retry counter is reset and updated rules are injected into context.
   * On `"unresolved"`: section is marked `"escalated-to-human"` and the loop halts.
   */
  escalate(escalation: SectionEscalation): Promise<SelfHealingResult>;
}

// ---------------------------------------------------------------------------
// ImplementationLoopOptions
// ---------------------------------------------------------------------------

/**
 * Configuration for a single implementation loop run.
 * All fields except `maxRetriesPerSection` and `qualityGateConfig` are optional.
 */
export type ImplementationLoopOptions = Readonly<{
  /** Max implement-review-improve cycles per section before escalation. Default: 3. */
  maxRetriesPerSection: number;
  /** Named quality gate checks to run after each implement step. */
  qualityGateConfig: QualityGateConfig;
  /** Optional spec10 self-healing loop; when absent, exhausted sections halt with `"section-failed"`. */
  selfHealingLoop?: ISelfHealingLoop;
  /** Optional event bus; when absent, lifecycle events are silently dropped. */
  eventBus?: IImplementationLoopEventBus;
  /** Optional structured logger; when absent, log entries are silently dropped. */
  logger?: IImplementationLoopLogger;
  /**
   * Optional spec6 context engine. When provided:
   * - `resetTask(sectionId)` is called at the start of each section to isolate context.
   * - A `contextProvider` adapter is passed to `IAgentLoop.run()` so the agent loop
   *   queries the context engine for PLAN-step context.
   * When absent, no context isolation is performed and no `contextProvider` is injected.
   */
  contextEngine?: IContextEngine;
  /**
   * Optional agent event bus forwarded to every AgentLoopService.run() call.
   * Used by debug-flow to capture per-iteration agent loop events.
   * When absent, no IAgentEventBus is passed to the agent loop.
   */
  agentEventBus?: IAgentEventBus;
}>;

// ---------------------------------------------------------------------------
// ImplementationLoopOutcome and ImplementationLoopResult
// ---------------------------------------------------------------------------

/**
 * Terminal outcome of a single implementation loop run.
 * All reachable sections must be in a terminal state before a non-`"stopped"` result is returned.
 */
export type ImplementationLoopOutcome =
  | "completed"
  | "section-failed"
  | "human-intervention-required"
  | "stopped"
  | "plan-not-found";

/**
 * Returned on every termination path.
 * Postcondition: `outcome = "completed"` only when all sections reach `"completed"` status.
 */
export type ImplementationLoopResult = Readonly<{
  outcome: ImplementationLoopOutcome;
  planId: string;
  /** Final state snapshots for all sections that were processed. */
  sections: ReadonlyArray<SectionExecutionRecord>;
  durationMs: number;
  /** Human-readable description of why the loop halted; present on non-`"completed"` outcomes. */
  haltReason?: string;
}>;

// ---------------------------------------------------------------------------
// IImplementationLoop — public port for the implementation loop service
// ---------------------------------------------------------------------------

/**
 * Public contract for running and resuming the implementation loop.
 *
 * Preconditions: `planId` must reference a plan persisted by `IPlanStore`.
 * Postconditions: All reachable sections are in a terminal state; plan state is persisted.
 * Invariants:
 *   - A `review-passed` signal is required before any commit.
 *   - The retry counter per section is non-decreasing.
 *   - Never throws — all errors surface as `ImplementationLoopResult` outcome variants.
 */
export interface IImplementationLoop {
  /**
   * Execute the implementation loop for the given plan from the beginning.
   * Sections already in `"completed"` status are skipped.
   */
  run(planId: string, options?: Partial<ImplementationLoopOptions>): Promise<ImplementationLoopResult>;

  /**
   * Resume an interrupted implementation loop for the given plan.
   * Sections in `"in_progress"` state at startup are reset to `"pending"` before re-execution.
   */
  resume(planId: string, options?: Partial<ImplementationLoopOptions>): Promise<ImplementationLoopResult>;

  /** Signal graceful stop; the loop halts at the next section boundary. */
  stop(): void;
}
