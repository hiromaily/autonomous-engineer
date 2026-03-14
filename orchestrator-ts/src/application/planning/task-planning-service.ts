import type { AgentLoopResult, IAgentLoop } from "@/application/ports/agent-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type {
  IHumanReviewGateway,
  IPlanContextBuilder,
  ITaskPlanner,
  ITaskPlanStore,
  TaskPlannerOptions,
  TaskPlanResult,
} from "@/application/ports/task-planning";
import { PlanValidator } from "@/domain/planning/plan-validator";
import type { PlanEvent, PlanReviewReason, Step, StepStatus, TaskPlan, TaskStatus } from "@/domain/planning/types";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Number of parse retries for plan generation.
 * Total attempts = 1 (initial) + PLAN_PARSE_RETRIES = 3.
 */
const PLAN_PARSE_RETRIES = 2;

/** Default step count threshold above which the human review gate activates. */
const DEFAULT_MAX_AUTO_APPROVE_STEPS = 10;

/**
 * Keywords whose presence in any step description triggers the high-risk gate.
 * Matched case-insensitively.
 */
const HIGH_RISK_KEYWORDS: ReadonlyArray<string> = [
  "delete",
  "drop",
  "force-push",
  "schema migration",
];

/** Timeout in milliseconds passed to reviewPlan(). */
const REVIEW_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Zod schema for LLM plan response validation
// ---------------------------------------------------------------------------

const StepSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]).default("pending"),
  dependsOn: z.array(z.string()).default([]),
  statusHistory: z
    .array(
      z.object({
        status: z.enum(["pending", "in_progress", "completed", "failed"]),
        at: z.string(),
      }),
    )
    .default([]),
});

const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]).default("pending"),
  steps: z.array(StepSchema),
});

const PlanBodySchema = z.object({
  goal: z.string().optional(),
  tasks: z.array(TaskSchema),
});

/**
 * Default number of retries per step before entering LLM-driven revision.
 * Total attempts in the retry loop = 1 (initial) + DEFAULT_MAX_STEP_RETRIES.
 */
const DEFAULT_MAX_STEP_RETRIES = 3;

// ---------------------------------------------------------------------------
// Internal discriminated result type for phase methods
// ---------------------------------------------------------------------------

type PhaseResult =
  | { readonly type: "proceed"; readonly plan: TaskPlan }
  | { readonly type: "terminal"; readonly result: TaskPlanResult };

// ---------------------------------------------------------------------------
// TaskPlanningService
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full task-planning lifecycle:
 *   generate → validate → persist → human gate → execute steps → recover → escalate
 *
 * Implements ITaskPlanner; all lifecycle sub-concerns are private methods.
 * Never throws from run() or resume() — all errors surface as TaskPlanOutcome.
 */
export class TaskPlanningService implements ITaskPlanner {
  readonly #agentLoop: IAgentLoop;
  readonly #contextBuilder: IPlanContextBuilder;
  readonly #llm: LlmProviderPort;
  readonly #store: ITaskPlanStore;
  readonly #reviewGateway: IHumanReviewGateway | undefined;
  readonly #validator = new PlanValidator();

  /** Set to true by stop(); checked at the start of every step iteration. */
  #stopRequested = false;

  constructor(
    agentLoop: IAgentLoop,
    contextBuilder: IPlanContextBuilder,
    llm: LlmProviderPort,
    store: ITaskPlanStore,
    reviewGateway?: IHumanReviewGateway,
  ) {
    this.#agentLoop = agentLoop;
    this.#contextBuilder = contextBuilder;
    this.#llm = llm;
    this.#store = store;
    this.#reviewGateway = reviewGateway;
  }

  // ---------------------------------------------------------------------------
  // Public interface — ITaskPlanner
  // ---------------------------------------------------------------------------

