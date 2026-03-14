import { describe, expect, it } from "bun:test";
import { ContextEngineService } from "../../../application/context/context-engine-service";
import type { ContextEngineServiceOptions } from "../../../application/context/context-engine-service";
import type {
  CachedEntry,
  CompressionResult,
  ContextBuildRequest,
  IContextCache,
  IContextPlanner,
  ILayerCompressor,
  ITokenBudgetManager,
  LayerBudgetMap,
  LayerId,
} from "../../../application/ports/context";
import type { MemoryPort, RankedMemoryEntry } from "../../../application/ports/memory";
import type { IToolExecutor } from "../../../application/tools/executor";
import { ContextAccumulator } from "../../../domain/context/context-accumulator";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeBudgetManager(): ITokenBudgetManager {
  return {
    countTokens: (text) => Math.ceil(text.length / 4),
    allocate: (): LayerBudgetMap => ({
      budgets: {
        systemInstructions: 100_000,
        taskDescription: 100_000,
        activeSpecification: 100_000,
        codeContext: 100_000,
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

function makeMemoryPortWithContent(description: string): MemoryPort {
  return makeMemoryPort([
    {
      relevanceScore: 0.9,
      sourceFile: "memory.md",
      entry: { title: "Entry", context: "ctx", description, date: "2026-03-13" },
    },
  ]);
}

/**
 * Build a tool executor whose read_file responses are keyed by path.
 * Falls back to `defaultContent` for unregistered paths.
 */
function makeMultiFileToolExecutor(
  pathContents: Record<string, string>,
  defaultContent = "// default file",
): IToolExecutor {
  return {
    invoke: async (name, args) => {
      if (name === "git_status") {
        return { ok: true, value: { branch: "main", staged: [], unstaged: [] } };
      }
      if (name === "read_file") {
        const path = (args as { path?: string }).path ?? "";
        return { ok: true, value: pathContents[path] ?? defaultContent };
      }
      return { ok: true, value: defaultContent };
    },
  };
}

function makeToolExecutor(readContent = "// code"): IToolExecutor {
  return makeMultiFileToolExecutor({}, readContent);
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

/** Service factory using the real ContextAccumulator for authentic isolation testing. */
function makeServiceWithRealAccumulator(opts: {
  planner?: IContextPlanner;
  toolExecutor?: IToolExecutor;
  memoryPort?: MemoryPort;
  options?: ContextEngineServiceOptions;
  maxExpansions?: number;
}) {
  const accumulator = new ContextAccumulator({
    maxExpansionsPerIteration: opts.maxExpansions ?? 100,
  });
  const service = new ContextEngineService(
    opts.memoryPort ?? makeMemoryPort(),
    opts.toolExecutor ?? makeToolExecutor(),
    opts.planner ?? makePlannerWith([]),
    makeBudgetManager(),
    makeIdentityCompressor(),
    accumulator,
    makeCache(),
    opts.options ?? { workspaceRoot: "/workspace" },
  );
  return { service, accumulator };
}

function makeRequest(
  phaseId: string,
  taskId: string,
  overrides: Partial<ContextBuildRequest> = {},
): ContextBuildRequest {
  return {
    sessionId: "session-1",
    phaseId,
    taskId,
    stepType: "Exploration",
    taskDescription: "Explore the codebase",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task 11.5: Phase and task isolation integration tests
// ---------------------------------------------------------------------------

describe("ContextEngineService — phase and task isolation integration (task 11.5)", () => {
  // -------------------------------------------------------------------------
  // 1. resetPhase clears expanded layer state — no leakage into next phase
  // -------------------------------------------------------------------------

  describe("resetPhase — no expanded content leaks into next phase", () => {
    it("expandContext after resetPhase has lower updatedTokenCount than before reset (fresh start)", async () => {
      const fileContent = "a".repeat(100); // 25 tokens
      const { service } = makeServiceWithRealAccumulator({
        toolExecutor: makeToolExecutor(fileContent),
      });

      // Phase 1: expand twice, accumulating tokens
      const r1 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/p1/a.ts",
        targetLayer: "codeContext",
      });
      const r2 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/p1/b.ts",
        targetLayer: "codeContext",
      });

      // After two expansions, tokens have grown
      expect(r2.updatedTokenCount).toBeGreaterThan(r1.updatedTokenCount);
      const phase1FinalTokens = r2.updatedTokenCount;

      // Reset phase
      service.resetPhase("phase-1");

      // Phase 2: single expansion — should start from empty (no carry-over)
      const r3 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-2",
        taskId: "task-2",
        resourceId: "/p2/a.ts",
        targetLayer: "codeContext",
      });

      expect(r3.ok).toBe(true);
      // Token count should be the single file's tokens, not the accumulated phase-1 total
      expect(r3.updatedTokenCount).toBeLessThan(phase1FinalTokens);
    });

    it("resetPhase resets the expansion counter so expansions can proceed in the new phase", async () => {
      const { service } = makeServiceWithRealAccumulator({
        toolExecutor: makeToolExecutor("// code"),
        maxExpansions: 1,
      });

      // Phase 1: use up the 1 allowed expansion
      const r1 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/p1/a.ts",
        targetLayer: "codeContext",
      });
      expect(r1.ok).toBe(true);

      // Second expansion in phase-1 is rejected
      const r2 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/p1/b.ts",
        targetLayer: "codeContext",
      });
      expect(r2.ok).toBe(false);

      // Reset phase 1
      service.resetPhase("phase-1");

      // Phase 2: expansion counter is reset — should succeed again
      const r3 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-2",
        taskId: "task-2",
        resourceId: "/p2/a.ts",
        targetLayer: "codeContext",
      });
      expect(r3.ok).toBe(true);
    });

    it("resetPhase clears accumulator entries for that phase — getEntries returns empty", async () => {
      const { service, accumulator } = makeServiceWithRealAccumulator({
        toolExecutor: makeToolExecutor("// code"),
      });

      // Accumulate an entry during phase-1
      await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/p1/a.ts",
        targetLayer: "codeContext",
      });

      // Verify entry exists
      expect(accumulator.getEntries("phase-1", "task-1").length).toBeGreaterThan(0);

      // Reset phase
      service.resetPhase("phase-1");

      // Entries should be gone
      expect(accumulator.getEntries("phase-1", "task-1").length).toBe(0);
    });

    it("buildContext after resetPhase assembles fresh layers without phase-1 data", async () => {
      const { service } = makeServiceWithRealAccumulator({
        planner: makePlannerWith(["codeContext"], "/workspace/src/main.ts"),
        toolExecutor: makeToolExecutor("// fresh code"),
      });

      // Phase 1: build and expand
      await service.buildContext(makeRequest("phase-1", "task-1"));
      await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/p1/extra.ts",
        targetLayer: "codeContext",
      });

      // Reset
      service.resetPhase("phase-1");

      // Phase 2: fresh build
      const result2 = await service.buildContext(makeRequest("phase-2", "task-2"));

      expect(result2).toBeDefined();
      expect(result2.layers.some((l) => l.layerId === "taskDescription")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Two sequential phases end-to-end — zero cross-phase leakage
  // -------------------------------------------------------------------------

  describe("two sequential phases — zero cross-phase leakage", () => {
    it("phase-1 tool results do not appear in phase-2 buildContext", async () => {
      const { service } = makeServiceWithRealAccumulator({
        planner: makePlannerWith(["toolResults"]),
      });

      // Phase 1 has tool results
      const result1 = await service.buildContext(
        makeRequest("phase-1", "task-1", {
          stepType: "Validation",
          previousToolResults: [{ toolName: "test_runner", content: "PHASE1_TOOL_OUTPUT" }],
        }),
      );
      const phase1HasToolResults = result1.layers.some((l) => l.layerId === "toolResults");
      expect(phase1HasToolResults).toBe(true);

      // Reset before phase 2
      service.resetPhase("phase-1");

      // Phase 2 has NO tool results in the request
      const result2 = await service.buildContext(
        makeRequest("phase-2", "task-2", {
          stepType: "Validation",
          // No previousToolResults
        }),
      );

      const phase2LayerIds = result2.layers.map((l) => l.layerId);
      expect(phase2LayerIds).not.toContain("toolResults");
    });

    it("phase-2 taskDescription is not contaminated by phase-1 content", async () => {
      const { service } = makeServiceWithRealAccumulator({
        planner: makePlannerWith([]),
      });

      const phase1Task = "Implement the auth module for phase one";
      const phase2Task = "Write tests for the payment module in phase two";

      await service.buildContext(makeRequest("phase-1", "task-1", { taskDescription: phase1Task }));

      service.resetPhase("phase-1");

      const result2 = await service.buildContext(makeRequest("phase-2", "task-2", { taskDescription: phase2Task }));

      const taskLayer = result2.layers.find((l) => l.layerId === "taskDescription");
      expect(taskLayer?.content).toBe(phase2Task);
      expect(taskLayer?.content).not.toContain(phase1Task);
    });

    it("phase-2 expansion starts from empty — no phase-1 expansion content carries over", async () => {
      const phase1Content = "X".repeat(100); // 25 tokens
      const phase2Content = "Y".repeat(40); // 10 tokens

      const { service } = makeServiceWithRealAccumulator({
        toolExecutor: makeMultiFileToolExecutor({
          "/p1/file.ts": phase1Content,
          "/p2/file.ts": phase2Content,
        }),
      });

      // Phase 1: expand codeContext with 100 chars
      const r1 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/p1/file.ts",
        targetLayer: "codeContext",
      });
      const phase1Tokens = r1.updatedTokenCount; // ~25

      // Reset before phase 2
      service.resetPhase("phase-1");

      // Phase 2: expand codeContext with 40 chars — should NOT include phase-1's 100 chars
      const r2 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-2",
        taskId: "task-2",
        resourceId: "/p2/file.ts",
        targetLayer: "codeContext",
      });

      expect(r2.ok).toBe(true);
      // Phase-2 token count should reflect only phase-2 content
      expect(r2.updatedTokenCount).toBeLessThan(phase1Tokens);
    });

    it("accumulator entries from phase-1 are not visible in phase-2 scope", async () => {
      const { service, accumulator } = makeServiceWithRealAccumulator({
        toolExecutor: makeToolExecutor("// code"),
      });

      // Phase 1 expansion
      await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/a.ts",
        targetLayer: "codeContext",
      });
      expect(accumulator.getEntries("phase-1", "task-1").length).toBeGreaterThan(0);

      // Reset
      service.resetPhase("phase-1");

      // Phase 2 expansion
      await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-2",
        taskId: "task-2",
        resourceId: "/b.ts",
        targetLayer: "codeContext",
      });

      // Phase-1 entries are gone; phase-2 entries are present
      expect(accumulator.getEntries("phase-1", "task-1").length).toBe(0);
      expect(accumulator.getEntries("phase-2", "task-2").length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. resetTask clears accumulated context for completed task
  // -------------------------------------------------------------------------

  describe("resetTask — accumulated context cleared for completed task", () => {
    it("resetTask resets expansion counter so new task can expand again", async () => {
      const { service } = makeServiceWithRealAccumulator({
        toolExecutor: makeToolExecutor("// code"),
        maxExpansions: 1,
      });

      // Task 1: use up the expansion limit
      const r1 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/a.ts",
        targetLayer: "codeContext",
      });
      expect(r1.ok).toBe(true);

      const r2 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/b.ts",
        targetLayer: "codeContext",
      });
      expect(r2.ok).toBe(false);

      // Reset task
      service.resetTask("task-1");

      // Task 2: expansion counter reset — should succeed
      const r3 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-2",
        resourceId: "/c.ts",
        targetLayer: "codeContext",
      });
      expect(r3.ok).toBe(true);
    });

    it("resetTask clears accumulator entries for that task", async () => {
      const { service, accumulator } = makeServiceWithRealAccumulator({
        toolExecutor: makeToolExecutor("// code"),
      });

      await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/a.ts",
        targetLayer: "codeContext",
      });
      expect(accumulator.getEntries("phase-1", "task-1").length).toBeGreaterThan(0);

      service.resetTask("task-1");

      expect(accumulator.getEntries("phase-1", "task-1").length).toBe(0);
    });

    it("resetTask clears currentLayers so next expandContext for new task starts fresh", async () => {
      const task1Content = "T".repeat(100); // 25 tokens
      const task2Content = "U".repeat(20); // 5 tokens

      const { service } = makeServiceWithRealAccumulator({
        toolExecutor: makeMultiFileToolExecutor({
          "/t1.ts": task1Content,
          "/t2.ts": task2Content,
        }),
      });

      // Task 1: expand to 25 tokens
      const r1 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/t1.ts",
        targetLayer: "codeContext",
      });
      expect(r1.updatedTokenCount).toBe(25);

      // Reset task-1
      service.resetTask("task-1");

      // Task 2: should start fresh — only task-2 content, not cumulative
      const r2 = await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-2",
        resourceId: "/t2.ts",
        targetLayer: "codeContext",
      });
      expect(r2.ok).toBe(true);
      // Token count for task-2 = just its content, not task-1 + task-2
      expect(r2.updatedTokenCount).toBe(5);
    });

    it("buildContext after resetTask assembles fresh layers with new taskDescription", async () => {
      const { service } = makeServiceWithRealAccumulator({
        planner: makePlannerWith([]),
      });

      const task1Description = "Complete task one with all requirements";
      const task2Description = "Complete task two independently";

      await service.buildContext(makeRequest("phase-1", "task-1", { taskDescription: task1Description }));
      service.resetTask("task-1");

      const result2 = await service.buildContext(
        makeRequest("phase-1", "task-2", { taskDescription: task2Description }),
      );

      const taskLayer = result2.layers.find((l) => l.layerId === "taskDescription");
      expect(taskLayer?.content).toBe(task2Description);
      expect(taskLayer?.content).not.toContain(task1Description);
    });

    it("task-2 entries do not bleed into task-1 scope after resetTask", async () => {
      const { service, accumulator } = makeServiceWithRealAccumulator({
        toolExecutor: makeToolExecutor("// code"),
      });

      // Task 1 expansion
      await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-1",
        resourceId: "/a.ts",
        targetLayer: "codeContext",
      });

      service.resetTask("task-1");

      // Task 2 expansion under same phase
      await service.expandContext({
        sessionId: "session-1",
        phaseId: "phase-1",
        taskId: "task-2",
        resourceId: "/b.ts",
        targetLayer: "codeContext",
      });

      // Task-1 entries cleared; task-2 has its own
      expect(accumulator.getEntries("phase-1", "task-1").length).toBe(0);
      expect(accumulator.getEntries("phase-1", "task-2").length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Both reset methods never throw
  // -------------------------------------------------------------------------

  describe("reset methods are safe to call", () => {
    it("resetPhase does not throw even when no phase data exists", () => {
      const { service } = makeServiceWithRealAccumulator({});
      expect(() => service.resetPhase("nonexistent-phase")).not.toThrow();
    });

    it("resetTask does not throw even when no task data exists", () => {
      const { service } = makeServiceWithRealAccumulator({});
      expect(() => service.resetTask("nonexistent-task")).not.toThrow();
    });

    it("resetPhase followed by another resetPhase for the same id does not throw", () => {
      const { service } = makeServiceWithRealAccumulator({});
      expect(() => {
        service.resetPhase("phase-1");
        service.resetPhase("phase-1");
      }).not.toThrow();
    });

    it("resetTask followed by another resetTask for the same id does not throw", () => {
      const { service } = makeServiceWithRealAccumulator({});
      expect(() => {
        service.resetTask("task-1");
        service.resetTask("task-1");
      }).not.toThrow();
    });
  });
});
