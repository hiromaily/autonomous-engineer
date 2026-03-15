import { DebugAgentEventBus } from "@/application/agent/debug-agent-event-bus";
import type { IDebugEventSink } from "@/application/ports/debug";
import type { IWorkflowEventBus, WorkflowEvent } from "@/application/ports/workflow";
import type { AgentLoopEvent } from "@/domain/agent/types";
import type { DebugEvent } from "@/domain/debug/types";
import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeSink(): IDebugEventSink & { events: DebugEvent[] } {
  const events: DebugEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
    async close() {},
  };
}

function makeWorkflowEventBus(): IWorkflowEventBus & { emit: (event: WorkflowEvent) => void } {
  const handlers: Set<(event: WorkflowEvent) => void> = new Set();
  return {
    emit(event: WorkflowEvent) {
      for (const h of handlers) h(event);
    },
    on(handler: (event: WorkflowEvent) => void) {
      handlers.add(handler);
    },
    off(handler: (event: WorkflowEvent) => void) {
      handlers.delete(handler);
    },
  };
}

function makeBus() {
  const sink = makeSink();
  const workflowEventBus = makeWorkflowEventBus();
  const bus = new DebugAgentEventBus({ sink, workflowEventBus });
  return { sink, workflowEventBus, bus };
}

function makeIterationCompleteEvent(
  iteration = 1,
  category = "Modification",
  toolName = "write_file",
): AgentLoopEvent & { type: "iteration:complete" } {
  return {
    type: "iteration:complete",
    iteration,
    category,
    toolName,
    durationMs: 50,
    assessment: "task_complete",
  } as unknown as AgentLoopEvent & { type: "iteration:complete" };
}

function makeIterationStartEvent(iteration = 1): AgentLoopEvent & { type: "iteration:start" } {
  return {
    type: "iteration:start",
    iteration,
    currentStep: null,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// emit() — iteration:complete maps to agent:iteration debug event
// ---------------------------------------------------------------------------

describe("DebugAgentEventBus.emit() — iteration:complete", () => {
  let sink: ReturnType<typeof makeSink>;
  let bus: DebugAgentEventBus;

  beforeEach(() => {
    ({ sink, bus } = makeBus());
  });

  it("emits an agent:iteration debug event to the sink", () => {
    bus.emit(makeIterationCompleteEvent());

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.type).toBe("agent:iteration");
  });

  it("maps actionCategory from iteration:complete.category", () => {
    bus.emit(makeIterationCompleteEvent(1, "Exploration", "read_file"));

    const ev = sink.events[0];
    if (ev?.type === "agent:iteration") {
      expect(ev.actionCategory).toBe("Exploration");
    }
  });

  it("maps toolName from iteration:complete.toolName", () => {
    bus.emit(makeIterationCompleteEvent(2, "Modification", "edit_file"));

    const ev = sink.events[0];
    if (ev?.type === "agent:iteration") {
      expect(ev.toolName).toBe("edit_file");
    }
  });

  it("maps iterationNumber from iteration:complete.iteration", () => {
    bus.emit(makeIterationCompleteEvent(7));

    const ev = sink.events[0];
    if (ev?.type === "agent:iteration") {
      expect(ev.iterationNumber).toBe(7);
    }
  });

  it("includes durationMs and timestamp in agent:iteration event", () => {
    bus.emit(makeIterationCompleteEvent());

    const ev = sink.events[0];
    if (ev?.type === "agent:iteration") {
      expect(typeof ev.durationMs).toBe("number");
      expect(typeof ev.timestamp).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// emit() — phase tracking via workflowEventBus
// ---------------------------------------------------------------------------

describe("DebugAgentEventBus phase tracking", () => {
  it("reports UNKNOWN phase before any phase:start event", () => {
    const { sink, bus } = makeBus();
    bus.emit(makeIterationCompleteEvent());

    const ev = sink.events[0];
    if (ev?.type === "agent:iteration") {
      expect(ev.phase).toBe("UNKNOWN");
    }
  });

  it("reports correct phase after phase:start event", () => {
    const { sink, workflowEventBus, bus } = makeBus();
    workflowEventBus.emit({ type: "phase:start", phase: "IMPLEMENTATION", timestamp: "t" });
    bus.emit(makeIterationCompleteEvent());

    const ev = sink.events[0];
    if (ev?.type === "agent:iteration") {
      expect(ev.phase).toBe("IMPLEMENTATION");
    }
  });

  it("updates phase on each subsequent phase:start event", () => {
    const { sink, workflowEventBus, bus } = makeBus();

    workflowEventBus.emit({ type: "phase:start", phase: "REQUIREMENTS", timestamp: "t1" });
    bus.emit(makeIterationCompleteEvent(1));

    workflowEventBus.emit({ type: "phase:start", phase: "IMPLEMENTATION", timestamp: "t2" });
    bus.emit(makeIterationCompleteEvent(2));

    const phases = sink.events.map((e) => (e.type === "agent:iteration" ? e.phase : null));
    expect(phases).toEqual(["REQUIREMENTS", "IMPLEMENTATION"]);
  });
});

// ---------------------------------------------------------------------------
// emit() — non-iteration:complete events are NOT forwarded to sink
// ---------------------------------------------------------------------------

describe("DebugAgentEventBus.emit() — other event types", () => {
  let sink: ReturnType<typeof makeSink>;
  let bus: DebugAgentEventBus;

  beforeEach(() => {
    ({ sink, bus } = makeBus());
  });

  it("does NOT emit to sink for iteration:start events", () => {
    bus.emit(makeIterationStartEvent());
    expect(sink.events).toHaveLength(0);
  });

  it("does NOT emit to sink for step:start events", () => {
    bus.emit({ type: "step:start", step: "PLAN", iteration: 1, timestamp: "t" });
    expect(sink.events).toHaveLength(0);
  });

  it("does NOT emit to sink for step:complete events", () => {
    bus.emit({ type: "step:complete", step: "ACT", iteration: 1, durationMs: 10 });
    expect(sink.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// on() / off() — subscription management
// ---------------------------------------------------------------------------

describe("DebugAgentEventBus.on() and off()", () => {
  let bus: DebugAgentEventBus;

  beforeEach(() => {
    ({ bus } = makeBus());
  });

  it("on() handlers receive all emitted events (including iteration:complete)", () => {
    const received: AgentLoopEvent[] = [];
    bus.on((e) => received.push(e));
    bus.emit(makeIterationCompleteEvent());
    bus.emit(makeIterationStartEvent());

    expect(received).toHaveLength(2);
  });

  it("off() correctly unregisters a handler", () => {
    const received: AgentLoopEvent[] = [];
    const handler = (e: AgentLoopEvent) => received.push(e);
    bus.on(handler);
    bus.emit(makeIterationStartEvent(1));
    bus.off(handler);
    bus.emit(makeIterationStartEvent(2));

    expect(received).toHaveLength(1);
  });

  it("multiple on() handlers all receive events", () => {
    const a: AgentLoopEvent[] = [];
    const b: AgentLoopEvent[] = [];
    bus.on((e) => a.push(e));
    bus.on((e) => b.push(e));
    bus.emit(makeIterationCompleteEvent());

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("off() for an unregistered handler does not throw", () => {
    expect(() => bus.off(() => {})).not.toThrow();
  });
});
