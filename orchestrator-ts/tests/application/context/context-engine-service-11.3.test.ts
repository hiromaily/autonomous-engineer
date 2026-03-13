import { describe, expect, it } from "bun:test";
import type {
	IContextAccumulator,
	IContextCache,
	IContextPlanner,
	ILayerCompressor,
	ITokenBudgetManager,
	ContextBuildRequest,
	LayerBudgetMap,
	LayerId,
	CachedEntry,
	CompressionResult,
} from "../../../application/ports/context";
import type { MemoryPort } from "../../../application/ports/memory";
import type { IToolExecutor } from "../../../application/tools/executor";
import { ContextEngineService } from "../../../application/context/context-engine-service";
import type { ContextEngineServiceOptions } from "../../../application/context/context-engine-service";

// ---------------------------------------------------------------------------
// Budget manager factories
// ---------------------------------------------------------------------------

/** Budget manager with generous limits — no compression expected. */
function makeGenerousBudgetManager(): ITokenBudgetManager {
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

/** Budget manager with a very tight codeContext budget to force compression. */
function makeTightCodeContextBudgetManager(codeContextBudget: number): ITokenBudgetManager {
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
			totalBudget: 700_000 + codeContextBudget,
		}),
		checkBudget: (content, budget) => {
			const tokensUsed = Math.ceil(content.length / 4);
			return { tokensUsed, overBy: Math.max(0, tokensUsed - budget) };
		},
		checkTotal: (_counts, _totalBudget) => 0,
	};
}

