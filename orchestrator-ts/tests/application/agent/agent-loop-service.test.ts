import { describe, expect, it } from "bun:test";
import { AgentLoopService } from "../../../application/agent/agent-loop-service";
import type {
  AgentLoopLogger,
  AgentLoopOptions,
  IAgentEventBus,
  IAgentLoop,
  IContextProvider,
} from "../../../application/ports/agent-loop";
import type { LlmProviderPort } from "../../../application/ports/llm";
import type { IToolExecutor } from "../../../application/tools/executor";
import type { AgentLoopEvent, AgentState, ReflectionOutput } from "../../../domain/agent/types";
import type { IToolRegistry, ToolListEntry } from "../../../domain/tools/registry";
import type { MemoryEntry, ToolContext } from "../../../domain/tools/types";

// ---------------------------------------------------------------------------
// Test helpers — minimal mocks satisfying each injected interface
// ---------------------------------------------------------------------------

function makeExecutor(): IToolExecutor {
  return {
    async invoke(_name, _input, _ctx) {
      return { ok: true, value: {} };
    },
  };
}

function makeRegistry(): IToolRegistry {
  return {
    register: () => ({ ok: true, value: undefined }),
    get: (name) => ({ ok: false, error: { type: "not_found", name } }),
    list: () => [],
  };
}

