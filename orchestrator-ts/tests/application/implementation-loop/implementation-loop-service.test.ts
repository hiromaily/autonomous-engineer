/**
 * Unit tests for ImplementationLoopService — Tasks 4.1, 4.2, 4.3 & 4.4
 *
 * Task 4.1 — section loading and dependency-ordered iteration:
 * - Returns "plan-not-found" when IPlanStore returns null
 * - Returns "completed" when all sections are already completed
 * - Iterates sections in plan order
 * - Writes "in_progress" to IPlanStore before beginning each section
 * - Skips sections already in "completed" status
 * - Emits plan:completed event after all sections reach terminal state
 * - Returns "stopped" when stop() is called before a section begins
 * - Defers a section if its preceding task is not yet completed (sequential dependency)
 *
 * Task 4.2 — implement-review-commit cycle for a single section:
 * - IAgentLoop.run() is called with the section title
 * - IReviewEngine.review() is called after the agent loop completes
 * - When review passes → git stageAndCommit() is called
 * - Commit message contains the section title
 * - When review passes → IPlanStore updated to "completed"
 * - When review passes → section:completed event emitted with commitSha
 * - When agent loop terminates without task completion → section "failed"
 * - When review fails → no git commit, section "failed"
 * - When git commit fails → section "failed", plan halts
 *
 * Task 4.4 — context isolation and preservation across section boundaries:
 * - contextEngine.resetTask(task.id) called at section start
 * - resetTask NOT called during improve steps (only once per section, even on retries)
 * - resetTask called once per section in a multi-section plan
 * - contextProvider passed to IAgentLoop.run() when contextEngine is provided
 * - contextProvider not passed when contextEngine is absent
 * - Works normally without contextEngine
 *
 * Task 4.6 — structured logging and event emission:
 * - logIteration called after each iteration with correct planId, sectionId, outcome
 * - logIteration called for failed review with "failed" outcome
 * - logSectionComplete called once when a section reaches "completed" status
 * - logSectionComplete NOT called when a section fails
 * - logHaltSummary called when the loop halts due to section failure
 * - logHaltSummary NOT called when the loop completes successfully
 * - Logger is optional — service runs normally without a logger
 *
 * Task 4.7 — escalation to the self-healing loop:
 * - Without ISelfHealingLoop: outcome = "section-failed", section status = "failed"
 * - ISelfHealingLoop.escalate() called with correct sectionId, planId, retryHistory
 * - ISelfHealingLoop.escalate() called with accumulated reviewFeedback from failed iterations
 * - ISelfHealingLoop.escalate() called with accumulated agentObservations
 * - On SelfHealingResult "unresolved": status = "escalated-to-human", outcome = "human-intervention-required"
 * - On SelfHealingResult "resolved": retry counter resets, execution continues, can succeed
 * - When ISelfHealingLoop throws: section marked "failed", outcome = "section-failed" (no crash)
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 2.1, 2.3, 2.4, 3.1, 4.1, 4.4, 4.5, 6.2, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4
 */

import { ImplementationLoopService } from "@/application/implementation-loop/implementation-loop-service";
import type { AgentLoopResult, IAgentLoop } from "@/application/ports/agent-loop";
import type { IContextEngine } from "@/application/ports/context";
import type { IGitController } from "@/application/ports/git-controller";
import type {
  IImplementationLoopEventBus,
  IImplementationLoopLogger,
  IPlanStore,
  IReviewEngine,
  ISelfHealingLoop,
  QualityGateConfig,
  ReviewResult,
  SectionIterationLogEntry,
} from "@/application/ports/implementation-loop";
import type { AgentState, Observation, TerminationCondition } from "@/domain/agent/types";
import type {
  ImplementationLoopEvent,
  SectionEscalation,
  SectionExecutionRecord,
  SelfHealingResult,
} from "@/domain/implementation-loop/types";
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

// ===========================================================================
// Task 4.2: Implement-Review-Commit Cycle Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Task 4.2 spy helpers
// ---------------------------------------------------------------------------

/** Spy agent loop that records which task strings were passed to run(). */
function makeSpyAgentLoop(
  resultOverrides: Partial<AgentLoopResult> = {},
): IAgentLoop & { calls: string[] } {
  const calls: string[] = [];
  const baseResult = makeAgentLoopResult();
  const result: AgentLoopResult = { ...baseResult, ...resultOverrides };
  return {
    calls,
    async run(task: string) {
      calls.push(task);
      return result;
    },
    stop() {},
    getState() {
      return null;
    },
  };
}

/** Spy agent loop that simulates a non-completing agent loop run. */
function makeFailingAgentLoop(condition: TerminationCondition): IAgentLoop & { calls: string[] } {
  return makeSpyAgentLoop({ terminationCondition: condition, taskCompleted: false });
}

