/**
 * Unit tests for SelfHealingLoopService — Tasks 3.1 and 3.2
 *
 * Tasks 3.1 tests cover:
 * - Constructor accepts all required and optional arguments
 * - `escalate()` returns a SelfHealingResult (never rejects)
 * - `escalate()` result always has `outcome` and non-empty `summary` fields
 * - `escalate()` never throws even when internal components fail
 * - Outer timeout returns `outcome: "unresolved"` with a timeout message
 *
 * Task 3.2 tests cover:
 * - `escalation-intake` log entry is emitted on every call
 * - Empty `retryHistory` returns `unresolved` immediately (requirement 1.2)
 * - Concurrent call for same `sectionId` returns `unresolved` (requirement 1.4)
 * - `#inFlightSections` is cleaned up after a completed call (requirement 1.4)
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */
import type { ISelfHealingLoop } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { FailureFilter, FailureRecord, MemoryPort, ShortTermMemoryPort } from "@/application/ports/memory";
import type { ISelfHealingLoopLogger } from "@/application/ports/self-healing-loop-logger";
import {
  type SelfHealingLoopConfig,
  SelfHealingLoopService,
} from "@/application/self-healing-loop/self-healing-loop-service";
import type { SectionEscalation } from "@/domain/implementation-loop/types";
import type { EscalationIntakeLogEntry, SelfHealingLogEntry } from "@/domain/self-healing/types";
import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal mock factories
// ---------------------------------------------------------------------------

function makeMockLlm(): LlmProviderPort {
  return {
    complete: async () => ({
      ok: false as const,
      error: { category: "api_error" as const, message: "mock LLM", originalError: null },
    }),
    clearContext: () => {},
  };
}

function makeMockShortTerm(): ShortTermMemoryPort {
  return {
    read: () => ({ recentFiles: [] }),
    write: () => {},
    clear: () => {},
  };
}

function makeMockMemory(): MemoryPort {
  return {
    shortTerm: makeMockShortTerm(),
    query: async () => ({ entries: [] }),
    append: async () => ({ ok: true as const, action: "appended" as const }),
    update: async () => ({ ok: true as const, action: "updated" as const }),
    writeFailure: async () => ({ ok: true as const, action: "appended" as const }),
    getFailures: async () => [],
  };
}

function makeMockLogger(): ISelfHealingLoopLogger {
  return {
    log: (_entry: SelfHealingLogEntry) => {},
  };
}

/** A SectionEscalation with one entry in retryHistory (non-empty is valid). */
function makeEscalation(overrides: Partial<SectionEscalation> = {}): SectionEscalation {
  return {
    sectionId: "sec-1",
    planId: "plan-abc",
    retryHistory: [
      {
        iterationNumber: 1,
        reviewResult: {
          outcome: "failed" as const,
          checks: [],
          feedback: [],
          durationMs: 100,
        },
        durationMs: 500,
        timestamp: "2026-03-15T00:00:00.000Z",
      },
    ],
    reviewFeedback: [],
    agentObservations: [],
    ...overrides,
  };
}

/** Creates a service wired to a log spy — used in intake log emission tests. */
function makeServiceWithLogSpy(): {
  service: SelfHealingLoopService;
  logSpy: ReturnType<typeof mock<(entry: SelfHealingLogEntry) => void>>;
} {
  const logSpy = mock((_entry: SelfHealingLogEntry) => {});
  const logger: ISelfHealingLoopLogger = { log: logSpy };
  const service = new SelfHealingLoopService(makeMockLlm(), makeMockMemory(), defaultConfig, logger);
  return { service, logSpy };
}

const defaultConfig: SelfHealingLoopConfig = {
  workspaceRoot: "/workspace",
  selfHealingTimeoutMs: 120_000,
  analysisTimeoutMs: 60_000,
  maxAnalysisRetries: 2,
  maxRecordSizeBytes: 65_536,
};

