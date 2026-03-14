import type { IAgentLoop } from "@/application/ports/agent-loop";
import type { IGitController } from "@/application/ports/git-controller";
import type {
  IImplementationLoop,
  ImplementationLoopOptions,
  ImplementationLoopOutcome,
  ImplementationLoopResult,
  IPlanStore,
  IReviewEngine,
} from "@/application/ports/implementation-loop";
import type { SectionExecutionRecord, SectionExecutionStatus } from "@/domain/implementation-loop/types";
import type { Task, TaskPlan } from "@/domain/planning/types";

// ---------------------------------------------------------------------------
// Default option values
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: Required<ImplementationLoopOptions> = {
  maxRetriesPerSection: 3,
  qualityGateConfig: { checks: [] },
  selfHealingLoop: undefined as never,
  eventBus: undefined as never,
  logger: undefined as never,
};

function resolveOptions(
  partial: Partial<ImplementationLoopOptions>,
): Required<ImplementationLoopOptions> {
  return { ...DEFAULT_OPTIONS, ...partial };
}

// ---------------------------------------------------------------------------
// ImplementationLoopService
// ---------------------------------------------------------------------------

/**
 * Orchestrates section iteration, review, retry, commit, and escalation.
 *
 * - Implements IImplementationLoop; all step logic is in private methods.
 * - All dependencies are constructor-injected; no direct external imports.
 * - The stop flag (#stopRequested) is the only mutable class-level state.
 * - Never throws from run() or resume() — all errors surface as result outcomes.
 *
 * Execution order (per section):
 *   1. Check stop signal at each section boundary → return "stopped" if set
 *   2. Write status "in_progress" to IPlanStore
 *   3. Execute implement→review→commit cycle (#executeSection — task 4.2+)
 *   4. On success: add to completedSectionIds, continue
 *   5. On failure/escalation: emit plan:halted, return halt result
 *   6. After all sections complete: emit plan:completed, return "completed"
 */
export class ImplementationLoopService implements IImplementationLoop {
  readonly #planStore: IPlanStore;
  readonly #agentLoop: IAgentLoop;
  readonly #reviewEngine: IReviewEngine;
  readonly #gitController: IGitController;

  /** Set to true by stop(); checked at each section boundary. */
  #stopRequested = false;

  constructor(
    planStore: IPlanStore,
    agentLoop: IAgentLoop,
    reviewEngine: IReviewEngine,
    gitController: IGitController,
  ) {
    this.#planStore = planStore;
    this.#agentLoop = agentLoop;
    this.#reviewEngine = reviewEngine;
    this.#gitController = gitController;
  }

  /**
   * Execute the implementation loop for the given plan from the beginning.
   * Sections already in "completed" status are skipped.
   */
  async run(
    planId: string,
    options?: Partial<ImplementationLoopOptions>,
  ): Promise<ImplementationLoopResult> {
    // Snapshot the stop flag before resetting it for the new run.
    // This ensures a pre-run stop() call is honored while still allowing
    // subsequent run() calls to proceed normally.
    const wasStopRequested = this.#stopRequested;
    this.#stopRequested = false;
    if (wasStopRequested) {
      return {
        outcome: "stopped",
        planId,
        sections: [],
        durationMs: 0,
        haltReason: "Stop signal received",
      };
    }
    return this.#execute(planId, options ?? {}, false);
  }

  /**
   * Resume an interrupted implementation loop.
   * Sections in "in_progress" state at startup are reset to "pending" before re-execution.
   */
  async resume(
    planId: string,
    options?: Partial<ImplementationLoopOptions>,
  ): Promise<ImplementationLoopResult> {
    const wasStopRequested = this.#stopRequested;
    this.#stopRequested = false;
    if (wasStopRequested) {
      return {
        outcome: "stopped",
        planId,
        sections: [],
        durationMs: 0,
        haltReason: "Stop signal received",
      };
    }
    return this.#execute(planId, options ?? {}, true);
  }

  /** Signal graceful stop; the loop halts at the next section boundary. */
  stop(): void {
    this.#stopRequested = true;
  }

  // ---------------------------------------------------------------------------
  // Core execution loop
  // ---------------------------------------------------------------------------

