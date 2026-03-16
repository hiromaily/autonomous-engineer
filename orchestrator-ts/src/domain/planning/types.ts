// ---------------------------------------------------------------------------
// Status union types
// ---------------------------------------------------------------------------

export type StepStatus = "pending" | "in_progress" | "completed" | "failed";
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "escalated-to-human";

/** Frozen tuple of all valid StepStatus values. */
export const STEP_STATUSES = Object.freeze(
  ["pending", "in_progress", "completed", "failed"] as const satisfies ReadonlyArray<StepStatus>,
);

/** Frozen tuple of all valid TaskStatus values. */
export const TASK_STATUSES = Object.freeze(
  ["pending", "in_progress", "completed", "failed", "escalated-to-human"] as const satisfies ReadonlyArray<TaskStatus>,
);

// ---------------------------------------------------------------------------
// Entity types — four-level planning hierarchy
// ---------------------------------------------------------------------------

export interface Step {
  readonly id: string;
  readonly description: string;
  readonly status: StepStatus;
  readonly dependsOn: ReadonlyArray<string>;
  /** ISO 8601 timestamps for each status transition. */
  readonly statusHistory: ReadonlyArray<{ readonly status: StepStatus; readonly at: string }>;
}

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly steps: ReadonlyArray<Step>;
}

export interface TaskPlan {
  readonly id: string;
  readonly goal: string;
  readonly tasks: ReadonlyArray<Task>;
  /** ISO 8601 timestamp of plan creation. */
  readonly createdAt: string;
  /** ISO 8601 timestamp of last status change. */
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Human review reason
// ---------------------------------------------------------------------------

export type PlanReviewReason = "large-plan" | "high-risk-operations";

/** Frozen tuple of all valid PlanReviewReason values. */
export const PLAN_REVIEW_REASONS = Object.freeze(
  ["large-plan", "high-risk-operations"] as const satisfies ReadonlyArray<PlanReviewReason>,
);

// ---------------------------------------------------------------------------
// PlanEvent — discriminated union of all observable planning lifecycle events
// ---------------------------------------------------------------------------

export type PlanEvent =
  | {
    readonly type: "plan:created";
    readonly planId: string;
    readonly goal: string;
    readonly timestamp: string;
  }
  | {
    readonly type: "plan:validated";
    readonly planId: string;
    readonly timestamp: string;
  }
  | {
    readonly type: "plan:revision";
    readonly planId: string;
    readonly stepId: string;
    readonly originalDescription: string;
    readonly revisedDescription: string;
    readonly reason: string;
    readonly timestamp: string;
  }
  | {
    readonly type: "step:start";
    readonly planId: string;
    readonly stepId: string;
    readonly attempt: number;
    readonly timestamp: string;
  }
  | {
    readonly type: "step:completed";
    readonly planId: string;
    readonly stepId: string;
    readonly durationMs: number;
    readonly timestamp: string;
  }
  | {
    readonly type: "step:failed";
    readonly planId: string;
    readonly stepId: string;
    readonly attempt: number;
    readonly errorSummary: string;
    readonly recoveryAction: string;
    readonly timestamp: string;
  }
  | {
    readonly type: "step:escalated";
    readonly planId: string;
    readonly stepId: string;
    readonly timestamp: string;
  }
  | {
    readonly type: "plan:awaiting-review";
    readonly planId: string;
    readonly reason: PlanReviewReason;
    readonly timestamp: string;
  }
  | {
    readonly type: "plan:completed";
    readonly planId: string;
    readonly totalSteps: number;
    readonly durationMs: number;
    readonly timestamp: string;
  }
  | {
    readonly type: "plan:escalated";
    readonly planId: string;
    readonly failedStepId: string;
    readonly timestamp: string;
  };