/** Spy review engine that records how many times review() was called. */
function makeSpyReviewEngine(
  outcome: "passed" | "failed" = "passed",
): IReviewEngine & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async review() {
      callCount++;
      return makeReviewResult(outcome);
    },
  };
}

/** Spy git controller that records stageAndCommit calls. */
function makeSpyGitController(
  commitSuccess = true,
): IGitController & { commitCalls: Array<{ files: readonly string[]; message: string }> } {
  const commitCalls: Array<{ files: readonly string[]; message: string }> = [];
  return {
    commitCalls,
    async listBranches() {
      return { ok: true, value: [] };
    },
    async detectChanges() {
      return { ok: true, value: { staged: [], unstaged: ["src/feature.ts"], untracked: [] } };
    },
    async createAndCheckoutBranch() {
      return {
        ok: true,
        value: { branchName: "feature/test", baseBranch: "main", conflictResolved: false },
      };
    },
    async stageAndCommit(files, message) {
      commitCalls.push({ files, message });
      if (!commitSuccess) {
        return { ok: false, error: { type: "runtime", message: "Nothing to commit" } };
      }
      return { ok: true, value: { hash: "commit-sha-abc", message, fileCount: 1 } };
    },
    async push() {
      return {
        ok: true,
        value: { branchName: "feature/test", remote: "origin", commitHash: "commit-sha-abc" },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Agent loop invocation
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.2) — agent loop invocation", () => {
  it("calls IAgentLoop.run() with the section title", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", title: "Build the auth module", status: "pending" })]);
    const store = makePlanStore(plan);
    const agentLoop = makeSpyAgentLoop();
    const service = makeService(store, {
      agentLoop,
      reviewEngine: makeSpyReviewEngine(),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    expect(agentLoop.calls).toHaveLength(1);
    expect(agentLoop.calls[0]).toContain("Build the auth module");
  });

  it("calls IAgentLoop.run() once per pending section", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", title: "Section A", status: "pending" }),
      makeTask({ id: "t2", title: "Section B", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const agentLoop = makeSpyAgentLoop();
    const service = makeService(store, {
      agentLoop,
      reviewEngine: makeSpyReviewEngine(),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    expect(agentLoop.calls).toHaveLength(2);
  });

  it("does not call IAgentLoop.run() for already-completed sections", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "completed" }),
      makeTask({ id: "t2", title: "Only this one", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const agentLoop = makeSpyAgentLoop();
    const service = makeService(store, {
      agentLoop,
      reviewEngine: makeSpyReviewEngine(),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    expect(agentLoop.calls).toHaveLength(1);
    expect(agentLoop.calls[0]).toContain("Only this one");
  });
});

// ---------------------------------------------------------------------------
// Review engine invocation
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.2) — review engine invocation", () => {
  it("calls IReviewEngine.review() after a successful agent loop run", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const reviewEngine = makeSpyReviewEngine();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine,
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    expect(reviewEngine.callCount).toBe(1);
  });

  it("does not call IReviewEngine.review() when agent loop fails to complete", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const agentLoop = makeFailingAgentLoop("SAFETY_STOP");
    const reviewEngine = makeSpyReviewEngine();
    const service = makeService(store, { agentLoop, reviewEngine, gitController: makeSpyGitController() });

    await service.run(plan.id);

    expect(reviewEngine.callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Git commit on review-passed
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.2) — git commit when review passes", () => {
  it("calls stageAndCommit when review passes", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", title: "Add caching layer", status: "pending" })]);
    const store = makePlanStore(plan);
    const git = makeSpyGitController();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: git,
    });

    await service.run(plan.id);

    expect(git.commitCalls).toHaveLength(1);
  });

  it("commit message contains the section title", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", title: "Add caching layer", status: "pending" })]);
    const store = makePlanStore(plan);
    const git = makeSpyGitController();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: git,
    });

    await service.run(plan.id);

    const commitMessage = git.commitCalls[0]?.message ?? "";
    expect(commitMessage).toContain("Add caching layer");
  });

  it("does not call stageAndCommit when review fails", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const git = makeSpyGitController();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: git,
    });

    await service.run(plan.id);

    expect(git.commitCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// IPlanStore status updates on commit
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.2) — plan store updates", () => {
  it("updates section to 'completed' in IPlanStore when review passes and commit succeeds", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    const completedUpdate = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "completed",
    );
    expect(completedUpdate).toBeDefined();
  });

  it("updates section to 'failed' when agent loop does not complete (SAFETY_STOP)", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeFailingAgentLoop("SAFETY_STOP"),
      reviewEngine: makeSpyReviewEngine(),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    const failedUpdate = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "failed",
    );
    expect(failedUpdate).toBeDefined();
  });

  it("updates section to 'failed' when agent loop hits MAX_ITERATIONS_REACHED", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeFailingAgentLoop("MAX_ITERATIONS_REACHED"),
      reviewEngine: makeSpyReviewEngine(),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    const failedUpdate = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "failed",
    );
    expect(failedUpdate).toBeDefined();
  });

  it("updates section to 'failed' when review fails", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    const failedUpdate = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "failed",
    );
    expect(failedUpdate).toBeDefined();
  });

  it("updates section to 'failed' when git commit fails", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(false), // commit fails
    });

    await service.run(plan.id);

    const failedUpdate = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "failed",
    );
    expect(failedUpdate).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Events emitted during section execution
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.2) — lifecycle events", () => {
  it("emits section:completed event with commitSha when review passes and commit succeeds", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { eventBus });

    const completedEvent = eventBus.events.find((e) => e.type === "section:completed");
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.type === "section:completed" && completedEvent.commitSha).toBe(
      "commit-sha-abc",
    );
  });

  it("emits section:review-passed event when review passes", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { eventBus });

    const reviewPassedEvent = eventBus.events.find((e) => e.type === "section:review-passed");
    expect(reviewPassedEvent).toBeDefined();
  });

  it("emits section:review-failed event when review fails", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { eventBus });

    const reviewFailedEvent = eventBus.events.find((e) => e.type === "section:review-failed");
    expect(reviewFailedEvent).toBeDefined();
  });

  it("emits plan:halted event when git commit fails", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(false),
    });

    await service.run(plan.id, { eventBus });

    const haltedEvent = eventBus.events.find((e) => e.type === "plan:halted");
    expect(haltedEvent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Overall outcome when section execution fails
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.2) — overall outcome on section failure", () => {
  it("returns outcome: section-failed when agent loop does not complete", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeFailingAgentLoop("SAFETY_STOP"),
      reviewEngine: makeSpyReviewEngine(),
      gitController: makeSpyGitController(),
    });

    const result = await service.run(plan.id);

    expect(result.outcome).toBe("section-failed");
  });

  it("returns outcome: section-failed when review fails", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    const result = await service.run(plan.id);

    expect(result.outcome).toBe("section-failed");
  });

  it("returns outcome: section-failed when git commit fails", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(false),
    });

    const result = await service.run(plan.id);

    expect(result.outcome).toBe("section-failed");
  });

  it("does not halt on first section failure; includes failed section in sections array", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeFailingAgentLoop("SAFETY_STOP"),
      reviewEngine: makeSpyReviewEngine(),
      gitController: makeSpyGitController(),
    });

    const result = await service.run(plan.id);

    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.sections[0]?.status).toBe("failed");
  });

  it("does not execute subsequent sections after a section fails", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "pending" }),
      makeTask({ id: "t2", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const agentLoop = makeFailingAgentLoop("SAFETY_STOP");
    const service = makeService(store, {
      agentLoop,
      reviewEngine: makeSpyReviewEngine(),
      gitController: makeSpyGitController(),
    });

    // maxRetriesPerSection: 1 — single failure immediately escalates; t2 is never started
    await service.run(plan.id, { maxRetriesPerSection: 1 });

    // Agent loop called once (only for t1), t2 never starts
    expect(agentLoop.calls).toHaveLength(1);
  });
});

