import type { IDebugEventSink } from "@/application/ports/debug";
import { DebugApprovalGate } from "@/application/workflow/debug-approval-gate";
import type { DebugEvent } from "@/domain/debug/types";
import { beforeEach, describe, expect, it } from "bun:test";

function makeSink(): IDebugEventSink & { events: DebugEvent[] } {
  const events: DebugEvent[] = [];
  return {
    events,
    emit(e) {
      events.push(e);
    },
    async close() {},
  };
}

describe("DebugApprovalGate.check()", () => {
  let sink: ReturnType<typeof makeSink>;
  let gate: DebugApprovalGate;

  beforeEach(() => {
    sink = makeSink();
    gate = new DebugApprovalGate(sink);
  });

  it("pauses at human_interaction — returns not-approved", async () => {
    const result = await gate.check("/any", "human_interaction");
    expect(result.approved).toBe(false);
  });

  it("does not emit approval:auto when pausing at human_interaction", async () => {
    await gate.check("/any", "human_interaction");
    expect(sink.events).toHaveLength(0);
  });

  it("auto-approves requirements", async () => {
    expect(await gate.check("/any", "requirements")).toEqual({ approved: true });
  });

  it("auto-approves design", async () => {
    expect(await gate.check("/any", "design")).toEqual({ approved: true });
  });

  it("auto-approves tasks", async () => {
    expect(await gate.check("/any", "tasks")).toEqual({ approved: true });
  });

  it("emits approval:auto event for each auto-approved phase", async () => {
    await gate.check("/any", "requirements");
    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0];
    if (ev?.type === "approval:auto") {
      expect(ev.approvalType).toBe("requirements");
      expect(ev.outcome).toBe("approved");
    }
  });
});

describe("DebugApprovalGate.checkResume() — inherited from ApprovalGate", () => {
  it("auto-approves human_interaction on resume (re-run is sufficient to continue)", async () => {
    const gate = new DebugApprovalGate(makeSink());
    const result = await gate.checkResume("/any", "human_interaction");
    expect(result).toEqual({ approved: true });
  });
});
