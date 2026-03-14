import { describe, expect, it } from "bun:test";
import type {
  AgentLoopLogger,
  AgentLoopOptions,
  AgentLoopResult,
  IAgentEventBus,
  IAgentLoop,
  IContextProvider,
} from "../../src/application/ports/agent-loop";
import type { AgentLoopEvent, AgentState } from "../../src/domain/agent/types";

// ---------------------------------------------------------------------------
// Helper: build a minimal AgentState for testing
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    task: "test task",
    plan: [],
    completedSteps: [],
    currentStep: null,
    iterationCount: 0,
    observations: [],
    recoveryAttempts: 0,
    startedAt: "2026-03-11T21:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AgentLoopOptions shape
// ---------------------------------------------------------------------------

describe("AgentLoopOptions shape", () => {
  it("accepts an options object with only required numeric fields set", () => {
    const options: AgentLoopOptions = {
      maxIterations: 50,
      maxRecoveryAttempts: 3,
      maxPlanParseRetries: 2,
    };

    expect(options.maxIterations).toBe(50);
    expect(options.maxRecoveryAttempts).toBe(3);
    expect(options.maxPlanParseRetries).toBe(2);
    expect(options.contextProvider).toBeUndefined();
    expect(options.eventBus).toBeUndefined();
    expect(options.logger).toBeUndefined();
    expect(options.onSafetyStop).toBeUndefined();
  });

  it("accepts options with all optional fields present", () => {
    const onSafetyStop = (): void => {};

    const options: AgentLoopOptions = {
      maxIterations: 100,
      maxRecoveryAttempts: 5,
      maxPlanParseRetries: 3,
      onSafetyStop,
    };

    expect(options.maxIterations).toBe(100);
    expect(options.onSafetyStop).toBe(onSafetyStop);
  });

  it("accepts default numeric values (50, 3, 2)", () => {
    // Verify the intended default values can be assigned without type errors
    const defaults: Pick<AgentLoopOptions, "maxIterations" | "maxRecoveryAttempts" | "maxPlanParseRetries"> = {
      maxIterations: 50,
      maxRecoveryAttempts: 3,
      maxPlanParseRetries: 2,
    };

    expect(defaults.maxIterations).toBe(50);
    expect(defaults.maxRecoveryAttempts).toBe(3);
    expect(defaults.maxPlanParseRetries).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AgentLoopResult shape
// ---------------------------------------------------------------------------

describe("AgentLoopResult shape", () => {
  it("accepts a task-completed result", () => {
    const state = makeState({ iterationCount: 3, completedSteps: ["step 1", "step 2", "step 3"] });

    const result: AgentLoopResult = {
      terminationCondition: "TASK_COMPLETED",
      finalState: state,
      totalIterations: 3,
      taskCompleted: true,
    };

    expect(result.terminationCondition).toBe("TASK_COMPLETED");
    expect(result.finalState.iterationCount).toBe(3);
    expect(result.totalIterations).toBe(3);
    expect(result.taskCompleted).toBe(true);
  });

  it("accepts a max-iterations-reached result with taskCompleted: false", () => {
    const state = makeState({ iterationCount: 50 });

    const result: AgentLoopResult = {
      terminationCondition: "MAX_ITERATIONS_REACHED",
      finalState: state,
      totalIterations: 50,
      taskCompleted: false,
    };

    expect(result.terminationCondition).toBe("MAX_ITERATIONS_REACHED");
    expect(result.taskCompleted).toBe(false);
    expect(result.totalIterations).toBe(50);
  });

  it("accepts all five termination conditions in a result", () => {
    const state = makeState();

    const conditions: AgentLoopResult["terminationCondition"][] = [
      "TASK_COMPLETED",
      "MAX_ITERATIONS_REACHED",
      "HUMAN_INTERVENTION_REQUIRED",
      "SAFETY_STOP",
      "RECOVERY_EXHAUSTED",
    ];

    for (const condition of conditions) {
      const result: AgentLoopResult = {
        terminationCondition: condition,
        finalState: state,
        totalIterations: 1,
        taskCompleted: condition === "TASK_COMPLETED",
      };

      expect(result.terminationCondition).toBe(condition);
    }
  });
});

// ---------------------------------------------------------------------------
// IAgentLoop contract via mock
// ---------------------------------------------------------------------------

describe("IAgentLoop contract (mock implementation)", () => {
  it("run() returns an AgentLoopResult without throwing", async () => {
    const state = makeState();

    const loop: IAgentLoop = {
      async run(_task, _options): Promise<AgentLoopResult> {
        return {
          terminationCondition: "TASK_COMPLETED",
          finalState: state,
          totalIterations: 1,
          taskCompleted: true,
        };
      },
      stop(): void {},
      getState(): Readonly<AgentState> | null {
        return null;
      },
    };

    const result = await loop.run("Implement the feature");
    expect(result.terminationCondition).toBe("TASK_COMPLETED");
    expect(result.taskCompleted).toBe(true);
  });

  it("run() accepts an optional Partial<AgentLoopOptions>", async () => {
    const state = makeState();

    const loop: IAgentLoop = {
      async run(_task, options): Promise<AgentLoopResult> {
        return {
          terminationCondition: "TASK_COMPLETED",
          finalState: state,
          totalIterations: options?.maxIterations ?? 50,
          taskCompleted: true,
        };
      },
      stop(): void {},
      getState(): Readonly<AgentState> | null {
        return null;
      },
    };

    const result = await loop.run("task", { maxIterations: 10 });
    expect(result.totalIterations).toBe(10);
  });

  it("stop() can be called without arguments", () => {
    let stopped = false;

    const loop: IAgentLoop = {
      async run(): Promise<AgentLoopResult> {
        return {
          terminationCondition: "SAFETY_STOP",
          finalState: makeState(),
          totalIterations: 0,
          taskCompleted: false,
        };
      },
      stop(): void {
        stopped = true;
      },
      getState(): Readonly<AgentState> | null {
        return null;
      },
    };

    loop.stop();
    expect(stopped).toBe(true);
  });

  it("getState() returns null when no run is active", () => {
    const loop: IAgentLoop = {
      async run(): Promise<AgentLoopResult> {
        return {
          terminationCondition: "TASK_COMPLETED",
          finalState: makeState(),
          totalIterations: 0,
          taskCompleted: true,
        };
      },
      stop(): void {},
      getState(): Readonly<AgentState> | null {
        return null;
      },
    };

    expect(loop.getState()).toBeNull();
  });

  it("getState() returns a snapshot of the current agent state when running", () => {
    const activeState = makeState({ iterationCount: 2, currentStep: "Write tests" });

    const loop: IAgentLoop = {
      async run(): Promise<AgentLoopResult> {
        return {
          terminationCondition: "TASK_COMPLETED",
          finalState: activeState,
          totalIterations: 2,
          taskCompleted: true,
        };
      },
      stop(): void {},
      getState(): Readonly<AgentState> | null {
        return activeState;
      },
    };

    const snapshot = loop.getState();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.iterationCount).toBe(2);
    expect(snapshot?.currentStep).toBe("Write tests");
  });

  it("run() never throws — errors surface in AgentLoopResult", async () => {
    const state = makeState();

    const loop: IAgentLoop = {
      async run(): Promise<AgentLoopResult> {
        // Simulate internal error captured as HUMAN_INTERVENTION_REQUIRED
        return {
          terminationCondition: "HUMAN_INTERVENTION_REQUIRED",
          finalState: state,
          totalIterations: 1,
          taskCompleted: false,
        };
      },
      stop(): void {},
      getState(): Readonly<AgentState> | null {
        return null;
      },
    };

    // run() must not throw even when the task cannot complete
    const result = await loop.run("ambiguous task");
    expect(result.terminationCondition).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(result.taskCompleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IContextProvider contract via mock
// ---------------------------------------------------------------------------

describe("IContextProvider contract (mock implementation)", () => {
  it("buildContext() receives state and tool schemas, returns a string prompt", async () => {
    const state = makeState({ task: "Add feature X", iterationCount: 1 });

    const provider: IContextProvider = {
      async buildContext(s, toolSchemas): Promise<string> {
        return `Task: ${s.task}\nAvailable tools: ${toolSchemas.map((t) => t.name).join(", ")}`;
      },
    };

    const schemas = [
      { name: "read_file", description: "Read a file", schema: { input: {}, output: {} } },
      { name: "write_file", description: "Write a file", schema: { input: {}, output: {} } },
    ];

    const context = await provider.buildContext(state, schemas);
    expect(context).toContain("Task: Add feature X");
    expect(context).toContain("read_file");
    expect(context).toContain("write_file");
  });

  it("buildContext() can return an empty string for a state with no observations", async () => {
    const state = makeState();

    const provider: IContextProvider = {
      async buildContext(_s, _schemas): Promise<string> {
        return "";
      },
    };

    const context = await provider.buildContext(state, []);
    expect(typeof context).toBe("string");
    expect(context).toBe("");
  });
});

// ---------------------------------------------------------------------------
// IAgentEventBus contract via mock
// ---------------------------------------------------------------------------

describe("IAgentEventBus contract (mock implementation)", () => {
  it("emit() delivers the event to registered on() handlers", () => {
    const received: AgentLoopEvent[] = [];
    const handlers: ((event: AgentLoopEvent) => void)[] = [];

    const bus: IAgentEventBus = {
      emit(event: AgentLoopEvent): void {
        for (const handler of handlers) handler(event);
      },
      on(handler: (event: AgentLoopEvent) => void): void {
        handlers.push(handler);
      },
      off(handler: (event: AgentLoopEvent) => void): void {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      },
    };

    const handler = (e: AgentLoopEvent): void => {
      received.push(e);
    };
    bus.on(handler);

    bus.emit({ type: "iteration:start", iteration: 1, currentStep: null, timestamp: "2026-03-11T21:00:00.000Z" });
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("iteration:start");
  });

  it("off() removes a handler so it no longer receives events", () => {
    const received: AgentLoopEvent[] = [];
    const handlers: ((event: AgentLoopEvent) => void)[] = [];

    const bus: IAgentEventBus = {
      emit(event: AgentLoopEvent): void {
        for (const handler of handlers) handler(event);
      },
      on(handler: (event: AgentLoopEvent) => void): void {
        handlers.push(handler);
      },
      off(handler: (event: AgentLoopEvent) => void): void {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      },
    };

    const handler = (e: AgentLoopEvent): void => {
      received.push(e);
    };
    bus.on(handler);

    bus.emit({ type: "step:start", step: "PLAN", iteration: 1, timestamp: "2026-03-11T21:00:00.000Z" });
    expect(received).toHaveLength(1);

    bus.off(handler);
    bus.emit({ type: "step:complete", step: "PLAN", iteration: 1, durationMs: 50 });
    // Handler removed — still only 1 event received
    expect(received).toHaveLength(1);
  });

  it("emit() with no handlers registered does not throw", () => {
    const bus: IAgentEventBus = {
      emit(_event: AgentLoopEvent): void {},
      on(_handler: (event: AgentLoopEvent) => void): void {},
      off(_handler: (event: AgentLoopEvent) => void): void {},
    };

    expect(() => {
      bus.emit({
        type: "terminated",
        condition: "TASK_COMPLETED",
        finalState: makeState(),
        timestamp: "2026-03-11T21:00:00.000Z",
      });
    }).not.toThrow();
  });

  it("multiple handlers can be registered and all receive the same event", () => {
    const received1: AgentLoopEvent[] = [];
    const received2: AgentLoopEvent[] = [];
    const handlers: ((event: AgentLoopEvent) => void)[] = [];

    const bus: IAgentEventBus = {
      emit(event: AgentLoopEvent): void {
        for (const handler of handlers) handler(event);
      },
      on(handler: (event: AgentLoopEvent) => void): void {
        handlers.push(handler);
      },
      off(handler: (event: AgentLoopEvent) => void): void {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      },
    };

    bus.on((e) => received1.push(e));
    bus.on((e) => received2.push(e));

    bus.emit({ type: "recovery:attempt", attempt: 1, maxAttempts: 3, errorMessage: "ENOENT" });

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect(received1[0]?.type).toBe("recovery:attempt");
    expect(received2[0]?.type).toBe("recovery:attempt");
  });
});

// ---------------------------------------------------------------------------
// AgentLoopLogger contract via mock
// ---------------------------------------------------------------------------

describe("AgentLoopLogger contract (mock implementation)", () => {
  it("info() receives a message and optional metadata", () => {
    const infoLogs: { message: string; data?: Readonly<Record<string, unknown>> }[] = [];

    const logger: AgentLoopLogger = {
      info(message, data): void {
        infoLogs.push({ message, data });
      },
      error(_message, _data): void {},
    };

    logger.info("PLAN step started", { iteration: 1, step: "PLAN" });
    expect(infoLogs).toHaveLength(1);
    expect(infoLogs[0]?.message).toBe("PLAN step started");
    expect(infoLogs[0]?.data?.iteration).toBe(1);
  });

  it("error() receives a message and optional metadata", () => {
    const errorLogs: { message: string; data?: Readonly<Record<string, unknown>> }[] = [];

    const logger: AgentLoopLogger = {
      info(_message, _data): void {},
      error(message, data): void {
        errorLogs.push({ message, data });
      },
    };

    logger.error("Tool execution failed", { toolName: "write_file", errorType: "permission" });
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.message).toBe("Tool execution failed");
    expect(errorLogs[0]?.data?.errorType).toBe("permission");
  });

  it("info() and error() can be called without metadata", () => {
    const infoLogs: string[] = [];
    const errorLogs: string[] = [];

    const logger: AgentLoopLogger = {
      info(message): void {
        infoLogs.push(message);
      },
      error(message): void {
        errorLogs.push(message);
      },
    };

    logger.info("Step complete");
    logger.error("Unexpected failure");

    expect(infoLogs).toHaveLength(1);
    expect(errorLogs).toHaveLength(1);
    expect(infoLogs[0]).toBe("Step complete");
    expect(errorLogs[0]).toBe("Unexpected failure");
  });
});
