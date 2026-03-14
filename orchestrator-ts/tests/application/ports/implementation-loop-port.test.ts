import type { AgentLoopResult } from "@/application/ports/agent-loop";
import type {
  ExecutionHaltSummary,
  IImplementationLoop,
  IImplementationLoopEventBus,
  IImplementationLoopLogger,
  IPlanStore,
  IQualityGate,
  IReviewEngine,
  ISelfHealingLoop,
  ImplementationLoopOptions,
  ImplementationLoopOutcome,
  ImplementationLoopResult,
  QualityGateCheck,
  QualityGateConfig,
  SectionIterationLogEntry,
  SectionPersistenceStatus,
} from "@/application/ports/implementation-loop";
import type { Task, TaskPlan } from "@/domain/planning/types";
import type {
  ImplementationLoopEvent,
  ReviewFeedbackItem,
  ReviewResult,
  SectionEscalation,
  SectionExecutionRecord,
  SelfHealingResult,
} from "@/domain/implementation-loop/types";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: "plan-abc",
    goal: "Build the feature",
    tasks: [],
    createdAt: "2026-03-14T00:00:00.000Z",
    updatedAt: "2026-03-14T00:00:00.000Z",
    ...overrides,
  };
}

function makeSection(overrides: Partial<Task> = {}): Task {
  return {
    id: "sec-1",
    title: "Implement auth module",
    status: "pending",
    steps: [],
    ...overrides,
  };
}

function makeRecord(overrides: Partial<SectionExecutionRecord> = {}): SectionExecutionRecord {
  return {
    sectionId: "sec-1",
    planId: "plan-abc",
    title: "Implement auth module",
    status: "pending",
    retryCount: 0,
    iterations: [],
    startedAt: "2026-03-14T10:00:00.000Z",
    ...overrides,
  };
}

function makeReviewResult(outcome: "passed" | "failed" = "passed"): ReviewResult {
  return {
    outcome,
    checks: [],
    feedback: [],
    durationMs: 100,
  };
}

function makeAgentLoopResult(): AgentLoopResult {
  return {
    terminationCondition: "TASK_COMPLETED",
    finalState: {
      task: "implement auth",
      plan: [],
      completedSteps: [],
      currentStep: null,
      iterationCount: 1,
      observations: [],
      recoveryAttempts: 0,
      startedAt: "2026-03-14T10:00:00.000Z",
    },
    totalIterations: 1,
    taskCompleted: true,
  };
}

// ---------------------------------------------------------------------------
// Task 1.2: IImplementationLoop port and supporting types
// ---------------------------------------------------------------------------

describe("ImplementationLoopOptions shape", () => {
  it("accepts an options object with all required fields and defaults", () => {
    const options: ImplementationLoopOptions = {
      maxRetriesPerSection: 3,
      qualityGateConfig: { checks: [] },
    };

    expect(options.maxRetriesPerSection).toBe(3);
    expect(options.qualityGateConfig.checks).toHaveLength(0);
    expect(options.selfHealingLoop).toBeUndefined();
    expect(options.eventBus).toBeUndefined();
    expect(options.logger).toBeUndefined();
  });

  it("accepts optional selfHealingLoop, eventBus, and logger", () => {
    const mockSelfHealing: ISelfHealingLoop = {
      async escalate(_esc): Promise<SelfHealingResult> {
        return { outcome: "unresolved", summary: "Could not resolve" };
      },
    };

    const options: ImplementationLoopOptions = {
      maxRetriesPerSection: 3,
      qualityGateConfig: { checks: [] },
      selfHealingLoop: mockSelfHealing,
    };

    expect(options.selfHealingLoop).toBe(mockSelfHealing);
  });
});

describe("ImplementationLoopOutcome type", () => {
  it("accepts all five outcome variants", () => {
    const outcomes: ImplementationLoopOutcome[] = [
      "completed",
      "section-failed",
      "human-intervention-required",
      "stopped",
      "plan-not-found",
    ];

    expect(outcomes).toHaveLength(5);
    expect(outcomes).toContain("completed");
    expect(outcomes).toContain("section-failed");
    expect(outcomes).toContain("human-intervention-required");
    expect(outcomes).toContain("stopped");
    expect(outcomes).toContain("plan-not-found");
  });
});

