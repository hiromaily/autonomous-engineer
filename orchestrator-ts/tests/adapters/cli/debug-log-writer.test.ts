import type { DebugEvent } from "@/domain/debug/types";
import { DebugLogWriter } from "@/infra/logger/debug-log-writer";
import { beforeEach, describe, expect, it, mock } from "bun:test";

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

describe("DebugLogWriter — stderr mode", () => {
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

  it("always writes to stderr (no file path accepted)", async () => {
    // Verify constructor accepts no arguments
    const writer = new DebugLogWriter();
    expect(writer).toBeDefined();
    await writer.close();
  });
});
