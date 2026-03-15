import type {
  ImplementationLoopEvent,
  ImplementationLoopState,
  ReviewFeedbackItem,
  ReviewResult,
  SectionEscalation,
  SectionExecutionRecord,
  SectionExecutionStatus,
  SectionIterationRecord,
  SectionSummary,
  SelfHealingOutcome,
  SelfHealingResult,
} from "@/domain/implementation-loop/types";
import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// SectionExecutionStatus — discriminated union
// ---------------------------------------------------------------------------

describe("SectionExecutionStatus", () => {
  test("accepts all five valid status values", () => {
    const statuses: SectionExecutionStatus[] = [
      "pending",
      "in_progress",
      "completed",
      "failed",
      "escalated-to-human",
    ];
    expect(statuses).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// SectionExecutionRecord — immutable snapshot
// ---------------------------------------------------------------------------

describe("SectionExecutionRecord", () => {
  test("constructs a minimal record with required fields", () => {
    const record: SectionExecutionRecord = {
      sectionId: "sec-1",
      planId: "plan-abc",
      title: "Implement auth module",
      status: "pending",
      retryCount: 0,
      iterations: [],
      startedAt: "2026-03-14T10:00:00.000Z",
    };

    expect(record.sectionId).toBe("sec-1");
    expect(record.planId).toBe("plan-abc");
    expect(record.title).toBe("Implement auth module");
    expect(record.status).toBe("pending");
    expect(record.retryCount).toBe(0);
    expect(record.iterations).toHaveLength(0);
  });

  test("accepts optional fields: completedAt, commitSha, escalationSummary", () => {
    const record: SectionExecutionRecord = {
      sectionId: "sec-2",
      planId: "plan-abc",
      title: "Write tests",
      status: "completed",
      retryCount: 1,
      iterations: [],
      startedAt: "2026-03-14T10:00:00.000Z",
      completedAt: "2026-03-14T10:05:00.000Z",
      commitSha: "abc1234",
    };

    expect(record.completedAt).toBe("2026-03-14T10:05:00.000Z");
    expect(record.commitSha).toBe("abc1234");
    expect(record.escalationSummary).toBeUndefined();
  });

  test("accepts escalatedToHuman status with escalation summary", () => {
    const record: SectionExecutionRecord = {
      sectionId: "sec-3",
      planId: "plan-abc",
      title: "Fix complex bug",
      status: "escalated-to-human",
      retryCount: 3,
      iterations: [],
      startedAt: "2026-03-14T10:00:00.000Z",
      escalationSummary: "Exceeded max retries after 3 attempts",
    };

    expect(record.status).toBe("escalated-to-human");
    expect(record.escalationSummary).toBe("Exceeded max retries after 3 attempts");
  });
});

// ---------------------------------------------------------------------------
// SectionIterationRecord — single implement-review-improve attempt log
// ---------------------------------------------------------------------------

describe("SectionIterationRecord", () => {
  test("constructs an iteration record with all required fields", () => {
    const mockReviewResult: ReviewResult = {
      outcome: "passed",
      checks: [],
      feedback: [],
      durationMs: 100,
    };

    const record: SectionIterationRecord = {
      iterationNumber: 1,
      reviewResult: mockReviewResult,
      durationMs: 5000,
      timestamp: "2026-03-14T10:01:00.000Z",
    };

    expect(record.iterationNumber).toBe(1);
    expect(record.reviewResult.outcome).toBe("passed");
    expect(record.durationMs).toBe(5000);
  });

  test("accepts optional improvePrompt", () => {
    const mockReviewResult: ReviewResult = {
      outcome: "failed",
      checks: [],
      feedback: [
        {
          category: "requirement-alignment",
          description: "Missing error handling",
          severity: "blocking",
        },
      ],
      durationMs: 200,
    };

    const record: SectionIterationRecord = {
      iterationNumber: 2,
      reviewResult: mockReviewResult,
      improvePrompt: "Fix the missing error handling identified in the review",
      durationMs: 8000,
      timestamp: "2026-03-14T10:02:00.000Z",
    };

    expect(record.improvePrompt).toBe("Fix the missing error handling identified in the review");
  });
});

// ---------------------------------------------------------------------------
// ImplementationLoopState — cross-section persistent state
// ---------------------------------------------------------------------------

describe("ImplementationLoopState", () => {
  test("constructs state with required fields", () => {
    const state: ImplementationLoopState = {
      planId: "plan-abc",
      featureBranchName: "feature/auth-module",
      completedSectionSummaries: [],
      startedAt: "2026-03-14T10:00:00.000Z",
    };

    expect(state.planId).toBe("plan-abc");
    expect(state.featureBranchName).toBe("feature/auth-module");
    expect(state.completedSectionSummaries).toHaveLength(0);
  });

  test("accumulates section summaries without mutation", () => {
    const initialState: ImplementationLoopState = {
      planId: "plan-abc",
      featureBranchName: "feature/auth-module",
      completedSectionSummaries: [],
      startedAt: "2026-03-14T10:00:00.000Z",
    };

    const summary: SectionSummary = {
      sectionId: "sec-1",
      title: "Implement auth module",
      commitSha: "abc1234",
    };

    // Simulate immutable update (spread operator)
    const updatedState: ImplementationLoopState = {
      ...initialState,
      completedSectionSummaries: [...initialState.completedSectionSummaries, summary],
    };

    expect(initialState.completedSectionSummaries).toHaveLength(0);
    expect(updatedState.completedSectionSummaries).toHaveLength(1);
    expect(updatedState.completedSectionSummaries[0]?.sectionId).toBe("sec-1");
  });
});

// ---------------------------------------------------------------------------
// SectionSummary — value type for completed section reference
// ---------------------------------------------------------------------------

describe("SectionSummary", () => {
  test("accepts optional commitSha", () => {
    const withCommit: SectionSummary = {
      sectionId: "sec-1",
      title: "Auth module",
      commitSha: "abc1234",
    };
    const withoutCommit: SectionSummary = {
      sectionId: "sec-2",
      title: "Tests",
    };

    expect(withCommit.commitSha).toBe("abc1234");
    expect(withoutCommit.commitSha).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ReviewResult — review output value object
// ---------------------------------------------------------------------------

describe("ReviewResult", () => {
  test("constructs a passing review result", () => {
    const result: ReviewResult = {
      outcome: "passed",
      checks: [
        {
          checkName: "lint",
          outcome: "passed",
          required: true,
          details: "No lint errors",
        },
      ],
      feedback: [],
      durationMs: 1500,
    };

    expect(result.outcome).toBe("passed");
    expect(result.checks).toHaveLength(1);
    expect(result.feedback).toHaveLength(0);
  });

  test("constructs a failed review result with blocking feedback", () => {
    const feedbackItem: ReviewFeedbackItem = {
      category: "code-quality",
      description: "Missing type annotations",
      severity: "blocking",
    };

    const result: ReviewResult = {
      outcome: "failed",
      checks: [
        {
          checkName: "typecheck",
          outcome: "failed",
          required: true,
          details: "10 type errors found",
        },
      ],
      feedback: [feedbackItem],
      durationMs: 2000,
    };

    expect(result.outcome).toBe("failed");
    expect(result.feedback[0]?.severity).toBe("blocking");
  });

  test("advisory feedback does not change outcome to failed", () => {
    const advisoryFeedback: ReviewFeedbackItem = {
      category: "design-consistency",
      description: "Consider extracting helper function",
      severity: "advisory",
    };

    const result: ReviewResult = {
      outcome: "passed",
      checks: [],
      feedback: [advisoryFeedback],
      durationMs: 500,
    };

    // Outcome is still "passed" despite advisory feedback
    expect(result.outcome).toBe("passed");
    expect(result.feedback[0]?.severity).toBe("advisory");
  });
});

// ---------------------------------------------------------------------------
// SelfHealingResult — value type for spec10 escalation response
// ---------------------------------------------------------------------------

describe("SelfHealingResult", () => {
  test("resolved outcome with updated rules", () => {
    const result: SelfHealingResult = {
      outcome: "resolved",
      updatedRules: ["Rule 1: Always handle null", "Rule 2: Use explicit return types"],
      summary: "Self-healing resolved by adding null guards",
    };

    expect(result.outcome).toBe("resolved");
    expect(result.updatedRules).toHaveLength(2);
  });

  test("unresolved outcome without updated rules", () => {
    const result: SelfHealingResult = {
      outcome: "unresolved",
      summary: "Could not determine root cause after analysis",
    };

    expect(result.outcome).toBe("unresolved");
    expect(result.updatedRules).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SectionEscalation — value object passed to ISelfHealingLoop
// ---------------------------------------------------------------------------

describe("SectionEscalation", () => {
  test("constructs escalation with all required fields", () => {
    const escalation: SectionEscalation = {
      sectionId: "sec-1",
      planId: "plan-abc",
      retryHistory: [],
      reviewFeedback: [],
      agentObservations: [],
    };

    expect(escalation.sectionId).toBe("sec-1");
    expect(escalation.planId).toBe("plan-abc");
    expect(escalation.retryHistory).toHaveLength(0);
    expect(escalation.reviewFeedback).toHaveLength(0);
    expect(escalation.agentObservations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SelfHealingOutcome — discriminated union
// ---------------------------------------------------------------------------

describe("SelfHealingOutcome", () => {
  test("accepts both valid outcome values", () => {
    const outcomes: SelfHealingOutcome[] = ["resolved", "unresolved"];
    expect(outcomes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ImplementationLoopEvent — discriminated union of all lifecycle events
// ---------------------------------------------------------------------------

describe("ImplementationLoopEvent", () => {
  test("section:start event has sectionId and timestamp", () => {
    const event: ImplementationLoopEvent = {
      type: "section:start",
      sectionId: "sec-1",
      timestamp: "2026-03-14T10:00:00.000Z",
    };

    expect(event.type).toBe("section:start");
    expect(event.sectionId).toBe("sec-1");
  });

  test("section:completed event has commitSha and durationMs", () => {
    const event: ImplementationLoopEvent = {
      type: "section:completed",
      sectionId: "sec-1",
      commitSha: "abc1234",
      durationMs: 30000,
    };

    expect(event.type).toBe("section:completed");
    expect(event.commitSha).toBe("abc1234");
    expect(event.durationMs).toBe(30000);
  });

  test("section:review-passed event has sectionId and iteration", () => {
    const event: ImplementationLoopEvent = {
      type: "section:review-passed",
      sectionId: "sec-1",
      iteration: 1,
    };

    expect(event.type).toBe("section:review-passed");
    expect(event.iteration).toBe(1);
  });

  test("section:review-failed event has feedback array", () => {
    const feedback: ReadonlyArray<ReviewFeedbackItem> = [
      { category: "code-quality", description: "Missing tests", severity: "blocking" },
    ];

    const event: ImplementationLoopEvent = {
      type: "section:review-failed",
      sectionId: "sec-1",
      iteration: 1,
      feedback,
    };

    expect(event.type).toBe("section:review-failed");
    expect(event.feedback).toHaveLength(1);
  });

  test("section:improve-start event has sectionId and iteration", () => {
    const event: ImplementationLoopEvent = {
      type: "section:improve-start",
      sectionId: "sec-1",
      iteration: 2,
    };

    expect(event.type).toBe("section:improve-start");
    expect(event.iteration).toBe(2);
  });

  test("section:escalated event has retryCount and reason", () => {
    const event: ImplementationLoopEvent = {
      type: "section:escalated",
      sectionId: "sec-1",
      retryCount: 3,
      reason: "Max retries exceeded",
    };

    expect(event.type).toBe("section:escalated");
    expect(event.retryCount).toBe(3);
    expect(event.reason).toBe("Max retries exceeded");
  });

  test("plan:completed event has planId, completedSections, and durationMs", () => {
    const event: ImplementationLoopEvent = {
      type: "plan:completed",
      planId: "plan-abc",
      completedSections: ["sec-1", "sec-2"],
      durationMs: 120000,
    };

    expect(event.type).toBe("plan:completed");
    expect(event.completedSections).toHaveLength(2);
  });

  test("plan:halted event has haltingSectionId and summary", () => {
    const event: ImplementationLoopEvent = {
      type: "plan:halted",
      planId: "plan-abc",
      haltingSectionId: "sec-2",
      summary: "Section failed after max retries",
    };

    expect(event.type).toBe("plan:halted");
    expect(event.haltingSectionId).toBe("sec-2");
  });

  test("exhaustive discriminated union type checking via switch", () => {
    const handleEvent = (event: ImplementationLoopEvent): string => {
      switch (event.type) {
        case "section:start":
          return `start:${event.sectionId}`;
        case "section:completed":
          return `completed:${event.sectionId}`;
        case "section:review-passed":
          return `review-passed:${event.sectionId}`;
        case "section:review-failed":
          return `review-failed:${event.sectionId}`;
        case "section:improve-start":
          return `improve-start:${event.sectionId}`;
        case "section:escalated":
          return `escalated:${event.sectionId}`;
        case "plan:completed":
          return `plan-completed:${event.planId}`;
        case "plan:halted":
          return `plan-halted:${event.planId}`;
      }
    };

    const result = handleEvent({
      type: "section:start",
      sectionId: "sec-1",
      timestamp: "2026-03-14T10:00:00.000Z",
    });
    expect(result).toBe("start:sec-1");
  });
});