function makeLlm(): LlmProviderPort {
  return {
    async complete(_prompt) {
      return { ok: true, value: { content: "{}", usage: { inputTokens: 1, outputTokens: 1 } } };
    },
    clearContext() {},
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

// ---------------------------------------------------------------------------
// Constructor and interface conformance
// ---------------------------------------------------------------------------

describe("AgentLoopService constructor", () => {
  it("constructs successfully with all four required dependencies", () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    expect(service).toBeDefined();
  });

  it("satisfies the IAgentLoop interface — has run, stop, and getState methods", () => {
    const service: IAgentLoop = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    expect(typeof service.run).toBe("function");
    expect(typeof service.stop).toBe("function");
    expect(typeof service.getState).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// stop() and getState() — mutable flag behaviour
// ---------------------------------------------------------------------------

describe("AgentLoopService.stop()", () => {
  it("can be called without error when no run is active", () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    expect(() => service.stop()).not.toThrow();
  });

  it("can be called multiple times without error", () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    service.stop();
    service.stop();
    // Still callable; no throws
    expect(() => service.stop()).not.toThrow();
  });
});

describe("AgentLoopService.getState()", () => {
  it("returns null before any run is started", () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    expect(service.getState()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_OPTIONS — accessible via run() merging behaviour
// ---------------------------------------------------------------------------

describe("AgentLoopService DEFAULT_OPTIONS", () => {
  it("run() accepts an empty options object and uses defaults (does not throw)", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    // Just verify run() doesn't crash when options is fully omitted
    const result = await service.run("test task", {});
    expect(result).toBeDefined();
    expect(result.finalState).toBeDefined();
    expect(result.terminationCondition).toBeDefined();
  });

  it("run() accepts partial options and merges with defaults", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    const result = await service.run("test task", { maxIterations: 1 });
    expect(result).toBeDefined();
    expect(result.totalIterations).toBeLessThanOrEqual(1);
  });

  it("run() with maxIterations: 0 terminates immediately with max-iterations-reached", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    const result = await service.run("test task", { maxIterations: 0 });
    expect(result.terminationCondition).toBe("MAX_ITERATIONS_REACHED");
    expect(result.taskCompleted).toBe(false);
    expect(result.totalIterations).toBe(0);
  });

  it("run() result contains a finalState with the original task string", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    const result = await service.run("my specific task", { maxIterations: 0 });
    expect(result.finalState.task).toBe("my specific task");
  });
});

// ---------------------------------------------------------------------------
// Dependency boundary — no SDK or tool impl imports in module
// ---------------------------------------------------------------------------

describe("AgentLoopService dependency boundary", () => {
  it("executor, registry, llm, and toolContext are injected (not imported directly)", () => {
    // Verify the service works with entirely mock dependencies —
    // if it imported real tool impls or the Anthropic SDK directly, this would
    // fail or require those modules to be available.
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    expect(service).toBeInstanceOf(AgentLoopService);
  });
});

// ---------------------------------------------------------------------------
// Task 3.2 — run() outer skeleton: schema retrieval, loop structure, cleanup
// ---------------------------------------------------------------------------

describe("AgentLoopService.run() outer loop skeleton", () => {
  it("calls registry.list() exactly once per run() invocation", async () => {
    let listCallCount = 0;

    const registry: IToolRegistry = {
      register: () => ({ ok: true, value: undefined }),
      get: (name) => ({ ok: false, error: { type: "not_found", name } }),
      list: () => {
        listCallCount++;
        return [];
      },
    };

    const service = new AgentLoopService(
      makeExecutor(),
      registry,
      makeLlm(),
      makeToolContext(),
    );

    await service.run("test task", { maxIterations: 0 });
    expect(listCallCount).toBe(1);

    // Reset and verify it is called again on a second run
    listCallCount = 0;
    await service.run("test task again", { maxIterations: 0 });
    expect(listCallCount).toBe(1);
  });

  it("getState() returns null after run() completes (cleanup on every exit path)", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    await service.run("test task", { maxIterations: 0 });
    expect(service.getState()).toBeNull();
  });

  it("finalState.startedAt is a valid ISO 8601 timestamp", async () => {
    const before = Date.now();

    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    const result = await service.run("test task", { maxIterations: 0 });

    const parsed = Date.parse(result.finalState.startedAt);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(result.finalState.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("finalState has empty plan, completedSteps, and observations on initialization", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    const result = await service.run("test task", { maxIterations: 0 });

    expect(result.finalState.plan).toHaveLength(0);
    expect(result.finalState.completedSteps).toHaveLength(0);
    expect(result.finalState.observations).toHaveLength(0);
    expect(result.finalState.iterationCount).toBe(0);
    expect(result.finalState.recoveryAttempts).toBe(0);
    expect(result.finalState.currentStep).toBeNull();
  });

  it("run() never throws even when an unexpected error occurs internally", async () => {
    const throwingRegistry: IToolRegistry = {
      register: () => ({ ok: true, value: undefined }),
      get: (name) => ({ ok: false, error: { type: "not_found", name } }),
      list: () => {
        throw new Error("simulated internal failure");
      },
    };

    const service = new AgentLoopService(
      makeExecutor(),
      throwingRegistry,
      makeLlm(),
      makeToolContext(),
    );

    // Must not throw — error should be surfaced as a TerminationCondition
    const result = await service.run("test task", { maxIterations: 1 });
    expect(result.terminationCondition).toBeDefined();
    expect(result.finalState).toBeDefined();
    expect(result.taskCompleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 4.1 — PLAN step: context building, LLM call, parse, validation, retry
// ---------------------------------------------------------------------------

function makeValidPlanJson(): string {
  return JSON.stringify({
    category: "Exploration",
    toolName: "read_file",
    toolInput: { path: "/workspace/src/index.ts" },
    rationale: "Need to read the main file to understand structure",
  });
}

describe("AgentLoopService PLAN step", () => {
  it("valid ActionPlan JSON on first LLM call — returns MAX_ITERATIONS_REACHED (not HUMAN_INTERVENTION_REQUIRED)", async () => {
    const llm: LlmProviderPort = {
      async complete(_prompt) {
        return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.terminationCondition).toBe("MAX_ITERATIONS_REACHED");
  });

  it("invalid JSON twice then valid JSON — retries and succeeds (MAX_ITERATIONS_REACHED)", async () => {
    let callCount = 0;
    const llm: LlmProviderPort = {
      async complete(_prompt) {
        callCount++;
        if (callCount <= 2) {
          return { ok: true, value: { content: "not valid json", usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        if (callCount === 3) {
          // 3rd PLAN attempt succeeds
          return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        // 4th call is the REFLECT step
        return { ok: true, value: { content: makeValidReflectionJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    // maxPlanParseRetries: 2 → 3 PLAN attempts (initial + 2 retries) + 1 REFLECT = 4 total
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run("test task", { maxIterations: 1, maxPlanParseRetries: 2 });

    expect(callCount).toBe(4); // 3 PLAN attempts + 1 REFLECT
    expect(result.terminationCondition).toBe("MAX_ITERATIONS_REACHED");
  });

  it("always invalid JSON beyond retry limit — returns HUMAN_INTERVENTION_REQUIRED", async () => {
    const llm: LlmProviderPort = {
      async complete(_prompt) {
        return { ok: true, value: { content: "not valid json at all", usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run("test task", { maxIterations: 1, maxPlanParseRetries: 2 });

    expect(result.terminationCondition).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(result.taskCompleted).toBe(false);
  });

  it("delegates to contextProvider.buildContext() when provided in options", async () => {
    let contextProviderCalled = false;

    const contextProvider: IContextProvider = {
      async buildContext(_state, _toolSchemas) {
        contextProviderCalled = true;
        return "custom context";
      },
    };

    const llm: LlmProviderPort = {
      async complete(_prompt) {
        return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    await service.run("test task", { maxIterations: 1, contextProvider });

    expect(contextProviderCalled).toBe(true);
  });

  it("uses inline fallback context when no contextProvider — prompt contains task string", async () => {
    let promptReceived = "";

    const llm: LlmProviderPort = {
      async complete(prompt) {
        promptReceived = prompt;
        return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    await service.run("my special task", { maxIterations: 1 });

    expect(promptReceived).toContain("my special task");
  });

  it("ActionPlan with invalid category — returns HUMAN_INTERVENTION_REQUIRED", async () => {
    const badCategoryJson = JSON.stringify({
      category: "InvalidCategory",
      toolName: "read_file",
      toolInput: {},
      rationale: "test",
    });

    const llm: LlmProviderPort = {
      async complete(_prompt) {
        return { ok: true, value: { content: badCategoryJson, usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run("test task", { maxIterations: 1, maxPlanParseRetries: 0 });

    expect(result.terminationCondition).toBe("HUMAN_INTERVENTION_REQUIRED");
  });

  it("ActionPlan with empty toolName — returns HUMAN_INTERVENTION_REQUIRED", async () => {
    const emptyToolNameJson = JSON.stringify({
      category: "Exploration",
      toolName: "",
      toolInput: {},
      rationale: "test",
    });

    const llm: LlmProviderPort = {
      async complete(_prompt) {
        return { ok: true, value: { content: emptyToolNameJson, usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run("test task", { maxIterations: 1, maxPlanParseRetries: 0 });

    expect(result.terminationCondition).toBe("HUMAN_INTERVENTION_REQUIRED");
  });

  it("retry prompt includes error hint after first parse failure", async () => {
    const prompts: string[] = [];

    const llm: LlmProviderPort = {
      async complete(prompt) {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return { ok: true, value: { content: "bad json", usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        if (prompts.length === 2) {
          // PLAN retry succeeds
          return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        // 3rd call is the REFLECT step — return valid reflection
        return { ok: true, value: { content: makeValidReflectionJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    await service.run("test task", { maxIterations: 1, maxPlanParseRetries: 1 });

    // 2 PLAN prompts + 1 REFLECT prompt
    expect(prompts.length).toBe(3);
    // Second PLAN prompt should contain some hint about the previous failure
    expect(prompts[1]).not.toBe(prompts[0]);
  });
});

// ---------------------------------------------------------------------------
// Task 4.2 — ACT step: tool invocation, observation construction, permission bypass
// ---------------------------------------------------------------------------

describe("AgentLoopService ACT step", () => {
  function makeValidLlm(): LlmProviderPort {
    let n = 0;
    return {
      async complete(_prompt) {
        n++;
        // Odd calls = PLAN step, even calls = REFLECT step
        if (n % 2 === 1) {
          return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        return { ok: true, value: { content: makeValidReflectionJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };
  }

  it("successful tool execution — returns MAX_ITERATIONS_REACHED (no error)", async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: true, value: { result: "file contents here" } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.terminationCondition).toBe("MAX_ITERATIONS_REACHED");
    expect(result.taskCompleted).toBe(false);
  });

  it("runtime tool error — does not return HUMAN_INTERVENTION_REQUIRED (non-permission errors do not bypass loop)", async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: false, error: { type: "runtime", message: "command failed" } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.terminationCondition).toBe("MAX_ITERATIONS_REACHED");
  });

  it("validation tool error — does not return HUMAN_INTERVENTION_REQUIRED (non-permission errors do not bypass loop)", async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: false, error: { type: "validation", message: "invalid input" } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.terminationCondition).toBe("MAX_ITERATIONS_REACHED");
  });

  it("permission tool error — returns HUMAN_INTERVENTION_REQUIRED immediately (bypasses recovery)", async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: false, error: { type: "permission", message: "write not permitted" } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.terminationCondition).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(result.taskCompleted).toBe(false);
  });

  it("executor is called with the toolName and toolInput from the ActionPlan", async () => {
    let capturedName = "";
    let capturedInput: unknown = null;

    const executor: IToolExecutor = {
      async invoke(name, input, _ctx) {
        capturedName = name;
        capturedInput = input;
        return { ok: true, value: {} };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    await service.run("test task", { maxIterations: 1 });

    // makeValidPlanJson returns toolName: 'read_file', toolInput: { path: '/workspace/src/index.ts' }
    expect(capturedName).toBe("read_file");
    expect(capturedInput).toEqual({ path: "/workspace/src/index.ts" });
  });
});

// ---------------------------------------------------------------------------
// Task 5.1 — OBSERVE step: observation recording and immutable state update
// ---------------------------------------------------------------------------

describe("AgentLoopService OBSERVE step", () => {
  function makeValidLlm(): LlmProviderPort {
    let n = 0;
    return {
      async complete(_prompt) {
        n++;
        // Odd calls = PLAN step, even calls = REFLECT step
        if (n % 2 === 1) {
          return {
            ok: true,
            value: {
              content: JSON.stringify({
                category: "Exploration",
                toolName: "read_file",
                toolInput: { path: "/workspace/src/index.ts" },
                rationale: "Need to read the main file",
              }),
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        }
        return { ok: true, value: { content: makeValidReflectionJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };
  }

  it("after one iteration, finalState.observations has exactly one entry", async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: true, value: { content: "file contents" } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.finalState.observations).toHaveLength(1);
  });

  it("observation records the toolName from the ActionPlan", async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: true, value: {} };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.finalState.observations[0]!.toolName).toBe("read_file");
  });

  it("successful tool execution — observation has success=true and rawOutput set", async () => {
    const rawOutput = { content: "file contents here", lines: 42 };
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: true, value: rawOutput };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    const obs = result.finalState.observations[0]!;
    expect(obs.success).toBe(true);
    expect(obs.rawOutput).toEqual(rawOutput);
    expect(obs.error).toBeUndefined();
  });

  it("failed tool execution (non-permission) — observation has success=false and error set", async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: false, error: { type: "runtime", message: "command failed" } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    const obs = result.finalState.observations[0]!;
    expect(obs.success).toBe(false);
    expect(obs.error).toBeDefined();
    expect(obs.error!.type).toBe("runtime");
    expect(obs.error!.message).toBe("command failed");
  });

  it("observation records toolInput from the ActionPlan", async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: true, value: {} };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    const obs = result.finalState.observations[0]!;
    expect(obs.toolInput).toEqual({ path: "/workspace/src/index.ts" });
  });

  it("observation has a valid ISO 8601 recordedAt timestamp", async () => {
    const before = Date.now();
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: true, value: {} };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    const obs = result.finalState.observations[0]!;
    const parsed = Date.parse(obs.recordedAt);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(obs.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("state is never mutated — initial state has empty observations, new state has one", async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: true, value: {} };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());

    // Run with maxIterations: 0 to capture empty initial state
    const emptyResult = await service.run("test task", { maxIterations: 0 });
    expect(emptyResult.finalState.observations).toHaveLength(0);

    // Run with maxIterations: 1 to get one observation
    const oneIterResult = await service.run("test task", { maxIterations: 1 });
    expect(oneIterResult.finalState.observations).toHaveLength(1);
  });

  it("zero iterations — finalState.observations remains empty", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeValidLlm(),
      makeToolContext(),
    );

    const result = await service.run("test task", { maxIterations: 0 });
    expect(result.finalState.observations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2 — REFLECT step: reflection prompt, LLM call, parse, embed in observation
// ---------------------------------------------------------------------------

function makeValidReflectionJson(overrides: Partial<ReflectionOutput> = {}): string {
  const base: ReflectionOutput = {
    assessment: "expected",
    learnings: ["The file structure is as expected"],
    planAdjustment: "continue",
    summary: "The action completed successfully as planned",
    ...overrides,
  };
  return JSON.stringify(base);
}

describe("AgentLoopService REFLECT step", () => {
  // LLM: first call returns valid ActionPlan (PLAN step), second call returns valid ReflectionOutput
  function makeTwoPhaseValidLlm(): LlmProviderPort {
    let callCount = 0;
    return {
      async complete(_prompt) {
        callCount++;
        if (callCount === 1) {
          // PLAN step
          return {
            ok: true,
            value: {
              content: JSON.stringify({
                category: "Exploration",
                toolName: "read_file",
                toolInput: { path: "/workspace/src/index.ts" },
                rationale: "Need to read the main file",
              }),
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        }
        // REFLECT step
        return {
          ok: true,
          value: {
            content: makeValidReflectionJson(),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      },
      clearContext() {},
    };
  }

  it("latest observation has a reflection embedded after one full iteration", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeTwoPhaseValidLlm(),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.finalState.observations).toHaveLength(1);
    expect(result.finalState.observations[0]!.reflection).toBeDefined();
  });

  it("reflection has the correct assessment from the LLM response", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeTwoPhaseValidLlm(),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.finalState.observations[0]!.reflection!.assessment).toBe("expected");
  });

  it("reflection has learnings array from the LLM response", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeTwoPhaseValidLlm(),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 1 });

    const ref = result.finalState.observations[0]!.reflection!;
    expect(Array.isArray(ref.learnings)).toBe(true);
    expect(ref.learnings).toContain("The file structure is as expected");
  });

  it("reflection has planAdjustment from the LLM response", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeTwoPhaseValidLlm(),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.finalState.observations[0]!.reflection!.planAdjustment).toBe("continue");
  });

  it("reflection has a summary string from the LLM response", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeTwoPhaseValidLlm(),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 1 });

    expect(typeof result.finalState.observations[0]!.reflection!.summary).toBe("string");
    expect(result.finalState.observations[0]!.reflection!.summary.length).toBeGreaterThan(0);
  });

  it("invalid reflection JSON from LLM — observation still gets a failure assessment reflection (no crash)", async () => {
    let callCount = 0;
    const llm: LlmProviderPort = {
      async complete(_prompt) {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            value: {
              content: JSON.stringify({
                category: "Exploration",
                toolName: "read_file",
                toolInput: { path: "/workspace/src/index.ts" },
                rationale: "test",
              }),
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        }
        // Invalid reflection response
        return {
          ok: true,
          value: { content: "not valid json at all", usage: { inputTokens: 1, outputTokens: 1 } },
        };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    // Should not crash — observation should have a failure reflection
    expect(result.finalState.observations[0]!.reflection).toBeDefined();
    expect(result.finalState.observations[0]!.reflection!.assessment).toBe("failure");
  });

  it("LLM error during REFLECT — observation still gets a failure assessment reflection", async () => {
    let callCount = 0;
    const llm: LlmProviderPort = {
      async complete(_prompt) {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            value: {
              content: JSON.stringify({
                category: "Exploration",
                toolName: "read_file",
                toolInput: {},
                rationale: "test",
              }),
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        }
        return { ok: false, error: { code: "api_error", message: "LLM unavailable" } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.finalState.observations[0]!.reflection).toBeDefined();
    expect(result.finalState.observations[0]!.reflection!.assessment).toBe("failure");
  });

  it("reflection prompt includes the task string and rationale from the plan", async () => {
    const reflectPrompts: string[] = [];
    let callCount = 0;

    const llm: LlmProviderPort = {
      async complete(prompt) {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            value: {
              content: JSON.stringify({
                category: "Exploration",
                toolName: "read_file",
                toolInput: {},
                rationale: "my specific rationale for the plan",
              }),
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        }
        reflectPrompts.push(prompt);
        return {
          ok: true,
          value: { content: makeValidReflectionJson(), usage: { inputTokens: 1, outputTokens: 1 } },
        };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    await service.run("my important task", { maxIterations: 1 });

    expect(reflectPrompts.length).toBeGreaterThan(0);
    expect(reflectPrompts[0]!).toContain("my important task");
    expect(reflectPrompts[0]!).toContain("my specific rationale for the plan");
  });

  it("reflection with taskComplete=true is embedded in observation", async () => {
    let callCount = 0;
    const llm: LlmProviderPort = {
      async complete(_prompt) {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            value: {
              content: JSON.stringify({
                category: "Validation",
                toolName: "run_tests",
                toolInput: {},
                rationale: "Run tests to verify completion",
              }),
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        }
        return {
          ok: true,
          value: {
            content: makeValidReflectionJson({ planAdjustment: "stop", taskComplete: true }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    const ref = result.finalState.observations[0]!.reflection!;
    expect(ref.taskComplete).toBe(true);
    expect(ref.planAdjustment).toBe("stop");
  });

  it("reflection with revisedPlan is embedded when planAdjustment is revise", async () => {
    let callCount = 0;
    const llm: LlmProviderPort = {
      async complete(_prompt) {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            value: {
              content: JSON.stringify({
                category: "Exploration",
                toolName: "read_file",
                toolInput: {},
                rationale: "test",
              }),
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        }
        return {
          ok: true,
          value: {
            content: makeValidReflectionJson({
              assessment: "unexpected",
              planAdjustment: "revise",
              revisedPlan: ["step 1: fix the issue", "step 2: rerun tests"],
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run("test task", { maxIterations: 1 });

    const ref = result.finalState.observations[0]!.reflection!;
    expect(ref.planAdjustment).toBe("revise");
    expect(ref.revisedPlan).toEqual(["step 1: fix the issue", "step 2: rerun tests"]);
  });
});

// ---------------------------------------------------------------------------
// Task 5.3 — UPDATE STATE step: iterationCount increment, step promotion, plan revision
// ---------------------------------------------------------------------------

/** Builds a two-call LLM mock: call 1 returns valid ActionPlan, call 2+ returns valid ReflectionOutput. */
function makeCycledLlm(reflectionOverrides: Partial<ReflectionOutput> = {}): LlmProviderPort {
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
              toolName: "read_file",
              toolInput: { path: "/workspace/src/index.ts" },
              rationale: "Read the file",
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      }
      // Even calls = REFLECT step
      return {
        ok: true,
        value: {
          content: makeValidReflectionJson(reflectionOverrides),
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      };
    },
    clearContext() {},
  };
}

describe("AgentLoopService UPDATE STATE step", () => {
  it("iterationCount is 1 in finalState after one complete cycle (maxIterations: 1)", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm(),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.finalState.iterationCount).toBe(1);
  });

  it("totalIterations in result is 1 after one complete cycle (maxIterations: 1)", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm(),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.totalIterations).toBe(1);
  });

  it("iterationCount is 2 after two complete cycles (maxIterations: 2)", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm(),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 2 });

    expect(result.finalState.iterationCount).toBe(2);
    expect(result.totalIterations).toBe(2);
  });

  it("failure assessment: iterationCount still increments (recovery not yet implemented)", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm({ assessment: "failure", planAdjustment: "continue" }),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 1 });

    // Even on failure, iteration counter must increment
    expect(result.finalState.iterationCount).toBe(1);
  });

  it("non-failure with empty plan: currentStep remains null after UPDATE", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm({ assessment: "expected", planAdjustment: "continue" }),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 1 });

    // Plan was empty initially, so currentStep should still be null
    expect(result.finalState.currentStep).toBeNull();
    expect(result.finalState.completedSteps).toHaveLength(0);
  });

  it("plan revision: plan replaced with revisedPlan and currentStep set to first step", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm({
        assessment: "unexpected",
        planAdjustment: "revise",
        revisedPlan: ["step 1: analyze the error", "step 2: apply the fix", "step 3: rerun tests"],
      }),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 1 });

    expect(result.finalState.plan).toEqual([
      "step 1: analyze the error",
      "step 2: apply the fix",
      "step 3: rerun tests",
    ]);
    expect(result.finalState.currentStep).toBe("step 1: analyze the error");
  });

  it("non-failure with active plan step: step moves to completedSteps and advances", async () => {
    // Two iterations: revision on iteration 1 sets up plan, then expected on iteration 2 advances step
    let callCount = 0;
    const llm: LlmProviderPort = {
      async complete(_prompt) {
        callCount++;
        if (callCount % 2 === 1) {
          return {
            ok: true,
            value: {
              content: JSON.stringify({
                category: "Exploration",
                toolName: "read_file",
                toolInput: {},
                rationale: "test",
              }),
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        }
        if (callCount === 2) {
          // First REFLECT: revise plan to set currentStep
          return {
            ok: true,
            value: {
              content: makeValidReflectionJson({
                assessment: "expected",
                planAdjustment: "revise",
                revisedPlan: ["step A", "step B"],
              }),
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        }
        // Second REFLECT: expected/continue — advances currentStep from 'step A' to 'step B'
        return {
          ok: true,
          value: {
            content: makeValidReflectionJson({
              assessment: "expected",
              planAdjustment: "continue",
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run("test task", { maxIterations: 2 });

    // After 2 iterations:
    // Iteration 1: plan revised to ['step A', 'step B'], currentStep = 'step A'
    // Iteration 2: 'step A' moved to completedSteps, currentStep = 'step B'
    expect(result.finalState.completedSteps).toContain("step A");
    expect(result.finalState.currentStep).toBe("step B");
    expect(result.finalState.iterationCount).toBe(2);
  });

  it("two observations accumulated after two complete cycles", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm(),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 2 });

    expect(result.finalState.observations).toHaveLength(2);
  });

  it("both observations have reflections embedded after two cycles", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm(),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 2 });

    expect(result.finalState.observations[0]!.reflection).toBeDefined();
    expect(result.finalState.observations[1]!.reflection).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Task 6.1 — stop-flag check, maxIterations enforcement, and termination conditions
// ---------------------------------------------------------------------------

describe("AgentLoopService task 6.1 — stopping conditions", () => {
  it("reflection with taskComplete=true and planAdjustment=stop terminates with TASK_COMPLETED", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm({ planAdjustment: "stop", taskComplete: true }),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 5 });

    expect(result.terminationCondition).toBe("TASK_COMPLETED");
  });

  it("reflection with taskComplete=true results in taskCompleted=true", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm({ planAdjustment: "stop", taskComplete: true }),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 5 });

    expect(result.taskCompleted).toBe(true);
  });

  it("reflection with requiresHumanIntervention=true terminates with HUMAN_INTERVENTION_REQUIRED", async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm({ requiresHumanIntervention: true }),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 5 });

    expect(result.terminationCondition).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(result.taskCompleted).toBe(false);
  });

  it("stop() called during ACT step terminates with SAFETY_STOP", async () => {
    let service!: AgentLoopService;

    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        service.stop();
        return { ok: true, value: {} };
      },
    };

    service = new AgentLoopService(
      executor,
      makeRegistry(),
      makeCycledLlm(),
      makeToolContext(),
    );
    const result = await service.run("test task", { maxIterations: 5 });

    expect(result.terminationCondition).toBe("SAFETY_STOP");
    expect(result.taskCompleted).toBe(false);
  });

  it("max iterations reached logs a progress summary via the injected logger", async () => {
    const loggedMessages: string[] = [];

    const logger = {
      info(message: string, _data?: Readonly<Record<string, unknown>>) {
        loggedMessages.push(message);
      },
      error(_message: string, _data?: Readonly<Record<string, unknown>>) {},
    };

    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm(),
      makeToolContext(),
    );
    await service.run("test task", { maxIterations: 2, logger });

    expect(loggedMessages.length).toBeGreaterThan(0);
  });

  it("max iterations progress summary includes iteration count, completed steps, and tools invoked", async () => {
    const loggedData: Array<Readonly<Record<string, unknown>>> = [];

    const logger = {
      info(_message: string, data?: Readonly<Record<string, unknown>>) {
        if (data) loggedData.push(data);
      },
      error(_message: string, _data?: Readonly<Record<string, unknown>>) {},
    };

    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm(),
      makeToolContext(),
    );
    await service.run("test task", { maxIterations: 2, logger });

    const merged = Object.assign({}, ...loggedData);
    expect(typeof merged["iterationCount"] === "number" || typeof merged["totalIterations"] === "number").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 6.2 — termination event emission and result assembly
// ---------------------------------------------------------------------------

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

function makeSummaryLogger(): {
  logger: AgentLoopLogger;
  infos: Array<{ msg: string; data: Readonly<Record<string, unknown>> | undefined }>;
} {
  const infos: Array<{ msg: string; data: Readonly<Record<string, unknown>> | undefined }> = [];
  const logger: AgentLoopLogger = {
    info(msg, data) {
      infos.push({ msg, data });
    },
    error(_msg, _data) {},
  };
  return { logger, infos };
}

describe("AgentLoopService task 6.2 — termination event emission", () => {
  it("emits a terminated event when loop exits via MAX_ITERATIONS_REACHED", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, eventBus: bus });

    const termEvents = events.filter((e) => e.type === "terminated");
    expect(termEvents.length).toBe(1);
    expect((termEvents[0] as Extract<AgentLoopEvent, { type: "terminated" }>).condition).toBe("MAX_ITERATIONS_REACHED");
  });

  it("terminated event carries the final agent state", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1, eventBus: bus });

    const termEvent = events.find((e) => e.type === "terminated") as
      | Extract<AgentLoopEvent, { type: "terminated" }>
      | undefined;
    expect(termEvent).toBeDefined();
    expect(termEvent!.finalState).toEqual(result.finalState);
  });

  it("emits terminated event with TASK_COMPLETED condition when task finishes", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm({ planAdjustment: "stop", taskComplete: true }),
      makeToolContext(),
    );
    await service.run("test", { maxIterations: 5, eventBus: bus });

    const termEvent = events.find((e) => e.type === "terminated") as
      | Extract<AgentLoopEvent, { type: "terminated" }>
      | undefined;
    expect(termEvent?.condition).toBe("TASK_COMPLETED");
  });

  it("emits terminated event with HUMAN_INTERVENTION_REQUIRED when reflection requests it", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm({ requiresHumanIntervention: true }),
      makeToolContext(),
    );
    await service.run("test", { maxIterations: 5, eventBus: bus });

    const termEvent = events.find((e) => e.type === "terminated") as
      | Extract<AgentLoopEvent, { type: "terminated" }>
      | undefined;
    expect(termEvent?.condition).toBe("HUMAN_INTERVENTION_REQUIRED");
  });

  it("emits terminated event with SAFETY_STOP when stop() is called during execution", async () => {
    let svc!: AgentLoopService;
    const executor: IToolExecutor = {
      async invoke(_n, _i, _c) {
        svc.stop();
        return { ok: true, value: {} };
      },
    };
    const { bus, events } = makeEventBus();
    svc = new AgentLoopService(executor, makeRegistry(), makeCycledLlm(), makeToolContext());
    await svc.run("test", { maxIterations: 5, eventBus: bus });

    const termEvent = events.find((e) => e.type === "terminated") as
      | Extract<AgentLoopEvent, { type: "terminated" }>
      | undefined;
    expect(termEvent?.condition).toBe("SAFETY_STOP");
  });

  it("terminated event carries an ISO 8601 timestamp", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 0, eventBus: bus });

    const termEvent = events.find((e) => e.type === "terminated") as
      | Extract<AgentLoopEvent, { type: "terminated" }>
      | undefined;
    expect(termEvent?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("emits terminated event even when an unexpected internal error occurs (catch path)", async () => {
    const throwingRegistry: IToolRegistry = {
      register: () => ({ ok: true, value: undefined }),
      get: (name) => ({ ok: false, error: { type: "not_found", name } }),
      list: () => {
        throw new Error("internal boom");
      },
    };
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), throwingRegistry, makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, eventBus: bus });

    const termEvent = events.find((e) => e.type === "terminated");
    expect(termEvent).toBeDefined();
  });

  it("no event bus — run() still completes without error", async () => {
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    const result = await service.run("test", { maxIterations: 1 });
    expect(result.terminationCondition).toBeDefined();
  });
});

describe("AgentLoopService task 6.2 — onSafetyStop callback", () => {
  it("onSafetyStop is called when termination is SAFETY_STOP", async () => {
    let safetyStopNotified = false;
    let svc!: AgentLoopService;
    const executor: IToolExecutor = {
      async invoke(_n, _i, _c) {
        svc.stop();
        return { ok: true, value: {} };
      },
    };
    svc = new AgentLoopService(executor, makeRegistry(), makeCycledLlm(), makeToolContext());
    await svc.run("test", {
      maxIterations: 5,
      onSafetyStop: () => {
        safetyStopNotified = true;
      },
    });

    expect(safetyStopNotified).toBe(true);
  });

  it("onSafetyStop is NOT called when termination is MAX_ITERATIONS_REACHED", async () => {
    let safetyStopNotified = false;
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", {
      maxIterations: 1,
      onSafetyStop: () => {
        safetyStopNotified = true;
      },
    });

    expect(safetyStopNotified).toBe(false);
  });

  it("onSafetyStop is NOT called when termination is TASK_COMPLETED", async () => {
    let safetyStopNotified = false;
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm({ planAdjustment: "stop", taskComplete: true }),
      makeToolContext(),
    );
    await service.run("test", {
      maxIterations: 5,
      onSafetyStop: () => {
        safetyStopNotified = true;
      },
    });

    expect(safetyStopNotified).toBe(false);
  });
});

describe("AgentLoopService task 6.2 — final summary log on termination", () => {
  it("logs a final summary info entry on MAX_ITERATIONS_REACHED with terminal condition", async () => {
    const { logger, infos } = makeSummaryLogger();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 2, logger });

    // Must have at least one info log containing terminal condition info
    const hasCondition = infos.some((l) =>
      (l.data && "terminationCondition" in l.data)
      || l.msg.toLowerCase().includes("max")
      || l.msg.toLowerCase().includes("terminat")
    );
    expect(hasCondition).toBe(true);
  });

  it("logs total iterations in the final summary", async () => {
    const { logger, infos } = makeSummaryLogger();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 2, logger });

    const allData = Object.assign({}, ...infos.map((l) => l.data ?? {}));
    expect(typeof allData["iterationCount"] === "number" || typeof allData["totalIterations"] === "number").toBe(true);
  });

  it("logs a final summary on TASK_COMPLETED path", async () => {
    const { logger, infos } = makeSummaryLogger();
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm({ planAdjustment: "stop", taskComplete: true }),
      makeToolContext(),
    );
    await service.run("test", { maxIterations: 5, logger });

    expect(infos.length).toBeGreaterThan(0);
  });

  it("logs a final summary on HUMAN_INTERVENTION_REQUIRED path", async () => {
    const { logger, infos } = makeSummaryLogger();
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeCycledLlm({ requiresHumanIntervention: true }),
      makeToolContext(),
    );
    await service.run("test", { maxIterations: 5, logger });

    expect(infos.length).toBeGreaterThan(0);
  });

  it("logs a final summary on SAFETY_STOP path", async () => {
    let svc!: AgentLoopService;
    const executor: IToolExecutor = {
      async invoke(_n, _i, _c) {
        svc.stop();
        return { ok: true, value: {} };
      },
    };
    const { logger, infos } = makeSummaryLogger();
    svc = new AgentLoopService(executor, makeRegistry(), makeCycledLlm(), makeToolContext());
    await svc.run("test", { maxIterations: 5, logger });

    expect(infos.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Task 7.1 — error recovery sub-loop: cycle orchestration
// ---------------------------------------------------------------------------

/**
 * LLM mock for recovery tests.
 * Call 1: valid ActionPlan (PLAN step)
 * Call 2: failure ReflectionOutput (REFLECT step)
 * Calls 3+: valid ActionPlan (recovery error-analysis fix plans)
 */
function makeRecoveryLlm(): LlmProviderPort {
  let callCount = 0;
  return {
    async complete(_prompt) {
      callCount++;
      if (callCount === 1) {
        // PLAN step — valid ActionPlan
        return {
          ok: true,
          value: {
            content: JSON.stringify({
              category: "Validation",
              toolName: "run_tests",
              toolInput: { suite: "unit" },
              rationale: "Run tests to check if implementation is correct",
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      }
      if (callCount === 2) {
        // REFLECT step — failure assessment
        return {
          ok: true,
          value: {
            content: makeValidReflectionJson({
              assessment: "failure",
              planAdjustment: "stop",
              summary: "Tests failed",
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      }
      // Recovery fix plan calls (3+): valid ActionPlan
      return {
        ok: true,
        value: {
          content: JSON.stringify({
            category: "Modification",
            toolName: "write_file",
            toolInput: { path: "/workspace/src/fix.ts", content: "fix" },
            rationale: "Apply fix to resolve the test failure",
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      };
    },
    clearContext() {},
  };
}

describe("AgentLoopService task 7.1 — error recovery sub-loop", () => {
  it("failure assessment triggers recovery — emits recovery:attempt event", async () => {
    const { bus, events } = makeEventBus();

    // Executor: first call (main ACT) returns ok; subsequent calls (fix + validation) also ok
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeRecoveryLlm(), makeToolContext());
    await service.run("test task", { maxIterations: 1, eventBus: bus, maxRecoveryAttempts: 3 });

    const recoveryEvents = events.filter((e) => e.type === "recovery:attempt");
    expect(recoveryEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("recovery:attempt event carries attempt number, maxAttempts, and errorMessage", async () => {
    const { bus, events } = makeEventBus();

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeRecoveryLlm(), makeToolContext());
    await service.run("test task", { maxIterations: 1, eventBus: bus, maxRecoveryAttempts: 3 });

    const recoveryEvent = events.find((e) => e.type === "recovery:attempt") as
      | Extract<AgentLoopEvent, { type: "recovery:attempt" }>
      | undefined;

    expect(recoveryEvent).toBeDefined();
    expect(typeof recoveryEvent!.attempt).toBe("number");
    expect(recoveryEvent!.attempt).toBeGreaterThanOrEqual(1);
    expect(typeof recoveryEvent!.maxAttempts).toBe("number");
    expect(recoveryEvent!.maxAttempts).toBeGreaterThan(0);
    expect(typeof recoveryEvent!.errorMessage).toBe("string");
  });

  it("executor is called for the fix action during recovery", async () => {
    const invocations: string[] = [];

    const executor: IToolExecutor = {
      async invoke(name, _input, _ctx) {
        invocations.push(name);
        return { ok: true, value: {} };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeRecoveryLlm(), makeToolContext());
    await service.run("test task", { maxIterations: 1, maxRecoveryAttempts: 3 });

    // The fix tool ('write_file') should have been called during recovery
    expect(invocations).toContain("write_file");
  });

  it("original failing tool is re-invoked as validation during recovery", async () => {
    const invocations: string[] = [];

    const executor: IToolExecutor = {
      async invoke(name, _input, _ctx) {
        invocations.push(name);
        return { ok: true, value: {} };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeRecoveryLlm(), makeToolContext());
    await service.run("test task", { maxIterations: 1, maxRecoveryAttempts: 3 });

    // 'run_tests' is the original failing tool — should be re-invoked during validation
    // It appears as the ACT step AND the validation step
    const runTestsCount = invocations.filter((n) => n === "run_tests").length;
    expect(runTestsCount).toBeGreaterThanOrEqual(2);
  });

  it("recovery success — loop resumes and reaches MAX_ITERATIONS_REACHED", async () => {
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeRecoveryLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1, maxRecoveryAttempts: 3 });

    // After successful recovery, the loop continues and terminates normally
    expect(result.terminationCondition).toBe("MAX_ITERATIONS_REACHED");
    expect(result.taskCompleted).toBe(false);
  });

  it("recovery success — recoveryAttempts is reset to 0 in final state", async () => {
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeRecoveryLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1, maxRecoveryAttempts: 3 });

    expect(result.finalState.recoveryAttempts).toBe(0);
  });

  it("validation always fails — terminates with RECOVERY_EXHAUSTED after maxRecoveryAttempts", async () => {
    let execCount = 0;

    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        execCount++;
        // Main ACT step (call 1): succeed so REFLECT is triggered
        // Fix calls: succeed (so we can proceed to validation)
        // Validation calls: always fail
        // Pattern: main=ok, fix=ok, validate=fail, fix=ok, validate=fail, ...
        // Call 1: main ACT → ok
        if (execCount === 1) return { ok: true, value: {} };
        // Even calls after first are validations (fix is odd, validate is even in recovery)
        // Actually: recovery call sequence is: fix (exec), validate (exec)
        // Call 2: fix → ok; Call 3: validate → fail
        // Call 4: fix → ok; Call 5: validate → fail
        if (execCount % 2 === 0) {
          // fix calls (2, 4, 6, ...): ok
          return { ok: true, value: {} };
        }
        // validate calls (3, 5, 7, ...): fail
        return { ok: false, error: { type: "runtime", message: "tests still failing" } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeRecoveryLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 5, maxRecoveryAttempts: 3 });

    expect(result.terminationCondition).toBe("RECOVERY_EXHAUSTED");
    expect(result.taskCompleted).toBe(false);
  });

  it("RECOVERY_EXHAUSTED emits a terminated event with that condition", async () => {
    let execCount = 0;
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        execCount++;
        if (execCount === 1) return { ok: true, value: {} };
        if (execCount % 2 === 0) return { ok: true, value: {} };
        return { ok: false, error: { type: "runtime", message: "always fails" } };
      },
    };
    const { bus, events } = makeEventBus();

    const service = new AgentLoopService(executor, makeRegistry(), makeRecoveryLlm(), makeToolContext());
    await service.run("test task", { maxIterations: 5, maxRecoveryAttempts: 3, eventBus: bus });

    const termEvent = events.find((e) => e.type === "terminated") as
      | Extract<AgentLoopEvent, { type: "terminated" }>
      | undefined;
    expect(termEvent?.condition).toBe("RECOVERY_EXHAUSTED");
  });

  it("no event bus — recovery works without error (silent drop)", async () => {
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeRecoveryLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1, maxRecoveryAttempts: 3 });

    // No throws — recovery emits nothing but runs to completion
    expect(result).toBeDefined();
    expect(result.terminationCondition).toBeDefined();
  });

  it("maxRecoveryAttempts: 0 — enters recovery but exhausts immediately without attempting", async () => {
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeRecoveryLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 5, maxRecoveryAttempts: 0 });

    expect(result.terminationCondition).toBe("RECOVERY_EXHAUSTED");
  });

  it("recovery emits exactly maxRecoveryAttempts recovery:attempt events before exhaustion", async () => {
    let execCount = 0;
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        execCount++;
        if (execCount === 1) return { ok: true, value: {} };
        if (execCount % 2 === 0) return { ok: true, value: {} };
        return { ok: false, error: { type: "runtime", message: "always fails" } };
      },
    };
    const { bus, events } = makeEventBus();

    const service = new AgentLoopService(executor, makeRegistry(), makeRecoveryLlm(), makeToolContext());
    await service.run("test task", { maxIterations: 5, maxRecoveryAttempts: 2, eventBus: bus });

    const recoveryEvents = events.filter((e) => e.type === "recovery:attempt");
    expect(recoveryEvents.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Task 7.2 — attempt tracking, repeated failure detection, failure context
// ---------------------------------------------------------------------------

/**
 * LLM mock for multi-iteration recovery tests.
 * Supports two full PLAN→REFLECT cycles plus recovery fix plans between them.
 *
 * Call pattern:
 *   1: PLAN iter 1 → ActionPlan (toolName='read_file')
 *   2: REFLECT iter 1 → failure assessment
 *   3: Recovery fix plan → ActionPlan (toolName='write_file')
 *   4: PLAN iter 2 → ActionPlan (toolName='read_file')
 *   5: REFLECT iter 2 → failure assessment
 *   6+: Recovery fix plan → ActionPlan (toolName='write_file')
 */
function makeMultiIterRecoveryLlm(): LlmProviderPort {
  let n = 0;
  return {
    async complete(_prompt) {
      n++;
      // Calls 1 and 4: PLAN steps — ActionPlan with read_file (same as makeValidPlanJson)
      if (n === 1 || n === 4) {
        return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      }
      // Calls 2 and 5: REFLECT steps — failure assessment
      if (n === 2 || n === 5) {
        return {
          ok: true,
          value: {
            content: makeValidReflectionJson({ assessment: "failure", planAdjustment: "stop", summary: "failed" }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      }
      // Call 3 and beyond: recovery fix plans
      return {
        ok: true,
        value: {
          content: JSON.stringify({
            category: "Modification",
            toolName: "write_file",
            toolInput: { path: "/workspace/fix.ts", content: "fix" },
            rationale: "Apply fix",
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      };
    },
    clearContext() {},
  };
}

describe("AgentLoopService task 7.2 — repeated failure detection", () => {
  it("same tool+error seen in history >= maxRecoveryAttempts times — escalates without recovery:attempt event", async () => {
    // Iter 1: read_file fails → recovery (1 attempt) → validation ok → resume
    // Iter 2: read_file fails with same error → previousSameErrorCount=1 >= maxRecoveryAttempts(1) → escalate
    let execCount = 0;
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        execCount++;
        // Call 1 (iter 1 ACT): fail
        if (execCount === 1) return { ok: false, error: { type: "runtime", message: "tests failed" } };
        // Calls 2 (recovery fix), 3 (recovery validation): ok → recovery succeeds for iter 1
        if (execCount <= 3) return { ok: true, value: {} };
        // Call 4 (iter 2 ACT): fail with same error
        if (execCount === 4) return { ok: false, error: { type: "runtime", message: "tests failed" } };
        return { ok: true, value: {} };
      },
    };

    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(executor, makeRegistry(), makeMultiIterRecoveryLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 5, maxRecoveryAttempts: 1, eventBus: bus });

    expect(result.terminationCondition).toBe("RECOVERY_EXHAUSTED");
    // Only 1 recovery:attempt event from iter 1; iter 2 escalates immediately without recovery:attempt
    const recoveryEvents = events.filter((e) => e.type === "recovery:attempt");
    expect(recoveryEvents.length).toBe(1);
  });

  it("first occurrence of error — does NOT escalate (recovery:attempt IS emitted)", async () => {
    // With maxRecoveryAttempts: 2 and first occurrence (previousCount=0 < 2), recovery runs normally
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeRecoveryLlm(), makeToolContext());
    await service.run("test task", { maxIterations: 1, maxRecoveryAttempts: 2, eventBus: bus });

    const recoveryEvents = events.filter((e) => e.type === "recovery:attempt");
    expect(recoveryEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("pattern detection only applies when failingObs has an error (success=false)", async () => {
    // If the observation succeeds but REFLECT says failure (no error.message), no pattern detection
    // Two iterations with same REFLECT failure but executor always succeeds
    let execCount = 0;
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        execCount++;
        return { ok: true, value: {} }; // always succeed — no tool error
      },
    };

    // LLM: both PLAN and REFLECT calls alternate for 2 iterations
    let n = 0;
    const llm: LlmProviderPort = {
      async complete(_prompt) {
        n++;
        if (n % 2 === 1) {
          return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        return {
          ok: true,
          value: {
            content: makeValidReflectionJson({ assessment: "failure", planAdjustment: "stop" }),
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      },
      clearContext() {},
    };

    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(executor, makeRegistry(), llm, makeToolContext());
    // With maxRecoveryAttempts: 1, if pattern detection fires on iter 2 even without a tool error,
    // it would give RECOVERY_EXHAUSTED. But since failingObs.success=true (no error), no pattern detection.
    // Recovery still runs normally, and since executor succeeds, validation also succeeds.
    const result = await service.run("test task", { maxIterations: 2, maxRecoveryAttempts: 1, eventBus: bus });

    // Recovery should run for both iterations (no early escalation for no-error failure assessments)
    const recoveryEvents = events.filter((e) => e.type === "recovery:attempt");
    expect(recoveryEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("iter 1 fails → recovery succeeds; iter 2 tool succeeds → no escalation", async () => {
    // Iter 1: read_file ACT fails → recovery runs (1 attempt) → validation ok → resumes
    // Iter 2: read_file ACT succeeds (executor returns ok) but REFLECT says failure.
    //   Since failingObs has no tool error (success=true), pattern detection is skipped.
    //   Recovery runs and validation passes immediately.
    let execCount = 0;
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        execCount++;
        if (execCount === 1) return { ok: false, error: { type: "runtime", message: "tests failed" } };
        if (execCount <= 3) return { ok: true, value: {} }; // recovery for iter 1
        // Iter 2: executor always succeeds (no tool error)
        return { ok: true, value: {} };
      },
    };

    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(executor, makeRegistry(), makeMultiIterRecoveryLlm(), makeToolContext());
    await service.run("test task", { maxIterations: 5, maxRecoveryAttempts: 1, eventBus: bus });

    // Iter 1 should have had a recovery:attempt
    const recoveryEvents = events.filter((e) => e.type === "recovery:attempt");
    expect(recoveryEvents.length).toBeGreaterThanOrEqual(1);
  });
});

describe("AgentLoopService task 7.2 — failure context in state on exhaustion", () => {
  it("RECOVERY_EXHAUSTED result has recoveryAttempts > 0 in finalState", async () => {
    // Executor always fails → recovery runs maxRecoveryAttempts times, all fail → exhausted
    // The final state should have recoveryAttempts reflecting the exhausted count
    const executor: IToolExecutor = {
      async invoke(_n, _i, _c) {
        return { ok: false, error: { type: "runtime", message: "always fails" } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeRecoveryLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 5, maxRecoveryAttempts: 2 });

    expect(result.terminationCondition).toBe("RECOVERY_EXHAUSTED");
    expect(result.finalState.recoveryAttempts).toBeGreaterThan(0);
  });

  it("RECOVERY_EXHAUSTED final state recoveryAttempts equals maxRecoveryAttempts", async () => {
    const executor: IToolExecutor = {
      async invoke(_n, _i, _c) {
        return { ok: false, error: { type: "runtime", message: "always fails" } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeRecoveryLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 5, maxRecoveryAttempts: 2 });

    expect(result.finalState.recoveryAttempts).toBe(2);
  });

  it("terminated event on RECOVERY_EXHAUSTED carries finalState with recoveryAttempts > 0", async () => {
    let execCount = 0;
    const executor: IToolExecutor = {
      async invoke(_n, _i, _c) {
        execCount++;
        if (execCount === 1) return { ok: true, value: {} };
        if (execCount % 2 === 0) return { ok: true, value: {} };
        return { ok: false, error: { type: "runtime", message: "always fails" } };
      },
    };
    const { bus, events } = makeEventBus();

    const service = new AgentLoopService(executor, makeRegistry(), makeRecoveryLlm(), makeToolContext());
    await service.run("test task", { maxIterations: 5, maxRecoveryAttempts: 2, eventBus: bus });

    const termEvent = events.find((e) => e.type === "terminated") as
      | Extract<AgentLoopEvent, { type: "terminated" }>
      | undefined;
    expect(termEvent?.condition).toBe("RECOVERY_EXHAUSTED");
    expect(termEvent?.finalState.recoveryAttempts).toBeGreaterThan(0);
  });
});

describe("AgentLoopService task 7.2 — counter reset on distinct new error", () => {
  it("recoveryAttempts is 0 in state after successful recovery (ready for new errors)", async () => {
    // After recovery succeeds, recoveryAttempts should be 0 so distinct new errors start fresh
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeRecoveryLlm(), makeToolContext());
    const result = await service.run("test task", { maxIterations: 1, maxRecoveryAttempts: 3 });

    // Recovery succeeded → recoveryAttempts reset to 0
    expect(result.finalState.recoveryAttempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 8.1 — event bus integration: per-step and per-iteration events
// ---------------------------------------------------------------------------

describe("AgentLoopService task 8.1 — iteration:start event", () => {
  it("emits one iteration:start event per iteration", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 2, eventBus: bus });

    const startEvents = events.filter((e) => e.type === "iteration:start");
    expect(startEvents.length).toBe(2);
  });

  it("iteration:start event carries iteration number, currentStep, and ISO timestamp", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, eventBus: bus });

    const startEvent = events.find((e) => e.type === "iteration:start") as
      | Extract<AgentLoopEvent, { type: "iteration:start" }>
      | undefined;

    expect(startEvent).toBeDefined();
    expect(typeof startEvent!.iteration).toBe("number");
    expect(startEvent!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect("currentStep" in startEvent!).toBe(true);
  });

  it("iteration:start events have consecutive iteration numbers starting at 0", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 2, eventBus: bus });

    const startEvents = events.filter((e) => e.type === "iteration:start") as Array<
      Extract<AgentLoopEvent, { type: "iteration:start" }>
    >;

    expect(startEvents[0]!.iteration).toBe(0);
    expect(startEvents[1]!.iteration).toBe(1);
  });
});

describe("AgentLoopService task 8.1 — step:start and step:complete events", () => {
  it("emits step:start and step:complete for each of the 5 sub-steps per iteration", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, eventBus: bus });

    const stepStarts = events.filter((e) => e.type === "step:start") as Array<
      Extract<AgentLoopEvent, { type: "step:start" }>
    >;
    const stepCompletes = events.filter((e) => e.type === "step:complete") as Array<
      Extract<AgentLoopEvent, { type: "step:complete" }>
    >;

    expect(stepStarts.length).toBe(5);
    expect(stepCompletes.length).toBe(5);
  });

  it("step:start events cover all 5 steps: PLAN, ACT, OBSERVE, REFLECT, UPDATE_STATE", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, eventBus: bus });

    const stepStarts = events.filter((e) => e.type === "step:start") as Array<
      Extract<AgentLoopEvent, { type: "step:start" }>
    >;
    const stepNames = stepStarts.map((e) => e.step);

    expect(stepNames).toContain("PLAN");
    expect(stepNames).toContain("ACT");
    expect(stepNames).toContain("OBSERVE");
    expect(stepNames).toContain("REFLECT");
    expect(stepNames).toContain("UPDATE_STATE");
  });

  it("step events appear in PLAN→ACT→OBSERVE→REFLECT→UPDATE_STATE order", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, eventBus: bus });

    const stepStartEvents = events.filter((e) => e.type === "step:start") as Array<
      Extract<AgentLoopEvent, { type: "step:start" }>
    >;
    const stepNames = stepStartEvents.map((e) => e.step);
    expect(stepNames).toEqual(["PLAN", "ACT", "OBSERVE", "REFLECT", "UPDATE_STATE"]);
  });

  it("step:start event carries step name, iteration number, and ISO timestamp", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, eventBus: bus });

    const planStart = events.find((e) => e.type === "step:start") as
      | Extract<AgentLoopEvent, { type: "step:start" }>
      | undefined;

    expect(planStart).toBeDefined();
    expect(planStart!.step).toBe("PLAN");
    expect(typeof planStart!.iteration).toBe("number");
    expect(planStart!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("step:complete event carries step name, iteration number, and non-negative durationMs", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, eventBus: bus });

    const planComplete = events.find((e) => e.type === "step:complete") as
      | Extract<AgentLoopEvent, { type: "step:complete" }>
      | undefined;

    expect(planComplete).toBeDefined();
    expect(planComplete!.step).toBe("PLAN");
    expect(typeof planComplete!.iteration).toBe("number");
    expect(typeof planComplete!.durationMs).toBe("number");
    expect(planComplete!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("step:complete events cover all 5 steps: PLAN, ACT, OBSERVE, REFLECT, UPDATE_STATE", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, eventBus: bus });

    const stepCompletes = events.filter((e) => e.type === "step:complete") as Array<
      Extract<AgentLoopEvent, { type: "step:complete" }>
    >;
    const stepNames = stepCompletes.map((e) => e.step);

    expect(stepNames).toContain("PLAN");
    expect(stepNames).toContain("ACT");
    expect(stepNames).toContain("OBSERVE");
    expect(stepNames).toContain("REFLECT");
    expect(stepNames).toContain("UPDATE_STATE");
  });

  it("step events carry correct iteration number for second iteration", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 2, eventBus: bus });

    const stepStarts = events.filter((e) => e.type === "step:start") as Array<
      Extract<AgentLoopEvent, { type: "step:start" }>
    >;

    // First 5 step:start events are for iteration 0, next 5 for iteration 1
    const iter0Steps = stepStarts.filter((e) => e.iteration === 0);
    const iter1Steps = stepStarts.filter((e) => e.iteration === 1);
    expect(iter0Steps.length).toBe(5);
    expect(iter1Steps.length).toBe(5);
  });
});

describe("AgentLoopService task 8.1 — iteration:complete event", () => {
  it("emits one iteration:complete event per iteration", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 2, eventBus: bus });

    const completeEvents = events.filter((e) => e.type === "iteration:complete");
    expect(completeEvents.length).toBe(2);
  });

  it("iteration:complete event carries category, toolName, non-negative durationMs, and assessment", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, eventBus: bus });

    const completeEvent = events.find((e) => e.type === "iteration:complete") as
      | Extract<AgentLoopEvent, { type: "iteration:complete" }>
      | undefined;

    expect(completeEvent).toBeDefined();
    expect(typeof completeEvent!.iteration).toBe("number");
    expect(typeof completeEvent!.category).toBe("string");
    expect(typeof completeEvent!.toolName).toBe("string");
    expect(typeof completeEvent!.durationMs).toBe("number");
    expect(completeEvent!.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof completeEvent!.assessment).toBe("string");
  });

  it("iteration:complete carries the correct toolName from the action plan", async () => {
    const { bus, events } = makeEventBus();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, eventBus: bus });

    // makeCycledLlm returns toolName: 'read_file' in the plan
    const completeEvent = events.find((e) => e.type === "iteration:complete") as
      | Extract<AgentLoopEvent, { type: "iteration:complete" }>
      | undefined;

    expect(completeEvent!.toolName).toBe("read_file");
    expect(completeEvent!.category).toBe("Exploration");
  });

  it("no event bus — run() completes normally without errors (per-step events skipped silently)", async () => {
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    const result = await service.run("test", { maxIterations: 1 });
    expect(result.terminationCondition).toBe("MAX_ITERATIONS_REACHED");
  });
});

