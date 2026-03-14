/**
 * Unit tests for ImplementationLoopService — Task 4.1
 *
 * Tests cover section loading and dependency-ordered iteration:
 * - Returns "plan-not-found" when IPlanStore returns null
 * - Returns "completed" when all sections are already completed
 * - Iterates sections in plan order
 * - Writes "in_progress" to IPlanStore before beginning each section
 * - Skips sections already in "completed" status
 * - Emits plan:completed event after all sections reach terminal state
 * - Returns "stopped" when stop() is called before a section begins
 * - Defers a section if its preceding task is not yet completed (sequential dependency)
 *
 * Requirements: 1.1, 1.3, 1.4, 1.6
 */

import { ImplementationLoopService } from "@/application/implementation-loop/implementation-loop-service";
import type { AgentLoopResult, IAgentLoop } from "@/application/ports/agent-loop";
import type {
  IImplementationLoopEventBus,
  IPlanStore,
  IReviewEngine,
  QualityGateConfig,
  ReviewResult,
} from "@/application/ports/implementation-loop";
import type { ImplementationLoopEvent } from "@/domain/implementation-loop/types";
import type { IGitController } from "@/application/ports/git-controller";
import type { AgentState } from "@/domain/agent/types";
import type { Task, TaskPlan } from "@/domain/planning/types";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Implement section A",
    status: "pending",
    steps: [],
    ...overrides,
  };
}