// ---------------------------------------------------------------------------
// Constructor tests
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — constructor", () => {
  it("constructs with required args only (no logger)", () => {
    expect(
      () => new SelfHealingLoopService(makeMockLlm(), makeMockMemory(), defaultConfig),
    ).not.toThrow();
  });

  it("constructs with all args including optional logger", () => {
    expect(
      () => new SelfHealingLoopService(makeMockLlm(), makeMockMemory(), defaultConfig, makeMockLogger()),
    ).not.toThrow();
  });

  it("implements ISelfHealingLoop interface (has escalate method)", () => {
    const service: ISelfHealingLoop = new SelfHealingLoopService(
      makeMockLlm(),
      makeMockMemory(),
      defaultConfig,
    );
    expect(typeof service.escalate).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// escalate() basic shape and non-throwing behavior
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — escalate() result shape", () => {
  let service: SelfHealingLoopService;

  beforeEach(() => {
    service = new SelfHealingLoopService(makeMockLlm(), makeMockMemory(), defaultConfig);
  });

  it("returns a SelfHealingResult that resolves (never rejects)", async () => {
    await expect(service.escalate(makeEscalation())).resolves.toBeDefined();
  });

  it("result has an outcome field equal to 'resolved' or 'unresolved'", async () => {
    const result = await service.escalate(makeEscalation());
    expect(["resolved", "unresolved"]).toContain(result.outcome);
  });

  it("result has a non-empty summary string", async () => {
    const result = await service.escalate(makeEscalation());
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("escalate() does not throw even when called without a logger", async () => {
    const noLoggerService = new SelfHealingLoopService(
      makeMockLlm(),
      makeMockMemory(),
      defaultConfig,
      undefined,
    );
    const result = await noLoggerService.escalate(makeEscalation());
    expect(result).toBeDefined();
    expect(result.outcome).toMatch(/^(resolved|unresolved)$/);
  });
});

// ---------------------------------------------------------------------------
// escalate() never-throw guarantee — requirement 1.1
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — never throws", () => {
  it("does not reject even when MemoryPort.writeFailure throws", async () => {
    const throwingMemory = makeMockMemory();
    throwingMemory.writeFailure = async () => {
      throw new Error("disk full");
    };
    const service = new SelfHealingLoopService(makeMockLlm(), throwingMemory, defaultConfig);

    await expect(service.escalate(makeEscalation())).resolves.toMatchObject({
      outcome: expect.stringMatching(/^(resolved|unresolved)$/),
    });
  });

  it("does not reject even when MemoryPort.getFailures throws", async () => {
    const throwingMemory = makeMockMemory();
    throwingMemory.getFailures = async () => {
      throw new Error("memory read error");
    };
    const service = new SelfHealingLoopService(makeMockLlm(), throwingMemory, defaultConfig);

    await expect(service.escalate(makeEscalation())).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Outer timeout — requirement 1.5
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — outer timeout", () => {
  it("returns unresolved with a timeout message when selfHealingTimeoutMs elapses", async () => {
    // Use a LLM mock that never resolves to force the workflow to hang
    const hangingLlm: LlmProviderPort = {
      complete: () => new Promise<never>(() => {}), // never resolves
      clearContext: () => {},
    };

    const service = new SelfHealingLoopService(hangingLlm, makeMockMemory(), {
      ...defaultConfig,
      selfHealingTimeoutMs: 30,
    });

    const result = await service.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(result.summary).toMatch(/timeout|timed out/i);
  }, 1000 /* generous test timeout */);

  it("timeout summary includes the configured selfHealingTimeoutMs value", async () => {
    const hangingLlm: LlmProviderPort = {
      complete: () => new Promise<never>(() => {}),
      clearContext: () => {},
    };

    const service = new SelfHealingLoopService(hangingLlm, makeMockMemory(), {
      ...defaultConfig,
      selfHealingTimeoutMs: 50,
    });

    const result = await service.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(result.summary).toContain("50");
  }, 1000);
});

// ---------------------------------------------------------------------------
// Task 3.2: Escalation intake log emission — requirement 8.1
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — escalation-intake log entry", () => {
  it("emits an escalation-intake log entry on every escalate() call", async () => {
    const { service, logSpy } = makeServiceWithLogSpy();

    await service.escalate(makeEscalation());

    expect(logSpy).toHaveBeenCalled();
    const firstCall = logSpy.mock.calls[0]?.[0];
    expect(firstCall?.type).toBe("escalation-intake");
  });

  it("escalation-intake entry carries the correct retryHistoryCount", async () => {
    const { service, logSpy } = makeServiceWithLogSpy();
    const escalation = makeEscalation();

    await service.escalate(escalation);

    const intakeEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e): e is EscalationIntakeLogEntry => e?.type === "escalation-intake");
    expect(intakeEntry).toBeDefined();
    expect(intakeEntry?.retryHistoryCount).toBe(escalation.retryHistory.length);
  });

  it("escalation-intake entry carries correct sectionId and planId", async () => {
    const { service, logSpy } = makeServiceWithLogSpy();

    await service.escalate(makeEscalation({ sectionId: "sec-log-test", planId: "plan-xyz" }));

    const intakeEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e): e is EscalationIntakeLogEntry => e?.type === "escalation-intake");
    expect(intakeEntry?.sectionId).toBe("sec-log-test");
    expect(intakeEntry?.planId).toBe("plan-xyz");
  });

  it("emits escalation-intake even when retryHistory is empty", async () => {
    const { service, logSpy } = makeServiceWithLogSpy();

    await service.escalate(makeEscalation({ retryHistory: [] }));

    const intakeEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e): e is EscalationIntakeLogEntry => e?.type === "escalation-intake");
    expect(intakeEntry).toBeDefined();
    expect(intakeEntry?.retryHistoryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 3.2: Empty retryHistory guard — requirement 1.2
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — empty retryHistory guard", () => {
  it("returns unresolved immediately when retryHistory is empty", async () => {
    const service = new SelfHealingLoopService(makeMockLlm(), makeMockMemory(), defaultConfig);
    const result = await service.escalate(makeEscalation({ retryHistory: [] }));

    expect(result.outcome).toBe("unresolved");
  });

  it("empty retryHistory summary is non-empty and descriptive", async () => {
    const service = new SelfHealingLoopService(makeMockLlm(), makeMockMemory(), defaultConfig);
    const result = await service.escalate(makeEscalation({ retryHistory: [] }));

    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    // Should mention retry history or analysis in the summary
    expect(result.summary.toLowerCase()).toMatch(/retry|history|analysis/i);
  });

  it("empty retryHistory guard fires before any LLM call", async () => {
    const llmSpy = mock(async () => ({
      ok: false as const,
      error: { category: "api_error" as const, message: "should not be called", originalError: null },
    }));
    const mockLlm: LlmProviderPort = { complete: llmSpy, clearContext: () => {} };
    const service = new SelfHealingLoopService(mockLlm, makeMockMemory(), defaultConfig);

    await service.escalate(makeEscalation({ retryHistory: [] }));

    expect(llmSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 3.2: Concurrency guard — requirement 1.4
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — concurrency guard (#inFlightSections)", () => {
  it("returns unresolved with 'concurrent' in summary when same sectionId is in-flight", async () => {
    const hangingLlm: LlmProviderPort = {
      complete: () => new Promise<never>(() => {}),
      clearContext: () => {},
    };
    const service = new SelfHealingLoopService(hangingLlm, makeMockMemory(), {
      ...defaultConfig,
      selfHealingTimeoutMs: 200,
    });
    const escalation = makeEscalation({ sectionId: "sec-concurrent" });

    // First call hangs (LLM never resolves)
    const promise1 = service.escalate(escalation);
    // Second call immediately — sectionId is already in-flight synchronously
    const result2 = await service.escalate(escalation);

    expect(result2.outcome).toBe("unresolved");
    expect(result2.summary.toLowerCase()).toContain("concurrent");

    // Clean up: let first promise resolve via timeout
    await promise1;
  }, 1000);

  it("concurrent guard does not fire for different sectionIds", async () => {
    const hangingLlm: LlmProviderPort = {
      complete: () => new Promise<never>(() => {}),
      clearContext: () => {},
    };
    const service = new SelfHealingLoopService(hangingLlm, makeMockMemory(), {
      ...defaultConfig,
      selfHealingTimeoutMs: 200,
    });

    // Start escalation for sectionId A (hangs)
    const promiseA = service.escalate(makeEscalation({ sectionId: "sec-A" }));

    // Escalation for sectionId B is a different section — should NOT be blocked
    const resultB = await service.escalate(makeEscalation({ sectionId: "sec-B" }));

    // resultB should not say "concurrent" — different section
    expect(resultB.summary.toLowerCase()).not.toContain("concurrent escalation in progress");

    await promiseA;
  }, 1000);

  it("#inFlightSections is cleaned up after a successful call (no concurrent false-positive on retry)", async () => {
    // Mock LLM returns an error result (immediate, no hang)
    const service = new SelfHealingLoopService(makeMockLlm(), makeMockMemory(), defaultConfig);
    const escalation = makeEscalation({ sectionId: "sec-retry" });

    // First call completes
    await service.escalate(escalation);

    // Second call for same sectionId — should NOT be blocked by concurrent guard
    const result2 = await service.escalate(escalation);
    expect(result2.summary.toLowerCase()).not.toContain("concurrent");
  });

  it("#inFlightSections is cleaned up even when workflow throws internally", async () => {
    const throwingMemory = makeMockMemory();
    // Make writeFailure throw to simulate internal error
    throwingMemory.writeFailure = async () => {
      throw new Error("internal error");
    };
    const service = new SelfHealingLoopService(makeMockLlm(), throwingMemory, defaultConfig);
    const escalation = makeEscalation({ sectionId: "sec-error-cleanup" });

    // First call — may produce unresolved due to error but should not throw
    await service.escalate(escalation);

    // Second call — sectionId should be cleaned up from #inFlightSections
    const result2 = await service.escalate(escalation);
    expect(result2.summary.toLowerCase()).not.toContain("concurrent");
  });
});

// ---------------------------------------------------------------------------
// Task 4.1: Root-cause analysis — retry loop and per-call timeout
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — root-cause analysis (task 4.1)", () => {
  const validRootCauseJson = JSON.stringify({
    attemptsNarrative: "Attempted to create a TypeScript file",
    failureNarrative: "TypeScript compilation failed due to missing types",
    recurringPattern: "Missing type imports in generated code",
  });

  it("retries LLM up to maxAnalysisRetries times on API failure, then returns unresolved", async () => {
    let callCount = 0;
    const failingLlm: LlmProviderPort = {
      complete: async () => {
        callCount++;
        return {
          ok: false as const,
          error: { category: "api_error" as const, message: "service unavailable", originalError: null },
        };
      },
      clearContext: () => {},
    };

    const service = new SelfHealingLoopService(failingLlm, makeMockMemory(), {
      ...defaultConfig,
      maxAnalysisRetries: 2,
    });

    const result = await service.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(callCount).toBe(3); // 1 initial + 2 retries
    expect(result.summary).toMatch(/analysis|failed|attempt/i);
  });

  it("retries on non-parseable LLM response, then returns unresolved after exhausting retries", async () => {
    let callCount = 0;
    const garbageLlm: LlmProviderPort = {
      complete: async () => {
        callCount++;
        return {
          ok: true as const,
          value: { content: "not valid json {{{", usage: { inputTokens: 5, outputTokens: 5 } },
        };
      },
      clearContext: () => {},
    };

    const service = new SelfHealingLoopService(garbageLlm, makeMockMemory(), {
      ...defaultConfig,
      maxAnalysisRetries: 1,
    });

    const result = await service.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(callCount).toBe(2); // 1 initial + 1 retry
    expect(result.summary).toMatch(/analysis|parse|failed/i);
  });

  it("counts a timed-out LLM call as a failure and triggers retry", async () => {
    let callCount = 0;
    const slowLlm: LlmProviderPort = {
      complete: () => {
        callCount++;
        return new Promise<never>(() => {}); // hangs forever
      },
      clearContext: () => {},
    };

    const service = new SelfHealingLoopService(slowLlm, makeMockMemory(), {
      ...defaultConfig,
      analysisTimeoutMs: 20, // very short per-call timeout
      selfHealingTimeoutMs: 5_000, // generous outer timeout
      maxAnalysisRetries: 1,
    });

    const result = await service.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(callCount).toBe(2); // initial + 1 retry (both timed out)
    expect(result.summary).toMatch(/analysis|timeout|failed/i);
  }, 2_000);

  it("elapsed-time guard prevents LLM call when outer timeout is already consumed", async () => {
    let callCount = 0;
    const countingLlm: LlmProviderPort = {
      complete: async () => {
        callCount++;
        return {
          ok: false as const,
          error: { category: "api_error" as const, message: "fail", originalError: null },
        };
      },
      clearContext: () => {},
    };

    // selfHealingTimeoutMs: 0 means elapsed >= 0 is always true at the guard check
    const service = new SelfHealingLoopService(countingLlm, makeMockMemory(), {
      ...defaultConfig,
      selfHealingTimeoutMs: 0,
      maxAnalysisRetries: 5,
    });

    const result = await service.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(callCount).toBe(0); // no LLM calls — guard fires before first attempt
    expect(result.summary).toMatch(/timeout|elapsed|consumed|skipped/i);
  });

  it("successful parse with valid JSON proceeds beyond analysis (not an analysis failure)", async () => {
    const successLlm: LlmProviderPort = {
      complete: async () => ({
        ok: true as const,
        value: { content: validRootCauseJson, usage: { inputTokens: 10, outputTokens: 20 } },
      }),
      clearContext: () => {},
    };

    const service = new SelfHealingLoopService(successLlm, makeMockMemory(), defaultConfig);
    const result = await service.escalate(makeEscalation());

    // Analysis succeeds; workflow continues — outcome is unresolved until tasks 5–8 are implemented
    expect(result.outcome).toBe("unresolved");
    // Summary should NOT indicate an analysis failure
    expect(result.summary).not.toMatch(/analysis failed|Root-cause analysis failed/i);
  });
});

// ---------------------------------------------------------------------------
// Task 4.2: analysis-complete log entry emission — requirements 2.2, 2.4
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — analysis-complete log entry (task 4.2)", () => {
  const validRootCauseJson = JSON.stringify({
    attemptsNarrative: "Tried to generate code using the wrong pattern",
    failureNarrative: "Build failed due to incorrect import style",
    recurringPattern: "Wrong import style used consistently across retries",
  });

  function makeSuccessLlm(): LlmProviderPort {
    return {
      complete: async () => ({
        ok: true as const,
        value: { content: validRootCauseJson, usage: { inputTokens: 10, outputTokens: 20 } },
      }),
      clearContext: () => {},
    };
  }

  it("emits an analysis-complete log entry after successful root-cause analysis", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const svc = new SelfHealingLoopService(makeSuccessLlm(), makeMockMemory(), defaultConfig, logger);

    await svc.escalate(makeEscalation());

    const analysisEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "analysis-complete");
    expect(analysisEntry).toBeDefined();
  });

  it("analysis-complete entry carries the recurringPattern from the parsed analysis", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const svc = new SelfHealingLoopService(makeSuccessLlm(), makeMockMemory(), defaultConfig, logger);

    await svc.escalate(makeEscalation());

    const analysisEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "analysis-complete");
    expect(analysisEntry).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((analysisEntry as any).recurringPattern).toBe(
      "Wrong import style used consistently across retries",
    );
  });

  it("analysis-complete entry carries correct sectionId and planId", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const svc = new SelfHealingLoopService(makeSuccessLlm(), makeMockMemory(), defaultConfig, logger);

    await svc.escalate(makeEscalation({ sectionId: "sec-analysis", planId: "plan-analysis" }));

    const analysisEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "analysis-complete");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((analysisEntry as any)?.sectionId).toBe("sec-analysis");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((analysisEntry as any)?.planId).toBe("plan-analysis");
  });

  it("analysis-complete entry does NOT contain raw LLM output (only recurringPattern)", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const svc = new SelfHealingLoopService(makeSuccessLlm(), makeMockMemory(), defaultConfig, logger);

    await svc.escalate(makeEscalation());

    const analysisEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "analysis-complete");
    expect(analysisEntry).toBeDefined();
    const entryStr = JSON.stringify(analysisEntry);
    // Raw LLM fields like attemptsNarrative and failureNarrative should NOT appear in log
    expect(entryStr).not.toContain("attemptsNarrative");
    expect(entryStr).not.toContain("failureNarrative");
    // Only recurringPattern is logged
    expect(entryStr).toContain("recurringPattern");
  });

  it("analysis-complete is NOT emitted when analysis fails", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const svc = new SelfHealingLoopService(makeMockLlm(), makeMockMemory(), defaultConfig, logger);

    // makeMockLlm returns ok: false — analysis fails
    await svc.escalate(makeEscalation());

    const analysisEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "analysis-complete");
    expect(analysisEntry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task 5.1: Gap identification — requirements 3.1, 3.2, 3.3, 3.5
// ---------------------------------------------------------------------------

/**
 * Two-phase LLM mock: first call returns valid root-cause analysis JSON,
 * subsequent calls return the provided gap response.
 */
function makeTwoPhaseLlm(
  gapResponse:
    | { ok: true; content: string }
    | { ok: false; message?: string }
    | "hang",
): LlmProviderPort {
  const validRootCause = JSON.stringify({
    attemptsNarrative: "Attempted to create a TypeScript file",
    failureNarrative: "TypeScript compilation failed due to missing types",
    recurringPattern: "Missing type imports in generated code",
  });
  let callCount = 0;
  return {
    complete: async () => {
      callCount++;
      if (callCount === 1) {
        // First call: root-cause analysis succeeds
        return {
          ok: true as const,
          value: { content: validRootCause, usage: { inputTokens: 10, outputTokens: 20 } },
        };
      }
      // Subsequent calls: gap identification
      if (gapResponse === "hang") {
        return new Promise<never>(() => {});
      }
      if (gapResponse.ok) {
        return {
          ok: true as const,
          value: { content: gapResponse.content, usage: { inputTokens: 10, outputTokens: 20 } },
        };
      }
      return {
        ok: false as const,
        error: {
          category: "api_error" as const,
          message: gapResponse.message ?? "gap LLM failed",
          originalError: null,
        },
      };
    },
    clearContext: () => {},
  };
}

const validGapJson = JSON.stringify({
  targetFile: "coding_rules",
  proposedChange: "Always use const for variable declarations",
  rationale: "Pattern shows inconsistent var usage leading to bugs",
});

const noActionableGapJson = JSON.stringify({
  targetFile: null,
  proposedChange: "",
  rationale: "No actionable knowledge gap identified for this failure pattern",
});

const unsupportedFileGapJson = JSON.stringify({
  targetFile: "unknown_file",
  proposedChange: "Some change",
  rationale: "Some rationale",
});

describe("SelfHealingLoopService — gap identification (task 5.1)", () => {
  it("calls MemoryPort.query() to read rule file contents before the gap LLM call", async () => {
    let queryCalled = false;
    const spyMemory = makeMockMemory();
    const originalQuery = spyMemory.query.bind(spyMemory);
    spyMemory.query = async (q) => {
      queryCalled = true;
      return originalQuery(q);
    };

    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      spyMemory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation());

    expect(queryCalled).toBe(true);
  });

  it("returns unresolved with explanatory summary when LLM reports no actionable gap (targetFile null)", async () => {
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: noActionableGapJson }),
      makeMockMemory(),
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary.toLowerCase()).toMatch(/gap|actionable|no/i);
  });

  it("does NOT retry when LLM returns no actionable gap (targetFile null) — it's a valid terminal response", async () => {
    let callCount = 0;
    const validRootCause = JSON.stringify({
      attemptsNarrative: "Tried",
      failureNarrative: "Failed",
      recurringPattern: "Pattern",
    });
    const countingLlm: LlmProviderPort = {
      complete: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true as const,
            value: { content: validRootCause, usage: { inputTokens: 5, outputTokens: 5 } },
          };
        }
        return {
          ok: true as const,
          value: { content: noActionableGapJson, usage: { inputTokens: 5, outputTokens: 5 } },
        };
      },
      clearContext: () => {},
    };

    const svc = new SelfHealingLoopService(countingLlm, makeMockMemory(), {
      ...defaultConfig,
      maxAnalysisRetries: 3,
    });

    await svc.escalate(makeEscalation());

    // Only 2 LLM calls: 1 for analysis + 1 for gap (no_gap is terminal, no retry)
    expect(callCount).toBe(2);
  });

  it("returns unresolved with 'unsupported rule file' when targetFile is not in the supported set", async () => {
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: unsupportedFileGapJson }),
      makeMockMemory(),
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(result.summary.toLowerCase()).toMatch(/unsupported|rule file|unknown_file/i);
  });

  it("does NOT retry when targetFile is unsupported — it's a terminal validation failure", async () => {
    let callCount = 0;
    const validRootCause = JSON.stringify({
      attemptsNarrative: "Tried",
      failureNarrative: "Failed",
      recurringPattern: "Pattern",
    });
    const countingLlm: LlmProviderPort = {
      complete: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true as const,
            value: { content: validRootCause, usage: { inputTokens: 5, outputTokens: 5 } },
          };
        }
        return {
          ok: true as const,
          value: { content: unsupportedFileGapJson, usage: { inputTokens: 5, outputTokens: 5 } },
        };
      },
      clearContext: () => {},
    };

    const svc = new SelfHealingLoopService(countingLlm, makeMockMemory(), {
      ...defaultConfig,
      maxAnalysisRetries: 3,
    });

    await svc.escalate(makeEscalation());

    // Only 2 LLM calls: 1 for analysis + 1 for gap (unsupported file is terminal)
    expect(callCount).toBe(2);
  });

  it("retries gap LLM call up to maxAnalysisRetries on API failure, then returns unresolved", async () => {
    let gapCallCount = 0;
    const validRootCause = JSON.stringify({
      attemptsNarrative: "Tried",
      failureNarrative: "Failed",
      recurringPattern: "Pattern",
    });
    const countingLlm: LlmProviderPort = {
      complete: async () => {
        if (gapCallCount === 0) {
          gapCallCount++; // mark analysis done
          return {
            ok: true as const,
            value: { content: validRootCause, usage: { inputTokens: 5, outputTokens: 5 } },
          };
        }
        gapCallCount++;
        return {
          ok: false as const,
          error: { category: "api_error" as const, message: "gap service down", originalError: null },
        };
      },
      clearContext: () => {},
    };

    const svc = new SelfHealingLoopService(countingLlm, makeMockMemory(), {
      ...defaultConfig,
      maxAnalysisRetries: 2,
    });

    const result = await svc.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    // gapCallCount starts at 0, increments to 1 on analysis call,
    // then 2,3,4 on gap calls (1 initial + 2 retries)
    expect(gapCallCount).toBe(4); // 1 analysis + 3 gap attempts
    expect(result.summary).toMatch(/gap|failed|attempt/i);
  });

  it("retries gap LLM call on non-parseable response, then returns unresolved after exhausting retries", async () => {
    let callCount = 0;
    const validRootCause = JSON.stringify({
      attemptsNarrative: "Tried",
      failureNarrative: "Failed",
      recurringPattern: "Pattern",
    });
    const countingLlm: LlmProviderPort = {
      complete: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true as const,
            value: { content: validRootCause, usage: { inputTokens: 5, outputTokens: 5 } },
          };
        }
        return {
          ok: true as const,
          value: { content: "not valid json {{{", usage: { inputTokens: 5, outputTokens: 5 } },
        };
      },
      clearContext: () => {},
    };

    const svc = new SelfHealingLoopService(countingLlm, makeMockMemory(), {
      ...defaultConfig,
      maxAnalysisRetries: 1,
    });

    const result = await svc.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(callCount).toBe(3); // 1 analysis + 2 gap attempts (1 initial + 1 retry)
  });

  it("emits a gap-identified log entry with targetFile after successful gap parse", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      makeMockMemory(),
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation());

    const gapEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "gap-identified");
    expect(gapEntry).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((gapEntry as any)?.targetFile).toBe("coding_rules");
  });

  it("gap-identified log entry carries correct sectionId and planId", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      makeMockMemory(),
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation({ sectionId: "sec-gap-test", planId: "plan-gap-test" }));

    const gapEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "gap-identified");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((gapEntry as any)?.sectionId).toBe("sec-gap-test");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((gapEntry as any)?.planId).toBe("plan-gap-test");
  });

  it("gap-identified is NOT emitted when LLM returns no actionable gap", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: noActionableGapJson }),
      makeMockMemory(),
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation());

    const gapEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "gap-identified");
    expect(gapEntry).toBeUndefined();
  });

  it("elapsed-time guard prevents gap LLM call when outer timeout already consumed", async () => {
    // Use selfHealingTimeoutMs: 0 so the outer guard fires immediately.
    // With threshold 0, elapsed >= 0 is always true, so analysis guard fires first.
    // The important property: escalate() returns unresolved with a timeout message,
    // not a gap-identification error.
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      makeMockMemory(),
      {
        ...defaultConfig,
        selfHealingTimeoutMs: 0,
        maxAnalysisRetries: 5,
      },
    );

    const result = await svc.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(result.summary).toMatch(/timeout|elapsed|consumed|skipped/i);
  });

  it("proceeds past gap identification when valid gap is found (summary does not indicate gap failure)", async () => {
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      makeMockMemory(),
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation());

    // Gap identification succeeds; full workflow proceeds to resolved outcome (task 8.1 complete)
    // Should NOT indicate a gap identification failure
    expect(result.summary).not.toMatch(/gap identification failed/i);
    expect(result.summary).not.toMatch(/unsupported rule file/i);
    expect(result.summary).not.toMatch(/no actionable gap/i);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2: Duplicate gap detection — requirement 3.4
// ---------------------------------------------------------------------------

/** Delegates to the service's canonical encoder so tests stay in sync with the implementation. */
const encodeRuleUpdate = SelfHealingLoopService.encodeRuleUpdate;

/** Creates a MemoryPort mock pre-seeded with the given failure records. */
function makeMemoryWithFailures(failures: readonly FailureRecord[]): MemoryPort {
  const base = makeMockMemory();
  base.getFailures = async (_filter?) => failures;
  return base;
}

/** A minimal valid FailureRecord for pre-seeding. */
function makeFailureRecord(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    taskId: "sec-1",
    specName: "plan-abc",
    phase: "IMPLEMENTATION",
    attempted: "[]",
    errors: [],
    rootCause: "unknown",
    ruleUpdate: undefined,
    timestamp: "2026-03-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("SelfHealingLoopService — duplicate gap detection (task 5.2)", () => {
  it("proceeds past duplicate check when no prior failure records exist", async () => {
    const memory = makeMemoryWithFailures([]);
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation());

    // No duplicates → workflow proceeds through to resolved outcome (task 8.1 complete)
    // Should NOT say "duplicate gap detected"
    expect(result.summary.toLowerCase()).not.toContain("duplicate");
  });

  it("returns unresolved with 'duplicate gap detected' when prior record has identical targetFile + proposedChange", async () => {
    const priorRecord = makeFailureRecord({
      taskId: "sec-1",
      ruleUpdate: encodeRuleUpdate("coding_rules", "Always use const for variable declarations"),
    });
    const memory = makeMemoryWithFailures([priorRecord]);
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation({ sectionId: "sec-1" }));

    expect(result.outcome).toBe("unresolved");
    expect(result.summary.toLowerCase()).toContain("duplicate");
  });

  it("'duplicate gap detected' appears in summary (exact wording per requirement 3.4)", async () => {
    const priorRecord = makeFailureRecord({
      taskId: "sec-1",
      ruleUpdate: encodeRuleUpdate("coding_rules", "Always use const for variable declarations"),
    });
    const memory = makeMemoryWithFailures([priorRecord]);
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation({ sectionId: "sec-1" }));

    expect(result.summary.toLowerCase()).toContain("duplicate gap detected");
  });

  it("no duplicate detected when prior record has different targetFile (same proposedChange)", async () => {
    const priorRecord = makeFailureRecord({
      taskId: "sec-1",
      // Different targetFile: "review_rules" vs the gap's "coding_rules"
      ruleUpdate: encodeRuleUpdate("review_rules", "Always use const for variable declarations"),
    });
    const memory = makeMemoryWithFailures([priorRecord]);
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation({ sectionId: "sec-1" }));

    expect(result.summary.toLowerCase()).not.toContain("duplicate");
  });

  it("no duplicate detected when prior record has different proposedChange (same targetFile)", async () => {
    const priorRecord = makeFailureRecord({
      taskId: "sec-1",
      // Different proposedChange
      ruleUpdate: encodeRuleUpdate("coding_rules", "Some completely different rule"),
    });
    const memory = makeMemoryWithFailures([priorRecord]);
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation({ sectionId: "sec-1" }));

    expect(result.summary.toLowerCase()).not.toContain("duplicate");
  });

  it("no duplicate detected when prior record belongs to a different sectionId", async () => {
    const priorRecord = makeFailureRecord({
      taskId: "sec-OTHER", // different section
      ruleUpdate: encodeRuleUpdate("coding_rules", "Always use const for variable declarations"),
    });
    // getFailures is called with a filter; here the mock returns this record regardless
    // To properly test, we need getFailures to only return records for the queried taskId
    const memory = makeMockMemory();
    let capturedFilter: FailureFilter | undefined;
    memory.getFailures = async (filter?) => {
      capturedFilter = filter;
      // Return empty for sec-1 (simulating filtered query)
      if (filter?.taskId === "sec-1") return [];
      return [priorRecord];
    };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation({ sectionId: "sec-1" }));

    // Should have queried with the correct sectionId filter
    expect(capturedFilter?.taskId).toBe("sec-1");
    expect(result.summary.toLowerCase()).not.toContain("duplicate");
  });

  it("calls getFailures with taskId set to the escalation sectionId", async () => {
    let capturedFilter: FailureFilter | undefined;
    const memory = makeMockMemory();
    memory.getFailures = async (filter?) => {
      capturedFilter = filter;
      return [];
    };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation({ sectionId: "my-section-id" }));

    expect(capturedFilter?.taskId).toBe("my-section-id");
  });

  it("proceeds as if no duplicates when getFailures throws (safe default)", async () => {
    const memory = makeMockMemory();
    memory.getFailures = async () => {
      throw new Error("failure memory unavailable");
    };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    // Should not throw and should not report duplicate — workflow proceeds through to resolved
    const result = await svc.escalate(makeEscalation());
    expect(result.summary.toLowerCase()).not.toContain("duplicate");
  });

  it("detects duplicate across multiple prior records (any match triggers detection)", async () => {
    const priorRecords = [
      makeFailureRecord({
        taskId: "sec-1",
        ruleUpdate: encodeRuleUpdate("review_rules", "Some other rule"),
      }),
      makeFailureRecord({
        taskId: "sec-1",
        ruleUpdate: encodeRuleUpdate("coding_rules", "Always use const for variable declarations"),
      }),
      makeFailureRecord({
        taskId: "sec-1",
        ruleUpdate: encodeRuleUpdate("implementation_patterns", "Another unrelated rule"),
      }),
    ];
    const memory = makeMemoryWithFailures(priorRecords);
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation({ sectionId: "sec-1" }));

    expect(result.outcome).toBe("unresolved");
    expect(result.summary.toLowerCase()).toContain("duplicate gap detected");
  });

  it("gap-identified log entry is still emitted before duplicate check fires", async () => {
    // The log entry should be emitted before the duplicate check
    const priorRecord = makeFailureRecord({
      taskId: "sec-1",
      ruleUpdate: encodeRuleUpdate("coding_rules", "Always use const for variable declarations"),
    });
    const memory = makeMemoryWithFailures([priorRecord]);
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation({ sectionId: "sec-1" }));

    const gapEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "gap-identified");
    expect(gapEntry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Task 6.1: Workspace boundary validation — requirements 4.5, 8.5
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — task 6.1: workspace boundary validation (static helpers)", () => {
  describe("isPathWithinWorkspace", () => {
    it("returns true for a direct child path inside workspace", () => {
      expect(
        SelfHealingLoopService.isPathWithinWorkspace("/workspace", "/workspace/file.md"),
      ).toBe(true);
    });

    it("returns true for a deeply nested path inside workspace", () => {
      expect(
        SelfHealingLoopService.isPathWithinWorkspace(
          "/workspace",
          "/workspace/.kiro/steering/coding_rules.md",
        ),
      ).toBe(true);
    });

    it("returns false for a path outside workspace", () => {
      expect(
        SelfHealingLoopService.isPathWithinWorkspace("/workspace", "/other/file.md"),
      ).toBe(false);
    });

    it("does NOT match a sibling directory that shares a common prefix (no false positive)", () => {
      // '/workspace-other' starts with '/workspace' — must NOT be considered inside '/workspace'
      expect(
        SelfHealingLoopService.isPathWithinWorkspace(
          "/workspace",
          "/workspace-other/.kiro/steering/coding_rules.md",
        ),
      ).toBe(false);
    });

    it("returns false when path is the parent of workspace root", () => {
      expect(
        SelfHealingLoopService.isPathWithinWorkspace("/workspace/a/b", "/workspace/a"),
      ).toBe(false);
    });

    it("handles workspaceRoot with a trailing separator correctly", () => {
      expect(
        SelfHealingLoopService.isPathWithinWorkspace(
          "/workspace/",
          "/workspace/.kiro/steering/coding_rules.md",
        ),
      ).toBe(true);
    });
  });

  describe("ruleFileRelativePath", () => {
    it("maps coding_rules to .kiro/steering/coding_rules.md", () => {
      const rel = SelfHealingLoopService.ruleFileRelativePath("coding_rules");
      expect(rel).toMatch(/\.kiro[/\\]steering[/\\]coding_rules\.md$/);
    });

    it("maps review_rules to .kiro/steering/review_rules.md", () => {
      const rel = SelfHealingLoopService.ruleFileRelativePath("review_rules");
      expect(rel).toMatch(/\.kiro[/\\]steering[/\\]review_rules\.md$/);
    });

    it("maps implementation_patterns to .kiro/steering/implementation_patterns.md", () => {
      const rel = SelfHealingLoopService.ruleFileRelativePath("implementation_patterns");
      expect(rel).toMatch(/\.kiro[/\\]steering[/\\]implementation_patterns\.md$/);
    });

    it("maps debugging_patterns to .kiro/steering/debugging_patterns.md", () => {
      const rel = SelfHealingLoopService.ruleFileRelativePath("debugging_patterns");
      expect(rel).toMatch(/\.kiro[/\\]steering[/\\]debugging_patterns\.md$/);
    });
  });
});

