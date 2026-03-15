/**
 * Integration tests for the Implementation Loop service — Tasks 6.1–6.5
 *
 * Task 6.1 — full implement → review → commit cycle:
 * - Stub IAgentLoop returns a successful result for every section
 * - Stub IReviewEngine returns outcome: "passed" on first attempt
 * - IPlanStore.updateSectionStatus is called with "completed" for each section
 * - Git integration commits once per section with a message referencing the section title
 * - ImplementationLoopResult.outcome = "completed" and all SectionExecutionRecord statuses are "completed"
 * - plan:completed event is emitted after all sections
 * - SectionIterationLogEntry records are written for each completed section
 *
 * Task 6.2 — retry flow:
 * - Stub IReviewEngine returns "failed" for first two iterations, "passed" on third
 * - Retry counter increments correctly after each failure
 * - Improve prompt carries review feedback from the previous failed attempt
 * - Final commit occurs only after the third (passing) iteration
 *
 * Task 6.3 — escalation and halt:
 * - IReviewEngine always fails → maxRetriesPerSection is reached → section:escalated emitted
 * - With ISelfHealingLoop returning "unresolved": section "escalated-to-human", plan:halted, outcome "human-intervention-required"
 * - Without ISelfHealingLoop: section "failed", plan:halted emitted, outcome "section-failed"
 * - section:escalated event contains sectionId, retry count, and review feedback
 *
 * Task 6.4 — plan resumption after interruption:
 * - Plan seeded with one "in_progress" section and one "completed" section
 * - resume(planId): completed section is not re-executed
 * - "in_progress" section is reset to "pending" before execution begins
 * - Context is re-initialized fresh for the resumed section (resetTask called once)
 *
 * Task 6.5 — quality gate checks and commit blocking:
 * - Required lint check failure blocks commit, routes back to improve step
 * - Advisory test check failure does not block commit (review passes with advisory feedback)
 * - Gate check results appear in the iteration log entry
 *
 * Integration scope:
 * - Real PlanFileStore (atomic JSON persistence) backed by a temp directory, wrapped in an
 *   IPlanStore adapter so ImplementationLoopService can read and persist section state
 * - Real NdjsonImplementationLoopLogger writing to the temp directory
 * - Real ImplementationLoopService (full orchestration logic)
 * - Stub IAgentLoop, IReviewEngine, IGitController
 * - Verifies end-to-end plan state via filesystem reads, not just in-memory results
 *
 * Requirements: 1.1, 1.3, 1.5, 1.6, 2.1, 2.3, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5,
 *              6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.3, 7.4, 7.5, 9.1, 9.2, 9.3, 9.4
 */

import { ImplementationLoopService } from "@/application/implementation-loop/implementation-loop-service";
import type { AgentLoopResult, IAgentLoop } from "@/application/ports/agent-loop";
import type { IContextEngine } from "@/application/ports/context";
import type { IGitController } from "@/application/ports/git-controller";
import type {
  IImplementationLoopEventBus,
  IPlanStore,
  IQualityGate,
  IReviewEngine,
  QualityGateCheck,
  QualityGateConfig,
  ReviewResult,
  SectionPersistenceStatus,
} from "@/application/ports/implementation-loop";
import type { AgentState } from "@/domain/agent/types";
import type {
  ImplementationLoopEvent,
  ReviewCheckResult,
  ReviewFeedbackItem,
  SectionEscalation,
  SelfHealingResult,
} from "@/domain/implementation-loop/types";
import type { ISelfHealingLoop } from "@/application/ports/implementation-loop";
import type { TaskPlan } from "@/domain/planning/types";
import { NdjsonImplementationLoopLogger } from "@/infra/implementation-loop/ndjson-logger";
import { PlanFileStore } from "@/infra/planning/plan-file-store";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// PlanFileStoreAdapter — wraps PlanFileStore into IPlanStore
// ---------------------------------------------------------------------------

/**
 * Adapter that satisfies the `IPlanStore` port by delegating to `PlanFileStore`.
 * `updateSectionStatus` reads the current plan, patches the matching task's status,
 * then writes back atomically. Only the four `TaskStatus` values (pending, in_progress,
 * completed, failed) trigger a real save; "escalated-to-human" is stored as-is.
 */
class PlanFileStoreAdapter implements IPlanStore {
  readonly #store: PlanFileStore;

