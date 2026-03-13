import { readFile, stat } from "node:fs/promises";
import type {
	ContextAssemblyLog,
	ContextAssemblyResult,
	ContextBuildRequest,
	CompressionTechnique,
	ExpansionRequest,
	ExpansionResult,
	IContextAccumulator,
	IContextCache,
	IContextEngine,
	IContextPlanner,
	ILayerCompressor,
	ITokenBudgetManager,
	LayerId,
	LayerBudgetMap,
	LayerTokenUsage,
	PlannerDecision,
	TokenBudgetConfig,
} from "../ports/context";
import type { MemoryPort, RankedMemoryEntry } from "../ports/memory";
import type { IToolExecutor } from "../tools/executor";
import { LAYER_REGISTRY } from "../../domain/context/layer-registry";
import type { ToolContext } from "../../domain/tools/types";

// ---------------------------------------------------------------------------
// Service configuration
// ---------------------------------------------------------------------------

export interface ContextEngineServiceOptions {
	readonly workspaceRoot: string;
	/** Absolute paths to steering documents for systemInstructions layer. */
	readonly steeringDocPaths?: ReadonlyArray<string>;
	/** Optional path to the active specification file for activeSpecification layer. */
	readonly activeSpecPath?: string;
	readonly tokenBudgetConfig?: TokenBudgetConfig;
}

// ---------------------------------------------------------------------------
// Internal layer population result
// ---------------------------------------------------------------------------

interface LayerContent {
	readonly layerId: LayerId;
	readonly content: string;
	readonly cacheHit: boolean;
	readonly compressed: boolean;
}

interface PopulationResult {
	readonly layers: LayerContent[];
	readonly omittedLayers: LayerId[];
	readonly degraded: boolean;
}

interface CompressionEventRecord {
	readonly layerId: LayerId;
	readonly original: number;
	readonly compressed: number;
	readonly technique: CompressionTechnique;
}

// Layers that callers may expand via expandContext
const EXPANDABLE_LAYERS: ReadonlySet<LayerId> = new Set([
	"codeContext",
	"activeSpecification",
	"memoryRetrieval",
]);

const REVERSE_CANONICAL_LAYER_ORDER: ReadonlyArray<LayerId> = Object.freeze(
	[...LAYER_REGISTRY].reverse().map((e) => e.id),
);

interface BudgetedLayers {
	readonly layers: LayerContent[];
	readonly budgetMap: LayerBudgetMap;
	readonly compressionEvents: CompressionEventRecord[];
}

// ---------------------------------------------------------------------------
// ContextEngineService
// ---------------------------------------------------------------------------

/**
 * Application service that orchestrates all domain services and I/O ports
 * to fulfill the IContextEngine contract.
 *
 * Never throws from buildContext — all errors surface as degraded/omittedLayers.
 */
export class ContextEngineService implements IContextEngine {
	private readonly memoryPort: MemoryPort;
	private readonly toolExecutor: IToolExecutor;
	private readonly planner: IContextPlanner;
	private readonly budgetManager: ITokenBudgetManager;
	private readonly compressor: ILayerCompressor;
	private readonly accumulator: IContextAccumulator;
	private readonly cache: IContextCache;
	private readonly options: ContextEngineServiceOptions;
	private readonly _toolContext: ToolContext;

	/** Current assembled layer content — updated after each buildContext/expandContext call. */
	private currentLayers = new Map<LayerId, string>();
	/** Current budget map — updated after each buildContext call. */
	private currentBudgetMap: LayerBudgetMap | null = null;

	constructor(
		memoryPort: MemoryPort,
		toolExecutor: IToolExecutor,
		planner: IContextPlanner,
		budgetManager: ITokenBudgetManager,
		compressor: ILayerCompressor,
		accumulator: IContextAccumulator,
		cache: IContextCache,
		options: ContextEngineServiceOptions,
	) {
		this.memoryPort = memoryPort;
		this.toolExecutor = toolExecutor;
		this.planner = planner;
		this.budgetManager = budgetManager;
		this.compressor = compressor;
		this.accumulator = accumulator;
		this.cache = cache;
		this.options = options;
		this._toolContext = {
			workspaceRoot: options.workspaceRoot,
			workingDirectory: options.workspaceRoot,
			permissions: {
				filesystemRead: true,
				filesystemWrite: false,
				shellExecution: false,
				gitWrite: false,
				networkAccess: false,
			},
			memory: { search: async () => [] },
			logger: {
				info: () => {},
				error: () => {},
			},
		};
	}