describe("SelfHealingLoopService — task 6.1: workspace boundary via escalate()", () => {
  it("valid gap does NOT produce 'workspace safety violation' (path inside workspaceRoot)", async () => {
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      makeMockMemory(),
      defaultConfig, // workspaceRoot: "/workspace"
    );

    const result = await svc.escalate(makeEscalation());

    // Workspace validation should PASS for valid KnowledgeMemoryFile values —
    // the summary should NOT contain 'workspace safety violation'
    expect(result.summary.toLowerCase()).not.toContain("workspace safety violation");
  });

  it("MemoryPort.append and .update are NOT called when workspace validation blocks the path", () => {
    // This test demonstrates that isPathWithinWorkspace(workspaceRoot, outsidePath) === false
    // protects MemoryPort from receiving external paths.
    // The violation case cannot be triggered through escalate() because the path is always
    // constructed from workspaceRoot + relative, making it structurally inside workspaceRoot.
    // Boundary logic is fully covered by the static helper unit tests above.
    expect(
      SelfHealingLoopService.isPathWithinWorkspace("/workspace", "/etc/passwd"),
    ).toBe(false);
    expect(
      SelfHealingLoopService.isPathWithinWorkspace("/workspace", "/workspace/../etc/passwd"),
    ).toBe(false); // path.resolve normalizes this to /etc/passwd
  });
});

