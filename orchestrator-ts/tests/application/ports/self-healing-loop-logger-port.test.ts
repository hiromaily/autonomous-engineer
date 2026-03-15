import type { ISelfHealingLoopLogger } from "@/application/ports/self-healing-loop-logger";
import type {
  AnalysisCompleteLogEntry,
  EscalationIntakeLogEntry,
  GapIdentifiedLogEntry,
  RuleUpdatedLogEntry,
  SelfHealingLogEntry,
  SelfHealingResolvedLogEntry,
  UnresolvedLogEntry,
} from "@/domain/self-healing/types";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEscalationIntake(overrides: Partial<EscalationIntakeLogEntry> = {}): EscalationIntakeLogEntry {
  return {
    type: "escalation-intake",
    sectionId: "sec-1",
    planId: "plan-abc",
    timestamp: "2026-03-15T00:00:00.000Z",
    retryHistoryCount: 3,
    ...overrides,
  };
}

function makeAnalysisComplete(overrides: Partial<AnalysisCompleteLogEntry> = {}): AnalysisCompleteLogEntry {
  return {
    type: "analysis-complete",
    sectionId: "sec-1",
    planId: "plan-abc",
    timestamp: "2026-03-15T00:01:00.000Z",
    recurringPattern: "type mismatch in output shape",
    ...overrides,
  };
}

function makeGapIdentified(overrides: Partial<GapIdentifiedLogEntry> = {}): GapIdentifiedLogEntry {
  return {
    type: "gap-identified",
    sectionId: "sec-1",
    planId: "plan-abc",
    timestamp: "2026-03-15T00:02:00.000Z",
    targetFile: "coding_rules",
    ...overrides,
  };
}

function makeRuleUpdated(overrides: Partial<RuleUpdatedLogEntry> = {}): RuleUpdatedLogEntry {
  return {
    type: "rule-updated",
    sectionId: "sec-1",
    planId: "plan-abc",
    timestamp: "2026-03-15T00:03:00.000Z",
    targetFile: "coding_rules",
    memoryWriteAction: "appended",
    ...overrides,
  };
}

function makeSelfHealingResolved(overrides: Partial<SelfHealingResolvedLogEntry> = {}): SelfHealingResolvedLogEntry {
  return {
    type: "self-healing-resolved",
    sectionId: "sec-1",
    planId: "plan-abc",
    timestamp: "2026-03-15T00:04:00.000Z",
    updatedRules: ["coding_rules"],
    totalDurationMs: 4000,
    ...overrides,
  };
}