	// -------------------------------------------------------------------------
	// buildContext — entry point
	// -------------------------------------------------------------------------

	async buildContext(request: ContextBuildRequest): Promise<ContextAssemblyResult> {
		const startMs = Date.now();

		// Validate required fields
		if (
			!request.sessionId ||
			!request.phaseId ||
			!request.taskId ||
			!request.taskDescription
		) {
			return this.buildDegradedResult([]);
		}

		// Plan retrieval
		const plan = this.planner.plan(
			request.stepType,
			request.taskDescription,
			request.previousToolResults ?? [],
		);

		// Log planner decision (metadata only — no raw content)
		console.info(
			"[ContextEngineService] PlannerDecision",
			JSON.stringify({
				layersToRetrieve: plan.layersToRetrieve,
				rationale: plan.rationale,
				codeContextQuery: plan.codeContextQuery,
				memoryQuery: plan.memoryQuery,
				specSections: plan.specSections,
			}),
		);

		// Populate all layers
		const population = await this.populateLayers(request, plan);

		// Apply budget enforcement and compression (returns layers + budgetMap + compressionEvents)
		const { layers: budgeted, budgetMap, compressionEvents } = this.applyBudgets(population.layers);

		// Log each compression event (metadata only — no raw content)
		for (const event of compressionEvents) {
			console.info(
				"[ContextEngineService] CompressionEvent",
				JSON.stringify(event),
			);
		}

		// Assemble final content string in canonical order
		const { content, layers, layerUsage, totalTokens } = this.assembleContent(budgeted, budgetMap);

		// Save assembled layer state for subsequent expandContext calls
		this.currentBudgetMap = budgetMap;
		for (const layer of layers) {
			this.currentLayers.set(layer.layerId, layer.content);
		}

		const durationMs = Date.now() - startMs;

		// Emit structured ContextAssemblyLog (no raw content)
		const assemblyLog: ContextAssemblyLog = {
			sessionId: request.sessionId,
			phaseId: request.phaseId,
			taskId: request.taskId,
			stepType: request.stepType,
			layersAssembled: layerUsage.map((l) => l.layerId),
			layerTokenCounts: layerUsage.map((l) => ({
				layerId: l.layerId,
				tokens: l.actualTokens,
				budget: l.budget,
			})),
			cacheHits: layerUsage.filter((l) => l.cacheHit).map((l) => l.layerId),
			cacheMisses: layerUsage.filter((l) => !l.cacheHit).map((l) => l.layerId),
			totalTokens,
			compressed: compressionEvents,
			omittedLayers: population.omittedLayers,
			degraded: population.degraded,
			durationMs,
		};
		console.info("[ContextEngineService] ContextAssemblyLog", JSON.stringify(assemblyLog));

		return {
			content,
			layers,
			totalTokens,
			layerUsage,
			plannerDecision: plan,
			degraded: population.degraded,
			omittedLayers: population.omittedLayers,
		};
	}

	// -------------------------------------------------------------------------
	// expandContext — implemented in task 9.1
	// -------------------------------------------------------------------------

