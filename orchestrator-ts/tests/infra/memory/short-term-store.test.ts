import { beforeEach, describe, expect, it } from "bun:test";
import type { ShortTermState } from "../../../src/application/ports/memory";
import { InProcessShortTermStore } from "../../../src/infra/memory/short-term-store";

// ---------------------------------------------------------------------------
// Task 5.1: Unit tests for the in-process short-term store
// ---------------------------------------------------------------------------

describe("InProcessShortTermStore", () => {
  let store: InProcessShortTermStore;

  beforeEach(() => {
    store = new InProcessShortTermStore();
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  it("read() immediately after construction returns the empty initial state", () => {
    const state = store.read();

    expect(state.recentFiles).toEqual([]);
    expect(state.currentSpec).toBeUndefined();
    expect(state.currentPhase).toBeUndefined();
    expect(state.taskProgress).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Partial-merge write semantics
  // -------------------------------------------------------------------------

  it("write() with a partial object merges only the provided keys", () => {
    store.write({ currentSpec: "memory-system" });
    const state = store.read();

    expect(state.currentSpec).toBe("memory-system");
    expect(state.recentFiles).toEqual([]); // unchanged
    expect(state.currentPhase).toBeUndefined(); // unchanged
    expect(state.taskProgress).toBeUndefined(); // unchanged
  });

  it("write() leaves unmentioned fields at their previous values", () => {
    store.write({ currentSpec: "spec-a", recentFiles: ["file.ts"] });
    store.write({ currentPhase: "DESIGN" });
    const state = store.read();

    expect(state.currentSpec).toBe("spec-a"); // preserved from first write
    expect(state.recentFiles).toEqual(["file.ts"]); // preserved from first write
    expect(state.currentPhase).toBe("DESIGN"); // from second write
  });

  it("write() with empty object leaves state unchanged", () => {
    store.write({ currentSpec: "spec-b" });
    store.write({});
    const state = store.read();

    expect(state.currentSpec).toBe("spec-b");
    expect(state.recentFiles).toEqual([]);
  });

  it("successive write() calls accumulate state correctly", () => {
    store.write({ currentSpec: "spec-c" });
    store.write({ currentPhase: "IMPLEMENTATION" });
    store.write({ recentFiles: ["a.ts", "b.ts"] });
    store.write({
      taskProgress: {
        taskId: "task-1",
        completedSteps: ["step-a"],
        currentStep: "step-b",
      },
    });
    const state = store.read();

    expect(state.currentSpec).toBe("spec-c");
    expect(state.currentPhase).toBe("IMPLEMENTATION");
    expect(state.recentFiles).toEqual(["a.ts", "b.ts"]);
    expect(state.taskProgress?.taskId).toBe("task-1");
    expect(state.taskProgress?.currentStep).toBe("step-b");
  });

  // -------------------------------------------------------------------------
  // clear() semantics
  // -------------------------------------------------------------------------

  it("clear() resets all fields to the empty initial state", () => {
    store.write({
      currentSpec: "spec-x",
      currentPhase: "IMPLEMENTATION",
      recentFiles: ["a.ts", "b.ts"],
      taskProgress: { taskId: "task-2", completedSteps: ["s1"] },
    });
    store.clear();
    const state = store.read();

    expect(state.recentFiles).toEqual([]);
    expect(state.currentSpec).toBeUndefined();
    expect(state.currentPhase).toBeUndefined();
    expect(state.taskProgress).toBeUndefined();
  });

  it("write() after clear() works normally", () => {
    store.write({ currentSpec: "spec-y" });
    store.clear();
    store.write({ currentPhase: "DESIGN" });
    const state = store.read();

    expect(state.currentSpec).toBeUndefined(); // cleared, not restored
    expect(state.currentPhase).toBe("DESIGN");
  });

  // -------------------------------------------------------------------------
  // Synchronous API
  // -------------------------------------------------------------------------

  it("read() returns synchronously (not a Promise)", () => {
    const result = store.read();
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("write() and clear() are synchronous (return void, i.e. undefined)", () => {
    const writeResult = store.write({ currentSpec: "test" });
    const clearResult = store.clear();

    expect(writeResult).toBeUndefined();
    expect(clearResult).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Instance isolation
  // -------------------------------------------------------------------------

  it("two separate instances do not share state", () => {
    const storeA = new InProcessShortTermStore();
    const storeB = new InProcessShortTermStore();

    storeA.write({ currentSpec: "spec-a" });

    const stateA = storeA.read();
    const stateB = storeB.read();

    expect(stateA.currentSpec).toBe("spec-a");
    expect(stateB.currentSpec).toBeUndefined(); // storeB is unaffected
  });

  it("writing to one instance does not affect another", () => {
    const storeA = new InProcessShortTermStore();
    const storeB = new InProcessShortTermStore();

    storeA.write({ recentFiles: ["foo.ts"] });
    storeB.write({ currentPhase: "REQUIREMENTS" });

    expect(storeA.read().currentPhase).toBeUndefined();
    expect(storeB.read().recentFiles).toEqual([]);
  });

  it("clearing one instance does not clear another", () => {
    const storeA = new InProcessShortTermStore();
    const storeB = new InProcessShortTermStore();

    storeA.write({ currentSpec: "spec-shared" });
    storeB.write({ currentSpec: "spec-b-only" });

    storeA.clear();

    expect(storeA.read().currentSpec).toBeUndefined();
    expect(storeB.read().currentSpec).toBe("spec-b-only"); // unaffected
  });

  // -------------------------------------------------------------------------
  // read() returns a snapshot (not a mutable reference)
  // -------------------------------------------------------------------------

  it("read() returns the current state snapshot", () => {
    const before: ShortTermState = store.read();
    store.write({ currentSpec: "after-write" });
    const after: ShortTermState = store.read();

    // The two snapshots are independent objects
    expect(before.currentSpec).toBeUndefined();
    expect(after.currentSpec).toBe("after-write");
  });
});