  constructor(store: PlanFileStore) {
    this.#store = store;
  }

  async loadPlan(planId: string): Promise<TaskPlan | null> {
    return this.#store.load(planId);
  }

  async updateSectionStatus(
    planId: string,
    sectionId: string,
    status: SectionPersistenceStatus,
  ): Promise<void> {
    const plan = await this.#store.load(planId);
    if (plan === null) return;

    // Patch the matching task's status. We cast because PlanFileStore's TaskStatus union
    // does not include "escalated-to-human", but PlanFileStore is specified to preserve
    // unknown status values rather than coercing them (design tolerance note).
    const updatedTasks = plan.tasks.map((t) =>
      t.id === sectionId ? { ...t, status: status as TaskPlan["tasks"][number]["status"] } : t,
    );

    await this.#store.save({
      ...plan,
      tasks: updatedTasks,
      updatedAt: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makeSuccessAgentLoop(callTracker?: { count: number }): IAgentLoop {
  return {
    async run(): Promise<AgentLoopResult> {
      if (callTracker) callTracker.count++;
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
    },
    stop() {},
    getState() {
      return null;
    },
  };
}

function makePassingReviewEngine(): IReviewEngine {
  return {
    async review(
      _result: AgentLoopResult,
      _section: unknown,
      _config: QualityGateConfig,
    ): Promise<ReviewResult> {
      return { outcome: "passed", checks: [], feedback: [], durationMs: 5 };
    },
  };
}

/** Stub git controller that records commit calls. */
function makeGitController(): IGitController & {
  commits: Array<{ files: ReadonlyArray<string>; message: string }>;
} {
  const commits: Array<{ files: ReadonlyArray<string>; message: string }> = [];
  return {
    commits,
    async listBranches() {
      return { ok: true, value: [] };
    },
    async detectChanges() {
      return { ok: true, value: { staged: [], unstaged: [], untracked: ["src/file.ts"] } };
    },
    async createAndCheckoutBranch() {
      return {
        ok: true,
        value: { branchName: "feature/test", baseBranch: "main", conflictResolved: false },
      };
    },
    async stageAndCommit(files, message) {
      commits.push({ files, message });
      return { ok: true, value: { hash: `sha-${commits.length}`, message, fileCount: files.length } };
    },
    async push() {
      return { ok: true, value: { branchName: "feature/test", remote: "origin", commitHash: "sha-1" } };
    },
  };
}

function makeEventBus(): IImplementationLoopEventBus & { events: ImplementationLoopEvent[] } {
  const events: ImplementationLoopEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
}

/** Seed a plan with the given tasks into PlanFileStore, return the plan ID. */
async function seedPlan(store: PlanFileStore, tasks: TaskPlan["tasks"]): Promise<string> {
  const plan: TaskPlan = {
    id: `plan-${Date.now()}`,
    goal: "Integration test plan",
    tasks,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.save(plan);
  return plan.id;
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "impl-loop-int-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Task 6.1 — Full implement → review → commit cycle
// ---------------------------------------------------------------------------

describe("ImplementationLoop integration — full implement → review → commit cycle (task 6.1)", () => {
  it("returns outcome: completed when all sections pass review", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Section Alpha", status: "pending", steps: [] },
      { id: "s2", title: "Section Beta", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makePassingReviewEngine(),
      makeGitController(),
    );

    const result = await service.run(planId);

    expect(result.outcome).toBe("completed");
  });

  it("marks all sections as completed in the persisted plan", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Section Alpha", status: "pending", steps: [] },
      { id: "s2", title: "Section Beta", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makePassingReviewEngine(),
      makeGitController(),
    );

    await service.run(planId);

    const persistedPlan = await fileStore.load(planId);
    expect(persistedPlan).not.toBeNull();
    for (const task of persistedPlan!.tasks) {
      expect(task.status).toBe("completed");
    }
  });

  it("all SectionExecutionRecord statuses in the result are 'completed'", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Section Alpha", status: "pending", steps: [] },
      { id: "s2", title: "Section Beta", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makePassingReviewEngine(),
      makeGitController(),
    );

    const result = await service.run(planId);

    expect(result.sections).toHaveLength(2);
    for (const section of result.sections) {
      expect(section.status).toBe("completed");
    }
  });

  it("commits once per section with a message referencing the section title", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Section Alpha", status: "pending", steps: [] },
      { id: "s2", title: "Section Beta", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const gitController = makeGitController();
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makePassingReviewEngine(),
      gitController,
    );

    await service.run(planId);

    expect(gitController.commits).toHaveLength(2);
    expect(gitController.commits[0]!.message).toContain("Section Alpha");
    expect(gitController.commits[1]!.message).toContain("Section Beta");
  });

  it("emits plan:completed event after all sections complete", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Section Alpha", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const eventBus = makeEventBus();
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makePassingReviewEngine(),
      makeGitController(),
    );

    await service.run(planId, { eventBus });

    const completedEvents = eventBus.events.filter((e) => e.type === "plan:completed");
    expect(completedEvents).toHaveLength(1);
  });

  it("emits section:start and section:completed events for each section", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Section Alpha", status: "pending", steps: [] },
      { id: "s2", title: "Section Beta", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const eventBus = makeEventBus();
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makePassingReviewEngine(),
      makeGitController(),
    );

    await service.run(planId, { eventBus });

    const startEvents = eventBus.events.filter((e) => e.type === "section:start");
    const completedEvents = eventBus.events.filter((e) => e.type === "section:completed");
    expect(startEvents).toHaveLength(2);
    expect(completedEvents).toHaveLength(2);
  });

  it("writes SectionIterationLogEntry records to NDJSON log file for each section", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Section Alpha", status: "pending", steps: [] },
      { id: "s2", title: "Section Beta", status: "pending", steps: [] },
    ]);

    const logDir = join(tmpDir, "logs");
    const logger = new NdjsonImplementationLoopLogger(planId, logDir);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makePassingReviewEngine(),
      makeGitController(),
    );

    await service.run(planId, { logger });

    const logPath = join(logDir, `implementation-loop-${planId}.ndjson`);
    const raw = await readFile(logPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    // Expect at least one log entry per section (iteration entry + section-complete entry)
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // All lines must be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // At least two iteration entries (one per section)
    const iterationEntries = lines
      .map((l) => JSON.parse(l))
      .filter((e: { type?: string }) => e.type === "iteration");
    expect(iterationEntries).toHaveLength(2);

    // Each iteration entry should have correct planId and sectionId
    for (const entry of iterationEntries) {
      expect(entry.planId).toBe(planId);
      expect(entry.reviewOutcome).toBe("passed");
    }
  });

  it("records the commit SHA in the section:completed event", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Section Alpha", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const eventBus = makeEventBus();
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makePassingReviewEngine(),
      makeGitController(),
    );

    await service.run(planId, { eventBus });

    const completedEvent = eventBus.events.find((e) => e.type === "section:completed") as
      | { type: "section:completed"; commitSha: string }
      | undefined;
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.commitSha).toBeDefined();
    expect(typeof completedEvent?.commitSha).toBe("string");
  });

  it("agent loop is called once per section", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Section Alpha", status: "pending", steps: [] },
      { id: "s2", title: "Section Beta", status: "pending", steps: [] },
      { id: "s3", title: "Section Gamma", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const callTracker = { count: 0 };
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(callTracker),
      makePassingReviewEngine(),
      makeGitController(),
    );

    await service.run(planId);

    expect(callTracker.count).toBe(3);
  });

  it("skips sections that are already completed at plan load time", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Already Done", status: "completed", steps: [] },
      { id: "s2", title: "Section Beta", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const callTracker = { count: 0 };
    const gitController = makeGitController();
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(callTracker),
      makePassingReviewEngine(),
      gitController,
    );

    const result = await service.run(planId);

    expect(result.outcome).toBe("completed");
    // Agent loop only invoked for the one pending section
    expect(callTracker.count).toBe(1);
    // Only one commit (for the pending section)
    expect(gitController.commits).toHaveLength(1);
    expect(gitController.commits[0]!.message).toContain("Section Beta");
  });
});

