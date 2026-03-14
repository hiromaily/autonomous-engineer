/**
 * Integration tests for AgentLoopService with a real ToolRegistry.
 *
 * Task 11.1: Full PLAN→ACT→OBSERVE→REFLECT→UPDATE cycle
 *
 * Integration scope:
 * - Real ToolRegistry (not mock) populated with a mock tool
 * - Mock IToolExecutor, mock LlmProviderPort, mock IAgentEventBus
 * - Verifies complete multi-iteration cycle: step promotion, state accumulation,
 *   event ordering, and concurrent getState() reads.
 *
 * Note on "three completed steps":
 *   The initial AgentState has an empty plan. The first REFLECT must revise the plan
 *   before any step can be promoted. To promote 3 steps to completedSteps, the test
 *   therefore runs 4 iterations (1 revision + 3 promotions) with maxIterations: 4.
 *
 * Requirements: 1.1, 1.2, 1.3, 4.1, 4.2, 5.1, 5.2, 6.1, 10.3
 */
import { AgentLoopService } from "@/application/agent/agent-loop-service";
import type { IAgentEventBus } from "@/application/ports/agent-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { IToolExecutor } from "@/application/tools/executor";
import type { AgentLoopEvent, ReflectionOutput } from "@/domain/agent/types";
import { ToolRegistry } from "@/domain/tools/registry";
import type { MemoryEntry, Tool, ToolContext } from "@/domain/tools/types";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/** A minimal tool with permissive schemas — safe to register in the real ToolRegistry. */
function makeMockTool(name: string, description: string): Tool<unknown, unknown> {
  return {
    name,
    description,
    requiredPermissions: [],
    schema: {
      input: { type: "object" },
      output: { type: "object" },
    },
    async execute(_input: unknown, _ctx: ToolContext): Promise<unknown> {
      return { result: "ok" };
    },
  };
}

function makeToolContext(): ToolContext {
  return {
    workspaceRoot: "/workspace",
    workingDirectory: "/workspace",
    permissions: {
      filesystemRead: true,
      filesystemWrite: false,
      shellExecution: false,
      gitWrite: false,
      networkAccess: false,
    },
    memory: {
      async search(): Promise<ReadonlyArray<MemoryEntry>> {
        return [];
      },
    },
    logger: { info() {}, error() {} },
  };
}

function makeEventBus(): { bus: IAgentEventBus; events: AgentLoopEvent[] } {
  const events: AgentLoopEvent[] = [];
  const bus: IAgentEventBus = {
    emit(event) {
      events.push(event);
    },
    on(_handler) {},
    off(_handler) {},
  };
  return { bus, events };
}

/** Executor that always succeeds with a simple output. */
function makeSucceedingExecutor(): IToolExecutor {
  return {
    async invoke(_name, _input, _ctx) {
      return { ok: true, value: { result: "tool output" } };
    },
  };
}

function makeReflectionJson(overrides: Partial<ReflectionOutput> = {}): string {
  const base: ReflectionOutput = {
    assessment: "expected",
    learnings: ["Action completed as expected"],
    planAdjustment: "continue",
    summary: "Step completed successfully",
    ...overrides,
  };
  return JSON.stringify(base);
}

/**
 * LLM mock for a 4-iteration test that produces 3 completedSteps.
 *
 * Call sequence:
 *   1 (PLAN iter 1):    ActionPlan for mock_tool
 *   2 (REFLECT iter 1): revise plan → ["step-1", "step-2", "step-3", "step-4"]
 *   3 (PLAN iter 2):    ActionPlan for mock_tool
 *   4 (REFLECT iter 2): continue → step-1 promoted
 *   5 (PLAN iter 3):    ActionPlan for mock_tool
 *   6 (REFLECT iter 3): continue → step-2 promoted
 *   7 (PLAN iter 4):    ActionPlan for mock_tool
 *   8 (REFLECT iter 4): continue → step-3 promoted
 */
