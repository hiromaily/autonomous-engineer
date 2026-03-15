// ---------------------------------------------------------------------------
// Self-Healing Domain Types
//
// All types in this file are pure domain types with no external dependencies.
// KnowledgeMemoryFile and MemoryWriteAction are redefined here to avoid
// importing from the application layer (Clean Architecture boundary).
// ---------------------------------------------------------------------------

/**
 * Mirrors KnowledgeMemoryFile from application/ports/memory.ts.
 * Rule files that the self-healing loop may update.
 */
export type KnowledgeMemoryFile =
  | "coding_rules"
  | "review_rules"
  | "implementation_patterns"
  | "debugging_patterns";

/**
 * Mirrors MemoryWriteAction from application/ports/memory.ts.
 * Result of a MemoryPort write call.
 */
export type MemoryWriteAction = "appended" | "updated" | "skipped_duplicate";

// ---------------------------------------------------------------------------
// RootCauseAnalysis — parsed output of the root-cause analysis LLM call
// ---------------------------------------------------------------------------

/**
 * Structured output of the root-cause analysis LLM call.
 * Captures what was attempted, what failed, and the recurring theme.
 *
 * Requirements: 2.2
 */
export interface RootCauseAnalysis {
  readonly attemptsNarrative: string; // what was attempted in each retry
  readonly failureNarrative: string; // what failed each time
  readonly recurringPattern: string; // concise cross-attempt theme
}

// ---------------------------------------------------------------------------
// GapReport — parsed output of the gap-identification LLM call
// ---------------------------------------------------------------------------

/**
 * Structured output of the gap-identification LLM call.
 * Identifies which rule file to update and what change to apply.
 *
 * Requirements: 3.1, 3.2
 */
export interface GapReport {
  readonly targetFile: KnowledgeMemoryFile;
  readonly proposedChange: string; // specific addition or correction text
  readonly rationale: string; // links gap to observed failure pattern
}

// ---------------------------------------------------------------------------
// SelfHealingLogEntry — discriminated union covering all seven log entry shapes
// ---------------------------------------------------------------------------

/** Discriminated union of all log entry type strings. Requirements: 8.1, 8.2 */
export type SelfHealingLogEntryType =
  | "escalation-intake"
  | "analysis-complete"
  | "gap-identified"
  | "rule-updated"
  | "retry-initiated"
  | "self-healing-resolved"
  | "unresolved";

/** Base fields shared by all log entry shapes. Requirements: 8.1, 8.2 */
interface SelfHealingLogEntryBase {
  readonly type: SelfHealingLogEntryType;
  readonly sectionId: string;
  readonly planId: string;
  readonly timestamp: string; // ISO 8601
}

/** Emitted at the start of escalate() intake processing. */
export interface EscalationIntakeLogEntry extends SelfHealingLogEntryBase {
  readonly type: "escalation-intake";
  readonly retryHistoryCount: number;
}

/** Emitted after successful root-cause analysis parse. */
export interface AnalysisCompleteLogEntry extends SelfHealingLogEntryBase {
  readonly type: "analysis-complete";
  readonly recurringPattern: string;
}

/** Emitted after successful gap identification and validation. */
export interface GapIdentifiedLogEntry extends SelfHealingLogEntryBase {
  readonly type: "gap-identified";
  readonly targetFile: KnowledgeMemoryFile;
}

/** Emitted after a successful rule file write via MemoryPort. */
export interface RuleUpdatedLogEntry extends SelfHealingLogEntryBase {
  readonly type: "rule-updated";
  readonly targetFile: KnowledgeMemoryFile;
  readonly memoryWriteAction: MemoryWriteAction;
}

/** Emitted just before the implementation loop restarts the healed section. */
export interface RetryInitiatedLogEntry extends SelfHealingLogEntryBase {
  readonly type: "retry-initiated";
}

/** Emitted as the final log entry on a fully resolved healing path. */
export interface SelfHealingResolvedLogEntry extends SelfHealingLogEntryBase {
  readonly type: "self-healing-resolved";
  readonly updatedRules: ReadonlyArray<string>;
  readonly totalDurationMs: number;
}

/** Emitted as the final log entry when healing cannot resolve the issue. */
export interface UnresolvedLogEntry extends SelfHealingLogEntryBase {
  readonly type: "unresolved";
  readonly stopStep: string;
  readonly totalDurationMs: number;
}

/**
 * Discriminated union of all seven NDJSON log entry shapes emitted by
 * SelfHealingLoopService during an escalate() invocation.
 *
 * Requirements: 8.1, 8.2
 */
export type SelfHealingLogEntry =
  | EscalationIntakeLogEntry
  | AnalysisCompleteLogEntry
  | GapIdentifiedLogEntry
  | RuleUpdatedLogEntry
  | RetryInitiatedLogEntry
  | SelfHealingResolvedLogEntry
  | UnresolvedLogEntry;

// ---------------------------------------------------------------------------
// SelfHealingFailureRecord — internal record before mapping to MemoryPort.FailureRecord
// ---------------------------------------------------------------------------

/**
 * Internal failure record shape constructed by SelfHealingLoopService before
 * mapping to MemoryPort.FailureRecord for persistence.
 * Written for every escalate() invocation regardless of outcome.
 *
 * Requirements: 5.1
 */
export interface SelfHealingFailureRecord {
  readonly sectionId: string;
  readonly planId: string;
  readonly rootCause: string | null;
  readonly gapIdentified: GapReport | null;
  readonly ruleFilesUpdated: ReadonlyArray<string>;
  readonly outcome: "resolved" | "unresolved";
  /** True when agentObservations were truncated to stay within maxRecordSizeBytes. */
  readonly truncated: boolean;
  readonly timestamp: string; // ISO 8601
}
