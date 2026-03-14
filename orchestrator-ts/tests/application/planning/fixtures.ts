/**
 * Shared test fixtures for TaskPlanningService tests (tasks 5.1–5.6).
 *
 * Each helper is a pure factory that creates a minimal, valid mock. Helpers that
 * track interactions return an object with both the mock and the capture array.
 */

import type { AgentLoopResult, IAgentLoop } from "../../../src/application/ports/agent-loop";
import type { LlmProviderPort, LlmResult } from "../../../src/application/ports/llm";
import type { IPlanContextBuilder, IPlanEventBus, ITaskPlanStore } from "../../../src/application/ports/task-planning";
import type { AgentState } from "../../../src/domain/agent/types";
import type { PlanEvent, TaskPlan } from "../../../src/domain/planning/types";

// ---------------------------------------------------------------------------
// LLM plan body builders
// ---------------------------------------------------------------------------

/**
 * Builds the JSON string a mock LLM returns for plan generation.
 * Each step gets `description: s.description ?? "Step {id}"`.
 */
export function makePlanBody(
  steps: Array<{ id: string; description?: string; dependsOn?: string[] }> = [{ id: "step-1" }],
  goal = "Implement feature X",
): string {
  return JSON.stringify({
    goal,
    tasks: [
      {
        id: "task-1",
        title: "Task One",
        status: "pending",
        steps: steps.map((s) => ({
          id: s.id,
          description: s.description ?? `Step ${s.id}`,
          status: "pending",
          dependsOn: s.dependsOn ?? [],
          statusHistory: [],
        })),
      },
    ],
  });
}

/** Creates a plan body with `count` steps, each with a unique ID. */
export function makeLargePlanBody(count: number): string {
  return makePlanBody(Array.from({ length: count }, (_, i) => ({ id: `step-${i + 1}` })));
}

/** Creates a plan body containing a step with a high-risk keyword. */
export function makeHighRiskPlanBody(): string {
  return makePlanBody([{ id: "step-1", description: "Delete all stale records from the database" }]);
}

// ---------------------------------------------------------------------------
// LLM result helpers
// ---------------------------------------------------------------------------

export function makeSuccessLlmResult(body: string): LlmResult {
  return { ok: true, value: { content: body, usage: { inputTokens: 10, outputTokens: 20 } } };
}

export function makeFailureLlmResult(message = "LLM API error"): LlmResult {
  return { ok: false, error: { category: "api_error", message, originalError: null } };
}

// ---------------------------------------------------------------------------
// Mock LLM factories
// ---------------------------------------------------------------------------

/**
 * LLM that returns responses in sequence.
 * First call returns a success with `planBody`; subsequent calls use `revisionResponses`.
 * Any call beyond the revision list returns a failure.
 */
export function makeLlm(planBody: string, revisionResponses: LlmResult[] = []): LlmProviderPort {
  let callCount = 0;
  return {
    async complete(): Promise<LlmResult> {
      if (callCount === 0) {
        callCount++;
        return makeSuccessLlmResult(planBody);
      }
      const rev = revisionResponses[callCount - 1];
      callCount++;
      return rev ?? makeFailureLlmResult("no revision response");
    },
    clearContext() {},
  };
}

/**
 * LLM that accepts a full sequence of `LlmResult` values.
 * Beyond the list, returns a failure.
 */
