import { MockLlmProvider } from "@/adapters/llm/mock-llm-provider";
import type { IDebugEventSink } from "@/application/ports/debug";
import type { IWorkflowEventBus } from "@/application/ports/workflow";
import type { WorkflowEvent } from "@/application/ports/workflow";
import type { DebugEvent } from "@/domain/debug/types";
import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeSink(): IDebugEventSink & { events: DebugEvent[] } {
  const events: DebugEvent[] = [];
  return {
    events,
    emit(event: DebugEvent) {
      events.push(event);
    },
    async close() {},
  };
}

function makeEventBus(): IWorkflowEventBus & {
  handlers: Array<(event: WorkflowEvent) => void>;
} {
  const handlers: Array<(event: WorkflowEvent) => void> = [];
  return {
    handlers,
    emit(event: WorkflowEvent) {
      for (const h of handlers) h(event);
    },
    on(handler: (event: WorkflowEvent) => void) {
      handlers.push(handler);
    },
    off(handler: (event: WorkflowEvent) => void) {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    },
  };
}

// ---------------------------------------------------------------------------
// complete() — success path
// ---------------------------------------------------------------------------

describe("MockLlmProvider.complete()", () => {
  let sink: ReturnType<typeof makeSink>;
  let bus: ReturnType<typeof makeEventBus>;
  let provider: MockLlmProvider;

  beforeEach(() => {
    sink = makeSink();
    bus = makeEventBus();
    provider = new MockLlmProvider({
      sink,
      workflowEventBus: bus,
    });
  });

  it("returns ok:true with valid JSON content for a PLAN prompt", async () => {
    const result = await provider.complete("test prompt");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = JSON.parse(result.value.content) as Record<string, unknown>;
      expect(parsed.category).toBe("Exploration");
      expect(parsed.toolName).toBe("list_directory");
    }
  });

  it("returns ok:true with taskComplete:true for a REFLECT prompt", async () => {
    const result = await provider.complete(
      "respond with JSON: { \"planAdjustment\": \"continue\"|\"revise\"|\"stop\" }",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = JSON.parse(result.value.content) as Record<string, unknown>;
      expect(parsed.taskComplete).toBe(true);
      expect(parsed.assessment).toBe("expected");
    }
  });

  it("emits an llm:call event with correct fields", async () => {
    await provider.complete("hello world");
    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0]!;
    expect(ev.type).toBe("llm:call");
    if (ev.type === "llm:call") {
      expect(ev.callIndex).toBe(1);
      expect(ev.prompt).toBe("hello world");
      expect(typeof ev.response).toBe("string");
      expect(ev.phase).toBe("UNKNOWN"); // no phase:start emitted yet
      expect(ev.iterationNumber).toBeNull();
      expect(typeof ev.durationMs).toBe("number");
      expect(typeof ev.timestamp).toBe("string");
    }
  });

  it("uses iterationNumber from options in the emitted event", async () => {
    await provider.complete("prompt", { iterationNumber: 5 });
    const ev = sink.events[0];
    if (ev?.type === "llm:call") {
      expect(ev.iterationNumber).toBe(5);
    }
  });

  it("sets iterationNumber to null when options omit it", async () => {
    await provider.complete("prompt");
    const ev = sink.events[0];
    if (ev?.type === "llm:call") {
      expect(ev.iterationNumber).toBeNull();
    }
  });

  it("increments callIndex monotonically across multiple calls", async () => {
    await provider.complete("first");
    await provider.complete("second");
    await provider.complete("third");

    expect(sink.events).toHaveLength(3);
    const indices = sink.events.map((e) => (e.type === "llm:call" ? e.callIndex : -1));
    expect(indices).toEqual([1, 2, 3]);
  });

  it("records correct phase after phase:start event", async () => {
    bus.emit({ type: "phase:start", phase: "SPEC_REQUIREMENTS", timestamp: "2026-01-01T00:00:00.000Z" });
    await provider.complete("prompt");

    const ev = sink.events[0];
    expect(ev?.type).toBe("llm:call");
    if (ev?.type === "llm:call") {
      expect(ev.phase).toBe("SPEC_REQUIREMENTS");
    }
  });

  it("updates phase when phase:start is emitted again", async () => {
    bus.emit({ type: "phase:start", phase: "SPEC_REQUIREMENTS", timestamp: "t1" });
    await provider.complete("first");
    bus.emit({ type: "phase:start", phase: "SPEC_DESIGN", timestamp: "t2" });
    await provider.complete("second");

    const phases = sink.events.map((e) => (e.type === "llm:call" ? e.phase : ""));
    expect(phases).toEqual(["SPEC_REQUIREMENTS", "SPEC_DESIGN"]);
  });

  it("uses UNKNOWN phase before any phase:start event", async () => {
    await provider.complete("prompt");
    const ev = sink.events[0];
    if (ev?.type === "llm:call") {
      expect(ev.phase).toBe("UNKNOWN");
    }
  });

  it("returns usage fields in the result", async () => {
    const result = await provider.complete("prompt");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.usage.inputTokens).toBe("number");
      expect(typeof result.value.usage.outputTokens).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// clearContext()
// ---------------------------------------------------------------------------

describe("MockLlmProvider.clearContext()", () => {
  let sink: ReturnType<typeof makeSink>;
  let bus: ReturnType<typeof makeEventBus>;
  let provider: MockLlmProvider;

  beforeEach(() => {
    sink = makeSink();
    bus = makeEventBus();
    provider = new MockLlmProvider({
      sink,
      workflowEventBus: bus,
    });
  });

  it("does not reset callIndex", async () => {
    await provider.complete("first");
    provider.clearContext();
    await provider.complete("second");

    const indices = sink.events.map((e) => (e.type === "llm:call" ? e.callIndex : -1));
    expect(indices).toEqual([1, 2]);
  });

  it("does not reset the current phase", async () => {
    bus.emit({ type: "phase:start", phase: "SPEC_DESIGN", timestamp: "t" });
    await provider.complete("before");
    provider.clearContext();
    await provider.complete("after");

    const phases = sink.events.map((e) => (e.type === "llm:call" ? e.phase : ""));
    expect(phases).toEqual(["SPEC_DESIGN", "SPEC_DESIGN"]);
  });
});
