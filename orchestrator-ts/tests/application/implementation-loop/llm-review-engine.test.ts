/**
 * Unit tests for LlmReviewEngineService (Task 3.2)
 *
 * Tests cover:
 * - All checks pass → ReviewResult.outcome = "passed", feedback array empty
 * - One required LLM check fails → outcome = "failed", correct feedback item present
 * - Advisory check fails → outcome = "passed", advisory feedback item present
 * - LLM call throws → review result captures error, does not propagate exception
 * - ReviewFeedbackItem category and severity correctly mapped from LLM output
 *
 * Requirements: 3.2, 3.3, 3.5, 3.6, 6.2, 6.3
 */
import { LlmReviewEngineService } from "@/application/implementation-loop/llm-review-engine";
import type { AgentLoopResult } from "@/application/ports/agent-loop";
import type { QualityGateConfig } from "@/application/ports/implementation-loop";
import type { IQualityGate } from "@/application/ports/implementation-loop";
import type { LlmProviderPort, LlmResult } from "@/application/ports/llm";
import type { ReviewCheckResult } from "@/domain/implementation-loop/types";
import type { Task } from "@/domain/planning/types";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSection(overrides: Partial<Task> = {}): Task {
  return {
    id: "section-1",
    title: "Implement feature X",
    status: "pending",
    steps: [],
    ...overrides,
  };
}

function makeAgentLoopResult(overrides: Partial<AgentLoopResult> = {}): AgentLoopResult {
  return {
    terminationCondition: "TASK_COMPLETED",
    finalState: {
      task: "Implement feature X",
      plan: [],
      completedSteps: [],
      currentStep: null,
      iterationCount: 1,
      observations: [],
      recoveryAttempts: 0,
      startedAt: new Date().toISOString(),
    },
    totalIterations: 1,
    taskCompleted: true,
    ...overrides,
  };
}

function makeEmptyGateConfig(): QualityGateConfig {
  return { checks: [] };
}

/** Creates an LLM provider that returns a passing JSON response. */
function makePassingLlm(): LlmProviderPort {
  return {
    async complete(_prompt: string): Promise<LlmResult> {
      return {
        ok: true,
        value: {
          content: JSON.stringify({
            passed: true,
            feedback: [],
          }),
          usage: { inputTokens: 10, outputTokens: 20 },
        },
      };
    },
    clearContext() {},
  };
}

/** Creates an LLM provider that returns a failing JSON response with feedback. */
function makeFailingLlm(category: string, description: string): LlmProviderPort {
  return {
    async complete(_prompt: string): Promise<LlmResult> {
      return {
        ok: true,
        value: {
          content: JSON.stringify({
            passed: false,
            feedback: [{ category, description, severity: "blocking" }],
          }),
          usage: { inputTokens: 10, outputTokens: 30 },
        },
      };
    },
    clearContext() {},
  };
}

/** Creates an LLM provider that returns an advisory failure. */
function makeAdvisoryFailingLlm(): LlmProviderPort {
  return {
    async complete(_prompt: string): Promise<LlmResult> {
      return {
        ok: true,
        value: {
          content: JSON.stringify({
            passed: true,
            feedback: [
              {
                category: "requirement-alignment",
                description: "Minor naming inconsistency",
                severity: "advisory",
              },
            ],
          }),
          usage: { inputTokens: 10, outputTokens: 25 },
        },
      };
    },
    clearContext() {},
  };
}

/** Creates an LLM provider that fails with a network error. */
function makeErrorLlm(): LlmProviderPort {
  return {
    async complete(_prompt: string): Promise<LlmResult> {
      return {
        ok: false,
        error: {
          category: "network",
          message: "Connection refused",
          originalError: new Error("Connection refused"),
        },
      };
    },
    clearContext() {},
  };
}

/** Creates an LLM provider that throws unexpectedly. */
function makeThrowingLlm(): LlmProviderPort {
  return {
    async complete(_prompt: string): Promise<never> {
      throw new Error("Unexpected crash in LLM provider");
    },
    clearContext() {},
  };
}

/** Creates a NoopQualityGate-like stub returning fixed results. */
function makeGateWithResults(results: ReadonlyArray<ReviewCheckResult>): IQualityGate {
  return {
    async run(_config: QualityGateConfig): Promise<ReadonlyArray<ReviewCheckResult>> {
      return results;
    },
  };
}

function makePassingGate(): IQualityGate {
  return makeGateWithResults([]);
}

function makeFailingRequiredGate(): IQualityGate {
  return makeGateWithResults([
    {
      checkName: "lint",
      outcome: "failed",
      required: true,
      details: "3 lint errors found",
    },
  ]);
}

