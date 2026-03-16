import type {
  CachedEntry,
  CompressionResult,
  IContextAccumulator,
  IContextCache,
  IContextPlanner,
  ILayerCompressor,
  ITokenBudgetManager,
  LayerBudgetMap,
  LayerId,
} from "@/application/ports/context";
import type { MemoryPort } from "@/application/ports/memory";
import { ContextEngineService } from "@/application/services/context/context-engine-service";
import type { ContextEngineServiceOptions } from "@/application/services/context/context-engine-service";
import type { IToolExecutor } from "@/application/services/tools/executor";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlannerWith(layersToRetrieve: LayerId[]): IContextPlanner {
  return {
    plan: () => ({
      layersToRetrieve,
      rationale: "stepType:Exploration taskExcerpt:test",
      codeContextQuery: { paths: [] },
      memoryQuery: { text: "test", topN: 5 },
    }),
  };
}

function makeDefaultBudgetManager(): ITokenBudgetManager {
  return {
    countTokens: (text) => Math.ceil(text.length / 4),
    allocate: (): LayerBudgetMap => ({
      budgets: {
        systemInstructions: 1000,
        taskDescription: 500,
        activeSpecification: 2000,
        codeContext: 4000,
        repositoryState: 500,
        memoryRetrieval: 1500,
        toolResults: 2000,
      },
      totalBudget: 11500,
    }),
    checkBudget: (content, budget) => {
      const tokensUsed = Math.ceil(content.length / 4);
      return { tokensUsed, overBy: Math.max(0, tokensUsed - budget) };
    },
    checkTotal: (counts, totalBudget) => {
      const sum = counts.reduce((acc, l) => acc + l.tokens, 0);
      return sum - totalBudget;
    },
  };
}

function makeCompressor(): ILayerCompressor {
  return {
    compress: (_layerId, _content, _budget, tokenCounter): CompressionResult => ({
      compressed: "COMPRESSED",
      tokenCount: tokenCounter("COMPRESSED"),
      technique: "truncation",
      originalTokenCount: 9999,
    }),
  };
}

/** Accumulator that records which reset methods were called. */
function makeTrackingAccumulator(): {
  accumulator: IContextAccumulator;
  resetPhaseCalls: string[];
  resetTaskCalls: string[];
} {
  const resetPhaseCalls: string[] = [];
  const resetTaskCalls: string[] = [];
  const accumulator: IContextAccumulator = {
    accumulate: () => {},
    getEntries: () => [],
    recordExpansion: () => ({ ok: true }),
    getExpansionEvents: () => [],
    resetPhase: (phaseId) => resetPhaseCalls.push(phaseId),
    resetTask: (taskId) => resetTaskCalls.push(taskId),
  };
  return { accumulator, resetPhaseCalls, resetTaskCalls };
}

function makeCache(): IContextCache {
  const store = new Map<string, CachedEntry>();
  let setCount = 0;
  let clearCount = 0;
  return {
    get: (fp, mtime) => {
      const e = store.get(fp);
      return e && e.mtime === mtime ? e : null;
    },
    set: (e) => {
      store.set(e.filePath, e);
      setCount++;
    },
    invalidate: (fp) => store.delete(fp),
    stats: () => ({ hits: 0, misses: 0, entries: store.size }),
    clear: () => {
      store.clear();
      clearCount++;
    },
    // test helpers
    get _setCount() {
      return setCount;
    },
    get _clearCount() {
      return clearCount;
    },
    get _entries() {
      return store;
    },
  } as IContextCache & { _setCount: number; _clearCount: number; _entries: Map<string, CachedEntry> };
}

function makeMemoryPort(): MemoryPort {
  return {
    shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
    query: async () => ({ entries: [] }),
    append: async () => ({ ok: true, action: "appended" }),
    update: async () => ({ ok: true, action: "updated" }),
    writeFailure: async () => ({ ok: true, action: "appended" }),
    getFailures: async () => [],
  };
}

function makeToolExecutor(): IToolExecutor {
  return {
    invoke: async (name) => {
      if (name === "git_status") {
        return { ok: true, value: { branch: "main", staged: [], unstaged: [] } };
      }
      if (name === "read_file") {
        return { ok: true, value: "file content" };
      }
      return { ok: true, value: {} };
    },
  };
}

function makeService(opts: {
  accumulator?: IContextAccumulator;
  cache?: IContextCache;
  toolExecutor?: IToolExecutor;
} = {}) {
  const serviceOpts: ContextEngineServiceOptions = {
    workspaceRoot: "/workspace",
  };
  return new ContextEngineService(
    makeMemoryPort(),
    opts.toolExecutor ?? makeToolExecutor(),
    makePlannerWith([]),
    makeDefaultBudgetManager(),
    makeCompressor(),
    opts.accumulator ?? makeTrackingAccumulator().accumulator,
    opts.cache ?? makeCache(),
    serviceOpts,
  );
}

