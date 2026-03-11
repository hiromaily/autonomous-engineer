import { describe, it, expect } from 'bun:test';
import { AgentLoopService } from '../../../application/agent/agent-loop-service';
import type { IAgentLoop, AgentLoopOptions } from '../../../application/ports/agent-loop';
import type { IToolExecutor } from '../../../application/tools/executor';
import type { IToolRegistry } from '../../../domain/tools/registry';
import type { LlmProviderPort } from '../../../application/ports/llm';
import type { ToolContext, MemoryEntry } from '../../../domain/tools/types';

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
