import { DebugLogWriter } from "@/adapters/cli/debug-log-writer";
import type { DebugEvent } from "@/domain/debug/types";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLlmCallEvent(callIndex = 1): DebugEvent {
  return {
    type: "llm:call",
    callIndex,
    phase: "REQUIREMENTS",
    iterationNumber: null,
    prompt: "test prompt",
    response: "[MOCK LLM RESPONSE] done",
    durationMs: 10,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function makeApprovalEvent(): DebugEvent {
  return {
    type: "approval:auto",
    phase: "REQUIREMENTS",
    approvalType: "requirements",
    outcome: "approved",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

describe("DebugLogWriter — stderr mode (no file path)", () => {
  let stderrWrites: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrWrites = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = mock((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;
  });

  it("restores stderr after each test", () => {
    process.stderr.write = originalWrite;
  });

  it("writes llm:call event as human-readable text to stderr", async () => {
    process.stderr.write = mock((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;

    const writer = new DebugLogWriter();
    const event = makeLlmCallEvent();
    writer.emit(event);
    await writer.close();

    process.stderr.write = originalWrite;

    expect(stderrWrites).toHaveLength(1);
    expect(stderrWrites[0]).toContain("[LLM #1]");
    expect(stderrWrites[0]).toContain("phase=REQUIREMENTS");
    expect(stderrWrites[0]).toContain("test prompt");
    expect(stderrWrites[0]).toEndWith("\n");
  });

  it("writes multiple events in order to stderr", async () => {
    const writes: string[] = [];
    process.stderr.write = mock((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;

    const writer = new DebugLogWriter();
    writer.emit(makeLlmCallEvent(1));
    writer.emit(makeLlmCallEvent(2));
    await writer.close();

    process.stderr.write = originalWrite;

    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain("[LLM #1]");
    expect(writes[1]).toContain("[LLM #2]");
  });

  it("silently drops emit() calls after close()", async () => {
    const writes: string[] = [];
    process.stderr.write = mock((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;

    const writer = new DebugLogWriter();
    await writer.close();
    writer.emit(makeLlmCallEvent());

    process.stderr.write = originalWrite;

    expect(writes).toHaveLength(0);
  });
});

describe("DebugLogWriter — file mode", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "debug-log-test-"));
  });

  it("writes events as NDJSON to the specified file", async () => {
    const logPath = join(tmpDir, "debug.ndjson");
    const writer = new DebugLogWriter(logPath);

    const e1 = makeLlmCallEvent(1);
    const e2 = makeApprovalEvent();
    writer.emit(e1);
    writer.emit(e2);
    await writer.close();

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(e1);
    expect(JSON.parse(lines[1]!)).toEqual(e2);
  });

  it("each line is valid JSON terminated by newline", async () => {
    const logPath = join(tmpDir, "debug.ndjson");
    const writer = new DebugLogWriter(logPath);
    writer.emit(makeLlmCallEvent());
    await writer.close();

    const content = await readFile(logPath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(content.trim())).not.toThrow();
  });

  it("creates the file even when no events are emitted", async () => {
    const logPath = join(tmpDir, "empty.ndjson");
    const writer = new DebugLogWriter(logPath);
    await writer.close();

    const content = await readFile(logPath, "utf-8");
    expect(content).toBe("");
  });

  it("silently drops emit() calls after close()", async () => {
    const logPath = join(tmpDir, "after-close.ndjson");
    const writer = new DebugLogWriter(logPath);
    await writer.close();
    writer.emit(makeLlmCallEvent());

    const content = await readFile(logPath, "utf-8");
    expect(content).toBe("");
  });
});

describe("DebugLogWriter — file-open failure fallback", () => {
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    originalWrite = process.stderr.write.bind(process.stderr);
  });

  it("falls back to stderr with warning when file cannot be opened", async () => {
    const badPath = "/nonexistent-dir/impossible/debug.ndjson";
    const writes: string[] = [];
    process.stderr.write = mock((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;

    const writer = new DebugLogWriter(badPath);
    const event = makeLlmCallEvent();
    writer.emit(event);
    await writer.close();

    process.stderr.write = originalWrite;

    // Should have a warning about file failure
    const allOutput = writes.join("");
    expect(allOutput).toContain("Warning");
    // Should still have the event written to stderr
    const debugLines = writes.filter((w) => w.startsWith("[DEBUG] "));
    expect(debugLines).toHaveLength(1);
    const parsed = JSON.parse(debugLines[0]!.slice("[DEBUG] ".length));
    expect(parsed).toEqual(event);
  });
});