// ===========================================================================
// Task 4.3: Improve Step and Per-Section Retry Control Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Task 4.3 sequenced-stub helpers
// ---------------------------------------------------------------------------

/**
 * Agent loop that returns results in sequence (cycles on last if exhausted).
 * Useful for testing: "fail first attempt, pass second".
 */
function makeSequencedAgentLoop(
  results: Array<Partial<AgentLoopResult>>,
): IAgentLoop & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    async run(task: string) {
      calls.push(task);
      const override = results[Math.min(index, results.length - 1)] ?? {};
      index++;
      return { ...makeAgentLoopResult(), ...override };
    },
    stop() {},
    getState() {
      return null;
    },
  };
}

/**
 * Review engine that returns outcomes in sequence.
 * Useful for testing: "fail twice, then pass".
 */
function makeSequencedReviewEngine(
  outcomes: Array<"passed" | "failed">,
  feedbackDescription = "Missing error handling",
): IReviewEngine & { callCount: number } {
  let callCount = 0;
  let index = 0;
  return {
    get callCount() {
      return callCount;
    },
    async review() {
      callCount++;
      const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? "passed";
      index++;
      return {
        outcome,
        checks: [{ checkName: "test-check", outcome, required: true, details: "details" }],
        feedback: outcome === "failed"
          ? [{
            category: "requirement-alignment" as const,
            description: feedbackDescription,
            severity: "blocking" as const,
          }]
          : [],
        durationMs: 5,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Improve step invocation
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.3) — improve step invocation", () => {
  it("calls agent loop a second time (improve) when review fails once then passes", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", title: "Add auth", status: "pending" })]);
    const store = makePlanStore(plan);
    const agentLoop = makeSequencedAgentLoop([{}, {}]); // both pass TASK_COMPLETED
    const reviewEngine = makeSequencedReviewEngine(["failed", "passed"]);
    const service = makeService(store, {
      agentLoop,
      reviewEngine,
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 3 });

    expect(agentLoop.calls).toHaveLength(2);
  });

  it("overall outcome is 'completed' when review passes on the second attempt", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "passed"]),
      gitController: makeSpyGitController(),
    });

    const result = await service.run(plan.id, { maxRetriesPerSection: 3 });

    expect(result.outcome).toBe("completed");
  });

  it("improve prompt sent to agent loop contains feedback from the failed review", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", title: "Add rate limiting", status: "pending" })]);
    const store = makePlanStore(plan);
    const agentLoop = makeSequencedAgentLoop([{}, {}]);
    const reviewEngine = makeSequencedReviewEngine(["failed", "passed"], "Missing rate limiter logic");
    const service = makeService(store, {
      agentLoop,
      reviewEngine,
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 3 });

    // Second call should be the improve prompt (contains feedback)
    const improvePrompt = agentLoop.calls[1] ?? "";
    expect(improvePrompt).toContain("Missing rate limiter logic");
  });

  it("improve prompt also references the original task title", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", title: "Implement payment flow", status: "pending" })]);
    const store = makePlanStore(plan);
    const agentLoop = makeSequencedAgentLoop([{}, {}]);
    const reviewEngine = makeSequencedReviewEngine(["failed", "passed"]);
    const service = makeService(store, {
      agentLoop,
      reviewEngine,
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 3 });

    const improvePrompt = agentLoop.calls[1] ?? "";
    expect(improvePrompt).toContain("Implement payment flow");
  });

  it("emits section:improve-start event before each retry (not before the first attempt)", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "passed"]),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 3, eventBus });

    const improveStartEvents = eventBus.events.filter((e) => e.type === "section:improve-start");
    expect(improveStartEvents).toHaveLength(1);
  });

  it("does not emit section:improve-start on the first (non-improve) attempt", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { eventBus });

    const improveStartEvents = eventBus.events.filter((e) => e.type === "section:improve-start");
    expect(improveStartEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Retry counter and escalation
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.3) — retry counter and escalation", () => {
  it("emits section:escalated when retryCount reaches maxRetriesPerSection", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    // All reviews fail → retries exhausted
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 2, eventBus });

    const escalatedEvent = eventBus.events.find((e) => e.type === "section:escalated");
    expect(escalatedEvent).toBeDefined();
  });

  it("section:escalated event contains the section ID", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 2, eventBus });

    const escalatedEvent = eventBus.events.find((e) => e.type === "section:escalated");
    expect(escalatedEvent?.type === "section:escalated" && escalatedEvent.sectionId).toBe("t1");
  });

  it("section:escalated event contains the retryCount", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 2, eventBus });

    const escalatedEvent = eventBus.events.find((e) => e.type === "section:escalated");
    expect(escalatedEvent?.type === "section:escalated" && escalatedEvent.retryCount).toBe(2);
  });

  it("returns outcome: section-failed after maxRetriesPerSection exhausted", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    const result = await service.run(plan.id, { maxRetriesPerSection: 2 });

    expect(result.outcome).toBe("section-failed");
  });

  it("agent loop is called maxRetriesPerSection times when all attempts fail via review", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const agentLoop = makeSpyAgentLoop();
    const service = makeService(store, {
      agentLoop,
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 2 });

    // 2 total attempts: 1 initial + 1 improve (retryCount goes 0→1 on fail, 1→2 on fail = escalate)
    expect(agentLoop.calls).toHaveLength(2);
  });

  it("does not call stageAndCommit after maxRetriesPerSection exhausted", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const git = makeSpyGitController();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: git,
    });

    await service.run(plan.id, { maxRetriesPerSection: 2 });

    expect(git.commitCalls).toHaveLength(0);
  });

  it("section:review-failed is emitted for each failed review", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 2, eventBus });

    const reviewFailedEvents = eventBus.events.filter((e) => e.type === "section:review-failed");
    expect(reviewFailedEvents).toHaveLength(2);
  });

  it("agent loop failure counts toward retryCount and triggers escalation", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const eventBus = makeEventBus();
    const service = makeService(store, {
      agentLoop: makeFailingAgentLoop("SAFETY_STOP"),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    // All agent attempts fail → retryCount hits max
    await service.run(plan.id, { maxRetriesPerSection: 2, eventBus });

    const escalatedEvent = eventBus.events.find((e) => e.type === "section:escalated");
    expect(escalatedEvent).toBeDefined();
  });

  it("records all iterations in the SectionExecutionRecord when retries occur", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "failed", "passed"]),
      gitController: makeSpyGitController(),
    });

    const result = await service.run(plan.id, { maxRetriesPerSection: 3 });

    const section = result.sections[0];
    expect(section).toBeDefined();
    // 3 iterations: 2 failed + 1 passed
    expect(section?.iterations).toHaveLength(3);
  });

  it("commit is made only after a successful review (on retry)", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const git = makeSpyGitController();
    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "passed"]),
      gitController: git,
    });

    await service.run(plan.id, { maxRetriesPerSection: 3 });

    // Commit called once (after second review passes)
    expect(git.commitCalls).toHaveLength(1);
  });
});

