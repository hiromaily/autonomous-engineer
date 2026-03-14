import { describe, expect, it } from "bun:test";
import { ContextEngineService } from "../../../src/application/context/context-engine-service";
import type {
  CachedEntry,
  ContextBuildRequest,
  IContextAccumulator,
  IContextCache,
  IContextPlanner,
  ILayerCompressor,
  ITokenBudgetManager,
  LayerBudgetMap,
  LayerId,
  PlannerDecision,
} from "../../../src/application/ports/context";
import type { MemoryPort, RankedMemoryEntry } from "../../../src/application/ports/memory";
import type { IToolExecutor } from "../../../src/application/tools/executor";
import type { ToolResult } from "../../../src/domain/tools/types";

// ---------------------------------------------------------------------------
// Helpers — minimal mocks
// ---------------------------------------------------------------------------

function makePlannerWith(layersToRetrieve: LayerId[], override: Partial<PlannerDecision> = {}): IContextPlanner {
  return {
    plan: () => ({
      layersToRetrieve,
      rationale: "stepType:Exploration taskExcerpt:test",
      codeContextQuery: { paths: [] },
      memoryQuery: { text: "test", topN: 5 },
      ...override,
    }),
  };
}

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
    checkTotal: () => 0,
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

function makeMemoryPort(
  querySpy?: (query: { text: string; topN?: number }) => Promise<{ entries: RankedMemoryEntry[] }>,
): MemoryPort {
  return {
    shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
    query: querySpy
      ? (q) => querySpy(q)
      : async () => ({ entries: [] }),
    append: async () => ({ ok: true, action: "appended" }),
    update: async () => ({ ok: true, action: "updated" }),
    writeFailure: async () => ({ ok: true, action: "appended" }),
    getFailures: async () => [],
  };
}

function makeToolExecutor(
  handler?: (name: string, input: unknown) => Promise<unknown>,
): IToolExecutor {
  return {
    invoke: (name, input, _ctx) =>
      (handler ? handler(name, input) : Promise.resolve({ ok: true, value: {} })) as Promise<ToolResult<unknown>>,
  };
}

function makeRequest(overrides: Partial<ContextBuildRequest> = {}): ContextBuildRequest {
  return {
    sessionId: "s1",
    phaseId: "p1",
    taskId: "t1",
    stepType: "Exploration",
    taskDescription: "Implement feature X",
    ...overrides,
  };
}

function makeService(opts: {
  planner: IContextPlanner;
  toolExecutor?: IToolExecutor;
  memoryPort?: MemoryPort;
}) {
  return new ContextEngineService(
    opts.memoryPort ?? makeMemoryPort(),
    opts.toolExecutor ?? makeToolExecutor(),
    opts.planner,
    makeBudgetManager(),
    makeCompressor(),
    makeAccumulator(),
    makeCache(),
    { workspaceRoot: "/workspace", steeringDocPaths: [] },
  );
}

// ---------------------------------------------------------------------------
// Task 8.2 — repository state, memory, code context, tool results helpers
// ---------------------------------------------------------------------------