	async expandContext(request: ExpansionRequest): Promise<ExpansionResult> {
		if (!EXPANDABLE_LAYERS.has(request.targetLayer)) {
			return {
				ok: false,
				updatedTokenCount: 0,
				errorReason: `Layer "${request.targetLayer}" is not expandable`,
			};
		}

		// Fetch resource content based on targetLayer
		let fetchedContent: string;
		try {
			if (request.targetLayer === "memoryRetrieval") {
				const result = await this.memoryPort.query({ text: request.resourceId, topN: 1 });
				fetchedContent = this.formatMemoryEntries(result.entries);
			} else {
				const result = await this.toolExecutor.invoke(
					"read_file",
					{ path: request.resourceId },
					this._toolContext,
				);
				if (!result.ok) {
					return {
						ok: false,
						updatedTokenCount: 0,
						errorReason: `Failed to fetch resource "${request.resourceId}": ${result.error}`,
					};
				}
				fetchedContent = String(result.value);
			}
		} catch (err) {
			return {
				ok: false,
				updatedTokenCount: 0,
				errorReason: `Unexpected error fetching resource "${request.resourceId}": ${err}`,
			};
		}

		// Compute token deltas
		const currentContent = this.currentLayers.get(request.targetLayer) ?? "";
		const addedTokenCount = this.budgetManager.countTokens(fetchedContent);
		const newContent = currentContent
			? `${currentContent}\n\n${fetchedContent}`
			: fetchedContent;
		const newCumulativeTokenCount = this.budgetManager.countTokens(newContent);

		// Record expansion (also enforces the per-iteration limit)
		const expansionResult = this.accumulator.recordExpansion({
			resourceId: request.resourceId,
			targetLayer: request.targetLayer,
			addedTokenCount,
			newCumulativeTokenCount,
			timestamp: new Date().toISOString(),
		});

		if (!expansionResult.ok) {
			return {
				ok: false,
				updatedTokenCount: newCumulativeTokenCount,
				errorReason: expansionResult.errorReason,
			};
		}

		// Accumulate the appended entry
		this.accumulator.accumulate({
			layerId: request.targetLayer,
			content: fetchedContent,
			phaseId: request.phaseId,
			taskId: request.taskId,
			resourceId: request.resourceId,
		});

		// Re-run budget check; compress if over budget
		const effectiveBudgetMap =
			this.currentBudgetMap ??
			this.budgetManager.allocate(
				this.options.tokenBudgetConfig ?? this.defaultBudgetConfig(),
			);
		const budget = effectiveBudgetMap.budgets[request.targetLayer];
		let finalContent = newContent;
		let updatedTokenCount = newCumulativeTokenCount;
		const { overBy } = this.budgetManager.checkBudget(finalContent, budget);
		if (overBy > 0) {
			const compressed = this.compressor.compress(
				request.targetLayer,
				finalContent,
				budget,
				this.budgetManager.countTokens.bind(this.budgetManager),
			);
			finalContent = compressed.compressed;
			updatedTokenCount = compressed.tokenCount; // reuse count from compressor
		}

		// Persist updated content for subsequent calls
		this.currentLayers.set(request.targetLayer, finalContent);

		// Emit expansion log entry (metadata only — no raw content)
		console.info(
			`[ContextEngineService] expandContext: resourceId=${request.resourceId} targetLayer=${request.targetLayer} updatedTokenCount=${updatedTokenCount}`,
		);

		return { ok: true, updatedTokenCount };
	}

	// -------------------------------------------------------------------------
	// resetPhase — delegates to accumulator; emits PhaseResetEvent (task 9.2)
	// -------------------------------------------------------------------------

	resetPhase(phaseId: string): void {
		this.accumulator.resetPhase(phaseId);
		this.releaseLayerState("PhaseResetEvent", "phaseId", phaseId);
	}

	// -------------------------------------------------------------------------
	// resetTask — delegates to accumulator; emits TaskResetEvent (task 9.2)
	// -------------------------------------------------------------------------

	resetTask(taskId: string): void {
		this.accumulator.resetTask(taskId);
		this.releaseLayerState("TaskResetEvent", "taskId", taskId);
	}

	/** Clear assembled layer state and emit a structured reset event. */
	private releaseLayerState(event: string, field: string, id: string): void {
		this.currentLayers.clear();
		this.currentBudgetMap = null;
		console.info(
			`[ContextEngineService] ${event}: ${field}=${id} timestamp=${new Date().toISOString()}`,
		);
	}

	// -------------------------------------------------------------------------
	// Layer population helpers
	// -------------------------------------------------------------------------