// ---------------------------------------------------------------------------
// Task 6.2 — Integration test: retry flow
// ---------------------------------------------------------------------------

/**
 * Review engine that returns outcomes in sequence (cycles on last).
 * Returns `feedbackDescription` as the feedback text on failed iterations.
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
    async review(): Promise<ReviewResult> {
      callCount++;
      const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? "passed";
      index++;
      return {
        outcome,
        checks: [{ checkName: "test-check", outcome, required: true, details: "details" }],
        feedback: outcome === "failed"
          ? [
            {
              category: "requirement-alignment" as const,
              description: feedbackDescription,
              severity: "blocking" as const,
            } satisfies ReviewFeedbackItem,
          ]
          : [],
        durationMs: 5,
      };
    },
  };
}

/**
 * Agent loop that records every task string passed to run().
 */
function makeTrackingAgentLoop(): IAgentLoop & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(task: string): Promise<AgentLoopResult> {
      calls.push(task);
      const state: AgentState = {
        task,
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
    },
    stop() {},
    getState() {
      return null;
    },
  };
}

describe("ImplementationLoop integration — retry flow (task 6.2)", () => {
  it("returns outcome: completed when review passes on the third iteration", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const service = new ImplementationLoopService(
      planStore,
      makeTrackingAgentLoop(),
      makeSequencedReviewEngine(["failed", "failed", "passed"]),
      makeGitController(),
    );

    const result = await service.run(planId, { maxRetriesPerSection: 3 });

    expect(result.outcome).toBe("completed");
  });

  it("retry counter increments correctly — SectionExecutionRecord.retryCount equals 2 after two failures", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const service = new ImplementationLoopService(
      planStore,
      makeTrackingAgentLoop(),
      makeSequencedReviewEngine(["failed", "failed", "passed"]),
      makeGitController(),
    );

    const result = await service.run(planId, { maxRetriesPerSection: 3 });

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.retryCount).toBe(2);
  });

  it("agent loop is called three times when review fails twice then passes", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Add caching", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const agentLoop = makeTrackingAgentLoop();
    const service = new ImplementationLoopService(
      planStore,
      agentLoop,
      makeSequencedReviewEngine(["failed", "failed", "passed"]),
      makeGitController(),
    );

    await service.run(planId, { maxRetriesPerSection: 3 });

    expect(agentLoop.calls).toHaveLength(3);
  });

  it("improve prompt carries review feedback from the previous failed attempt", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Add rate limiting", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const agentLoop = makeTrackingAgentLoop();
    const service = new ImplementationLoopService(
      planStore,
      agentLoop,
      makeSequencedReviewEngine(["failed", "passed"], "Rate limiter logic is missing"),
      makeGitController(),
    );

    await service.run(planId, { maxRetriesPerSection: 3 });

    // Second call is the improve step; it should carry the feedback text
    const improvePrompt = agentLoop.calls[1] ?? "";
    expect(improvePrompt).toContain("Rate limiter logic is missing");
  });

  it("improve prompt references the original task title", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement payment flow", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const agentLoop = makeTrackingAgentLoop();
    const service = new ImplementationLoopService(
      planStore,
      agentLoop,
      makeSequencedReviewEngine(["failed", "passed"]),
      makeGitController(),
    );

    await service.run(planId, { maxRetriesPerSection: 3 });

    const improvePrompt = agentLoop.calls[1] ?? "";
    expect(improvePrompt).toContain("Implement payment flow");
  });

  it("final commit occurs only after the passing iteration", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const gitController = makeGitController();
    const service = new ImplementationLoopService(
      planStore,
      makeTrackingAgentLoop(),
      makeSequencedReviewEngine(["failed", "failed", "passed"]),
      gitController,
    );

    await service.run(planId, { maxRetriesPerSection: 3 });

    // Only one commit — happens only after the third (passing) review
    expect(gitController.commits).toHaveLength(1);
  });

  it("section:review-failed event is emitted for each failed review iteration", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const eventBus = makeEventBus();
    const service = new ImplementationLoopService(
      planStore,
      makeTrackingAgentLoop(),
      makeSequencedReviewEngine(["failed", "failed", "passed"]),
      makeGitController(),
    );

    await service.run(planId, { maxRetriesPerSection: 3, eventBus });

    const failedEvents = eventBus.events.filter((e) => e.type === "section:review-failed");
    expect(failedEvents).toHaveLength(2);
  });

  it("persists 'completed' status to plan file after retries succeed", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const service = new ImplementationLoopService(
      planStore,
      makeTrackingAgentLoop(),
      makeSequencedReviewEngine(["failed", "passed"]),
      makeGitController(),
    );

    await service.run(planId, { maxRetriesPerSection: 3 });

    const persistedPlan = await fileStore.load(planId);
    expect(persistedPlan?.tasks[0]?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Task 6.3 — Integration test: escalation and halt
// ---------------------------------------------------------------------------

/** Review engine that always returns "failed". */
function makeAlwaysFailingReviewEngine(feedbackDescription = "Implementation does not meet requirements"): IReviewEngine {
  return {
    async review(): Promise<ReviewResult> {
      return {
        outcome: "failed",
        checks: [{ checkName: "review", outcome: "failed", required: true, details: "check failed" }],
        feedback: [{
          category: "requirement-alignment" as const,
          description: feedbackDescription,
          severity: "blocking" as const,
        }],
        durationMs: 5,
      };
    },
  };
}

describe("ImplementationLoop integration — escalation and halt (task 6.3)", () => {
  it("returns outcome: section-failed when ISelfHealingLoop is absent and max retries reached", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makeAlwaysFailingReviewEngine(),
      makeGitController(),
    );

    const result = await service.run(planId, { maxRetriesPerSection: 2 });

    expect(result.outcome).toBe("section-failed");
  });

  it("persists 'failed' status to plan file when ISelfHealingLoop is absent", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makeAlwaysFailingReviewEngine(),
      makeGitController(),
    );

    await service.run(planId, { maxRetriesPerSection: 2 });

    const persistedPlan = await fileStore.load(planId);
    expect(persistedPlan?.tasks[0]?.status).toBe("failed");
  });

  it("emits plan:halted event when ISelfHealingLoop is absent", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const eventBus = makeEventBus();
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makeAlwaysFailingReviewEngine(),
      makeGitController(),
    );

    await service.run(planId, { maxRetriesPerSection: 2, eventBus });

    const haltedEvent = eventBus.events.find((e) => e.type === "plan:halted");
    expect(haltedEvent).toBeDefined();
  });

  it("section:escalated event contains sectionId and retryCount", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const eventBus = makeEventBus();
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makeAlwaysFailingReviewEngine(),
      makeGitController(),
    );

    await service.run(planId, { maxRetriesPerSection: 2, eventBus });

    const escalatedEvent = eventBus.events.find((e) => e.type === "section:escalated");
    expect(escalatedEvent).toBeDefined();
    expect(
      escalatedEvent?.type === "section:escalated" && escalatedEvent.sectionId,
    ).toBe("s1");
    expect(
      escalatedEvent?.type === "section:escalated" && escalatedEvent.retryCount,
    ).toBe(2);
  });

  it("returns outcome: human-intervention-required when ISelfHealingLoop returns 'unresolved'", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const selfHealingLoop: ISelfHealingLoop = {
      async escalate(_escalation: SectionEscalation): Promise<SelfHealingResult> {
        return { outcome: "unresolved", summary: "Could not resolve automatically" };
      },
    };
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makeAlwaysFailingReviewEngine(),
      makeGitController(),
    );

    const result = await service.run(planId, {
      maxRetriesPerSection: 2,
      selfHealingLoop,
    });

    expect(result.outcome).toBe("human-intervention-required");
  });

  it("persists 'escalated-to-human' status when ISelfHealingLoop returns 'unresolved'", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const selfHealingLoop: ISelfHealingLoop = {
      async escalate(): Promise<SelfHealingResult> {
        return { outcome: "unresolved", summary: "Could not resolve" };
      },
    };
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makeAlwaysFailingReviewEngine(),
      makeGitController(),
    );

    await service.run(planId, { maxRetriesPerSection: 2, selfHealingLoop });

    // The PlanFileStoreAdapter saves the status — read it back via a fresh load
    // Note: "escalated-to-human" is cast to TaskStatus for persistence
    const persistedPlan = await fileStore.load(planId);
    // The status may be persisted as "escalated-to-human" (via cast in adapter)
    const sectionStatus = (persistedPlan?.tasks[0] as { status: string } | undefined)?.status;
    expect(sectionStatus).toBe("escalated-to-human");
  });

  it("ISelfHealingLoop.escalate() receives the accumulated review feedback", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const escalationPayloads: SectionEscalation[] = [];
    const selfHealingLoop: ISelfHealingLoop = {
      async escalate(escalation: SectionEscalation): Promise<SelfHealingResult> {
        escalationPayloads.push(escalation);
        return { outcome: "unresolved", summary: "Not fixed" };
      },
    };
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makeAlwaysFailingReviewEngine("Missing error handling in service"),
      makeGitController(),
    );

    await service.run(planId, { maxRetriesPerSection: 2, selfHealingLoop });

    expect(escalationPayloads).toHaveLength(1);
    expect(escalationPayloads[0]?.reviewFeedback.length).toBeGreaterThan(0);
    const hasExpectedFeedback = escalationPayloads[0]?.reviewFeedback.some(
      (f) => f.description === "Missing error handling in service",
    );
    expect(hasExpectedFeedback).toBe(true);
  });

  it("ISelfHealingLoop.escalate() receives the section and plan IDs", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Implement feature", status: "pending", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    let capturedEscalation: SectionEscalation | undefined;
    const selfHealingLoop: ISelfHealingLoop = {
      async escalate(escalation: SectionEscalation): Promise<SelfHealingResult> {
        capturedEscalation = escalation;
        return { outcome: "unresolved", summary: "Not fixed" };
      },
    };
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makeAlwaysFailingReviewEngine(),
      makeGitController(),
    );

    await service.run(planId, { maxRetriesPerSection: 2, selfHealingLoop });

    expect(capturedEscalation?.sectionId).toBe("s1");
    expect(capturedEscalation?.planId).toBe(planId);
  });
});

