import { describe, it, expect } from 'bun:test';
import { AgentLoopService } from '../../../application/agent/agent-loop-service';
import type { IAgentLoop, AgentLoopOptions, IContextProvider } from '../../../application/ports/agent-loop';
import type { IToolExecutor } from '../../../application/tools/executor';
import type { IToolRegistry, ToolListEntry } from '../../../domain/tools/registry';
import type { LlmProviderPort } from '../../../application/ports/llm';
import type { ToolContext, MemoryEntry } from '../../../domain/tools/types';
import type { AgentState } from '../../../domain/agent/types';

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
    get: (name) => ({ ok: false, error: { type: 'not_found', name } }),
    list: () => [],
  };
}

function makeLlm(): LlmProviderPort {
  return {
    async complete(_prompt) {
      return { ok: true, value: { content: '{}', usage: { inputTokens: 1, outputTokens: 1 } } };
    },
    clearContext() {},
  };
}

function makeToolContext(): ToolContext {
  return {
    workspaceRoot: '/workspace',
    workingDirectory: '/workspace',
    permissions: {
      filesystemRead: true,
      filesystemWrite: false,
      shellExecution: false,
      gitWrite: false,
      networkAccess: false,
    },
    memory: { async search(): Promise<ReadonlyArray<MemoryEntry>> { return []; } },
    logger: { info() {}, error() {} },
  };
}

// ---------------------------------------------------------------------------
// Constructor and interface conformance
// ---------------------------------------------------------------------------