	private async populateLayers(
		request: ContextBuildRequest,
		plan: PlannerDecision,
	): Promise<PopulationResult> {
		const layers: LayerContent[] = [];
		const omittedLayers: LayerId[] = [];
		let degraded = false;

		const layersToRetrieve = new Set(plan.layersToRetrieve);

		// systemInstructions — always populated
		const sysInstr = await this.populateSystemInstructions();
		if (sysInstr !== null) {
			layers.push(sysInstr);
		} else {
			// systemInstructions omitted but not fatal
			omittedLayers.push("systemInstructions");
		}

		// taskDescription — always populated, never compressed/cached
		layers.push(this.populateTaskDescription(request.taskDescription));

		// activeSpecification
		if (layersToRetrieve.has("activeSpecification")) {
			const specLayer = await this.populateActiveSpecification();
			if (specLayer !== null) {
				layers.push(specLayer);
			} else {
				omittedLayers.push("activeSpecification");
				degraded = true;
			}
		}

		// repositoryState
		if (layersToRetrieve.has("repositoryState")) {
			const repoLayer = await this.populateRepositoryState();
			if (repoLayer !== null) {
				layers.push(repoLayer);
			} else {
				omittedLayers.push("repositoryState");
				degraded = true;
			}
		}

		// memoryRetrieval
		if (layersToRetrieve.has("memoryRetrieval")) {
			const memLayer = await this.populateMemoryRetrieval(request.taskDescription);
			if (memLayer !== null) {
				layers.push(memLayer);
			} else {
				omittedLayers.push("memoryRetrieval");
				degraded = true;
			}
		}

		// codeContext
		if (layersToRetrieve.has("codeContext")) {
			const codeLayer = await this.populateCodeContext(plan);
			if (codeLayer !== null) {
				layers.push(codeLayer);
			} else {
				omittedLayers.push("codeContext");
				degraded = true;
			}
		}

		// toolResults
		if (layersToRetrieve.has("toolResults") && request.previousToolResults?.length) {
			layers.push(this.populateToolResults(request.previousToolResults));
		}

		return { layers, omittedLayers, degraded };
	}

	// -------------------------------------------------------------------------
	// populateSystemInstructions
	// -------------------------------------------------------------------------

	private async populateSystemInstructions(): Promise<LayerContent | null> {
		const paths = this.options.steeringDocPaths;
		if (!paths || paths.length === 0) {
			return null;
		}

		const results = await Promise.all(
			paths.map(async (filePath) => {
				try {
					const statResult = await stat(filePath);
					const mtime = statResult.mtimeMs;
					const cached = this.cache.get(filePath, mtime);

					if (cached !== null) {
						return { content: cached.content, cacheHit: true };
					}

					const content = await readFile(filePath, "utf-8");
					const tokenCount = this.budgetManager.countTokens(content);
					this.cache.set({
						filePath,
						content,
						tokenCount,
						mtime,
						cachedAt: new Date().toISOString(),
					});
					return { content, cacheHit: false };
				} catch {
					console.warn(
						`[ContextEngineService] Failed to read steering doc: ${filePath}`,
					);
					return null;
				}
			}),
		);

		const parts: string[] = [];
		let anyCacheHit = false;
		for (const r of results) {
			if (r !== null) {
				parts.push(r.content);
				if (r.cacheHit) anyCacheHit = true;
			}
		}

		if (parts.length === 0) {
			return null;
		}

		return {
			layerId: "systemInstructions",
			content: parts.join("\n\n---\n\n"),
			cacheHit: anyCacheHit,
			compressed: false,
		};
	}

	// -------------------------------------------------------------------------
	// populateTaskDescription
	// -------------------------------------------------------------------------

	private populateTaskDescription(taskDescription: string): LayerContent {
		return {
			layerId: "taskDescription",
			content: taskDescription,
			cacheHit: false,
			compressed: false,
		};
	}

	// -------------------------------------------------------------------------
	// populateActiveSpecification
	// -------------------------------------------------------------------------

	private async populateActiveSpecification(): Promise<LayerContent | null> {
		const specPath = this.options.activeSpecPath;
		if (!specPath) {
			return null;
		}

		try {
			const content = await readFile(specPath, "utf-8");
			return { layerId: "activeSpecification", content, cacheHit: false, compressed: false };
		} catch {
			console.warn(
				`[ContextEngineService] Failed to read active specification: ${specPath}`,
			);
			return null;
		}
	}

	// -------------------------------------------------------------------------
	// populateRepositoryState (task 8.2)
	// -------------------------------------------------------------------------

	private async populateRepositoryState(): Promise<LayerContent | null> {
		try {
			const result = await this.toolExecutor.invoke(
				"git_status",
				{},
				this._toolContext,
			);

			if (!result.ok) {
				console.error("[ContextEngineService] git_status failed:", result.error);
				return null;
			}

			const value = result.value as {
				branch?: string;
				staged?: string[];
				unstaged?: string[];
			};
			const content =
				`Branch: ${value.branch ?? "unknown"}\n` +
				`Staged: ${(value.staged ?? []).join(", ") || "none"}\n` +
				`Unstaged: ${(value.unstaged ?? []).join(", ") || "none"}`;

			return { layerId: "repositoryState", content, cacheHit: false, compressed: false };
		} catch (err) {
			console.error("[ContextEngineService] Unexpected error in git_status:", err);
			return null;
		}
	}