describe("ImplementationLoopResult shape", () => {
  it("accepts a completed result with all sections", () => {
    const result: ImplementationLoopResult = {
      outcome: "completed",
      planId: "plan-abc",
      sections: [makeRecord({ status: "completed" })],
      durationMs: 120000,
    };

    expect(result.outcome).toBe("completed");
    expect(result.sections).toHaveLength(1);
    expect(result.haltReason).toBeUndefined();
  });

  it("accepts a section-failed result with haltReason", () => {
    const result: ImplementationLoopResult = {
      outcome: "section-failed",
      planId: "plan-abc",
      sections: [makeRecord({ status: "failed" })],
      durationMs: 60000,
      haltReason: "Section sec-1 failed after 3 retries",
    };

    expect(result.outcome).toBe("section-failed");
    expect(result.haltReason).toContain("sec-1");
  });

  it("accepts a plan-not-found result with empty sections", () => {
    const result: ImplementationLoopResult = {
      outcome: "plan-not-found",
      planId: "plan-xyz",
      sections: [],
      durationMs: 0,
      haltReason: "Plan plan-xyz not found in store",
    };

    expect(result.outcome).toBe("plan-not-found");
    expect(result.sections).toHaveLength(0);
  });
});

describe("IImplementationLoop contract (mock implementation)", () => {
  it("run() returns an ImplementationLoopResult without throwing", async () => {
    const loop: IImplementationLoop = {
      async run(planId): Promise<ImplementationLoopResult> {
        return {
          outcome: "completed",
          planId,
          sections: [],
          durationMs: 1000,
        };
      },
      async resume(planId): Promise<ImplementationLoopResult> {
        return {
          outcome: "completed",
          planId,
          sections: [],
          durationMs: 500,
        };
      },
      stop(): void {},
    };

    const result = await loop.run("plan-abc");
    expect(result.outcome).toBe("completed");
    expect(result.planId).toBe("plan-abc");
  });

  it("resume() returns a result for the given planId", async () => {
    const loop: IImplementationLoop = {
      async run(planId): Promise<ImplementationLoopResult> {
        return { outcome: "completed", planId, sections: [], durationMs: 0 };
      },
      async resume(planId): Promise<ImplementationLoopResult> {
        return { outcome: "completed", planId, sections: [], durationMs: 200 };
      },
      stop(): void {},
    };

    const result = await loop.resume("plan-abc");
    expect(result.planId).toBe("plan-abc");
    expect(result.durationMs).toBe(200);
  });

  it("stop() can be called without arguments", () => {
    let stopped = false;
    const loop: IImplementationLoop = {
      async run(planId): Promise<ImplementationLoopResult> {
        return { outcome: "stopped", planId, sections: [], durationMs: 0 };
      },
      async resume(planId): Promise<ImplementationLoopResult> {
        return { outcome: "stopped", planId, sections: [], durationMs: 0 };
      },
      stop(): void {
        stopped = true;
      },
    };

    loop.stop();
    expect(stopped).toBe(true);
  });

  it("run() can accept partial options", async () => {
    let capturedOptions: Partial<ImplementationLoopOptions> | undefined;

    const loop: IImplementationLoop = {
      async run(planId, options): Promise<ImplementationLoopResult> {
        capturedOptions = options;
        return { outcome: "completed", planId, sections: [], durationMs: 0 };
      },
      async resume(planId): Promise<ImplementationLoopResult> {
        return { outcome: "completed", planId, sections: [], durationMs: 0 };
      },
      stop(): void {},
    };

    await loop.run("plan-abc", { maxRetriesPerSection: 5 });
    expect(capturedOptions?.maxRetriesPerSection).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Task 1.3: IReviewEngine and IQualityGate port interfaces
// ---------------------------------------------------------------------------

describe("IReviewEngine contract (mock implementation)", () => {
  it("review() returns a passed ReviewResult without throwing", async () => {
    const engine: IReviewEngine = {
      async review(_result, _section, _config): Promise<ReviewResult> {
        return makeReviewResult("passed");
      },
    };

    const result = await engine.review(makeAgentLoopResult(), makeSection(), { checks: [] });
    expect(result.outcome).toBe("passed");
  });

  it("review() returns a failed result with feedback items", async () => {
    const feedbackItems: ReviewFeedbackItem[] = [
      { category: "requirement-alignment", description: "Missing feature", severity: "blocking" },
    ];

    const engine: IReviewEngine = {
      async review(): Promise<ReviewResult> {
        return {
          outcome: "failed",
          checks: [],
          feedback: feedbackItems,
          durationMs: 500,
        };
      },
    };

    const result = await engine.review(makeAgentLoopResult(), makeSection(), { checks: [] });
    expect(result.outcome).toBe("failed");
    expect(result.feedback).toHaveLength(1);
    expect(result.feedback[0]?.severity).toBe("blocking");
  });

  it("review() never throws — LLM errors surface as failed result", async () => {
    const engine: IReviewEngine = {
      async review(): Promise<ReviewResult> {
        // Simulates error captured as failed result (never throws)
        return {
          outcome: "failed",
          checks: [],
          feedback: [{ category: "code-quality", description: "LLM call failed", severity: "blocking" }],
          durationMs: 0,
        };
      },
    };

    await expect(engine.review(makeAgentLoopResult(), makeSection(), { checks: [] })).resolves.toBeDefined();
  });
});

describe("IQualityGate contract (mock implementation)", () => {
  it("run() returns one ReviewCheckResult per configured check", async () => {
    const gate: IQualityGate = {
      async run(config): Promise<readonly import("@/domain/implementation-loop/types").ReviewCheckResult[]> {
        return config.checks.map((check) => ({
          checkName: check.name,
          outcome: "passed" as const,
          required: check.required,
          details: "OK",
        }));
      },
    };

    const config: QualityGateConfig = {
      checks: [
        { name: "lint", command: "bun run lint", required: true },
        { name: "test", command: "bun test", required: true },
      ],
    };

    const results = await gate.run(config);
    expect(results).toHaveLength(2);
    expect(results[0]?.checkName).toBe("lint");
    expect(results[1]?.checkName).toBe("test");
  });

  it("run() marks required check as failed when command exits non-zero", async () => {
    const gate: IQualityGate = {
      async run(config): Promise<readonly import("@/domain/implementation-loop/types").ReviewCheckResult[]> {
        return config.checks.map((check) => ({
          checkName: check.name,
          outcome: check.required ? ("failed" as const) : ("passed" as const),
          required: check.required,
          details: check.required ? "Exit code 1" : "OK",
        }));
      },
    };

    const config: QualityGateConfig = {
      checks: [{ name: "lint", command: "bun run lint", required: true }],
    };

    const results = await gate.run(config);
    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.required).toBe(true);
    expect(results[0]?.details).toContain("Exit code 1");
  });

  it("advisory check failure does not affect required check result", async () => {
    const gate: IQualityGate = {
      async run(config): Promise<readonly import("@/domain/implementation-loop/types").ReviewCheckResult[]> {
        return config.checks.map((check) => ({
          checkName: check.name,
          // Advisory checks can fail independently
          outcome: "failed" as const,
          required: check.required,
          details: "Advisory failure",
        }));
      },
    };

    const config: QualityGateConfig = {
      checks: [{ name: "naming-check", command: "bun run naming", required: false }],
    };

    const results = await gate.run(config);
    expect(results[0]?.required).toBe(false);
    expect(results[0]?.outcome).toBe("failed");
  });
});

describe("QualityGateCheck shape", () => {
  it("accepts required fields with optional workingDirectory", () => {
    const check: QualityGateCheck = {
      name: "lint",
      command: "bun run lint",
      required: true,
    };
    expect(check.workingDirectory).toBeUndefined();

    const checkWithDir: QualityGateCheck = {
      name: "test",
      command: "bun test",
      required: false,
      workingDirectory: "./orchestrator-ts",
    };
    expect(checkWithDir.workingDirectory).toBe("./orchestrator-ts");
  });
});

describe("QualityGateConfig shape", () => {
  it("accepts a config with a readonly array of checks", () => {
    const config: QualityGateConfig = {
      checks: [
        { name: "lint", command: "bun run lint", required: true },
        { name: "test", command: "bun test", required: false },
      ],
    };
    expect(config.checks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Task 1.4: IPlanStore port interface
// ---------------------------------------------------------------------------

describe("SectionPersistenceStatus type", () => {
  it("accepts all five status values including escalated-to-human", () => {
    const statuses: SectionPersistenceStatus[] = [
      "pending",
      "in_progress",
      "completed",
      "failed",
      "escalated-to-human",
    ];
    expect(statuses).toHaveLength(5);
    expect(statuses).toContain("escalated-to-human");
  });
});

describe("IPlanStore contract (mock implementation)", () => {
  it("loadPlan() returns a TaskPlan when the plan exists", async () => {
    const plan = makePlan();
    const store: IPlanStore = {
      async loadPlan(): Promise<TaskPlan | null> {
        return plan;
      },
      async updateSectionStatus(): Promise<void> {},
    };

    const loaded = await store.loadPlan("plan-abc");
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe("plan-abc");
  });

  it("loadPlan() returns null when the plan does not exist", async () => {
    const store: IPlanStore = {
      async loadPlan(): Promise<TaskPlan | null> {
        return null;
      },
      async updateSectionStatus(): Promise<void> {},
    };

    const loaded = await store.loadPlan("non-existent");
    expect(loaded).toBeNull();
  });

  it("updateSectionStatus() is called with planId, sectionId, and status", async () => {
    const calls: { planId: string; sectionId: string; status: SectionPersistenceStatus }[] = [];

    const store: IPlanStore = {
      async loadPlan(): Promise<TaskPlan | null> {
        return null;
      },
      async updateSectionStatus(planId, sectionId, status): Promise<void> {
        calls.push({ planId, sectionId, status });
      },
    };

    await store.updateSectionStatus("plan-abc", "sec-1", "completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.planId).toBe("plan-abc");
    expect(calls[0]?.sectionId).toBe("sec-1");
    expect(calls[0]?.status).toBe("completed");
  });

  it("updateSectionStatus() supports all five status values", async () => {
    const statuses: SectionPersistenceStatus[] = [];

    const store: IPlanStore = {
      async loadPlan(): Promise<TaskPlan | null> {
        return null;
      },
      async updateSectionStatus(_planId, _sectionId, status): Promise<void> {
        statuses.push(status);
      },
    };

    await store.updateSectionStatus("p", "s", "pending");
    await store.updateSectionStatus("p", "s", "in_progress");
    await store.updateSectionStatus("p", "s", "completed");
    await store.updateSectionStatus("p", "s", "failed");
    await store.updateSectionStatus("p", "s", "escalated-to-human");

    expect(statuses).toHaveLength(5);
    expect(statuses).toContain("escalated-to-human");
  });
});

// ---------------------------------------------------------------------------
// Task 1.5: IImplementationLoopLogger and IImplementationLoopEventBus
// ---------------------------------------------------------------------------

describe("SectionIterationLogEntry shape", () => {
  it("accepts all required fields with optional commitSha", () => {
    const entry: SectionIterationLogEntry = {
      planId: "plan-abc",
      sectionId: "sec-1",
      iterationNumber: 1,
      reviewOutcome: "passed",
      gateCheckResults: [],
      durationMs: 5000,
      timestamp: "2026-03-14T10:01:00.000Z",
    };

    expect(entry.planId).toBe("plan-abc");
    expect(entry.iterationNumber).toBe(1);
    expect(entry.reviewOutcome).toBe("passed");
    expect(entry.commitSha).toBeUndefined();
  });

  it("accepts optional commitSha for successful iterations", () => {
    const entry: SectionIterationLogEntry = {
      planId: "plan-abc",
      sectionId: "sec-1",
      iterationNumber: 2,
      reviewOutcome: "passed",
      gateCheckResults: [],
      commitSha: "abc1234",
      durationMs: 8000,
      timestamp: "2026-03-14T10:02:00.000Z",
    };

    expect(entry.commitSha).toBe("abc1234");
  });
});

describe("ExecutionHaltSummary shape", () => {
  it("accepts all required fields", () => {
    const summary: ExecutionHaltSummary = {
      planId: "plan-abc",
      completedSections: ["sec-1"],
      committedSections: ["sec-1"],
      haltingSectionId: "sec-2",
      reason: "Section sec-2 exceeded max retries",
      timestamp: "2026-03-14T10:30:00.000Z",
    };

    expect(summary.planId).toBe("plan-abc");
    expect(summary.completedSections).toHaveLength(1);
    expect(summary.haltingSectionId).toBe("sec-2");
  });
});

describe("IImplementationLoopLogger contract (mock implementation)", () => {
  it("logIteration() receives a SectionIterationLogEntry", () => {
    const logged: SectionIterationLogEntry[] = [];

    const logger: IImplementationLoopLogger = {
      logIteration(entry): void {
        logged.push(entry);
      },
      logSectionComplete(): void {},
      logHaltSummary(): void {},
    };

    const entry: SectionIterationLogEntry = {
      planId: "plan-abc",
      sectionId: "sec-1",
      iterationNumber: 1,
      reviewOutcome: "passed",
      gateCheckResults: [],
      durationMs: 5000,
      timestamp: "2026-03-14T10:01:00.000Z",
    };

    logger.logIteration(entry);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.iterationNumber).toBe(1);
  });

  it("logSectionComplete() receives a SectionExecutionRecord", () => {
    const records: SectionExecutionRecord[] = [];

    const logger: IImplementationLoopLogger = {
      logIteration(): void {},
      logSectionComplete(record): void {
        records.push(record);
      },
      logHaltSummary(): void {},
    };

    logger.logSectionComplete(makeRecord({ status: "completed" }));
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("completed");
  });

  it("logHaltSummary() receives an ExecutionHaltSummary", () => {
    const summaries: ExecutionHaltSummary[] = [];

    const logger: IImplementationLoopLogger = {
      logIteration(): void {},
      logSectionComplete(): void {},
      logHaltSummary(summary): void {
        summaries.push(summary);
      },
    };

    const summary: ExecutionHaltSummary = {
      planId: "plan-abc",
      completedSections: [],
      committedSections: [],
      haltingSectionId: "sec-1",
      reason: "Max retries exceeded",
      timestamp: "2026-03-14T10:00:00.000Z",
    };

    logger.logHaltSummary(summary);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.reason).toBe("Max retries exceeded");
  });

  it("all logger methods can be called safely without side effects", () => {
    const noopLogger: IImplementationLoopLogger = {
      logIteration(): void {},
      logSectionComplete(): void {},
      logHaltSummary(): void {},
    };

    expect(() => {
      noopLogger.logIteration({
        planId: "p",
        sectionId: "s",
        iterationNumber: 1,
        reviewOutcome: "failed",
        gateCheckResults: [],
        durationMs: 0,
        timestamp: "2026-03-14T00:00:00.000Z",
      });
      noopLogger.logSectionComplete(makeRecord());
      noopLogger.logHaltSummary({
        planId: "p",
        completedSections: [],
        committedSections: [],
        haltingSectionId: "s",
        reason: "test",
        timestamp: "2026-03-14T00:00:00.000Z",
      });
    }).not.toThrow();
  });
});

describe("IImplementationLoopEventBus contract (mock implementation)", () => {
  it("emit() delivers section:start events", () => {
    const received: ImplementationLoopEvent[] = [];

    const bus: IImplementationLoopEventBus = {
      emit(event): void {
        received.push(event);
      },
    };

    bus.emit({ type: "section:start", sectionId: "sec-1", timestamp: "2026-03-14T10:00:00.000Z" });
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("section:start");
  });

  it("emit() can be called with any ImplementationLoopEvent variant", () => {
    const events: ImplementationLoopEvent[] = [];
    const bus: IImplementationLoopEventBus = {
      emit(event): void {
        events.push(event);
      },
    };

    bus.emit({ type: "section:start", sectionId: "s1", timestamp: "t" });
    bus.emit({ type: "section:completed", sectionId: "s1", commitSha: "abc", durationMs: 100 });
    bus.emit({ type: "section:review-passed", sectionId: "s1", iteration: 1 });
    bus.emit({ type: "section:review-failed", sectionId: "s1", iteration: 1, feedback: [] });
    bus.emit({ type: "section:improve-start", sectionId: "s1", iteration: 2 });
    bus.emit({ type: "section:escalated", sectionId: "s1", retryCount: 3, reason: "max retries" });
    bus.emit({ type: "plan:completed", planId: "p1", completedSections: ["s1"], durationMs: 5000 });
    bus.emit({ type: "plan:halted", planId: "p1", haltingSectionId: "s1", summary: "halt" });

    expect(events).toHaveLength(8);
  });

  it("emit() with no side effects (no-op bus) does not throw", () => {
    const noopBus: IImplementationLoopEventBus = {
      emit(): void {},
    };

    expect(() => {
      noopBus.emit({ type: "plan:completed", planId: "p", completedSections: [], durationMs: 0 });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 1.6: ISelfHealingLoop port interface
// ---------------------------------------------------------------------------

describe("ISelfHealingLoop contract (mock implementation)", () => {
  it("escalate() returns a SelfHealingResult without throwing", async () => {
    const selfHealing: ISelfHealingLoop = {
      async escalate(): Promise<SelfHealingResult> {
        return { outcome: "resolved", updatedRules: ["Rule 1"], summary: "Fixed" };
      },
    };

    const escalation: SectionEscalation = {
      sectionId: "sec-1",
      planId: "plan-abc",
      retryHistory: [],
      reviewFeedback: [],
      agentObservations: [],
    };

    const result = await selfHealing.escalate(escalation);
    expect(result.outcome).toBe("resolved");
    expect(result.updatedRules).toHaveLength(1);
  });

  it("escalate() returns unresolved outcome when self-healing cannot fix the issue", async () => {
    const selfHealing: ISelfHealingLoop = {
      async escalate(): Promise<SelfHealingResult> {
        return { outcome: "unresolved", summary: "Root cause not identified" };
      },
    };

    const escalation: SectionEscalation = {
      sectionId: "sec-2",
      planId: "plan-abc",
      retryHistory: [],
      reviewFeedback: [
        { category: "requirement-alignment", description: "Unclear requirement", severity: "blocking" },
      ],
      agentObservations: [],
    };

    const result = await selfHealing.escalate(escalation);
    expect(result.outcome).toBe("unresolved");
    expect(result.updatedRules).toBeUndefined();
    expect(result.summary).toBe("Root cause not identified");
  });

  it("escalate() receives full retry history and review feedback", async () => {
    const captured: { escalation: SectionEscalation | null } = { escalation: null };

    const selfHealing: ISelfHealingLoop = {
      async escalate(escalation): Promise<SelfHealingResult> {
        captured.escalation = escalation;
        return { outcome: "unresolved", summary: "n/a" };
      },
    };

    const escalation: SectionEscalation = {
      sectionId: "sec-3",
      planId: "plan-abc",
      retryHistory: [],
      reviewFeedback: [
        { category: "code-quality", description: "Missing null checks", severity: "blocking" },
      ],
      agentObservations: [],
    };

    await selfHealing.escalate(escalation);
    if (!captured.escalation) throw new Error("escalation should have been captured");
    expect(captured.escalation.sectionId).toBe("sec-3");
    expect(captured.escalation.reviewFeedback).toHaveLength(1);
  });
});
