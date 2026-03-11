import type { IAgentLoop, AgentLoopOptions, AgentLoopResult } from '../ports/agent-loop';
import type { IToolExecutor } from '../tools/executor';
import type { IToolRegistry } from '../../domain/tools/registry';
import type { LlmProviderPort } from '../ports/llm';
import type { ToolContext } from '../../domain/tools/types';
import type { AgentState } from '../../domain/agent/types';

// ---------------------------------------------------------------------------
// Default option values — applied when callers omit a field
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: Readonly<Required<Pick<AgentLoopOptions, 'maxIterations' | 'maxRecoveryAttempts' | 'maxPlanParseRetries'>>> = {
  maxIterations: 50,
  maxRecoveryAttempts: 3,
  maxPlanParseRetries: 2,
};

// ---------------------------------------------------------------------------
// AgentLoopService
// ---------------------------------------------------------------------------

/**
 * Orchestrates the PLAN→ACT→OBSERVE→REFLECT→UPDATE loop and error recovery.
 *
 * - Implements IAgentLoop; all step logic is in private methods.
 * - All dependencies are constructor-injected; no direct SDK or tool impl imports.
 * - The stop flag (#stopRequested) is the only mutable class-level state.
 * - Never throws from run() — all errors surface as TerminationCondition values.
 */
export class AgentLoopService implements IAgentLoop {
  readonly #executor: IToolExecutor;
  readonly #registry: IToolRegistry;
  readonly #llm: LlmProviderPort;
  readonly #toolContext: ToolContext;

  /** Set to true by stop(); checked at the start of every iteration. */
  #stopRequested = false;
  /** Updated at each step; returned by getState() for external status queries. */
  #currentState: AgentState | null = null;

  constructor(
    executor: IToolExecutor,
    registry: IToolRegistry,
    llm: LlmProviderPort,
    toolContext: ToolContext,
  ) {
    this.#executor = executor;
    this.#registry = registry;
    this.#llm = llm;
    this.#toolContext = toolContext;
  }

  // ---------------------------------------------------------------------------
  // Public interface — IAgentLoop
  // ---------------------------------------------------------------------------

  /**
   * Execute the agent loop for the given task.
   * Never throws — all errors surface as TerminationCondition in AgentLoopResult.
   */
  async run(task: string, options?: Partial<AgentLoopOptions>): Promise<AgentLoopResult> {
    // Merge caller options with defaults
    const maxIterations = options?.maxIterations ?? DEFAULT_OPTIONS.maxIterations;
    const maxRecoveryAttempts = options?.maxRecoveryAttempts ?? DEFAULT_OPTIONS.maxRecoveryAttempts;
    const maxPlanParseRetries = options?.maxPlanParseRetries ?? DEFAULT_OPTIONS.maxPlanParseRetries;
    const opts = { ...options, maxIterations, maxRecoveryAttempts, maxPlanParseRetries };

    // Reset stop flag for this run
    this.#stopRequested = false;

    // Initialize state
    let state = this.#initState(task);
    this.#currentState = state;

    try {
      // Retrieve available tool schemas once at startup (req 10.3)
      // Passed to PLAN step context — tasks 4.x
      const _toolSchemas = this.#registry.list();

      // Outer iteration loop — PLAN→ACT→OBSERVE→REFLECT→UPDATE (tasks 4.x–8.x)
      while (!this.#stopRequested && state.iterationCount < opts.maxIterations) {
        // TODO: execute one full iteration cycle (tasks 4.1, 4.2, 5.1–5.3, 6.x, 7.x, 8.x)
        // Placeholder: break so the loop exits via maxIterations check below
        break;
      }

      return {
        terminationCondition: 'MAX_ITERATIONS_REACHED',
        finalState: state,
        totalIterations: state.iterationCount,
        taskCompleted: false,
      };
    } catch (_err) {
      // run() must never throw — catch-all for unexpected internal failures
      return {
        terminationCondition: 'HUMAN_INTERVENTION_REQUIRED',
        finalState: state,
        totalIterations: state.iterationCount,
        taskCompleted: false,
      };
    } finally {
      // Always clear current state on exit (req 9.4 — query returns null when not running)
      this.#currentState = null;
    }
  }

  /** Signal graceful stop; the loop halts at the next PLAN step boundary. */
  stop(): void {
    this.#stopRequested = true;
  }

  /** Returns current AgentState snapshot, or null when no run is active. */
  getState(): Readonly<AgentState> | null {
    return this.#currentState;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  #initState(task: string): AgentState {
    return {
      task,
      plan: [],
      completedSteps: [],
      currentStep: null,
      iterationCount: 0,
      observations: [],
      recoveryAttempts: 0,
      startedAt: new Date().toISOString(),
    };
  }
}
