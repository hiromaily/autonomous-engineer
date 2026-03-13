import type { IAgentLoop, AgentLoopOptions, AgentLoopResult, IContextProvider } from '../ports/agent-loop';
import type { IToolExecutor } from '../tools/executor';
import type { IToolRegistry, ToolListEntry } from '../../domain/tools/registry';
import type { LlmProviderPort } from '../ports/llm';
import type { ToolContext } from '../../domain/tools/types';
import type { AgentState, ActionPlan, ActionCategory, Observation, ReflectionOutput, ReflectionAssessment, PlanAdjustment, TerminationCondition } from '../../domain/agent/types';
import { ACTION_CATEGORIES } from '../../domain/agent/types';

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
      const toolSchemas = this.#registry.list();

      // Outer iteration loop — PLAN→ACT→OBSERVE→REFLECT→UPDATE (tasks 4.x–8.x)
      while (!this.#stopRequested && state.iterationCount < opts.maxIterations) {
        // PLAN step — throws on exhausted retries (caught below → HUMAN_INTERVENTION_REQUIRED)
        const plan = await this.#planStep(state, toolSchemas, opts);
        // ACT step — throws on permission error (caught below → HUMAN_INTERVENTION_REQUIRED)
        const observation = await this.#actStep(plan);
        // OBSERVE step (task 5.1) — append observation to state (immutable)
        state = this.#observeStep(observation, state);
        // REFLECT step (task 5.2) — embed reflection into latest observation
        state = await this.#reflectStep(plan, state);
        // UPDATE STATE step (task 5.3) — advance step pointer, increment iteration counter
        state = this.#updateStateStep(state);
        this.#currentState = state;

        // Task 6.1 — check termination conditions from reflection after each complete cycle
        const latestReflection = state.observations[state.observations.length - 1]?.reflection;
        if (latestReflection?.taskComplete === true) {
          return this.#terminate('TASK_COMPLETED', state, true, opts);
        }
        if (latestReflection?.requiresHumanIntervention === true) {
          return this.#terminate('HUMAN_INTERVENTION_REQUIRED', state, false, opts);
        }

        // Task 7.1 — error recovery sub-loop: enter when reflection indicates failure
        if (latestReflection?.assessment === 'failure') {
          const recoveryResult = await this.#errorRecovery(state, opts);
          if ('type' in recoveryResult && recoveryResult.type === 'RECOVERY_EXHAUSTED') {
            // Task 7.2 — use the state with failure context (recoveryAttempts set) for the result
            return this.#terminate('RECOVERY_EXHAUSTED', recoveryResult.state, false, opts);
          }
          state = recoveryResult as AgentState;
          this.#currentState = state;
        }
      }

      // Task 6.1 — distinguish stop signal from max-iterations exhaustion
      if (this.#stopRequested) {
        return this.#terminate('SAFETY_STOP', state, false, opts);
      }

      return this.#terminate('MAX_ITERATIONS_REACHED', state, false, opts);
    } catch (_err) {
      // run() must never throw — catch-all for unexpected internal failures
      return this.#terminate('HUMAN_INTERVENTION_REQUIRED', state, false, opts);
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

  /**
   * Task 6.2 — centralises all exit paths:
   * - Emits a `terminated` event on the event bus (if configured).
   * - Logs a final summary entry (if logger is configured).
   * - Calls opts.onSafetyStop() when the condition is SAFETY_STOP.
   * - Assembles and returns the AgentLoopResult.
   */
  #terminate(
    condition: TerminationCondition,
    state: AgentState,
    taskCompleted: boolean,
    opts: Pick<AgentLoopOptions, 'eventBus' | 'logger' | 'onSafetyStop'>,
  ): AgentLoopResult {
    const result: AgentLoopResult = {
      terminationCondition: condition,
      finalState: state,
      totalIterations: state.iterationCount,
      taskCompleted,
    };

    // Emit terminated event for every exit path (task 6.2)
    opts.eventBus?.emit({
      type: 'terminated',
      condition,
      finalState: state,
      timestamp: new Date().toISOString(),
    });

    // Log a final summary (task 6.2)
    opts.logger?.info(`Agent loop terminated: ${condition}`, {
      terminationCondition: condition,
      iterationCount: state.iterationCount,
      completedSteps: state.completedSteps.length,
      toolsInvoked: state.observations.length,
      errorsEncountered: state.observations.filter((o) => !o.success).length,
      pendingSteps: state.plan.filter((s) => !state.completedSteps.includes(s)).length,
    });

    // Notify safety layer on SAFETY_STOP (task 6.2)
    if (condition === 'SAFETY_STOP') {
      opts.onSafetyStop?.();
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // PLAN step (task 4.1)
  // ---------------------------------------------------------------------------

  /**
   * Assembles context, calls the LLM, and parses the response into an ActionPlan.
   * Retries on parse failure up to opts.maxPlanParseRetries times.
   * Throws if all attempts are exhausted — caught by run()'s outer catch.
   */
  async #planStep(
    state: AgentState,
    toolSchemas: ReadonlyArray<ToolListEntry>,
    opts: { maxPlanParseRetries: number; contextProvider?: IContextProvider },
  ): Promise<ActionPlan> {
    const baseContext = opts.contextProvider
      ? await opts.contextProvider.buildContext(state, toolSchemas)
      : this.#buildFallbackContext(state, toolSchemas);

    const totalAttempts = 1 + opts.maxPlanParseRetries;
    let lastError = '';

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      const prompt = attempt === 0
        ? baseContext
        : `${baseContext}\n\nPrevious attempt failed: ${lastError}. Please respond with valid JSON.`;

      const result = await this.#llm.complete(prompt);

      if (!result.ok) {
        lastError = result.error.message;
        continue;
      }

      const plan = this.#parseActionPlan(result.value.content);
      if (plan !== null) {
        return plan;
      }

      lastError = `Invalid plan format: ${result.value.content.slice(0, 100)}`;
    }

    throw new Error(`PLAN step failed after ${totalAttempts} attempt(s): ${lastError}`);
  }

  // ---------------------------------------------------------------------------
  // ACT step (task 4.2)
  // ---------------------------------------------------------------------------

  /**
   * Invokes the tool executor with the planned tool name and inputs.
   * - On success: returns an Observation with success=true and the raw output.
   * - On non-permission failure: returns an Observation with success=false (recovery in task 7.x).
   * - On permission failure: throws immediately (caught by run() → HUMAN_INTERVENTION_REQUIRED).
   */
  async #actStep(plan: ActionPlan): Promise<Observation> {
    const result = await this.#executor.invoke(plan.toolName, plan.toolInput, this.#toolContext);
    const recordedAt = new Date().toISOString();

    if (result.ok) {
      return {
        toolName: plan.toolName,
        toolInput: plan.toolInput,
        rawOutput: result.value,
        success: true,
        recordedAt,
      };
    }

    // Permission errors bypass the recovery sub-loop — throw immediately
    if (result.error.type === 'permission') {
      throw new Error(`ACT step: permission denied — ${result.error.message}`);
    }

    // Non-permission failures return a failure observation (recovery handled in task 7.x)
    return {
      toolName: plan.toolName,
      toolInput: plan.toolInput,
      rawOutput: undefined,
      error: result.error,
      success: false,
      recordedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // OBSERVE step (task 5.1)
  // ---------------------------------------------------------------------------

  /**
   * Appends the observation produced by the ACT step to the agent state.
   * Never mutates the existing state — returns a replacement state object.
   */
  #observeStep(observation: Observation, state: AgentState): AgentState {
    return {
      ...state,
      observations: [...state.observations, observation],
    };
  }

  // ---------------------------------------------------------------------------
  // REFLECT step (task 5.2)
  // ---------------------------------------------------------------------------

  /**
   * Sends a reflection prompt to the LLM, parses the response into a ReflectionOutput,
   * and embeds it into the latest observation in the state.
   * On parse failure, embeds a failure assessment reflection rather than crashing.
   * Returns a new immutable AgentState with the updated observation.
   */
  async #reflectStep(plan: ActionPlan, state: AgentState): Promise<AgentState> {
    const prompt = this.#buildReflectionPrompt(plan, state);
    const result = await this.#llm.complete(prompt);

    let reflection: ReflectionOutput;
    if (!result.ok) {
      reflection = this.#makeFailureReflection(`LLM error: ${result.error.message}`);
    } else {
      const parsed = this.#parseReflection(result.value.content);
      reflection = parsed ?? this.#makeFailureReflection(`Parse failure: ${result.value.content.slice(0, 100)}`);
    }

    // Embed reflection into the latest observation — never mutate existing state
    const lastIdx = state.observations.length - 1;
    if (lastIdx < 0) return state;
    const observations = [
      ...state.observations.slice(0, lastIdx),
      { ...state.observations[lastIdx]!, reflection },
    ];

    return { ...state, observations };
  }

  /** Builds the reflection prompt combining task, plan rationale, and latest tool result. */
  #buildReflectionPrompt(plan: ActionPlan, state: AgentState): string {
    const latestObs = state.observations[state.observations.length - 1];
    const MAX_OUTPUT_CHARS = 500;
    const toolResultStr = latestObs
      ? latestObs.success
        ? JSON.stringify(latestObs.rawOutput).slice(0, MAX_OUTPUT_CHARS)
        : `Error (${latestObs.error?.type}): ${latestObs.error?.message}`
      : '(none)';

    return [
      `Task: ${state.task}`,
      `Action taken: ${plan.toolName} (${plan.category})`,
      `Rationale: ${plan.rationale}`,
      `Tool result: ${toolResultStr}`,
      `Iteration: ${state.iterationCount}`,
      '\nEvaluate the result and respond with JSON: { "assessment": "expected"|"unexpected"|"failure", "learnings": string[], "planAdjustment": "continue"|"revise"|"stop", "revisedPlan": string[] (optional), "requiresHumanIntervention": boolean (optional), "taskComplete": boolean (optional), "summary": string }',
    ].join('\n\n');
  }

  /** Returns a failure-assessment ReflectionOutput for use when LLM response cannot be parsed. */
  #makeFailureReflection(reason: string): ReflectionOutput {
    return {
      assessment: 'failure',
      learnings: [],
      planAdjustment: 'stop',
      summary: reason,
    };
  }

  /**
   * Strips optional markdown code fences and parses the content as JSON.
   * Returns the parsed object cast to `Record<string, unknown>`, or null on any failure.
   * Shared by both #parseActionPlan and #parseReflection.
   */
  #parseLlmJson(content: string): Record<string, unknown> | null {
    try {
      const jsonStr = content.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? content;
      const parsed: unknown = JSON.parse(jsonStr);
      if (typeof parsed !== 'object' || parsed === null) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Parses and validates LLM response content into a ReflectionOutput, or returns null on failure. */
  #parseReflection(content: string): ReflectionOutput | null {
    const obj = this.#parseLlmJson(content);
    if (!obj) return null;

    const assessment = obj['assessment'];
    if (!['expected', 'unexpected', 'failure'].includes(assessment as string)) return null;

    const learnings = obj['learnings'];
    if (!Array.isArray(learnings) || !learnings.every((l) => typeof l === 'string')) return null;

    const planAdjustment = obj['planAdjustment'];
    if (!['continue', 'revise', 'stop'].includes(planAdjustment as string)) return null;

    const summary = obj['summary'];
    if (typeof summary !== 'string') return null;

    const revisedPlan = obj['revisedPlan'];
    const requiresHumanIntervention = obj['requiresHumanIntervention'];
    const taskComplete = obj['taskComplete'];

    return {
      assessment: assessment as ReflectionAssessment,
      learnings: learnings as ReadonlyArray<string>,
      planAdjustment: planAdjustment as PlanAdjustment,
      ...(Array.isArray(revisedPlan) ? { revisedPlan: revisedPlan as ReadonlyArray<string> } : {}),
      ...(typeof requiresHumanIntervention === 'boolean' ? { requiresHumanIntervention } : {}),
      ...(typeof taskComplete === 'boolean' ? { taskComplete } : {}),
      summary,
    };
  }

  // ---------------------------------------------------------------------------
  // UPDATE STATE step (task 5.3)
  // ---------------------------------------------------------------------------

  /**
   * Advances the agent state after a complete PLAN→ACT→OBSERVE→REFLECT cycle:
   * - Always increments iterationCount.
   * - On plan revision: replaces plan with revisedPlan, sets currentStep to first incomplete step.
   * - On non-failure assessment: moves currentStep to completedSteps and advances the pointer.
   * - On failure assessment (or missing reflection): increments counter only.
   * Never mutates the existing state — returns a replacement state object.
   */
  #updateStateStep(state: AgentState): AgentState {
    const latestObs = state.observations[state.observations.length - 1];
    const reflection = latestObs?.reflection;

    // Always increment iteration counter
    const base: AgentState = { ...state, iterationCount: state.iterationCount + 1 };

    if (!reflection || reflection.assessment === 'failure') {
      // Failure or no reflection: increment only
      return base;
    }

    // Plan revision: replace plan, set currentStep to first incomplete step
    if (reflection.planAdjustment === 'revise' && reflection.revisedPlan && reflection.revisedPlan.length > 0) {
      const newPlan = reflection.revisedPlan;
      const completedSet = new Set(base.completedSteps);
      const newCurrentStep = newPlan.find((s) => !completedSet.has(s)) ?? null;
      return { ...base, plan: newPlan, currentStep: newCurrentStep };
    }

    // Non-failure (expected or unexpected): move currentStep to completedSteps, advance pointer
    if (base.currentStep !== null) {
      const completedSteps = [...base.completedSteps, base.currentStep];
      const completedSet = new Set(completedSteps);
      const nextStep = base.plan.find((s) => !completedSet.has(s)) ?? null;
      return { ...base, completedSteps, currentStep: nextStep };
    }

    return base;
  }

  /** Inline context builder used when no IContextProvider is injected. */
  #buildFallbackContext(state: AgentState, toolSchemas: ReadonlyArray<ToolListEntry>): string {
    const toolList = toolSchemas.map((t) => `- ${t.name}: ${t.description}`).join('\n');
    const recentObs = state.observations.slice(-5).map((o) =>
      `Tool: ${o.toolName}, Success: ${o.success}`,
    ).join('\n');

    return [
      `Task: ${state.task}`,
      `Available tools:\n${toolList || '(none)'}`,
      `Recent observations:\n${recentObs || '(none)'}`,
      `Iteration: ${state.iterationCount}`,
      '\nRespond with JSON: { "category": "Exploration"|"Modification"|"Validation"|"Documentation", "toolName": string, "toolInput": object, "rationale": string }',
    ].join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // Error recovery sub-loop (task 7.1)
  // ---------------------------------------------------------------------------

  /**
   * Orchestrates the error recovery cycle when REFLECT returns assessment='failure'.
   *
   * Task 7.2 additions:
   * - Detects repeated failure patterns: if the same (toolName, errorMessage) has appeared in
   *   previous observations >= maxRecoveryAttempts times, escalates immediately without retrying.
   * - Returns the updated state (with recoveryAttempts set) on exhaustion so the caller can
   *   surface the failure context in the AgentLoopResult.
   *
   * For each attempt (up to maxRecoveryAttempts):
   * 1. Emit a recovery:attempt event.
   * 2. Ask the LLM for an error-analysis fix plan.
   * 3. Execute the fix action via the executor.
   * 4. Re-run the original failing tool as validation.
   * 5a. Validation passes → append validation observation, reset counter, return recovered state.
   * 5b. Validation fails → increment counter and loop back.
   *
   * On exhaustion, returns `{ type: 'RECOVERY_EXHAUSTED', state }` with the failure context preserved.
   */
  async #errorRecovery(
    state: AgentState,
    opts: Pick<AgentLoopOptions, 'maxRecoveryAttempts' | 'eventBus' | 'logger'>,
  ): Promise<AgentState | Readonly<{ type: 'RECOVERY_EXHAUSTED'; state: AgentState }>> {
    const failingObs = state.observations[state.observations.length - 1]!;
    const errorMessage = failingObs.error?.message ?? 'unknown failure';

    // Task 7.2 — repeated failure pattern detection: only when the failing observation has
    // a real tool error (success=false with an error). Count prior observations with the same
    // (toolName, errorMessage) combination; if already at or above the budget, escalate immediately.
    if (failingObs.error) {
      const previousSameErrorCount = state.observations.slice(0, -1).filter(
        (obs) =>
          !obs.success &&
          obs.toolName === failingObs.toolName &&
          obs.error?.message === failingObs.error!.message,
      ).length;

      if (previousSameErrorCount >= opts.maxRecoveryAttempts) {
        // Repeated failure pattern — escalate without attempting recovery
        return { type: 'RECOVERY_EXHAUSTED', state } as const;
      }
    }

    let currentState = state;

    while (currentState.recoveryAttempts < opts.maxRecoveryAttempts) {
      // Increment attempt counter
      currentState = { ...currentState, recoveryAttempts: currentState.recoveryAttempts + 1 };

      // Emit recovery:attempt event
      opts.eventBus?.emit({
        type: 'recovery:attempt',
        attempt: currentState.recoveryAttempts,
        maxAttempts: opts.maxRecoveryAttempts,
        errorMessage,
      });

      // Log recovery attempt
      opts.logger?.info(`Recovery attempt ${currentState.recoveryAttempts}/${opts.maxRecoveryAttempts}`, {
        attempt: currentState.recoveryAttempts,
        maxAttempts: opts.maxRecoveryAttempts,
        failingTool: failingObs.toolName,
      });

      // Get error-analysis fix plan from LLM
      const errorPrompt = this.#buildErrorAnalysisPrompt(failingObs, currentState);
      const llmResult = await this.#llm.complete(errorPrompt);

      if (!llmResult.ok) {
        // LLM error — can't get fix plan; continue to next attempt
        continue;
      }

      const fixPlan = this.#parseActionPlan(llmResult.value.content);
      if (!fixPlan) {
        // Unparseable fix plan — continue
        continue;
      }

      // Execute the fix action
      await this.#executor.invoke(fixPlan.toolName, fixPlan.toolInput, this.#toolContext);

      // Re-run original failing tool as validation
      const validationResult = await this.#executor.invoke(
        failingObs.toolName,
        failingObs.toolInput,
        this.#toolContext,
      );

      if (validationResult.ok) {
        // Recovery succeeded — append validation observation and reset counter
        const validationObs: Observation = {
          toolName: failingObs.toolName,
          toolInput: failingObs.toolInput,
          rawOutput: validationResult.value,
          success: true,
          recordedAt: new Date().toISOString(),
        };
        return {
          ...currentState,
          observations: [...currentState.observations, validationObs],
          recoveryAttempts: 0,
        };
      }

      // Validation failed — loop back for next attempt
    }

    // Task 7.2 — return the state with failure context (recoveryAttempts reflects exhausted count)
    return { type: 'RECOVERY_EXHAUSTED', state: currentState } as const;
  }

  /** Builds the error-analysis prompt for the recovery LLM call. */
  #buildErrorAnalysisPrompt(failingObs: Observation, state: AgentState): string {
    return [
      `Task: ${state.task}`,
      `Error recovery attempt ${state.recoveryAttempts}:`,
      `The previous action failed:`,
      `  Tool: ${failingObs.toolName}`,
      `  Error: ${failingObs.error?.message ?? 'unknown error'}`,
      '\nAnalyze the error and propose a fix action. Respond with JSON:',
      '{ "category": "Exploration"|"Modification"|"Validation"|"Documentation", "toolName": string, "toolInput": object, "rationale": string }',
    ].join('\n');
  }

  /** Parses and validates LLM response content into an ActionPlan, or returns null on failure. */
  #parseActionPlan(content: string): ActionPlan | null {
    const obj = this.#parseLlmJson(content);
    if (!obj) return null;

    const category = obj['category'];
    if (!ACTION_CATEGORIES.includes(category as ActionCategory)) return null;

    const toolName = obj['toolName'];
    if (typeof toolName !== 'string' || toolName.length === 0) return null;

    const toolInput = obj['toolInput'];
    if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return null;

    const rationale = obj['rationale'];
    if (typeof rationale !== 'string') return null;

    return {
      category: category as ActionCategory,
      toolName,
      toolInput: toolInput as Readonly<Record<string, unknown>>,
      rationale,
    };
  }
}
