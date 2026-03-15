import type { IAgentLoop, IContextProvider } from "@/application/ports/agent-loop";
import type { IContextEngine } from "@/application/ports/context";
import type { IGitController } from "@/application/ports/git-controller";
import type {
  IImplementationLoop,
  ImplementationLoopOptions,
  ImplementationLoopOutcome,
  ImplementationLoopResult,
  IPlanStore,
  IReviewEngine,
} from "@/application/ports/implementation-loop";
import type { AgentState, Observation, TerminationCondition } from "@/domain/agent/types";
import type {
  ReviewFeedbackItem,
  ReviewResult,
  SectionEscalation,
  SectionExecutionRecord,
  SectionExecutionStatus,
  SectionIterationRecord,
  SectionSummary,
  SelfHealingResult,
} from "@/domain/implementation-loop/types";
import type { Task, TaskPlan } from "@/domain/planning/types";

// ---------------------------------------------------------------------------
// Internal discriminated union for escalation results
// ---------------------------------------------------------------------------

/**
 * Returned by `#escalateSection` to indicate what the retry loop should do next.
 * - `"halt"`: stop executing this section and propagate the record upward.
 * - `"retry"`: the self-healing loop resolved the issue; reset retryCount and continue.
 */
type EscalationDecision =
  | { action: "halt"; record: SectionExecutionRecord }
  | { action: "retry"; improvePrompt: string };

