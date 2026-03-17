// Re-export domain-level types so consumers can import from either location.
export type {
  CompressionResult,
  CompressionTechnique,
  IContextPlanner,
  ILayerCompressor,
  ITokenBudgetManager,
  LayerBudgetConfig,
  LayerBudgetMap,
  LayerId,
  PlannerDecision,
  StepType,
  TokenBudgetConfig,
  ToolResultEntry,
} from "@/domain/context/types";

import type { CompressionTechnique, LayerId, PlannerDecision, StepType, ToolResultEntry } from "@/domain/context/types";

// ---------------------------------------------------------------------------
// IContextEngine — value objects (request / result)
// ---------------------------------------------------------------------------

export interface ContextBuildRequest {
  readonly sessionId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly stepType: StepType;
  readonly taskDescription: string;
  readonly previousToolResults?: ReadonlyArray<ToolResultEntry>;
  readonly modelTokenLimit?: number;
}

export interface LayerTokenUsage {
  readonly layerId: LayerId;
  readonly actualTokens: number;
  readonly budget: number;
  readonly cacheHit: boolean;
  readonly compressed: boolean;
}

export interface ContextAssemblyResult {
  readonly content: string;
  readonly layers: ReadonlyArray<{ readonly layerId: LayerId; readonly content: string }>;
  readonly totalTokens: number;
  readonly layerUsage: ReadonlyArray<LayerTokenUsage>;
  readonly plannerDecision: PlannerDecision;
  readonly degraded: boolean;
  readonly omittedLayers: ReadonlyArray<LayerId>;
}

export interface ExpansionRequest {
  readonly sessionId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly resourceId: string;
  readonly targetLayer: "codeContext" | "activeSpecification" | "memoryRetrieval";
}

export interface ExpansionResult {
  readonly ok: boolean;
  readonly updatedTokenCount: number;
  readonly errorReason?: string;
}

// ---------------------------------------------------------------------------
// IContextEngine — primary application port
// ---------------------------------------------------------------------------

export interface IContextEngine {
  /**
   * Build a complete 7-layer context for an LLM invocation.
   * Never throws — errors surface in the result's degraded/omittedLayers fields.
   */
  buildContext(request: ContextBuildRequest): Promise<ContextAssemblyResult>;

  /**
   * Append additional content to an expandable layer mid-iteration.
   * Always resolves — returns a result with `ok: false` when targetLayer is not
   * expandable or the maximum expansion limit has been reached.
   */
  expandContext(request: ExpansionRequest): Promise<ExpansionResult>;

  /**
   * Discard all non-cached accumulated context for the given phase.
   * Called by PhaseRunner.onEnter() at every phase transition.
   */
  resetPhase(phaseId: string): void;

  /**
   * Initialize a fresh task-scoped context state.
   * Called by the implementation loop at the start of each task section.
   */
  resetTask(taskId: string): void;
}

// ---------------------------------------------------------------------------
// IContextAccumulator — value objects
// ---------------------------------------------------------------------------

export interface AccumulatedEntry {
  readonly layerId: LayerId;
  readonly content: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly resourceId: string | undefined;
}

export interface ExpansionEvent {
  readonly resourceId: string;
  readonly targetLayer: "codeContext" | "activeSpecification" | "memoryRetrieval";
  readonly addedTokenCount: number;
  readonly newCumulativeTokenCount: number;
  readonly timestamp: string; // ISO 8601
}

export interface ContextAccumulatorConfig {
  readonly maxExpansionsPerIteration: number; // default: 10
}

// ---------------------------------------------------------------------------
// IContextAccumulator — domain port
// ---------------------------------------------------------------------------

export interface IContextAccumulator {
  /** Add an entry to the current phase/task scope. */
  accumulate(entry: AccumulatedEntry): void;

  /** Return all entries valid for the given phase+task scope. */
  getEntries(phaseId: string, taskId: string): ReadonlyArray<AccumulatedEntry>;

  /**
   * Record an expansion event; returns `{ ok: false, errorReason }` when
   * maxExpansionsPerIteration is reached.
   */
  recordExpansion(event: ExpansionEvent): { ok: boolean; errorReason?: string };

  /** Return all expansion events recorded in the current iteration. */
  getExpansionEvents(): ReadonlyArray<ExpansionEvent>;

  /** Discard all entries tagged with phaseId and reset the expansion counter. */
  resetPhase(phaseId: string): void;

  /** Discard all entries tagged with taskId and reset the expansion counter. */
  resetTask(taskId: string): void;
}

// ---------------------------------------------------------------------------
// IContextCache — value objects
// ---------------------------------------------------------------------------

export interface CachedEntry {
  readonly filePath: string;
  readonly content: string;
  readonly tokenCount: number;
  readonly mtime: number; // ms since epoch from fs.stat
  readonly cachedAt: string; // ISO 8601
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
}

// ---------------------------------------------------------------------------
// IContextCache — application port
// ---------------------------------------------------------------------------

export interface IContextCache {
  /** Return cached entry if mtime matches; null on miss or staleness. */
  get(filePath: string, currentMtime: number): CachedEntry | null;

  /** Store entry in cache; evicts LRU entry if capacity is exceeded. */
  set(entry: CachedEntry): void;

  /** Invalidate a specific entry. */
  invalidate(filePath: string): void;

  /** Return cumulative hit/miss statistics. */
  stats(): CacheStats;

  /** Reset all cache entries (called at session end, not phase reset). */
  clear(): void;
}

// ---------------------------------------------------------------------------
// ContextAssemblyLog — observability (no raw content)
// ---------------------------------------------------------------------------

export interface ContextAssemblyLog {
  readonly sessionId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly stepType: StepType;
  readonly layersAssembled: ReadonlyArray<LayerId>;
  readonly layerTokenCounts: ReadonlyArray<{
    layerId: LayerId;
    tokens: number;
    budget: number;
  }>;
  readonly cacheHits: ReadonlyArray<LayerId>;
  readonly cacheMisses: ReadonlyArray<LayerId>;
  readonly totalTokens: number;
  readonly compressed: ReadonlyArray<{
    layerId: LayerId;
    original: number;
    compressed: number;
    technique: CompressionTechnique;
  }>;
  readonly omittedLayers: ReadonlyArray<LayerId>;
  readonly degraded: boolean;
  readonly durationMs: number;
}