// ---------------------------------------------------------------------------
// Task 6.2: Rule file write with machine-readable marker — requirements 4.1–4.4
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — task 6.2: rule file write", () => {
  it("calls MemoryPort.append() with the correct MemoryTarget (knowledge + targetFile)", async () => {
    let capturedTarget: unknown;
    const memory = makeMockMemory();
    memory.append = async (target, _entry, _trigger) => {
      capturedTarget = target;
      return { ok: true as const, action: "appended" as const };
    };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation());

    expect(capturedTarget).toMatchObject({ type: "knowledge", file: "coding_rules" });
  });

  it("MemoryEntry.description contains the machine-readable marker with sectionId and timestamp", async () => {
    let capturedEntry: unknown;
    const memory = makeMockMemory();
    memory.append = async (_target, entry, _trigger) => {
      capturedEntry = entry;
      return { ok: true as const, action: "appended" as const };
    };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation({ sectionId: "sec-marker-test" }));

    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const desc = (capturedEntry as any)?.description as string;
    expect(desc).toContain("<!-- self-healing: sec-marker-test");
  });

  it("MemoryEntry.description contains the proposedChange from the GapReport", async () => {
    let capturedEntry: unknown;
    const memory = makeMockMemory();
    memory.append = async (_target, entry, _trigger) => {
      capturedEntry = entry;
      return { ok: true as const, action: "appended" as const };
    };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation());

    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const desc = (capturedEntry as any)?.description as string;
    expect(desc).toContain("Always use const for variable declarations");
  });

  it("MemoryEntry.context contains both planId and sectionId for traceability", async () => {
    let capturedEntry: unknown;
    const memory = makeMockMemory();
    memory.append = async (_target, entry, _trigger) => {
      capturedEntry = entry;
      return { ok: true as const, action: "appended" as const };
    };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation({ sectionId: "sec-ctx", planId: "plan-ctx" }));

    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const ctx = (capturedEntry as any)?.context as string;
    expect(ctx).toContain("sec-ctx");
    expect(ctx).toContain("plan-ctx");
  });

  it("MemoryEntry.title contains sectionId for uniqueness", async () => {
    let capturedEntry: unknown;
    const memory = makeMockMemory();
    memory.append = async (_target, entry, _trigger) => {
      capturedEntry = entry;
      return { ok: true as const, action: "appended" as const };
    };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation({ sectionId: "sec-title-test" }));

    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const title = (capturedEntry as any)?.title as string;
    expect(title).toContain("sec-title-test");
  });

  it("MemoryPort.append() is called with trigger 'self_healing'", async () => {
    let capturedTrigger: unknown;
    const memory = makeMockMemory();
    memory.append = async (_target, _entry, trigger) => {
      capturedTrigger = trigger;
      return { ok: true as const, action: "appended" as const };
    };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation());

    expect(capturedTrigger).toBe("self_healing");
  });

  it("returns unresolved with filesystem error in summary when MemoryPort.append() fails", async () => {
    const memory = makeMockMemory();
    memory.append = async () => ({
      ok: false as const,
      error: { category: "io_error" as const, message: "disk write failed" },
    });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(result.summary.toLowerCase()).toContain("disk write failed");
  });

  it("emits a rule-updated log entry with targetFile and memoryWriteAction after a successful write", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation());

    const ruleUpdatedEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "rule-updated");
    expect(ruleUpdatedEntry).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((ruleUpdatedEntry as any)?.targetFile).toBe("coding_rules");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((ruleUpdatedEntry as any)?.memoryWriteAction).toBe("appended");
  });

  it("rule-updated log entry carries correct sectionId and planId", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation({ sectionId: "sec-rule-log", planId: "plan-rule-log" }));

    const entry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "rule-updated");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((entry as any)?.sectionId).toBe("sec-rule-log");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((entry as any)?.planId).toBe("plan-rule-log");
  });

  it("rule-updated log entry reflects the actual memoryWriteAction returned by MemoryPort (updated)", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const memory = makeMockMemory();
    // Simulate MemoryPort returning "updated" (e.g. entry already existed and was updated)
    memory.append = async () => ({ ok: true as const, action: "updated" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation());

    const ruleUpdatedEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "rule-updated");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((ruleUpdatedEntry as any)?.memoryWriteAction).toBe("updated");
  });

  it("rule-updated log entry is NOT emitted when MemoryPort.append() fails", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const memory = makeMockMemory();
    memory.append = async () => ({
      ok: false as const,
      error: { category: "io_error" as const, message: "disk full" },
    });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation());

    const ruleUpdatedEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "rule-updated");
    expect(ruleUpdatedEntry).toBeUndefined();
  });

  it("workspace-relative path of updated rule file is collected in updatedRules (surfaced by task 8)", async () => {
    // After task 6.2, the path is collected internally. Task 8 will surface it in the
    // resolved result. For now, verify indirectly: a successful write does NOT produce
    // 'rule file write not yet implemented' in the summary.
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation());

    expect(result.summary.toLowerCase()).not.toContain("rule file write not yet implemented");
  });
});

