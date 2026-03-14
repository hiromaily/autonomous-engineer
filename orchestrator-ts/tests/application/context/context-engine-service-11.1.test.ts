import { describe, expect, it } from "bun:test";
import { ContextEngineService } from "../../../application/context/context-engine-service";
import type { ContextEngineServiceOptions } from "../../../application/context/context-engine-service";
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
} from "../../../application/ports/context";
import type { MemoryPort, RankedMemoryEntry } from "../../../application/ports/memory";
import type { IToolExecutor } from "../../../application/tools/executor";
import { ContextPlanner } from "../../../domain/context/context-planner";

// ---------------------------------------------------------------------------
// Canonical layer order (mirrors LAYER_REGISTRY)
// ---------------------------------------------------------------------------

const CANONICAL_LAYER_ORDER: LayerId[] = [
  "systemInstructions",
  "taskDescription",
  "activeSpecification",
  "codeContext",
  "repositoryState",
  "memoryRetrieval",
  "toolResults",
];

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

/**
 * Build a MemoryPort that returns `entries` for any query.
 * Each entry must have `title`, `context`, `description`, `date`.
 */
function makeMemoryPort(
  entries: Array<{ title: string; description: string; score?: number }> = [],
): MemoryPort {
  const ranked: RankedMemoryEntry[] = entries.map((e, i) => ({
    relevanceScore: e.score ?? 0.8,
    sourceFile: `memory-${i}.md`,
    entry: {
      title: e.title,
      context: "integration test",
      description: e.description,
      date: "2026-03-13",
    },
  }));
  return {
    shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
    query: async () => ({ entries: ranked }),
    append: async () => ({ ok: true, action: "appended" }),
    update: async () => ({ ok: true, action: "updated" }),
    writeFailure: async () => ({ ok: true, action: "appended" }),
    getFailures: async () => [],
  };
}

/**
 * Build a MemoryPort whose `query()` throws to simulate system failure.
 */
function makeFailingMemoryPort(): MemoryPort {
  return {
    shortTerm: { read: () => ({ recentFiles: [] }), write: () => {}, clear: () => {} },
    query: async () => {
      throw new Error("memory system unavailable");
    },
    append: async () => ({ ok: true, action: "appended" }),
    update: async () => ({ ok: true, action: "updated" }),
    writeFailure: async () => ({ ok: true, action: "appended" }),
    getFailures: async () => [],
  };
}

/**
 * Build an IToolExecutor whose `invoke()` responds to git_status, read_file, and search_files.
 */
function makeToolExecutor(opts: {
  gitBranch?: string;
  staged?: string[];
  unstaged?: string[];
  readFileContent?: string;
  searchResult?: string;
} = {}): IToolExecutor {
  return {
    invoke: async (name, args) => {
      if (name === "git_status") {
        return {
          ok: true,
          value: {
            branch: opts.gitBranch ?? "main",
            staged: opts.staged ?? [],
            unstaged: opts.unstaged ?? [],
          },
        };
      }
      if (name === "read_file") {
        return { ok: true, value: opts.readFileContent ?? "// file content" };
      }
      if (name === "search_files") {
        return { ok: true, value: opts.searchResult ?? "// search results" };
      }
      return { ok: true, value: {} };
    },
  };
}

/**
 * Planner that returns an Exploration plan including a codeContextQuery path
 * so that populateCodeContext() is exercised in integration tests.
 */