function makeUnresolved(overrides: Partial<UnresolvedLogEntry> = {}): UnresolvedLogEntry {
  return {
    type: "unresolved",
    sectionId: "sec-1",
    planId: "plan-abc",
    timestamp: "2026-03-15T00:04:00.000Z",
    stopStep: "root-cause-analysis",
    totalDurationMs: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task 2.1: ISelfHealingLoopLogger port interface
// ---------------------------------------------------------------------------

describe("ISelfHealingLoopLogger contract (mock implementation)", () => {
  it("log() accepts all seven SelfHealingLogEntry variants without throwing", () => {
    const logged: SelfHealingLogEntry[] = [];

    const logger: ISelfHealingLoopLogger = {
      log(entry: SelfHealingLogEntry): void {
        logged.push(entry);
      },
    };

    logger.log(makeEscalationIntake());
    logger.log(makeAnalysisComplete());
    logger.log(makeGapIdentified());
    logger.log(makeRuleUpdated());
    logger.log({ type: "retry-initiated", sectionId: "sec-1", planId: "plan-abc", timestamp: "t" });
    logger.log(makeSelfHealingResolved());
    logger.log(makeUnresolved());

    expect(logged).toHaveLength(7);
  });

  it("log() receives escalation-intake entry with retryHistoryCount", () => {
    const logged: SelfHealingLogEntry[] = [];
    const logger: ISelfHealingLoopLogger = { log: (e: SelfHealingLogEntry) => void logged.push(e) };

    const entry = makeEscalationIntake({ retryHistoryCount: 5 });
    logger.log(entry);

    expect(logged[0]?.type).toBe("escalation-intake");
    expect((logged[0] as EscalationIntakeLogEntry).retryHistoryCount).toBe(5);
  });

  it("log() receives analysis-complete entry with recurringPattern", () => {
    const logged: SelfHealingLogEntry[] = [];
    const logger: ISelfHealingLoopLogger = { log: (e: SelfHealingLogEntry) => void logged.push(e) };

    const entry = makeAnalysisComplete({ recurringPattern: "null pointer in handler" });
    logger.log(entry);

    expect(logged[0]?.type).toBe("analysis-complete");
    expect((logged[0] as AnalysisCompleteLogEntry).recurringPattern).toBe("null pointer in handler");
  });

  it("log() receives gap-identified entry with targetFile", () => {
    const logged: SelfHealingLogEntry[] = [];
    const logger: ISelfHealingLoopLogger = { log: (e: SelfHealingLogEntry) => void logged.push(e) };

    const entry = makeGapIdentified({ targetFile: "review_rules" });
    logger.log(entry);

    expect((logged[0] as GapIdentifiedLogEntry).targetFile).toBe("review_rules");
  });

  it("log() receives rule-updated entry with targetFile and memoryWriteAction", () => {
    const logged: SelfHealingLogEntry[] = [];
    const logger: ISelfHealingLoopLogger = { log: (e: SelfHealingLogEntry) => void logged.push(e) };

    const entry = makeRuleUpdated({ memoryWriteAction: "updated" });
    logger.log(entry);

    expect((logged[0] as RuleUpdatedLogEntry).memoryWriteAction).toBe("updated");
  });

  it("log() receives self-healing-resolved entry with updatedRules and totalDurationMs", () => {
    const logged: SelfHealingLogEntry[] = [];
    const logger: ISelfHealingLoopLogger = { log: (e: SelfHealingLogEntry) => void logged.push(e) };

    const entry = makeSelfHealingResolved({ updatedRules: ["coding_rules", "review_rules"], totalDurationMs: 8500 });
    logger.log(entry);

    expect((logged[0] as SelfHealingResolvedLogEntry).updatedRules).toHaveLength(2);
    expect((logged[0] as SelfHealingResolvedLogEntry).totalDurationMs).toBe(8500);
  });

  it("log() receives unresolved entry with stopStep and totalDurationMs", () => {
    const logged: SelfHealingLogEntry[] = [];
    const logger: ISelfHealingLoopLogger = { log: (e: SelfHealingLogEntry) => void logged.push(e) };

    const entry = makeUnresolved({ stopStep: "gap-identification", totalDurationMs: 2000 });
    logger.log(entry);

    expect((logged[0] as UnresolvedLogEntry).stopStep).toBe("gap-identification");
    expect((logged[0] as UnresolvedLogEntry).totalDurationMs).toBe(2000);
  });

  it("a no-op logger implementation does not throw", () => {
    const noopLogger: ISelfHealingLoopLogger = {
      log(): void {},
    };

    expect(() => {
      noopLogger.log(makeEscalationIntake());
      noopLogger.log(makeAnalysisComplete());
      noopLogger.log(makeUnresolved());
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Optionality guarantee: service never fails when logger is absent
// ---------------------------------------------------------------------------

describe("ISelfHealingLoopLogger optionality", () => {
  it("calling log() on an optional logger only when defined does not throw", () => {
    let logger: ISelfHealingLoopLogger | undefined;

    // This pattern mirrors how SelfHealingLoopService uses the optional logger
    expect(() => {
      logger?.log(makeEscalationIntake());
    }).not.toThrow();

    logger = { log: () => {} };
    expect(() => {
      logger?.log(makeEscalationIntake());
    }).not.toThrow();
  });
});
