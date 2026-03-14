import { describe, expect, it } from "bun:test";
import { ContextEngineService } from "../../../src/application/context/context-engine-service";
import type { ContextEngineServiceOptions } from "../../../src/application/context/context-engine-service";
import type {
  AccumulatedEntry,
  CachedEntry,
  CompressionResult,
  ContextBuildRequest,
  ExpansionEvent,
  IContextAccumulator,
  IContextCache,
  IContextPlanner,
  ILayerCompressor,
  ITokenBudgetManager,
  LayerBudgetMap,
  LayerId,
} from "../../../src/application/ports/context";
import type { MemoryPort } from "../../../src/application/ports/memory";
import type { IToolExecutor } from "../../../src/application/tools/executor";

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

/** Budget manager with tight layer budgets to force compression. */
function makeTightBudgetManager(codeContextBudget = 5): ITokenBudgetManager {
  return {
    countTokens: (text) => Math.ceil(text.length / 4),
    allocate: (): LayerBudgetMap => ({
      budgets: {
        systemInstructions: 1000,
        taskDescription: 500,
        activeSpecification: 2000,
        codeContext: codeContextBudget,
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

function makeTrackingCompressor(): {
  compressor: ILayerCompressor;
  compressedLayers: string[];
} {
  const compressedLayers: string[] = [];
  const compressor: ILayerCompressor = {
    compress: (layerId, content, _budget, tokenCounter): CompressionResult => {
      compressedLayers.push(layerId);
      return {
        compressed: "short",
        tokenCount: tokenCounter("short"),
        technique: "truncation",
        originalTokenCount: tokenCounter(content),
      };
    },
  };
  return { compressor, compressedLayers };
}

function makeAccumulator(): IContextAccumulator {
  return {
    accumulate: () => {},
    getEntries: () => [],
    recordExpansion: () => ({ ok: true }),
    getExpansionEvents: () => [],
    resetPhase: () => {},
    resetTask: () => {},
  };
}

/** Accumulator that rejects recordExpansion after `maxCount` calls. */
function makeLimitedAccumulator(maxCount: number): IContextAccumulator {
  let count = 0;
  const events: ExpansionEvent[] = [];
  const entries: AccumulatedEntry[] = [];
  return {
    accumulate: (entry) => entries.push(entry),
    getEntries: () => entries,
    recordExpansion: (event) => {
      if (count >= maxCount) {
        return { ok: false, errorReason: `Expansion limit of ${maxCount} reached.` };
      }
      count++;
      events.push(event);
      return { ok: true };
    },
    getExpansionEvents: () => events,
    resetPhase: () => {
      count = 0;
    },
    resetTask: () => {
      count = 0;
    },
  };
}

function makeCache(): IContextCache {
  const store = new Map<string, CachedEntry>();
  return {
    get: (fp, mtime) => {
      const e = store.get(fp);
      return e && e.mtime === mtime ? e : null;
    },
    set: (e) => store.set(e.filePath, e),
    invalidate: (fp) => store.delete(fp),
    stats: () => ({ hits: 0, misses: 0, entries: store.size }),
    clear: () => store.clear(),
  };
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

/** MemoryPort that returns a fixed entry for any query. */
function makeMemoryPortWithEntry(title: string, desc: string): MemoryPort {
  return {
    shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
    query: async () => ({
      entries: [
        {
          relevanceScore: 0.9,
          entry: { id: "mem-1", title, description: desc, tags: [], createdAt: "", updatedAt: "" },
        },
      ],
    }),
    append: async () => ({ ok: true, action: "appended" }),
    update: async () => ({ ok: true, action: "updated" }),
    writeFailure: async () => ({ ok: true, action: "appended" }),
    getFailures: async () => [],
  };
}

function makeToolExecutor(readFileContent = "file content"): IToolExecutor {
  return {
    invoke: async (name, args) => {
      if (name === "git_status") {
        return { ok: true, value: { branch: "main", staged: [], unstaged: [] } };
      }
      if (name === "read_file") {
        return { ok: true, value: readFileContent };
      }
      return { ok: true, value: {} };
    },
  };
}

function makeFailingToolExecutor(): IToolExecutor {
  return {
    invoke: async (name) => {
      if (name === "git_status") {
        return { ok: true, value: { branch: "main", staged: [], unstaged: [] } };
      }
      return { ok: false, error: "tool failure" };
    },
  };
}

function makeService(opts: {
  planner?: IContextPlanner;
  budgetManager?: ITokenBudgetManager;
  compressor?: ILayerCompressor;
  accumulator?: IContextAccumulator;
  toolExecutor?: IToolExecutor;
  memoryPort?: MemoryPort;
  cache?: IContextCache;
}) {
  const serviceOpts: ContextEngineServiceOptions = {
    workspaceRoot: "/workspace",
  };
  return new ContextEngineService(
    opts.memoryPort ?? makeMemoryPort(),
    opts.toolExecutor ?? makeToolExecutor(),
    opts.planner ?? makePlannerWith([]),
    opts.budgetManager ?? makeDefaultBudgetManager(),
    opts.compressor ?? makeCompressor(),
    opts.accumulator ?? makeAccumulator(),
    opts.cache ?? makeCache(),
    serviceOpts,
  );
}

function makeRequest(overrides: Partial<ContextBuildRequest> = {}): ContextBuildRequest {
  return {
    sessionId: "s1",
    phaseId: "p1",
    taskId: "t1",
    stepType: "Exploration",
    taskDescription: "test task",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — Task 9.1: expandContext
// ---------------------------------------------------------------------------

describe("ContextEngineService — expandContext (task 9.1)", () => {
  // -------------------------------------------------------------------------
  // Layer validation
  // -------------------------------------------------------------------------

  it("returns ok: false for invalid targetLayer 'systemInstructions'", async () => {
    const service = makeService({});
    const result = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/path/to/file.ts",
      targetLayer: "systemInstructions" as "codeContext",
    });
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBeDefined();
  });

  it("returns ok: false for invalid targetLayer 'taskDescription'", async () => {
    const service = makeService({});
    const result = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/path/to/file.ts",
      targetLayer: "taskDescription" as "codeContext",
    });
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBeDefined();
  });

  it("returns ok: false for invalid targetLayer 'repositoryState'", async () => {
    const service = makeService({});
    const result = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/path/to/file.ts",
      targetLayer: "repositoryState" as "codeContext",
    });
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBeDefined();
  });

  it("returns ok: false for invalid targetLayer 'toolResults'", async () => {
    const service = makeService({});
    const result = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/path/to/file.ts",
      targetLayer: "toolResults" as "codeContext",
    });
    expect(result.ok).toBe(false);
    expect(result.errorReason).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Successful expansion via IToolExecutor (read_file)
  // -------------------------------------------------------------------------

  it("expands codeContext layer using read_file and returns ok: true with updatedTokenCount", async () => {
    const fileContent = "export function foo() { return 42; }";
    const service = makeService({ toolExecutor: makeToolExecutor(fileContent) });

    const result = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/src/foo.ts",
      targetLayer: "codeContext",
    });

    expect(result.ok).toBe(true);
    expect(result.updatedTokenCount).toBeGreaterThan(0);
  });

  it("expands activeSpecification layer using read_file and returns ok: true", async () => {
    const specContent = "# Spec\n\n## Requirements\n- Must do X";
    const service = makeService({ toolExecutor: makeToolExecutor(specContent) });

    const result = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/specs/feature/requirements.md",
      targetLayer: "activeSpecification",
    });

    expect(result.ok).toBe(true);
    expect(result.updatedTokenCount).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Successful expansion via MemoryPort
  // -------------------------------------------------------------------------

  it("expands memoryRetrieval layer via memoryPort.query and returns ok: true", async () => {
    const memPort = makeMemoryPortWithEntry("Past Decision", "We chose X because Y");
    const service = makeService({ memoryPort: memPort });

    const result = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "query: past architecture decision",
      targetLayer: "memoryRetrieval",
    });

    expect(result.ok).toBe(true);
    expect(result.updatedTokenCount).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Expansion limit enforcement
  // -------------------------------------------------------------------------

  it("returns ok: false when expansion limit is reached", async () => {
    // maxCount=0 means the very first expansion is rejected
    const accumulator = makeLimitedAccumulator(0);
    const service = makeService({ accumulator });

    const result = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/src/foo.ts",
      targetLayer: "codeContext",
    });

    expect(result.ok).toBe(false);
    expect(result.errorReason).toContain("limit");
  });

  it("allows exactly maxCount expansions then rejects the next one", async () => {
    const accumulator = makeLimitedAccumulator(2);
    const service = makeService({
      accumulator,
      toolExecutor: makeToolExecutor("file content"),
    });

    const req = {
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/src/foo.ts",
      targetLayer: "codeContext" as const,
    };

    const r1 = await service.expandContext(req);
    const r2 = await service.expandContext(req);
    const r3 = await service.expandContext(req);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Budget re-check and compression after expansion
  // -------------------------------------------------------------------------

  it("applies compression when expanded layer exceeds budget", async () => {
    const largeFileContent = "x".repeat(1000); // 250 tokens (length/4)
    const { compressor, compressedLayers } = makeTrackingCompressor();
    // codeContext budget = 5 tokens, so 250 tokens will definitely exceed
    const service = makeService({
      budgetManager: makeTightBudgetManager(5),
      compressor,
      toolExecutor: makeToolExecutor(largeFileContent),
    });

    const result = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/src/large.ts",
      targetLayer: "codeContext",
    });

    expect(result.ok).toBe(true);
    expect(compressedLayers).toContain("codeContext");
  });

  it("does not compress when expanded layer is within budget", async () => {
    const smallContent = "hi"; // 1 token
    const { compressor, compressedLayers } = makeTrackingCompressor();
    // codeContext budget = 4000 tokens, so 1 token is within budget
    const service = makeService({
      compressor,
      toolExecutor: makeToolExecutor(smallContent),
    });

    const result = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/src/small.ts",
      targetLayer: "codeContext",
    });

    expect(result.ok).toBe(true);
    expect(compressedLayers).not.toContain("codeContext");
  });

  // -------------------------------------------------------------------------
  // Tool failure handling
  // -------------------------------------------------------------------------

  it("returns ok: false when read_file tool fails", async () => {
    const service = makeService({ toolExecutor: makeFailingToolExecutor() });

    const result = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/nonexistent.ts",
      targetLayer: "codeContext",
    });

    expect(result.ok).toBe(false);
    expect(result.errorReason).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // updatedTokenCount reflects appended content
  // -------------------------------------------------------------------------

  it("updatedTokenCount increases after each successive expansion", async () => {
    const fileContent = "a".repeat(100); // 25 tokens
    const service = makeService({ toolExecutor: makeToolExecutor(fileContent) });

    const r1 = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/src/a.ts",
      targetLayer: "codeContext",
    });

    const r2 = await service.expandContext({
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "/src/b.ts",
      targetLayer: "codeContext",
    });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.updatedTokenCount).toBeGreaterThan(r1.updatedTokenCount);
  });
});
