export const WORKFLOW_PHASES = Object.freeze(
  [
    "SPEC_INIT",
    "HUMAN_INTERACTION",
    "VALIDATE_PREREQUISITES",
    "SPEC_REQUIREMENTS",
    "VALIDATE_REQUIREMENTS",
    "REFLECT_BEFORE_DESIGN",
    "VALIDATE_GAP",
    "SPEC_DESIGN",
    "VALIDATE_DESIGN",
    "REFLECT_BEFORE_TASKS",
    "SPEC_TASKS",
    "VALIDATE_TASK",
    "IMPLEMENTATION",
    "PULL_REQUEST",
  ] as const,
);

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export type WorkflowStatus = "running" | "paused_for_approval" | "completed" | "failed";

export interface WorkflowState {
  readonly specName: string;
  /** Current or last-completed phase.
   *  Invariant: when status is `paused_for_approval`, currentPhase holds the phase
   *  that triggered the pause; the engine re-checks the approval gate for this phase
   *  before advancing on the next run. */
  readonly currentPhase: WorkflowPhase;
  readonly completedPhases: readonly WorkflowPhase[];
  readonly status: WorkflowStatus;
  readonly failureDetail?: { readonly phase: WorkflowPhase; readonly error: string };
  readonly startedAt: string; // ISO 8601
  readonly updatedAt: string; // ISO 8601
}
