import type { WorkflowPhase, WorkflowState } from "@/domain/workflow/types";

export type WorkflowEvent =
  | { readonly type: "phase:start"; readonly phase: WorkflowPhase; readonly timestamp: string }
  | {
    readonly type: "phase:complete";
    readonly phase: WorkflowPhase;
    readonly durationMs: number;
    readonly artifacts: readonly string[];
  }
  | { readonly type: "phase:error"; readonly phase: WorkflowPhase; readonly operation: string; readonly error: string }
  | {
    readonly type: "approval:required";
    readonly phase: WorkflowPhase;
    readonly artifactPath: string;
    readonly instruction: string;
  }
  | { readonly type: "workflow:complete"; readonly completedPhases: readonly WorkflowPhase[] }
  | { readonly type: "workflow:failed"; readonly phase: WorkflowPhase; readonly error: string };

export interface IWorkflowStateStore {
  /** Atomically write state to disk. */
  persist(state: WorkflowState): Promise<void>;
  /** Return the last persisted state, or null when no state file exists. */
  restore(specName: string): Promise<WorkflowState | null>;
  /** Create a fresh initial state for a new workflow run. */
  init(specName: string): WorkflowState;
}

export interface IWorkflowEventBus {
  /** Synchronously deliver event to all registered handlers. */
  emit(event: WorkflowEvent): void;
  on(handler: (event: WorkflowEvent) => void): void;
  off(handler: (event: WorkflowEvent) => void): void;
}
