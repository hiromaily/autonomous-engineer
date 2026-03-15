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
import type { ISelfHealingLoopLogger } from "@/application/ports/self-healing-loop-logger";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { MemoryPort, ShortTermMemoryPort } from "@/application/ports/memory";
import {
  SelfHealingLoopService,
  type SelfHealingLoopConfig,
} from "@/application/self-healing-loop/self-healing-loop-service";
import type { SectionEscalation } from "@/domain/implementation-loop/types";
import type { EscalationIntakeLogEntry, SelfHealingLogEntry } from "@/domain/self-healing/types";
import { describe, it, expect, beforeEach, mock } from "bun:test";

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
      () =>
        new SelfHealingLoopService(makeMockLlm(), makeMockMemory(), defaultConfig, makeMockLogger()),
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
