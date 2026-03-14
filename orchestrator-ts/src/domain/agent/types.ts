import type { ToolError } from "@/domain/tools/types";

// ---------------------------------------------------------------------------
// Action category
// ---------------------------------------------------------------------------

export type ActionCategory =
  | "Exploration"
  | "Modification"
  | "Validation"
  | "Documentation";

/** Frozen tuple of all valid ActionCategory values — useful for iteration and validation. */
export const ACTION_CATEGORIES = Object.freeze(
  [
    "Exploration",
    "Modification",
    "Validation",
    "Documentation",
  ] as const satisfies ReadonlyArray<ActionCategory>,
);

// ---------------------------------------------------------------------------
// Loop step names
// ---------------------------------------------------------------------------

export type LoopStep = "PLAN" | "ACT" | "OBSERVE" | "REFLECT" | "UPDATE_STATE";

/** Frozen tuple of all valid LoopStep values — in execution order. */
export const LOOP_STEPS = Object.freeze(
  [
    "PLAN",
    "ACT",
    "OBSERVE",
    "REFLECT",
    "UPDATE_STATE",
  ] as const satisfies ReadonlyArray<LoopStep>,
);

// ---------------------------------------------------------------------------
// Supporting union types
// ---------------------------------------------------------------------------

export type ReflectionAssessment = "expected" | "unexpected" | "failure";

export type PlanAdjustment = "continue" | "revise" | "stop";

// ---------------------------------------------------------------------------
// ActionPlan — transient value produced by the PLAN step
// ---------------------------------------------------------------------------

export interface ActionPlan {
  readonly category: ActionCategory;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// ReflectionOutput — transient value produced by the REFLECT step
// ---------------------------------------------------------------------------

export interface ReflectionOutput {
  readonly assessment: ReflectionAssessment;
  readonly learnings: ReadonlyArray<string>;
  readonly planAdjustment: PlanAdjustment;
  readonly revisedPlan?: ReadonlyArray<string>;
  readonly requiresHumanIntervention?: boolean;
  readonly taskComplete?: boolean;
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Termination conditions
// ---------------------------------------------------------------------------

export type TerminationCondition =
  | "TASK_COMPLETED"
  | "MAX_ITERATIONS_REACHED"
  | "HUMAN_INTERVENTION_REQUIRED"
  | "SAFETY_STOP"
  | "RECOVERY_EXHAUSTED";

/** Frozen tuple of all valid TerminationCondition values. */
export const TERMINATION_CONDITIONS = Object.freeze(
  [
    "TASK_COMPLETED",
    "MAX_ITERATIONS_REACHED",
    "HUMAN_INTERVENTION_REQUIRED",
    "SAFETY_STOP",
    "RECOVERY_EXHAUSTED",
  ] as const satisfies ReadonlyArray<TerminationCondition>,
);

// ---------------------------------------------------------------------------
// Observation — value object recording a single tool invocation result
// ---------------------------------------------------------------------------

export interface Observation {
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  /** Raw tool output — typed as unknown to be agnostic to content format. */
  readonly rawOutput: unknown;
  /** Present when the tool invocation failed; absent on success. */
  readonly error?: ToolError;
  readonly success: boolean;
  /** ISO 8601 timestamp for when this observation was recorded. */
  readonly recordedAt: string;
  /** Reflection metadata populated during the REFLECT step. */
  readonly reflection?: ReflectionOutput;
}

// ---------------------------------------------------------------------------
// AgentState — root aggregate for a single loop execution
// ---------------------------------------------------------------------------

export interface AgentState {
  readonly task: string;
  readonly plan: ReadonlyArray<string>;
  readonly completedSteps: ReadonlyArray<string>;
  readonly currentStep: string | null;
  readonly iterationCount: number;
  readonly observations: ReadonlyArray<Observation>;
  readonly recoveryAttempts: number;
  /** ISO 8601 timestamp for when the loop execution started. */
  readonly startedAt: string;
}

// ---------------------------------------------------------------------------
// AgentLoopEvent — discriminated union of all observable loop lifecycle events
// ---------------------------------------------------------------------------

export type AgentLoopEvent =
  | {
    readonly type: "iteration:start";
    readonly iteration: number;
    readonly currentStep: string | null;
    readonly timestamp: string;
  }
  | {
    readonly type: "iteration:complete";
    readonly iteration: number;
    readonly category: ActionCategory;
    readonly toolName: string;
    readonly durationMs: number;
    readonly assessment: ReflectionAssessment;
  }
  | {
    readonly type: "step:start";
    readonly step: LoopStep;
    readonly iteration: number;
    readonly timestamp: string;
  }
  | {
    readonly type: "step:complete";
    readonly step: LoopStep;
    readonly iteration: number;
    readonly durationMs: number;
  }
  | {
    readonly type: "recovery:attempt";
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly errorMessage: string;
  }
  | {
    readonly type: "terminated";
    readonly condition: TerminationCondition;
    readonly finalState: AgentState;
    readonly timestamp: string;
  };