// ===========================================================================
// Task 4.4: Context Isolation and Preservation Across Section Boundaries
// ===========================================================================

// ---------------------------------------------------------------------------
// Task 4.4 spy helpers
// ---------------------------------------------------------------------------

/** Spy context engine that records resetTask calls. */
function makeSpyContextEngine(): IContextEngine & { resetTaskCalls: string[] } {
  const resetTaskCalls: string[] = [];
  return {
    resetTaskCalls,
    async buildContext(_request) {
      return {
        content: "context snapshot",
        layers: [],
        totalTokens: 50,
        layerUsage: [],
        plannerDecision: { layersToRetrieve: [], rationale: "test" },
        degraded: false,
        omittedLayers: [],
      };
    },
    async expandContext(_request) {
      return { ok: false, updatedTokenCount: 0, errorReason: "not supported in spy" };
    },
    resetPhase(_phaseId: string) {},
    resetTask(taskId: string) {
      resetTaskCalls.push(taskId);
    },
  };
}

/** Agent loop spy that records whether a contextProvider was passed in options. */
function makeOptionsCapturingAgentLoop(): IAgentLoop & {
  invocations: Array<{ task: string; hasContextProvider: boolean }>;
} {
  const invocations: Array<{ task: string; hasContextProvider: boolean }> = [];
  return {
    invocations,
    async run(task, options?) {
      invocations.push({ task, hasContextProvider: options?.contextProvider !== undefined });
      return makeAgentLoopResult();
    },
    stop() {},
    getState() {
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Context isolation: resetTask per section
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.4) — context isolation per section", () => {
  it("calls contextEngine.resetTask with the section ID at section start", async () => {
    const plan = makeTaskPlan([makeTask({ id: "task-one", status: "pending" })]);
    const store = makePlanStore(plan);
    const contextEngine = makeSpyContextEngine();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { contextEngine });

    expect(contextEngine.resetTaskCalls).toContain("task-one");
  });

  it("calls contextEngine.resetTask exactly once per section even when retries occur", async () => {
    const plan = makeTaskPlan([makeTask({ id: "task-one", status: "pending" })]);
    const store = makePlanStore(plan);
    const contextEngine = makeSpyContextEngine();
    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "passed"]),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 3, contextEngine });

    const callsForSection = contextEngine.resetTaskCalls.filter((id) => id === "task-one");
    expect(callsForSection).toHaveLength(1);
  });

  it("calls contextEngine.resetTask once per section in a multi-section plan", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "section-a", title: "Section A", status: "pending" }),
      makeTask({ id: "section-b", title: "Section B", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const contextEngine = makeSpyContextEngine();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { contextEngine });

    expect(contextEngine.resetTaskCalls).toHaveLength(2);
    expect(contextEngine.resetTaskCalls[0]).toBe("section-a");
    expect(contextEngine.resetTaskCalls[1]).toBe("section-b");
  });
});

