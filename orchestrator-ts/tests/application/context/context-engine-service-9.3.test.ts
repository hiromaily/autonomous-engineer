import { describe, expect, it } from "bun:test";
import type {
	IContextAccumulator,
	IContextCache,
	IContextPlanner,
	ILayerCompressor,
	ITokenBudgetManager,
	ContextBuildRequest,
	CompressionResult,
	LayerBudgetMap,
	LayerId,
	CachedEntry,
	ContextAssemblyLog,
} from "../../../application/ports/context";
import type { MemoryPort } from "../../../application/ports/memory";
import type { IToolExecutor } from "../../../application/tools/executor";
import { ContextEngineService } from "../../../application/context/context-engine-service";
import type { ContextEngineServiceOptions } from "../../../application/context/context-engine-service";

// ---------------------------------------------------------------------------
// Log capture helper
// ---------------------------------------------------------------------------

function captureInfoLogs(): { logs: string[]; restore: () => void } {
	const logs: string[] = [];
	const original = console.info;
	console.info = (...args: unknown[]) => logs.push(args.map(String).join(" "));
	return { logs, restore: () => { console.info = original; } };
}

/** Find the ContextAssemblyLog JSON from captured logs. */
function findAssemblyLog(logs: string[]): ContextAssemblyLog | null {
	for (const log of logs) {
		if (log.includes("ContextAssemblyLog")) {
			const jsonStart = log.indexOf("{");
			if (jsonStart !== -1) {
				try {
					return JSON.parse(log.slice(jsonStart)) as ContextAssemblyLog;
				} catch {
					// try next
				}
			}
		}
	}
	return null;
}

/** Find all compression event JSON entries from captured logs. */
function findCompressionLogs(logs: string[]): Array<{ layerId: string; original: number; compressed: number; technique: string }> {
	const result = [];
	for (const log of logs) {
		if (log.includes("CompressionEvent")) {
			const jsonStart = log.indexOf("{");
			if (jsonStart !== -1) {
				try {
					result.push(JSON.parse(log.slice(jsonStart)));
				} catch {
					// skip
				}
			}
		}
	}
	return result;
}