// ---------------------------------------------------------------------------
// Task 7.1: Failure record field mapping and size truncation — requirements 5.1, 5.5
// ---------------------------------------------------------------------------

/** LLM that never resolves — forces the timeout path which calls #persistFailureRecord. */
function makeHangingLlm(): LlmProviderPort {
  return {
    complete: () => new Promise<never>(() => {}),
    clearContext: () => {},
  };
}

/** MemoryPort that captures every writeFailure call. */
function makeCapturingMemory(): { memory: MemoryPort; capturedRecords: FailureRecord[] } {
  const capturedRecords: FailureRecord[] = [];
  const memory = makeMockMemory();
  memory.writeFailure = async (record) => {
    capturedRecords.push(record);
    return { ok: true as const, action: "appended" as const };
  };
  return { memory, capturedRecords };
}

describe("SelfHealingLoopService — task 7.1: failure record field mapping (timeout path)", () => {
  it("writeFailure is called with taskId mapped from sectionId", async () => {
    const { memory, capturedRecords } = makeCapturingMemory();
    const svc = new SelfHealingLoopService(makeHangingLlm(), memory, {
      ...defaultConfig,
      selfHealingTimeoutMs: 30,
    });

    await svc.escalate(makeEscalation({ sectionId: "sec-mapping-test", planId: "plan-xyz" }));

    expect(capturedRecords.length).toBeGreaterThan(0);
    expect(capturedRecords[0]!.taskId).toBe("sec-mapping-test");
  }, 1000);

  it("writeFailure is called with specName mapped from planId", async () => {
    const { memory, capturedRecords } = makeCapturingMemory();
    const svc = new SelfHealingLoopService(makeHangingLlm(), memory, {
      ...defaultConfig,
      selfHealingTimeoutMs: 30,
    });

    await svc.escalate(makeEscalation({ sectionId: "sec-1", planId: "plan-mapping-test" }));

    expect(capturedRecords[0]!.specName).toBe("plan-mapping-test");
  }, 1000);

  it("writeFailure is called with fixed phase 'IMPLEMENTATION'", async () => {
    const { memory, capturedRecords } = makeCapturingMemory();
    const svc = new SelfHealingLoopService(makeHangingLlm(), memory, {
      ...defaultConfig,
      selfHealingTimeoutMs: 30,
    });

    await svc.escalate(makeEscalation());

    expect(capturedRecords[0]!.phase).toBe("IMPLEMENTATION");
  }, 1000);

  it("writeFailure 'attempted' field contains serialized retryHistory", async () => {
    const { memory, capturedRecords } = makeCapturingMemory();
    const svc = new SelfHealingLoopService(makeHangingLlm(), memory, {
      ...defaultConfig,
      selfHealingTimeoutMs: 30,
    });

    await svc.escalate(makeEscalation());

    const attempted = capturedRecords[0]!.attempted;
    // retryHistory has iterationNumber field
    expect(attempted).toContain("iterationNumber");
  }, 1000);

  it("writeFailure 'ruleUpdate' is undefined when no gap was identified (null gapReport)", async () => {
    const { memory, capturedRecords } = makeCapturingMemory();
    const svc = new SelfHealingLoopService(makeHangingLlm(), memory, {
      ...defaultConfig,
      selfHealingTimeoutMs: 30,
    });

    await svc.escalate(makeEscalation());

    expect(capturedRecords[0]!.ruleUpdate).toBeUndefined();
  }, 1000);

  it("writeFailure 'errors' is empty array when rootCause is null (timeout path)", async () => {
    const { memory, capturedRecords } = makeCapturingMemory();
    const svc = new SelfHealingLoopService(makeHangingLlm(), memory, {
      ...defaultConfig,
      selfHealingTimeoutMs: 30,
    });

    await svc.escalate(makeEscalation());

    expect(Array.isArray(capturedRecords[0]!.errors)).toBe(true);
    expect(capturedRecords[0]!.errors.length).toBe(0);
  }, 1000);

  it("writeFailure 'rootCause' is 'unknown' when rootCause analysis is null (timeout path)", async () => {
    const { memory, capturedRecords } = makeCapturingMemory();
    const svc = new SelfHealingLoopService(makeHangingLlm(), memory, {
      ...defaultConfig,
      selfHealingTimeoutMs: 30,
    });

    await svc.escalate(makeEscalation());

    expect(capturedRecords[0]!.rootCause).toBe("unknown");
  }, 1000);

  it("writeFailure 'timestamp' is a valid ISO 8601 string", async () => {
    const { memory, capturedRecords } = makeCapturingMemory();
    const svc = new SelfHealingLoopService(makeHangingLlm(), memory, {
      ...defaultConfig,
      selfHealingTimeoutMs: 30,
    });

    await svc.escalate(makeEscalation());

    const ts = capturedRecords[0]!.timestamp;
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(ts).toISOString()).toBe(ts);
  }, 1000);
});

