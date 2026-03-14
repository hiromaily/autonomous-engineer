import type { AgentLoopEvent, AgentState, TerminationCondition } from "@/domain/agent/types";
import type { ToolListEntry } from "@/domain/tools/registry";

// ---------------------------------------------------------------------------
// AgentLoopOptions — configuration for a single loop run
// ---------------------------------------------------------------------------

export interface AgentLoopOptions {
  /** Maximum number of PLAN→ACT→OBSERVE→REFLECT→UPDATE cycles. Default: 50. */
  readonly maxIterations: number;
  /** Maximum recovery attempts per error occurrence before escalating. Default: 3. */
  readonly maxRecoveryAttempts: number;
  /** Maximum retries for LLM plan parse failures before halting. Default: 2. */
  readonly maxPlanParseRetries: number;
  /** Optional spec6 context engine; when present, delegates PLAN context assembly. */
  readonly contextProvider?: IContextProvider;
  /** Optional event bus; when present, receives all loop lifecycle events. */
  readonly eventBus?: IAgentEventBus;
  /** Optional structured logger; receives info/error entries at each step boundary. */
  readonly logger?: AgentLoopLogger;
  /** Callback registered by the agent-safety layer to trigger an emergency halt. */
  readonly onSafetyStop?: () => void;
}

// ---------------------------------------------------------------------------
// AgentLoopResult — returned on every termination path
// ---------------------------------------------------------------------------

export interface AgentLoopResult {
  readonly terminationCondition: TerminationCondition;
  readonly finalState: AgentState;
  readonly totalIterations: number;
  /** True only when the loop exited via TASK_COMPLETED. */
  readonly taskCompleted: boolean;
}

// ---------------------------------------------------------------------------
// IAgentLoop — public port for callers (orchestrator-core, task-planning)
// ---------------------------------------------------------------------------

export interface IAgentLoop {
  /**
   * Execute the agent loop for the given task.
   * Never throws — all errors surface as a TerminationCondition in AgentLoopResult.
   */
  run(task: string, options?: Partial<AgentLoopOptions>): Promise<AgentLoopResult>;
  /** Signal graceful stop; the loop halts at the next PLAN step boundary. */
  stop(): void;
  /** Returns current AgentState snapshot, or null when no run is active. */
  getState(): Readonly<AgentState> | null;
}

// ---------------------------------------------------------------------------
// IContextProvider — optional spec6 context assembly delegation
// ---------------------------------------------------------------------------

export interface IContextProvider {
  /** Assembles the LLM prompt context for the PLAN step. */
  buildContext(state: AgentState, toolSchemas: ReadonlyArray<ToolListEntry>): Promise<string>;
}

// ---------------------------------------------------------------------------
// IAgentEventBus — optional event emission and subscription
// ---------------------------------------------------------------------------

export interface IAgentEventBus {
  emit(event: AgentLoopEvent): void;
  on(handler: (event: AgentLoopEvent) => void): void;
  off(handler: (event: AgentLoopEvent) => void): void;
}

// ---------------------------------------------------------------------------
// AgentLoopLogger — optional structured logging
// ---------------------------------------------------------------------------

export interface AgentLoopLogger {
  info(message: string, data?: Readonly<Record<string, unknown>>): void;
  error(message: string, data?: Readonly<Record<string, unknown>>): void;
}