function makeTaskPlan(tasks: ReadonlyArray<Task> = []): TaskPlan {
  return {
    id: "plan-123",
    goal: "Build the feature",
    tasks,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeAgentLoopResult(): AgentLoopResult {
  const state: AgentState = {
    task: "test task",
    plan: [],
    completedSteps: [],
    currentStep: null,
    iterationCount: 1,
    observations: [],
    recoveryAttempts: 0,
    startedAt: new Date().toISOString(),
  };
  return {
    terminationCondition: "TASK_COMPLETED",
    finalState: state,
    totalIterations: 1,
    taskCompleted: true,
  };
}

function makeReviewResult(outcome: "passed" | "failed" = "passed"): ReviewResult {
  return {
    outcome,
    checks: [],
    feedback: [],
    durationMs: 10,
  };
}

/** Creates a stub IPlanStore that returns the given plan. */
function makePlanStore(plan: TaskPlan | null): IPlanStore & {
  statusUpdates: Array<{ planId: string; sectionId: string; status: string }>;
} {
  const statusUpdates: Array<{ planId: string; sectionId: string; status: string }> = [];
  return {
    statusUpdates,
    async loadPlan(_planId: string) {
      return plan;
    },
    async updateSectionStatus(planId, sectionId, status) {
      statusUpdates.push({ planId, sectionId, status });
    },
  };
}

/** Creates a stub IAgentLoop that always returns a completed result. */
function makeAgentLoop(): IAgentLoop {
  return {
    async run(_task: string) {
      return makeAgentLoopResult();
    },
    stop() {},
    getState() {
      return null;
    },
  };
}

/** Creates a stub IReviewEngine that always returns passed. */
function makeReviewEngine(outcome: "passed" | "failed" = "passed"): IReviewEngine {
  return {
    async review(
      _result: AgentLoopResult,
      _section: Task,
      _config: QualityGateConfig,
    ): Promise<ReviewResult> {
      return makeReviewResult(outcome);
    },
  };
}

/** Creates a stub IGitController that returns a successful commit. */
function makeGitController(): IGitController {
  return {
    async listBranches() {
      return { ok: true, value: [] };
    },
    async detectChanges() {
      return { ok: true, value: { staged: [], unstaged: [], untracked: [] } };
    },
    async createAndCheckoutBranch() {
      return { ok: true, value: { branchName: "feature/test", baseBranch: "main", conflictResolved: false } };
    },
    async stageAndCommit(_files, _message) {
      return { ok: true, value: { hash: "abc123", message: _message, fileCount: 1 } };
    },
    async push() {
      return { ok: true, value: { branchName: "feature/test", remote: "origin", commitHash: "abc123" } };
    },
  };
}

/** Creates a stub IImplementationLoopEventBus that records emitted events. */
function makeEventBus(): IImplementationLoopEventBus & { events: ImplementationLoopEvent[] } {
  const events: ImplementationLoopEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
}

/** Creates a service with default stubs for all dependencies. */
function makeService(
  planStore: IPlanStore,
  options: {
    agentLoop?: IAgentLoop;
    reviewEngine?: IReviewEngine;
    gitController?: IGitController;
  } = {},
): ImplementationLoopService {
  return new ImplementationLoopService(
    planStore,
    options.agentLoop ?? makeAgentLoop(),
    options.reviewEngine ?? makeReviewEngine(),
    options.gitController ?? makeGitController(),
  );
}

// ---------------------------------------------------------------------------
// Plan not found
// ---------------------------------------------------------------------------

describe("ImplementationLoopService — plan not found", () => {
  it("returns outcome: plan-not-found when IPlanStore returns null", async () => {
    const store = makePlanStore(null);
    const service = makeService(store);

    const result = await service.run("nonexistent-plan");

    expect(result.outcome).toBe("plan-not-found");
  });

  it("includes the planId in the result even when plan is not found", async () => {
    const store = makePlanStore(null);
    const service = makeService(store);

    const result = await service.run("missing-plan");

    expect(result.planId).toBe("missing-plan");
  });

  it("returns empty sections array when plan is not found", async () => {
    const store = makePlanStore(null);
    const service = makeService(store);

    const result = await service.run("missing-plan");

    expect(result.sections).toHaveLength(0);
  });

  it("returns non-negative durationMs when plan is not found", async () => {
    const store = makePlanStore(null);
    const service = makeService(store);

    const result = await service.run("missing-plan");

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Empty plan / all sections completed
// ---------------------------------------------------------------------------

describe("ImplementationLoopService — empty or fully-completed plan", () => {
  it("returns outcome: completed for a plan with no tasks", async () => {
    const plan = makeTaskPlan([]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    const result = await service.run(plan.id);

    expect(result.outcome).toBe("completed");
  });

  it("returns outcome: completed when all tasks are already completed", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "completed" }),
      makeTask({ id: "t2", status: "completed" }),
    ]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    const result = await service.run(plan.id);

    expect(result.outcome).toBe("completed");
  });

  it("does not call updateSectionStatus for already-completed tasks", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "completed" })]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    await service.run(plan.id);

    expect(store.statusUpdates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Section iteration and status writes
// ---------------------------------------------------------------------------

describe("ImplementationLoopService — section iteration", () => {
  it("writes in_progress before executing each pending section", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", title: "Section 1", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    await service.run(plan.id);

    const inProgressUpdate = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "in_progress",
    );
    expect(inProgressUpdate).toBeDefined();
  });

  it("writes in_progress before completed for the same section", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    await service.run(plan.id);

    const updates = store.statusUpdates.filter((u) => u.sectionId === "t1");
    const inProgressIdx = updates.findIndex((u) => u.status === "in_progress");
    const completedIdx = updates.findIndex((u) => u.status === "completed");
    expect(inProgressIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(inProgressIdx);
  });

  it("iterates all pending sections in plan order", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", title: "Section 1", status: "pending" }),
      makeTask({ id: "t2", title: "Section 2", status: "pending" }),
      makeTask({ id: "t3", title: "Section 3", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    await service.run(plan.id);

    const inProgressUpdates = store.statusUpdates
      .filter((u) => u.status === "in_progress")
      .map((u) => u.sectionId);
    expect(inProgressUpdates).toEqual(["t1", "t2", "t3"]);
  });

  it("skips sections that are already completed when iterating", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "completed" }),
      makeTask({ id: "t2", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    await service.run(plan.id);

    const allUpdates = store.statusUpdates.map((u) => u.sectionId);
    expect(allUpdates).not.toContain("t1");
    expect(allUpdates).toContain("t2");
  });

  it("returns outcome: completed after all pending sections execute", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "pending" }),
      makeTask({ id: "t2", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    const result = await service.run(plan.id);

    expect(result.outcome).toBe("completed");
  });

  it("includes planId in the result", async () => {
    const plan = makeTaskPlan([]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    const result = await service.run(plan.id);

    expect(result.planId).toBe(plan.id);
  });
});

// ---------------------------------------------------------------------------
// Sequential dependency ordering
// ---------------------------------------------------------------------------

describe("ImplementationLoopService — sequential dependency ordering", () => {
  it("executes sections in plan order (t1 before t2 before t3)", async () => {
    const executionOrder: string[] = [];
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "pending" }),
      makeTask({ id: "t2", status: "pending" }),
      makeTask({ id: "t3", status: "pending" }),
    ]);

    const trackingStore = makePlanStore(plan);
    const originalUpdate = trackingStore.updateSectionStatus.bind(trackingStore);
    const recordingStore: IPlanStore = {
      async loadPlan(planId) {
        return trackingStore.loadPlan(planId);
      },
      async updateSectionStatus(planId, sectionId, status) {
        if (status === "in_progress") {
          executionOrder.push(sectionId);
        }
        return originalUpdate(planId, sectionId, status);
      },
    };

    const service = makeService(recordingStore);
    await service.run(plan.id);

    expect(executionOrder).toEqual(["t1", "t2", "t3"]);
  });

  it("does not start t2 before t1 completes", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "pending" }),
      makeTask({ id: "t2", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    await service.run(plan.id);

    const updates = store.statusUpdates;
    const t1CompletedIdx = updates.findIndex((u) => u.sectionId === "t1" && u.status === "completed");
    const t2InProgressIdx = updates.findIndex((u) => u.sectionId === "t2" && u.status === "in_progress");
    expect(t1CompletedIdx).toBeGreaterThanOrEqual(0);
    expect(t2InProgressIdx).toBeGreaterThan(t1CompletedIdx);
  });
});

