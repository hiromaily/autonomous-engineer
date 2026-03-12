import type { IAgentLoop, AgentLoopOptions, AgentLoopResult, IContextProvider } from '../ports/agent-loop';
import type { IToolExecutor } from '../tools/executor';
import type { IToolRegistry, ToolListEntry } from '../../domain/tools/registry';
import type { LlmProviderPort } from '../ports/llm';
import type { ToolContext } from '../../domain/tools/types';
import type { AgentState, ActionPlan, ActionCategory, Observation, ReflectionOutput, ReflectionAssessment, PlanAdjustment } from '../../domain/agent/types';
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
        this.#currentState = state;
        // REFLECT step (task 5.2) — embed reflection into latest observation
        state = await this.#reflectStep(plan, state);
        this.#currentState = state;
        // UPDATE STATE step (task 5.3) — advance step pointer, increment iteration counter
        state = this.#updateStateStep(state);
        this.#currentState = state;
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
    const observations = state.observations.slice();
    const lastIdx = observations.length - 1;
    if (lastIdx >= 0) {
      observations[lastIdx] = { ...observations[lastIdx]!, reflection };
    }

    return { ...state, observations };
  }

  /** Builds the reflection prompt combining task, plan rationale, and latest tool result. */
  #buildReflectionPrompt(plan: ActionPlan, state: AgentState): string {
    const latestObs = state.observations[state.observations.length - 1];
    const toolResultStr = latestObs
      ? latestObs.success
        ? JSON.stringify(latestObs.rawOutput)
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
      planAdjustment: 'continue',
      summary: reason,
    };
  }

  /** Parses and validates LLM response content into a ReflectionOutput, or returns null on failure. */
  #parseReflection(content: string): ReflectionOutput | null {
    try {
      const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1] : content;

      const parsed: unknown = JSON.parse(jsonStr ?? content);
      if (typeof parsed !== 'object' || parsed === null) return null;

      const obj = parsed as Record<string, unknown>;

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
    } catch {
      return null;
    }
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

  /** Parses and validates LLM response content into an ActionPlan, or returns null on failure. */
  #parseActionPlan(content: string): ActionPlan | null {
    try {
      // Strip markdown code fences if present
      const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1] : content;

      const parsed: unknown = JSON.parse(jsonStr ?? content);
      if (typeof parsed !== 'object' || parsed === null) return null;

      const obj = parsed as Record<string, unknown>;

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
    } catch {
      return null;
    }
  }
}