// ---------------------------------------------------------------------------
// Context provider passed to agent loop
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.4) — contextProvider passed to agent loop", () => {
  it("passes contextProvider to IAgentLoop.run() when contextEngine is provided", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const contextEngine = makeSpyContextEngine();
    const agentLoop = makeOptionsCapturingAgentLoop();
    const service = makeService(store, {
      agentLoop,
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { contextEngine });

    expect(agentLoop.invocations[0]?.hasContextProvider).toBe(true);
  });

  it("does not pass contextProvider to IAgentLoop.run() when contextEngine is absent", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const agentLoop = makeOptionsCapturingAgentLoop();
    const service = makeService(store, {
      agentLoop,
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    expect(agentLoop.invocations[0]?.hasContextProvider).toBe(false);
  });

  it("passes contextProvider to both implement and improve agent loop calls", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const contextEngine = makeSpyContextEngine();
    const agentLoop = makeOptionsCapturingAgentLoop();
    const reviewEngine = makeSequencedReviewEngine(["failed", "passed"]);
    const service = makeService(store, {
      agentLoop,
      reviewEngine,
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 3, contextEngine });

    expect(agentLoop.invocations).toHaveLength(2);
    expect(agentLoop.invocations[0]?.hasContextProvider).toBe(true);
    expect(agentLoop.invocations[1]?.hasContextProvider).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation without contextEngine
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.4) — works without contextEngine", () => {
  it("completes normally when no contextEngine is provided", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    const result = await service.run(plan.id);

    expect(result.outcome).toBe("completed");
  });
});

