import type { IDebugEventSink } from "@/application/ports/debug";
import { DebugApprovalGate } from "@/application/workflow/debug-approval-gate";
import type { DebugEvent } from "@/domain/debug/types";
import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Test double
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DebugApprovalGate", () => {
  let sink: ReturnType<typeof makeSink>;
  let gate: DebugApprovalGate;

  beforeEach(() => {
    sink = makeSink();
    gate = new DebugApprovalGate(sink);
  });

  it("returns { approved: true } for requirements phase", async () => {
    const result = await gate.check("/any/spec/dir", "requirements");
    expect(result).toEqual({ approved: true });
  });

  it("returns { approved: true } for design phase", async () => {
    const result = await gate.check("/any/spec/dir", "design");
    expect(result).toEqual({ approved: true });
  });

  it("returns { approved: true } for tasks phase", async () => {
    const result = await gate.check("/any/spec/dir", "tasks");
    expect(result).toEqual({ approved: true });
  });

  it("emits exactly one approval:auto event per check() call", async () => {
    await gate.check("/spec", "requirements");
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.type).toBe("approval:auto");
  });

  it("emits event with correct approvalType for requirements", async () => {
    await gate.check("/spec", "requirements");
    const ev = sink.events[0];
    expect(ev?.type).toBe("approval:auto");
    if (ev?.type === "approval:auto") {
      expect(ev.approvalType).toBe("requirements");
      expect(ev.outcome).toBe("approved");
    }
  });

  it("emits event with correct approvalType for design", async () => {
    await gate.check("/spec", "design");
    const ev = sink.events[0];
    if (ev?.type === "approval:auto") {
      expect(ev.approvalType).toBe("design");
    }
  });

  it("emits event with correct approvalType for tasks", async () => {
    await gate.check("/spec", "tasks");
    const ev = sink.events[0];
    if (ev?.type === "approval:auto") {
      expect(ev.approvalType).toBe("tasks");
    }
  });

  it("emits events in call order for multiple check() calls", async () => {
    await gate.check("/spec", "requirements");
    await gate.check("/spec", "design");
    await gate.check("/spec", "tasks");

    expect(sink.events).toHaveLength(3);
    const types = sink.events.map((e) => e.type === "approval:auto" ? e.approvalType : null);
    expect(types).toEqual(["requirements", "design", "tasks"]);
  });

  it("emits approval:auto with a timestamp string", async () => {
    await gate.check("/spec", "requirements");
    const ev = sink.events[0];
    if (ev?.type === "approval:auto") {
      expect(typeof ev.timestamp).toBe("string");
      expect(ev.timestamp.length).toBeGreaterThan(0);
    }
  });
});
