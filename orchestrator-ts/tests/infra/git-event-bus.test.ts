import { describe, expect, it } from "bun:test";
import type { GitEvent } from "../../domain/git/types";
import { GitEventBus } from "../../infra/events/git-event-bus";

const makeEvent = (type: GitEvent["type"]): GitEvent => {
  if (type === "branch-created") {
    return { type, branchName: "agent/test", baseBranch: "main", timestamp: "2026-01-01T00:00:00Z" };
  }
  if (type === "commit-created") {
    return { type, hash: "abc123", message: "feat: test", fileCount: 1, timestamp: "2026-01-01T00:00:00Z" };
  }
  if (type === "branch-pushed") {
    return { type, branchName: "agent/test", remote: "origin", commitHash: "abc123", timestamp: "2026-01-01T00:00:00Z" };
  }
  if (type === "pull-request-created") {
    return { type, url: "https://github.com/owner/repo/pull/1", title: "Test PR", targetBranch: "main", timestamp: "2026-01-01T00:00:00Z" };
  }
  if (type === "commit-size-limit-exceeded") {
    return { type, fileCount: 51, limit: 50, timestamp: "2026-01-01T00:00:00Z" };
  }
  if (type === "no-changes-to-commit") {
    return { type, timestamp: "2026-01-01T00:00:00Z" };
  }
  if (type === "protected-file-detected") {
    return { type, files: [".env"], timestamp: "2026-01-01T00:00:00Z" };
  }
  if (type === "protected-branch-push-rejected") {
    return { type, branchName: "main", timestamp: "2026-01-01T00:00:00Z" };
  }
  if (type === "push-rejected-non-fast-forward") {
    return { type, branchName: "agent/test", remote: "origin", timestamp: "2026-01-01T00:00:00Z" };
  }
  if (type === "pr-creation-auth-failed") {
    return { type, message: "Auth failed", timestamp: "2026-01-01T00:00:00Z" };
  }
  if (type === "repeated-git-failure") {
    return { type, operation: "commit", attemptCount: 3, timestamp: "2026-01-01T00:00:00Z" };
  }
  const _exhaustive: never = type;
  throw new Error(`Unhandled event type: ${_exhaustive}`);
};

describe("GitEventBus", () => {
  describe("emit() and on()", () => {
    it("delivers event synchronously to a registered handler", () => {
      const bus = new GitEventBus();
      const received: GitEvent[] = [];

      bus.on(e => received.push(e));
      bus.emit(makeEvent("branch-created"));

      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe("branch-created");
    });

    it("delivers events to multiple handlers in registration order", () => {
      const bus = new GitEventBus();
      const order: number[] = [];

      bus.on(() => order.push(1));
      bus.on(() => order.push(2));
      bus.on(() => order.push(3));

      bus.emit(makeEvent("no-changes-to-commit"));

      expect(order).toEqual([1, 2, 3]);
    });

    it("delivers all 11 event types correctly", () => {
      const bus = new GitEventBus();
      const received: GitEvent[] = [];
      bus.on(e => received.push(e));

      const types: GitEvent["type"][] = [
        "branch-created",
        "commit-created",
        "branch-pushed",
        "pull-request-created",
        "commit-size-limit-exceeded",
        "no-changes-to-commit",
        "protected-file-detected",
        "protected-branch-push-rejected",
        "push-rejected-non-fast-forward",
        "pr-creation-auth-failed",
        "repeated-git-failure",
      ];

      for (const type of types) {
        bus.emit(makeEvent(type));
      }

      expect(received).toHaveLength(11);
      expect(received.map(e => e.type)).toEqual(types);
    });

    it("is synchronous: handler runs before emit() returns", () => {
      const bus = new GitEventBus();
      let called = false;

      bus.on(() => {
        called = true;
      });
      expect(called).toBe(false);

      bus.emit(makeEvent("no-changes-to-commit"));
      expect(called).toBe(true);
    });

    it("no-ops when no handlers are registered", () => {
      const bus = new GitEventBus();
      expect(() => bus.emit(makeEvent("no-changes-to-commit"))).not.toThrow();
    });
  });

  describe("off()", () => {
    it("removes a handler so it no longer receives events", () => {
      const bus = new GitEventBus();
      const received: GitEvent[] = [];
      const handler = (e: GitEvent) => received.push(e);

      bus.on(handler);
      bus.emit(makeEvent("no-changes-to-commit"));
      expect(received).toHaveLength(1);

      bus.off(handler);
      bus.emit(makeEvent("no-changes-to-commit"));
      expect(received).toHaveLength(1); // still 1 — handler removed
    });

    it("does not affect other handlers when one is removed", () => {
      const bus = new GitEventBus();
      const receivedA: GitEvent[] = [];
      const receivedB: GitEvent[] = [];

      const handlerA = (e: GitEvent) => receivedA.push(e);
      const handlerB = (e: GitEvent) => receivedB.push(e);

      bus.on(handlerA);
      bus.on(handlerB);
      bus.off(handlerA);

      bus.emit(makeEvent("no-changes-to-commit"));

      expect(receivedA).toHaveLength(0);
      expect(receivedB).toHaveLength(1);
    });

    it("is idempotent when called with an unregistered handler", () => {
      const bus = new GitEventBus();
      const handler = (_e: GitEvent) => {};

      expect(() => bus.off(handler)).not.toThrow();
    });
  });

  describe("no buffering", () => {
    it("does not replay past events to newly added handlers", () => {
      const bus = new GitEventBus();
      const received: GitEvent[] = [];

      bus.emit(makeEvent("no-changes-to-commit"));
      bus.on(e => received.push(e));

      expect(received).toHaveLength(0);
    });
  });
});
