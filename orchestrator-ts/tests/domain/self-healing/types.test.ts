import type {
  GapReport,
  MemoryWriteAction,
  RootCauseAnalysis,
  SelfHealingFailureRecord,
  SelfHealingLogEntry,
} from "@/domain/self-healing/types";
import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// RootCauseAnalysis — parsed LLM output for analysis step
// ---------------------------------------------------------------------------

describe("RootCauseAnalysis", () => {
  test("constructs with all three required fields", () => {
    const analysis: RootCauseAnalysis = {
      attemptsNarrative: "Attempted to implement auth handler three times",
      failureNarrative: "Each time the token validation threw TypeError",
      recurringPattern: "Missing null check on token before validation",
    };

    expect(analysis.attemptsNarrative).toBe("Attempted to implement auth handler three times");
    expect(analysis.failureNarrative).toBe("Each time the token validation threw TypeError");
    expect(analysis.recurringPattern).toBe("Missing null check on token before validation");
  });

  test("all fields are string values", () => {
    const analysis: RootCauseAnalysis = {
      attemptsNarrative: "attempt",
      failureNarrative: "failure",
      recurringPattern: "pattern",
    };

    expect(typeof analysis.attemptsNarrative).toBe("string");
    expect(typeof analysis.failureNarrative).toBe("string");
    expect(typeof analysis.recurringPattern).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// GapReport — parsed LLM output for gap identification step
// ---------------------------------------------------------------------------

describe("GapReport", () => {
  test("constructs with targetFile, proposedChange, and rationale", () => {
    const report: GapReport = {
      targetFile: "coding_rules",
      proposedChange: "Always check for null before calling .validate() on tokens",
      rationale: "The recurring TypeError is caused by missing null checks before token validation",
    };

    expect(report.targetFile).toBe("coding_rules");
    expect(report.proposedChange).toBe(
      "Always check for null before calling .validate() on tokens",
    );
    expect(report.rationale).toContain("null checks");
  });

  test("accepts all supported KnowledgeMemoryFile target values", () => {
    const targets: GapReport["targetFile"][] = [
      "coding_rules",
      "review_rules",
      "implementation_patterns",
      "debugging_patterns",
    ];

    for (const targetFile of targets) {
      const report: GapReport = {
        targetFile,
        proposedChange: "some change",
        rationale: "some rationale",
      };
      expect(report.targetFile).toBe(targetFile);
    }
  });
});

// ---------------------------------------------------------------------------
// SelfHealingLogEntry — discriminated union of all seven entry shapes
// ---------------------------------------------------------------------------

describe("SelfHealingLogEntry — escalation-intake", () => {
  test("constructs with base fields and retryHistoryCount", () => {
    const entry: SelfHealingLogEntry = {
      type: "escalation-intake",
      sectionId: "sec-1",
      planId: "plan-abc",
      timestamp: "2026-03-15T12:00:00.000Z",
      retryHistoryCount: 3,
    };

    expect(entry.type).toBe("escalation-intake");
    expect(entry.sectionId).toBe("sec-1");
    expect(entry.planId).toBe("plan-abc");
    expect(entry.timestamp).toBe("2026-03-15T12:00:00.000Z");
    if (entry.type === "escalation-intake") {
      expect(entry.retryHistoryCount).toBe(3);
    }
  });
});

describe("SelfHealingLogEntry — analysis-complete", () => {
  test("constructs with base fields and recurringPattern", () => {
    const entry: SelfHealingLogEntry = {
      type: "analysis-complete",
      sectionId: "sec-1",
      planId: "plan-abc",
      timestamp: "2026-03-15T12:01:00.000Z",
      recurringPattern: "Missing null check pattern",
    };

    expect(entry.type).toBe("analysis-complete");
    if (entry.type === "analysis-complete") {
      expect(entry.recurringPattern).toBe("Missing null check pattern");
    }
  });
});

describe("SelfHealingLogEntry — gap-identified", () => {
  test("constructs with base fields and targetFile", () => {
    const entry: SelfHealingLogEntry = {
      type: "gap-identified",
      sectionId: "sec-1",
      planId: "plan-abc",
      timestamp: "2026-03-15T12:02:00.000Z",
      targetFile: "review_rules",
    };

    expect(entry.type).toBe("gap-identified");
    if (entry.type === "gap-identified") {
      expect(entry.targetFile).toBe("review_rules");
    }
  });
});

describe("SelfHealingLogEntry — rule-updated", () => {
  test("constructs with targetFile and memoryWriteAction", () => {
    const entry: SelfHealingLogEntry = {
      type: "rule-updated",
      sectionId: "sec-1",
      planId: "plan-abc",
      timestamp: "2026-03-15T12:03:00.000Z",
      targetFile: "implementation_patterns",
      memoryWriteAction: "appended",
    };

    expect(entry.type).toBe("rule-updated");
    if (entry.type === "rule-updated") {
      expect(entry.targetFile).toBe("implementation_patterns");
      expect(entry.memoryWriteAction).toBe("appended");
    }
  });

  test("accepts all valid memoryWriteAction values", () => {
    const actions: MemoryWriteAction[] = [
      "appended",
      "updated",
      "skipped_duplicate",
    ];

    for (const memoryWriteAction of actions) {
      const entry: SelfHealingLogEntry = {
        type: "rule-updated",
        sectionId: "sec-1",
        planId: "plan-abc",
        timestamp: "2026-03-15T12:03:00.000Z",
        targetFile: "coding_rules",
        memoryWriteAction,
      };
      if (entry.type === "rule-updated") {
        expect(entry.memoryWriteAction).toBe(memoryWriteAction);
      }
    }
  });
});

describe("SelfHealingLogEntry — retry-initiated", () => {
  test("constructs with only base fields", () => {
    const entry: SelfHealingLogEntry = {
      type: "retry-initiated",
      sectionId: "sec-1",
      planId: "plan-abc",
      timestamp: "2026-03-15T12:04:00.000Z",
    };

    expect(entry.type).toBe("retry-initiated");
    expect(entry.sectionId).toBe("sec-1");
    expect(entry.planId).toBe("plan-abc");
  });
});

describe("SelfHealingLogEntry — self-healing-resolved", () => {
  test("constructs with updatedRules and totalDurationMs", () => {
    const entry: SelfHealingLogEntry = {
      type: "self-healing-resolved",
      sectionId: "sec-1",
      planId: "plan-abc",
      timestamp: "2026-03-15T12:05:00.000Z",
      updatedRules: [".kiro/steering/coding_rules.md"],
      totalDurationMs: 45000,
    };

    expect(entry.type).toBe("self-healing-resolved");
    if (entry.type === "self-healing-resolved") {
      expect(entry.updatedRules).toHaveLength(1);
      expect(entry.totalDurationMs).toBe(45000);
    }
  });

  test("accepts empty updatedRules array", () => {
    const entry: SelfHealingLogEntry = {
      type: "self-healing-resolved",
      sectionId: "sec-1",
      planId: "plan-abc",
      timestamp: "2026-03-15T12:05:00.000Z",
      updatedRules: [],
      totalDurationMs: 1000,
    };

    if (entry.type === "self-healing-resolved") {
      expect(entry.updatedRules).toHaveLength(0);
    }
  });
});

describe("SelfHealingLogEntry — unresolved", () => {
  test("constructs with stopStep and totalDurationMs", () => {
    const entry: SelfHealingLogEntry = {
      type: "unresolved",
      sectionId: "sec-1",
      planId: "plan-abc",
      timestamp: "2026-03-15T12:06:00.000Z",
      stopStep: "root-cause-analysis",
      totalDurationMs: 62000,
    };

    expect(entry.type).toBe("unresolved");
    if (entry.type === "unresolved") {
      expect(entry.stopStep).toBe("root-cause-analysis");
      expect(entry.totalDurationMs).toBe(62000);
    }
  });
});

describe("SelfHealingLogEntry — exhaustive switch coverage", () => {
  test("switch on type covers all seven entry shapes", () => {
    const getLabel = (entry: SelfHealingLogEntry): string => {
      switch (entry.type) {
        case "escalation-intake":
          return `intake:${entry.retryHistoryCount}`;
        case "analysis-complete":
          return `analysis:${entry.recurringPattern}`;
        case "gap-identified":
          return `gap:${entry.targetFile}`;
        case "rule-updated":
          return `rule:${entry.targetFile}:${entry.memoryWriteAction}`;
        case "retry-initiated":
          return `retry:${entry.sectionId}`;
        case "self-healing-resolved":
          return `resolved:${entry.totalDurationMs}ms`;
        case "unresolved":
          return `unresolved:${entry.stopStep}`;
        case "system-error":
          return `system-error:${entry.component}`;
      }
    };

    const intake: SelfHealingLogEntry = {
      type: "escalation-intake",
      sectionId: "s",
      planId: "p",
      timestamp: "2026-03-15T00:00:00.000Z",
      retryHistoryCount: 2,
    };
    expect(getLabel(intake)).toBe("intake:2");

    const unresolved: SelfHealingLogEntry = {
      type: "unresolved",
      sectionId: "s",
      planId: "p",
      timestamp: "2026-03-15T00:00:00.000Z",
      stopStep: "gap-identification",
      totalDurationMs: 5000,
    };
    expect(getLabel(unresolved)).toBe("unresolved:gap-identification");
  });
});

// ---------------------------------------------------------------------------
// SelfHealingFailureRecord — internal record before MemoryPort mapping
// ---------------------------------------------------------------------------

describe("SelfHealingFailureRecord", () => {
  test("constructs a resolved record with all fields", () => {
    const record: SelfHealingFailureRecord = {
      sectionId: "sec-1",
      planId: "plan-abc",
      rootCause: "Missing null check on token before validation",
      gapIdentified: {
        targetFile: "coding_rules",
        proposedChange: "Always check for null before calling .validate()",
        rationale: "Recurring TypeError from missing null guard",
      },
      ruleFilesUpdated: [".kiro/steering/coding_rules.md"],
      outcome: "resolved",
      truncated: false,
      timestamp: "2026-03-15T12:05:00.000Z",
    };

    expect(record.sectionId).toBe("sec-1");
    expect(record.planId).toBe("plan-abc");
    expect(record.rootCause).toBe("Missing null check on token before validation");
    expect(record.gapIdentified).not.toBeNull();
    expect(record.ruleFilesUpdated).toHaveLength(1);
    expect(record.outcome).toBe("resolved");
    expect(record.truncated).toBe(false);
  });

  test("constructs an unresolved record with null rootCause and gapIdentified", () => {
    const record: SelfHealingFailureRecord = {
      sectionId: "sec-2",
      planId: "plan-abc",
      rootCause: null,
      gapIdentified: null,
      ruleFilesUpdated: [],
      outcome: "unresolved",
      truncated: false,
      timestamp: "2026-03-15T12:06:00.000Z",
    };

    expect(record.rootCause).toBeNull();
    expect(record.gapIdentified).toBeNull();
    expect(record.outcome).toBe("unresolved");
  });

  test("truncated flag is true when agentObservations were trimmed", () => {
    const record: SelfHealingFailureRecord = {
      sectionId: "sec-3",
      planId: "plan-abc",
      rootCause: "Some root cause",
      gapIdentified: null,
      ruleFilesUpdated: [],
      outcome: "unresolved",
      truncated: true,
      timestamp: "2026-03-15T12:07:00.000Z",
    };

    expect(record.truncated).toBe(true);
  });

  test("accepts empty ruleFilesUpdated for unresolved outcomes", () => {
    const record: SelfHealingFailureRecord = {
      sectionId: "sec-4",
      planId: "plan-abc",
      rootCause: "Analysis timed out",
      gapIdentified: null,
      ruleFilesUpdated: [],
      outcome: "unresolved",
      truncated: false,
      timestamp: "2026-03-15T12:08:00.000Z",
    };

    expect(record.ruleFilesUpdated).toHaveLength(0);
  });

  test("timestamp is ISO 8601 format", () => {
    const record: SelfHealingFailureRecord = {
      sectionId: "sec-5",
      planId: "plan-abc",
      rootCause: null,
      gapIdentified: null,
      ruleFilesUpdated: [],
      outcome: "unresolved",
      truncated: false,
      timestamp: "2026-03-15T12:00:00.000Z",
    };

    // Basic ISO 8601 format check
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