	// -------------------------------------------------------------------------
	// populateMemoryRetrieval (task 8.2)
	// -------------------------------------------------------------------------

	private async populateMemoryRetrieval(taskDescription: string): Promise<LayerContent | null> {
		try {
			const result = await this.memoryPort.query({
				text: taskDescription,
				topN: 5,
			});

			const content = this.formatMemoryEntries(result.entries);

			return {
				layerId: "memoryRetrieval",
				content: content || "(no memory entries)",
				cacheHit: false,
				compressed: false,
			};
		} catch (err) {
			console.warn("[ContextEngineService] Memory retrieval failed:", err);
			return null;
		}
	}

	// -------------------------------------------------------------------------
	// populateCodeContext (task 8.2)
	// -------------------------------------------------------------------------

	private async populateCodeContext(plan: PlannerDecision): Promise<LayerContent | null> {
		try {
			const query = plan.codeContextQuery;
			if (!query || (query.paths.length === 0 && !query.pattern)) {
				return null;
			}

			const ctx = this._toolContext;
			const parts: string[] = [];

			if (query.pattern) {
				const result = await this.toolExecutor.invoke(
					"search_files",
					{ pattern: query.pattern },
					ctx,
				);
				if (result.ok) {
					parts.push(String(result.value));
				} else {
					console.error("[ContextEngineService] search_files failed:", result.error);
					return null;
				}
			} else {
				const fileResults = await Promise.all(
					query.paths.map((path) => this.toolExecutor.invoke("read_file", { path }, ctx)),
				);
				for (const result of fileResults) {
					if (result.ok) {
						parts.push(String(result.value));
					} else {
						console.error("[ContextEngineService] read_file failed:", result.error);
						return null;
					}
				}
			}

			return {
				layerId: "codeContext",
				content: parts.join("\n\n"),
				cacheHit: false,
				compressed: false,
			};
		} catch (err) {
			console.error("[ContextEngineService] Unexpected error in code context:", err);
			return null;
		}
	}

	// -------------------------------------------------------------------------
	// populateToolResults (task 8.2)
	// -------------------------------------------------------------------------

	private populateToolResults(
		previousToolResults: ReadonlyArray<{ toolName: string; content: string }>,
	): LayerContent {
		const content = previousToolResults
			.map((r) => `[Tool: ${r.toolName}]\n${r.content}`)
			.join("\n\n");
		return { layerId: "toolResults", content, cacheHit: false, compressed: false };
	}

	// -------------------------------------------------------------------------
	// applyBudgets — compression enforcement (task 8.3)
	// -------------------------------------------------------------------------

	private applyBudgets(layers: LayerContent[]): BudgetedLayers {
		const config = this.options.tokenBudgetConfig ?? this.defaultBudgetConfig();
		const budgetMap = this.budgetManager.allocate(config);
		const compressionEvents: CompressionEventRecord[] = [];

		// Phase 1: per-layer compression
		const result: LayerContent[] = layers.map((layer) => {
			const budget = budgetMap.budgets[layer.layerId];
			const { tokensUsed, overBy } = this.budgetManager.checkBudget(layer.content, budget);

			if (
				overBy > 0 &&
				layer.layerId !== "systemInstructions" &&
				layer.layerId !== "taskDescription"
			) {
				const compressed = this.compressor.compress(
					layer.layerId,
					layer.content,
					budget,
					this.budgetManager.countTokens.bind(this.budgetManager),
				);
				compressionEvents.push({
					layerId: layer.layerId,
					original: tokensUsed,
					compressed: compressed.tokenCount,
					technique: compressed.technique,
				});
				return { ...layer, content: compressed.compressed, compressed: true };
			}

			return { ...layer, compressed: false };
		});

		// Phase 2: total budget check — truncate lowest-priority layer on overage
		const tokenCounts = result.map((l) => ({
			layerId: l.layerId,
			tokens: this.budgetManager.countTokens(l.content),
		}));
		const overage = this.budgetManager.checkTotal(tokenCounts, budgetMap.totalBudget);

		if (overage > 0) {
			// Lowest-priority = reverse canonical order; skip system-level layers
			const reversePriority = REVERSE_CANONICAL_LAYER_ORDER;

			for (const layerId of reversePriority) {
				if (layerId === "systemInstructions" || layerId === "taskDescription") continue;
				const idx = result.findIndex((l) => l.layerId === layerId);
				if (idx === -1) continue;

				const target = result[idx];
				if (target === undefined) continue;

				const targetTokens = this.budgetManager.countTokens(target.content);
				const remainingBudget = Math.max(0, targetTokens - overage);

				console.error(
					`[ContextEngineService] Total token overage of ${overage} tokens — truncating layer "${layerId}"`,
				);

				const truncatedContent = this.#truncateContentAware(layerId, target.content, remainingBudget);
				compressionEvents.push({
					layerId,
					original: targetTokens,
					compressed: this.budgetManager.countTokens(truncatedContent),
					technique: "truncation",
				});
				result[idx] = { ...target, content: truncatedContent, compressed: true };
				break;
			}
		}

		return { layers: result, budgetMap, compressionEvents };
	}