// ---------------------------------------------------------------------------
// Default option values
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: Required<ImplementationLoopOptions> = {
  maxRetriesPerSection: 3,
  qualityGateConfig: { checks: [] },
  selfHealingLoop: undefined as never,
  eventBus: undefined as never,
  logger: undefined as never,
  contextEngine: undefined as never,
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
   * Execute the implementation loop for the given plan.
   * Sections in "completed" status are skipped. Sections in "in_progress" status
   * (left over from a crashed previous run) are reset to "pending" and re-executed.
   */
  async run(
    planId: string,
    options?: Partial<ImplementationLoopOptions>,
  ): Promise<ImplementationLoopResult> {
    const stopped = this.#consumeStopSignal(planId);
    if (stopped) return stopped;
    return this.#execute(planId, options ?? {});
  }

  /**
   * Resume an interrupted implementation loop.
   * Equivalent to run() — both reset "in_progress" sections and skip "completed" ones.
   * Provided as a semantic alternative so callers can express intent explicitly.
   */
  async resume(
    planId: string,
    options?: Partial<ImplementationLoopOptions>,
  ): Promise<ImplementationLoopResult> {
    const stopped = this.#consumeStopSignal(planId);
    if (stopped) return stopped;
    return this.#execute(planId, options ?? {});
  }

  /** Signal graceful stop; the loop halts at the next section boundary. */
  stop(): void {
    this.#stopRequested = true;
  }

  /**
   * Atomically reads and clears the stop flag.
   * Returns a "stopped" result if the flag was set, null otherwise.
   * Shared by run() and resume() to avoid duplicating the early-exit logic.
   */
  #consumeStopSignal(planId: string): ImplementationLoopResult | null {
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
    return null;
  }

  // ---------------------------------------------------------------------------
  // Core execution loop
  // ---------------------------------------------------------------------------

  async #execute(
    planId: string,
    options: Partial<ImplementationLoopOptions>,
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

    // Reset any in_progress sections to pending — applies to both run() and resume().
    // If a process was killed mid-section, the section remains "in_progress" in the
    // store. Resetting it to "pending" before re-executing ensures the section is
    // treated as incomplete and re-run cleanly rather than being skipped. This is
    // the sole startup read from IPlanStore; no in-memory state survives across runs.
    for (const task of plan.tasks) {
      if (task.status === "in_progress") {
        await this.#planStore.updateSectionStatus(planId, task.id, "pending");
      }
    }

    // Track which sections have completed during this run
    const completedSectionIds = new Set<string>(
      plan.tasks.filter((t) => t.status === "completed").map((t) => t.id),
    );

    const sectionRecords: SectionExecutionRecord[] = [];

    // Cross-section state: summaries of completed sections (section ID, title, commit SHA).
    // Used by the contextProvider adapter to include previous-section context.
    const completedSummaries: SectionSummary[] = plan.tasks
      .filter((t) => t.status === "completed")
      .map((t) => ({ sectionId: t.id, title: t.title }));

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
      const record = await this.#executeSection(task, plan, resolved, completedSummaries);
      sectionRecords.push(record);

      if (record.status === "completed") {
        completedSectionIds.add(task.id);
        // Update cross-section summaries so subsequent sections have context
        completedSummaries.push({
          sectionId: task.id,
          title: task.title,
          ...(record.commitSha !== undefined ? { commitSha: record.commitSha } : {}),
        });
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
    completedSummaries: ReadonlyArray<SectionSummary>,
  ): Promise<SectionExecutionRecord> {
    const sectionStartAt = new Date().toISOString();
    const sectionStartMs = Date.now();
    const iterations: SectionIterationRecord[] = [];
    let retryCount = 0;
    let improvePrompt: string | undefined;
    // Requirement 6.4: track whether self-healing was already attempted and resolved for this
    // section. On a second budget exhaustion, skip re-escalation and go straight to
    // "escalated-to-human" so the loop never calls ISelfHealingLoop.escalate() twice.
    let hasHealed = false;

    // Accumulated across all iterations for escalation payloads (task 4.7).
    const allObservations: Observation[] = [];
    const allFeedback: ReviewFeedbackItem[] = [];

    // Context isolation: reset the context engine at section start so accumulated
    // context from the previous section is discarded. The contextProvider built here
    // is reused for ALL iterations (implement + improve) of this section so that
    // context accumulates within the section rather than being reset on each retry.
    options.contextEngine?.resetTask(task.id);
    const contextProvider: IContextProvider | undefined = options.contextEngine
      ? buildContextProvider(options.contextEngine, plan.id, task.id, completedSummaries)
      : undefined;

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

      // Invoke agent loop with improve prompt (or original task title on first attempt).
      // Pass the pre-built contextProvider so the agent loop queries the context engine.
      const agentInput = improvePrompt ?? task.title;
      const agentResult = await this.#agentLoop.run(
        agentInput,
        contextProvider !== undefined ? { contextProvider } : undefined,
      );
      const iterationDurationMs = Date.now() - iterationStartMs;

      // Accumulate agent observations across all attempts for escalation payloads.
      allObservations.push(...agentResult.finalState.observations);

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
        allFeedback.push(...failureReview.feedback);
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
          const decision = await this.#escalateSection(
            task,
            plan,
            iterations,
            retryCount,
            sectionStartAt,
            options,
            allObservations,
            allFeedback,
            hasHealed,
          );
          if (decision.action === "halt") {
            return decision.record;
          }
          // Self-healing resolved: reset retry counter and apply the new improve prompt.
          retryCount = 0;
          hasHealed = true;
          improvePrompt = decision.improvePrompt;
          continue;
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
      allFeedback.push(...reviewResult.feedback);

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
        const decision = await this.#escalateSection(
          task,
          plan,
          iterations,
          retryCount,
          sectionStartAt,
          options,
          allObservations,
          allFeedback,
          hasHealed,
        );
        if (decision.action === "halt") {
          return decision.record;
        }
        // Self-healing resolved: reset retry counter and apply the new improve prompt.
        retryCount = 0;
        hasHealed = true;
        improvePrompt = decision.improvePrompt;
        continue;
      }

      improvePrompt = buildImprovePrompt(task.title, reviewResult.feedback);
    }
  }

  // ---------------------------------------------------------------------------
  // Escalation when maxRetriesPerSection is exhausted
  //
  // Returns an EscalationDecision:
  //   - { action: "halt", record } — section is permanently failed/escalated-to-human.
  //   - { action: "retry", improvePrompt } — self-healing resolved; caller resets retryCount.
  // ---------------------------------------------------------------------------

  async #escalateSection(
    task: Task,
    plan: TaskPlan,
    iterations: ReadonlyArray<SectionIterationRecord>,
    retryCount: number,
    sectionStartAt: string,
    options: Required<ImplementationLoopOptions>,
    agentObservations: ReadonlyArray<Observation>,
    reviewFeedback: ReadonlyArray<ReviewFeedbackItem>,
    healingAlreadyAttempted = false,
  ): Promise<EscalationDecision> {
    const escalationSummary = `Section escalated after ${retryCount} failed attempts`;

    // Requirement 6.4: if self-healing already resolved once for this section, skip re-escalation
    // and go straight to "escalated-to-human" so ISelfHealingLoop.escalate() is never called twice.
    if (options.selfHealingLoop !== undefined && healingAlreadyAttempted) {
      const humanSummary =
        `${escalationSummary}. Section failed again after self-healing resolved; escalating to human.`;
      options.eventBus?.emit({
        type: "section:escalated",
        sectionId: task.id,
        retryCount,
        reason: humanSummary,
      });
      await this.#planStore.updateSectionStatus(plan.id, task.id, "escalated-to-human");
      return {
        action: "halt",
        record: buildSectionRecord(
          task,
          plan.id,
          "escalated-to-human",
          retryCount,
          iterations,
          sectionStartAt,
          undefined,
          humanSummary,
        ),
      };
    }

    // Attempt self-healing when the port is provided.
    if (options.selfHealingLoop !== undefined) {
      const escalation: SectionEscalation = {
        sectionId: task.id,
        planId: plan.id,
        retryHistory: iterations,
        reviewFeedback,
        agentObservations,
      };

      let healingResult: SelfHealingResult;
      try {
        healingResult = await options.selfHealingLoop.escalate(escalation);
      } catch (err) {
        // Self-healing loop threw — treat as unresolvable failure.
        const errMessage = err instanceof Error ? err.message : String(err);
        options.eventBus?.emit({
          type: "section:escalated",
          sectionId: task.id,
          retryCount,
          reason: escalationSummary,
        });
        await this.#planStore.updateSectionStatus(plan.id, task.id, "failed");
        return {
          action: "halt",
          record: buildSectionRecord(
            task,
            plan.id,
            "failed",
            retryCount,
            iterations,
            sectionStartAt,
            undefined,
            `Self-healing loop threw unexpectedly: ${errMessage}`,
          ),
        };
      }

      if (healingResult.outcome === "resolved") {
        // Self-healing resolved: build a new improve prompt incorporating the updated rules.
        const improvePrompt = buildHealedImprovePrompt(
          task.title,
          healingResult.summary,
          healingResult.updatedRules ?? [],
        );
        return { action: "retry", improvePrompt };
      }

      // Self-healing unresolved → escalated-to-human.
      // Requirement 7.3: emit section:escalated with the SelfHealingResult.summary in the reason.
      const humanSummary = `${escalationSummary}. Self-healing was unable to resolve: ${healingResult.summary}`;
      options.eventBus?.emit({
        type: "section:escalated",
        sectionId: task.id,
        retryCount,
        reason: humanSummary,
      });
      await this.#planStore.updateSectionStatus(plan.id, task.id, "escalated-to-human");
      return {
        action: "halt",
        record: buildSectionRecord(
          task,
          plan.id,
          "escalated-to-human",
          retryCount,
          iterations,
          sectionStartAt,
          undefined,
          humanSummary,
        ),
      };
    }

    // No self-healing loop configured — permanent failure.
    options.eventBus?.emit({
      type: "section:escalated",
      sectionId: task.id,
      retryCount,
      reason: escalationSummary,
    });
    await this.#planStore.updateSectionStatus(plan.id, task.id, "failed");

    return {
      action: "halt",
      record: buildSectionRecord(
        task,
        plan.id,
        "failed",
        retryCount,
        iterations,
        sectionStartAt,
        undefined,
        escalationSummary,
      ),
    };
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

/**
 * Build an `IContextProvider` adapter that delegates to `IContextEngine`.
 *
 * The adapter is created once per section (before the retry loop) and reused
 * for all iterations — implement and improve. This allows the context engine
 * to accumulate observations across iterations of the same section, while
 * `resetTask()` at section start ensures isolation from the previous section.
 *
 * Completed section summaries are embedded in the task description so the
 * agent loop has cross-section context about what has already been committed.
 */
function buildContextProvider(
  contextEngine: IContextEngine,
  planId: string,
  taskId: string,
  completedSummaries: ReadonlyArray<SectionSummary>,
): IContextProvider {
  return {
    async buildContext(state: AgentState) {
      const summaryLines = completedSummaries.map(
        (s) => `- ${s.title}${s.commitSha !== undefined ? ` (${s.commitSha.slice(0, 7)})` : ""}`,
      );
      const taskDescription = summaryLines.length > 0
        ? `${state.task}\n\nCompleted sections:\n${summaryLines.join("\n")}`
        : state.task;

      const previousToolResults = state.observations.map((o) => ({
        toolName: o.toolName,
        content: typeof o.rawOutput === "string" ? o.rawOutput : JSON.stringify(o.rawOutput),
      }));

      const result = await contextEngine.buildContext({
        sessionId: planId,
        phaseId: "implementation",
        taskId,
        stepType: "Modification",
        taskDescription,
        previousToolResults,
      });

      return result.content;
    },
  };
}

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

/**
 * Build an improve prompt for a section that was resolved by the self-healing loop.
 * Incorporates the self-healing analysis summary and any updated rules.
 */
function buildHealedImprovePrompt(
  taskTitle: string,
  healingSummary: string,
  updatedRules: ReadonlyArray<string>,
): string {
  const rulesSection = updatedRules.length > 0
    ? `\nUpdated rules from self-healing analysis:\n${updatedRules.map((r) => `- ${r}`).join("\n")}`
    : "";
  return [
    `Retry the implementation of: ${taskTitle}`,
    ``,
    `The self-healing loop has analyzed the previous failures and produced the following guidance:`,
    healingSummary,
    rulesSection,
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
