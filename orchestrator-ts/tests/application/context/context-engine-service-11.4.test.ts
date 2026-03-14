import { ContextEngineService } from "@/application/context/context-engine-service";
import type { ContextEngineServiceOptions } from "@/application/context/context-engine-service";
import type {
  AccumulatedEntry,
  CachedEntry,
  CompressionResult,
  ContextBuildRequest,
  ExpansionEvent,
  ExpansionRequest,
  IContextAccumulator,
  IContextCache,
  IContextPlanner,
  ILayerCompressor,
  ITokenBudgetManager,
  LayerBudgetMap,
  LayerId,
} from "@/application/ports/context";
import type { MemoryPort, RankedMemoryEntry } from "@/application/ports/memory";
import type { IToolExecutor } from "@/application/tools/executor";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeBudgetManager(codeContextBudget = 100_000): ITokenBudgetManager {
  return {
    countTokens: (text) => Math.ceil(text.length / 4),
    allocate: (): LayerBudgetMap => ({
      budgets: {
        systemInstructions: 100_000,
        taskDescription: 100_000,
        activeSpecification: 100_000,
        codeContext: codeContextBudget,
        repositoryState: 100_000,
        memoryRetrieval: 100_000,
        toolResults: 100_000,
      },
      totalBudget: 700_000,
    }),
    checkBudget: (content, budget) => {
      const tokensUsed = Math.ceil(content.length / 4);
      return { tokensUsed, overBy: Math.max(0, tokensUsed - budget) };
    },
    checkTotal: (_counts, _totalBudget) => 0,
  };
}

function makeIdentityCompressor(): ILayerCompressor {
  return {
    compress: (_layerId, content, _budget, tokenCounter): CompressionResult => ({
      compressed: content,
      tokenCount: tokenCounter(content),
      technique: "truncation",
      originalTokenCount: tokenCounter(content),
    }),
  };
}

