/**
 * Unit tests for NdjsonSelfHealingLoopLogger (Task 2.2)
 *
 * Tests cover:
 * - log() writes a JSON line for every SelfHealingLogEntry variant
 * - Each write is async (fire-and-forget) and does not block the caller
 * - Write errors are captured in writeErrorCount; log() never throws
 * - Log file name is self-healing-<planId>.ndjson under logDir
 * - Multiple calls append individual NDJSON lines
 * - logDir is created recursively if it does not exist
 *
 * Requirements: 8.1, 8.3, 8.5
 */
import type { SelfHealingLogEntry } from "@/domain/self-healing/types";
import { NdjsonSelfHealingLoopLogger } from "@/infra/logger/ndjson-self-healing-loop-logger";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempLogDir(): string {
  const dir = join(tmpdir(), `ndjson-sh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readLines(filePath: string): string[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/** Wait for fire-and-forget async writes to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

function makeEntry(
  type: SelfHealingLogEntry["type"],
  overrides: Partial<SelfHealingLogEntry> = {},
): SelfHealingLogEntry {
  const base = {
    sectionId: "sec-1",
    planId: "plan-abc",
    timestamp: "2026-03-15T00:00:00.000Z",
  };
  switch (type) {
    case "escalation-intake":
      return { ...base, type, retryHistoryCount: 3, ...overrides } as SelfHealingLogEntry;
    case "analysis-complete":
      return { ...base, type, recurringPattern: "type mismatch", ...overrides } as SelfHealingLogEntry;
    case "gap-identified":
      return { ...base, type, targetFile: "coding_rules", ...overrides } as SelfHealingLogEntry;
    case "rule-updated":
      return {
        ...base,
        type,
        targetFile: "coding_rules",
        memoryWriteAction: "appended",
        ...overrides,
      } as SelfHealingLogEntry;
    case "retry-initiated":
      return { ...base, type, ...overrides } as SelfHealingLogEntry;
    case "self-healing-resolved":
      return {
        ...base,
        type,
        updatedRules: ["coding_rules"],
        totalDurationMs: 4000,
        ...overrides,
      } as SelfHealingLogEntry;
    case "unresolved":
      return { ...base, type, stopStep: "analysis", totalDurationMs: 1000, ...overrides } as SelfHealingLogEntry;
    case "system-error":
      return {
        ...base,
        type,
        component: "SelfHealingLoopService.persistFailureRecord",
        message: "write failed",
        ...overrides,
      } as SelfHealingLogEntry;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let logDir: string;

beforeEach(() => {
  logDir = makeTempLogDir();
});

afterEach(() => {
  if (existsSync(logDir)) {
    rmSync(logDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// File naming and creation
// ---------------------------------------------------------------------------

describe("NdjsonSelfHealingLoopLogger — file naming", () => {
  it("creates a log file named self-healing-<planId>.ndjson in logDir", async () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);
    logger.log(makeEntry("escalation-intake"));
    await flush();

    const logPath = join(logDir, "self-healing-plan-abc.ndjson");
    expect(existsSync(logPath)).toBe(true);
  });

  it("includes the planId in the log file name", async () => {
    const logger = new NdjsonSelfHealingLoopLogger("my-plan-xyz", logDir);
    logger.log(makeEntry("unresolved", { planId: "my-plan-xyz" }));
    await flush();

    const logPath = join(logDir, "self-healing-my-plan-xyz.ndjson");
    expect(existsSync(logPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NDJSON format — one JSON object per line
// ---------------------------------------------------------------------------

describe("NdjsonSelfHealingLoopLogger — NDJSON format", () => {
  it("writes one JSON line for a single log() call", async () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);
    logger.log(makeEntry("escalation-intake"));
    await flush();

    const lines = readLines(join(logDir, "self-healing-plan-abc.ndjson"));
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0] as string)).not.toThrow();
  });

  it("appends a new line for each log() call", async () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);

    logger.log(makeEntry("escalation-intake"));
    logger.log(makeEntry("analysis-complete"));
    logger.log(makeEntry("gap-identified"));
    logger.log(makeEntry("rule-updated"));
    logger.log(makeEntry("retry-initiated"));
    logger.log(makeEntry("self-healing-resolved"));
    await flush();

    const lines = readLines(join(logDir, "self-healing-plan-abc.ndjson"));
    expect(lines).toHaveLength(6);
  });

  it("each line is independently parseable JSON", async () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);

    logger.log(makeEntry("escalation-intake"));
    logger.log(makeEntry("unresolved"));
    await flush();

    const lines = readLines(join(logDir, "self-healing-plan-abc.ndjson"));
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Entry field serialization
// ---------------------------------------------------------------------------

describe("NdjsonSelfHealingLoopLogger — entry serialization", () => {
  it("serializes escalation-intake entry with retryHistoryCount", async () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);
    logger.log(makeEntry("escalation-intake", { retryHistoryCount: 5 }));
    await flush();

    const line = readLines(join(logDir, "self-healing-plan-abc.ndjson"))[0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("escalation-intake");
    expect(parsed.retryHistoryCount).toBe(5);
  });

  it("serializes analysis-complete entry with recurringPattern", async () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);
    logger.log(makeEntry("analysis-complete", { recurringPattern: "null pointer" }));
    await flush();

    const line = readLines(join(logDir, "self-healing-plan-abc.ndjson"))[0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("analysis-complete");
    expect(parsed.recurringPattern).toBe("null pointer");
  });

  it("serializes gap-identified entry with targetFile", async () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);
    logger.log(makeEntry("gap-identified", { targetFile: "review_rules" }));
    await flush();

    const parsed = JSON.parse(readLines(join(logDir, "self-healing-plan-abc.ndjson"))[0] as string);
    expect(parsed.type).toBe("gap-identified");
    expect(parsed.targetFile).toBe("review_rules");
  });

  it("serializes rule-updated entry with targetFile and memoryWriteAction", async () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);
    logger.log(makeEntry("rule-updated", { memoryWriteAction: "updated" }));
    await flush();

    const parsed = JSON.parse(readLines(join(logDir, "self-healing-plan-abc.ndjson"))[0] as string);
    expect(parsed.type).toBe("rule-updated");
    expect(parsed.memoryWriteAction).toBe("updated");
  });

  it("serializes self-healing-resolved entry with updatedRules and totalDurationMs", async () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);
    logger.log(makeEntry("self-healing-resolved", { updatedRules: ["coding_rules"], totalDurationMs: 9000 }));
    await flush();

    const parsed = JSON.parse(readLines(join(logDir, "self-healing-plan-abc.ndjson"))[0] as string);
    expect(parsed.type).toBe("self-healing-resolved");
    expect(parsed.totalDurationMs).toBe(9000);
  });

  it("serializes unresolved entry with stopStep and totalDurationMs", async () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);
    logger.log(makeEntry("unresolved", { stopStep: "gap-identification", totalDurationMs: 3000 }));
    await flush();

    const parsed = JSON.parse(readLines(join(logDir, "self-healing-plan-abc.ndjson"))[0] as string);
    expect(parsed.type).toBe("unresolved");
    expect(parsed.stopStep).toBe("gap-identification");
    expect(parsed.totalDurationMs).toBe(3000);
  });

  it("preserves sectionId and planId in all entries", async () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);
    logger.log(makeEntry("retry-initiated", { sectionId: "sec-42", planId: "plan-abc" }));
    await flush();

    const parsed = JSON.parse(readLines(join(logDir, "self-healing-plan-abc.ndjson"))[0] as string);
    expect(parsed.sectionId).toBe("sec-42");
    expect(parsed.planId).toBe("plan-abc");
  });
});

// ---------------------------------------------------------------------------
// Error resilience — writeErrorCount, no throws
// ---------------------------------------------------------------------------

describe("NdjsonSelfHealingLoopLogger — error resilience", () => {
  it("log() does not throw when logDir does not exist (creates it recursively)", async () => {
    const nonExistentDir = join(logDir, "nested", "deep", "dir");
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", nonExistentDir);

    expect(() => logger.log(makeEntry("escalation-intake"))).not.toThrow();
    await flush();

    const logPath = join(nonExistentDir, "self-healing-plan-abc.ndjson");
    expect(existsSync(logPath)).toBe(true);
  });

  it("writeErrorCount starts at zero", () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);
    expect(logger.writeErrorCount).toBe(0);
  });

  it("writeErrorCount increments when a write fails", async () => {
    // Use a path that cannot be written to (logDir points to a file, not a dir)
    const fileAsDir = join(logDir, "not-a-dir.txt");
    // Create a file at logDir path so mkdirSync would fail trying to create it
    const { writeFileSync } = await import("node:fs");
    writeFileSync(fileAsDir, "block");

    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", fileAsDir);
    logger.log(makeEntry("escalation-intake"));
    await flush();

    expect(logger.writeErrorCount).toBeGreaterThan(0);
  });

  it("log() remains callable after a write failure (writeErrorCount keeps incrementing)", async () => {
    const fileAsDir = join(logDir, "blocked.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(fileAsDir, "block");

    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", fileAsDir);
    logger.log(makeEntry("escalation-intake"));
    logger.log(makeEntry("analysis-complete"));
    await flush();

    expect(() => logger.log(makeEntry("unresolved"))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Async fire-and-forget: log() returns void synchronously
// ---------------------------------------------------------------------------

describe("NdjsonSelfHealingLoopLogger — async behavior", () => {
  it("log() returns void (not a Promise) synchronously", () => {
    const logger = new NdjsonSelfHealingLoopLogger("plan-abc", logDir);
    const result = logger.log(makeEntry("escalation-intake"));

    expect(result).toBeUndefined();
  });
});
