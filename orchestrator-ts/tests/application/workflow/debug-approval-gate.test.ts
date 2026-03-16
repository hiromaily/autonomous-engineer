import type { IDebugEventSink } from "@/application/ports/debug";
import { DebugApprovalGate } from "@/application/workflow/debug-approval-gate";
import type { DebugEvent } from "@/domain/debug/types";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ---------------------------------------------------------------------------
// human_interaction: delegates to real ApprovalGate (reads spec.json)
// ---------------------------------------------------------------------------

describe("DebugApprovalGate — human_interaction delegates to real gate", () => {
  let tmpDir: string;
  let sink: ReturnType<typeof makeSink>;
  let gate: DebugApprovalGate;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "debug-gate-test-"));
    sink = makeSink();
    gate = new DebugApprovalGate(sink);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns { approved: false } when spec.json is missing", async () => {
    const result = await gate.check(tmpDir, "human_interaction");
    expect(result.approved).toBe(false);
  });

  it("returns { approved: false } when human_interaction approval is not set", async () => {
    await writeFile(join(tmpDir, "spec.json"), JSON.stringify({ approvals: {} }));
    const result = await gate.check(tmpDir, "human_interaction");
    expect(result.approved).toBe(false);
  });

  it("returns { approved: true } when human_interaction approval is set to true in spec.json", async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, "spec.json"),
      JSON.stringify({ approvals: { human_interaction: { approved: true } } }),
    );
    const result = await gate.check(tmpDir, "human_interaction");
    expect(result.approved).toBe(true);
  });

  it("does NOT emit an approval:auto event for human_interaction", async () => {
    await gate.check(tmpDir, "human_interaction");
    expect(sink.events).toHaveLength(0);
  });

  it("auto-approves other phases independently of human_interaction delegation", async () => {
    // human_interaction — real gate (no spec.json → not approved)
    const hiResult = await gate.check(tmpDir, "human_interaction");
    expect(hiResult.approved).toBe(false);

    // requirements — auto-approved
    const reqResult = await gate.check(tmpDir, "requirements");
    expect(reqResult.approved).toBe(true);

    // Only requirements emits an approval:auto event
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.type).toBe("approval:auto");
  });
});
