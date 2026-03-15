/**
 * Integration tests for SelfHealingLoopService — Tasks 10.1, 10.2, 10.3
 *
 * Task 10.1 — Full happy-path integration with in-memory MemoryPort stub:
 * - Wire SelfHealingLoopService to an in-memory MemoryPort stub and mock LlmProviderPort
 * - Execute full analysis → gap → rule update → resolved flow
 * - Assert updatedRules contains correct workspace-relative paths
 * - Verify failure record is stored and readable via MemoryPort.getFailures()
 * - Verify NDJSON log file receives all expected entries via NdjsonSelfHealingLoopLogger
 *
 * Task 10.2 — Duplicate gap detection integration test:
 * - Pre-seed in-memory stub with a failure record matching sectionId and targetFile+proposedChange
 * - Execute escalate() and assert outcome: "unresolved" with "duplicate gap detected"
 *
 * Task 10.3 — Workspace boundary and append-only persistence:
 * - Verify that rule file paths outside workspaceRoot are rejected by isPathWithinWorkspace
 * - Verify no MemoryPort.append call occurs on unresolved escalations
 * - Execute two escalate() calls with different outcomes and verify two distinct failure records
 *   are appended without modifying prior entries
 *
 * Integration scope:
 * - Real SelfHealingLoopService (full orchestration logic, no internal mocking)
 * - Real NdjsonSelfHealingLoopLogger writing to a temp directory (task 10.1 NDJSON test)
 * - In-memory MemoryPort stub with real accumulation and getFailures() semantics
 * - Mock LlmProviderPort with controlled two-phase responses
 *
 * Requirements: 2.4, 3.4, 3.5, 4.5, 5.2, 6.5
 */

import type {
  FailureFilter,
  FailureRecord,
  MemoryEntry,
  MemoryPort,
  MemoryTarget,
  MemoryWriteResult,
  MemoryWriteTrigger,
  ShortTermMemoryPort,
} from "@/application/ports/memory";
import {
  type SelfHealingLoopConfig,
  SelfHealingLoopService,
} from "@/application/self-healing-loop/self-healing-loop-service";
import type { SectionEscalation } from "@/domain/implementation-loop/types";
import { NdjsonSelfHealingLoopLogger } from "@/infra/self-healing/ndjson-logger";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// In-memory MemoryPort stub — accumulates entries for post-call assertion
// ---------------------------------------------------------------------------

interface AppendCall {
  target: MemoryTarget;
  entry: MemoryEntry;
  trigger: MemoryWriteTrigger;
}

class InMemoryMemoryPort implements MemoryPort {
  readonly shortTerm: ShortTermMemoryPort = {
    read: () => ({ recentFiles: [] }),
    write: () => {},
    clear: () => {},
  };

  readonly appendCalls: AppendCall[] = [];
  readonly failureRecords: FailureRecord[] = [];

  /** Pre-seed a failure record for duplicate-gap detection tests. */
  seed(record: FailureRecord): void {
    this.failureRecords.push({ ...record });
  }

  async query() {
    return { entries: [] };
  }

  async append(target: MemoryTarget, entry: MemoryEntry, trigger: MemoryWriteTrigger): Promise<MemoryWriteResult> {
    this.appendCalls.push({ target, entry, trigger });
    return { ok: true as const, action: "appended" as const };
  }

  async update(): Promise<MemoryWriteResult> {
    return { ok: true as const, action: "updated" as const };
  }

  async writeFailure(record: FailureRecord): Promise<MemoryWriteResult> {
    this.failureRecords.push({ ...record });
    return { ok: true as const, action: "appended" as const };
  }

  async getFailures(filter?: FailureFilter): Promise<readonly FailureRecord[]> {
    if (!filter) return [...this.failureRecords];
    return this.failureRecords.filter(
      (r) =>
        (filter.taskId === undefined || r.taskId === filter.taskId) &&
        (filter.specName === undefined || r.specName === filter.specName),
    );
  }
}

// ---------------------------------------------------------------------------
// LLM mock helpers
// ---------------------------------------------------------------------------

const validRootCauseJson = JSON.stringify({
  attemptsNarrative: "Attempted to write TypeScript files with strict null checks",
  failureNarrative: "TypeScript compiler rejected null assertions in every attempt",
  recurringPattern: "Missing null-check guards in generated TypeScript code",
});

const validGapJson = JSON.stringify({
  targetFile: "coding_rules",
  proposedChange: "Always add null-check guards before accessing optional properties",
  rationale: "Pattern shows null assertion failures recurring across all retries",
});

const noActionableGapJson = JSON.stringify({
  targetFile: null,
  proposedChange: "",
  rationale: "No actionable knowledge gap identified for this failure pattern",
});

/**
 * Two-phase LLM: first call → valid root-cause JSON; subsequent calls → gapResponse.
 */
