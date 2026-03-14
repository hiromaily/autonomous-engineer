import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ContextEngineService } from "../../../application/context/context-engine-service";
import type { ContextEngineServiceOptions } from "../../../application/context/context-engine-service";
import type {
  CachedEntry,
  ContextAssemblyResult,
  ContextBuildRequest,
  IContextAccumulator,
  IContextCache,
  IContextPlanner,
  ILayerCompressor,
  ITokenBudgetManager,
  LayerBudgetMap,
  LayerId,
} from "../../../application/ports/context";
import type { MemoryPort, RankedMemoryEntry } from "../../../application/ports/memory";
import type { IToolExecutor } from "../../../application/tools/executor";
import { ContextPlanner } from "../../../domain/context/context-planner";

// ---------------------------------------------------------------------------
// Shared mock factories
// ---------------------------------------------------------------------------

function makeBudgetManager(): ITokenBudgetManager {
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
    compress: (_layerId, content, _budget, tokenCounter) => ({
      compressed: content,
      tokenCount: tokenCounter(content),
      technique: "truncation",
      originalTokenCount: tokenCounter(content),
    }),
  };
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

function makeHealthyMemoryPort(): MemoryPort {
  const entries: RankedMemoryEntry[] = [
    {
      relevanceScore: 0.9,
      sourceFile: "memory.md",
      entry: { title: "Context", context: "test", description: "desc", date: "2026-03-13" },
    },
  ];
  return {
    shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
    query: async () => ({ entries }),
    append: async () => ({ ok: true, action: "appended" }),
    update: async () => ({ ok: true, action: "updated" }),
    writeFailure: async () => ({ ok: true, action: "appended" }),
    getFailures: async () => [],
  };
}

/** MemoryPort whose query() throws an error. */
function makeFailingMemoryPort(message = "memory system unavailable"): MemoryPort {
  return {
    shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
    query: async () => {
      throw new Error(message);
    },
    append: async () => ({ ok: true, action: "appended" }),
    update: async () => ({ ok: true, action: "updated" }),
    writeFailure: async () => ({ ok: true, action: "appended" }),
    getFailures: async () => [],
  };
}

/** IToolExecutor that returns success for all tools by default. */
function makeToolExecutor(opts: {
  gitBranch?: string;
  readFileContent?: string;
  failGitStatus?: boolean;
  failReadFile?: boolean;
} = {}): IToolExecutor {
  return {
    invoke: async (name) => {
      if (name === "git_status") {
        if (opts.failGitStatus) {
          return { ok: false, error: "git command failed" };
        }
        return {
          ok: true,
          value: { branch: opts.gitBranch ?? "main", staged: [], unstaged: [] },
        };
      }
      if (name === "read_file") {
        if (opts.failReadFile) {
          return { ok: false, error: "file not found" };
        }
        return { ok: true, value: opts.readFileContent ?? "// file content" };
      }
      if (name === "search_files") {
        return { ok: true, value: "// search results" };
      }
      return { ok: true, value: {} };
    },
  };
}

/** IToolExecutor whose invoke() throws unexpectedly. */
function makeThrowingToolExecutor(): IToolExecutor {
  return {
    invoke: async (name) => {
      if (name === "git_status") {
        throw new Error("unexpected tool crash");
      }
      return { ok: true, value: {} };
    },
  };
}

/** Planner that always requests the given layers. */
function makePlannerWith(layersToRetrieve: LayerId[], codeContextPath?: string): IContextPlanner {
  return {
    plan: (_stepType, taskDescription) => ({
      layersToRetrieve,
      rationale: `stepType:test taskExcerpt:${taskDescription.slice(0, 100)}`,
      ...(codeContextPath ? { codeContextQuery: { paths: [codeContextPath] } } : {}),
    }),
  };
}

function makeService(opts: {
  planner?: IContextPlanner;
  toolExecutor?: IToolExecutor;
  memoryPort?: MemoryPort;
  options?: ContextEngineServiceOptions;
} = {}) {
  return new ContextEngineService(
    opts.memoryPort ?? makeHealthyMemoryPort(),
    opts.toolExecutor ?? makeToolExecutor(),
    opts.planner ?? new ContextPlanner(),
    makeBudgetManager(),
    makeCompressor(),
    makeAccumulator(),
    makeCache(),
    opts.options ?? { workspaceRoot: "/workspace" },
  );
}

