/**
 * Type-shape tests for application/ports/context.ts
 * Verifies all exports exist with the correct signatures.
 */
import { describe, expect, it } from "bun:test";
import type {
  AccumulatedEntry,
  CachedEntry,
  CacheStats,
  CompressionResult,
  CompressionTechnique,
  ContextAccumulatorConfig,
  ContextAssemblyLog,
  ContextAssemblyResult,
  ContextBuildRequest,
  ExpansionEvent,
  ExpansionRequest,
  ExpansionResult,
  IContextAccumulator,
  IContextCache,
  IContextEngine,
  IContextPlanner,
  ILayerCompressor,
  ITokenBudgetManager,
  LayerBudgetConfig,
  LayerBudgetMap,
  LayerId,
  LayerTokenUsage,
  PlannerDecision,
  StepType,
  TokenBudgetConfig,
  ToolResultEntry,
} from "../../../src/application/ports/context";

describe("application/ports/context type shapes", () => {
  it("LayerId accepts all seven layer values", () => {
    const ids: LayerId[] = [
      "systemInstructions",
      "taskDescription",
      "activeSpecification",
      "codeContext",
      "repositoryState",
      "memoryRetrieval",
      "toolResults",
    ];
    expect(ids.length).toBe(7);
  });

  it("StepType accepts all three step types", () => {
    const steps: StepType[] = ["Exploration", "Modification", "Validation"];
    expect(steps.length).toBe(3);
  });

  it("CompressionTechnique accepts all four values", () => {
    const techniques: CompressionTechnique[] = [
      "spec_extraction",
      "code_skeleton",
      "memory_score_filter",
      "truncation",
    ];
    expect(techniques.length).toBe(4);
  });

  it("ContextBuildRequest can be constructed with required fields", () => {
    const req: ContextBuildRequest = {
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      stepType: "Exploration",
      taskDescription: "implement feature X",
    };
    expect(req.sessionId).toBe("s1");
    expect(req.stepType).toBe("Exploration");
  });

  it("ContextBuildRequest accepts optional fields", () => {
    const toolResult: ToolResultEntry = { toolName: "git_status", content: "clean" };
    const req: ContextBuildRequest = {
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      stepType: "Modification",
      taskDescription: "fix bug",
      previousToolResults: [toolResult],
      modelTokenLimit: 128000,
    };
    expect(req.modelTokenLimit).toBe(128000);
    expect(req.previousToolResults?.length).toBe(1);
  });

  it("LayerTokenUsage has all required fields", () => {
    const usage: LayerTokenUsage = {
      layerId: "codeContext",
      actualTokens: 1200,
      budget: 4000,
      cacheHit: false,
      compressed: true,
    };
    expect(usage.compressed).toBe(true);
  });

  it("ContextAssemblyResult has all required fields including layers array", () => {
    const result: ContextAssemblyResult = {
      content: "=== [LAYER: systemInstructions] ===\nhello",
      layers: [{ layerId: "systemInstructions", content: "hello" }],
      totalTokens: 5,
      layerUsage: [],
      plannerDecision: {
        layersToRetrieve: ["systemInstructions"],
        rationale: "stepType:Exploration taskExcerpt:test",
      },
      degraded: false,
      omittedLayers: [],
    };
    expect(result.layers.length).toBe(1);
    expect(result.degraded).toBe(false);
  });

  it("ExpansionRequest restricts targetLayer to expandable layers", () => {
    const req: ExpansionRequest = {
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      resourceId: "src/foo.ts",
      targetLayer: "codeContext",
    };
    expect(req.targetLayer).toBe("codeContext");
  });

  it("ExpansionResult has ok and optional errorReason", () => {
    const ok: ExpansionResult = { ok: true, updatedTokenCount: 150 };
    const fail: ExpansionResult = { ok: false, updatedTokenCount: 0, errorReason: "limit reached" };
    expect(ok.ok).toBe(true);
    expect(fail.errorReason).toBe("limit reached");
  });

  it("PlannerDecision has required layersToRetrieve and rationale", () => {
    const decision: PlannerDecision = {
      layersToRetrieve: ["codeContext", "repositoryState"],
      codeContextQuery: { paths: ["src/foo.ts"] },
      memoryQuery: { text: "implement feature", topN: 5 },
      rationale: "stepType:Exploration taskExcerpt:implement",
    };
    expect(decision.layersToRetrieve.length).toBe(2);
  });

  it("LayerBudgetConfig has all seven layer budget fields", () => {
    const config: LayerBudgetConfig = {
      systemInstructions: 1000,
      taskDescription: 500,
      activeSpecification: 2000,
      codeContext: 4000,
      repositoryState: 500,
      memoryRetrieval: 1500,
      toolResults: 2000,
    };
    expect(config.codeContext).toBe(4000);
  });

  it("TokenBudgetConfig has layerBudgets, modelTokenLimit, safetyBufferFraction", () => {
    const config: TokenBudgetConfig = {
      layerBudgets: {
        systemInstructions: 1000,
        taskDescription: 500,
        activeSpecification: 2000,
        codeContext: 4000,
        repositoryState: 500,
        memoryRetrieval: 1500,
        toolResults: 2000,
      },
      modelTokenLimit: 128000,
      safetyBufferFraction: 0.05,
    };
    expect(config.safetyBufferFraction).toBe(0.05);
  });

  it("LayerBudgetMap has budgets record and totalBudget", () => {
    const map: LayerBudgetMap = {
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
    };
    expect(map.totalBudget).toBe(11500);
  });

  it("CompressionResult has all required fields", () => {
    const result: CompressionResult = {
      compressed: "export function foo(): void",
      tokenCount: 8,
      technique: "code_skeleton",
      originalTokenCount: 500,
    };
    expect(result.technique).toBe("code_skeleton");
  });

  it("AccumulatedEntry has phase and task isolation fields", () => {
    const entry: AccumulatedEntry = {
      layerId: "memoryRetrieval",
      content: "some memory",
      phaseId: "phase-1",
      taskId: "task-1",
    };
    expect(entry.phaseId).toBe("phase-1");
  });

  it("ExpansionEvent has all required fields", () => {
    const event: ExpansionEvent = {
      resourceId: "src/foo.ts",
      targetLayer: "codeContext",
      addedTokenCount: 50,
      newCumulativeTokenCount: 200,
      timestamp: new Date().toISOString(),
    };
    expect(event.addedTokenCount).toBe(50);
  });

  it("ContextAccumulatorConfig has maxExpansionsPerIteration", () => {
    const config: ContextAccumulatorConfig = { maxExpansionsPerIteration: 10 };
    expect(config.maxExpansionsPerIteration).toBe(10);
  });

  it("CachedEntry has filePath, content, tokenCount, mtime, cachedAt", () => {
    const entry: CachedEntry = {
      filePath: "/project/.kiro/steering/tech.md",
      content: "# Tech",
      tokenCount: 3,
      mtime: Date.now(),
      cachedAt: new Date().toISOString(),
    };
    expect(entry.filePath).toBe("/project/.kiro/steering/tech.md");
  });

  it("CacheStats has hits, misses, entries", () => {
    const stats: CacheStats = { hits: 10, misses: 2, entries: 5 };
    expect(stats.hits).toBe(10);
  });

  it("ContextAssemblyLog has all observability metadata fields", () => {
    const log: ContextAssemblyLog = {
      sessionId: "s1",
      phaseId: "p1",
      taskId: "t1",
      stepType: "Exploration",
      layersAssembled: ["systemInstructions", "taskDescription"],
      layerTokenCounts: [
        { layerId: "systemInstructions", tokens: 100, budget: 1000 },
      ],
      cacheHits: ["systemInstructions"],
      cacheMisses: [],
      totalTokens: 100,
      compressed: [],
      omittedLayers: [],
      degraded: false,
      durationMs: 42,
    };
    expect(log.durationMs).toBe(42);
  });

  it("IContextEngine interface shape is structurally valid", () => {
    // Verify all four methods exist on a mock implementation
    const mock: IContextEngine = {
      buildContext: async (_req) => ({
        content: "",
        layers: [],
        totalTokens: 0,
        layerUsage: [],
        plannerDecision: { layersToRetrieve: [], rationale: "" },
        degraded: false,
        omittedLayers: [],
      }),
      expandContext: async (_req) => ({ ok: false, updatedTokenCount: 0 }),
      resetPhase: (_phaseId) => {},
      resetTask: (_taskId) => {},
    };
    expect(typeof mock.buildContext).toBe("function");
    expect(typeof mock.expandContext).toBe("function");
    expect(typeof mock.resetPhase).toBe("function");
    expect(typeof mock.resetTask).toBe("function");
  });

  it("IContextPlanner interface shape is structurally valid", () => {
    const mock: IContextPlanner = {
      plan: (_stepType, _taskDesc, _prevResults) => ({
        layersToRetrieve: [],
        rationale: "test",
      }),
    };
    expect(typeof mock.plan).toBe("function");
  });

  it("ITokenBudgetManager interface shape is structurally valid", () => {
    const mock: ITokenBudgetManager = {
      countTokens: (_text) => 0,
      allocate: (_config) => ({ budgets: {} as never, totalBudget: 0 }),
      checkBudget: (_content, _budget) => ({ tokensUsed: 0, overBy: 0 }),
      checkTotal: (_counts, _total) => 0,
    };
    expect(typeof mock.countTokens).toBe("function");
  });

  it("ILayerCompressor interface shape is structurally valid", () => {
    const mock: ILayerCompressor = {
      compress: (_layerId, content, _budget, _counter) => ({
        compressed: content,
        tokenCount: 0,
        technique: "truncation",
        originalTokenCount: 0,
      }),
    };
    expect(typeof mock.compress).toBe("function");
  });

  it("IContextAccumulator interface shape is structurally valid", () => {
    const mock: IContextAccumulator = {
      accumulate: (_entry) => {},
      getEntries: (_phaseId, _taskId) => [],
      recordExpansion: (_event) => ({ ok: true }),
      getExpansionEvents: () => [],
      resetPhase: (_phaseId) => {},
      resetTask: (_taskId) => {},
    };
    expect(typeof mock.accumulate).toBe("function");
    expect(typeof mock.getExpansionEvents).toBe("function");
  });

  it("IContextCache interface shape is structurally valid", () => {
    const mock: IContextCache = {
      get: (_filePath, _mtime) => null,
      set: (_entry) => {},
      invalidate: (_filePath) => {},
      stats: () => ({ hits: 0, misses: 0, entries: 0 }),
      clear: () => {},
    };
    expect(typeof mock.get).toBe("function");
    expect(typeof mock.clear).toBe("function");
  });
});
