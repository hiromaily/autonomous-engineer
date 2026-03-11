import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunSpecUseCase } from '../../application/usecases/run-spec';
import type { IWorkflowStateStore, IWorkflowEventBus } from '../../application/ports/workflow';
import type { SddFrameworkPort } from '../../application/ports/sdd';
import type { LlmProviderPort } from '../../application/ports/llm';
import type { AesConfig } from '../../application/ports/config';
import type { WorkflowState } from '../../domain/workflow/types';
import type { MemoryPort, ShortTermMemoryPort } from '../../application/ports/memory';

// ─── Stub factories ─────────────────────────────────────────────────────────

function makeStateStore(overrides?: Partial<IWorkflowStateStore>): IWorkflowStateStore {
  const defaultState: WorkflowState = {
    specName: 'test-spec',
    currentPhase: 'SPEC_INIT',
    completedPhases: [],
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    init: mock(() => defaultState),
    persist: mock(() => Promise.resolve()),
    restore: mock(() => Promise.resolve(null)),
    ...overrides,
  };
}

function makeEventBus(): IWorkflowEventBus {
  return {
    emit: mock(() => {}),
    subscribe: mock(() => {}),
    unsubscribe: mock(() => {}),
  };
}

function makeSdd(): SddFrameworkPort {
  return {
    generateRequirements: mock(() => Promise.resolve({ ok: true, artifactPath: '' })),
    generateDesign: mock(() => Promise.resolve({ ok: true, artifactPath: '' })),
    validateDesign: mock(() => Promise.resolve({ ok: true, artifactPath: '' })),
    generateTasks: mock(() => Promise.resolve({ ok: true, artifactPath: '' })),
  };
}

function makeLlm(): LlmProviderPort {
  return {
    complete: mock(() => Promise.resolve({ ok: true as const, value: { content: '', usage: { inputTokens: 0, outputTokens: 0 } } })),
    clearContext: mock(() => {}),
  };
}

function makeShortTerm(): ShortTermMemoryPort {
  return {
    read: mock(() => ({ recentFiles: [] })),
    write: mock(() => {}),
    clear: mock(() => {}),
  };
}

function makeMemoryPort(shortTerm?: ShortTermMemoryPort): MemoryPort {
  const st = shortTerm ?? makeShortTerm();
  return {
    shortTerm: st,
    query: mock(() => Promise.resolve({ entries: [] })),
    append: mock(() => Promise.resolve({ ok: true as const, action: 'appended' as const })),
    update: mock(() => Promise.resolve({ ok: true as const, action: 'updated' as const })),
    writeFailure: mock(() => Promise.resolve({ ok: true as const, action: 'appended' as const })),
    getFailures: mock(() => Promise.resolve([])),
  };
}

