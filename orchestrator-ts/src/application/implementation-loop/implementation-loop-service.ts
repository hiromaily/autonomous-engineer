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
import type { TerminationCondition } from "@/domain/agent/types";
import type {
  ReviewFeedbackItem,
  ReviewResult,
  SectionExecutionRecord,
  SectionExecutionStatus,
  SectionIterationRecord,
} from "@/domain/implementation-loop/types";
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
  // Section execution — implement → review → improve → commit retry loop
  //
  // Each section runs a retry loop (bounded by maxRetriesPerSection):
  //   - First attempt: agent runs with the original task title as prompt
  //   - On review failure: retryCount++, build improve prompt from feedback
  //   - Each retry: emit section:improve-start, re-run agent with improve prompt
  //   - When retryCount reaches maxRetriesPerSection → escalate (section:escalated)
  //   - On review pass: detect changes, commit, emit section:completed
  // ---------------------------------------------------------------------------

  async #executeSection(
    task: Task,
    plan: TaskPlan,
    options: Required<ImplementationLoopOptions>,
  ): Promise<SectionExecutionRecord> {
    const sectionStartAt = new Date().toISOString();
    const sectionStartMs = Date.now();
    const iterations: SectionIterationRecord[] = [];
    let retryCount = 0;
    let improvePrompt: string | undefined;

    while (true) {
      const iterationNumber = iterations.length + 1;
      const iterationStartMs = Date.now();

      // Emit section:improve-start before each retry (not before the first attempt)
      if (improvePrompt !== undefined) {
        options.eventBus?.emit({
          type: "section:improve-start",
          sectionId: task.id,
          iteration: iterationNumber,
        });
      }

      // Invoke agent loop with improve prompt (or original task title on first attempt)
      const agentInput = improvePrompt ?? task.title;
      const agentResult = await this.#agentLoop.run(agentInput);
      const iterationDurationMs = Date.now() - iterationStartMs;

      // Non-TASK_COMPLETED termination → increment retry, possibly escalate
      if (!agentResult.taskCompleted) {
        const failureReview = buildAgentFailureReview(agentResult.terminationCondition);
        const iterRecord = buildIterationRecord(
          iterationNumber,
          failureReview,
          improvePrompt,
          iterationDurationMs,
          new Date().toISOString(),
        );
        iterations.push(iterRecord);
        retryCount++;

        options.logger?.logIteration({
          planId: plan.id,
          sectionId: task.id,
          iterationNumber,
          reviewOutcome: "failed",
          gateCheckResults: failureReview.checks,
          durationMs: iterationDurationMs,
          timestamp: iterRecord.timestamp,
        });

        if (retryCount >= options.maxRetriesPerSection) {
          return this.#escalateSection(
            task,
            plan,
            iterations,
            retryCount,
            sectionStartAt,
            options,
          );
        }

        improvePrompt = buildImprovePrompt(task.title, failureReview.feedback);
        continue;
      }

      // Review the agent output
      const reviewResult = await this.#reviewEngine.review(agentResult, task, options.qualityGateConfig);
      const iterRecord = buildIterationRecord(
        iterationNumber,
        reviewResult,
        improvePrompt,
        iterationDurationMs,
        new Date().toISOString(),
      );
      iterations.push(iterRecord);

      if (reviewResult.outcome === "passed") {
        // Emit review-passed signal
        options.eventBus?.emit({
          type: "section:review-passed",
          sectionId: task.id,
          iteration: iterationNumber,
        });

        // Build commit message including the section title
        const commitMessage = `feat: ${task.title}`;

        // Detect changed files and commit
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
          // Git failure → halt; no retry (risk of duplicate commits)
          await this.#planStore.updateSectionStatus(plan.id, task.id, "failed");
          return buildSectionRecord(
            task,
            plan.id,
            "failed",
            retryCount,
            iterations,
            sectionStartAt,
            undefined,
            `Git commit failed: ${commitResult.error.message}`,
          );
        }

        const commitSha = commitResult.value.hash;
        const sectionDurationMs = Date.now() - sectionStartMs;

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
          iterationNumber,
          reviewOutcome: "passed",
          gateCheckResults: reviewResult.checks,
          commitSha,
          durationMs: iterationDurationMs,
          timestamp: iterRecord.timestamp,
        });

        const completedRecord = buildSectionRecord(
          task,
          plan.id,
          "completed",
          retryCount,
          iterations,
          sectionStartAt,
          commitSha,
          undefined,
        );
        options.logger?.logSectionComplete(completedRecord);
        return completedRecord;
      }

      // Review failed — increment retry counter, emit event, possibly escalate
      retryCount++;

      options.eventBus?.emit({
        type: "section:review-failed",
        sectionId: task.id,
        iteration: iterationNumber,
        feedback: reviewResult.feedback,
      });

      options.logger?.logIteration({
        planId: plan.id,
        sectionId: task.id,
        iterationNumber,
        reviewOutcome: "failed",
        gateCheckResults: reviewResult.checks,
        durationMs: iterationDurationMs,
        timestamp: iterRecord.timestamp,
      });

      if (retryCount >= options.maxRetriesPerSection) {
        return this.#escalateSection(
          task,
          plan,
          iterations,
          retryCount,
          sectionStartAt,
          options,
        );
      }

      improvePrompt = buildImprovePrompt(task.title, reviewResult.feedback);
    }
  }

  // ---------------------------------------------------------------------------
  // Escalation when maxRetriesPerSection is exhausted
  // ---------------------------------------------------------------------------

  async #escalateSection(
    task: Task,
    plan: TaskPlan,
    iterations: ReadonlyArray<SectionIterationRecord>,
    retryCount: number,
    sectionStartAt: string,
    options: Required<ImplementationLoopOptions>,
  ): Promise<SectionExecutionRecord> {
    const escalationSummary = `Section escalated after ${retryCount} failed attempts`;

    options.eventBus?.emit({
      type: "section:escalated",
      sectionId: task.id,
      retryCount,
      reason: escalationSummary,
    });

    await this.#planStore.updateSectionStatus(plan.id, task.id, "failed");

    return buildSectionRecord(
      task,
      plan.id,
      "failed",
      retryCount,
      iterations,
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

function buildImprovePrompt(taskTitle: string, feedback: ReadonlyArray<ReviewFeedbackItem>): string {
  const feedbackLines = feedback
    .map((f) => `- [${f.severity}] ${f.description}`)
    .join("\n");
  return [
    `Improve the implementation of: ${taskTitle}`,
    ``,
    `The previous attempt did not pass review. Address the following feedback:`,
    feedbackLines || "- No specific feedback provided; review the implementation holistically.",
    ``,
    `Ensure all blocking issues are resolved before completing.`,
  ].join("\n");
}

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