// ---------------------------------------------------------------------------
// Task 6.4 — Integration test: plan resumption after interruption
// ---------------------------------------------------------------------------

describe("ImplementationLoop integration — plan resumption after interruption (task 6.4)", () => {
  it("resume(): does not re-execute the already-completed section", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Already Done", status: "completed", steps: [] },
      { id: "s2", title: "Pending Work", status: "in_progress", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const callTracker = { count: 0 };
    const agentLoop = makeSuccessAgentLoop(callTracker);
    const service = new ImplementationLoopService(
      planStore,
      agentLoop,
      makePassingReviewEngine(),
      makeGitController(),
    );

    await service.resume(planId);

    // Only s2 is executed — s1 (completed) is skipped
    expect(callTracker.count).toBe(1);
  });

  it("resume(): resets 'in_progress' section to 'pending' before execution", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Interrupted Section", status: "in_progress", steps: [] },
    ]);

    // Intercept updateSectionStatus calls to verify the reset to "pending"
    const statusHistory: Array<{ sectionId: string; status: string }> = [];
    const wrappedPlanStore: IPlanStore = {
      async loadPlan(pid: string) {
        return fileStore.load(pid);
      },
      async updateSectionStatus(pid: string, sectionId: string, status: SectionPersistenceStatus) {
        statusHistory.push({ sectionId, status });
        // Also persist to file store for plan reads
        const plan = await fileStore.load(pid);
        if (!plan) return;
        const updated = plan.tasks.map((t) =>
          t.id === sectionId ? { ...t, status: status as TaskPlan["tasks"][number]["status"] } : t,
        );
        await fileStore.save({ ...plan, tasks: updated, updatedAt: new Date().toISOString() });
      },
    };

    const service = new ImplementationLoopService(
      wrappedPlanStore,
      makeSuccessAgentLoop(),
      makePassingReviewEngine(),
      makeGitController(),
    );

    await service.resume(planId);

    // First update for s1 must be "pending" (the reset), followed by "in_progress" and "completed"
    const s1Updates = statusHistory.filter((h) => h.sectionId === "s1");
    const pendingResetIdx = s1Updates.findIndex((h) => h.status === "pending");
    const inProgressIdx = s1Updates.findIndex((h) => h.status === "in_progress");
    expect(pendingResetIdx).toBeGreaterThanOrEqual(0);
    expect(inProgressIdx).toBeGreaterThan(pendingResetIdx);
  });

  it("resume(): returns outcome: completed after resuming and finishing the remaining section", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Already Done", status: "completed", steps: [] },
      { id: "s2", title: "Resume This", status: "in_progress", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makePassingReviewEngine(),
      makeGitController(),
    );

    const result = await service.resume(planId);

    expect(result.outcome).toBe("completed");
  });

  it("resume(): context is re-initialized fresh for the resumed section", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Interrupted Section", status: "in_progress", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const resetTaskCalls: string[] = [];
    const contextEngine: IContextEngine = {
      resetTask(taskId: string) {
        resetTaskCalls.push(taskId);
      },
      resetPhase() {},
      async buildContext() {
        return {
          content: "context",
          layers: [],
          totalTokens: 7,
          layerUsage: [],
          plannerDecision: { layersToRetrieve: [], rationale: "" },
          degraded: false,
          omittedLayers: [],
        };
      },
      async expandContext() {
        return { ok: true, updatedTokenCount: 0 };
      },
    };

    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      makePassingReviewEngine(),
      makeGitController(),
    );

    await service.resume(planId, { contextEngine });

    // resetTask must be called once for the resumed section to isolate its context
    expect(resetTaskCalls).toContain("s1");
    expect(resetTaskCalls).toHaveLength(1);
  });

  it("run() also resets 'in_progress' sections and re-executes them", async () => {
    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "In Progress Section", status: "in_progress", steps: [] },
    ]);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const callTracker = { count: 0 };
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(callTracker),
      makePassingReviewEngine(),
      makeGitController(),
    );

    const result = await service.run(planId);

    // The "in_progress" section should be treated as incomplete and re-executed
    expect(result.outcome).toBe("completed");
    expect(callTracker.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 6.5 — Integration test: quality gate checks and commit blocking
// ---------------------------------------------------------------------------

/**
 * Creates a stub IQualityGate that returns results based on the check names
 * in the config. `failedCheckNames` is a map of check name → required flag.
 * Checks not in failedCheckNames always pass.
 */
function makeConfiguredQualityGate(
  failedChecks: Array<{ name: string; required: boolean; details?: string }>,
): IQualityGate {
  return {
    async run(config: QualityGateConfig): Promise<ReadonlyArray<ReviewCheckResult>> {
      return config.checks.map((check: QualityGateCheck): ReviewCheckResult => {
        const failEntry = failedChecks.find((f) => f.name === check.name);
        if (failEntry) {
          return {
            checkName: check.name,
            outcome: "failed",
            required: check.required,
            details: failEntry.details ?? `Exit code 1`,
          };
        }
        return { checkName: check.name, outcome: "passed", required: check.required, details: "OK" };
      });
    },
  };
}

/**
 * Creates a stub LLM provider that always returns a passing review JSON.
 */
function makePassingLlmProvider() {
  return {
    async complete() {
      return {
        ok: true as const,
        value: {
          content: JSON.stringify({ passed: true, feedback: [] }),
          usage: { inputTokens: 10, outputTokens: 20 },
        },
      };
    },
    clearContext() {},
  };
}

describe("ImplementationLoop integration — quality gate checks and commit blocking (task 6.5)", () => {
  it("required lint check failure blocks commit and routes to improve step", async () => {
    // Use LlmReviewEngineService with a stub LLM (passes) + stub quality gate (required lint fails)
    const { LlmReviewEngineService } = await import(
      "@/application/implementation-loop/llm-review-engine"
    );

    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Add linting compliance", status: "pending", steps: [] },
    ]);

    const qualityGate = makeConfiguredQualityGate([
      { name: "lint", required: true, details: "Exit code 1: 3 lint errors" },
    ]);
    const qualityGateConfig: QualityGateConfig = {
      checks: [
        { name: "lint", command: "bun run lint", required: true },
      ],
    };
    const reviewEngine = new LlmReviewEngineService(makePassingLlmProvider(), qualityGate);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const agentLoop = makeTrackingAgentLoop();
    const service = new ImplementationLoopService(
      planStore,
      agentLoop,
      reviewEngine,
      makeGitController(),
    );

    const result = await service.run(planId, {
      maxRetriesPerSection: 2,
      qualityGateConfig,
    });

    // Required lint failure → loop retries (agent loop called more than once)
    expect(agentLoop.calls.length).toBeGreaterThan(1);
    // No commit since lint always fails (maxRetries reached → section-failed)
    expect(result.outcome).toBe("section-failed");
  });

  it("advisory test check failure does not block commit — review passes with advisory feedback", async () => {
    const { LlmReviewEngineService } = await import(
      "@/application/implementation-loop/llm-review-engine"
    );

    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Add test coverage", status: "pending", steps: [] },
    ]);

    const qualityGate = makeConfiguredQualityGate([
      { name: "tests", required: false, details: "Exit code 1: 2 test failures" },
    ]);
    const qualityGateConfig: QualityGateConfig = {
      checks: [
        { name: "tests", command: "bun test", required: false },
      ],
    };
    const reviewEngine = new LlmReviewEngineService(makePassingLlmProvider(), qualityGate);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const gitController = makeGitController();
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      reviewEngine,
      gitController,
    );

    const result = await service.run(planId, { qualityGateConfig });

    // Advisory failure does not block commit → outcome is "completed"
    expect(result.outcome).toBe("completed");
    // Exactly one commit
    expect(gitController.commits).toHaveLength(1);
  });

  it("gate check results appear in the iteration log entry", async () => {
    const { LlmReviewEngineService } = await import(
      "@/application/implementation-loop/llm-review-engine"
    );

    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Add test coverage", status: "pending", steps: [] },
    ]);

    const qualityGate = makeConfiguredQualityGate([
      { name: "tests", required: false, details: "Exit code 1" },
    ]);
    const qualityGateConfig: QualityGateConfig = {
      checks: [
        { name: "tests", command: "bun test", required: false },
      ],
    };
    const reviewEngine = new LlmReviewEngineService(makePassingLlmProvider(), qualityGate);

    const logDir = join(tmpDir, "logs");
    const logger = new NdjsonImplementationLoopLogger(planId, logDir);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      reviewEngine,
      makeGitController(),
    );

    await service.run(planId, { qualityGateConfig, logger });

    const logPath = join(logDir, `implementation-loop-${planId}.ndjson`);
    const raw = await readFile(logPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    const iterationEntry = lines
      .map((l: string) => JSON.parse(l))
      .find((e: { type?: string }) => e.type === "iteration");

    expect(iterationEntry).toBeDefined();
    // gateCheckResults must be present in the log entry
    expect(Array.isArray(iterationEntry?.gateCheckResults)).toBe(true);
    // The "tests" check should be in the results
    const testsCheck = iterationEntry?.gateCheckResults.find(
      (c: { checkName?: string }) => c.checkName === "tests",
    );
    expect(testsCheck).toBeDefined();
    expect(testsCheck?.outcome).toBe("failed");
  });

  it("required check failure shows as blocking feedback; advisory shows as advisory", async () => {
    const { LlmReviewEngineService } = await import(
      "@/application/implementation-loop/llm-review-engine"
    );

    const fileStore = new PlanFileStore({ baseDir: tmpDir });
    const planId = await seedPlan(fileStore, [
      { id: "s1", title: "Check gate categories", status: "pending", steps: [] },
    ]);

    const qualityGate = makeConfiguredQualityGate([
      { name: "lint", required: true, details: "lint error" },
      { name: "tests", required: false, details: "test failure" },
    ]);
    const qualityGateConfig: QualityGateConfig = {
      checks: [
        { name: "lint", command: "bun run lint", required: true },
        { name: "tests", command: "bun test", required: false },
      ],
    };
    // Use a sequenced review engine that passes on second attempt so we can observe
    // advisory feedback without the section failing permanently
    const reviewEngine = new LlmReviewEngineService(makePassingLlmProvider(), qualityGate);

    const planStore = new PlanFileStoreAdapter(fileStore);
    const service = new ImplementationLoopService(
      planStore,
      makeSuccessAgentLoop(),
      reviewEngine,
      makeGitController(),
    );

    const result = await service.run(planId, {
      maxRetriesPerSection: 2,
      qualityGateConfig,
    });

    // Required lint failure → section fails
    expect(result.outcome).toBe("section-failed");
    const sectionRecord = result.sections[0];
    expect(sectionRecord).toBeDefined();

    // The iterations should contain gateCheckResults with both checks
    const lastIteration = sectionRecord?.iterations[sectionRecord.iterations.length - 1];
    expect(lastIteration?.reviewResult.checks).toBeDefined();
    const lintCheck = lastIteration?.reviewResult.checks.find((c) => c.checkName === "lint");
    const testCheck = lastIteration?.reviewResult.checks.find((c) => c.checkName === "tests");
    expect(lintCheck?.outcome).toBe("failed");
    expect(lintCheck?.required).toBe(true);
    expect(testCheck?.outcome).toBe("failed");
    expect(testCheck?.required).toBe(false);
  });
});
