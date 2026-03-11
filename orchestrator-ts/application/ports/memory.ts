import type { WorkflowPhase } from '../../domain/workflow/types';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type MemoryErrorCategory = 'io_error' | 'invalid_entry' | 'not_found';

export interface MemoryError {
  readonly category: MemoryErrorCategory;
  readonly message: string;
}

export type MemoryWriteAction = 'appended' | 'updated' | 'skipped_duplicate';

export type MemoryWriteResult =
  | { readonly ok: true;  readonly action: MemoryWriteAction }
  | { readonly ok: false; readonly error: MemoryError };

// ---------------------------------------------------------------------------
// Short-Term Memory (in-process, ephemeral)
// ---------------------------------------------------------------------------

export interface TaskProgress {
  readonly taskId: string;
  readonly completedSteps: readonly string[];
  readonly currentStep?: string | undefined;
}

export interface ShortTermState {
  readonly currentSpec?: string | undefined;
  readonly currentPhase?: WorkflowPhase | undefined;
  readonly taskProgress?: TaskProgress | undefined;
  readonly recentFiles: readonly string[];
}

export interface ShortTermMemoryPort {
  /** Return current ephemeral state (never throws). */
  read(): ShortTermState;
  /** Merge update into current state (partial update semantics). */
  write(update: Partial<ShortTermState>): void;
  /** Reset all state to initial empty values. */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Persistent Memory Types
// ---------------------------------------------------------------------------

/** Discriminant shared by MemoryTarget and MemoryQuery.memoryTypes. */
export type MemoryLayerType = 'project' | 'knowledge';

export type ProjectMemoryFile =
  | 'project_rules'
  | 'coding_patterns'
  | 'review_feedback'
  | 'architecture_notes';

export type KnowledgeMemoryFile =
  | 'coding_rules'
  | 'review_rules'
  | 'implementation_patterns'
  | 'debugging_patterns';

export type MemoryTarget =
  | { readonly type: 'project';   readonly file: ProjectMemoryFile }
  | { readonly type: 'knowledge'; readonly file: KnowledgeMemoryFile };

export type MemoryWriteTrigger =
  | 'implementation_pattern'
  | 'review_feedback'
  | 'debugging_discovery'
  | 'self_healing';

export interface MemoryEntry {
  readonly title: string;
  readonly context: string;
  readonly description: string;
  readonly date: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Query Types
// ---------------------------------------------------------------------------

export interface MemoryQuery {
  readonly text: string;
  /** Filter to specific memory layer types. Defaults to both if omitted. */
  readonly memoryTypes?: ReadonlyArray<MemoryLayerType>;
  /** Maximum results to return. Defaults to 5. */
  readonly topN?: number;
}

export interface RankedMemoryEntry {
  readonly entry: MemoryEntry;
  readonly sourceFile: string;
  readonly relevanceScore: number;
}

export interface MemoryQueryResult {
  readonly entries: readonly RankedMemoryEntry[];
}

// ---------------------------------------------------------------------------
// Failure Records
// ---------------------------------------------------------------------------

export interface FailureRecord {
  readonly taskId: string;
  readonly specName: string;
  readonly phase: WorkflowPhase;
  readonly attempted: string;
  readonly errors: readonly string[];
  readonly rootCause: string;
  readonly ruleUpdate?: string | undefined;
  readonly timestamp: string; // ISO 8601
}

export interface FailureFilter {
  readonly specName?: string | undefined;
  readonly taskId?: string | undefined;
}

// ---------------------------------------------------------------------------
// Unified MemoryPort Interface
// ---------------------------------------------------------------------------

export interface MemoryPort {
  /** Access synchronous in-process short-term memory. */
  readonly shortTerm: ShortTermMemoryPort;

  /** Keyword-ranked retrieval from project and/or knowledge memory. */
  query(query: MemoryQuery): Promise<MemoryQueryResult>;

  /**
   * Append a new entry to the target memory file.
   * Deduplicates by title (case-insensitive). Returns skipped_duplicate if already present.
   */
  append(
    target: MemoryTarget,
    entry: MemoryEntry,
    trigger: MemoryWriteTrigger,
  ): Promise<MemoryWriteResult>;

  /**
   * Update an existing entry by title in the target file.
   * Used exclusively by the self-healing rule update path.
   * Returns not_found error if entry title does not exist.
   */
  update(
    target: MemoryTarget,
    entryTitle: string,
    entry: MemoryEntry,
  ): Promise<MemoryWriteResult>;

  /** Write a structured failure record atomically to .memory/failures/. */
  writeFailure(record: FailureRecord): Promise<MemoryWriteResult>;

  /** Return all failure records, optionally filtered. Never throws. */
  getFailures(filter?: FailureFilter): Promise<readonly FailureRecord[]>;
}