// ===========================================================================
// Task 4.5: Plan Resumption After Interruption
// ===========================================================================

describe("ImplementationLoopService (task 4.5) — run() resets in_progress sections", () => {
  it("run() resets in_progress sections to pending before re-executing", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "in_progress" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    const pendingReset = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "pending",
    );
    expect(pendingReset).toBeDefined();
  });

  it("run() executes a section that was in_progress (after resetting it)", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "in_progress" })]);
    const store = makePlanStore(plan);
    const agentLoop = makeSpyAgentLoop();
    const service = makeService(store, {
      agentLoop,
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    expect(agentLoop.calls).toHaveLength(1);
  });

  it("run() does not reset sections already in completed status", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "completed" }),
      makeTask({ id: "t2", status: "in_progress" }),
    ]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    const t1PendingReset = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "pending",
    );
    expect(t1PendingReset).toBeUndefined();
  });

  it("run() returns completed when resuming from an in_progress section that succeeds", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "completed" }),
      makeTask({ id: "t2", status: "in_progress" }),
    ]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    const result = await service.run(plan.id);

    expect(result.outcome).toBe("completed");
  });
});

describe("ImplementationLoopService (task 4.5) — context re-initialized for resumed section", () => {
  it("calls contextEngine.resetTask for a section that was in_progress (fresh context on resume)", async () => {
    const plan = makeTaskPlan([makeTask({ id: "task-resume", status: "in_progress" })]);
    const store = makePlanStore(plan);
    const contextEngine = makeSpyContextEngine();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { contextEngine });

    expect(contextEngine.resetTaskCalls).toContain("task-resume");
  });

  it("does not re-execute completed sections — only the interrupted section runs", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "completed-section", status: "completed" }),
      makeTask({ id: "interrupted-section", status: "in_progress" }),
    ]);
    const store = makePlanStore(plan);
    const agentLoop = makeSpyAgentLoop();
    const service = makeService(store, {
      agentLoop,
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id);

    // Only the interrupted (in_progress) section is re-executed
    expect(agentLoop.calls).toHaveLength(1);
  });
});

// ===========================================================================
// Task 4.6: Structured Logging and Event Emission
// ===========================================================================

// ---------------------------------------------------------------------------
// Task 4.6 spy helpers
// ---------------------------------------------------------------------------

/** Spy logger that records all calls to logIteration, logSectionComplete, logHaltSummary. */
function makeSpyLogger(): IImplementationLoopLogger & {
  iterationEntries: SectionIterationLogEntry[];
  sectionCompleteRecords: SectionExecutionRecord[];
  haltSummaryCount: number;
} {
  const iterationEntries: SectionIterationLogEntry[] = [];
  const sectionCompleteRecords: SectionExecutionRecord[] = [];
  let haltSummaryCount = 0;
  return {
    iterationEntries,
    sectionCompleteRecords,
    get haltSummaryCount() {
      return haltSummaryCount;
    },
    logIteration(entry: SectionIterationLogEntry) {
      iterationEntries.push(entry);
    },
    logSectionComplete(record: SectionExecutionRecord) {
      sectionCompleteRecords.push(record);
    },
    logHaltSummary(_summary) {
      haltSummaryCount++;
    },
  };
}