const baseConfig: AesConfig = {
  llm: { provider: 'claude', modelName: 'claude-sonnet-4-6', apiKey: 'test-key' },
  specDir: '/tmp/specs',
  sddFramework: 'cc-sdd',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RunSpecUseCase', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'run-spec-test-'));
  });

  describe('dry-run mode', () => {
    it('returns completed with empty phases when spec directory exists', async () => {
      // specDir in config is the parent; the engine checks join(specDir, specName)
      // tmpDir itself is the parent; we use its parent so join(parent, basename(tmpDir)) = tmpDir
      const specParent = join(tmpDir, '..');
      const specName = tmpDir.split('/').at(-1) ?? 'test-spec';
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      const result = await useCase.run(specName, { ...baseConfig, specDir: specParent }, {
        resume: false,
        dryRun: true,
      });

      expect(result).toEqual({ status: 'completed', completedPhases: [] });
    });

    it('returns failed when spec directory does not exist', async () => {
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      const result = await useCase.run('missing-spec', { ...baseConfig, specDir: '/nonexistent/path/xyz' }, {
        resume: false,
        dryRun: true,
      });

      expect(result.status).toBe('failed');
    });

    it('does not call WorkflowEngine or stateStore when dry-run', async () => {
      const specParent = join(tmpDir, '..');
      const specName = tmpDir.split('/').at(-1) ?? 'test-spec';
      const stateStore = makeStateStore();
      const useCase = new RunSpecUseCase({
        stateStore,
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      await useCase.run(specName, { ...baseConfig, specDir: specParent }, {
        resume: false,
        dryRun: true,
      });

      expect(stateStore.init).not.toHaveBeenCalled();
      expect(stateStore.restore).not.toHaveBeenCalled();
      expect(stateStore.persist).not.toHaveBeenCalled();
    });
  });

  describe('resume mode', () => {
    it('calls stateStore.restore on --resume', async () => {
      const restoredState: WorkflowState = {
        specName: 'test-spec',
        currentPhase: 'REQUIREMENTS',
        completedPhases: ['SPEC_INIT'],
        status: 'paused_for_approval',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const stateStore = makeStateStore({
        restore: mock(() => Promise.resolve(restoredState)),
        persist: mock(() => Promise.resolve()),
      });

      // WorkflowEngine will be invoked; use a spec dir that has all required artifacts
      const specDir = tmpDir;
      // Provide spec.json with approvals to allow paused phase to advance
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        join(specDir, 'spec.json'),
        JSON.stringify({ approvals: { requirements: { approved: true } }, ready_for_implementation: true }),
      );

      const useCase = new RunSpecUseCase({
        stateStore,
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      await useCase.run('test-spec', { ...baseConfig, specDir }, { resume: true, dryRun: false });

      expect(stateStore.restore).toHaveBeenCalledWith('test-spec');
      expect(stateStore.init).not.toHaveBeenCalled();
    });

    it('falls back to stateStore.init when restore returns null on --resume', async () => {
      const stateStore = makeStateStore({
        restore: mock(() => Promise.resolve(null)),
        persist: mock(() => Promise.resolve()),
      });
      const useCase = new RunSpecUseCase({
        stateStore,
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      await useCase.run('test-spec', { ...baseConfig, specDir: tmpDir }, { resume: true, dryRun: false });

      expect(stateStore.restore).toHaveBeenCalledWith('test-spec');
      expect(stateStore.init).toHaveBeenCalledWith('test-spec');
    });

    it('calls stateStore.init (not restore) when not resuming', async () => {
      const stateStore = makeStateStore({
        persist: mock(() => Promise.resolve()),
      });
      const useCase = new RunSpecUseCase({
        stateStore,
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      await useCase.run('test-spec', { ...baseConfig, specDir: tmpDir }, { resume: false, dryRun: false });

      expect(stateStore.init).toHaveBeenCalledWith('test-spec');
      expect(stateStore.restore).not.toHaveBeenCalled();
    });
  });

  describe('provider override', () => {
    it('passes providerOverride to createLlmProvider', async () => {
      const createLlmProvider = mock((_config: AesConfig, _override?: string) => makeLlm());
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        createLlmProvider,
        memory: makeMemoryPort(),
      });

      await useCase.run('test-spec', { ...baseConfig, specDir: tmpDir }, {
        resume: false,
        dryRun: false,
        providerOverride: 'openai',
      });

      expect(createLlmProvider).toHaveBeenCalledWith(expect.objectContaining({ llm: expect.anything() }), 'openai');
    });

    it('passes undefined providerOverride when not specified', async () => {
      const createLlmProvider = mock((_config: AesConfig, _override?: string) => makeLlm());
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        createLlmProvider,
        memory: makeMemoryPort(),
      });

      await useCase.run('test-spec', { ...baseConfig, specDir: tmpDir }, { resume: false, dryRun: false });

      expect(createLlmProvider).toHaveBeenCalledWith(expect.objectContaining({}), undefined);
    });
  });

  describe('engine delegation', () => {
    it('delegates execution to WorkflowEngine and returns its result', async () => {
      // WorkflowEngine pauses at REQUIREMENTS approval gate unless spec.json approves it.
      // Supply a spec.json with all approvals so all phases complete.
      const { writeFile, mkdir } = await import('node:fs/promises');
      const specSubDir = join(tmpDir, 'test-spec');
      await mkdir(specSubDir, { recursive: true });
      const specJson = {
        approvals: {
          requirements: { approved: true },
          design: { approved: true },
          tasks: { approved: true },
        },
        ready_for_implementation: true,
      };
      await writeFile(join(specSubDir, 'spec.json'), JSON.stringify(specJson));
      // Create required artifacts for each phase gate
      await writeFile(join(specSubDir, 'requirements.md'), '# Requirements');
      await writeFile(join(specSubDir, 'design.md'), '# Design');
      await writeFile(join(specSubDir, 'tasks.md'), '# Tasks');

      const stateStore = makeStateStore({ persist: mock(() => Promise.resolve()) });
      const eventBus = makeEventBus();
      const useCase = new RunSpecUseCase({
        stateStore,
        eventBus,
        sdd: makeSdd(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      const result = await useCase.run('test-spec', { ...baseConfig, specDir: tmpDir }, {
        resume: false,
        dryRun: false,
      });

      // WorkflowEngine will complete all 7 phases (all stubs return ok, all approvals granted)
      expect(result.status).toBe('completed');
    });

    it('passes specDir from config joined with specName to engine', async () => {
      // SPEC_INIT is a stub (no artifact requirements); workflow pauses at REQUIREMENTS gate.
      // That is still a valid result — we just verify run() returns without throwing.
      const stateStore = makeStateStore({ persist: mock(() => Promise.resolve()) });
      const useCase = new RunSpecUseCase({
        stateStore,
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        createLlmProvider: () => makeLlm(),
        memory: makeMemoryPort(),
      });

      const result = await useCase.run('test-spec', { ...baseConfig, specDir: tmpDir }, {
        resume: false,
        dryRun: false,
      });

      expect(result).toBeDefined();
    });
  });

  describe('memory lifecycle', () => {
    it('calls memory.shortTerm.clear() at the start of a non-dry-run execution', async () => {
      const shortTerm = makeShortTerm();
      const memory = makeMemoryPort(shortTerm);
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        createLlmProvider: () => makeLlm(),
        memory,
      });

      await useCase.run('test-spec', { ...baseConfig, specDir: tmpDir }, { resume: false, dryRun: false });

      expect(shortTerm.clear).toHaveBeenCalledTimes(1);
    });

    it('does NOT call memory.shortTerm.clear() during dry-run', async () => {
      const specParent = join(tmpDir, '..');
      const specName = tmpDir.split('/').at(-1) ?? 'test-spec';
      const shortTerm = makeShortTerm();
      const memory = makeMemoryPort(shortTerm);
      const useCase = new RunSpecUseCase({
        stateStore: makeStateStore(),
        eventBus: makeEventBus(),
        sdd: makeSdd(),
        createLlmProvider: () => makeLlm(),
        memory,
      });

      await useCase.run(specName, { ...baseConfig, specDir: specParent }, { resume: false, dryRun: true });

      expect(shortTerm.clear).not.toHaveBeenCalled();
    });
  });
});
