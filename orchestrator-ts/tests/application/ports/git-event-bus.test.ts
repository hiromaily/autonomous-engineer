import { describe, expect, it } from "bun:test";
import type { IGitEventBus } from "../../../application/ports/git-event-bus";
import type { GitEvent } from "../../../domain/git/types";

// ---------------------------------------------------------------------------
// Helper: build a minimal stub that satisfies IGitEventBus
// ---------------------------------------------------------------------------

function makeEventBus(): IGitEventBus & { getEmitted: () => GitEvent[] } {
  const handlers: Array<(event: GitEvent) => void> = [];
  const emitted: GitEvent[] = [];

  return {
    emit(event: GitEvent): void {
      emitted.push(event);
      for (const handler of handlers) {
        handler(event);
      }
    },
    on(handler: (event: GitEvent) => void): void {
      handlers.push(handler);
    },
    off(handler: (event: GitEvent) => void): void {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
    },
    getEmitted(): GitEvent[] {
      return emitted;
    },
  };
}

// ---------------------------------------------------------------------------
// IGitEventBus contract
// ---------------------------------------------------------------------------

describe("IGitEventBus contract (stub implementation)", () => {
  it("on() registers a handler that receives emitted events", () => {
    const bus = makeEventBus();
    const received: GitEvent[] = [];
    const handler = (event: GitEvent) => received.push(event);

    bus.on(handler);
    bus.emit({ type: "no-changes-to-commit", timestamp: "2026-03-14T00:00:00Z" });

    expect(received).toHaveLength(1);
    const first = received[0];
    expect(first?.type).toBe("no-changes-to-commit");
  });

  it("off() unregisters handler so it no longer receives events", () => {
    const bus = makeEventBus();
    const received: GitEvent[] = [];
    const handler = (event: GitEvent) => received.push(event);

    bus.on(handler);
    bus.emit({ type: "no-changes-to-commit", timestamp: "2026-03-14T00:00:00Z" });
    bus.off(handler);
    bus.emit({ type: "no-changes-to-commit", timestamp: "2026-03-14T00:00:01Z" });

    expect(received).toHaveLength(1);
  });

  it("emit() delivers event to multiple handlers in registration order", () => {
    const bus = makeEventBus();
    const order: number[] = [];

    bus.on(() => order.push(1));
    bus.on(() => order.push(2));
    bus.on(() => order.push(3));

    bus.emit({ type: "no-changes-to-commit", timestamp: "2026-03-14T00:00:00Z" });

    expect(order).toEqual([1, 2, 3]);
  });

  it("emit() delivers branch-created event with all fields", () => {
    const bus = makeEventBus();
    const received: GitEvent[] = [];
    bus.on(e => received.push(e));

    const event: GitEvent = {
      type: "branch-created",
      branchName: "agent/my-feature",
      baseBranch: "main",
      timestamp: "2026-03-14T00:00:00Z",
    };
    bus.emit(event);

    expect(received).toHaveLength(1);
    const e = received[0]!;
    if (e.type === "branch-created") {
      expect(e.branchName).toBe("agent/my-feature");
      expect(e.baseBranch).toBe("main");
    } else {
      throw new Error("Expected branch-created");
    }
  });

  it("emit() delivers commit-created event with all fields", () => {
    const bus = makeEventBus();
    const received: GitEvent[] = [];
    bus.on(e => received.push(e));

    const event: GitEvent = {
      type: "commit-created",
      hash: "abc123",
      message: "feat: implement git integration",
      fileCount: 5,
      timestamp: "2026-03-14T00:00:00Z",
    };
    bus.emit(event);

    const e = received[0]!;
    if (e.type === "commit-created") {
      expect(e.hash).toBe("abc123");
      expect(e.fileCount).toBe(5);
    } else {
      throw new Error("Expected commit-created");
    }
  });

  it("emit() delivers repeated-git-failure event", () => {
    const bus = makeEventBus();
    const received: GitEvent[] = [];
    bus.on(e => received.push(e));

    bus.emit({
      type: "repeated-git-failure",
      operation: "commit",
      attemptCount: 3,
      timestamp: "2026-03-14T00:00:00Z",
    });

    const e = received[0]!;
    if (e.type === "repeated-git-failure") {
      expect(e.operation).toBe("commit");
      expect(e.attemptCount).toBe(3);
    } else {
      throw new Error("Expected repeated-git-failure");
    }
  });

  it("emit() with no handlers does not throw", () => {
    const bus = makeEventBus();
    expect(() => {
      bus.emit({ type: "no-changes-to-commit", timestamp: "2026-03-14T00:00:00Z" });
    }).not.toThrow();
  });

  it("off() with unregistered handler does not throw", () => {
    const bus = makeEventBus();
    const handler = (_event: GitEvent) => {};
    expect(() => bus.off(handler)).not.toThrow();
  });
});