function makeTwoPhaseLlm(
  gapResponse: { ok: true; content: string } | { ok: false; message?: string },
) {
  let callCount = 0;
  return {
    complete: async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true as const,
          value: { content: validRootCauseJson, usage: { inputTokens: 10, outputTokens: 20 } },
        };
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

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const defaultConfig: SelfHealingLoopConfig = {
  workspaceRoot: "/workspace",
  selfHealingTimeoutMs: 10_000,
  analysisTimeoutMs: 5_000,
  maxAnalysisRetries: 1,
  maxRecordSizeBytes: 65_536,
};

function makeEscalation(overrides: Partial<SectionEscalation> = {}): SectionEscalation {
  return {
    sectionId: "integration-sec-1",
    planId: "integration-plan-abc",
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

/**
 * Build a pre-seeded FailureRecord for duplicate-gap detection tests.
 * The ruleUpdate encodes the same targetFile+proposedChange as validGapJson.
 */
function makePreSeededFailureRecord(taskId: string, specName = "plan-dup"): FailureRecord {
  return {
    taskId,
    specName,
    phase: "IMPLEMENTATION",
    attempted: "{}",
    errors: [],
    rootCause: "unknown",
    ruleUpdate: SelfHealingLoopService.encodeRuleUpdate(
      "coding_rules",
      "Always add null-check guards before accessing optional properties",
    ),
    timestamp: "2026-03-14T10:00:00.000Z",
  };
}

/** Wait for fire-and-forget NDJSON writes to reach the filesystem. */
async function flushFileWrites(): Promise<void> {
  await new Promise((r) => setTimeout(r, 80));
}

// ---------------------------------------------------------------------------
// Task 10.1: Full happy-path integration
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService integration — task 10.1: full happy-path", () => {
  it("returns outcome: 'resolved' with updatedRules containing the correct workspace-relative path", async () => {
    const memory = new InMemoryMemoryPort();
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation());

    expect(result.outcome).toBe("resolved");
    expect(result.updatedRules).toBeDefined();
    expect(result.updatedRules!.length).toBe(1);
    expect(result.updatedRules![0]).toBe(".kiro/steering/coding_rules.md");
  });

  it("persists one failure record, readable via getFailures() after escalation", async () => {
    const memory = new InMemoryMemoryPort();
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation({ sectionId: "sec-persist", planId: "plan-persist" }));

    const records = await memory.getFailures({ taskId: "sec-persist" });
    expect(records.length).toBe(1);
    expect(records[0]!.taskId).toBe("sec-persist");
    expect(records[0]!.specName).toBe("plan-persist");
    expect(records[0]!.phase).toBe("IMPLEMENTATION");
  });

  it("failure record on resolved path includes ruleUpdate encoding the targetFile and proposedChange", async () => {
    const memory = new InMemoryMemoryPort();
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation());

    const records = await memory.getFailures();
    expect(records.length).toBe(1);
    expect(records[0]!.ruleUpdate).toBeDefined();

    const parsed = JSON.parse(records[0]!.ruleUpdate!) as { targetFile: string; proposedChange: string };
    expect(parsed.targetFile).toBe("coding_rules");
    expect(parsed.proposedChange).toBe("Always add null-check guards before accessing optional properties");
  });

  it("calls MemoryPort.append exactly once on the resolved path", async () => {
    const memory = new InMemoryMemoryPort();
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation());

    expect(memory.appendCalls.length).toBe(1);
    expect(memory.appendCalls[0]!.target).toEqual({ type: "knowledge", file: "coding_rules" });
    expect(memory.appendCalls[0]!.trigger).toBe("self_healing");
  });

  it("append call description contains the machine-readable self-healing marker", async () => {
    const memory = new InMemoryMemoryPort();
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation({ sectionId: "sec-marker" }));

    expect(memory.appendCalls.length).toBe(1);
    const description = memory.appendCalls[0]!.entry.description;
    expect(description).toContain("<!-- self-healing: sec-marker");
  });

  it("NDJSON log file receives entries for all major happy-path steps", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "self-healing-integration-"));
    try {
      const memory = new InMemoryMemoryPort();
      const planId = "plan-ndjson-test";
      const logger = new NdjsonSelfHealingLoopLogger(planId, tmpDir);
      const svc = new SelfHealingLoopService(
        makeTwoPhaseLlm({ ok: true, content: validGapJson }),
        memory,
        defaultConfig,
        logger,
      );

      await svc.escalate(makeEscalation({ planId }));
      await flushFileWrites();

      const logPath = join(tmpDir, `self-healing-${planId}.ndjson`);
      const content = await readFile(logPath, "utf8");
      const entries = content
        .trim()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { type: string });

      const types = entries.map((e) => e.type);
      expect(types).toContain("escalation-intake");
      expect(types).toContain("analysis-complete");
      expect(types).toContain("gap-identified");
      expect(types).toContain("rule-updated");
      expect(types).toContain("retry-initiated");
      expect(types).toContain("self-healing-resolved");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Task 10.2: Duplicate gap detection integration
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService integration — task 10.2: duplicate gap detection", () => {
  it("returns unresolved with 'duplicate gap detected' when a matching failure record is pre-seeded", async () => {
    const memory = new InMemoryMemoryPort();
    memory.seed(makePreSeededFailureRecord("sec-dup"));

    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation({ sectionId: "sec-dup", planId: "plan-dup" }));

    expect(result.outcome).toBe("unresolved");
    expect(result.summary.toLowerCase()).toContain("duplicate gap detected");
  });

  it("does NOT call MemoryPort.append when a duplicate gap is detected", async () => {
    const memory = new InMemoryMemoryPort();
    memory.seed(makePreSeededFailureRecord("sec-dup-no-append"));

    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation({ sectionId: "sec-dup-no-append", planId: "plan-dup" }));

    expect(memory.appendCalls.length).toBe(0);
  });

  it("still persists a failure record even when duplicate gap halts the workflow", async () => {
    const memory = new InMemoryMemoryPort();
    memory.seed(makePreSeededFailureRecord("sec-dup-record"));
    const recordCountBefore = memory.failureRecords.length;

    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );

    await svc.escalate(makeEscalation({ sectionId: "sec-dup-record", planId: "plan-dup" }));

    // A new failure record must be written regardless of outcome (requirement 5.2)
    expect(memory.failureRecords.length).toBe(recordCountBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// Task 10.3: Workspace boundary and append-only persistence
// ---------------------------------------------------------------------------

describe("SelfHealingLoopService integration — task 10.3: workspace boundary & append-only persistence", () => {
  it("isPathWithinWorkspace rejects a path that escapes the workspace root", () => {
    expect(SelfHealingLoopService.isPathWithinWorkspace("/workspace", "/etc/passwd")).toBe(false);
    expect(SelfHealingLoopService.isPathWithinWorkspace("/workspace", "/workspace-other/file.md")).toBe(false);
    expect(SelfHealingLoopService.isPathWithinWorkspace("/workspace", "/workspace/../etc/passwd")).toBe(false);
  });

  it("isPathWithinWorkspace accepts paths that are inside the workspace root", () => {
    expect(SelfHealingLoopService.isPathWithinWorkspace("/workspace", "/workspace/.kiro/steering/coding_rules.md")).toBe(true);
    expect(SelfHealingLoopService.isPathWithinWorkspace("/workspace", "/workspace")).toBe(true);
  });

  it("MemoryPort.append is NOT called on an unresolved escalation (no actionable gap)", async () => {
    const memory = new InMemoryMemoryPort();
    const svc = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: noActionableGapJson }),
      memory,
      defaultConfig,
    );

    const result = await svc.escalate(makeEscalation());

    expect(result.outcome).toBe("unresolved");
    expect(memory.appendCalls.length).toBe(0);
  });

  it("two escalate() calls produce two distinct failure records with no modification to prior entries", async () => {
    const memory = new InMemoryMemoryPort();

    const svc1 = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );
    await svc1.escalate(makeEscalation({ sectionId: "sec-call-1", planId: "plan-two-calls" }));

    // Snapshot the first record before the second call
    expect(memory.failureRecords.length).toBe(1);
    const firstRecord = { ...memory.failureRecords[0]! };

    // Second call: unresolved (empty retryHistory)
    const svc2 = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );
    await svc2.escalate(makeEscalation({ sectionId: "sec-call-2", planId: "plan-two-calls", retryHistory: [] }));

    expect(memory.failureRecords.length).toBe(2);
    expect(memory.failureRecords[0]!.taskId).toBe("sec-call-1");
    expect(memory.failureRecords[1]!.taskId).toBe("sec-call-2");

    // The first record is unchanged (append-only semantics)
    expect(memory.failureRecords[0]!.taskId).toBe(firstRecord.taskId);
    expect(memory.failureRecords[0]!.specName).toBe(firstRecord.specName);
    expect(memory.failureRecords[0]!.attempted).toBe(firstRecord.attempted);
    expect(memory.failureRecords[0]!.timestamp).toBe(firstRecord.timestamp);
  });

  it("second call does not overwrite the first failure record when both calls target different sectionIds", async () => {
    const memory = new InMemoryMemoryPort();

    const svc1 = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );
    await svc1.escalate(makeEscalation({ sectionId: "sec-alpha", planId: "plan-persist-check" }));
    const firstTimestamp = memory.failureRecords[0]!.timestamp;

    const svc2 = new SelfHealingLoopService(
      makeTwoPhaseLlm({ ok: true, content: validGapJson }),
      memory,
      defaultConfig,
    );
    await svc2.escalate(makeEscalation({ sectionId: "sec-beta", planId: "plan-persist-check" }));

    // Original record still has the same timestamp (was not overwritten)
    expect(memory.failureRecords[0]!.timestamp).toBe(firstTimestamp);
    expect(memory.failureRecords.length).toBe(2);
    expect(memory.failureRecords[1]!.taskId).toBe("sec-beta");
  });
});