function makeTrackingCompressor(): {
  compressor: ILayerCompressor;
  compressedLayerIds: string[];
} {
  const compressedLayerIds: string[] = [];
  const compressor: ILayerCompressor = {
    compress: (layerId, _content, _budget, tokenCounter): CompressionResult => {
      compressedLayerIds.push(layerId);
      return {
        compressed: "COMPRESSED",
        tokenCount: tokenCounter("COMPRESSED"),
        technique: "truncation",
        originalTokenCount: 9999,
      };
    },
  };
  return { compressor, compressedLayerIds };
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

function makeMemoryPort(entries: RankedMemoryEntry[] = []): MemoryPort {
  return {
    shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
    query: async () => ({ entries }),
    append: async () => ({ ok: true, action: "appended" }),
    update: async () => ({ ok: true, action: "updated" }),
    writeFailure: async () => ({ ok: true, action: "appended" }),
    getFailures: async () => [],
  };
}

function makeMemoryPortWithContent(content: string): MemoryPort {
  return {
    shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
    query: async () => ({
      entries: [
        {
          relevanceScore: 0.9,
          sourceFile: "memory.md",
          entry: { title: "Memory", context: "ctx", description: content, date: "2026-03-13" },
        },
      ],
    }),
    append: async () => ({ ok: true, action: "appended" }),
    update: async () => ({ ok: true, action: "updated" }),
    writeFailure: async () => ({ ok: true, action: "appended" }),
    getFailures: async () => [],
  };
}

function makeToolExecutor(readFileContent = "// file content"): IToolExecutor {
  return {
    invoke: async (name) => {
      if (name === "git_status") {
        return { ok: true, value: { branch: "main", staged: [], unstaged: [] } };
      }
      if (name === "read_file") {
        return { ok: true, value: readFileContent };
      }
      if (name === "search_files") {
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
      // All other tool calls fail
      return { ok: false, error: { type: "runtime" as const, message: "tool failure" } };
    },
  };
}

/** Accumulator with a configurable expansion limit. */
function makeLimitedAccumulator(maxExpansions: number): IContextAccumulator {
  let count = 0;
  const events: ExpansionEvent[] = [];
  const entries: AccumulatedEntry[] = [];
  return {
    accumulate: (e) => entries.push(e),
    getEntries: () => entries,
    recordExpansion: (event) => {
      if (count >= maxExpansions) {
        return { ok: false, errorReason: `Expansion limit of ${maxExpansions} reached.` };
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

function makeUnlimitedAccumulator(): IContextAccumulator {
  return makeLimitedAccumulator(Number.MAX_SAFE_INTEGER);
}

function makePlannerWith(layersToRetrieve: LayerId[], codePath?: string): IContextPlanner {
  return {
    plan: (_stepType, taskDescription) => ({
      layersToRetrieve,
      rationale: `stepType:test taskExcerpt:${taskDescription.slice(0, 100)}`,
      ...(codePath ? { codeContextQuery: { paths: [codePath] } } : {}),
    }),
  };
}

function makeService(opts: {
  planner?: IContextPlanner;
  budgetManager?: ITokenBudgetManager;
  compressor?: ILayerCompressor;
  accumulator?: IContextAccumulator;
  toolExecutor?: IToolExecutor;
  memoryPort?: MemoryPort;
  options?: ContextEngineServiceOptions;
} = {}) {
  return new ContextEngineService(
    opts.memoryPort ?? makeMemoryPort(),
    opts.toolExecutor ?? makeToolExecutor(),
    opts.planner ?? makePlannerWith([]),
    opts.budgetManager ?? makeBudgetManager(),
    opts.compressor ?? makeIdentityCompressor(),
    opts.accumulator ?? makeUnlimitedAccumulator(),
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
    taskDescription: "Explore the codebase",
    ...overrides,
  };
}

function makeExpansionRequest(
  overrides: Partial<ExpansionRequest> = {},
): ExpansionRequest {
  return {
    sessionId: "session-1",
    phaseId: "phase-1",
    taskId: "task-1",
    resourceId: "/workspace/src/main.ts",
    targetLayer: "codeContext",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task 11.4: expandContext integration tests
// ---------------------------------------------------------------------------

describe("ContextEngineService — expandContext integration (task 11.4)", () => {
  // -------------------------------------------------------------------------
  // 1. expandContext appends content to the correct layer and re-runs budget check
  // -------------------------------------------------------------------------

  describe("content appended to correct layer and budget re-checked", () => {
    it("returns ok: true when expanding an existing codeContext layer after buildContext", async () => {
      const fileContent = "export function foo() {}";
      const service = makeService({
        planner: makePlannerWith(["codeContext"], "/workspace/src/main.ts"),
        toolExecutor: makeToolExecutor(fileContent),
      });

      // Establish layer state via buildContext
      await service.buildContext(makeRequest());

      const result = await service.expandContext(makeExpansionRequest({
        targetLayer: "codeContext",
        resourceId: "/workspace/src/extra.ts",
      }));

      expect(result.ok).toBe(true);
    });

    it("updatedTokenCount reflects appended content (greater than before expansion)", async () => {
      const fileContent = "export const x = 1;";
      const service = makeService({
        toolExecutor: makeToolExecutor(fileContent),
      });

      const r1 = await service.expandContext(makeExpansionRequest({
        targetLayer: "codeContext",
        resourceId: "/workspace/src/a.ts",
      }));

      const r2 = await service.expandContext(makeExpansionRequest({
        targetLayer: "codeContext",
        resourceId: "/workspace/src/b.ts",
      }));

      expect(r1.ok).toBe(true);
      expect(r2.updatedTokenCount).toBeGreaterThan(r1.updatedTokenCount);
    });

    it("updatedTokenCount is non-zero after first expansion", async () => {
      const service = makeService({
        toolExecutor: makeToolExecutor("export const x = 42;"),
      });

      const result = await service.expandContext(makeExpansionRequest({
        targetLayer: "codeContext",
        resourceId: "/workspace/src/x.ts",
      }));

      expect(result.ok).toBe(true);
      expect(result.updatedTokenCount).toBeGreaterThan(0);
    });

    it("re-runs budget check: triggers compression when expanded layer exceeds budget", async () => {
      const largeContent = "x".repeat(100); // 25 tokens >> budget=1
      const { compressor, compressedLayerIds } = makeTrackingCompressor();

      const service = makeService({
        budgetManager: makeBudgetManager(1), // codeContext budget = 1 token
        compressor,
        toolExecutor: makeToolExecutor(largeContent),
      });

      const result = await service.expandContext(makeExpansionRequest({
        targetLayer: "codeContext",
        resourceId: "/workspace/src/large.ts",
      }));

      expect(result.ok).toBe(true);
      expect(compressedLayerIds).toContain("codeContext");
    });

    it("does NOT trigger compression when expanded layer is within budget", async () => {
      const smallContent = "x"; // 1 token, within budget=100
      const { compressor, compressedLayerIds } = makeTrackingCompressor();

      const service = makeService({
        budgetManager: makeBudgetManager(100),
        compressor,
        toolExecutor: makeToolExecutor(smallContent),
      });

      const result = await service.expandContext(makeExpansionRequest({
        targetLayer: "codeContext",
        resourceId: "/workspace/src/small.ts",
      }));

      expect(result.ok).toBe(true);
      expect(compressedLayerIds).not.toContain("codeContext");
    });

    it("can expand activeSpecification layer and returns ok: true", async () => {
      const specContent = "# Feature spec\n\n- AC1: must do X\n- AC2: must not Y";
      const service = makeService({
        toolExecutor: makeToolExecutor(specContent),
      });

      const result = await service.expandContext(makeExpansionRequest({
        targetLayer: "activeSpecification",
        resourceId: "/workspace/.kiro/specs/feature/requirements.md",
      }));

      expect(result.ok).toBe(true);
      expect(result.updatedTokenCount).toBeGreaterThan(0);
    });

    it("can expand memoryRetrieval layer via memory port and returns ok: true", async () => {
      const service = makeService({
        memoryPort: makeMemoryPortWithContent("relevant past decision about auth"),
      });

      const result = await service.expandContext(makeExpansionRequest({
        targetLayer: "memoryRetrieval",
        resourceId: "query: auth decisions",
      }));

      expect(result.ok).toBe(true);
      expect(result.updatedTokenCount).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. expandContext returns { ok: false } for non-expandable layers
  // -------------------------------------------------------------------------

  describe("non-expandable targetLayer returns ok: false", () => {
    it("returns ok: false when targetLayer is 'systemInstructions'", async () => {
      const service = makeService();

      const result = await service.expandContext(makeExpansionRequest({
        targetLayer: "systemInstructions" as "codeContext",
      }));

      expect(result.ok).toBe(false);
    });

    it("includes a descriptive errorReason when targetLayer is 'systemInstructions'", async () => {
      const service = makeService();

      const result = await service.expandContext(makeExpansionRequest({
        targetLayer: "systemInstructions" as "codeContext",
      }));

      expect(result.errorReason).toBeDefined();
      expect(typeof result.errorReason).toBe("string");
      expect((result.errorReason ?? "").length).toBeGreaterThan(0);
    });

    it("returns ok: false when targetLayer is 'taskDescription'", async () => {
      const service = makeService();

      const result = await service.expandContext(makeExpansionRequest({
        targetLayer: "taskDescription" as "codeContext",
      }));

      expect(result.ok).toBe(false);
    });

    it("returns ok: false when targetLayer is 'repositoryState'", async () => {
      const service = makeService();

      const result = await service.expandContext(makeExpansionRequest({
        targetLayer: "repositoryState" as "codeContext",
      }));

      expect(result.ok).toBe(false);
    });

    it("returns ok: false when targetLayer is 'toolResults'", async () => {
      const service = makeService();

      const result = await service.expandContext(makeExpansionRequest({
        targetLayer: "toolResults" as "codeContext",
      }));

      expect(result.ok).toBe(false);
    });

    it("never throws for any invalid targetLayer — always resolves", async () => {
      const service = makeService();

      await expect(
        service.expandContext(makeExpansionRequest({
          targetLayer: "systemInstructions" as "codeContext",
        })),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 3. expandContext returns { ok: false } once expansion limit is reached
  // -------------------------------------------------------------------------

  describe("expansion limit enforcement", () => {
    it("returns ok: false immediately when maxExpansions is 0", async () => {
      const service = makeService({
        accumulator: makeLimitedAccumulator(0),
        toolExecutor: makeToolExecutor("// code"),
      });

      const result = await service.expandContext(makeExpansionRequest());

      expect(result.ok).toBe(false);
    });

    it("errorReason is defined when expansion limit is reached", async () => {
      const service = makeService({
        accumulator: makeLimitedAccumulator(0),
        toolExecutor: makeToolExecutor("// code"),
      });

      const result = await service.expandContext(makeExpansionRequest());

      expect(result.errorReason).toBeDefined();
      expect((result.errorReason ?? "").length).toBeGreaterThan(0);
    });

    it("allows exactly maxExpansions successful calls then rejects the next", async () => {
      const service = makeService({
        accumulator: makeLimitedAccumulator(2),
        toolExecutor: makeToolExecutor("// code"),
      });

      const r1 = await service.expandContext(makeExpansionRequest({ resourceId: "/a.ts" }));
      const r2 = await service.expandContext(makeExpansionRequest({ resourceId: "/b.ts" }));
      const r3 = await service.expandContext(makeExpansionRequest({ resourceId: "/c.ts" }));

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(false);
    });

    it("limit is enforced across different resourceIds for the same targetLayer", async () => {
      const service = makeService({
        accumulator: makeLimitedAccumulator(1),
        toolExecutor: makeToolExecutor("// code"),
      });

      const r1 = await service.expandContext(makeExpansionRequest({
        targetLayer: "codeContext",
        resourceId: "/src/a.ts",
      }));
      const r2 = await service.expandContext(makeExpansionRequest({
        targetLayer: "codeContext",
        resourceId: "/src/b.ts",
      }));

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(false);
    });

    it("limit applies across different expandable layers", async () => {
      const memPort = makeMemoryPortWithContent("past decision");
      const service = makeService({
        accumulator: makeLimitedAccumulator(1),
        toolExecutor: makeToolExecutor("// code"),
        memoryPort: memPort,
      });

      // First expansion on codeContext succeeds
      const r1 = await service.expandContext(makeExpansionRequest({
        targetLayer: "codeContext",
        resourceId: "/src/a.ts",
      }));

      // Second expansion on memoryRetrieval is rejected (limit already reached)
      const r2 = await service.expandContext(makeExpansionRequest({
        targetLayer: "memoryRetrieval",
        resourceId: "query: auth",
      }));

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(false);
    });

    it("returns ok: false (not throw) when tool call fails during expansion", async () => {
      const service = makeService({
        accumulator: makeUnlimitedAccumulator(),
        toolExecutor: makeFailingToolExecutor(),
      });

      await expect(
        service.expandContext(makeExpansionRequest({
          targetLayer: "codeContext",
          resourceId: "/nonexistent.ts",
        })),
      ).resolves.toMatchObject({ ok: false });
    });
  });

  // -------------------------------------------------------------------------
  // 4. Integration: buildContext followed by expandContext
  // -------------------------------------------------------------------------

  describe("buildContext then expandContext integration flow", () => {
    it("expandContext after buildContext returns ok: true on valid expandable layer", async () => {
      const service = makeService({
        planner: makePlannerWith(["codeContext"], "/workspace/src/main.ts"),
        toolExecutor: makeToolExecutor("// initial code"),
      });

      await service.buildContext(makeRequest());

      const result = await service.expandContext(makeExpansionRequest({
        targetLayer: "codeContext",
        resourceId: "/workspace/src/extra.ts",
      }));

      expect(result.ok).toBe(true);
    });

    it("second expandContext call returns higher updatedTokenCount than first", async () => {
      const service = makeService({
        toolExecutor: makeToolExecutor("export const a = 1;"),
      });

      const r1 = await service.expandContext(makeExpansionRequest({ resourceId: "/a.ts" }));
      const r2 = await service.expandContext(makeExpansionRequest({ resourceId: "/b.ts" }));

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r2.updatedTokenCount).toBeGreaterThan(r1.updatedTokenCount);
    });

    it("resetTask clears accumulated state so expansion limit resets", async () => {
      const accumulator = makeLimitedAccumulator(1);
      const service = makeService({
        accumulator,
        toolExecutor: makeToolExecutor("// code"),
      });

      // Use up the limit
      const r1 = await service.expandContext(makeExpansionRequest({ resourceId: "/a.ts" }));
      const r2 = await service.expandContext(makeExpansionRequest({ resourceId: "/b.ts" }));
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(false);

      // Reset task clears the counter
      service.resetTask("task-1");

      // Should succeed again
      const r3 = await service.expandContext(makeExpansionRequest({ resourceId: "/c.ts" }));
      expect(r3.ok).toBe(true);
    });
  });
});
