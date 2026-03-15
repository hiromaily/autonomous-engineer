/**
 * Unit tests for NdjsonImplementationLoopLogger (Task 4.6)
 *
 * Tests cover:
 * - logIteration writes a JSON line with type: "iteration" to the log file
 * - logSectionComplete writes a JSON line with type: "section-complete"
 * - logHaltSummary writes a JSON line with type: "halt-summary"
 * - Each write produces valid NDJSON (one JSON object per line)
 * - Log file is created under the given logDir with the expected file name
 * - Multiple calls append additional lines (NDJSON format preserved)
 * - Errors during write do not throw (fire-and-forget)
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */
import type { SectionIterationLogEntry } from "@/application/ports/implementation-loop";
import type { SectionExecutionRecord } from "@/domain/implementation-loop/types";
import { NdjsonImplementationLoopLogger } from "@/infra/implementation-loop/ndjson-logger";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempLogDir(): string {
  const dir = join(tmpdir(), `ndjson-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readLines(filePath: string): string[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function makeIterationEntry(overrides: Partial<SectionIterationLogEntry> = {}): SectionIterationLogEntry {
  return {
    planId: "plan-abc",
    sectionId: "section-1",
    iterationNumber: 1,
    reviewOutcome: "passed",
    gateCheckResults: [],
    durationMs: 100,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeSectionCompleteRecord(overrides: Partial<SectionExecutionRecord> = {}): SectionExecutionRecord {
  return {
    sectionId: "section-1",
    planId: "plan-abc",
    title: "Implement feature X",
    status: "completed",
    retryCount: 0,
    iterations: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    commitSha: "abc123def",
    ...overrides,
  };
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
// logIteration
// ---------------------------------------------------------------------------

describe("NdjsonImplementationLoopLogger — logIteration", () => {
  it("creates the log file with a JSON line when logIteration is called", () => {
    const logger = new NdjsonImplementationLoopLogger("plan-abc", logDir);
    const entry = makeIterationEntry();

    logger.logIteration(entry);

    const logPath = join(logDir, "implementation-loop-plan-abc.ndjson");
    expect(existsSync(logPath)).toBe(true);
  });

  it("writes a valid JSON object containing type: iteration", () => {
    const logger = new NdjsonImplementationLoopLogger("plan-abc", logDir);
    logger.logIteration(makeIterationEntry());

    const logPath = join(logDir, "implementation-loop-plan-abc.ndjson");
    const lines = readLines(logPath);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.type).toBe("iteration");
  });

  it("includes planId, sectionId, iterationNumber, reviewOutcome in the log entry", () => {
    const logger = new NdjsonImplementationLoopLogger("plan-abc", logDir);
    const entry = makeIterationEntry({
      planId: "plan-abc",
      sectionId: "section-1",
      iterationNumber: 2,
      reviewOutcome: "failed",
    });

    logger.logIteration(entry);

    const logPath = join(logDir, "implementation-loop-plan-abc.ndjson");
    const parsed = JSON.parse(readLines(logPath)[0] as string);
    expect(parsed.planId).toBe("plan-abc");
    expect(parsed.sectionId).toBe("section-1");
    expect(parsed.iterationNumber).toBe(2);
    expect(parsed.reviewOutcome).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// logSectionComplete
// ---------------------------------------------------------------------------

describe("NdjsonImplementationLoopLogger — logSectionComplete", () => {
  it("writes a valid JSON object containing type: section-complete", () => {
    const logger = new NdjsonImplementationLoopLogger("plan-abc", logDir);
    logger.logSectionComplete(makeSectionCompleteRecord());

    const logPath = join(logDir, "implementation-loop-plan-abc.ndjson");
    const lines = readLines(logPath);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.type).toBe("section-complete");
  });

  it("includes sectionId and status in the section-complete log entry", () => {
    const logger = new NdjsonImplementationLoopLogger("plan-abc", logDir);
    logger.logSectionComplete(makeSectionCompleteRecord({ sectionId: "section-2", status: "completed" }));

    const logPath = join(logDir, "implementation-loop-plan-abc.ndjson");
    const parsed = JSON.parse(readLines(logPath)[0] as string);
    expect(parsed.sectionId).toBe("section-2");
    expect(parsed.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// logHaltSummary
// ---------------------------------------------------------------------------

describe("NdjsonImplementationLoopLogger — logHaltSummary", () => {
  it("writes a valid JSON object containing type: halt-summary", () => {
    const logger = new NdjsonImplementationLoopLogger("plan-abc", logDir);
    logger.logHaltSummary({
      planId: "plan-abc",
      completedSections: ["s1"],
      committedSections: ["s1"],
      haltingSectionId: "s2",
      reason: "Section failed after 3 retries",
      timestamp: new Date().toISOString(),
    });

    const logPath = join(logDir, "implementation-loop-plan-abc.ndjson");
    const lines = readLines(logPath);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.type).toBe("halt-summary");
  });

  it("includes haltingSectionId and reason in the halt-summary entry", () => {
    const logger = new NdjsonImplementationLoopLogger("plan-abc", logDir);
    logger.logHaltSummary({
      planId: "plan-abc",
      completedSections: [],
      committedSections: [],
      haltingSectionId: "failing-section",
      reason: "Max retries exceeded",
      timestamp: new Date().toISOString(),
    });

    const logPath = join(logDir, "implementation-loop-plan-abc.ndjson");
    const parsed = JSON.parse(readLines(logPath)[0] as string);
    expect(parsed.haltingSectionId).toBe("failing-section");
    expect(parsed.reason).toBe("Max retries exceeded");
  });
});

// ---------------------------------------------------------------------------
// NDJSON format: multiple calls append lines
// ---------------------------------------------------------------------------

describe("NdjsonImplementationLoopLogger — NDJSON append behavior", () => {
  it("appends a new line for each call (NDJSON format)", () => {
    const logger = new NdjsonImplementationLoopLogger("plan-abc", logDir);

    logger.logIteration(makeIterationEntry({ iterationNumber: 1 }));
    logger.logIteration(makeIterationEntry({ iterationNumber: 2 }));
    logger.logSectionComplete(makeSectionCompleteRecord());

    const logPath = join(logDir, "implementation-loop-plan-abc.ndjson");
    const lines = readLines(logPath);
    expect(lines).toHaveLength(3);
  });

  it("each line in the log file is independently parseable JSON", () => {
    const logger = new NdjsonImplementationLoopLogger("plan-abc", logDir);

    logger.logIteration(makeIterationEntry({ iterationNumber: 1, reviewOutcome: "failed" }));
    logger.logIteration(makeIterationEntry({ iterationNumber: 2, reviewOutcome: "passed" }));

    const logPath = join(logDir, "implementation-loop-plan-abc.ndjson");
    const lines = readLines(logPath);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.parse(lines[0] as string).reviewOutcome).toBe("failed");
    expect(JSON.parse(lines[1] as string).reviewOutcome).toBe("passed");
  });

  it("log file name includes the planId", () => {
    const logger = new NdjsonImplementationLoopLogger("my-plan-xyz", logDir);
    logger.logIteration(makeIterationEntry({ planId: "my-plan-xyz" }));

    const logPath = join(logDir, "implementation-loop-my-plan-xyz.ndjson");
    expect(existsSync(logPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error resilience: write errors do not propagate
// ---------------------------------------------------------------------------

describe("NdjsonImplementationLoopLogger — error resilience", () => {
  it("does not throw when logDir does not exist (creates it)", () => {
    const nonExistentDir = join(logDir, "nested", "deep", "dir");
    const logger = new NdjsonImplementationLoopLogger("plan-abc", nonExistentDir);

    // Must not throw — mkdirSync with recursive creates the dir
    expect(() => logger.logIteration(makeIterationEntry())).not.toThrow();
  });

  it("log file is created even when logDir is a nested path", () => {
    const nestedDir = join(logDir, "sub", "dir");
    const logger = new NdjsonImplementationLoopLogger("plan-abc", nestedDir);

    logger.logIteration(makeIterationEntry());

    const logPath = join(nestedDir, "implementation-loop-plan-abc.ndjson");
    expect(existsSync(logPath)).toBe(true);
  });
});