/** Find planner decision log entry. */
function findPlannerLog(logs: string[]): Record<string, unknown> | null {
	for (const log of logs) {
		if (log.includes("PlannerDecision")) {
			const jsonStart = log.indexOf("{");
			if (jsonStart !== -1) {
				try {
					return JSON.parse(log.slice(jsonStart)) as Record<string, unknown>;
				} catch {
					// skip
				}
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePlannerWith(layersToRetrieve: LayerId[]): IContextPlanner {
	return {
		plan: () => ({
			layersToRetrieve,
			rationale: "stepType:Exploration taskExcerpt:test task",
			codeContextQuery: { paths: ["/src/foo.ts"], pattern: undefined },
			memoryQuery: { text: "test task", topN: 5 },
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

/** Budget manager with very tight budgets to force compression on codeContext. */
function makeTightBudgetManager(): ITokenBudgetManager {
	return {
		countTokens: (text) => Math.ceil(text.length / 4),
		allocate: (): LayerBudgetMap => ({
			budgets: {
				systemInstructions: 1000,
				taskDescription: 500,
				activeSpecification: 2000,
				codeContext: 2, // tiny — will force compression
				repositoryState: 500,
				memoryRetrieval: 1500,
				toolResults: 2000,
			},
			totalBudget: 100000,
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
			technique: "code_skeleton",
			originalTokenCount: 9999,
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

function makeToolExecutor(readFileContent = "export function foo() { return 42; }"): IToolExecutor {
	return {
		invoke: async (name) => {
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

function makeService(opts: {
	planner?: IContextPlanner;
	budgetManager?: ITokenBudgetManager;
	compressor?: ILayerCompressor;
	toolExecutor?: IToolExecutor;
} = {}) {
	const serviceOpts: ContextEngineServiceOptions = {
		workspaceRoot: "/workspace",
	};
	return new ContextEngineService(
		makeMemoryPort(),
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
		taskDescription: "test task description",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests — Task 9.3: structured observability emission
// ---------------------------------------------------------------------------

describe("ContextEngineService — structured observability (task 9.3)", () => {
	// -------------------------------------------------------------------------
	// ContextAssemblyLog emission
	// -------------------------------------------------------------------------

	it("emits a ContextAssemblyLog after buildContext", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({});
			await service.buildContext(makeRequest());
			const log = findAssemblyLog(logs);
			expect(log).not.toBeNull();
		} finally {
			restore();
		}
	});

	it("ContextAssemblyLog contains sessionId, phaseId, taskId, stepType", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({});
			await service.buildContext(makeRequest({
				sessionId: "sess-42",
				phaseId: "phase-abc",
				taskId: "task-xyz",
				stepType: "Modification",
			}));
			const log = findAssemblyLog(logs);
			expect(log?.sessionId).toBe("sess-42");
			expect(log?.phaseId).toBe("phase-abc");
			expect(log?.taskId).toBe("task-xyz");
			expect(log?.stepType).toBe("Modification");
		} finally {
			restore();
		}
	});

	it("ContextAssemblyLog contains layersAssembled array", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({ planner: makePlannerWith([]) });
			await service.buildContext(makeRequest());
			const log = findAssemblyLog(logs);
			expect(Array.isArray(log?.layersAssembled)).toBe(true);
			// taskDescription is always assembled
			expect(log?.layersAssembled).toContain("taskDescription");
		} finally {
			restore();
		}
	});

	it("ContextAssemblyLog contains layerTokenCounts with tokens and budget", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({});
			await service.buildContext(makeRequest());
			const log = findAssemblyLog(logs);
			expect(Array.isArray(log?.layerTokenCounts)).toBe(true);
			const tdEntry = log?.layerTokenCounts.find((e) => e.layerId === "taskDescription");
			expect(tdEntry).toBeDefined();
			expect(typeof tdEntry?.tokens).toBe("number");
			expect(typeof tdEntry?.budget).toBe("number");
		} finally {
			restore();
		}
	});

	it("ContextAssemblyLog contains totalTokens", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({});
			await service.buildContext(makeRequest());
			const log = findAssemblyLog(logs);
			expect(typeof log?.totalTokens).toBe("number");
			expect(log!.totalTokens).toBeGreaterThanOrEqual(0);
		} finally {
			restore();
		}
	});

	it("ContextAssemblyLog contains durationMs >= 0", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({});
			await service.buildContext(makeRequest());
			const log = findAssemblyLog(logs);
			expect(typeof log?.durationMs).toBe("number");
			expect(log!.durationMs).toBeGreaterThanOrEqual(0);
		} finally {
			restore();
		}
	});

	it("ContextAssemblyLog contains omittedLayers array", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({});
			await service.buildContext(makeRequest());
			const log = findAssemblyLog(logs);
			expect(Array.isArray(log?.omittedLayers)).toBe(true);
		} finally {
			restore();
		}
	});

	it("ContextAssemblyLog contains degraded boolean", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({});
			await service.buildContext(makeRequest());
			const log = findAssemblyLog(logs);
			expect(typeof log?.degraded).toBe("boolean");
		} finally {
			restore();
		}
	});

	it("ContextAssemblyLog contains cacheHits and cacheMisses arrays", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({});
			await service.buildContext(makeRequest());
			const log = findAssemblyLog(logs);
			expect(Array.isArray(log?.cacheHits)).toBe(true);
			expect(Array.isArray(log?.cacheMisses)).toBe(true);
		} finally {
			restore();
		}
	});

	it("ContextAssemblyLog contains compressed array", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({});
			await service.buildContext(makeRequest());
			const log = findAssemblyLog(logs);
			expect(Array.isArray(log?.compressed)).toBe(true);
		} finally {
			restore();
		}
	});

	// -------------------------------------------------------------------------
	// No raw content in logs
	// -------------------------------------------------------------------------

	it("ContextAssemblyLog does not contain raw task description content", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({});
			const taskDesc = "UNIQUE_TASK_DESCRIPTION_CONTENT_12345";
			await service.buildContext(makeRequest({ taskDescription: taskDesc }));
			const log = findAssemblyLog(logs);
			// The JSON-stringified log should not contain the raw task description
			const logStr = JSON.stringify(log);
			expect(logStr).not.toContain(taskDesc);
		} finally {
			restore();
		}
	});

	// -------------------------------------------------------------------------
	// Planner decision logging
	// -------------------------------------------------------------------------

	it("logs planner decision with rationale", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({ planner: makePlannerWith(["codeContext"]) });
			await service.buildContext(makeRequest());
			const plannerLog = findPlannerLog(logs);
			expect(plannerLog).not.toBeNull();
			expect(plannerLog?.rationale).toBeDefined();
		} finally {
			restore();
		}
	});

	it("planner decision log does not contain raw content fields", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({ planner: makePlannerWith([]) });
			await service.buildContext(makeRequest({ taskDescription: "SECRET_TASK_CONTENT" }));
			const plannerLog = findPlannerLog(logs);
			const logStr = JSON.stringify(plannerLog);
			expect(logStr).not.toContain("SECRET_TASK_CONTENT");
		} finally {
			restore();
		}
	});

	// -------------------------------------------------------------------------
	// Compression event logging
	// -------------------------------------------------------------------------

	it("logs compression events when a layer is compressed", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const largeContent = "x".repeat(500); // ~125 tokens, exceeds codeContext budget of 2
			const service = makeService({
				planner: makePlannerWith(["codeContext"]),
				budgetManager: makeTightBudgetManager(),
				compressor: makeCompressor(),
				toolExecutor: makeToolExecutor(largeContent),
			});
			await service.buildContext(makeRequest());
			const compressionLogs = findCompressionLogs(logs);
			expect(compressionLogs.length).toBeGreaterThan(0);
		} finally {
			restore();
		}
	});

	it("compression event log contains layerId, original token count, compressed token count, and technique", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const largeContent = "x".repeat(500);
			const service = makeService({
				planner: makePlannerWith(["codeContext"]),
				budgetManager: makeTightBudgetManager(),
				compressor: makeCompressor(),
				toolExecutor: makeToolExecutor(largeContent),
			});
			await service.buildContext(makeRequest());
			const compressionLogs = findCompressionLogs(logs);
			const codeContextEvent = compressionLogs.find((e) => e.layerId === "codeContext");
			expect(codeContextEvent).toBeDefined();
			expect(typeof codeContextEvent?.original).toBe("number");
			expect(typeof codeContextEvent?.compressed).toBe("number");
			expect(codeContextEvent?.technique).toBe("code_skeleton");
		} finally {
			restore();
		}
	});

	it("does not log compression events when no layer exceeds budget", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const service = makeService({
				planner: makePlannerWith([]),
				// Default budget manager has large budgets — short content won't exceed them
			});
			await service.buildContext(makeRequest({ taskDescription: "short" }));
			const compressionLogs = findCompressionLogs(logs);
			expect(compressionLogs.length).toBe(0);
		} finally {
			restore();
		}
	});

	// -------------------------------------------------------------------------
	// ContextAssemblyLog compressed field matches actual compression
	// -------------------------------------------------------------------------

	it("ContextAssemblyLog compressed field includes details of compressed layers", async () => {
		const { logs, restore } = captureInfoLogs();
		try {
			const largeContent = "x".repeat(500);
			const service = makeService({
				planner: makePlannerWith(["codeContext"]),
				budgetManager: makeTightBudgetManager(),
				compressor: makeCompressor(),
				toolExecutor: makeToolExecutor(largeContent),
			});
			await service.buildContext(makeRequest());
			const log = findAssemblyLog(logs);
			expect(log?.compressed.length).toBeGreaterThan(0);
			const codeCtx = log?.compressed.find((e) => e.layerId === "codeContext");
			expect(codeCtx).toBeDefined();
			expect(typeof codeCtx?.original).toBe("number");
			expect(typeof codeCtx?.compressed).toBe("number");
		} finally {
			restore();
		}
	});
});