describe("ContextEngineService (task 8.2)", () => {
  // -----------------------------------------------------------------------
  // populateRepositoryState
  // -----------------------------------------------------------------------

  describe("populateRepositoryState()", () => {
    it("includes repositoryState layer when git_status returns ok", async () => {
      const executor = makeToolExecutor(async (name) => {
        if (name === "git_status") {
          return {
            ok: true,
            value: { branch: "feature/abc", staged: ["src/a.ts"], unstaged: ["src/b.ts"] },
          };
        }
        return { ok: true, value: {} };
      });

      const svc = makeService({
        planner: makePlannerWith(["repositoryState"]),
        toolExecutor: executor,
      });

      const result = await svc.buildContext(makeRequest());
      const layer = result.layers.find((l) => l.layerId === "repositoryState");

      expect(layer).toBeDefined();
      expect(layer?.content).toContain("Branch: feature/abc");
      expect(layer?.content).toContain("Staged: src/a.ts");
      expect(layer?.content).toContain("Unstaged: src/b.ts");
    });

    it("formats content as 'Branch: <branch>\\nStaged: <files>\\nUnstaged: <files>'", async () => {
      const executor = makeToolExecutor(async (name) => {
        if (name === "git_status") {
          return {
            ok: true,
            value: { branch: "main", staged: [], unstaged: [] },
          };
        }
        return { ok: true, value: {} };
      });

      const svc = makeService({
        planner: makePlannerWith(["repositoryState"]),
        toolExecutor: executor,
      });

      const result = await svc.buildContext(makeRequest());
      const layer = result.layers.find((l) => l.layerId === "repositoryState");

      expect(layer?.content).toBe("Branch: main\nStaged: none\nUnstaged: none");
    });

    it("omits repositoryState layer and sets degraded=true when git_status returns ok=false", async () => {
      const executor = makeToolExecutor(async (name) => {
        if (name === "git_status") {
          return {
            ok: false,
            error: { type: "execution_error" as const, message: "not a git repo" },
          };
        }
        return { ok: true, value: {} };
      });

      const svc = makeService({
        planner: makePlannerWith(["repositoryState"]),
        toolExecutor: executor,
      });

      const result = await svc.buildContext(makeRequest());

      expect(result.omittedLayers).toContain("repositoryState");
      expect(result.degraded).toBe(true);
      expect(result.layers.find((l) => l.layerId === "repositoryState")).toBeUndefined();
    });

    it("omits repositoryState layer when git_status throws", async () => {
      const executor = makeToolExecutor(async (name) => {
        if (name === "git_status") throw new Error("unexpected error");
        return { ok: true, value: {} };
      });

      const svc = makeService({
        planner: makePlannerWith(["repositoryState"]),
        toolExecutor: executor,
      });

      const result = await svc.buildContext(makeRequest());

      expect(result.omittedLayers).toContain("repositoryState");
      expect(result.degraded).toBe(true);
    });

    it("skips repositoryState when not in layersToRetrieve", async () => {
      let gitCalled = false;
      const executor = makeToolExecutor(async (name) => {
        if (name === "git_status") gitCalled = true;
        return { ok: true, value: {} };
      });

      const svc = makeService({
        planner: makePlannerWith(["memoryRetrieval"]),
        toolExecutor: executor,
      });

      await svc.buildContext(makeRequest());
      expect(gitCalled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // populateMemoryRetrieval
  // -----------------------------------------------------------------------

  describe("populateMemoryRetrieval()", () => {
    it("includes memoryRetrieval layer formatted as JSON lines", async () => {
      const memoryPort = makeMemoryPort(async () => ({
        entries: [
          {
            entry: {
              title: "Pattern A",
              description: "Use pattern A for X",
              context: "ctx",
              date: "2026-01-01",
            },
            sourceFile: "coding_patterns",
            relevanceScore: 0.9,
          },
          {
            entry: {
              title: "Pattern B",
              description: "Use pattern B for Y",
              context: "ctx",
              date: "2026-01-02",
            },
            sourceFile: "coding_patterns",
            relevanceScore: 0.7,
          },
        ] as RankedMemoryEntry[],
      }));

      const svc = makeService({
        planner: makePlannerWith(["memoryRetrieval"]),
        memoryPort,
      });

      const result = await svc.buildContext(makeRequest({ taskDescription: "task desc" }));
      const layer = result.layers.find((l) => l.layerId === "memoryRetrieval");

      expect(layer).toBeDefined();
      const lines = layer?.content.split("\n");
      expect(lines.length).toBe(2);

      const first = JSON.parse(lines[0] ?? "{}") as { title: string; description: string; relevanceScore: number };
      expect(first.title).toBe("Pattern A");
      expect(first.relevanceScore).toBe(0.9);
    });

    it("passes taskDescription as query text with topN: 5", async () => {
      let capturedQuery: { text: string; topN?: number } | null = null;

      const memoryPort = makeMemoryPort(async (q) => {
        capturedQuery = q;
        return { entries: [] };
      });

      const svc = makeService({
        planner: makePlannerWith(["memoryRetrieval"]),
        memoryPort,
      });

      await svc.buildContext(makeRequest({ taskDescription: "my specific task" }));

      expect(capturedQuery).not.toBeNull();
      expect(capturedQuery?.text).toBe("my specific task");
      expect(capturedQuery?.topN).toBe(5);
    });

    it("returns '(no memory entries)' content when entries array is empty", async () => {
      const memoryPort = makeMemoryPort(async () => ({ entries: [] }));

      const svc = makeService({
        planner: makePlannerWith(["memoryRetrieval"]),
        memoryPort,
      });

      const result = await svc.buildContext(makeRequest());
      const layer = result.layers.find((l) => l.layerId === "memoryRetrieval");

      expect(layer?.content).toBe("(no memory entries)");
    });

    it("omits memoryRetrieval layer and sets degraded=true when query() throws", async () => {
      const memoryPort = makeMemoryPort(async () => {
        throw new Error("memory system offline");
      });

      const svc = makeService({
        planner: makePlannerWith(["memoryRetrieval"]),
        memoryPort,
      });

      const result = await svc.buildContext(makeRequest());

      expect(result.omittedLayers).toContain("memoryRetrieval");
      expect(result.degraded).toBe(true);
      expect(result.layers.find((l) => l.layerId === "memoryRetrieval")).toBeUndefined();
    });

    it("skips memory query when memoryRetrieval not in layersToRetrieve", async () => {
      let queryCalled = false;
      const memoryPort = makeMemoryPort(async () => {
        queryCalled = true;
        return { entries: [] };
      });

      const svc = makeService({
        planner: makePlannerWith(["repositoryState"]),
        memoryPort,
      });

      await svc.buildContext(makeRequest());
      expect(queryCalled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // populateCodeContext
  // -----------------------------------------------------------------------

  describe("populateCodeContext()", () => {
    it("calls search_files with pattern when codeContextQuery.pattern is present", async () => {
      let searchCalled = false;
      let capturedInput: unknown = null;

      const executor = makeToolExecutor(async (name, input) => {
        if (name === "search_files") {
          searchCalled = true;
          capturedInput = input;
          return { ok: true, value: "src/a.ts\nsrc/b.ts" };
        }
        return { ok: true, value: {} };
      });

      const svc = makeService({
        planner: makePlannerWith(["codeContext"], {
          codeContextQuery: { paths: [], pattern: "*.ts" },
        }),
        toolExecutor: executor,
      });

      const result = await svc.buildContext(makeRequest());

      expect(searchCalled).toBe(true);
      expect((capturedInput as { pattern: string }).pattern).toBe("*.ts");
      const layer = result.layers.find((l) => l.layerId === "codeContext");
      expect(layer?.content).toContain("src/a.ts");
    });

    it("calls read_file for each path when pattern is absent", async () => {
      const invokedNames: string[] = [];
      const invokedPaths: string[] = [];

      const executor = makeToolExecutor(async (name, input) => {
        invokedNames.push(name);
        if (name === "read_file") {
          invokedPaths.push((input as { path: string }).path);
          return { ok: true, value: `content of ${(input as { path: string }).path}` };
        }
        return { ok: true, value: {} };
      });

      const svc = makeService({
        planner: makePlannerWith(["codeContext"], {
          codeContextQuery: { paths: ["src/foo.ts", "src/bar.ts"] },
        }),
        toolExecutor: executor,
      });

      const result = await svc.buildContext(makeRequest());
      const layer = result.layers.find((l) => l.layerId === "codeContext");

      expect(invokedPaths).toContain("src/foo.ts");
      expect(invokedPaths).toContain("src/bar.ts");
      expect(layer?.content).toContain("content of src/foo.ts");
      expect(layer?.content).toContain("content of src/bar.ts");
    });

    it("concatenates all read_file results with double newline", async () => {
      const executor = makeToolExecutor(async (name, input) => {
        if (name === "read_file") {
          const p = (input as { path: string }).path;
          return { ok: true, value: `FILE:${p}` };
        }
        return { ok: true, value: {} };
      });

      const svc = makeService({
        planner: makePlannerWith(["codeContext"], {
          codeContextQuery: { paths: ["a.ts", "b.ts"] },
        }),
        toolExecutor: executor,
      });

      const result = await svc.buildContext(makeRequest());
      const layer = result.layers.find((l) => l.layerId === "codeContext");

      expect(layer?.content).toBe("FILE:a.ts\n\nFILE:b.ts");
    });

    it("omits codeContext layer and sets degraded=true when read_file returns ok=false", async () => {
      const executor = makeToolExecutor(async (name) => {
        if (name === "read_file") {
          return {
            ok: false,
            error: { type: "execution_error" as const, message: "file not found" },
          };
        }
        return { ok: true, value: {} };
      });

      const svc = makeService({
        planner: makePlannerWith(["codeContext"], {
          codeContextQuery: { paths: ["missing.ts"] },
        }),
        toolExecutor: executor,
      });

      const result = await svc.buildContext(makeRequest());

      expect(result.omittedLayers).toContain("codeContext");
      expect(result.degraded).toBe(true);
    });

    it("omits codeContext layer when search_files returns ok=false", async () => {
      const executor = makeToolExecutor(async (name) => {
        if (name === "search_files") {
          return {
            ok: false,
            error: { type: "execution_error" as const, message: "pattern error" },
          };
        }
        return { ok: true, value: {} };
      });

      const svc = makeService({
        planner: makePlannerWith(["codeContext"], {
          codeContextQuery: { paths: [], pattern: "**/*.ts" },
        }),
        toolExecutor: executor,
      });

      const result = await svc.buildContext(makeRequest());

      expect(result.omittedLayers).toContain("codeContext");
      expect(result.degraded).toBe(true);
    });

    it("skips codeContext when not in layersToRetrieve", async () => {
      let readFileCalled = false;
      const executor = makeToolExecutor(async (name) => {
        if (name === "read_file" || name === "search_files") readFileCalled = true;
        return { ok: true, value: {} };
      });

      const svc = makeService({
        planner: makePlannerWith(["repositoryState"], {
          codeContextQuery: { paths: ["src/x.ts"] },
        }),
        toolExecutor: executor,
      });

      await svc.buildContext(makeRequest());
      expect(readFileCalled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // populateToolResults
  // -----------------------------------------------------------------------

  describe("populateToolResults()", () => {
    it("includes toolResults layer formatted as '[Tool: <name>]\\n<content>'", async () => {
      const svc = makeService({
        planner: makePlannerWith(["toolResults"]),
      });

      const result = await svc.buildContext(
        makeRequest({
          previousToolResults: [
            { toolName: "read_file", content: "file content here" },
            { toolName: "git_status", content: "branch: main" },
          ],
        }),
      );

      const layer = result.layers.find((l) => l.layerId === "toolResults");
      expect(layer).toBeDefined();
      expect(layer?.content).toContain("[Tool: read_file]");
      expect(layer?.content).toContain("file content here");
      expect(layer?.content).toContain("[Tool: git_status]");
      expect(layer?.content).toContain("branch: main");
    });

    it("each tool result is separated by double newline", async () => {
      const svc = makeService({
        planner: makePlannerWith(["toolResults"]),
      });

      const result = await svc.buildContext(
        makeRequest({
          previousToolResults: [
            { toolName: "tool_a", content: "result A" },
            { toolName: "tool_b", content: "result B" },
          ],
        }),
      );

      const layer = result.layers.find((l) => l.layerId === "toolResults");
      expect(layer?.content).toBe(
        "[Tool: tool_a]\nresult A\n\n[Tool: tool_b]\nresult B",
      );
    });

    it("always succeeds — never omitted or degraded due to tool results", async () => {
      const svc = makeService({
        planner: makePlannerWith(["toolResults"]),
      });

      const result = await svc.buildContext(
        makeRequest({
          previousToolResults: [{ toolName: "t", content: "c" }],
        }),
      );

      expect(result.omittedLayers).not.toContain("toolResults");
      expect(result.degraded).toBe(false);
    });

    it("skips toolResults when previousToolResults is empty or absent", async () => {
      const svc = makeService({
        planner: makePlannerWith(["toolResults"]),
      });

      const result = await svc.buildContext(makeRequest({ previousToolResults: [] }));
      expect(result.layers.find((l) => l.layerId === "toolResults")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // layersToRetrieve filtering
  // -----------------------------------------------------------------------

  describe("layersToRetrieve filtering", () => {
    it("only populates layers present in the planner decision", async () => {
      let repoCalled = false;
      const executor = makeToolExecutor(async (name) => {
        if (name === "git_status") repoCalled = true;
        return { ok: true, value: {} };
      });

      // Only request memoryRetrieval — no repo state
      const svc = makeService({
        planner: makePlannerWith(["memoryRetrieval"]),
        toolExecutor: executor,
      });

      const result = await svc.buildContext(makeRequest());

      expect(repoCalled).toBe(false);
      expect(result.layers.find((l) => l.layerId === "repositoryState")).toBeUndefined();
    });

    it("populates all requested layers in one buildContext call", async () => {
      const executor = makeToolExecutor(async (name) => {
        if (name === "git_status") {
          return {
            ok: true,
            value: { branch: "main", staged: [], unstaged: [] },
          };
        }
        if (name === "read_file") {
          return { ok: true, value: "code content" };
        }
        return { ok: true, value: {} };
      });

      const memoryPort = makeMemoryPort(async () => ({
        entries: [
          {
            entry: { title: "M", description: "D", context: "C", date: "2026-01-01" },
            sourceFile: "coding_patterns",
            relevanceScore: 0.8,
          },
        ] as RankedMemoryEntry[],
      }));

      const svc = makeService({
        planner: makePlannerWith(["repositoryState", "memoryRetrieval", "codeContext"], {
          codeContextQuery: { paths: ["src/x.ts"] },
          memoryQuery: { text: "task", topN: 5 },
        }),
        toolExecutor: executor,
        memoryPort,
      });

      const result = await svc.buildContext(makeRequest());
      const layerIds = result.layers.map((l) => l.layerId);

      expect(layerIds).toContain("repositoryState");
      expect(layerIds).toContain("memoryRetrieval");
      expect(layerIds).toContain("codeContext");
    });
  });
});