  /**
   * Generate and execute a plan for the given goal.
   * Never throws — all errors surface as TaskPlanOutcome in TaskPlanResult.
   */
  async run(goal: string, options?: Partial<TaskPlannerOptions>): Promise<TaskPlanResult> {
    this.#stopRequested = false;

    // Dependency-availability guard
    if (!this.#agentLoop || !this.#contextBuilder || !this.#llm) {
      return { outcome: "dependency-unavailable", plan: this.#createEmptyPlan(crypto.randomUUID(), goal) };
    }

    // Phase 1: Generate, validate, and persist the plan
    const genPhase = await this.#generationPhase(goal, options);
    if (genPhase.type === "terminal") return genPhase.result;

    // Phase 2: Human review gate
    const reviewPhase = await this.#humanReviewPhase(genPhase.plan, goal, options);
    if (reviewPhase.type === "terminal") return reviewPhase.result;

    // Phase 3: Execute steps in dependency order
    return this.#executeSteps(reviewPhase.plan, options);
  }

  /**
   * Resume an existing in-progress plan from the last completed step.
   * Returns validation-error outcome when no resumable plan exists for the given planId.
   * Task 5.6 will implement the full resume logic.
   */
  async resume(planId: string, options?: Partial<TaskPlannerOptions>): Promise<TaskPlanResult> {
    // Dependency-availability guard
    if (!this.#agentLoop || !this.#contextBuilder || !this.#llm) {
      return { outcome: "dependency-unavailable", plan: this.#createEmptyPlan(planId) };
    }

    let loaded: TaskPlan | null;
    try {
      loaded = await this.#store.load(planId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        outcome: "escalated",
        plan: this.#createEmptyPlan(planId),
        escalationContext: `Failed to load plan ${planId}: ${message}`,
      };
    }

    if (loaded === null) {
      return { outcome: "validation-error", plan: this.#createEmptyPlan(planId) };
    }

    // Validate the loaded plan; #executeSteps will also validate to obtain executionOrder,
    // but we validate here explicitly to return validation-error before any execution begins.
    const validationResult = this.#validator.validate(loaded);
    if (!validationResult.valid) {
      return { outcome: "validation-error", plan: loaded };
    }

    return this.#executeSteps(loaded, options, validationResult.executionOrder);
  }

  /** Returns IDs of all persisted plans not yet in completed or failed status. */
  async listResumable(): Promise<ReadonlyArray<string>> {
    return this.#store.listResumable();
  }

  /** Signal graceful stop; halts after the current step completes. */
  stop(): void {
    this.#stopRequested = true;
  }

  // ---------------------------------------------------------------------------
  // Private: Phase 1 — generation, validation, persistence
  // ---------------------------------------------------------------------------

  async #generationPhase(goal: string, options?: Partial<TaskPlannerOptions>): Promise<PhaseResult> {
    // Build LLM context (with fallback when context builder fails)
    let context: string;
    try {
      context = await this.#contextBuilder.buildPlanContext(goal);
    } catch {
      context = this.#buildFallbackContext(goal);
    }

    // Call LLM and parse response — retry up to PLAN_PARSE_RETRIES
    const planId = crypto.randomUUID();
    const now = new Date().toISOString();

    let plan: TaskPlan | null = null;
    let lastError = "unknown error";
    const maxAttempts = 1 + PLAN_PARSE_RETRIES;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const llmResult = await this.#llm.complete(context);

      if (!llmResult.ok) {
        lastError = llmResult.error.message;
        continue;
      }

      const parsed = this.#parsePlanBody(llmResult.value.content, planId, goal, now);
      if (parsed === null) {
        lastError = "LLM response could not be parsed as a valid plan structure";
        continue;
      }

      plan = parsed;
      break;
    }

    if (plan === null) {
      return {
        type: "terminal",
        result: {
          outcome: "escalated",
          plan: this.#createEmptyPlan(planId, goal),
          escalationContext: `Plan generation failed after ${maxAttempts} attempt(s): ${lastError}`,
        },
      };
    }

    // Validate the generated plan
    const validationResult = this.#validator.validate(plan);
    if (!validationResult.valid) {
      return { type: "terminal", result: { outcome: "validation-error", plan } };
    }

    // Persist initial plan before any further processing
    try {
      await this.#store.save(plan);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: "terminal",
        result: { outcome: "escalated", plan, escalationContext: `Persistence failure: ${message}` },
      };
    }

    // Emit observability events after successful generation and persistence
    const ts = new Date().toISOString();
    this.#emitAndLog(options, { type: "plan:created", planId: plan.id, goal, timestamp: ts });
    this.#emitAndLog(options, { type: "plan:validated", planId: plan.id, timestamp: ts });

