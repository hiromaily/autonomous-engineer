// ---------------------------------------------------------------------------
// Shared primitive types
// ---------------------------------------------------------------------------

export type LayerId =
  | "systemInstructions"
  | "taskDescription"
  | "activeSpecification"
  | "codeContext"
  | "repositoryState"
  | "memoryRetrieval"
  | "toolResults";

export type StepType = "Exploration" | "Modification" | "Validation";

// ---------------------------------------------------------------------------
// IContextPlanner — value objects
// ---------------------------------------------------------------------------

export interface ToolResultEntry {
  readonly toolName: string;
  readonly content: string;
}

export interface PlannerDecision {
  readonly layersToRetrieve: ReadonlyArray<LayerId>;
  readonly codeContextQuery?: {
    readonly paths: ReadonlyArray<string>;
    readonly pattern?: string;
  };
  readonly memoryQuery?: { readonly text: string; readonly topN: number };
  readonly specSections?: ReadonlyArray<string>;
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// IContextPlanner — domain port
// ---------------------------------------------------------------------------

export interface IContextPlanner {
  /**
   * Map step type and task context to a structured retrieval plan.
   * Pure function — no I/O.
   */
  plan(
    stepType: StepType,
    taskDescription: string,
    previousToolResults: ReadonlyArray<ToolResultEntry>,
  ): PlannerDecision;
}

// ---------------------------------------------------------------------------
// ILayerCompressor — value objects
// ---------------------------------------------------------------------------

export type CompressionTechnique =
  | "spec_extraction"
  | "code_skeleton"
  | "memory_score_filter"
  | "truncation";

export interface CompressionResult {
  readonly compressed: string;
  readonly tokenCount: number;
  readonly technique: CompressionTechnique;
  readonly originalTokenCount: number;
}

// ---------------------------------------------------------------------------
// ILayerCompressor — domain port
// ---------------------------------------------------------------------------

export interface ILayerCompressor {
  /**
   * Compress `content` to fit within `budget` tokens.
   * Layer type determines which technique is applied.
   * Returns the original content unchanged when layerId is `systemInstructions`
   * or `taskDescription`.
   */
  compress(
    layerId: LayerId,
    content: string,
    budget: number,
    tokenCounter: (text: string) => number,
  ): CompressionResult;
}

// ---------------------------------------------------------------------------
// ITokenBudgetManager — value objects
// ---------------------------------------------------------------------------

export interface LayerBudgetConfig {
  readonly systemInstructions: number; // default: 1000
  readonly taskDescription: number; // default: 500
  readonly activeSpecification: number; // default: 2000
  readonly codeContext: number; // default: 4000
  readonly repositoryState: number; // default: 500
  readonly memoryRetrieval: number; // default: 1500
  readonly toolResults: number; // default: 2000
}

export interface TokenBudgetConfig {
  readonly layerBudgets: LayerBudgetConfig;
  readonly modelTokenLimit: number;
  readonly safetyBufferFraction: number; // default: 0.05
}

export interface LayerBudgetMap {
  readonly budgets: Readonly<Record<LayerId, number>>;
  readonly totalBudget: number;
}

// ---------------------------------------------------------------------------
// ITokenBudgetManager — domain port
// ---------------------------------------------------------------------------

export interface ITokenBudgetManager {
  /** Count tokens in text using cl100k_base encoding. */
  countTokens(text: string): number;

  /** Compute per-layer budgets scaled to the model token limit. */
  allocate(config: TokenBudgetConfig): LayerBudgetMap;

  /** Check if content fits in budget; returns tokens over budget or 0 if within. */
  checkBudget(content: string, budget: number): { tokensUsed: number; overBy: number };

  /** Sum all layer token counts. Returns overage (positive) or headroom (negative). */
  checkTotal(
    layerTokenCounts: ReadonlyArray<{ layerId: LayerId; tokens: number }>,
    totalBudget: number,
  ): number;
}
