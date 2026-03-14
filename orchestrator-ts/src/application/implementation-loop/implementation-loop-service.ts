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
  // Section execution — implement → review → commit (single iteration)
  //
  // Task 4.2: runs one implement→review→commit cycle.
  // Task 4.3: wraps this in a retry loop with improve prompts.
  // ---------------------------------------------------------------------------

  async #executeSection(
    task: Task,
    plan: TaskPlan,
    options: Required<ImplementationLoopOptions>,
  ): Promise<SectionExecutionRecord> {
    const sectionStartAt = new Date().toISOString();
    const iterationStartMs = Date.now();

    // Step 1: Invoke the agent loop for implementation
    const agentResult = await this.#agentLoop.run(task.title);
    const iterationDurationMs = Date.now() - iterationStartMs;

    // Step 2: Non-TASK_COMPLETED termination → treat as section failure
    if (!agentResult.taskCompleted) {
      const failureReview = buildAgentFailureReview(agentResult.terminationCondition);
      const iterRecord = buildIterationRecord(1, failureReview, undefined, iterationDurationMs, sectionStartAt);
      await this.#planStore.updateSectionStatus(plan.id, task.id, "failed");
      return buildSectionRecord(
        task,
        plan.id,
        "failed",
        1,
        [iterRecord],
        sectionStartAt,
        undefined,
        `Agent loop terminated: ${agentResult.terminationCondition}`,
      );
    }

    // Step 3: Invoke the review engine to evaluate agent output
    const reviewResult = await this.#reviewEngine.review(agentResult, task, options.qualityGateConfig);
    const iterRecord = buildIterationRecord(1, reviewResult, undefined, iterationDurationMs, sectionStartAt);

    if (reviewResult.outcome === "passed") {
      // Step 4a: Emit review-passed signal
      options.eventBus?.emit({ type: "section:review-passed", sectionId: task.id, iteration: 1 });

      // Step 4b: Build commit message including the section title
      const commitMessage = `feat: ${task.title}`;

      // Step 4c: Detect changed files and commit
      const changesResult = await this.#gitController.detectChanges();
      const files: string[] = changesResult.ok
        ? [
          ...changesResult.value.staged,
          ...changesResult.value.unstaged,
          ...changesResult.value.untracked,
        ]
        : [];

      const commitResult = await this.#gitController.stageAndCommit(files, commitMessage);

      if (!commitResult.ok) {
        // Git failure → halt; do not retry automatically (risk of duplicate commits)
        await this.#planStore.updateSectionStatus(plan.id, task.id, "failed");
        return buildSectionRecord(
          task,
          plan.id,
          "failed",
          0,
          [iterRecord],
          sectionStartAt,
          undefined,
          `Git commit failed: ${commitResult.error.message}`,
        );
      }

      const commitSha = commitResult.value.hash;
      const sectionDurationMs = Date.now() - iterationStartMs;

      // Step 4d: Persist completed status and emit events
      await this.#planStore.updateSectionStatus(plan.id, task.id, "completed");

      options.eventBus?.emit({
        type: "section:completed",
        sectionId: task.id,
        commitSha,
        durationMs: sectionDurationMs,
      });

      options.logger?.logIteration({
        planId: plan.id,
        sectionId: task.id,
        iterationNumber: 1,
        reviewOutcome: "passed",
        gateCheckResults: reviewResult.checks,
        commitSha,
        durationMs: iterationDurationMs,
        timestamp: sectionStartAt,
      });

      const completedRecord = buildSectionRecord(
        task,
        plan.id,
        "completed",
        0,
        [iterRecord],
        sectionStartAt,
        commitSha,
        undefined,
      );
      options.logger?.logSectionComplete(completedRecord);
      return completedRecord;
    }

    // Step 5: Review failed — task 4.3 wraps this in a retry loop
    options.eventBus?.emit({
      type: "section:review-failed",
      sectionId: task.id,
      iteration: 1,
      feedback: reviewResult.feedback,
    });

    await this.#planStore.updateSectionStatus(plan.id, task.id, "failed");
    const escalationSummary = reviewResult.feedback.map((f) => f.description).join("; ")
      || "Review did not pass";
    return buildSectionRecord(
      task,
      plan.id,
      "failed",
      1,
      [iterRecord],
      sectionStartAt,
      undefined,
      escalationSummary,
    );
  }

  // ---------------------------------------------------------------------------
  // Halt path helper
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
}

// ---------------------------------------------------------------------------
// Module-level builder helpers
// ---------------------------------------------------------------------------

import type { TerminationCondition } from "@/domain/agent/types";
import type { ReviewResult, SectionIterationRecord } from "@/domain/implementation-loop/types";

function buildAgentFailureReview(condition: TerminationCondition): ReviewResult {
  return {
    outcome: "failed",
    checks: [
      {
        checkName: "agent-loop",
        outcome: "failed",
        required: true,
        details: `Agent loop terminated with: ${condition}`,
      },
    ],
    feedback: [
      {
        category: "requirement-alignment",
        description: `Agent loop did not complete the task (termination: ${condition})`,
        severity: "blocking",
      },
    ],
    durationMs: 0,
  };
}

function buildIterationRecord(
  iterationNumber: number,
  reviewResult: ReviewResult,
  improvePrompt: string | undefined,
  durationMs: number,
  timestamp: string,
): SectionIterationRecord {
  return {
    iterationNumber,
    reviewResult,
    ...(improvePrompt !== undefined ? { improvePrompt } : {}),
    durationMs,
    timestamp,
  };
}

function buildSectionRecord(
  task: Task,
  planId: string,
  status: SectionExecutionStatus,
  retryCount: number,
  iterations: ReadonlyArray<SectionIterationRecord>,
  startedAt: string,
  commitSha: string | undefined,
  escalationSummary: string | undefined,
): SectionExecutionRecord {
  return {
    sectionId: task.id,
    planId,
    title: task.title,
    status,
    retryCount,
    iterations,
    startedAt,
    completedAt: new Date().toISOString(),
    ...(commitSha !== undefined ? { commitSha } : {}),
    ...(escalationSummary !== undefined ? { escalationSummary } : {}),
  };
}
