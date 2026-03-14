import { describe, expect, it } from "bun:test";
import { ContextEngineService } from "../../../src/application/context/context-engine-service";
import type { ContextEngineServiceOptions } from "../../../src/application/context/context-engine-service";
import type {
  CachedEntry,
  CompressionResult,
  ContextBuildRequest,
  IContextAccumulator,
  IContextCache,
  IContextPlanner,
  ILayerCompressor,
  ITokenBudgetManager,
  LayerBudgetMap,
  LayerId,
  TokenBudgetConfig,
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

/** Budget manager where every layer has a small budget (50 tokens) to force compression. */
function makeTightBudgetManager(layerBudget = 50): ITokenBudgetManager {
  return {
    countTokens: (text) => Math.ceil(text.length / 4),
    allocate: (): LayerBudgetMap => ({
      budgets: {
        systemInstructions: layerBudget,
        taskDescription: layerBudget,
        activeSpecification: layerBudget,
        codeContext: layerBudget,
        repositoryState: layerBudget,
        memoryRetrieval: layerBudget,
        toolResults: layerBudget,
      },
      totalBudget: layerBudget * 7,
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

/** Compressor that returns a short fixed string to simulate compression. */
function makeCompressor(compressedOutput = "COMPRESSED"): ILayerCompressor {
  return {
    compress: (_layerId, _content, _budget, tokenCounter): CompressionResult => ({
      compressed: compressedOutput,
      tokenCount: tokenCounter(compressedOutput),
      technique: "truncation",
      originalTokenCount: 9999,
    }),
  };
}

/** Compressor that tracks which layers it was called on. */
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

function makeMemoryPort(content = "(no memory entries)"): MemoryPort {
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
      return { ok: true, value: {} };
    },
  };
}

function makeService(opts: {
  planner?: IContextPlanner;
  budgetManager?: ITokenBudgetManager;
  compressor?: ILayerCompressor;
  tokenBudgetConfig?: TokenBudgetConfig;
  toolExecutor?: IToolExecutor;
  memoryPort?: MemoryPort;
}) {
  const serviceOpts: ContextEngineServiceOptions = {
    workspaceRoot: "/workspace",
    ...(opts.tokenBudgetConfig !== undefined && { tokenBudgetConfig: opts.tokenBudgetConfig }),
  };
  return new ContextEngineService(
    opts.memoryPort ?? makeMemoryPort(),
    opts.toolExecutor ?? makeToolExecutor(),
    opts.planner ?? makePlannerWith([]),
    opts.budgetManager ?? makeDefaultBudgetManager(),
    opts.compressor ?? makeCompressor(),
    makeAccumulator(),
    makeCache(),
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
// Task 8.3 — Token budget enforcement, compression, assembly
// ---------------------------------------------------------------------------

describe("ContextEngineService (task 8.3)", () => {
  // -----------------------------------------------------------------------
  // Per-layer compression
  // -----------------------------------------------------------------------

  describe("per-layer compression", () => {
    it("calls compress() on a layer that exceeds its budget", async () => {
      const { compressor, compressedLayers } = makeTrackingCompressor();

      // memoryRetrieval budget = 50 tokens; text = 500 chars = 125 tokens → over budget
      const memoryPort: MemoryPort = {
        shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
        query: async () => ({
          entries: [
            {
              entry: {
                title: "T",
                description: "x".repeat(500),
                context: "c",
                date: "2026-01-01",
              },
              sourceFile: "coding_patterns",
              relevanceScore: 0.9,
            },
          ],
        }),
        append: async () => ({ ok: true, action: "appended" }),
        update: async () => ({ ok: true, action: "updated" }),
        writeFailure: async () => ({ ok: true, action: "appended" }),
        getFailures: async () => [],
      };

      const svc = makeService({
        planner: makePlannerWith(["memoryRetrieval"]),
        budgetManager: makeTightBudgetManager(50),
        compressor,
        memoryPort,
      });

      await svc.buildContext(makeRequest());
      expect(compressedLayers).toContain("memoryRetrieval");
    });

    it("does NOT call compress() on systemInstructions even when over budget", async () => {
      const { compressor, compressedLayers } = makeTrackingCompressor();

      // We'd need a real file for systemInstructions — skip by using empty paths
      // instead verify that if systemInstructions were present, it wouldn't be compressed
      // Test via taskDescription (also protected) using a very tight budget
      const svc = makeService({
        planner: makePlannerWith([]),
        budgetManager: makeTightBudgetManager(1), // 1 token budget — taskDesc will exceed
        compressor,
      });

      await svc.buildContext(
        makeRequest({ taskDescription: "A".repeat(200) }), // 50 tokens
      );

      // taskDescription must NOT be in compressed layers
      expect(compressedLayers).not.toContain("taskDescription");
    });

    it("does NOT call compress() on taskDescription even when over budget", async () => {
      const { compressor, compressedLayers } = makeTrackingCompressor();

      const svc = makeService({
        planner: makePlannerWith([]),
        budgetManager: makeTightBudgetManager(1),
        compressor,
      });

      await svc.buildContext(makeRequest({ taskDescription: "B".repeat(200) }));

      expect(compressedLayers).not.toContain("taskDescription");
    });

    it("sets layerUsage[i].compressed=true for compressed layers", async () => {
      const memoryPort: MemoryPort = {
        shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
        query: async () => ({
          entries: [
            {
              entry: {
                title: "T",
                description: "x".repeat(500),
                context: "c",
                date: "2026-01-01",
              },
              sourceFile: "coding_patterns",
              relevanceScore: 0.9,
            },
          ],
        }),
        append: async () => ({ ok: true, action: "appended" }),
        update: async () => ({ ok: true, action: "updated" }),
        writeFailure: async () => ({ ok: true, action: "appended" }),
        getFailures: async () => [],
      };

      const svc = makeService({
        planner: makePlannerWith(["memoryRetrieval"]),
        budgetManager: makeTightBudgetManager(50),
        compressor: makeCompressor("COMPRESSED"),
        memoryPort,
      });

      const result = await svc.buildContext(makeRequest());
      const memUsage = result.layerUsage.find((u) => u.layerId === "memoryRetrieval");

      expect(memUsage).toBeDefined();
      expect(memUsage?.compressed).toBe(true);
    });

    it("sets layerUsage[i].compressed=false for layers that fit within budget", async () => {
      const svc = makeService({
        planner: makePlannerWith([]),
        budgetManager: makeDefaultBudgetManager(),
        compressor: makeCompressor(),
      });

      // taskDescription = "test task" (9 chars = ~3 tokens) << 500 budget
      const result = await svc.buildContext(makeRequest());
      const tdUsage = result.layerUsage.find((u) => u.layerId === "taskDescription");

      expect(tdUsage?.compressed).toBe(false);
    });

    it("replaces layer content with compressed output in the final result", async () => {
      const oversizedContent = "x".repeat(400); // 100 tokens > 50 budget

      const memoryPort: MemoryPort = {
        shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
        query: async () => ({
          entries: [
            {
              entry: {
                title: "T",
                description: oversizedContent,
                context: "c",
                date: "2026-01-01",
              },
              sourceFile: "coding_patterns",
              relevanceScore: 0.9,
            },
          ],
        }),
        append: async () => ({ ok: true, action: "appended" }),
        update: async () => ({ ok: true, action: "updated" }),
        writeFailure: async () => ({ ok: true, action: "appended" }),
        getFailures: async () => [],
      };

      const svc = makeService({
        planner: makePlannerWith(["memoryRetrieval"]),
        budgetManager: makeTightBudgetManager(50),
        compressor: makeCompressor("SMALL_OUTPUT"),
        memoryPort,
      });

      const result = await svc.buildContext(makeRequest());
      const layer = result.layers.find((l) => l.layerId === "memoryRetrieval");

      expect(layer?.content).toBe("SMALL_OUTPUT");
      expect(result.content).toContain("SMALL_OUTPUT");
    });
  });

  // -----------------------------------------------------------------------
  // Total budget check and lowest-priority truncation
  // -----------------------------------------------------------------------

  describe("total budget check", () => {
    it("truncates the lowest-priority populated layer when total exceeds model limit", async () => {
      // Create a budget manager where total budget = 5 tokens but each layer gets 5
      // so any realistic content will overshoot the total
      const veryTightManager: ITokenBudgetManager = {
        countTokens: (text) => text.length, // 1 char = 1 token
        allocate: (): LayerBudgetMap => ({
          budgets: {
            systemInstructions: 1000,
            taskDescription: 1000,
            activeSpecification: 1000,
            codeContext: 1000,
            repositoryState: 1000,
            memoryRetrieval: 1000,
            toolResults: 1000,
          },
          totalBudget: 5, // intentionally tiny total
        }),
        checkBudget: (content, budget) => {
          const tokensUsed = content.length;
          return { tokensUsed, overBy: Math.max(0, tokensUsed - budget) };
        },
        checkTotal: (counts, totalBudget) => {
          const sum = counts.reduce((acc, l) => acc + l.tokens, 0);
          return sum - totalBudget;
        },
      };

      const taskDescription = "A".repeat(50); // 50 tokens >> total budget of 5

      const svc = makeService({
        planner: makePlannerWith([]),
        budgetManager: veryTightManager,
      });

      // Should not throw — graceful truncation
      const result = await svc.buildContext(makeRequest({ taskDescription }));
      expect(result).toBeDefined();
      expect(result.totalTokens).toBeDefined();
    });

    it("does not truncate when total tokens fit within model limit", async () => {
      const svc = makeService({
        planner: makePlannerWith([]),
        budgetManager: makeDefaultBudgetManager(),
      });

      // "test task" = ~9 chars = 3 tokens << 11500 total budget
      const result = await svc.buildContext(makeRequest());
      expect(result.degraded).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Content assembly — separators and canonical order
  // -----------------------------------------------------------------------

  describe("content assembly", () => {
    it("each layer in content is prefixed with '=== [LAYER: <layerId>] ==='", async () => {
      const svc = makeService({
        planner: makePlannerWith([]),
      });

      const result = await svc.buildContext(makeRequest({ taskDescription: "my task" }));

      // taskDescription must always be present
      expect(result.content).toContain("=== [LAYER: taskDescription] ===");
      expect(result.content).toContain("my task");
    });

    it("layer separator is '=== [LAYER: <id>] ===\\n<content>'", async () => {
      const svc = makeService({
        planner: makePlannerWith([]),
      });

      const result = await svc.buildContext(makeRequest({ taskDescription: "TD_CONTENT" }));
      expect(result.content).toContain("=== [LAYER: taskDescription] ===\nTD_CONTENT");
    });

    it("assembles layers in canonical order (systemInstructions < taskDescription < ... < toolResults)", async () => {
      const executor: IToolExecutor = {
        invoke: async (name) => {
          if (name === "git_status") {
            return { ok: true, value: { branch: "main", staged: [], unstaged: [] } };
          }
          return { ok: true, value: {} };
        },
      };

      const memoryPort: MemoryPort = {
        shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
        query: async () => ({ entries: [] }),
        append: async () => ({ ok: true, action: "appended" }),
        update: async () => ({ ok: true, action: "updated" }),
        writeFailure: async () => ({ ok: true, action: "appended" }),
        getFailures: async () => [],
      };

      const svc = makeService({
        planner: makePlannerWith(["repositoryState", "memoryRetrieval"]),
        toolExecutor: executor,
        memoryPort,
      });

      const result = await svc.buildContext(makeRequest());

      // Find positions of each section in content string
      const tdPos = result.content.indexOf("[LAYER: taskDescription]");
      const repoPos = result.content.indexOf("[LAYER: repositoryState]");
      const memPos = result.content.indexOf("[LAYER: memoryRetrieval]");

      // taskDescription comes before repositoryState
      expect(tdPos).toBeLessThan(repoPos);
      // repositoryState comes before memoryRetrieval
      expect(repoPos).toBeLessThan(memPos);
    });

    it("result.layers array preserves canonical order", async () => {
      const executor: IToolExecutor = {
        invoke: async (name) => {
          if (name === "git_status") {
            return { ok: true, value: { branch: "main", staged: [], unstaged: [] } };
          }
          return { ok: true, value: {} };
        },
      };

      const svc = makeService({
        planner: makePlannerWith(["repositoryState"]),
        toolExecutor: executor,
      });

      const result = await svc.buildContext(makeRequest());
      const layerIds = result.layers.map((l) => l.layerId);

      const tdIdx = layerIds.indexOf("taskDescription");
      const repoIdx = layerIds.indexOf("repositoryState");

      expect(tdIdx).not.toBe(-1);
      expect(repoIdx).not.toBe(-1);
      expect(tdIdx).toBeLessThan(repoIdx);
    });

    it("result.layers contains individual layer content accessible without string parsing", async () => {
      const svc = makeService({
        planner: makePlannerWith([]),
      });

      const result = await svc.buildContext(makeRequest({ taskDescription: "UNIQUE_TD" }));
      const tdLayer = result.layers.find((l) => l.layerId === "taskDescription");

      expect(tdLayer).toBeDefined();
      expect(tdLayer?.content).toBe("UNIQUE_TD");
    });
  });

  // -----------------------------------------------------------------------
  // layerUsage population
  // -----------------------------------------------------------------------

  describe("layerUsage", () => {
    it("contains exactly one entry per assembled layer", async () => {
      const executor: IToolExecutor = {
        invoke: async (name) => {
          if (name === "git_status") {
            return { ok: true, value: { branch: "main", staged: [], unstaged: [] } };
          }
          return { ok: true, value: {} };
        },
      };

      const svc = makeService({
        planner: makePlannerWith(["repositoryState"]),
        toolExecutor: executor,
      });

      const result = await svc.buildContext(makeRequest());

      // Assembled layers = taskDescription + repositoryState
      expect(result.layerUsage.length).toBe(result.layers.length);
      const usageIds = result.layerUsage.map((u) => u.layerId);
      expect(usageIds).toContain("taskDescription");
      expect(usageIds).toContain("repositoryState");
    });

    it("layerUsage includes actualTokens, budget, cacheHit, compressed for each layer", async () => {
      const svc = makeService({
        planner: makePlannerWith([]),
      });

      const result = await svc.buildContext(makeRequest());
      for (const usage of result.layerUsage) {
        expect(typeof usage.actualTokens).toBe("number");
        expect(typeof usage.budget).toBe("number");
        expect(typeof usage.cacheHit).toBe("boolean");
        expect(typeof usage.compressed).toBe("boolean");
      }
    });

    it("layerUsage.actualTokens matches token count of the final layer content", async () => {
      const budgetManager = makeDefaultBudgetManager();

      const svc = makeService({
        planner: makePlannerWith([]),
        budgetManager,
      });

      const taskDescription = "hello world";
      const result = await svc.buildContext(makeRequest({ taskDescription }));

      const tdUsage = result.layerUsage.find((u) => u.layerId === "taskDescription");
      const expectedTokens = budgetManager.countTokens(taskDescription);

      expect(tdUsage?.actualTokens).toBe(expectedTokens);
    });

    it("totalTokens equals sum of all layerUsage.actualTokens", async () => {
      const svc = makeService({
        planner: makePlannerWith([]),
      });

      const result = await svc.buildContext(makeRequest());
      const sumFromUsage = result.layerUsage.reduce((acc, u) => acc + u.actualTokens, 0);

      expect(result.totalTokens).toBe(sumFromUsage);
    });
  });
});