    return { type: "proceed", plan };
  }

  // ---------------------------------------------------------------------------
  // Private: Phase 2 — human review gate (task 5.2)
  // ---------------------------------------------------------------------------

  async #humanReviewPhase(
    plan: TaskPlan,
    goal: string,
    options?: Partial<TaskPlannerOptions>,
  ): Promise<PhaseResult> {
    // Skip conditions
    if (!this.#reviewGateway) return { type: "proceed", plan };
    if (options?.skipHumanReview === true) return { type: "proceed", plan };

    // Determine if review is needed
    const totalSteps = plan.tasks.reduce((sum, t) => sum + t.steps.length, 0);
    const maxAutoApproveSteps = options?.maxAutoApproveSteps ?? DEFAULT_MAX_AUTO_APPROVE_STEPS;
    const isLarge = totalSteps > maxAutoApproveSteps;

    const isHighRisk = plan.tasks.some((t) =>
      t.steps.some((s) => HIGH_RISK_KEYWORDS.some((kw) => s.description.toLowerCase().includes(kw.toLowerCase())))
    );

    if (!isLarge && !isHighRisk) return { type: "proceed", plan };

    // Reason: large-plan takes priority over high-risk-operations
    const reason: PlanReviewReason = isLarge ? "large-plan" : "high-risk-operations";
    const eventBus = options?.eventBus;

    // First review pass
    let decision: { approved: true } | { approved: false; feedback: string };
    try {
      decision = await this.#reviewGateway.reviewPlan(plan, reason, REVIEW_TIMEOUT_MS);
    } catch {
      this.#emitEvent(eventBus, {
        type: "plan:awaiting-review",
        planId: plan.id,
        reason,
        timestamp: new Date().toISOString(),
      });
      return { type: "terminal", result: { outcome: "waiting-for-input", plan } };
    }

    if (decision.approved) return { type: "proceed", plan };

    // Rejection: regenerate plan with feedback and re-present (one revision pass)
    const { feedback } = decision;
    const revisedPlan = await this.#generateRevisedPlan(plan, goal, feedback);
    if (revisedPlan === null) {
      return { type: "terminal", result: { outcome: "human-rejected", plan } };
    }

    // Second review pass with revised plan
    let secondDecision: { approved: true } | { approved: false; feedback: string };
    try {
      secondDecision = await this.#reviewGateway.reviewPlan(revisedPlan, reason, REVIEW_TIMEOUT_MS);
    } catch {
      this.#emitEvent(eventBus, {
        type: "plan:awaiting-review",
        planId: revisedPlan.id,
        reason,
        timestamp: new Date().toISOString(),
      });
      return { type: "terminal", result: { outcome: "waiting-for-input", plan: revisedPlan } };
    }

    if (secondDecision.approved) return { type: "proceed", plan: revisedPlan };

    return { type: "terminal", result: { outcome: "human-rejected", plan: revisedPlan } };
  }

  /**
   * Generates a revised plan incorporating reviewer feedback.
   * Returns null when the revised plan cannot be generated or parsed.
   */
  async #generateRevisedPlan(
    currentPlan: TaskPlan,
    goal: string,
    feedback: string,
  ): Promise<TaskPlan | null> {
    const revisedGoal = `${goal}\n\nReview feedback: ${feedback}`;
    let context: string;
    try {
      context = await this.#contextBuilder.buildPlanContext(revisedGoal);
    } catch {
      context = this.#buildFallbackContext(revisedGoal);
    }

    const llmResult = await this.#llm.complete(context);
    if (!llmResult.ok) return null;

    const now = new Date().toISOString();
    const parsed = this.#parsePlanBody(llmResult.value.content, currentPlan.id, goal, now);
    if (parsed === null) return null;

    const validationResult = this.#validator.validate(parsed);
    if (!validationResult.valid) return null;

    try {
      await this.#store.save(parsed);
    } catch {
      return null;
    }

    return parsed;
  }

  // ---------------------------------------------------------------------------
  // Private: Phase 3 — step execution loop (task 5.3)
  // ---------------------------------------------------------------------------

  /**
   * Executes all steps in topological dependency order.
   *
   * For each step:
   *   1. Halt if stop signal received.
   *   2. Cascade-fail if any dependency is already failed.
   *   3. Set status to in_progress and persist (before agent loop invocation).
   *   4. Invoke IAgentLoop.run() with the step description.
   *   5. Set status to completed or failed and persist (after agent loop returns).
   *
   * Returns "escalated" with the first failed step ID if any step fails.
   * Returns "completed" when all steps succeed.
   */
  async #executeSteps(
    plan: TaskPlan,
    options?: Partial<TaskPlannerOptions>,
    precomputedOrder?: ReadonlyArray<string>,
  ): Promise<TaskPlanResult> {
    // Use pre-computed execution order when available (avoids redundant validation on resume)
    let executionOrder: ReadonlyArray<string>;
    if (precomputedOrder !== undefined) {
      executionOrder = precomputedOrder;
    } else {
      const validationResult = this.#validator.validate(plan);
      if (!validationResult.valid) {
        return { outcome: "validation-error", plan };
      }
      executionOrder = validationResult.executionOrder;
    }

    const execStartMs = Date.now();
    const failedStepIds = new Set<string>();
    let currentPlan = plan;
    let firstFailedStepId: string | undefined;

    for (const stepId of executionOrder) {
      // Halt on stop signal — checked at the start of each step iteration
      if (this.#stopRequested) break;

      // Find the step in the current plan snapshot
      const step = this.#findStep(currentPlan, stepId);
      if (step === null) continue;

      // Skip steps already in a terminal state (resume scenario)
      if (step.status === "completed" || step.status === "failed") {
        if (step.status === "failed") failedStepIds.add(stepId);
        continue;
      }

      // Cascade-fail: if any declared dependency has already failed, fail this step
      const dependencyFailed = step.dependsOn.some((depId) => failedStepIds.has(depId));
      if (dependencyFailed) {
        currentPlan = this.#updateStepStatus(currentPlan, stepId, "failed");
        failedStepIds.add(stepId);
        if (firstFailedStepId === undefined) firstFailedStepId = stepId;
        try {
          await this.#store.save(currentPlan);
        } catch {
          // Ignore persistence error during cascade-fail; primary failure is already tracked
        }
        continue;
      }

      // Emit step:start before marking in_progress
      this.#emitAndLog(options, {
        type: "step:start",
        planId: currentPlan.id,
        stepId,
        attempt: 1,
        timestamp: new Date().toISOString(),
      });

      // Mark step in_progress and persist before invoking agent loop
      currentPlan = this.#updateStepStatus(currentPlan, stepId, "in_progress");
      try {
        await this.#store.save(currentPlan);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          outcome: "escalated",
          plan: currentPlan,
          escalationContext: `Persistence failure before step ${stepId}: ${message}`,
        };
      }

      const stepStartMs = Date.now();

      // Invoke agent loop with retry and LLM-driven revision (task 5.4)
      const recoveryResult = await this.#executeStepWithRecovery(step, currentPlan, options);

      if (recoveryResult.success) {
        currentPlan = this.#updateStepStatus(currentPlan, stepId, "completed");

        // Emit step:completed
        this.#emitAndLog(options, {
          type: "step:completed",
          planId: currentPlan.id,
          stepId,
          durationMs: Date.now() - stepStartMs,
          timestamp: new Date().toISOString(),
        });

        // Handle plan revision signal (task 5.5)
        if (recoveryResult.revisedPlan && recoveryResult.revisedPlan.length > 0) {
          const revResult = await this.#applyPlanRevision(
            currentPlan,
            stepId,
            executionOrder,
            recoveryResult.revisedPlan,
            recoveryResult.revisionReason ?? "",
            options,
          );
          if (revResult.status === "waiting-for-input") {
            return { outcome: "waiting-for-input", plan: revResult.plan };
          }
          currentPlan = revResult.plan;
        }
      } else {
        currentPlan = this.#updateStepStatus(currentPlan, stepId, "failed");
        failedStepIds.add(stepId);
        if (firstFailedStepId === undefined) firstFailedStepId = stepId;

        // Emit step:escalated
        this.#emitAndLog(options, {
          type: "step:escalated",
          planId: currentPlan.id,
          stepId,
          timestamp: new Date().toISOString(),
        });
      }

      try {
        await this.#store.save(currentPlan);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          outcome: "escalated",
          plan: currentPlan,
          escalationContext: `Persistence failure after step ${stepId}: ${message}`,
        };
      }
    }

    if (firstFailedStepId !== undefined) {
      // Emit plan:escalated
      this.#emitAndLog(options, {
        type: "plan:escalated",
        planId: currentPlan.id,
        failedStepId: firstFailedStepId,
        timestamp: new Date().toISOString(),
      });
      return { outcome: "escalated", plan: currentPlan, failedStepId: firstFailedStepId };
    }

    // Emit plan:completed
    this.#emitAndLog(options, {
      type: "plan:completed",
      planId: currentPlan.id,
      totalSteps: executionOrder.length,
      durationMs: Date.now() - execStartMs,
      timestamp: new Date().toISOString(),
    });

    return { outcome: "completed", plan: currentPlan };
  }

  // ---------------------------------------------------------------------------
  // Private: Phase 3 — failure recovery chain (task 5.4)
  // ---------------------------------------------------------------------------

  /**
   * Executes a single step with retry logic and LLM-driven revision.
   *
   * Phases:
   *   1. Attempt 0 (original description) through attempt maxStepRetries (with failure context).
   *   2. After all retries exhausted: LLM-driven revision → one final attempt.
   *   3. If revision generation fails (LLM error / contextBuilder throws): escalate immediately.
   */
  async #executeStepWithRecovery(
    step: Step,
    plan: TaskPlan,
    options?: Partial<TaskPlannerOptions>,
  ): Promise<{
    readonly success: boolean;
    readonly failureSummary: string;
    readonly revisedPlan?: ReadonlyArray<string>;
    readonly revisionReason?: string;
  }> {
    const maxRetries = options?.maxStepRetries ?? DEFAULT_MAX_STEP_RETRIES;
    const eventBus = options?.eventBus;
    const agentLoopOptions = options?.agentLoopOptions;
    let lastTerminationCondition = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const taskDesc = attempt === 0
        ? step.description
        : this.#buildRetryTaskDescription(step.description, lastTerminationCondition, attempt);

      const agentResult = await this.#agentLoop.run(taskDesc, agentLoopOptions);
      if (agentResult.taskCompleted) {
        const sig = this.#extractRevisionSignal(agentResult);
        return {
          success: true,
          failureSummary: "",
          ...(sig?.revisedPlan !== undefined ? { revisedPlan: sig.revisedPlan } : {}),
          ...(sig?.reason !== undefined ? { revisionReason: sig.reason } : {}),
        };
      }

      lastTerminationCondition = String(agentResult.terminationCondition ?? "step failed");

      const isLastRetry = attempt === maxRetries;
      const recoveryAction = isLastRetry ? "llm-driven-revision" : `retry (attempt ${attempt + 2})`;
      this.#emitEvent(eventBus, {
        type: "step:failed",
        planId: plan.id,
        stepId: step.id,
        attempt: attempt + 1,
        errorSummary: lastTerminationCondition,
        recoveryAction,
        timestamp: new Date().toISOString(),
      });
    }

    // All retries exhausted — try LLM-driven revision
    const revisedDescription = await this.#generateRevisedStepDescription(
      step,
      plan,
      lastTerminationCondition,
    );

    if (revisedDescription !== null) {
      const revisionResult = await this.#agentLoop.run(revisedDescription, agentLoopOptions);
      if (revisionResult.taskCompleted) {
        const sig = this.#extractRevisionSignal(revisionResult);
        return {
          success: true,
          failureSummary: "",
          ...(sig?.revisedPlan !== undefined ? { revisedPlan: sig.revisedPlan } : {}),
          ...(sig?.reason !== undefined ? { revisionReason: sig.reason } : {}),
        };
      }
    }

    return { success: false, failureSummary: lastTerminationCondition };
  }

  /**
   * Asks the LLM to generate a revised description for a failed step.
   * Returns null when the context builder throws or the LLM call fails.
   */
  async #generateRevisedStepDescription(
    step: Step,
    plan: TaskPlan,
    failureSummary: string,
  ): Promise<string | null> {
    try {
      const context = await this.#contextBuilder.buildRevisionContext(plan, step.id, failureSummary);
      const llmResult = await this.#llm.complete(context);
      if (!llmResult.ok) return null;
      return llmResult.value.content;
    } catch {
      return null;
    }
  }

  /**
   * Builds the task description for a retry attempt, embedding the prior failure context.
   */
  #buildRetryTaskDescription(original: string, lastError: string, attempt: number): string {
    return `${original}\n\n[Retry attempt ${attempt}. Previous attempt failed: ${lastError}]`;
  }

  // ---------------------------------------------------------------------------
  // Private: Phase 3 — dynamic plan adjustment (task 5.5)
  // ---------------------------------------------------------------------------

  /**
   * Extracts a plan revision signal from the agent loop result's last reflection.
   * Returns null when no revision is signalled.
   */
  #extractRevisionSignal(
    agentResult: AgentLoopResult,
  ): { readonly revisedPlan: ReadonlyArray<string>; readonly reason: string } | null {
    const obs = agentResult.finalState.observations ?? [];
    const lastObs = obs[obs.length - 1];
    const reflection = lastObs?.reflection;
    if (
      reflection?.planAdjustment === "revise"
      && reflection.revisedPlan
      && reflection.revisedPlan.length > 0
    ) {
      return { revisedPlan: reflection.revisedPlan, reason: reflection.summary };
    }
    return null;
  }

  /**
   * Applies a plan revision from an agent loop signal.
   *
   * Steps:
   *   1. Compute remaining steps after the current step.
   *   2. Diff new descriptions against current descriptions.
   *   3. If >50% of remaining steps change and a review gateway is available (and not skipped),
   *      pause for human review.
   *   4. Apply the revision, persist, and emit plan:revision events.
   */
  async #applyPlanRevision(
    plan: TaskPlan,
    completedStepId: string,
    executionOrder: ReadonlyArray<string>,
    revisedDescriptions: ReadonlyArray<string>,
    revisionReason: string,
    options?: Partial<TaskPlannerOptions>,
  ): Promise<{ readonly status: "applied" | "skipped" | "waiting-for-input"; readonly plan: TaskPlan }> {
    // Remaining step IDs (steps after the just-completed step in execution order)
    const completedIdx = executionOrder.indexOf(completedStepId);
    const remainingIds = executionOrder.slice(completedIdx + 1);

    if (remainingIds.length === 0 || revisedDescriptions.length === 0) {
      return { status: "skipped", plan };
    }

    // Build a flat step map for O(1) lookups — avoids repeated linear scans in the loop below
    const stepById = new Map<string, Step>();
    for (const task of plan.tasks) {
      for (const step of task.steps) {
        stepById.set(step.id, step);
      }
    }

    // Build revision map: only include steps where the description actually changes
    const changedSteps: Array<{ id: string; original: string; revised: string }> = [];
    const revisionMap = new Map<string, string>();

    for (let i = 0; i < Math.min(revisedDescriptions.length, remainingIds.length); i++) {
      const stepId = remainingIds[i];
      const newDesc = revisedDescriptions[i];
      if (stepId === undefined || newDesc === undefined) continue;
      const step = stepById.get(stepId);
      if (step === undefined) continue;
      if (newDesc !== step.description) {
        revisionMap.set(stepId, newDesc);
        changedSteps.push({ id: stepId, original: step.description, revised: newDesc });
      }
    }

    if (changedSteps.length === 0) return { status: "skipped", plan };

    // 50% threshold check: pause for human review when gateway is available and not skipped
    const changedRatio = changedSteps.length / remainingIds.length;
    if (changedRatio > 0.5 && this.#reviewGateway && options?.skipHumanReview !== true) {
      const revisedPlan = this.#applyRevisionToSteps(plan, revisionMap);
      try {
        const decision = await this.#reviewGateway.reviewPlan(revisedPlan, "large-plan", REVIEW_TIMEOUT_MS);
        if (!decision.approved) {
          return { status: "skipped", plan };
        }
        // Approved: fall through to apply
      } catch {
        // Timeout: emit awaiting-review and return waiting-for-input
        this.#emitAndLog(options, {
          type: "plan:awaiting-review",
          planId: plan.id,
          reason: "large-plan",
          timestamp: new Date().toISOString(),
        });
        await this.#store.save(plan);
        return { status: "waiting-for-input", plan };
      }
    }

    // Apply revision and persist
    const updatedPlan = this.#applyRevisionToSteps(plan, revisionMap);
    await this.#store.save(updatedPlan);

    // Emit plan:revision event for each changed step
    for (const { id, original, revised } of changedSteps) {
      this.#emitAndLog(options, {
        type: "plan:revision",
        planId: plan.id,
        stepId: id,
        originalDescription: original,
        revisedDescription: revised,
        reason: revisionReason,
        timestamp: new Date().toISOString(),
      });
    }

    return { status: "applied", plan: updatedPlan };
  }

  /** Returns a new plan with step descriptions replaced according to the revisionMap. */
  #applyRevisionToSteps(plan: TaskPlan, revisionMap: ReadonlyMap<string, string>): TaskPlan {
    const now = new Date().toISOString();
    return {
      ...plan,
      updatedAt: now,
      tasks: plan.tasks.map((task) => ({
        ...task,
        steps: task.steps.map((step) => {
          const newDesc = revisionMap.get(step.id);
          return newDesc !== undefined ? { ...step, description: newDesc } : step;
        }),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Private: helpers — step status management
  // ---------------------------------------------------------------------------

  /** Finds a step by ID across all tasks in the plan. Returns null if not found. */
  #findStep(plan: TaskPlan, stepId: string): Step | null {
    for (const task of plan.tasks) {
      const found = task.steps.find((s) => s.id === stepId);
      if (found !== undefined) return found;
    }
    return null;
  }

  /**
   * Returns a new plan with the specified step's status updated and a new
   * statusHistory entry appended. Task status is recomputed from its steps.
   */
  #updateStepStatus(plan: TaskPlan, stepId: string, status: StepStatus): TaskPlan {
    const now = new Date().toISOString();
    return {
      ...plan,
      updatedAt: now,
      tasks: plan.tasks.map((task) => {
        const updatedSteps = task.steps.map((step) =>
          step.id === stepId
            ? {
              ...step,
              status,
              statusHistory: [...step.statusHistory, { status, at: now }],
            }
            : step
        );
        return {
          ...task,
          status: this.#computeTaskStatus(updatedSteps),
          steps: updatedSteps,
        };
      }),
    };
  }

  /** Derives a task's status from the collective status of its steps. */
  #computeTaskStatus(steps: ReadonlyArray<Step>): TaskStatus {
    if (steps.length === 0) return "pending";
    if (steps.every((s) => s.status === "completed")) return "completed";
    if (steps.some((s) => s.status === "failed")) return "failed";
    if (steps.some((s) => s.status === "in_progress")) return "in_progress";
    return "pending";
  }

  // ---------------------------------------------------------------------------
  // Private: helpers — event emission, parsing, fallback context
  // ---------------------------------------------------------------------------

  /** Creates a minimal empty TaskPlan stub for use in terminal outcomes. */
  #createEmptyPlan(id: string, goal = ""): TaskPlan {
    const now = new Date().toISOString();
    return { id, goal, tasks: [], createdAt: now, updatedAt: now };
  }

  /** Emits a plan event to the optional event bus. No-op when bus is absent. */
  #emitEvent(eventBus: { emit(event: PlanEvent): void } | undefined, event: PlanEvent): void {
    eventBus?.emit(event);
  }

  /**
   * Emits a plan event to the event bus AND writes it to the logger as JSON.
   * No-op for whichever of bus/logger is absent.
   */
  #emitAndLog(options: Partial<TaskPlannerOptions> | undefined, event: PlanEvent): void {
    options?.eventBus?.emit(event);
    options?.logger?.info(event.type, event as unknown as Readonly<Record<string, unknown>>);
  }

  /**
   * Attempts to parse the raw LLM response as a TaskPlan body.
   * Assigns `planId`, `createdAt`, `updatedAt` from the caller.
   * Returns null when the body is not valid JSON or lacks required fields.
   */
  #parsePlanBody(
    raw: string,
    planId: string,
    goal: string,
    now: string,
  ): TaskPlan | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const result = PlanBodySchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }

    const body = result.data;

    return {
      id: planId,
      goal: body.goal ?? goal,
      tasks: body.tasks as TaskPlan["tasks"],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Constructs a minimal LLM prompt directly from the goal string.
   * Used when IPlanContextBuilder.buildPlanContext() throws.
   * Consistent with AgentLoopService.#buildFallbackContext pattern.
   */
  #buildFallbackContext(goal: string): string {
    return [
      `Goal: ${goal}`,
      "Generate a structured task plan to accomplish this goal.",
      "Respond with JSON matching this schema:",
      JSON.stringify(
        {
          goal: "string",
          tasks: [
            {
              id: "string (unique, e.g. task-1)",
              title: "string",
              status: "pending",
              steps: [
                {
                  id: "string (unique, e.g. step-1)",
                  description: "string",
                  status: "pending",
                  dependsOn: ["array of step IDs this step depends on, or empty array"],
                  statusHistory: [],
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    ].join("\n\n");
  }
}