// ---------------------------------------------------------------------------
// Log capture helper
// ---------------------------------------------------------------------------

function captureConsoleLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  return {
    logs,
    restore: () => {
      console.info = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — Task 9.2: resetPhase and resetTask observability
// ---------------------------------------------------------------------------

describe("ContextEngineService — resetPhase (task 9.2)", () => {
  it("delegates to accumulator.resetPhase with the given phaseId", () => {
    const { accumulator, resetPhaseCalls } = makeTrackingAccumulator();
    const service = makeService({ accumulator });

    service.resetPhase("phase-abc");

    expect(resetPhaseCalls).toContain("phase-abc");
  });

  it("emits a PhaseResetEvent log entry containing phaseId", () => {
    const { logs, restore } = captureConsoleLogs();
    try {
      const service = makeService({});
      service.resetPhase("phase-xyz");
      const joined = logs.join("\n");
      expect(joined).toContain("phase-xyz");
    } finally {
      restore();
    }
  });

  it("emits a PhaseResetEvent log entry containing a timestamp", () => {
    const { logs, restore } = captureConsoleLogs();
    try {
      const service = makeService({});
      service.resetPhase("p1");
      const joined = logs.join("\n");
      // timestamp should be an ISO date string
      expect(joined).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      restore();
    }
  });

  it("does NOT clear the ContextCache (cache is session-scoped)", () => {
    // The spec says: do not touch ContextCache — it is session-scoped
    const cacheWithTracking = makeCache() as IContextCache & { _clearCount: number };
    const service = makeService({ cache: cacheWithTracking });

    service.resetPhase("p1");
    service.resetPhase("p2");

    expect(cacheWithTracking._clearCount).toBe(0);
  });

  it("releases currentLayers state so next expansion starts fresh", async () => {
    const service = makeService({ toolExecutor: makeToolExecutor() });

    // First expansion sets some state
    const r1 = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/src/a.ts",
      targetLayer: "codeContext",
    });
    expect(r1.ok).toBe(true);
    expect(r1.updatedTokenCount).toBeGreaterThan(0);

    // After phase reset, expansion should start fresh (no accumulated content)
    service.resetPhase("p1");

    const r2 = await service.expandContext({
      sessionId: "s1",
      phaseId: "p2",
      taskId: "t2",
      resourceId: "/src/b.ts",
      targetLayer: "codeContext",
    });
    expect(r2.ok).toBe(true);
    // After reset, token count should be just the new file's tokens
    // (not cumulative from previous phase)
    expect(r2.updatedTokenCount).toBeLessThanOrEqual(r1.updatedTokenCount);
  });
});

describe("ContextEngineService — resetTask (task 9.2)", () => {
  it("delegates to accumulator.resetTask with the given taskId", () => {
    const { accumulator, resetTaskCalls } = makeTrackingAccumulator();
    const service = makeService({ accumulator });

    service.resetTask("task-123");

    expect(resetTaskCalls).toContain("task-123");
  });

  it("emits a TaskResetEvent log entry containing taskId", () => {
    const { logs, restore } = captureConsoleLogs();
    try {
      const service = makeService({});
      service.resetTask("task-xyz");
      const joined = logs.join("\n");
      expect(joined).toContain("task-xyz");
    } finally {
      restore();
    }
  });

  it("emits a TaskResetEvent log entry containing a timestamp", () => {
    const { logs, restore } = captureConsoleLogs();
    try {
      const service = makeService({});
      service.resetTask("t1");
      const joined = logs.join("\n");
      expect(joined).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      restore();
    }
  });

  it("releases accumulated token budget state so next expansion starts fresh", async () => {
    const service = makeService({ toolExecutor: makeToolExecutor() });

    // First expansion builds up accumulated state
    const r1 = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/src/a.ts",
      targetLayer: "codeContext",
    });
    expect(r1.ok).toBe(true);
    expect(r1.updatedTokenCount).toBeGreaterThan(0);

    // After task reset, expansion should start fresh
    service.resetTask("t1");

    const r2 = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t2",
      resourceId: "/src/b.ts",
      targetLayer: "codeContext",
    });
    expect(r2.ok).toBe(true);
    // After task reset, token count should equal just the new content
    // (not accumulated from the previous task)
    expect(r2.updatedTokenCount).toBeLessThanOrEqual(r1.updatedTokenCount);
  });

  it("does NOT clear the ContextCache on task reset", () => {
    const cacheWithTracking = makeCache() as IContextCache & { _clearCount: number };
    const service = makeService({ cache: cacheWithTracking });

    service.resetTask("t1");
    service.resetTask("t2");

    expect(cacheWithTracking._clearCount).toBe(0);
  });
});