// ---------------------------------------------------------------------------
// Task 8.2 — structured logging at sub-step boundaries
// ---------------------------------------------------------------------------

describe("AgentLoopService task 8.2 — per-step info logging", () => {
  it("logs an info entry for each of the 5 sub-steps per iteration", async () => {
    const { logger, infos } = makeSummaryLogger();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, logger });

    const stepLogs = infos.filter((l) => l.data && typeof l.data["step"] === "string");
    const stepNames = stepLogs.map((l) => l.data!["step"] as string);

    expect(stepNames).toContain("PLAN");
    expect(stepNames).toContain("ACT");
    expect(stepNames).toContain("OBSERVE");
    expect(stepNames).toContain("REFLECT");
    expect(stepNames).toContain("UPDATE_STATE");
  });

  it("per-step log entries include iteration number", async () => {
    const { logger, infos } = makeSummaryLogger();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, logger });

    const stepLogs = infos.filter((l) => l.data && typeof l.data["step"] === "string");
    expect(stepLogs.length).toBeGreaterThanOrEqual(5);
    for (const log of stepLogs) {
      expect(typeof log.data!["iteration"]).toBe("number");
    }
  });

  it("per-step log entries include durationMs as a non-negative number", async () => {
    const { logger, infos } = makeSummaryLogger();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, logger });

    const stepLogs = infos.filter((l) => l.data && typeof l.data["step"] === "string");
    expect(stepLogs.length).toBeGreaterThanOrEqual(5);
    for (const log of stepLogs) {
      expect(typeof log.data!["durationMs"]).toBe("number");
      expect(log.data!["durationMs"] as number).toBeGreaterThanOrEqual(0);
    }
  });

  it("ACT step log entry includes category, toolName, and success status", async () => {
    const { logger, infos } = makeSummaryLogger();
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, logger });

    const actLog = infos.find((l) => l.data?.["step"] === "ACT");
    expect(actLog).toBeDefined();
    expect(typeof actLog!.data!["category"]).toBe("string");
    expect(typeof actLog!.data!["toolName"]).toBe("string");
    expect(typeof actLog!.data!["success"]).toBe("boolean");
  });

  it("no logger configured — run() completes normally (per-step logs skipped silently)", async () => {
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    const result = await service.run("test", { maxIterations: 1 });
    expect(result.terminationCondition).toBe("MAX_ITERATIONS_REACHED");
  });
});