// ---------------------------------------------------------------------------
// Stop signal
// ---------------------------------------------------------------------------

describe("ImplementationLoopService — stop signal", () => {
  it("returns outcome: stopped when stop() is called before run()", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    service.stop();
    const result = await service.run(plan.id);

    expect(result.outcome).toBe("stopped");
  });

  it("does not execute any sections after stop() is called", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    service.stop();
    await service.run(plan.id);

    expect(store.statusUpdates).toHaveLength(0);
  });

  it("returns a non-negative durationMs when stopped", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    service.stop();
    const result = await service.run(plan.id);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("allows a new run after stop signal was consumed", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    service.stop();
    await service.run(plan.id); // stopped run

    // Second run should not be stopped
    const result = await service.run(plan.id);
    expect(result.outcome).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// plan:completed event
// ---------------------------------------------------------------------------

describe("ImplementationLoopService — plan:completed event", () => {
  it("emits plan:completed event when all sections reach terminal state", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store);

    await service.run(plan.id, { eventBus });

    const planCompletedEvent = eventBus.events.find((e) => e.type === "plan:completed");
    expect(planCompletedEvent).toBeDefined();
  });

  it("emits plan:completed event with the correct planId", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store);

    await service.run(plan.id, { eventBus });

    const planCompletedEvent = eventBus.events.find((e) => e.type === "plan:completed");
    expect(planCompletedEvent?.type === "plan:completed" && planCompletedEvent.planId).toBe(plan.id);
  });

  it("does not emit plan:completed when loop is stopped", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store);

    service.stop();
    await service.run(plan.id, { eventBus });

    const planCompletedEvent = eventBus.events.find((e) => e.type === "plan:completed");
    expect(planCompletedEvent).toBeUndefined();
  });

  it("emits section:start event before executing each section", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "pending" }),
      makeTask({ id: "t2", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store);

    await service.run(plan.id, { eventBus });

    const startEvents = eventBus.events.filter((e) => e.type === "section:start");
    expect(startEvents).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// resume() — resets in_progress sections
// ---------------------------------------------------------------------------

describe("ImplementationLoopService — resume()", () => {
  it("resets in_progress sections to pending before execution on resume", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "in_progress" }),
    ]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    await service.resume(plan.id);

    const pendingReset = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "pending",
    );
    expect(pendingReset).toBeDefined();
  });

  it("does not reset completed sections on resume", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "completed" }),
      makeTask({ id: "t2", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const service = makeService(store);

    await service.resume(plan.id);

    const t1PendingReset = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "pending",
    );
    expect(t1PendingReset).toBeUndefined();
  });

  it("returns outcome: plan-not-found on resume when plan does not exist", async () => {
    const store = makePlanStore(null);
    const service = makeService(store);

    const result = await service.resume("nonexistent");

    expect(result.outcome).toBe("plan-not-found");
  });
});
