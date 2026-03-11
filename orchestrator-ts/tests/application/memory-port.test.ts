import { describe, it, expect } from 'bun:test';
import type {
  ShortTermState,
  TaskProgress,
  ShortTermMemoryPort,
} from '../../application/ports/memory';
import type { WorkflowPhase } from '../../domain/workflow/types';

// ---------------------------------------------------------------------------
// ShortTermState shape
// ---------------------------------------------------------------------------

describe('ShortTermState', () => {
  it('holds required recentFiles array and all optional fields', () => {
    const state: ShortTermState = { recentFiles: [] };

    expect(state.recentFiles).toEqual([]);
    expect(state.currentSpec).toBeUndefined();
    expect(state.currentPhase).toBeUndefined();
    expect(state.taskProgress).toBeUndefined();
  });

  it('accepts all optional fields when provided', () => {
    const phase: WorkflowPhase = 'IMPLEMENTATION';
    const progress: TaskProgress = {
      taskId: 'task-1',
      completedSteps: ['step-a', 'step-b'],
      currentStep: 'step-c',
    };
    const state: ShortTermState = {
      currentSpec: 'memory-system',
      currentPhase: phase,
      taskProgress: progress,
      recentFiles: ['src/foo.ts', 'src/bar.ts'],
    };

    expect(state.currentSpec).toBe('memory-system');
    expect(state.currentPhase).toBe('IMPLEMENTATION');
    expect(state.taskProgress?.taskId).toBe('task-1');
    expect(state.recentFiles).toHaveLength(2);
  });

  it('currentPhase is assignable from WorkflowPhase union', () => {
    const phases: WorkflowPhase[] = [
      'SPEC_INIT',
      'REQUIREMENTS',
      'DESIGN',
      'VALIDATE_DESIGN',
      'TASK_GENERATION',
      'IMPLEMENTATION',
      'PULL_REQUEST',
    ];
    for (const phase of phases) {
      const state: ShortTermState = { currentPhase: phase, recentFiles: [] };
      expect(state.currentPhase).toBe(phase);
    }
  });
});

// ---------------------------------------------------------------------------
// TaskProgress shape
// ---------------------------------------------------------------------------

describe('TaskProgress', () => {
  it('requires taskId and completedSteps; currentStep is optional', () => {
    const progress: TaskProgress = {
      taskId: 'task-2',
      completedSteps: [],
    };

    expect(progress.taskId).toBe('task-2');
    expect(progress.completedSteps).toEqual([]);
    expect(progress.currentStep).toBeUndefined();
  });

  it('holds currentStep when provided', () => {
    const progress: TaskProgress = {
      taskId: 'task-3',
      completedSteps: ['step-1'],
      currentStep: 'step-2',
    };

    expect(progress.currentStep).toBe('step-2');
    expect(progress.completedSteps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ShortTermMemoryPort contract via mock implementation
// ---------------------------------------------------------------------------

function makeShortTermStore(): ShortTermMemoryPort {
  let state: ShortTermState = { recentFiles: [] };
  return {
    read(): ShortTermState {
      return state;
    },
    write(update: Partial<ShortTermState>): void {
      state = { ...state, ...update };
    },
    clear(): void {
      state = { recentFiles: [] };
    },
  };
}

describe('ShortTermMemoryPort contract (mock implementation)', () => {
  it('read() after construction returns empty initial state', () => {
    const store = makeShortTermStore();
    const state = store.read();

    expect(state.recentFiles).toEqual([]);
    expect(state.currentSpec).toBeUndefined();
    expect(state.currentPhase).toBeUndefined();
    expect(state.taskProgress).toBeUndefined();
  });

  it('write() with partial object merges only provided keys', () => {
    const store = makeShortTermStore();
    store.write({ currentSpec: 'memory-system' });
    const after = store.read();

    expect(after.currentSpec).toBe('memory-system');
    expect(after.recentFiles).toEqual([]); // unchanged
    expect(after.currentPhase).toBeUndefined(); // unchanged
  });

  it('write() leaves unmentioned fields at their previous values', () => {
    const store = makeShortTermStore();
    store.write({ currentSpec: 'spec-a', recentFiles: ['file.ts'] });
    store.write({ currentPhase: 'DESIGN' });
    const state = store.read();

    expect(state.currentSpec).toBe('spec-a'); // preserved
    expect(state.recentFiles).toEqual(['file.ts']); // preserved
    expect(state.currentPhase).toBe('DESIGN'); // updated
  });

  it('clear() resets all fields to empty initial state', () => {
    const store = makeShortTermStore();
    store.write({
      currentSpec: 'spec-x',
      currentPhase: 'IMPLEMENTATION',
      recentFiles: ['a.ts', 'b.ts'],
    });
    store.clear();
    const state = store.read();

    expect(state.recentFiles).toEqual([]);
    expect(state.currentSpec).toBeUndefined();
    expect(state.currentPhase).toBeUndefined();
    expect(state.taskProgress).toBeUndefined();
  });

  it('read() returns synchronously without throwing', () => {
    const store = makeShortTermStore();
    expect(() => store.read()).not.toThrow();
    // Return value is not a Promise
    const result = store.read();
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('write() and clear() are synchronous (return undefined)', () => {
    const store = makeShortTermStore();
    const writeResult = store.write({ currentSpec: 'test' });
    const clearResult = store.clear();

    expect(writeResult).toBeUndefined();
    expect(clearResult).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness check for WorkflowPhase via ShortTermState
// ---------------------------------------------------------------------------

const _exhaustivePhase = (phase: WorkflowPhase): string => {
  switch (phase) {
    case 'SPEC_INIT': return 'SPEC_INIT';
    case 'REQUIREMENTS': return 'REQUIREMENTS';
    case 'DESIGN': return 'DESIGN';
    case 'VALIDATE_DESIGN': return 'VALIDATE_DESIGN';
    case 'TASK_GENERATION': return 'TASK_GENERATION';
    case 'IMPLEMENTATION': return 'IMPLEMENTATION';
    case 'PULL_REQUEST': return 'PULL_REQUEST';
  }
};