function makeExplorationPlannerWithCodeQuery(
  codePath = "/workspace/src/main.ts",
): IContextPlanner {
  return {
    plan: (_stepType, taskDescription) => ({
      layersToRetrieve: [
        "systemInstructions",
        "taskDescription",
        "memoryRetrieval",
        "codeContext",
        "repositoryState",
      ],
      rationale: `stepType:Exploration taskExcerpt:${taskDescription.slice(0, 100)}`,
      codeContextQuery: { paths: [codePath] },
      memoryQuery: { text: taskDescription, topN: 5 },
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
    opts.memoryPort ?? makeMemoryPort(),
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
    taskDescription: "Explore the codebase for context engine implementation",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task 11.1: Core buildContext integration tests
// ---------------------------------------------------------------------------

describe("ContextEngineService — buildContext integration (task 11.1)", () => {
  // -------------------------------------------------------------------------
  // 1. Full Exploration step — expected layers assembled in canonical order
  // -------------------------------------------------------------------------

  describe("full Exploration step layer assembly", () => {
    it("assembles taskDescription layer for every Exploration request", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest());

      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).toContain("taskDescription");
    });

    it("assembles repositoryState layer for Exploration step", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest());

      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).toContain("repositoryState");
    });

    it("assembles memoryRetrieval layer for Exploration step", async () => {
      const service = makeService({
        memoryPort: makeMemoryPort([{ title: "Past work", description: "relevant context" }]),
      });
      const result = await service.buildContext(makeRequest());

      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).toContain("memoryRetrieval");
    });

    it("assembles codeContext layer when planner provides a codeContextQuery", async () => {
      const service = makeService({
        planner: makeExplorationPlannerWithCodeQuery("/workspace/src/main.ts"),
        toolExecutor: makeToolExecutor({ readFileContent: "export function main() {}" }),
      });
      const result = await service.buildContext(makeRequest());

      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).toContain("codeContext");
    });

    it("codeContext layer content contains the file contents returned by IToolExecutor", async () => {
      const fileContent = "export class Engine { run() {} }";
      const service = makeService({
        planner: makeExplorationPlannerWithCodeQuery("/workspace/src/engine.ts"),
        toolExecutor: makeToolExecutor({ readFileContent: fileContent }),
      });
      const result = await service.buildContext(makeRequest());

      const codeLayer = result.layers.find((l) => l.layerId === "codeContext");
      expect(codeLayer).toBeDefined();
      expect(codeLayer?.content).toContain(fileContent);
    });

    it("repositoryState layer content includes the branch name from IToolExecutor", async () => {
      const service = makeService({
        toolExecutor: makeToolExecutor({ gitBranch: "feature/context-engine" }),
      });
      const result = await service.buildContext(makeRequest());

      const repoLayer = result.layers.find((l) => l.layerId === "repositoryState");
      expect(repoLayer).toBeDefined();
      expect(repoLayer?.content).toContain("feature/context-engine");
    });

    it("does NOT include activeSpecification for Exploration step (not in planner output)", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest({ stepType: "Exploration" }));

      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).not.toContain("activeSpecification");
    });

    it("does NOT include toolResults when previousToolResults is absent or empty", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest({ previousToolResults: [] }));

      const layerIds = result.layers.map((l) => l.layerId);
      expect(layerIds).not.toContain("toolResults");
    });

    it("all assembled layers appear in canonical registry order", async () => {
      const service = makeService({
        planner: makeExplorationPlannerWithCodeQuery(),
        toolExecutor: makeToolExecutor({ readFileContent: "// code" }),
        memoryPort: makeMemoryPort([{ title: "Memory", description: "desc" }]),
      });
      const result = await service.buildContext(makeRequest());

      const assembledIds = result.layers.map((l) => l.layerId);
      // Filter canonical order to only assembled layers
      const expected = CANONICAL_LAYER_ORDER.filter((id) => assembledIds.includes(id));
      expect(assembledIds).toEqual(expected);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Content string contains === [LAYER: <layerId>] === separators in order
  // -------------------------------------------------------------------------

  describe("content string layer separators", () => {
    it("assembled content contains the === [LAYER: <id>] === separator format", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest());

      expect(result.content).toContain("=== [LAYER:");
    });

    it("each assembled layer has its === [LAYER: <layerId>] === separator in content", async () => {
      const service = makeService({
        planner: makeExplorationPlannerWithCodeQuery(),
        toolExecutor: makeToolExecutor({ readFileContent: "// code" }),
      });
      const result = await service.buildContext(makeRequest());

      for (const layer of result.layers) {
        expect(result.content).toContain(`=== [LAYER: ${layer.layerId}] ===`);
      }
    });

    it("taskDescription separator appears before repositoryState separator in content", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest());

      const taskDescIdx = result.content.indexOf("=== [LAYER: taskDescription] ===");
      const repoStateIdx = result.content.indexOf("=== [LAYER: repositoryState] ===");

      expect(taskDescIdx).toBeGreaterThanOrEqual(0);
      expect(repoStateIdx).toBeGreaterThan(taskDescIdx);
    });

    it("repositoryState separator appears before memoryRetrieval separator in content", async () => {
      const service = makeService({
        memoryPort: makeMemoryPort([{ title: "Memory", description: "desc" }]),
      });
      const result = await service.buildContext(makeRequest());

      const repoStateIdx = result.content.indexOf("=== [LAYER: repositoryState] ===");
      const memRetrievalIdx = result.content.indexOf("=== [LAYER: memoryRetrieval] ===");

      expect(repoStateIdx).toBeGreaterThanOrEqual(0);
      expect(memRetrievalIdx).toBeGreaterThan(repoStateIdx);
    });

    it("all assembled layer separators appear in strict canonical order in content", async () => {
      const service = makeService({
        planner: makeExplorationPlannerWithCodeQuery(),
        toolExecutor: makeToolExecutor({ readFileContent: "// code" }),
        memoryPort: makeMemoryPort([{ title: "Past decision", description: "context" }]),
      });
      const result = await service.buildContext(makeRequest());

      const assembledIds = result.layers.map((l) => l.layerId);
      const canonicalAssembled = CANONICAL_LAYER_ORDER.filter((id) => assembledIds.includes(id));

      // Each separator must appear after the previous one in the content string
      const positions = canonicalAssembled.map((id) => ({
        id,
        pos: result.content.indexOf(`=== [LAYER: ${id}] ===`),
      }));

      for (let i = 1; i < positions.length; i++) {
        const prev = positions[i - 1]!;
        const curr = positions[i]!;
        expect(curr.pos).toBeGreaterThan(prev.pos);
      }
    });

    it("taskDescription layer content follows its separator in the content string", async () => {
      const taskDescription = "unique-task-description-xyz-123";
      const service = makeService();
      const result = await service.buildContext(makeRequest({ taskDescription }));

      const separatorIdx = result.content.indexOf("=== [LAYER: taskDescription] ===");
      const contentIdx = result.content.indexOf(taskDescription);

      expect(separatorIdx).toBeGreaterThanOrEqual(0);
      expect(contentIdx).toBeGreaterThan(separatorIdx);
    });
  });

  // -------------------------------------------------------------------------
  // 3. layerUsage contains exactly the assembled layers and no others
  // -------------------------------------------------------------------------

  describe("layerUsage accuracy", () => {
    it("layerUsage has the same number of entries as result.layers", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest());

      expect(result.layerUsage.length).toBe(result.layers.length);
    });

    it("layerUsage layerIds match result.layers layerIds exactly", async () => {
      const service = makeService({
        planner: makeExplorationPlannerWithCodeQuery(),
        toolExecutor: makeToolExecutor({ readFileContent: "// code" }),
        memoryPort: makeMemoryPort([{ title: "Memory", description: "desc" }]),
      });
      const result = await service.buildContext(makeRequest());

      const layerIds = result.layers.map((l) => l.layerId).sort();
      const usageIds = result.layerUsage.map((u) => u.layerId).sort();
      expect(layerIds).toEqual(usageIds);
    });

    it("layerUsage contains no layers absent from result.layers", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest());

      for (const usage of result.layerUsage) {
        const found = result.layers.find((l) => l.layerId === usage.layerId);
        expect(found).toBeDefined();
      }
    });

    it("every layerUsage entry has a non-negative actualTokens value", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest());

      for (const usage of result.layerUsage) {
        expect(usage.actualTokens).toBeGreaterThanOrEqual(0);
      }
    });

    it("every layerUsage entry has a positive budget value", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest());

      for (const usage of result.layerUsage) {
        expect(usage.budget).toBeGreaterThan(0);
      }
    });

    it("totalTokens equals the sum of all layerUsage actualTokens", async () => {
      const service = makeService({
        planner: makeExplorationPlannerWithCodeQuery(),
        toolExecutor: makeToolExecutor({ readFileContent: "// code" }),
        memoryPort: makeMemoryPort([{ title: "Memory", description: "desc" }]),
      });
      const result = await service.buildContext(makeRequest());

      const sum = result.layerUsage.reduce((acc, u) => acc + u.actualTokens, 0);
      expect(result.totalTokens).toBe(sum);
    });

    it("taskDescription layerUsage entry has actualTokens matching task description length estimate", async () => {
      const taskDescription = "A specific task description for token counting";
      const service = makeService();
      const result = await service.buildContext(makeRequest({ taskDescription }));

      const usage = result.layerUsage.find((u) => u.layerId === "taskDescription");
      expect(usage).toBeDefined();
      // Budget manager uses Math.ceil(length / 4)
      const expectedTokens = Math.ceil(taskDescription.length / 4);
      expect(usage?.actualTokens).toBe(expectedTokens);
    });
  });

  // -------------------------------------------------------------------------
  // 4. plannerDecision is reflected in the result
  // -------------------------------------------------------------------------

  describe("plannerDecision in result", () => {
    it("result always contains a plannerDecision field", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest());

      expect(result.plannerDecision).toBeDefined();
    });

    it("plannerDecision.rationale contains the step type for Exploration", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest({ stepType: "Exploration" }));

      expect(result.plannerDecision.rationale).toContain("Exploration");
    });

    it("plannerDecision.rationale contains a task description excerpt", async () => {
      const taskDescription = "Explore the codebase to understand the context engine";
      const service = makeService();
      const result = await service.buildContext(makeRequest({ taskDescription }));

      // ContextPlanner sets rationale to: stepType:${stepType} taskExcerpt:${taskDescription.slice(0, 100)}
      expect(result.plannerDecision.rationale).toContain(taskDescription.slice(0, 100));
    });

    it("plannerDecision.layersToRetrieve includes codeContext and repositoryState for Exploration", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest({ stepType: "Exploration" }));

      expect(result.plannerDecision.layersToRetrieve).toContain("codeContext");
      expect(result.plannerDecision.layersToRetrieve).toContain("repositoryState");
    });

    it("plannerDecision.layersToRetrieve includes activeSpecification and codeContext for Modification", async () => {
      const service = makeService({
        // activeSpecPath not set, so activeSpecification layer will be omitted gracefully
        options: { workspaceRoot: "/workspace" },
      });
      const result = await service.buildContext(makeRequest({ stepType: "Modification" }));

      expect(result.plannerDecision.layersToRetrieve).toContain("activeSpecification");
      expect(result.plannerDecision.layersToRetrieve).toContain("codeContext");
    });

    it("plannerDecision.layersToRetrieve includes toolResults and activeSpecification for Validation", async () => {
      const service = makeService({
        options: { workspaceRoot: "/workspace" },
      });
      const result = await service.buildContext(makeRequest({ stepType: "Validation" }));

      expect(result.plannerDecision.layersToRetrieve).toContain("toolResults");
      expect(result.plannerDecision.layersToRetrieve).toContain("activeSpecification");
    });

    it("assembled layers are a subset of plannerDecision.layersToRetrieve plus always-present layers", async () => {
      const service = makeService();
      const result = await service.buildContext(makeRequest({ stepType: "Exploration" }));

      // systemInstructions and taskDescription are always present regardless of planner
      const permittedIds = new Set<string>([
        "systemInstructions",
        "taskDescription",
        ...result.plannerDecision.layersToRetrieve,
      ]);

      for (const layer of result.layers) {
        expect(permittedIds.has(layer.layerId)).toBe(true);
      }
    });

    it("plannerDecision is returned unchanged for a custom mock planner", async () => {
      const customPlan = {
        layersToRetrieve: ["taskDescription", "memoryRetrieval"] as LayerId[],
        rationale: "custom:rationale",
        memoryQuery: { text: "custom query", topN: 3 },
      };
      const customPlanner: IContextPlanner = { plan: () => customPlan };
      const service = makeService({ planner: customPlanner });

      const result = await service.buildContext(makeRequest());

      expect(result.plannerDecision.rationale).toBe("custom:rationale");
      expect(result.plannerDecision.layersToRetrieve).toContain("taskDescription");
      expect(result.plannerDecision.layersToRetrieve).toContain("memoryRetrieval");
    });
  });
});