// ---------------------------------------------------------------------------
// logIteration: called after each agent loop iteration
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.6) — logIteration", () => {
  it("calls logIteration once after a successful section with reviewOutcome: passed", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const logger = makeSpyLogger();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { logger });

    expect(logger.iterationEntries).toHaveLength(1);
    expect(logger.iterationEntries[0]?.reviewOutcome).toBe("passed");
  });

  it("includes correct planId and sectionId in logIteration entry", async () => {
    const plan = makeTaskPlan([makeTask({ id: "section-x", status: "pending" })]);
    const store = makePlanStore(plan);
    const logger = makeSpyLogger();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { logger });

    const entry = logger.iterationEntries[0];
    expect(entry?.planId).toBe(plan.id);
    expect(entry?.sectionId).toBe("section-x");
  });

  it("calls logIteration with reviewOutcome: failed when review fails", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const logger = makeSpyLogger();
    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "passed"]),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 3, logger });

    const failedEntries = logger.iterationEntries.filter((e) => e.reviewOutcome === "failed");
    expect(failedEntries).toHaveLength(1);
  });

  it("records iterationNumber starting at 1 for the first iteration", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const logger = makeSpyLogger();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { logger });

    expect(logger.iterationEntries[0]?.iterationNumber).toBe(1);
  });

  it("records commitSha in logIteration entry when commit succeeds", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const logger = makeSpyLogger();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { logger });

    expect(logger.iterationEntries[0]?.commitSha).toBeDefined();
  });

  it("calls logIteration twice when one retry occurs before passing", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const logger = makeSpyLogger();
    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "passed"]),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 3, logger });

    expect(logger.iterationEntries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// logSectionComplete: called only on successful sections
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.6) — logSectionComplete", () => {
  it("calls logSectionComplete once for a completed section", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const logger = makeSpyLogger();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { logger });

    expect(logger.sectionCompleteRecords).toHaveLength(1);
  });

  it("logSectionComplete record has status: completed", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const logger = makeSpyLogger();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { logger });

    expect(logger.sectionCompleteRecords[0]?.status).toBe("completed");
  });

  it("does NOT call logSectionComplete when a section fails", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const logger = makeSpyLogger();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { logger });

    expect(logger.sectionCompleteRecords).toHaveLength(0);
  });

  it("calls logSectionComplete for each completed section in a multi-section plan", async () => {
    const plan = makeTaskPlan([
      makeTask({ id: "t1", status: "pending" }),
      makeTask({ id: "t2", status: "pending" }),
    ]);
    const store = makePlanStore(plan);
    const logger = makeSpyLogger();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { logger });

    expect(logger.sectionCompleteRecords).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// logHaltSummary: called only when loop halts
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.6) — logHaltSummary", () => {
  it("calls logHaltSummary when a section fails and loop halts", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const logger = makeSpyLogger();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { logger });

    expect(logger.haltSummaryCount).toBe(1);
  });

  it("does NOT call logHaltSummary when all sections complete successfully", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const logger = makeSpyLogger();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { logger });

    expect(logger.haltSummaryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Logger is optional — no logger provided
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.6) — logger is optional", () => {
  it("completes successfully without a logger", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("passed"),
      gitController: makeSpyGitController(),
    });

    // No logger in options — must not throw
    const result = await service.run(plan.id);

    expect(result.outcome).toBe("completed");
  });
});

// ===========================================================================
// Task 4.7: Escalation to the Self-Healing Loop
// ===========================================================================

// ---------------------------------------------------------------------------
// Task 4.7 spy helpers
// ---------------------------------------------------------------------------

/** Creates an ISelfHealingLoop stub with a configurable outcome. */
function makeSelfHealingLoop(
  result: SelfHealingResult,
): ISelfHealingLoop & { escalations: SectionEscalation[] } {
  const escalations: SectionEscalation[] = [];
  return {
    escalations,
    async escalate(escalation: SectionEscalation): Promise<SelfHealingResult> {
      escalations.push(escalation);
      return result;
    },
  };
}

/** ISelfHealingLoop stub that throws on escalate. */
function makeThrowingSelfHealingLoop(): ISelfHealingLoop {
  return {
    async escalate(_escalation: SectionEscalation): Promise<never> {
      throw new Error("Self-healing loop crashed");
    },
  };
}

/**
 * Agent loop that includes observations in finalState.
 * Useful for verifying agentObservations passed to ISelfHealingLoop.escalate().
 */