// ---------------------------------------------------------------------------
// Task 8.2 — tool input redaction
// ---------------------------------------------------------------------------

describe("AgentLoopService task 8.2 — tool input redaction", () => {
  function makeLargeInputLlm(): LlmProviderPort {
    let callCount = 0;
    return {
      async complete(_prompt) {
        callCount++;
        if (callCount % 2 === 1) {
          return {
            ok: true,
            value: {
              content: JSON.stringify({
                category: "Modification",
                toolName: "write_file",
                toolInput: { content: "x".repeat(512), path: "/small.ts" },
                rationale: "Write file",
              }),
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        }
        return { ok: true, value: { content: makeValidReflectionJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };
  }

  it("large toolInput string values (>256 chars) are redacted in log entries", async () => {
    const loggedData: string[] = [];
    const logger = {
      info(_msg: string, data?: Readonly<Record<string, unknown>>) {
        if (data) loggedData.push(JSON.stringify(data));
      },
      error(_msg: string, _data?: Readonly<Record<string, unknown>>) {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeLargeInputLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, logger });

    const allLogs = loggedData.join("");
    // The large string 'x'.repeat(512) should NOT appear verbatim
    expect(allLogs).not.toContain("x".repeat(512));
  });

  it("small toolInput values are preserved in log entries (not redacted)", async () => {
    const loggedData: string[] = [];
    const logger = {
      info(_msg: string, data?: Readonly<Record<string, unknown>>) {
        if (data) loggedData.push(JSON.stringify(data));
      },
      error(_msg: string, _data?: Readonly<Record<string, unknown>>) {},
    };

    // makeCycledLlm uses toolInput: { path: '/workspace/src/index.ts' }
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, logger });

    const allLogs = loggedData.join("");
    // Short path value should appear in the logs
    expect(allLogs).toContain("/workspace/src/index.ts");
  });
});

// ---------------------------------------------------------------------------
// Task 8.2 — error path logging
// ---------------------------------------------------------------------------

describe("AgentLoopService task 8.2 — error path logging", () => {
  function makeFailingExecutor(): IToolExecutor {
    return {
      async invoke(_name, _input, _ctx) {
        return { ok: false, error: { type: "runtime", message: "specific-error-abc-123" } };
      },
    };
  }

  it("logs an error entry when tool invocation fails", async () => {
    const errors: Array<{ msg: string; data?: Readonly<Record<string, unknown>> }> = [];
    const logger = {
      info(_msg: string, _data?: Readonly<Record<string, unknown>>) {},
      error(msg: string, data?: Readonly<Record<string, unknown>>) {
        errors.push({ msg, data });
      },
    };

    const service = new AgentLoopService(makeFailingExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, logger });

    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("error log entry contains the error message from the tool failure", async () => {
    const errors: Array<{ msg: string; data?: Readonly<Record<string, unknown>> }> = [];
    const logger = {
      info(_msg: string, _data?: Readonly<Record<string, unknown>>) {},
      error(msg: string, data?: Readonly<Record<string, unknown>>) {
        errors.push({ msg, data });
      },
    };

    const service = new AgentLoopService(makeFailingExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, logger });

    const allText = errors.map((e) => `${e.msg} ${JSON.stringify(e.data ?? {})}`).join(" ");
    expect(allText).toContain("specific-error-abc-123");
  });

  it("error log entry includes error type", async () => {
    const errors: Array<{ msg: string; data?: Readonly<Record<string, unknown>> }> = [];
    const logger = {
      info(_msg: string, _data?: Readonly<Record<string, unknown>>) {},
      error(msg: string, data?: Readonly<Record<string, unknown>>) {
        errors.push({ msg, data });
      },
    };

    const service = new AgentLoopService(makeFailingExecutor(), makeRegistry(), makeCycledLlm(), makeToolContext());
    await service.run("test", { maxIterations: 1, logger });

    const errorData = errors.flatMap((e) => Object.values(e.data ?? {})).join(" ");
    expect(errorData).toContain("runtime");
  });
});

// ---------------------------------------------------------------------------
// Task 8.2 — state query without blocking
// ---------------------------------------------------------------------------

describe("AgentLoopService task 8.2 — state query during execution", () => {
  it("getState() returns a non-null snapshot during run() execution", async () => {
    let snapshotDuringExecution: Readonly<AgentState> | null = null;
    let svc!: AgentLoopService;

    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        snapshotDuringExecution = svc.getState();
        return { ok: true, value: {} };
      },
    };

    svc = new AgentLoopService(executor, makeRegistry(), makeCycledLlm(), makeToolContext());
    await svc.run("my-task", { maxIterations: 1 });

    expect(snapshotDuringExecution).not.toBeNull();
  });

  it("getState() snapshot during execution contains the task string", async () => {
    let snapshotDuringExecution: Readonly<AgentState> | null = null;
    let svc!: AgentLoopService;

    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        snapshotDuringExecution = svc.getState();
        return { ok: true, value: {} };
      },
    };

    svc = new AgentLoopService(executor, makeRegistry(), makeCycledLlm(), makeToolContext());
    await svc.run("my-special-task", { maxIterations: 1 });

    expect(snapshotDuringExecution!.task).toBe("my-special-task");
  });

  it("getState() snapshot during execution includes iterationCount and completedSteps", async () => {
    let snapshotDuringExecution: Readonly<AgentState> | null = null;
    let svc!: AgentLoopService;

    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        snapshotDuringExecution = svc.getState();
        return { ok: true, value: {} };
      },
    };

    svc = new AgentLoopService(executor, makeRegistry(), makeCycledLlm(), makeToolContext());
    await svc.run("test", { maxIterations: 1 });

    expect(typeof snapshotDuringExecution!.iterationCount).toBe("number");
    expect(Array.isArray(snapshotDuringExecution!.completedSteps)).toBe(true);
  });
});