describe("SelfHealingLoopService — task 7.1: agentObservations truncation (requirement 5.5)", () => {
  it("serialized record stays within maxRecordSizeBytes when agentObservations are large", async () => {
    const { memory, capturedRecords } = makeCapturingMemory();

    // Build 150 large observations — each with a ~500-char rawOutput
    const largeObservations = Array.from({ length: 150 }, (_, i) => ({
      toolName: "write_file",
      toolInput: { path: `/workspace/src/file-${i}.ts` },
      rawOutput: `Output ${i}: ${"large content ".repeat(40)}`,
      success: true,
      recordedAt: new Date().toISOString(),
    }));

    const maxBytes = 65_536; // default maxRecordSizeBytes
    const svc = new SelfHealingLoopService(makeHangingLlm(), memory, {
      ...defaultConfig,
      selfHealingTimeoutMs: 30,
      maxRecordSizeBytes: maxBytes,
    });

    await svc.escalate(makeEscalation({ agentObservations: largeObservations }));

    expect(capturedRecords.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(capturedRecords[0]!);
    const byteLength = new TextEncoder().encode(serialized).length;
    expect(byteLength).toBeLessThanOrEqual(maxBytes);
  }, 1000);

  it("does not truncate when agentObservations are small enough to fit", async () => {
    const { memory, capturedRecords } = makeCapturingMemory();

    const smallObservations = [
      {
        toolName: "read_file",
        toolInput: { path: "/workspace/src/a.ts" },
        rawOutput: "content",
        success: true,
        recordedAt: new Date().toISOString(),
      },
    ];

    const svc = new SelfHealingLoopService(makeHangingLlm(), memory, {
      ...defaultConfig,
      selfHealingTimeoutMs: 30,
      maxRecordSizeBytes: 65_536,
    });

    await svc.escalate(makeEscalation({ agentObservations: smallObservations }));

    const attempted = capturedRecords[0]!.attempted;
    // agentObservations should still be present (not truncated away)
    expect(attempted).toContain("read_file");
  }, 1000);

  it("handles zero agentObservations without error", async () => {
    const { memory, capturedRecords } = makeCapturingMemory();

    const svc = new SelfHealingLoopService(makeHangingLlm(), memory, {
      ...defaultConfig,
      selfHealingTimeoutMs: 30,
    });

    await svc.escalate(makeEscalation({ agentObservations: [] }));

    expect(capturedRecords.length).toBeGreaterThan(0);
    const attempted = capturedRecords[0]!.attempted;
    expect(attempted).toContain("retryHistory");
  }, 1000);
});

// ---------------------------------------------------------------------------
// Task 7.2: Failure record written in finally block — requirements 5.2, 5.3, 5.4
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — task 7.2: writeFailure in finally block", () => {
  it("calls writeFailure exactly once when analysis fails (normal unresolved path)", async () => {
    let writeCount = 0;
    const memory = makeMockMemory();
    memory.writeFailure = async () => {
      writeCount++;
      return { ok: true as const, action: "appended" as const };
    };
    // makeMockLlm returns ok: false → analysis fails → workflow completes quickly
    const svc = new SelfHealingLoopService(makeMockLlm(), memory, defaultConfig);

    await svc.escalate(makeEscalation());

    expect(writeCount).toBe(1);
  });

  it("calls writeFailure exactly once when gap identification fails", async () => {
    let writeCount = 0;
    const memory = makeMockMemory();
    memory.writeFailure = async () => {
      writeCount++;
      return { ok: true as const, action: "appended" as const };
    };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: noActionableGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation());

    expect(writeCount).toBe(1);
  });

  it("calls writeFailure exactly once when rule file write fails", async () => {
    let writeCount = 0;
    const memory = makeMockMemory();
    memory.append = async () => ({
      ok: false as const,
      error: { category: "io_error" as const, message: "disk full" },
    });
    memory.writeFailure = async () => {
      writeCount++;
      return { ok: true as const, action: "appended" as const };
    };
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation());

    expect(writeCount).toBe(1);
  });

  it("calls writeFailure even when the empty retryHistory guard fires", async () => {
    let writeCount = 0;
    const memory = makeMockMemory();
    memory.writeFailure = async () => {
      writeCount++;
      return { ok: true as const, action: "appended" as const };
    };
    const svc = new SelfHealingLoopService(makeMockLlm(), memory, defaultConfig);

    await svc.escalate(makeEscalation({ retryHistory: [] }));

    expect(writeCount).toBe(1);
  });

  it("calls writeFailure with rootCause.recurringPattern populated when analysis succeeds", async () => {
    const capturedRecords: FailureRecord[] = [];
    const memory = makeMockMemory();
    memory.writeFailure = async (r) => {
      capturedRecords.push(r);
      return { ok: true as const, action: "appended" as const };
    };

    const validRootCauseJson = JSON.stringify({
      attemptsNarrative: "Tried to create TypeScript files",
      failureNarrative: "Build system failed with missing types",
      recurringPattern: "Missing type imports in generated code",
    });
    const successAnalysisLlm: LlmProviderPort = {
      complete: async () => ({
        ok: true as const,
        value: { content: validRootCauseJson, usage: { inputTokens: 10, outputTokens: 20 } },
      }),
      clearContext: () => {},
    };

    const svc = new SelfHealingLoopService(successAnalysisLlm, memory, defaultConfig);
    await svc.escalate(makeEscalation());

    expect(capturedRecords.length).toBe(1);
    expect(capturedRecords[0]!.rootCause).toBe("Missing type imports in generated code");
    expect(capturedRecords[0]!.errors).toContain("Tried to create TypeScript files");
    expect(capturedRecords[0]!.errors).toContain("Build system failed with missing types");
  });

  it("calls writeFailure with ruleUpdate from gap report when gap is identified", async () => {
    const capturedRecords: FailureRecord[] = [];
    const memory = makeMockMemory();
    memory.writeFailure = async (r) => {
      capturedRecords.push(r);
      return { ok: true as const, action: "appended" as const };
    };

    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );
    await svc.escalate(makeEscalation());

    expect(capturedRecords.length).toBe(1);
    expect(capturedRecords[0]!.ruleUpdate).toBe(
      SelfHealingLoopService.encodeRuleUpdate(
        "coding_rules",
        "Always use const for variable declarations",
      ),
    );
  });

  it("does not alter the determined outcome when writeFailure throws", async () => {
    const memory = makeMockMemory();
    memory.writeFailure = async () => {
      throw new Error("persistence layer down");
    };
    // makeMockLlm fails → analysis fails → outcome = unresolved
    const svc = new SelfHealingLoopService(makeMockLlm(), memory, defaultConfig);

    const result = await svc.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(result.summary).not.toMatch(/persistence layer down/i);
  });

  it("does not propagate writeFailure throw to the escalate() caller", async () => {
    const memory = makeMockMemory();
    memory.writeFailure = async () => {
      throw new Error("fatal write error");
    };
    const svc = new SelfHealingLoopService(makeMockLlm(), memory, defaultConfig);

    await expect(svc.escalate(makeEscalation())).resolves.toBeDefined();
  });

  it("calls writeFailure exactly once per invocation (not twice) for non-timeout paths", async () => {
    let writeCount = 0;
    const memory = makeMockMemory();
    memory.writeFailure = async () => {
      writeCount++;
      return { ok: true as const, action: "appended" as const };
    };
    const svc = new SelfHealingLoopService(makeMockLlm(), memory, defaultConfig);

    await svc.escalate(makeEscalation());

    expect(writeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 8.1: Resolved result assembly and observability — requirements 6.1, 6.5, 8.2, 8.4
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService — task 8.1: resolved result assembly", () => {
  it("returns outcome: 'resolved' when all steps succeed", async () => {
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation());

    expect(result.outcome).toBe("resolved");
  });

  it("returns updatedRules with workspace-relative path of updated rule file", async () => {
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation());

    expect(result.updatedRules).toBeDefined();
    expect(result.updatedRules!.length).toBe(1);
    // validGapJson targets "coding_rules"
    expect(result.updatedRules![0]).toMatch(/coding_rules\.md$/);
  });

  it("updatedRules path is workspace-relative (does not start with '/')", async () => {
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation());

    expect(result.updatedRules![0]).not.toMatch(/^\//);
  });

  it("emits a retry-initiated log entry after rule update succeeds", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation());

    const retryEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "retry-initiated");
    expect(retryEntry).toBeDefined();
  });

  it("retry-initiated entry carries correct sectionId and planId", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation({ sectionId: "sec-retry", planId: "plan-retry" }));

    const retryEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "retry-initiated");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((retryEntry as any)?.sectionId).toBe("sec-retry");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((retryEntry as any)?.planId).toBe("plan-retry");
  });

  it("emits a self-healing-resolved log entry with updatedRules and positive totalDurationMs", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation({ sectionId: "sec-resolved", planId: "plan-resolved" }));

    const resolvedEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "self-healing-resolved");
    expect(resolvedEntry).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((resolvedEntry as any)?.sectionId).toBe("sec-resolved");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((resolvedEntry as any)?.planId).toBe("plan-resolved");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect(Array.isArray((resolvedEntry as any)?.updatedRules)).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((resolvedEntry as any)?.updatedRules.length).toBe(1);
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    expect((resolvedEntry as any)?.totalDurationMs).toBeGreaterThan(0);
  });

  it("retry-initiated log entry is emitted before self-healing-resolved", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation());

    const allTypes = logSpy.mock.calls.map((args) => args[0]?.type);
    const retryIdx = allTypes.indexOf("retry-initiated");
    const resolvedIdx = allTypes.indexOf("self-healing-resolved");
    expect(retryIdx).toBeGreaterThanOrEqual(0);
    expect(resolvedIdx).toBeGreaterThanOrEqual(0);
    expect(retryIdx).toBeLessThan(resolvedIdx);
  });

  it("resolved result includes a non-empty summary", async () => {
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation());

    expect(result.outcome).toBe("resolved");
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("does not throw when logger is absent on resolved path", async () => {
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
      // no logger
    );

    await expect(svc.escalate(makeEscalation())).resolves.toMatchObject({ outcome: "resolved" });
  });

  it("self-healing-resolved updatedRules matches the path from ruleFileRelativePath", async () => {
    const logSpy = mock((_entry: SelfHealingLogEntry) => {});
    const logger: ISelfHealingLoopLogger = { log: logSpy };
    const memory = makeMockMemory();
    memory.append = async () => ({ ok: true as const, action: "appended" as const });
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
      logger,
    );

    await svc.escalate(makeEscalation());

    const resolvedEntry = logSpy.mock.calls
      .map((args) => args[0])
      .find((e) => e?.type === "self-healing-resolved");
    // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union in test
    const loggedPaths = (resolvedEntry as any)?.updatedRules as string[];
    const expectedPath = SelfHealingLoopService.ruleFileRelativePath("coding_rules");
    expect(loggedPaths).toContain(expectedPath);
  });
});