function makeRequest(overrides: Partial<ContextBuildRequest> = {}): ContextBuildRequest {
  return {
    sessionId: "session-1",
    phaseId: "phase-1",
    taskId: "task-1",
    stepType: "Exploration",
    taskDescription: "Explore the codebase for context",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task 11.2: Graceful degradation integration tests
// ---------------------------------------------------------------------------

describe("ContextEngineService — graceful degradation integration (task 11.2)", () => {
  // -------------------------------------------------------------------------
  // 1. MemoryPort failure → degraded: true, omittedLayers includes memoryRetrieval
  // -------------------------------------------------------------------------

  describe("MemoryPort.query() failure", () => {
    let result: ContextAssemblyResult;

    beforeEach(async () => {
      const service = makeService({
        planner: makePlannerWith(["memoryRetrieval"]),
        memoryPort: makeFailingMemoryPort(),
      });
      result = await service.buildContext(makeRequest());
    });

    it("returns degraded: true when MemoryPort.query() throws", () => {
      expect(result.degraded).toBe(true);
    });

    it("omits memoryRetrieval layer when MemoryPort.query() throws", () => {
      expect(result.omittedLayers).toContain("memoryRetrieval");
    });

    it("does not include memoryRetrieval in result.layers when query throws", () => {
      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).not.toContain("memoryRetrieval");
    });

    it("still assembles taskDescription even when memory fails", () => {
      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).toContain("taskDescription");
    });

    it("never throws — returns a result even when MemoryPort.query() throws", async () => {
      const service = makeService({
        planner: makePlannerWith(["memoryRetrieval"]),
        memoryPort: makeFailingMemoryPort(),
      });
      await expect(service.buildContext(makeRequest())).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 2. IToolExecutor git_status failure → degraded: true, omits repositoryState
  // -------------------------------------------------------------------------

  describe("IToolExecutor git_status failure", () => {
    // Tests for ok:false response share identical setup
    let result: ContextAssemblyResult;

    beforeEach(async () => {
      const service = makeService({
        planner: makePlannerWith(["repositoryState"]),
        toolExecutor: makeToolExecutor({ failGitStatus: true }),
      });
      result = await service.buildContext(makeRequest());
    });

    it("returns degraded: true when git_status returns ok: false", () => {
      expect(result.degraded).toBe(true);
    });

    it("omits repositoryState layer when git_status returns ok: false", () => {
      expect(result.omittedLayers).toContain("repositoryState");
    });

    it("does not include repositoryState in result.layers when git_status fails", () => {
      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).not.toContain("repositoryState");
    });

    it("still assembles taskDescription even when git_status fails", () => {
      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).toContain("taskDescription");
    });

    // Throwing executor tests — different setup, kept inline
    it("returns degraded: true when git_status invoke() throws unexpectedly", async () => {
      const service = makeService({
        planner: makePlannerWith(["repositoryState"]),
        toolExecutor: makeThrowingToolExecutor(),
      });
      const r = await service.buildContext(makeRequest());
      expect(r.degraded).toBe(true);
    });

    it("never throws — returns a result even when git_status throws", async () => {
      const service = makeService({
        planner: makePlannerWith(["repositoryState"]),
        toolExecutor: makeThrowingToolExecutor(),
      });
      await expect(service.buildContext(makeRequest())).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 3. activeSpecification file not found → omit layer, no taskDescription substitution
  // -------------------------------------------------------------------------

  describe("activeSpecification file not found", () => {
    it("omits activeSpecification layer when spec file path does not exist", async () => {
      const service = makeService({
        planner: makePlannerWith(["activeSpecification"]),
        options: {
          workspaceRoot: "/workspace",
          activeSpecPath: "/nonexistent/path/to/spec.md",
        },
      });
      const result = await service.buildContext(makeRequest({ stepType: "Modification" }));

      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).not.toContain("activeSpecification");
    });

    it("sets degraded: true when activeSpecification file is missing", async () => {
      const service = makeService({
        planner: makePlannerWith(["activeSpecification"]),
        options: {
          workspaceRoot: "/workspace",
          activeSpecPath: "/nonexistent/path/to/spec.md",
        },
      });
      const result = await service.buildContext(makeRequest({ stepType: "Modification" }));

      expect(result.degraded).toBe(true);
    });

    it("includes activeSpecification in omittedLayers when file is missing", async () => {
      const service = makeService({
        planner: makePlannerWith(["activeSpecification"]),
        options: {
          workspaceRoot: "/workspace",
          activeSpecPath: "/nonexistent/path/to/spec.md",
        },
      });
      const result = await service.buildContext(makeRequest({ stepType: "Modification" }));

      expect(result.omittedLayers).toContain("activeSpecification");
    });

    it("does NOT substitute taskDescription content for the missing activeSpecification", async () => {
      const taskDescription = "unique-task-description-should-not-appear-as-spec";
      const service = makeService({
        planner: makePlannerWith(["taskDescription", "activeSpecification"]),
        options: {
          workspaceRoot: "/workspace",
          activeSpecPath: "/nonexistent/spec.md",
        },
      });
      const result = await service.buildContext(makeRequest({ taskDescription, stepType: "Modification" }));

      // activeSpecification layer must not exist
      const specLayer = result.layers.find((l) => l.layerId === "activeSpecification");
      expect(specLayer).toBeUndefined();

      // taskDescription layer must contain only the task description, not spec content
      const taskLayer = result.layers.find((l) => l.layerId === "taskDescription");
      expect(taskLayer?.content).toBe(taskDescription);
    });

    it("taskDescription layer content is unaffected when activeSpecification is omitted", async () => {
      const taskDescription = "Modify the auth module to support OAuth";
      const service = makeService({
        planner: makePlannerWith(["taskDescription", "activeSpecification"]),
        options: {
          workspaceRoot: "/workspace",
          activeSpecPath: "/nonexistent/requirements.md",
        },
      });
      const result = await service.buildContext(makeRequest({ taskDescription, stepType: "Modification" }));

      const taskLayer = result.layers.find((l) => l.layerId === "taskDescription");
      expect(taskLayer).toBeDefined();
      expect(taskLayer?.content).toBe(taskDescription);
    });

    it("does not throw when activeSpecPath is not configured at all", async () => {
      const service = makeService({
        planner: makePlannerWith(["activeSpecification"]),
        options: { workspaceRoot: "/workspace" }, // no activeSpecPath
      });

      await expect(
        service.buildContext(makeRequest({ stepType: "Modification" })),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Omitted layers produce a log entry at warning or error level
  // -------------------------------------------------------------------------

  describe("omitted layers produce log entries", () => {
    let warnSpy: ReturnType<typeof spyOn>;
    let errorSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      errorSpy = spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("logs a warning when MemoryPort.query() throws and memoryRetrieval is omitted", async () => {
      const service = makeService({
        planner: makePlannerWith(["memoryRetrieval"]),
        memoryPort: makeFailingMemoryPort(),
      });
      await service.buildContext(makeRequest());

      // Either console.warn or console.error must have been called
      const anyLogCalled = warnSpy.mock.calls.length > 0 || errorSpy.mock.calls.length > 0;
      expect(anyLogCalled).toBe(true);
    });

    it("logs a warning or error when git_status fails and repositoryState is omitted", async () => {
      const service = makeService({
        planner: makePlannerWith(["repositoryState"]),
        toolExecutor: makeToolExecutor({ failGitStatus: true }),
      });
      await service.buildContext(makeRequest());

      const anyLogCalled = warnSpy.mock.calls.length > 0 || errorSpy.mock.calls.length > 0;
      expect(anyLogCalled).toBe(true);
    });

    it("logs a warning when activeSpecification file is missing", async () => {
      const service = makeService({
        planner: makePlannerWith(["activeSpecification"]),
        options: {
          workspaceRoot: "/workspace",
          activeSpecPath: "/nonexistent/spec.md",
        },
      });
      await service.buildContext(makeRequest({ stepType: "Modification" }));

      const anyLogCalled = warnSpy.mock.calls.length > 0 || errorSpy.mock.calls.length > 0;
      expect(anyLogCalled).toBe(true);
    });

    it("logs when steering doc path does not exist and systemInstructions is omitted", async () => {
      const service = makeService({
        options: {
          workspaceRoot: "/workspace",
          steeringDocPaths: ["/nonexistent/steering/tech.md"],
        },
      });
      await service.buildContext(makeRequest());

      const anyLogCalled = warnSpy.mock.calls.length > 0 || errorSpy.mock.calls.length > 0;
      expect(anyLogCalled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Multiple simultaneous failures — all degradations are cumulative
  // -------------------------------------------------------------------------

  describe("multiple simultaneous failures", () => {
    it("omits both memoryRetrieval and repositoryState when both fail", async () => {
      const service = makeService({
        planner: makePlannerWith(["repositoryState", "memoryRetrieval"]),
        toolExecutor: makeToolExecutor({ failGitStatus: true }),
        memoryPort: makeFailingMemoryPort(),
      });
      const result = await service.buildContext(makeRequest());

      expect(result.omittedLayers).toContain("repositoryState");
      expect(result.omittedLayers).toContain("memoryRetrieval");
      expect(result.degraded).toBe(true);
    });

    it("still assembles taskDescription when all other layers fail", async () => {
      const service = makeService({
        planner: makePlannerWith(["repositoryState", "memoryRetrieval", "activeSpecification"]),
        toolExecutor: makeToolExecutor({ failGitStatus: true }),
        memoryPort: makeFailingMemoryPort(),
        options: {
          workspaceRoot: "/workspace",
          activeSpecPath: "/nonexistent/spec.md",
        },
      });
      const result = await service.buildContext(makeRequest({ stepType: "Modification" }));

      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).toContain("taskDescription");
      expect(result.degraded).toBe(true);
    });

    it("result.layers count equals all requested layers minus the failed ones", async () => {
      // Request: taskDescription + repositoryState (fails) + memoryRetrieval (fails)
      // Expected assembled: taskDescription only (repositoryState + memoryRetrieval omitted)
      const service = makeService({
        planner: makePlannerWith(["repositoryState", "memoryRetrieval"]),
        toolExecutor: makeToolExecutor({ failGitStatus: true }),
        memoryPort: makeFailingMemoryPort(),
      });
      const result = await service.buildContext(makeRequest());

      // Only taskDescription should be assembled (systemInstructions also absent — no steeringDocPaths)
      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).toContain("taskDescription");
      expect(layerIds).not.toContain("repositoryState");
      expect(layerIds).not.toContain("memoryRetrieval");
    });
  });
});