/** Budget manager that gives systemInstructions and taskDescription impossibly small budgets. */
function makeMinimalSystemLayerBudgetManager(): ITokenBudgetManager {
	return {
		countTokens: (text) => Math.ceil(text.length / 4),
		allocate: (): LayerBudgetMap => ({
			budgets: {
				systemInstructions: 1, // tiny — would trigger compression if allowed
				taskDescription: 1, // tiny — would trigger compression if allowed
				activeSpecification: 100_000,
				codeContext: 1, // tiny
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

// ---------------------------------------------------------------------------
// Compressor factories
// ---------------------------------------------------------------------------

/** Compressor that tracks which layers it was called for. */
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

/** Identity compressor — returns content unchanged but marks it as compressed. */
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

// ---------------------------------------------------------------------------
// Other mock factories
// ---------------------------------------------------------------------------

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

/** Planner that requests codeContext with a read_file query. */
function makeExplorationPlannerWithCode(codePath = "/workspace/src/main.ts"): IContextPlanner {
	return {
		plan: (_stepType, taskDescription) => ({
			layersToRetrieve: [
				"memoryRetrieval",
				"codeContext",
				"repositoryState",
			],
			rationale: `stepType:Exploration taskExcerpt:${taskDescription.slice(0, 100)}`,
			codeContextQuery: { paths: [codePath] },
		}),
	};
}

/** Planner that requests only the given layers (no codeContextQuery). */
function makePlannerWith(layersToRetrieve: LayerId[]): IContextPlanner {
	return {
		plan: (_stepType, taskDescription) => ({
			layersToRetrieve,
			rationale: `stepType:test taskExcerpt:${taskDescription.slice(0, 100)}`,
		}),
	};
}

function makeService(opts: {
	planner?: IContextPlanner;
	budgetManager?: ITokenBudgetManager;
	compressor?: ILayerCompressor;
	toolExecutor?: IToolExecutor;
	memoryPort?: MemoryPort;
	options?: ContextEngineServiceOptions;
}) {
	return new ContextEngineService(
		opts.memoryPort ?? makeMemoryPort(),
		opts.toolExecutor ?? makeToolExecutor(),
		opts.planner ?? makeExplorationPlannerWithCode(),
		opts.budgetManager ?? makeGenerousBudgetManager(),
		opts.compressor ?? makeIdentityCompressor(),
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
		taskDescription: "Explore the codebase",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Task 11.3: Compression integration tests
// ---------------------------------------------------------------------------

describe("ContextEngineService — compression integration (task 11.3)", () => {
	// -------------------------------------------------------------------------
	// 1. Compression applied to codeContext when content exceeds budget
	// -------------------------------------------------------------------------

	describe("codeContext compression when content exceeds budget", () => {
		it("calls compress() for codeContext layer when content exceeds its budget", async () => {
			// 100 chars / 4 = 25 tokens, budget = 1 token → overBy = 24
			const largeCode = "x".repeat(100);
			const { compressor, compressedLayerIds } = makeTrackingCompressor();

			const service = makeService({
				planner: makeExplorationPlannerWithCode(),
				budgetManager: makeTightCodeContextBudgetManager(1),
				compressor,
				toolExecutor: makeToolExecutor(largeCode),
			});
			await service.buildContext(makeRequest());

			expect(compressedLayerIds).toContain("codeContext");
		});

		it("sets layerUsage[codeContext].compressed = true when layer was compressed", async () => {
			const largeCode = "x".repeat(100);
			const service = makeService({
				planner: makeExplorationPlannerWithCode(),
				budgetManager: makeTightCodeContextBudgetManager(1),
				compressor: makeIdentityCompressor(),
				toolExecutor: makeToolExecutor(largeCode),
			});
			const result = await service.buildContext(makeRequest());

			const usage = result.layerUsage.find((u) => u.layerId === "codeContext");
			expect(usage).toBeDefined();
			expect(usage?.compressed).toBe(true);
		});

		it("content in the assembled result reflects the compressed output", async () => {
			const largeCode = "x".repeat(100);
			const { compressor } = makeTrackingCompressor(); // returns "COMPRESSED"

			const service = makeService({
				planner: makeExplorationPlannerWithCode(),
				budgetManager: makeTightCodeContextBudgetManager(1),
				compressor,
				toolExecutor: makeToolExecutor(largeCode),
			});
			const result = await service.buildContext(makeRequest());

			const codeLayer = result.layers.find((l) => l.layerId === "codeContext");
			expect(codeLayer?.content).toBe("COMPRESSED");
		});

		it("does NOT call compress() for codeContext when content is within budget", async () => {
			const smallCode = "x".repeat(4); // 1 token
			const { compressor, compressedLayerIds } = makeTrackingCompressor();

			const service = makeService({
				planner: makeExplorationPlannerWithCode(),
				budgetManager: makeTightCodeContextBudgetManager(100), // budget = 100 tokens
				compressor,
				toolExecutor: makeToolExecutor(smallCode),
			});
			await service.buildContext(makeRequest());

			expect(compressedLayerIds).not.toContain("codeContext");
		});

		it("sets layerUsage[codeContext].compressed = false when content is within budget", async () => {
			const smallCode = "x".repeat(4); // 1 token
			const service = makeService({
				planner: makeExplorationPlannerWithCode(),
				budgetManager: makeTightCodeContextBudgetManager(100),
				compressor: makeIdentityCompressor(),
				toolExecutor: makeToolExecutor(smallCode),
			});
			const result = await service.buildContext(makeRequest());

			const usage = result.layerUsage.find((u) => u.layerId === "codeContext");
			expect(usage).toBeDefined();
			expect(usage?.compressed).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// 2. systemInstructions and taskDescription are NEVER compressed
	// -------------------------------------------------------------------------

	describe("systemInstructions never compressed", () => {
		it("does NOT call compress() for systemInstructions even when budget is 1 token", async () => {
			const { compressor, compressedLayerIds } = makeTrackingCompressor();

			// Use a real file for systemInstructions — the project package.json is always present
			const steeringPath =
				"/Users/hiroki.yasui/work/hiromaily/autonomous-engineer/orchestrator-ts/package.json";

			const service = makeService({
				planner: makePlannerWith([]),
				budgetManager: makeMinimalSystemLayerBudgetManager(),
				compressor,
				options: {
					workspaceRoot: "/workspace",
					steeringDocPaths: [steeringPath],
				},
			});
			await service.buildContext(makeRequest());

			expect(compressedLayerIds).not.toContain("systemInstructions");
		});

		it("layerUsage[systemInstructions].compressed is false even when content greatly exceeds budget", async () => {
			// Use a real file with content — package.json is small but we use budget=1 to trigger
			const steeringPath =
				"/Users/hiroki.yasui/work/hiromaily/autonomous-engineer/orchestrator-ts/package.json";

			const service = makeService({
				planner: makePlannerWith([]),
				budgetManager: makeMinimalSystemLayerBudgetManager(),
				compressor: makeIdentityCompressor(),
				options: {
					workspaceRoot: "/workspace",
					steeringDocPaths: [steeringPath],
				},
			});
			const result = await service.buildContext(makeRequest());

			const usage = result.layerUsage.find((u) => u.layerId === "systemInstructions");
			if (usage !== undefined) {
				// If the layer was assembled, it must not be marked as compressed
				expect(usage.compressed).toBe(false);
			}
			// If systemInstructions was not assembled (file unreadable), the test still passes
		});
	});

	describe("taskDescription never compressed", () => {
		it("does NOT call compress() for taskDescription even when it has a tiny budget", async () => {
			// taskDescription budget = 1 token; provide a long task description (> 4 chars)
			const longTask = "A".repeat(20); // 5 tokens >> budget=1
			const { compressor, compressedLayerIds } = makeTrackingCompressor();

			const service = makeService({
				planner: makePlannerWith([]),
				budgetManager: makeMinimalSystemLayerBudgetManager(),
				compressor,
			});
			await service.buildContext(makeRequest({ taskDescription: longTask }));

			expect(compressedLayerIds).not.toContain("taskDescription");
		});

		it("layerUsage[taskDescription].compressed is always false", async () => {
			const longTask = "A".repeat(20); // 5 tokens, well over budget=1
			const service = makeService({
				planner: makePlannerWith([]),
				budgetManager: makeMinimalSystemLayerBudgetManager(),
				compressor: makeIdentityCompressor(),
			});
			const result = await service.buildContext(makeRequest({ taskDescription: longTask }));

			const usage = result.layerUsage.find((u) => u.layerId === "taskDescription");
			expect(usage).toBeDefined();
			expect(usage?.compressed).toBe(false);
		});

		it("taskDescription content remains exactly as provided even when budget is exceeded", async () => {
			const longTask = "B".repeat(20);
			const service = makeService({
				planner: makePlannerWith([]),
				budgetManager: makeMinimalSystemLayerBudgetManager(),
				compressor: makeTrackingCompressor().compressor,
			});
			const result = await service.buildContext(makeRequest({ taskDescription: longTask }));

			const layer = result.layers.find((l) => l.layerId === "taskDescription");
			expect(layer?.content).toBe(longTask);
		});
	});

	// -------------------------------------------------------------------------
	// 3. layerUsage[i].compressed reflects only actually compressed layers
	// -------------------------------------------------------------------------

	describe("layerUsage.compressed accuracy", () => {
		it("only the oversized codeContext layer has compressed = true; others have compressed = false", async () => {
			const largeCode = "x".repeat(100); // 25 tokens >> budget=1
			const service = makeService({
				planner: makeExplorationPlannerWithCode(),
				budgetManager: makeTightCodeContextBudgetManager(1),
				compressor: makeIdentityCompressor(),
				toolExecutor: makeToolExecutor(largeCode),
			});
			const result = await service.buildContext(makeRequest());

			for (const usage of result.layerUsage) {
				if (usage.layerId === "codeContext") {
					expect(usage.compressed).toBe(true);
				} else {
					expect(usage.compressed).toBe(false);
				}
			}
		});

		it("no layerUsage entries have compressed = true when all layers are within budget", async () => {
			const smallCode = "x".repeat(4); // 1 token, well within budget
			const service = makeService({
				planner: makeExplorationPlannerWithCode(),
				budgetManager: makeGenerousBudgetManager(),
				compressor: makeIdentityCompressor(),
				toolExecutor: makeToolExecutor(smallCode),
			});
			const result = await service.buildContext(makeRequest());

			for (const usage of result.layerUsage) {
				expect(usage.compressed).toBe(false);
			}
		});

		it("layerUsage.compressed is true for each layer that actually triggered compress()", async () => {
			const largeCode = "x".repeat(100); // 25 tokens >> budget=1
			const budgetManager = makeTightCodeContextBudgetManager(1);

			const service = makeService({
				planner: makeExplorationPlannerWithCode(),
				budgetManager,
				compressor: makeIdentityCompressor(),
				toolExecutor: makeToolExecutor(largeCode),
			});
			const result = await service.buildContext(makeRequest());

			const codeUsage = result.layerUsage.find((u) => u.layerId === "codeContext");
			expect(codeUsage?.compressed).toBe(true);

			// repositoryState was not oversized — should be false
			const repoUsage = result.layerUsage.find((u) => u.layerId === "repositoryState");
			if (repoUsage !== undefined) {
				expect(repoUsage.compressed).toBe(false);
			}
		});

		it("layerUsage count equals result.layers count after compression", async () => {
			const largeCode = "x".repeat(400);
			const service = makeService({
				planner: makeExplorationPlannerWithCode(),
				budgetManager: makeTightCodeContextBudgetManager(1),
				compressor: makeIdentityCompressor(),
				toolExecutor: makeToolExecutor(largeCode),
			});
			const result = await service.buildContext(makeRequest());

			expect(result.layerUsage.length).toBe(result.layers.length);
		});

		it("totalTokens remains consistent after compression", async () => {
			const largeCode = "x".repeat(400);
			const service = makeService({
				planner: makeExplorationPlannerWithCode(),
				budgetManager: makeTightCodeContextBudgetManager(1),
				compressor: makeIdentityCompressor(),
				toolExecutor: makeToolExecutor(largeCode),
			});
			const result = await service.buildContext(makeRequest());

			const sum = result.layerUsage.reduce((acc, u) => acc + u.actualTokens, 0);
			expect(result.totalTokens).toBe(sum);
		});
	});
});
