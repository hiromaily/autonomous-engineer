/**
 * Discriminated union of all debug observable events emitted during a --debug-flow run.
 * Each variant is a self-contained, immutable value object — no entity identity.
 */
export type DebugEvent =
  | {
    readonly type: "llm:call";
    readonly callIndex: number;
    readonly phase: string;
    readonly iterationNumber: number | null;
    readonly prompt: string;
    readonly response: string;
    readonly durationMs: number;
    readonly timestamp: string;
  }
  | {
    readonly type: "llm:error";
    readonly callIndex: number;
    readonly phase: string;
    readonly prompt: string;
    readonly errorCategory: string;
    readonly errorMessage: string;
    readonly durationMs: number;
    readonly timestamp: string;
  }
  | {
    readonly type: "agent:iteration";
    readonly iterationNumber: number;
    readonly phase: string;
    /** Mapped directly from `iteration:complete.category` (ActionCategory). */
    readonly actionCategory: string;
    readonly toolName: string;
    readonly durationMs: number;
    readonly timestamp: string;
  }
  | {
    readonly type: "approval:auto";
    readonly phase: string;
    readonly approvalType: "human_interaction" | "requirements" | "design" | "tasks";
    readonly outcome: "approved";
    readonly timestamp: string;
  };