function makeFourIterationLlm(): LlmProviderPort {
  let callCount = 0;
  return {
    async complete(_prompt) {
      callCount++;
      if (callCount % 2 === 1) {
        // Odd calls = PLAN step
        return {
          ok: true,
          value: {
            content: JSON.stringify({
              category: "Exploration",
              toolName: "mock_tool",
              toolInput: { query: "explore" },
              rationale: "Exploring with mock tool",
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      }
      // Even calls = REFLECT step
      if (callCount === 2) {
        // First REFLECT: revise plan to set up 4 steps
        return {
          ok: true,
          value: {
            content: makeReflectionJson({
              assessment: "expected",
              planAdjustment: "revise",
              revisedPlan: ["step-1", "step-2", "step-3", "step-4"],
              summary: "Revised plan based on initial exploration",
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      }
      // Subsequent REFLECTs: continue advancing through the plan
      return {
        ok: true,
        value: {
          content: makeReflectionJson({ assessment: "expected", planAdjustment: "continue" }),
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      };
    },
    clearContext() {},
  };
}

/**
 * LLM mock for a recovery-then-complete scenario.
 *
 * Call 1 (PLAN iter 1):    ActionPlan for "mock_tool"
 * Call 2 (REFLECT iter 1): failure assessment → enters recovery
 * Call 3 (recovery fix):   ActionPlan for "fix_tool"
 * Call 4 (PLAN iter 2):    ActionPlan for "mock_tool"
 * Call 5 (REFLECT iter 2): taskComplete=true → TASK_COMPLETED
 */
function makeRecoveryThenCompleteLlm(): LlmProviderPort {
  let callCount = 0;
  return {
    async complete(_prompt) {
      callCount++;
      if (callCount === 1) {
        // PLAN iter 1
        return {
          ok: true,
          value: {
            content: JSON.stringify({
              category: "Validation",
              toolName: "mock_tool",
              toolInput: { run: true },
              rationale: "Run the validation step",
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      }
      if (callCount === 2) {
        // REFLECT iter 1: failure — triggers recovery
        return {
          ok: true,
          value: {
            content: makeReflectionJson({ assessment: "failure", planAdjustment: "stop", summary: "Tool failed" }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      }
      if (callCount === 3) {
        // Recovery fix plan
        return {
          ok: true,
          value: {
            content: JSON.stringify({
              category: "Modification",
              toolName: "fix_tool",
              toolInput: { apply: true },
              rationale: "Apply the fix",
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      }
      if (callCount === 4) {
        // PLAN iter 2 — resume after recovery
        return {
          ok: true,
          value: {
            content: JSON.stringify({
              category: "Validation",
              toolName: "mock_tool",
              toolInput: { run: true },
              rationale: "Re-validate after fix",
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      }
      // REFLECT iter 2: task complete
      return {
        ok: true,
        value: {
          content: makeReflectionJson({
            assessment: "expected",
            planAdjustment: "stop",
            taskComplete: true,
            summary: "Task completed after recovery",
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      };
    },
    clearContext() {},
  };
}

/**
 * Executor where the first call (mock_tool ACT) fails, all subsequent calls succeed.
 * Call 1: mock_tool → fail (triggers recovery)
 * Call 2: fix_tool → ok
 * Call 3: mock_tool (validation) → ok  ← recovery succeeds
 * Call 4+: any → ok
 */
function makeFirstCallFailExecutor(): IToolExecutor {
  let callCount = 0;
  return {
    async invoke(_name, _input, _ctx) {
      callCount++;
      if (callCount === 1) return { ok: false, error: { type: "runtime", message: "validation failed" } };
      return { ok: true, value: { result: "ok" } };
    },
  };
}

/** Executor that always fails — drives recovery to exhaustion. */
function makeAlwaysFailExecutor(): IToolExecutor {
  return {
    async invoke(_name, _input, _ctx) {
      return { ok: false, error: { type: "runtime", message: "always fails" } };
    },
  };
}

/**
 * LLM mock for a 2-iteration run.
 * Odd calls = PLAN, even calls = REFLECT (continue, no task complete).
 */
function makeTwoIterationLlm(): LlmProviderPort {
  let n = 0;
  return {
    async complete(_prompt) {
      n++;
      if (n % 2 === 1) {
        return {
          ok: true,
          value: {
            content: JSON.stringify({
              category: "Exploration",
              toolName: "mock_tool",
              toolInput: { query: "test" },
              rationale: "Exploring",
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      }
      return {
        ok: true,
        value: {
          content: makeReflectionJson({ assessment: "expected", planAdjustment: "continue" }),
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      };
    },
    clearContext() {},
  };
}

// ---------------------------------------------------------------------------
// Task 11.1 — Full cycle with real ToolRegistry
// ---------------------------------------------------------------------------

describe("AgentLoopService integration — real ToolRegistry (task 11.1)", () => {
  it("real ToolRegistry.list() reflects the registered mock tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "A mock tool for integration testing"));

    const entries = registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("mock_tool");
    expect(entries[0]?.description).toBe("A mock tool for integration testing");
  });

  it("service runs 4 iterations and accumulates 4 observations", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock exploration tool"));

    const service = new AgentLoopService(
      makeSucceedingExecutor(),
      registry,
      makeFourIterationLlm(),
      makeToolContext(),
    );
    const result = await service.run("integration test task", { maxIterations: 4 });

    expect(result.finalState.observations).toHaveLength(4);
  });

  it("service produces 3 completedSteps after 4 iterations (1 revision + 3 promotions)", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock exploration tool"));

    const service = new AgentLoopService(
      makeSucceedingExecutor(),
      registry,
      makeFourIterationLlm(),
      makeToolContext(),
    );
    const result = await service.run("integration test task", { maxIterations: 4 });

    expect(result.finalState.completedSteps).toHaveLength(3);
    expect(result.finalState.completedSteps).toEqual(["step-1", "step-2", "step-3"]);
  });

  it("service finalState.iterationCount equals 4 after 4 complete cycles", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock exploration tool"));

    const service = new AgentLoopService(
      makeSucceedingExecutor(),
      registry,
      makeFourIterationLlm(),
      makeToolContext(),
    );
    const result = await service.run("integration test task", { maxIterations: 4 });

    expect(result.finalState.iterationCount).toBe(4);
    expect(result.totalIterations).toBe(4);
  });

  it("terminates with MAX_ITERATIONS_REACHED when maxIterations is reached", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock exploration tool"));

    const service = new AgentLoopService(
      makeSucceedingExecutor(),
      registry,
      makeFourIterationLlm(),
      makeToolContext(),
    );
    const result = await service.run("integration test task", { maxIterations: 4 });

    expect(result.terminationCondition).toBe("MAX_ITERATIONS_REACHED");
    expect(result.taskCompleted).toBe(false);
  });

  it("each iteration's observation records the mock_tool invocation", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock exploration tool"));

    const service = new AgentLoopService(
      makeSucceedingExecutor(),
      registry,
      makeFourIterationLlm(),
      makeToolContext(),
    );
    const result = await service.run("integration test task", { maxIterations: 4 });

    for (const obs of result.finalState.observations) {
      expect(obs.toolName).toBe("mock_tool");
      expect(obs.success).toBe(true);
    }
  });

  it("each iteration's observation has an embedded reflection", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock exploration tool"));

    const service = new AgentLoopService(
      makeSucceedingExecutor(),
      registry,
      makeFourIterationLlm(),
      makeToolContext(),
    );
    const result = await service.run("integration test task", { maxIterations: 4 });

    for (const obs of result.finalState.observations) {
      expect(obs.reflection).toBeDefined();
      expect(obs.reflection?.assessment).toBeDefined();
    }
  });

  it("event bus receives iteration-start and terminated events", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock exploration tool"));

    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(
      makeSucceedingExecutor(),
      registry,
      makeFourIterationLlm(),
      makeToolContext(),
    );
    await service.run("integration test task", { maxIterations: 4, eventBus: bus });

    const iterStartEvents = events.filter((e) => e.type === "iteration:start");
    const termEvents = events.filter((e) => e.type === "terminated");

    expect(iterStartEvents.length).toBe(4);
    expect(termEvents.length).toBe(1);
    expect((termEvents[0] as Extract<AgentLoopEvent, { type: "terminated" }>).condition).toBe("MAX_ITERATIONS_REACHED");
  });

  it("getState() returns a non-null snapshot containing the task string during execution", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock exploration tool"));

    let snapshotDuringExecution: ReturnType<AgentLoopService["getState"]> = null;
    let svc!: AgentLoopService;

    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        snapshotDuringExecution = svc.getState();
        return { ok: true, value: { result: "ok" } };
      },
    };

    svc = new AgentLoopService(executor, registry, makeFourIterationLlm(), makeToolContext());
    await svc.run("my integration task", { maxIterations: 1 });

    expect(snapshotDuringExecution).not.toBeNull();
    expect((snapshotDuringExecution as ReturnType<AgentLoopService["getState"]>)?.task).toBe("my integration task");
  });

  it("getState() snapshot during execution has a valid iterationCount", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock exploration tool"));

    let snapshotDuringExecution: ReturnType<AgentLoopService["getState"]> = null;
    let svc!: AgentLoopService;

    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        snapshotDuringExecution = svc.getState();
        return { ok: true, value: { result: "ok" } };
      },
    };

    svc = new AgentLoopService(executor, registry, makeFourIterationLlm(), makeToolContext());
    await svc.run("integration task", { maxIterations: 2 });

    expect(typeof (snapshotDuringExecution as ReturnType<AgentLoopService["getState"]>)?.iterationCount).toBe("number");
  });

  it("multiple tools can be registered and all appear in the registry list", () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("tool_a", "Tool A"));
    registry.register(makeMockTool("tool_b", "Tool B"));
    registry.register(makeMockTool("tool_c", "Tool C"));

    const entries = registry.list();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.name)).toContain("tool_a");
    expect(entries.map((e) => e.name)).toContain("tool_b");
    expect(entries.map((e) => e.name)).toContain("tool_c");
  });

  it("getState() returns null when no run is active", () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock tool"));

    const service = new AgentLoopService(
      makeSucceedingExecutor(),
      registry,
      makeFourIterationLlm(),
      makeToolContext(),
    );

    expect(service.getState()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 11.2 — Error recovery integration: full recovery cycle
// ---------------------------------------------------------------------------

describe("AgentLoopService integration — error recovery cycle (task 11.2)", () => {
  it("tool fails first call, validation succeeds — terminates with TASK_COMPLETED", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock validation tool"));
    registry.register(makeMockTool("fix_tool", "Mock fix tool"));

    const service = new AgentLoopService(
      makeFirstCallFailExecutor(),
      registry,
      makeRecoveryThenCompleteLlm(),
      makeToolContext(),
    );
    const result = await service.run("integration recovery task", { maxIterations: 5, maxRecoveryAttempts: 3 });

    expect(result.terminationCondition).toBe("TASK_COMPLETED");
    expect(result.taskCompleted).toBe(true);
  });

  it("tool fails first call, validation succeeds — emits exactly one recovery:attempt event", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock validation tool"));
    registry.register(makeMockTool("fix_tool", "Mock fix tool"));

    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(
      makeFirstCallFailExecutor(),
      registry,
      makeRecoveryThenCompleteLlm(),
      makeToolContext(),
    );
    await service.run("integration recovery task", { maxIterations: 5, maxRecoveryAttempts: 3, eventBus: bus });

    const recoveryEvents = events.filter((e) => e.type === "recovery:attempt");
    expect(recoveryEvents.length).toBe(1);
  });

  it("tool fails first call, validation succeeds — finalState.recoveryAttempts is 0 (reset on success)", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock validation tool"));
    registry.register(makeMockTool("fix_tool", "Mock fix tool"));

    const service = new AgentLoopService(
      makeFirstCallFailExecutor(),
      registry,
      makeRecoveryThenCompleteLlm(),
      makeToolContext(),
    );
    const result = await service.run("integration recovery task", { maxIterations: 5, maxRecoveryAttempts: 3 });

    expect(result.finalState.recoveryAttempts).toBe(0);
  });

  it("tool always fails — terminates with RECOVERY_EXHAUSTED", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock validation tool"));

    // makeRecoveryThenCompleteLlm: call 1=PLAN, call 2=failure REFLECT, call 3+=fix plans
    const service = new AgentLoopService(
      makeAlwaysFailExecutor(),
      registry,
      makeRecoveryThenCompleteLlm(),
      makeToolContext(),
    );
    const result = await service.run("always-fail task", { maxIterations: 5, maxRecoveryAttempts: 3 });

    expect(result.terminationCondition).toBe("RECOVERY_EXHAUSTED");
  });

  it("tool always fails — termination event carries finalState with non-zero recoveryAttempts", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock validation tool"));

    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(
      makeAlwaysFailExecutor(),
      registry,
      makeRecoveryThenCompleteLlm(),
      makeToolContext(),
    );
    await service.run("always-fail task", { maxIterations: 5, maxRecoveryAttempts: 3, eventBus: bus });

    const termEvent = events.find((e) => e.type === "terminated") as
      | Extract<AgentLoopEvent, { type: "terminated" }>
      | undefined;

    expect(termEvent).toBeDefined();
    expect(termEvent?.finalState.recoveryAttempts).toBeGreaterThan(0);
  });

  it("tool always fails — termination event condition is RECOVERY_EXHAUSTED", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock validation tool"));

    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(
      makeAlwaysFailExecutor(),
      registry,
      makeRecoveryThenCompleteLlm(),
      makeToolContext(),
    );
    await service.run("always-fail task", { maxIterations: 5, maxRecoveryAttempts: 3, eventBus: bus });

    const termEvent = events.find((e) => e.type === "terminated") as
      | Extract<AgentLoopEvent, { type: "terminated" }>
      | undefined;

    expect(termEvent?.condition).toBe("RECOVERY_EXHAUSTED");
  });
});

// ---------------------------------------------------------------------------
// Task 11.3 — Event bus ordering and AgentState serialization
// ---------------------------------------------------------------------------

describe("AgentLoopService integration — event ordering and state serialization (task 11.3)", () => {
  // The 5 sub-steps in PLAN→ACT→OBSERVE→REFLECT→UPDATE order
  const STEP_ORDER = ["PLAN", "ACT", "OBSERVE", "REFLECT", "UPDATE_STATE"] as const;

  it("two-iteration run emits iteration:start before any step events for each iteration", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock tool"));

    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeSucceedingExecutor(), registry, makeTwoIterationLlm(), makeToolContext());
    await service.run("ordering test", { maxIterations: 2, eventBus: bus });

    // Find the index of the first step:start event for each iteration
    for (let iter = 0; iter < 2; iter++) {
      const iterStartIdx = events.findIndex(
        (e) => e.type === "iteration:start" && e.iteration === iter,
      );
      const firstStepStartIdx = events.findIndex(
        (e) => e.type === "step:start" && e.iteration === iter,
      );
      expect(iterStartIdx).toBeLessThan(firstStepStartIdx);
    }
  });

  it("two-iteration run emits five step:start/step:complete pairs per iteration in PLAN→UPDATE_STATE order", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock tool"));

    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeSucceedingExecutor(), registry, makeTwoIterationLlm(), makeToolContext());
    await service.run("ordering test", { maxIterations: 2, eventBus: bus });

    for (let iter = 0; iter < 2; iter++) {
      const stepEvents = events.filter(
        (e): e is Extract<AgentLoopEvent, { type: "step:start" | "step:complete" }> =>
          (e.type === "step:start" || e.type === "step:complete") && e.iteration === iter,
      );

      // Should have 10 events (5 start + 5 complete) per iteration
      expect(stepEvents).toHaveLength(10);

      // Verify PLAN→ACT→OBSERVE→REFLECT→UPDATE_STATE order
      for (let i = 0; i < STEP_ORDER.length; i++) {
        expect(stepEvents[i * 2]?.type).toBe("step:start");
        expect(stepEvents[i * 2]?.step).toBe(STEP_ORDER[i]);
        expect(stepEvents[i * 2 + 1]?.type).toBe("step:complete");
        expect(stepEvents[i * 2 + 1]?.step).toBe(STEP_ORDER[i]);
      }
    }
  });

  it("iteration:complete is emitted after all step events and before terminated", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock tool"));

    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeSucceedingExecutor(), registry, makeTwoIterationLlm(), makeToolContext());
    await service.run("ordering test", { maxIterations: 2, eventBus: bus });

    for (let iter = 0; iter < 2; iter++) {
      const lastStepIdx = [...events]
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.type === "step:complete" && e.iteration === iter)
        .at(-1)?.i;
      const iterCompleteIdx = events.findIndex(
        (e) => e.type === "iteration:complete" && e.iteration === iter,
      );
      const terminatedIdx = events.findIndex((e) => e.type === "terminated");

      expect(lastStepIdx).toBeLessThan(iterCompleteIdx);
      expect(iterCompleteIdx).toBeLessThan(terminatedIdx);
    }
  });

  it("terminated event is the last event in the sequence", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock tool"));

    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeSucceedingExecutor(), registry, makeTwoIterationLlm(), makeToolContext());
    await service.run("ordering test", { maxIterations: 2, eventBus: bus });

    const lastEvent = events[events.length - 1];
    if (!lastEvent) throw new Error("expected at least one event");
    expect(lastEvent.type).toBe("terminated");
  });

  it("total event count for 2 iterations is 25 (12 per iteration + 1 terminated)", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock tool"));

    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeSucceedingExecutor(), registry, makeTwoIterationLlm(), makeToolContext());
    await service.run("ordering test", { maxIterations: 2, eventBus: bus });

    // Per iteration: 1 iteration:start + 10 step events + 1 iteration:complete = 12
    // Plus 1 terminated = 25 total
    expect(events).toHaveLength(25);
  });

  it("finalState serializes to JSON and round-trips without data loss — string fields", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock tool"));

    const service = new AgentLoopService(makeSucceedingExecutor(), registry, makeTwoIterationLlm(), makeToolContext());
    const result = await service.run("serialization test task", { maxIterations: 2 });

    const json = JSON.stringify(result.finalState);
    const parsed = JSON.parse(json);

    expect(parsed.task).toBe(result.finalState.task);
    expect(parsed.startedAt).toBe(result.finalState.startedAt);
  });

  it("finalState serializes to JSON and round-trips without data loss — numeric fields", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock tool"));

    const service = new AgentLoopService(makeSucceedingExecutor(), registry, makeTwoIterationLlm(), makeToolContext());
    const result = await service.run("serialization test task", { maxIterations: 2 });

    const json = JSON.stringify(result.finalState);
    const parsed = JSON.parse(json);

    expect(parsed.iterationCount).toBe(result.finalState.iterationCount);
    expect(parsed.recoveryAttempts).toBe(result.finalState.recoveryAttempts);
  });

  it("finalState serializes to JSON and round-trips without data loss — array contents", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock tool"));

    const service = new AgentLoopService(makeSucceedingExecutor(), registry, makeTwoIterationLlm(), makeToolContext());
    const result = await service.run("serialization test task", { maxIterations: 2 });

    const json = JSON.stringify(result.finalState);
    const parsed = JSON.parse(json);

    expect(parsed.plan).toEqual(result.finalState.plan);
    expect(parsed.completedSteps).toEqual(result.finalState.completedSteps);
    expect(parsed.observations).toHaveLength(result.finalState.observations.length);
  });

  it("finalState serializes to JSON and round-trips without data loss — observations detail", async () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("mock_tool", "Mock tool"));

    const service = new AgentLoopService(makeSucceedingExecutor(), registry, makeTwoIterationLlm(), makeToolContext());
    const result = await service.run("serialization test task", { maxIterations: 2 });

    const json = JSON.stringify(result.finalState);
    const parsed = JSON.parse(json);

    for (let i = 0; i < result.finalState.observations.length; i++) {
      const orig = result.finalState.observations[i];
      if (!orig) continue;
      const rt = parsed.observations[i];
      expect(rt.toolName).toBe(orig.toolName);
      expect(rt.success).toBe(orig.success);
      expect(rt.recordedAt).toBe(orig.recordedAt);
      expect(rt.rawOutput).toEqual(orig.rawOutput);
    }
  });
});