function makeFailingAdvisoryGate(): IQualityGate {
  return makeGateWithResults([
    {
      checkName: "naming-check",
      outcome: "failed",
      required: false,
      details: "Some naming warnings",
    },
  ]);
}

// ---------------------------------------------------------------------------
// All checks pass
// ---------------------------------------------------------------------------

describe("LlmReviewEngineService — all checks pass", () => {
  it("returns outcome: passed when both LLM checks and quality gate pass", async () => {
    const llm = makePassingLlm();
    const gate = makePassingGate();
    const service = new LlmReviewEngineService(llm, gate);

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    expect(result.outcome).toBe("passed");
  });

  it("returns empty feedback when all checks pass without issues", async () => {
    const llm = makePassingLlm();
    const gate = makePassingGate();
    const service = new LlmReviewEngineService(llm, gate);

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    // Feedback may be empty or contain only advisory items; no blocking items
    const blockingItems = result.feedback.filter((f) => f.severity === "blocking");
    expect(blockingItems).toHaveLength(0);
  });

  it("returns durationMs as a non-negative number", async () => {
    const service = new LlmReviewEngineService(makePassingLlm(), makePassingGate());

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Required LLM check fails
// ---------------------------------------------------------------------------

describe("LlmReviewEngineService — required LLM check fails", () => {
  it("returns outcome: failed when requirement alignment LLM check fails", async () => {
    const llm = makeFailingLlm("requirement-alignment", "Missing error handling as specified in req 3.4");
    const gate = makePassingGate();
    const service = new LlmReviewEngineService(llm, gate);

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    expect(result.outcome).toBe("failed");
  });

  it("includes blocking feedback item with correct category on LLM failure", async () => {
    const llm = makeFailingLlm("requirement-alignment", "Missing error handling");
    const gate = makePassingGate();
    const service = new LlmReviewEngineService(llm, gate);

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    const blockingItems = result.feedback.filter((f) => f.severity === "blocking");
    expect(blockingItems.length).toBeGreaterThan(0);
    expect(blockingItems[0]?.category).toBe("requirement-alignment");
  });

  it("returns outcome: failed when design consistency LLM check fails", async () => {
    const llm = makeFailingLlm("design-consistency", "Implementation does not follow adapter pattern");
    const gate = makePassingGate();
    const service = new LlmReviewEngineService(llm, gate);

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    expect(result.outcome).toBe("failed");
  });

  it("returns outcome: failed when required quality gate check fails", async () => {
    const llm = makePassingLlm();
    const gate = makeFailingRequiredGate();
    const service = new LlmReviewEngineService(llm, gate);

    const gateConfig: QualityGateConfig = {
      checks: [{ name: "lint", command: "bun run lint", required: true }],
    };

    const result = await service.review(makeAgentLoopResult(), makeSection(), gateConfig);

    expect(result.outcome).toBe("failed");
  });

  it("includes code-quality blocking feedback item when required gate check fails", async () => {
    const llm = makePassingLlm();
    const gate = makeFailingRequiredGate();
    const service = new LlmReviewEngineService(llm, gate);

    const gateConfig: QualityGateConfig = {
      checks: [{ name: "lint", command: "bun run lint", required: true }],
    };

    const result = await service.review(makeAgentLoopResult(), makeSection(), gateConfig);

    const codeQualityItems = result.feedback.filter((f) => f.category === "code-quality");
    expect(codeQualityItems.length).toBeGreaterThan(0);
    expect(codeQualityItems[0]?.severity).toBe("blocking");
  });

  it("populates checks array with gate check results", async () => {
    const llm = makePassingLlm();
    const gate = makeFailingRequiredGate();
    const service = new LlmReviewEngineService(llm, gate);

    const gateConfig: QualityGateConfig = {
      checks: [{ name: "lint", command: "bun run lint", required: true }],
    };

    const result = await service.review(makeAgentLoopResult(), makeSection(), gateConfig);

    expect(result.checks.length).toBeGreaterThan(0);
    const lintCheck = result.checks.find((c) => c.checkName === "lint");
    expect(lintCheck).toBeDefined();
    expect(lintCheck?.outcome).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Advisory check fails — outcome stays passed
// ---------------------------------------------------------------------------

describe("LlmReviewEngineService — advisory check failure", () => {
  it("returns outcome: passed when only advisory LLM feedback is present", async () => {
    const llm = makeAdvisoryFailingLlm();
    const gate = makePassingGate();
    const service = new LlmReviewEngineService(llm, gate);

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    expect(result.outcome).toBe("passed");
  });

  it("includes advisory feedback item when advisory check fails", async () => {
    const llm = makeAdvisoryFailingLlm();
    const gate = makePassingGate();
    const service = new LlmReviewEngineService(llm, gate);

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    const advisoryItems = result.feedback.filter((f) => f.severity === "advisory");
    expect(advisoryItems.length).toBeGreaterThan(0);
  });

  it("returns outcome: passed when only advisory quality gate check fails", async () => {
    const llm = makePassingLlm();
    const gate = makeFailingAdvisoryGate();
    const service = new LlmReviewEngineService(llm, gate);

    const gateConfig: QualityGateConfig = {
      checks: [{ name: "naming-check", command: "bun run check-names", required: false }],
    };

    const result = await service.review(makeAgentLoopResult(), makeSection(), gateConfig);

    expect(result.outcome).toBe("passed");
  });

  it("includes advisory feedback item for failed advisory gate check", async () => {
    const llm = makePassingLlm();
    const gate = makeFailingAdvisoryGate();
    const service = new LlmReviewEngineService(llm, gate);

    const gateConfig: QualityGateConfig = {
      checks: [{ name: "naming-check", command: "bun run check-names", required: false }],
    };

    const result = await service.review(makeAgentLoopResult(), makeSection(), gateConfig);

    const advisoryItems = result.feedback.filter(
      (f) => f.severity === "advisory" && f.category === "code-quality",
    );
    expect(advisoryItems.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LLM call failure / exception
// ---------------------------------------------------------------------------

describe("LlmReviewEngineService — LLM call failure", () => {
  it("returns outcome: failed when LLM returns an error result, does not throw", async () => {
    const llm = makeErrorLlm();
    const gate = makePassingGate();
    const service = new LlmReviewEngineService(llm, gate);

    // Must not throw
    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    expect(result.outcome).toBe("failed");
  });

  it("includes feedback item describing the LLM error", async () => {
    const llm = makeErrorLlm();
    const gate = makePassingGate();
    const service = new LlmReviewEngineService(llm, gate);

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    expect(result.feedback.length).toBeGreaterThan(0);
    const errorItem = result.feedback[0];
    expect(errorItem?.severity).toBe("blocking");
  });

  it("returns outcome: failed when LLM provider throws unexpectedly, does not propagate", async () => {
    const llm = makeThrowingLlm();
    const gate = makePassingGate();
    const service = new LlmReviewEngineService(llm, gate);

    // Must not throw
    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    expect(result.outcome).toBe("failed");
  });

  it("still includes gate check results when LLM call fails", async () => {
    const llm = makeErrorLlm();
    const gate = makeGateWithResults([
      { checkName: "lint", outcome: "passed", required: true, details: "OK" },
    ]);
    const service = new LlmReviewEngineService(llm, gate);

    const gateConfig: QualityGateConfig = {
      checks: [{ name: "lint", command: "bun run lint", required: true }],
    };

    const result = await service.review(makeAgentLoopResult(), makeSection(), gateConfig);

    // Gate results are still captured
    expect(result.checks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ReviewFeedbackItem category and severity mapping
// ---------------------------------------------------------------------------

describe("LlmReviewEngineService — feedback category and severity mapping", () => {
  it("maps requirement-alignment category from LLM response", async () => {
    const llm = makeFailingLlm("requirement-alignment", "Does not handle edge case");
    const service = new LlmReviewEngineService(llm, makePassingGate());

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    const item = result.feedback.find((f) => f.category === "requirement-alignment");
    expect(item).toBeDefined();
  });

  it("maps design-consistency category from LLM response", async () => {
    const llm = makeFailingLlm("design-consistency", "Violates layered architecture");
    const service = new LlmReviewEngineService(llm, makePassingGate());

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    const item = result.feedback.find((f) => f.category === "design-consistency");
    expect(item).toBeDefined();
  });

  it("maps code-quality category from failed gate check result", async () => {
    const llm = makePassingLlm();
    const gate = makeFailingRequiredGate();
    const service = new LlmReviewEngineService(llm, gate);

    const gateConfig: QualityGateConfig = {
      checks: [{ name: "lint", command: "bun run lint", required: true }],
    };

    const result = await service.review(makeAgentLoopResult(), makeSection(), gateConfig);

    const item = result.feedback.find((f) => f.category === "code-quality");
    expect(item).toBeDefined();
  });

  it("assigns blocking severity to required failing checks", async () => {
    const llm = makeFailingLlm("requirement-alignment", "Critical missing behavior");
    const service = new LlmReviewEngineService(llm, makePassingGate());

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    const item = result.feedback.find((f) => f.category === "requirement-alignment");
    expect(item?.severity).toBe("blocking");
  });

  it("assigns advisory severity to advisory checks", async () => {
    const llm = makeAdvisoryFailingLlm();
    const service = new LlmReviewEngineService(llm, makePassingGate());

    const result = await service.review(makeAgentLoopResult(), makeSection(), makeEmptyGateConfig());

    const item = result.feedback.find((f) => f.severity === "advisory");
    expect(item).toBeDefined();
  });
});
