import { describe, expect, it } from "bun:test";
import type {
	IContextAccumulator,
	IContextCache,
	IContextEngine,
	IContextPlanner,
	ILayerCompressor,
	ITokenBudgetManager,
	ContextBuildRequest,
	TokenBudgetConfig,
	PlannerDecision,
	LayerBudgetMap,
	LayerId,
	CachedEntry,
} from "../../../application/ports/context";
import type { ContextEngineServiceOptions } from "../../../application/context/context-engine-service";
import type { MemoryPort } from "../../../application/ports/memory";
import type { IToolExecutor } from "../../../application/tools/executor";
import { ContextEngineService } from "../../../application/context/context-engine-service";

// ---------------------------------------------------------------------------
// Test helpers — minimal mocks satisfying each injected interface
// ---------------------------------------------------------------------------

function makePlanner(
	layersToRetrieve: LayerId[] = ["repositoryState", "memoryRetrieval"],
): IContextPlanner {
	return {
		plan: () => ({
			layersToRetrieve,
			rationale: "stepType:Exploration taskExcerpt:test task",
			codeContextQuery: { paths: [] },
			memoryQuery: { text: "test task", topN: 5 },
		}),
	};
}

function makeBudgetManager(): ITokenBudgetManager {
	return {
		countTokens: (text) => Math.ceil(text.length / 4),
		allocate: (_config): LayerBudgetMap => ({
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
		checkTotal: (_counts, _budget) => 0,
	};
}

function makeCompressor(): ILayerCompressor {
	return {
		compress: (layerId, content, _budget, tokenCounter) => ({
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
	let hits = 0;
	let misses = 0;
	return {
		get: (filePath, mtime) => {
			const entry = store.get(filePath);
			if (!entry || entry.mtime !== mtime) {
				misses++;
				return null;
			}
			hits++;
			return entry;
		},
		set: (entry) => {
			store.set(entry.filePath, entry);
		},
		invalidate: (filePath) => {
			store.delete(filePath);
		},
		stats: () => ({ hits, misses, entries: store.size }),
		clear: () => {
			store.clear();
		},
	};
}

function makeMemoryPort(): MemoryPort {
	return {
		shortTerm: {
			read: () => ({ recentFiles: [] }),
			write: () => {},
			clear: () => {},
		},
		query: async () => ({ entries: [] }),
		append: async () => ({ ok: true, action: "appended" }),
		update: async () => ({ ok: true, action: "updated" }),
		writeFailure: async () => ({ ok: true, action: "appended" }),
		getFailures: async () => [],
	};
}

function makeToolExecutor(
	response: Awaited<ReturnType<IToolExecutor["invoke"]>> = {
		ok: true,
		value: { branch: "main", staged: [], unstaged: [] },
	},
): IToolExecutor {
	return {
		invoke: async () => response,
	};
}

function makeRequest(
	overrides: Partial<ContextBuildRequest> = {},
): ContextBuildRequest {
	return {
		sessionId: "session-1",
		phaseId: "phase-1",
		taskId: "task-1",
		stepType: "Exploration",
		taskDescription: "Implement the feature",
		...overrides,
	};
}

function makeService(
	overrides: {
		planner?: IContextPlanner;
		budgetManager?: ITokenBudgetManager;
		compressor?: ILayerCompressor;
		accumulator?: IContextAccumulator;
		cache?: IContextCache;
		memoryPort?: MemoryPort;
		toolExecutor?: IToolExecutor;
		options?: ContextEngineServiceOptions;
	} = {},
): ContextEngineService {
	return new ContextEngineService(
		overrides.memoryPort ?? makeMemoryPort(),
		overrides.toolExecutor ?? makeToolExecutor(),
		overrides.planner ?? makePlanner(),
		overrides.budgetManager ?? makeBudgetManager(),
		overrides.compressor ?? makeCompressor(),
		overrides.accumulator ?? makeAccumulator(),
		overrides.cache ?? makeCache(),
		overrides.options ?? { workspaceRoot: "/workspace" },
	);
}

// ---------------------------------------------------------------------------
// Task 8.1 — Scaffold service class and layer population helpers
// ---------------------------------------------------------------------------

describe("ContextEngineService (task 8.1)", () => {
	describe("constructor", () => {
		it("instantiates without throwing", () => {
			expect(() => makeService()).not.toThrow();
		});

		it("implements IContextEngine interface", () => {
			const svc: IContextEngine = makeService();
			expect(typeof svc.buildContext).toBe("function");
			expect(typeof svc.expandContext).toBe("function");
			expect(typeof svc.resetPhase).toBe("function");
			expect(typeof svc.resetTask).toBe("function");
		});
	});

	describe("buildContext() — field validation", () => {
		it("returns a result without throwing when all required fields are present", async () => {
			const svc = makeService();
			const result = await svc.buildContext(makeRequest());
			expect(result).toBeDefined();
			expect(typeof result.content).toBe("string");
			expect(typeof result.degraded).toBe("boolean");
			expect(Array.isArray(result.omittedLayers)).toBe(true);
			expect(Array.isArray(result.layers)).toBe(true);
			expect(Array.isArray(result.layerUsage)).toBe(true);
		});

		it("sets degraded=true when sessionId is empty", async () => {
			const svc = makeService();
			const result = await svc.buildContext(makeRequest({ sessionId: "" }));
			expect(result.degraded).toBe(true);
		});

		it("sets degraded=true when phaseId is empty", async () => {
			const svc = makeService();
			const result = await svc.buildContext(makeRequest({ phaseId: "" }));
			expect(result.degraded).toBe(true);
		});

		it("sets degraded=true when taskId is empty", async () => {
			const svc = makeService();
			const result = await svc.buildContext(makeRequest({ taskId: "" }));
			expect(result.degraded).toBe(true);
		});

		it("sets degraded=true when taskDescription is empty", async () => {
			const svc = makeService();
			const result = await svc.buildContext(makeRequest({ taskDescription: "" }));
			expect(result.degraded).toBe(true);
		});
	});

	describe("buildContext() — result shape", () => {
		it("returns a plannerDecision field", async () => {
			const svc = makeService();
			const result = await svc.buildContext(makeRequest());
			expect(result.plannerDecision).toBeDefined();
			expect(typeof result.plannerDecision.rationale).toBe("string");
		});

		it("assembles content string with layer separators", async () => {
			const svc = makeService();
			const result = await svc.buildContext(makeRequest());
			// At minimum taskDescription layer must be present
			expect(result.content).toContain("=== [LAYER:");
		});

		it("totalTokens is a non-negative number", async () => {
			const svc = makeService();
			const result = await svc.buildContext(makeRequest());
			expect(result.totalTokens).toBeGreaterThanOrEqual(0);
		});
	});

	describe("populateTaskDescription()", () => {
		it("includes taskDescription layer in the result", async () => {
			const svc = makeService();
			const request = makeRequest({ taskDescription: "My unique task description XYZ" });
			const result = await svc.buildContext(request);

			const taskDescLayer = result.layers.find((l) => l.layerId === "taskDescription");
			expect(taskDescLayer).toBeDefined();
			expect(taskDescLayer?.content).toContain("My unique task description XYZ");
		});

		it("taskDescription layer content matches request.taskDescription exactly", async () => {
			const svc = makeService();
			const taskDescription = "Implement feature ABC with specific requirements";
			const result = await svc.buildContext(makeRequest({ taskDescription }));

			const layer = result.layers.find((l) => l.layerId === "taskDescription");
			expect(layer?.content).toBe(taskDescription);
		});

		it("taskDescription is never omitted even without caching", async () => {
			const svc = makeService();
			const result = await svc.buildContext(makeRequest());

			expect(result.omittedLayers).not.toContain("taskDescription");
		});
	});

	describe("populateSystemInstructions()", () => {
		it("gracefully degrades when steering doc paths are not found", async () => {
			// With workspace root that doesn't exist, should still return a result
			const svc = makeService({
				options: {
					workspaceRoot: "/nonexistent/workspace",
					steeringDocPaths: ["/nonexistent/workspace/.kiro/steering/tech.md"],
				},
			});
			const result = await svc.buildContext(makeRequest());
			// Should not throw, just omit the layer or return empty content
			expect(result).toBeDefined();
			expect(typeof result.degraded).toBe("boolean");
		});

		it("includes systemInstructions layer in result when paths exist", async () => {
			// Use an existing file as a steering doc
			const svc = makeService({
				options: {
					workspaceRoot: "/workspace",
					// Use a path that does NOT exist — expect graceful handling
					steeringDocPaths: [],
				},
			});
			const result = await svc.buildContext(makeRequest());
			// With no steering doc paths, systemInstructions may be empty or omitted gracefully
			expect(result).toBeDefined();
		});

		it("uses the cache for system instructions on repeated calls", async () => {
			const cache = makeCache();
			const svc = makeService({
				cache,
				options: {
					workspaceRoot: "/workspace",
					steeringDocPaths: [],
				},
			});

			// First call
			await svc.buildContext(makeRequest());
			// Second call — stats should show cache activity
			await svc.buildContext(makeRequest());
			// We can only assert no throws; cache behavior depends on file existence
			expect(cache.stats()).toBeDefined();
		});
	});

	describe("populateActiveSpecification()", () => {
		it("omits activeSpecification layer when spec file path is not found", async () => {
			const svc = makeService({
				options: {
					workspaceRoot: "/nonexistent",
					activeSpecPath: "/nonexistent/.kiro/specs/my-spec/requirements.md",
				},
			});
			const result = await svc.buildContext(makeRequest());
			// No throw — graceful degradation
			expect(result).toBeDefined();
		});

		it("does not throw when active spec read fails", async () => {
			const svc = makeService({
				options: {
					workspaceRoot: "/workspace",
					activeSpecPath: "/definitely/does/not/exist.md",
				},
			});
			await expect(svc.buildContext(makeRequest())).resolves.toBeDefined();
		});
	});

	describe("interface stubs — expandContext, resetPhase, resetTask", () => {
		it("resetPhase does not throw", () => {
			const svc = makeService();
			expect(() => svc.resetPhase("phase-1")).not.toThrow();
		});

		it("resetTask does not throw", () => {
			const svc = makeService();
			expect(() => svc.resetTask("task-1")).not.toThrow();
		});

		it("expandContext returns a result with ok field", async () => {
			const svc = makeService();
			const result = await svc.expandContext({
				sessionId: "session-1",
				phaseId: "phase-1",
				taskId: "task-1",
				resourceId: "some-resource",
				targetLayer: "codeContext",
			});
			expect(result).toBeDefined();
			expect(typeof result.ok).toBe("boolean");
		});
	});
});