export function makeLlmFromResults(responses: LlmResult[]): LlmProviderPort {
  let callCount = 0;
  return {
    async complete(): Promise<LlmResult> {
      return responses[callCount++] ?? makeFailureLlmResult("no more mock responses");
    },
    clearContext() {},
  };
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export function makeContextBuilder(planContextStr = "plan context"): IPlanContextBuilder {
  return {
    async buildPlanContext() {
      return planContextStr;
    },
    async buildRevisionContext() {
      return "revision context";
    },
  };
}

// ---------------------------------------------------------------------------
// Store factories
// ---------------------------------------------------------------------------

/**
 * Store that captures deep copies of every saved plan.
 * Use `saves` to assert on persisted plan states.
 */
export function makeStore(persisted?: TaskPlan): { store: ITaskPlanStore; saves: TaskPlan[] } {
  const saves: TaskPlan[] = [];
  return {
    saves,
    store: {
      async save(plan) {
        saves.push(JSON.parse(JSON.stringify(plan)) as TaskPlan);
      },
      async load() {
        return persisted ?? null;
      },
      async listResumable() {
        return persisted ? [persisted.id] : [];
      },
    },
  };
}

/**
 * Store that captures deep copies of every saved plan (including status transitions).
 * Identical to `makeStore` but the return field is named `snapshots` for clarity in
 * tests that inspect intermediate persistence states.
 */
export function makeTrackingStore(): { store: ITaskPlanStore; snapshots: TaskPlan[] } {
  const snapshots: TaskPlan[] = [];
  return {
    snapshots,
    store: {
      async save(plan) {
        snapshots.push(JSON.parse(JSON.stringify(plan)) as TaskPlan);
      },
      async load() {
        return null;
      },
      async listResumable() {
        return [];
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

export function makeEventBus(): { bus: IPlanEventBus; events: PlanEvent[] } {
  const events: PlanEvent[] = [];
  return {
    events,
    bus: {
      emit(e) {
        events.push(e);
      },
      on() {},
      off() {},
    },
  };
}

// ---------------------------------------------------------------------------
// Agent loop factories
// ---------------------------------------------------------------------------

/** Always-succeeding agent loop (no tracking). */
export function makeAgentLoop(): IAgentLoop {
  return {
    async run(): Promise<AgentLoopResult> {
      return {
        terminationCondition: "TASK_COMPLETED",
        finalState: {} as AgentState,
        totalIterations: 1,
        taskCompleted: true,
      };
    },
    stop() {},
    getState() {
      return null;
    },
  };
}

/**
 * Agent loop whose calls return results in sequence.
 * Calls beyond the list default to a successful result.
 */
export function makeSequencedAgentLoop(
  results: AgentLoopResult[] = [],
): { agentLoop: IAgentLoop; taskArgs: string[] } {
  const taskArgs: string[] = [];
  let idx = 0;
  return {
    taskArgs,
    agentLoop: {
      async run(task: string): Promise<AgentLoopResult> {
        taskArgs.push(task);
        return results[idx++] ?? makeSuccessResult();
      },
      stop() {},
      getState() {
        return null;
      },
    },
  };
}

/**
 * Agent loop driven by a boolean result list.
 * `results[i]` controls whether the i-th call reports taskCompleted.
 * Calls beyond the list use `defaultResult` (true = success).
 */
export function makeBooleanAgentLoop(
  results: boolean[],
  defaultResult = true,
): { agentLoop: IAgentLoop; taskArgs: string[] } {
  const taskArgs: string[] = [];
  let idx = 0;
  return {
    taskArgs,
    agentLoop: {
      async run(task: string): Promise<AgentLoopResult> {
        taskArgs.push(task);
        const taskCompleted = results[idx++] ?? defaultResult;
        return {
          terminationCondition: taskCompleted ? "TASK_COMPLETED" : "MAX_ITERATIONS",
          finalState: {} as AgentState,
          totalIterations: 1,
          taskCompleted,
        };
      },
      stop() {},
      getState() {
        return null;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// AgentLoopResult helpers
// ---------------------------------------------------------------------------

export function makeSuccessResult(): AgentLoopResult {
  return {
    terminationCondition: "TASK_COMPLETED",
    totalIterations: 1,
    taskCompleted: true,
    finalState: {
      task: "test",
      plan: [],
      completedSteps: [],
      currentStep: null,
      iterationCount: 1,
      recoveryAttempts: 0,
      startedAt: new Date().toISOString(),
      observations: [],
    },
  };
}

export function makeAgentStateWithRevision(revisedPlan: string[], summary: string): AgentState {
  return {
    task: "test",
    plan: [],
    completedSteps: [],
    currentStep: null,
    iterationCount: 1,
    recoveryAttempts: 0,
    startedAt: new Date().toISOString(),
    observations: [
      {
        toolName: "reflect",
        toolInput: {},
        rawOutput: null,
        success: true,
        recordedAt: new Date().toISOString(),
        reflection: {
          assessment: "expected",
          learnings: [],
          planAdjustment: "revise",
          revisedPlan,
          summary,
        },
      },
    ],
  };
}

export function makeRevisionResult(
  revisedDescriptions: string[],
  reason = "Better approach found",
): AgentLoopResult {
  return {
    terminationCondition: "TASK_COMPLETED",
    totalIterations: 1,
    taskCompleted: true,
    finalState: makeAgentStateWithRevision(revisedDescriptions, reason),
  };
}
