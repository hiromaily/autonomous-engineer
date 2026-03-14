import type { WorkflowEvent } from "@/application/ports/workflow";
import { WorkflowEventBus } from "@/infra/events/workflow-event-bus";
import { describe, expect, it } from "bun:test";

describe("WorkflowEventBus", () => {
  describe("emit() and on()", () => {
    it("delivers event synchronously to a registered handler", () => {
      const bus = new WorkflowEventBus();
      const received: WorkflowEvent[] = [];

      bus.on(e => received.push(e));
      bus.emit({ type: "phase:start", phase: "SPEC_INIT", timestamp: "2026-01-01T00:00:00Z" });

      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe("phase:start");
    });

    it("delivers events to multiple handlers in subscription order", () => {
      const bus = new WorkflowEventBus();
      const order: number[] = [];

      bus.on(() => order.push(1));
      bus.on(() => order.push(2));
      bus.on(() => order.push(3));

      bus.emit({ type: "workflow:complete", completedPhases: [] });

      expect(order).toEqual([1, 2, 3]);
    });

    it("delivers all 6 event types correctly", () => {
      const bus = new WorkflowEventBus();
      const received: WorkflowEvent[] = [];
      bus.on(e => received.push(e));

      const events: WorkflowEvent[] = [
        { type: "phase:start", phase: "SPEC_INIT", timestamp: "2026-01-01T00:00:00Z" },
        { type: "phase:complete", phase: "SPEC_INIT", durationMs: 100, artifacts: [] },
        { type: "phase:error", phase: "DESIGN", operation: "generateDesign", error: "timeout" },
        { type: "approval:required", phase: "REQUIREMENTS", artifactPath: "req.md", instruction: "Approve it" },
        { type: "workflow:complete", completedPhases: ["SPEC_INIT"] },
        { type: "workflow:failed", phase: "DESIGN", error: "LLM error" },
      ];

      for (const event of events) {
        bus.emit(event);
      }

      expect(received).toHaveLength(6);
      expect(received.map(e => e.type)).toEqual([
        "phase:start",
        "phase:complete",
        "phase:error",
        "approval:required",
        "workflow:complete",
        "workflow:failed",
      ]);
    });

    it("is synchronous: handler runs before emit() returns", () => {
      const bus = new WorkflowEventBus();
      let called = false;

      bus.on(() => {
        called = true;
      });
      expect(called).toBe(false);

      bus.emit({ type: "workflow:complete", completedPhases: [] });
      expect(called).toBe(true);
    });

    it("no-ops when no handlers are registered", () => {
      const bus = new WorkflowEventBus();
      expect(() => bus.emit({ type: "phase:start", phase: "SPEC_INIT", timestamp: "2026-01-01T00:00:00Z" })).not
        .toThrow();
    });
  });

  describe("off()", () => {
    it("removes a handler so it no longer receives events", () => {
      const bus = new WorkflowEventBus();
      const received: WorkflowEvent[] = [];
      const handler = (e: WorkflowEvent) => received.push(e);

      bus.on(handler);
      bus.emit({ type: "workflow:complete", completedPhases: [] });
      expect(received).toHaveLength(1);

      bus.off(handler);
      bus.emit({ type: "workflow:complete", completedPhases: [] });
      expect(received).toHaveLength(1); // still 1 — handler removed
    });

    it("does not affect other handlers when one is removed", () => {
      const bus = new WorkflowEventBus();
      const receivedA: WorkflowEvent[] = [];
      const receivedB: WorkflowEvent[] = [];

      const handlerA = (e: WorkflowEvent) => receivedA.push(e);
      const handlerB = (e: WorkflowEvent) => receivedB.push(e);

      bus.on(handlerA);
      bus.on(handlerB);
      bus.off(handlerA);

      bus.emit({ type: "workflow:complete", completedPhases: [] });

      expect(receivedA).toHaveLength(0);
      expect(receivedB).toHaveLength(1);
    });

    it("is idempotent when called with an unregistered handler", () => {
      const bus = new WorkflowEventBus();
      const handler = (_e: WorkflowEvent) => {};

      expect(() => bus.off(handler)).not.toThrow();
    });
  });

  describe("no buffering", () => {
    it("does not replay past events to newly added handlers", () => {
      const bus = new WorkflowEventBus();
      const received: WorkflowEvent[] = [];

      bus.emit({ type: "workflow:complete", completedPhases: [] });
      bus.on(e => received.push(e));

      expect(received).toHaveLength(0);
    });
  });
});