  async #execute(
    planId: string,
    options: Partial<ImplementationLoopOptions>,
    isResume: boolean,
  ): Promise<ImplementationLoopResult> {
    const startedAt = Date.now();
    const resolved = resolveOptions(options);

    // Load plan from store
    const plan = await this.#planStore.loadPlan(planId);
    if (plan === null) {
      return {
        outcome: "plan-not-found",
        planId,
        sections: [],
        durationMs: Date.now() - startedAt,
        haltReason: `No plan found with ID: ${planId}`,
      };
    }

    // On resume: reset any in_progress sections to pending
    if (isResume) {
      for (const task of plan.tasks) {
        if (task.status === "in_progress") {
          await this.#planStore.updateSectionStatus(planId, task.id, "pending");
        }
      }
    }

    // Track which sections have completed during this run
    const completedSectionIds = new Set<string>(
      plan.tasks.filter((t) => t.status === "completed").map((t) => t.id),
    );

    const sectionRecords: SectionExecutionRecord[] = [];

    // Iterate sections in plan order (sequential dependency)
    for (const task of plan.tasks) {
      // Skip already-completed sections
      if (completedSectionIds.has(task.id)) {
        continue;
      }

      // Check stop signal at each section boundary
      if (this.#stopRequested) {
        return {
          outcome: "stopped",
          planId,
          sections: sectionRecords,
          durationMs: Date.now() - startedAt,
          haltReason: "Stop signal received",
        };
      }

      // Write in_progress before beginning the section
      await this.#planStore.updateSectionStatus(planId, task.id, "in_progress");

      // Emit section:start event
      resolved.eventBus?.emit({
        type: "section:start",
        sectionId: task.id,
        timestamp: new Date().toISOString(),
      });

      // Execute the implement→review→commit cycle for this section
      const record = await this.#executeSection(task, plan, resolved);
      sectionRecords.push(record);

      if (record.status === "completed") {
        completedSectionIds.add(task.id);
      } else {
        // Section failed or escalated — halt immediately
        return this.#buildHaltResult(plan, record, sectionRecords, resolved, startedAt);
      }
    }

    // All sections reached terminal state
    const durationMs = Date.now() - startedAt;

    resolved.eventBus?.emit({
      type: "plan:completed",
      planId,
      completedSections: [...completedSectionIds],
      durationMs,
    });

    return {
      outcome: "completed",
      planId,
      sections: sectionRecords,
      durationMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Section execution (implement→review→improve→commit)
  //
  // Task 4.1: minimal stub — marks section as completed.
  // Tasks 4.2–4.3: replaces this stub with the full cycle.
  // ---------------------------------------------------------------------------

  async #executeSection(
    task: Task,
    plan: TaskPlan,
    _options: Required<ImplementationLoopOptions>,
  ): Promise<SectionExecutionRecord> {
    const timestamp = new Date().toISOString();

    // Stub: mark section as completed in the store
    await this.#planStore.updateSectionStatus(plan.id, task.id, "completed");

    return {
      sectionId: task.id,
      planId: plan.id,
      title: task.title,
      status: "completed" satisfies SectionExecutionStatus,
      retryCount: 0,
      iterations: [],
      startedAt: timestamp,
      completedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Halt path helpers
  // ---------------------------------------------------------------------------

  #buildHaltResult(
    plan: TaskPlan,
    haltingRecord: SectionExecutionRecord,
    sectionRecords: ReadonlyArray<SectionExecutionRecord>,
    options: Required<ImplementationLoopOptions>,
    startedAt: number,
  ): ImplementationLoopResult {
    const completedSections = sectionRecords
      .filter((r) => r.status === "completed")
      .map((r) => r.sectionId);

    const committedSections = sectionRecords
      .filter((r) => r.commitSha !== undefined)
      .map((r) => r.sectionId);

    const haltReason = haltingRecord.escalationSummary ?? "Section execution failed";

    options.logger?.logHaltSummary({
      planId: plan.id,
      completedSections,
      committedSections,
      haltingSectionId: haltingRecord.sectionId,
      reason: haltReason,
      timestamp: new Date().toISOString(),
    });

    options.eventBus?.emit({
      type: "plan:halted",
      planId: plan.id,
      haltingSectionId: haltingRecord.sectionId,
      summary: haltReason,
    });

    const outcome: ImplementationLoopOutcome = haltingRecord.status === "escalated-to-human"
      ? "human-intervention-required"
      : "section-failed";

    return {
      outcome,
      planId: plan.id,
      sections: sectionRecords,
      durationMs: Date.now() - startedAt,
      haltReason,
    };
  }

  // ---------------------------------------------------------------------------
  // Unused injected dependencies — retained for task 4.2+
  // ---------------------------------------------------------------------------

  /** @internal accessed by task 4.2 implementation of #executeSection */
  protected get _agentLoop(): IAgentLoop {
    return this.#agentLoop;
  }

  /** @internal accessed by task 4.2 implementation of #executeSection */
  protected get _reviewEngine(): IReviewEngine {
    return this.#reviewEngine;
  }

  /** @internal accessed by task 4.2 implementation of #executeSection */
  protected get _gitController(): IGitController {
    return this.#gitController;
  }
}