	// -------------------------------------------------------------------------
	// #truncateContentAware — content-aware truncation to a token budget
	// -------------------------------------------------------------------------

	#truncateContentAware(layerId: LayerId, content: string, tokenBudget: number): string {
		// For memoryRetrieval, remove whole JSON-line entries from the end until within budget
		if (layerId === "memoryRetrieval") {
			const lines = content.split("\n").filter((l) => l.trim() !== "");
			while (lines.length > 0) {
				const joined = lines.join("\n");
				if (this.budgetManager.countTokens(joined) <= tokenBudget) {
					return joined;
				}
				lines.pop();
			}
			return "";
		}
		// Generic fallback: character-based slice
		return content.slice(0, tokenBudget * 4);
	}

	// -------------------------------------------------------------------------
	// assembleContent — build final output (task 8.3)
	// -------------------------------------------------------------------------

	private assembleContent(
		populatedLayers: LayerContent[],
		budgetMap: LayerBudgetMap,
	): {
		content: string;
		layers: ReadonlyArray<{ layerId: LayerId; content: string }>;
		layerUsage: ReadonlyArray<LayerTokenUsage>;
		totalTokens: number;
	} {
		// Order by canonical layer registry
		const populatedMap = new Map(populatedLayers.map((l) => [l.layerId, l]));
		const ordered: LayerContent[] = [];
		for (const entry of LAYER_REGISTRY) {
			const layer = populatedMap.get(entry.id);
			if (layer) {
				ordered.push(layer);
			}
		}

		const parts: string[] = [];
		const layerResults: { layerId: LayerId; content: string }[] = [];
		const layerUsage: LayerTokenUsage[] = [];
		let totalTokens = 0;

		for (const layer of ordered) {
			parts.push(`=== [LAYER: ${layer.layerId}] ===\n${layer.content}`);
			layerResults.push({ layerId: layer.layerId, content: layer.content });

			const actualTokens = this.budgetManager.countTokens(layer.content);
			totalTokens += actualTokens;
			layerUsage.push({
				layerId: layer.layerId,
				actualTokens,
				budget: budgetMap.budgets[layer.layerId],
				cacheHit: layer.cacheHit,
				compressed: layer.compressed,
			});
		}

		return {
			content: parts.join("\n\n"),
			layers: layerResults,
			layerUsage,
			totalTokens,
		};
	}

	// -------------------------------------------------------------------------
	// buildDegradedResult — validation failure shortcut
	// -------------------------------------------------------------------------

	private buildDegradedResult(omittedLayers: LayerId[]): ContextAssemblyResult {
		const emptyPlan: PlannerDecision = {
			layersToRetrieve: [],
			rationale: "validation_failure",
		};

		return {
			content: "",
			layers: [],
			totalTokens: 0,
			layerUsage: [],
			plannerDecision: emptyPlan,
			degraded: true,
			omittedLayers,
		};
	}

	// -------------------------------------------------------------------------
	// formatMemoryEntries — shared memory entry formatter (metadata only)
	// -------------------------------------------------------------------------

	private formatMemoryEntries(entries: readonly RankedMemoryEntry[]): string {
		return entries
			.map((e) =>
				JSON.stringify({
					title: e.entry.title,
					description: e.entry.description,
					relevanceScore: e.relevanceScore,
				}),
			)
			.join("\n");
	}

	// -------------------------------------------------------------------------
	// defaultBudgetConfig
	// -------------------------------------------------------------------------

	private defaultBudgetConfig(): TokenBudgetConfig {
		return {
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
	}
}