describe('AgentLoopService constructor', () => {
  it('constructs successfully with all four required dependencies', () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    expect(service).toBeDefined();
  });

  it('satisfies the IAgentLoop interface — has run, stop, and getState methods', () => {
    const service: IAgentLoop = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    expect(typeof service.run).toBe('function');
    expect(typeof service.stop).toBe('function');
    expect(typeof service.getState).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// stop() and getState() — mutable flag behaviour
// ---------------------------------------------------------------------------

describe('AgentLoopService.stop()', () => {
  it('can be called without error when no run is active', () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    expect(() => service.stop()).not.toThrow();
  });

  it('can be called multiple times without error', () => {
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

describe('AgentLoopService.getState()', () => {
  it('returns null before any run is started', () => {
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

describe('AgentLoopService DEFAULT_OPTIONS', () => {
  it('run() accepts an empty options object and uses defaults (does not throw)', async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    // Just verify run() doesn't crash when options is fully omitted
    const result = await service.run('test task', {});
    expect(result).toBeDefined();
    expect(result.finalState).toBeDefined();
    expect(result.terminationCondition).toBeDefined();
  });

  it('run() accepts partial options and merges with defaults', async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    const result = await service.run('test task', { maxIterations: 1 });
    expect(result).toBeDefined();
    expect(result.totalIterations).toBeLessThanOrEqual(1);
  });

  it('run() with maxIterations: 0 terminates immediately with max-iterations-reached', async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    const result = await service.run('test task', { maxIterations: 0 });
    expect(result.terminationCondition).toBe('MAX_ITERATIONS_REACHED');
    expect(result.taskCompleted).toBe(false);
    expect(result.totalIterations).toBe(0);
  });

  it('run() result contains a finalState with the original task string', async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    const result = await service.run('my specific task', { maxIterations: 0 });
    expect(result.finalState.task).toBe('my specific task');
  });
});

// ---------------------------------------------------------------------------
// Dependency boundary — no SDK or tool impl imports in module
// ---------------------------------------------------------------------------

describe('AgentLoopService dependency boundary', () => {
  it('executor, registry, llm, and toolContext are injected (not imported directly)', () => {
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

describe('AgentLoopService.run() outer loop skeleton', () => {
  it('calls registry.list() exactly once per run() invocation', async () => {
    let listCallCount = 0;

    const registry: IToolRegistry = {
      register: () => ({ ok: true, value: undefined }),
      get: (name) => ({ ok: false, error: { type: 'not_found', name } }),
      list: () => { listCallCount++; return []; },
    };

    const service = new AgentLoopService(
      makeExecutor(),
      registry,
      makeLlm(),
      makeToolContext(),
    );

    await service.run('test task', { maxIterations: 0 });
    expect(listCallCount).toBe(1);

    // Reset and verify it is called again on a second run
    listCallCount = 0;
    await service.run('test task again', { maxIterations: 0 });
    expect(listCallCount).toBe(1);
  });

  it('getState() returns null after run() completes (cleanup on every exit path)', async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    await service.run('test task', { maxIterations: 0 });
    expect(service.getState()).toBeNull();
  });

  it('finalState.startedAt is a valid ISO 8601 timestamp', async () => {
    const before = Date.now();

    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    const result = await service.run('test task', { maxIterations: 0 });

    const parsed = Date.parse(result.finalState.startedAt);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(result.finalState.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('finalState has empty plan, completedSteps, and observations on initialization', async () => {
    const service = new AgentLoopService(
      makeExecutor(),
      makeRegistry(),
      makeLlm(),
      makeToolContext(),
    );

    const result = await service.run('test task', { maxIterations: 0 });

    expect(result.finalState.plan).toHaveLength(0);
    expect(result.finalState.completedSteps).toHaveLength(0);
    expect(result.finalState.observations).toHaveLength(0);
    expect(result.finalState.iterationCount).toBe(0);
    expect(result.finalState.recoveryAttempts).toBe(0);
    expect(result.finalState.currentStep).toBeNull();
  });

  it('run() never throws even when an unexpected error occurs internally', async () => {
    const throwingRegistry: IToolRegistry = {
      register: () => ({ ok: true, value: undefined }),
      get: (name) => ({ ok: false, error: { type: 'not_found', name } }),
      list: () => { throw new Error('simulated internal failure'); },
    };

    const service = new AgentLoopService(
      makeExecutor(),
      throwingRegistry,
      makeLlm(),
      makeToolContext(),
    );

    // Must not throw — error should be surfaced as a TerminationCondition
    const result = await service.run('test task', { maxIterations: 1 });
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
    category: 'Exploration',
    toolName: 'read_file',
    toolInput: { path: '/workspace/src/index.ts' },
    rationale: 'Need to read the main file to understand structure',
  });
}

describe('AgentLoopService PLAN step', () => {
  it('valid ActionPlan JSON on first LLM call — returns MAX_ITERATIONS_REACHED (not HUMAN_INTERVENTION_REQUIRED)', async () => {
    const llm: LlmProviderPort = {
      async complete(_prompt) {
        return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run('test task', { maxIterations: 1 });

    expect(result.terminationCondition).toBe('MAX_ITERATIONS_REACHED');
  });

  it('invalid JSON twice then valid JSON — retries and succeeds (MAX_ITERATIONS_REACHED)', async () => {
    let callCount = 0;
    const llm: LlmProviderPort = {
      async complete(_prompt) {
        callCount++;
        if (callCount <= 2) {
          return { ok: true, value: { content: 'not valid json', usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    // maxPlanParseRetries: 2 → 3 total attempts (initial + 2 retries)
    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run('test task', { maxIterations: 1, maxPlanParseRetries: 2 });

    expect(callCount).toBe(3);
    expect(result.terminationCondition).toBe('MAX_ITERATIONS_REACHED');
  });

  it('always invalid JSON beyond retry limit — returns HUMAN_INTERVENTION_REQUIRED', async () => {
    const llm: LlmProviderPort = {
      async complete(_prompt) {
        return { ok: true, value: { content: 'not valid json at all', usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run('test task', { maxIterations: 1, maxPlanParseRetries: 2 });

    expect(result.terminationCondition).toBe('HUMAN_INTERVENTION_REQUIRED');
    expect(result.taskCompleted).toBe(false);
  });

  it('delegates to contextProvider.buildContext() when provided in options', async () => {
    let contextProviderCalled = false;

    const contextProvider: IContextProvider = {
      async buildContext(_state, _toolSchemas) {
        contextProviderCalled = true;
        return 'custom context';
      },
    };

    const llm: LlmProviderPort = {
      async complete(_prompt) {
        return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    await service.run('test task', { maxIterations: 1, contextProvider });

    expect(contextProviderCalled).toBe(true);
  });

  it('uses inline fallback context when no contextProvider — prompt contains task string', async () => {
    let promptReceived = '';

    const llm: LlmProviderPort = {
      async complete(prompt) {
        promptReceived = prompt;
        return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    await service.run('my special task', { maxIterations: 1 });

    expect(promptReceived).toContain('my special task');
  });

  it('ActionPlan with invalid category — returns HUMAN_INTERVENTION_REQUIRED', async () => {
    const badCategoryJson = JSON.stringify({
      category: 'InvalidCategory',
      toolName: 'read_file',
      toolInput: {},
      rationale: 'test',
    });

    const llm: LlmProviderPort = {
      async complete(_prompt) {
        return { ok: true, value: { content: badCategoryJson, usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run('test task', { maxIterations: 1, maxPlanParseRetries: 0 });

    expect(result.terminationCondition).toBe('HUMAN_INTERVENTION_REQUIRED');
  });

  it('ActionPlan with empty toolName — returns HUMAN_INTERVENTION_REQUIRED', async () => {
    const emptyToolNameJson = JSON.stringify({
      category: 'Exploration',
      toolName: '',
      toolInput: {},
      rationale: 'test',
    });

    const llm: LlmProviderPort = {
      async complete(_prompt) {
        return { ok: true, value: { content: emptyToolNameJson, usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    const result = await service.run('test task', { maxIterations: 1, maxPlanParseRetries: 0 });

    expect(result.terminationCondition).toBe('HUMAN_INTERVENTION_REQUIRED');
  });

  it('retry prompt includes error hint after first parse failure', async () => {
    const prompts: string[] = [];

    const llm: LlmProviderPort = {
      async complete(prompt) {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return { ok: true, value: { content: 'bad json', usage: { inputTokens: 1, outputTokens: 1 } } };
        }
        return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };

    const service = new AgentLoopService(makeExecutor(), makeRegistry(), llm, makeToolContext());
    await service.run('test task', { maxIterations: 1, maxPlanParseRetries: 1 });

    expect(prompts.length).toBe(2);
    // Second prompt should contain some hint about the previous failure
    expect(prompts[1]).not.toBe(prompts[0]);
  });
});

// ---------------------------------------------------------------------------
// Task 4.2 — ACT step: tool invocation, observation construction, permission bypass
// ---------------------------------------------------------------------------

describe('AgentLoopService ACT step', () => {
  function makeValidLlm(): LlmProviderPort {
    return {
      async complete(_prompt) {
        return { ok: true, value: { content: makeValidPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
      clearContext() {},
    };
  }

  it('successful tool execution — returns MAX_ITERATIONS_REACHED (no error)', async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: true, value: { result: 'file contents here' } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run('test task', { maxIterations: 1 });

    expect(result.terminationCondition).toBe('MAX_ITERATIONS_REACHED');
    expect(result.taskCompleted).toBe(false);
  });

  it('runtime tool error — does not return HUMAN_INTERVENTION_REQUIRED (non-permission errors do not bypass loop)', async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: false, error: { type: 'runtime', message: 'command failed' } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run('test task', { maxIterations: 1 });

    expect(result.terminationCondition).toBe('MAX_ITERATIONS_REACHED');
  });

  it('validation tool error — does not return HUMAN_INTERVENTION_REQUIRED (non-permission errors do not bypass loop)', async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: false, error: { type: 'validation', message: 'invalid input' } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run('test task', { maxIterations: 1 });

    expect(result.terminationCondition).toBe('MAX_ITERATIONS_REACHED');
  });

  it('permission tool error — returns HUMAN_INTERVENTION_REQUIRED immediately (bypasses recovery)', async () => {
    const executor: IToolExecutor = {
      async invoke(_name, _input, _ctx) {
        return { ok: false, error: { type: 'permission', message: 'write not permitted' } };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    const result = await service.run('test task', { maxIterations: 1 });

    expect(result.terminationCondition).toBe('HUMAN_INTERVENTION_REQUIRED');
    expect(result.taskCompleted).toBe(false);
  });

  it('executor is called with the toolName and toolInput from the ActionPlan', async () => {
    let capturedName = '';
    let capturedInput: unknown = null;

    const executor: IToolExecutor = {
      async invoke(name, input, _ctx) {
        capturedName = name;
        capturedInput = input;
        return { ok: true, value: {} };
      },
    };

    const service = new AgentLoopService(executor, makeRegistry(), makeValidLlm(), makeToolContext());
    await service.run('test task', { maxIterations: 1 });

    // makeValidPlanJson returns toolName: 'read_file', toolInput: { path: '/workspace/src/index.ts' }
    expect(capturedName).toBe('read_file');
    expect(capturedInput).toEqual({ path: '/workspace/src/index.ts' });
  });
});
