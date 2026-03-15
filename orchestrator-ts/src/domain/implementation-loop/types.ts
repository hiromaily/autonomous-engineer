import type { Observation } from "@/domain/agent/types";

// ---------------------------------------------------------------------------
// ReviewFeedbackItem — structured feedback from a review pass
// ---------------------------------------------------------------------------

export type ReviewFeedbackCategory =
  | "requirement-alignment"
  | "design-consistency"
  | "code-quality";

export type ReviewFeedbackSeverity = "blocking" | "advisory";

export type ReviewFeedbackItem = Readonly<{
  category: ReviewFeedbackCategory;
  description: string;
  severity: ReviewFeedbackSeverity;
}>;

// ---------------------------------------------------------------------------
// ReviewCheckResult — result of a single quality gate check
// ---------------------------------------------------------------------------

export type ReviewOutcome = "passed" | "failed";

export type ReviewCheckResult = Readonly<{
  checkName: string;
  outcome: ReviewOutcome;
  required: boolean;
  details: string;
}>;

// ---------------------------------------------------------------------------
// ReviewResult — output of a single IReviewEngine invocation
// ---------------------------------------------------------------------------

export type ReviewResult = Readonly<{
  outcome: ReviewOutcome;
  checks: ReadonlyArray<ReviewCheckResult>;
  feedback: ReadonlyArray<ReviewFeedbackItem>;
  durationMs: number;
}>;

// ---------------------------------------------------------------------------
// SectionExecutionStatus — discriminated union for section lifecycle state
// ---------------------------------------------------------------------------

export type SectionExecutionStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "escalated-to-human";

/** Frozen tuple of all valid SectionExecutionStatus values. */
export const SECTION_EXECUTION_STATUSES = Object.freeze(
  [
    "pending",
    "in_progress",
    "completed",
    "failed",
    "escalated-to-human",
  ] as const satisfies ReadonlyArray<SectionExecutionStatus>,
);

// ---------------------------------------------------------------------------
// SectionIterationRecord — log of a single implement-review-improve attempt
// ---------------------------------------------------------------------------

export type SectionIterationRecord = Readonly<{
  /** 1-based iteration counter for this section. */
  iterationNumber: number;
  /** Result of the review engine evaluation for this iteration. */
  reviewResult: ReviewResult;
  /** Improvement directive constructed from review feedback, if this was a retry. */
  improvePrompt?: string;
  /** Elapsed time from iteration start to terminal state (ms). */
  durationMs: number;
  /** ISO 8601 timestamp for when this iteration was recorded. */
  timestamp: string;
}>;

// ---------------------------------------------------------------------------
// SectionSummary — compact reference to a completed section
// ---------------------------------------------------------------------------

export type SectionSummary = Readonly<{
  sectionId: string;
  title: string;
  /** Git commit SHA produced when this section was completed. */
  commitSha?: string;
}>;

// ---------------------------------------------------------------------------
// SectionExecutionRecord — immutable per-section execution state snapshot
// ---------------------------------------------------------------------------

export type SectionExecutionRecord = Readonly<{
  sectionId: string;
  planId: string;
  title: string;
  status: SectionExecutionStatus;
  /** Number of implement-review cycles attempted for this section. */
  retryCount: number;
  /** Ordered log of all implement-review-improve attempts. */
  iterations: ReadonlyArray<SectionIterationRecord>;
  /** ISO 8601 timestamp for when execution of this section began. */
  startedAt: string;
  /** ISO 8601 timestamp for when this section reached a terminal state. */
  completedAt?: string;
  /** Git commit SHA produced on successful completion. */
  commitSha?: string;
  /** Human-readable summary when section was escalated. */
  escalationSummary?: string;
}>;

// ---------------------------------------------------------------------------
// ImplementationLoopState — cross-section persistent state
// ---------------------------------------------------------------------------

export type ImplementationLoopState = Readonly<{
  planId: string;
  featureBranchName: string;
  /** Ordered list of summaries for all sections that have reached "completed" status. */
  completedSectionSummaries: ReadonlyArray<SectionSummary>;
  /** ISO 8601 timestamp for when the implementation loop started. */
  startedAt: string;
}>;

// ---------------------------------------------------------------------------
// SectionEscalation — value object passed to ISelfHealingLoop
// ---------------------------------------------------------------------------

export type SectionEscalation = Readonly<{
  sectionId: string;
  planId: string;
  retryHistory: ReadonlyArray<SectionIterationRecord>;
  reviewFeedback: ReadonlyArray<ReviewFeedbackItem>;
  /** Agent loop observations accumulated across all retry attempts. */
  agentObservations: ReadonlyArray<Observation>;
}>;

// ---------------------------------------------------------------------------
// SelfHealingOutcome — result of ISelfHealingLoop.escalate()
// ---------------------------------------------------------------------------

export type SelfHealingOutcome = "resolved" | "unresolved";

export type SelfHealingResult = Readonly<{
  outcome: SelfHealingOutcome;
  /** Updated rules to inject into context on "resolved" outcome. */
  updatedRules?: ReadonlyArray<string>;
  /** Human-readable summary of the self-healing analysis. */
  summary: string;
}>;

// ---------------------------------------------------------------------------
// ImplementationLoopEvent — discriminated union of all lifecycle events
// ---------------------------------------------------------------------------

export type ImplementationLoopEvent =
  | Readonly<{ type: "section:start"; sectionId: string; timestamp: string }>
  | Readonly<{ type: "section:completed"; sectionId: string; commitSha: string; durationMs: number }>
  | Readonly<{ type: "section:review-passed"; sectionId: string; iteration: number }>
  | Readonly<{
    type: "section:review-failed";
    sectionId: string;
    iteration: number;
    feedback: ReadonlyArray<ReviewFeedbackItem>;
  }>
  | Readonly<{ type: "section:improve-start"; sectionId: string; iteration: number }>
  | Readonly<{ type: "section:escalated"; sectionId: string; retryCount: number; reason: string }>
  | Readonly<{
    type: "plan:completed";
    planId: string;
    completedSections: ReadonlyArray<string>;
    durationMs: number;
  }>
  | Readonly<{ type: "plan:halted"; planId: string; haltingSectionId: string; summary: string }>;
