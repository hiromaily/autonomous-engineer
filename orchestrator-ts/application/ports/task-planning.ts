import type { AgentLoopLogger, AgentLoopOptions } from "./agent-loop";
import type { PlanEvent, PlanReviewReason, TaskPlan } from "../../domain/planning/types";

// ---------------------------------------------------------------------------
// TaskPlannerOptions — configuration for a single planner run
// ---------------------------------------------------------------------------

export interface TaskPlannerOptions {
  /** Max Agent Loop invocations per step before entering failure recovery. Default: 1. */
  readonly maxStepRetries: number;
  /** Steps threshold above which the human review gate activates. Default: 10. */
  readonly maxAutoApproveSteps: number;
  /** If true, skip human review gate regardless of plan size or risk. Default: false. */
  readonly skipHumanReview: boolean;
  /** Agent Loop options forwarded to each IAgentLoop.run() call. */
  readonly agentLoopOptions?: Partial<AgentLoopOptions>;
  /** Optional event bus for structured PlanEvent emission. */
  readonly eventBus?: IPlanEventBus;
  /** Optional structured logger. */
  readonly logger?: AgentLoopLogger;
}

// ---------------------------------------------------------------------------
// TaskPlanOutcome — terminal states for a plan run
// ---------------------------------------------------------------------------

export type TaskPlanOutcome =
  | "completed"
  | "escalated"
  | "validation-error"
  | "human-rejected"
  | "waiting-for-input"
  | "dependency-unavailable";

// ---------------------------------------------------------------------------
// TaskPlanResult — returned on every termination path
// ---------------------------------------------------------------------------

export interface TaskPlanResult {
  readonly outcome: TaskPlanOutcome;
  readonly plan: TaskPlan;
  readonly failedStepId?: string;
  readonly escalationContext?: string;
}

// ---------------------------------------------------------------------------
// ITaskPlanner — public interface for callers (orchestrator-core, implementation-loop)
// ---------------------------------------------------------------------------

export interface ITaskPlanner {
  /**
   * Generate and execute a plan for the given goal.
   * Never throws — all errors surface as TaskPlanOutcome in TaskPlanResult.
   */
  run(goal: string, options?: Partial<TaskPlannerOptions>): Promise<TaskPlanResult>;
  /**
   * Resume an existing in-progress plan from the last completed step.
   * Returns validation-error outcome if no resumable plan exists for the given planId.
   */
  resume(planId: string, options?: Partial<TaskPlannerOptions>): Promise<TaskPlanResult>;
  /**
   * Returns IDs of all persisted plans not yet in "completed" or "failed" status.
   * Allows callers to discover resumable plans after a crash without accessing ITaskPlanStore directly.
   */
  listResumable(): Promise<ReadonlyArray<string>>;
  /** Signal graceful stop; halts after the current step completes. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// ITaskPlanStore — persistence port for plan read/write
// ---------------------------------------------------------------------------

export interface ITaskPlanStore {
  save(plan: TaskPlan): Promise<void>;
  load(planId: string): Promise<TaskPlan | null>;
  /** Returns IDs of all persisted plans not in "completed" or "failed" status. */
  listResumable(): Promise<ReadonlyArray<string>>;
}

// ---------------------------------------------------------------------------
// PlanReviewDecision — human approval gate response
// ---------------------------------------------------------------------------

export type PlanReviewDecision =
  | { readonly approved: true }
  | { readonly approved: false; readonly feedback: string };

// ---------------------------------------------------------------------------
// IPlanContextBuilder — narrow context-assembly port for plan generation
// ---------------------------------------------------------------------------

/**
 * Narrow context-building port for plan generation.
 * Decouples task-planning from spec6's full IContextEngine API, whose signature
 * (buildContext(AgentState, toolSchemas)) is incompatible with plan generation
 * (no AgentState exists before a plan is created).
 * A spec6 adapter implements this port; a minimal fallback implementation is
 * also provided in TaskPlanningService for when spec6 is unavailable.
 */
export interface IPlanContextBuilder {
  /** Assembles the LLM prompt for initial plan generation from the goal and optional repository context. */
  buildPlanContext(goal: string, repositoryContext?: string): Promise<string>;
  /** Assembles the LLM prompt for plan revision given the current plan and failure context. */
  buildRevisionContext(plan: TaskPlan, failedStepId: string, failureSummary: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// IHumanReviewGateway — human review gateway port
// ---------------------------------------------------------------------------

/** Human review gateway port — awaited by the service; adapter implements interaction. */
export interface IHumanReviewGateway {
  reviewPlan(
    plan: TaskPlan,
    reason: PlanReviewReason,
    timeoutMs: number,
  ): Promise<PlanReviewDecision>;
}

// ---------------------------------------------------------------------------
// IPlanEventBus — event bus for PlanEvent emission
// ---------------------------------------------------------------------------

/** Event bus for PlanEvent emission — optional; when absent, events are silently dropped. */
export interface IPlanEventBus {
  emit(event: PlanEvent): void;
  on(handler: (event: PlanEvent) => void): void;
  off(handler: (event: PlanEvent) => void): void;
}

// ---------------------------------------------------------------------------
// TaskPlannerLogger — re-export of AgentLoopLogger (identical shape)
// ---------------------------------------------------------------------------

export type { AgentLoopLogger as TaskPlannerLogger } from "./agent-loop";