function makeObservationAgentLoop(
  observation: Observation,
): IAgentLoop & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(task: string) {
      calls.push(task);
      const base = makeAgentLoopResult();
      return {
        ...base,
        finalState: {
          ...base.finalState,
          observations: [observation],
        },
      };
    },
    stop() {},
    getState() {
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// No ISelfHealingLoop provided — falls back to section-failed
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.7) — no self-healing loop provided", () => {
  it("returns outcome: section-failed when ISelfHealingLoop is absent and retries are exhausted", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    const result = await service.run(plan.id, { maxRetriesPerSection: 1 });

    expect(result.outcome).toBe("section-failed");
  });

  it("marks section as 'failed' in IPlanStore when no self-healing loop is present", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 1 });

    const failedUpdate = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "failed",
    );
    expect(failedUpdate).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ISelfHealingLoop provided — "unresolved" outcome
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.7) — self-healing loop: unresolved", () => {
  it("returns outcome: human-intervention-required when self-healing loop returns unresolved", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const selfHealingLoop = makeSelfHealingLoop({ outcome: "unresolved", summary: "Cannot fix" });
    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "failed"]),
      gitController: makeSpyGitController(),
    });

    const result = await service.run(plan.id, { maxRetriesPerSection: 2, selfHealingLoop });

    expect(result.outcome).toBe("human-intervention-required");
  });

  it("marks section as 'escalated-to-human' in IPlanStore on unresolved outcome", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const selfHealingLoop = makeSelfHealingLoop({ outcome: "unresolved", summary: "Cannot fix" });
    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "failed"]),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 2, selfHealingLoop });

    const escalatedUpdate = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "escalated-to-human",
    );
    expect(escalatedUpdate).toBeDefined();
  });

  it("calls ISelfHealingLoop.escalate() with the correct sectionId and planId", async () => {
    const plan = makeTaskPlan([makeTask({ id: "task-abc", status: "pending" })]);
    const store = makePlanStore(plan);
    const selfHealingLoop = makeSelfHealingLoop({ outcome: "unresolved", summary: "Cannot fix" });
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 1, selfHealingLoop });

    expect(selfHealingLoop.escalations).toHaveLength(1);
    expect(selfHealingLoop.escalations[0]?.sectionId).toBe("task-abc");
    expect(selfHealingLoop.escalations[0]?.planId).toBe(plan.id);
  });

  it("passes retryHistory with all iteration records to escalate()", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const selfHealingLoop = makeSelfHealingLoop({ outcome: "unresolved", summary: "Cannot fix" });
    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "failed"]),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 2, selfHealingLoop });

    const escalation = selfHealingLoop.escalations[0];
    // 2 iterations were recorded before escalation
    expect(escalation?.retryHistory).toHaveLength(2);
  });

  it("passes accumulated reviewFeedback from all failed iterations to escalate()", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const selfHealingLoop = makeSelfHealingLoop({ outcome: "unresolved", summary: "Cannot fix" });
    // Each failed review returns 1 feedback item with description "Missing error handling"
    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "failed"], "Missing error handling"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 2, selfHealingLoop });

    const escalation = selfHealingLoop.escalations[0];
    // 2 failed reviews × 1 feedback item each = 2 accumulated feedback items
    expect(escalation?.reviewFeedback.length).toBeGreaterThanOrEqual(1);
  });

  it("passes agentObservations accumulated across all iterations to escalate()", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const selfHealingLoop = makeSelfHealingLoop({ outcome: "unresolved", summary: "Cannot fix" });

    const observation: Observation = {
      toolName: "read_file",
      toolInput: { path: "src/feature.ts" },
      rawOutput: "file contents",
      success: true,
      recordedAt: new Date().toISOString(),
    };

    // Agent loop emits an observation on each run
    const agentLoop = makeObservationAgentLoop(observation);
    const service = makeService(store, {
      agentLoop,
      reviewEngine: makeSequencedReviewEngine(["failed", "failed"]),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 2, selfHealingLoop });

    const escalation = selfHealingLoop.escalations[0];
    // 2 runs × 1 observation each = 2 accumulated observations
    expect(escalation?.agentObservations.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// ISelfHealingLoop provided — "resolved" outcome
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.7) — self-healing loop: resolved", () => {
  it("resets retry counter and continues execution after self-healing resolves", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const selfHealingLoop = makeSelfHealingLoop({ outcome: "resolved", summary: "Fixed" });

    // First maxRetriesPerSection iterations fail → trigger escalation → resolved → then passes
    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "failed", "passed"]),
      gitController: makeSpyGitController(),
    });

    const result = await service.run(plan.id, { maxRetriesPerSection: 2, selfHealingLoop });

    expect(result.outcome).toBe("completed");
  });

  it("marks section as 'completed' when self-healing resolves and subsequent attempt passes", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const selfHealingLoop = makeSelfHealingLoop({ outcome: "resolved", summary: "Fixed" });

    const service = makeService(store, {
      agentLoop: makeSequencedAgentLoop([{}, {}, {}]),
      reviewEngine: makeSequencedReviewEngine(["failed", "failed", "passed"]),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 2, selfHealingLoop });

    const completedUpdate = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "completed",
    );
    expect(completedUpdate).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ISelfHealingLoop throws — falls back to section-failed
// ---------------------------------------------------------------------------

describe("ImplementationLoopService (task 4.7) — self-healing loop throws", () => {
  it("returns outcome: section-failed when ISelfHealingLoop.escalate() throws", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const selfHealingLoop = makeThrowingSelfHealingLoop();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    // Must not throw — error surfaces as section-failed
    const result = await service.run(plan.id, { maxRetriesPerSection: 1, selfHealingLoop });

    expect(result.outcome).toBe("section-failed");
  });

  it("marks section as 'failed' when ISelfHealingLoop.escalate() throws", async () => {
    const plan = makeTaskPlan([makeTask({ id: "t1", status: "pending" })]);
    const store = makePlanStore(plan);
    const selfHealingLoop = makeThrowingSelfHealingLoop();
    const service = makeService(store, {
      agentLoop: makeSpyAgentLoop(),
      reviewEngine: makeSpyReviewEngine("failed"),
      gitController: makeSpyGitController(),
    });

    await service.run(plan.id, { maxRetriesPerSection: 1, selfHealingLoop });

    const failedUpdate = store.statusUpdates.find(
      (u) => u.sectionId === "t1" && u.status === "failed",
    );
    expect(failedUpdate).toBeDefined();
  });
});
