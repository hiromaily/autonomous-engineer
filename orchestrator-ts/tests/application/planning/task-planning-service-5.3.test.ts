import { describe, expect, it } from "bun:test";
import { TaskPlanningService } from "../../../src/application/planning/task-planning-service";
import type { AgentLoopOptions, AgentLoopResult, IAgentLoop } from "../../../src/application/ports/agent-loop";
import type { ITaskPlanStore } from "../../../src/application/ports/task-planning";
import type { AgentState } from "../../../src/domain/agent/types";
import type { TaskPlan } from "../../../src/domain/planning/types";
import { makeContextBuilder, makeLlm, makePlanBody, makeTrackingStore } from "./fixtures";

// ---------------------------------------------------------------------------
// Test helpers (5.3-specific)
// ---------------------------------------------------------------------------

/**
 * Builds a controllable agent loop.
 * `resultsByCall` maps call-index → taskCompleted (true = success, false = failure).
 * Any call index not in the map defaults to `defaultResult` (true = success).
 */
function makeControllableAgentLoop(
  resultsByCall: Map<number, boolean> = new Map(),
  defaultResult = true,
): { agentLoop: IAgentLoop; taskArgs: string[] } {
  const taskArgs: string[] = [];
  let callIndex = 0;

  const agentLoop: IAgentLoop = {
    async run(task: string, _options?: Partial<AgentLoopOptions>): Promise<AgentLoopResult> {
      taskArgs.push(task);
      const taskCompleted = resultsByCall.has(callIndex)
        ? (resultsByCall.get(callIndex) ?? defaultResult)
        : defaultResult;
      callIndex++;
      return {
        terminationCondition: taskCompleted ? "TASK_COMPLETED" : "MAX_ITERATIONS",
        finalState: {} as AgentState,
        totalIterations: 1,
        taskCompleted,
      };
    },
    stop() {},
    getState() {
      return null;
    },
  };
  return { agentLoop, taskArgs };
}

// ---------------------------------------------------------------------------
// Task 5.3 — Step Execution Loop
// ---------------------------------------------------------------------------

describe("TaskPlanningService — task 5.3: step execution loop", () => {
  // -------------------------------------------------------------------------
  // 5.3.1 — Single-step happy path
  // -------------------------------------------------------------------------

  describe("single-step execution", () => {
    it("returns completed outcome when the single step succeeds", async () => {
      const { agentLoop } = makeControllableAgentLoop();
      const { store } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.outcome).toBe("completed");
    });

    it("step status transitions to completed in the returned plan", async () => {
      const { agentLoop } = makeControllableAgentLoop();
      const { store } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      const step = result.plan.tasks[0]?.steps[0];
      expect(step?.status).toBe("completed");
    });

    it("statusHistory records the completed transition", async () => {
      const { agentLoop } = makeControllableAgentLoop();
      const { store } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      const step = result.plan.tasks[0]?.steps[0];
      const completedEntry = step?.statusHistory.find((e) => e.status === "completed");
      expect(completedEntry).toBeDefined();
    });

    it("task status is completed when all its steps complete", async () => {
      const { agentLoop } = makeControllableAgentLoop();
      const { store } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.plan.tasks[0]?.status).toBe("completed");
    });

    it("passes the step description to agentLoop.run()", async () => {
      const { agentLoop, taskArgs } = makeControllableAgentLoop();
      const { store } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1", description: "Run the build pipeline" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal");

      expect(taskArgs[0]).toBe("Run the build pipeline");
    });
  });

  // -------------------------------------------------------------------------
  // 5.3.2 — Multi-step execution with dependencies
  // -------------------------------------------------------------------------

  describe("multi-step execution", () => {
    it("executes two sequential steps in topological order", async () => {
      const { agentLoop, taskArgs } = makeControllableAgentLoop();
      const { store } = makeTrackingStore();
      const llm = makeLlm(
        makePlanBody([
          { id: "step-1", description: "First step" },
          { id: "step-2", description: "Second step", dependsOn: ["step-1"] },
        ]),
      );

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      expect(result.outcome).toBe("completed");
      expect(taskArgs[0]).toBe("First step");
      expect(taskArgs[1]).toBe("Second step");
    });

    it("all steps are completed in the returned plan", async () => {
      const { agentLoop } = makeControllableAgentLoop();
      const { store } = makeTrackingStore();
      const llm = makeLlm(
        makePlanBody([
          { id: "step-1" },
          { id: "step-2", dependsOn: ["step-1"] },
        ]),
      );

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      const steps = result.plan.tasks[0]?.steps ?? [];
      expect(steps.every((s) => s.status === "completed")).toBe(true);
    });

    it("executes step-1 before step-2 regardless of order in plan", async () => {
      const { agentLoop, taskArgs } = makeControllableAgentLoop();
      const { store } = makeTrackingStore();
      // step-2 listed first in the plan body but depends on step-1
      const llm = makeLlm(
        makePlanBody([
          { id: "step-2", description: "Second step", dependsOn: ["step-1"] },
          { id: "step-1", description: "First step" },
        ]),
      );

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal");

      // step-1 must execute before step-2
      const step1Idx = taskArgs.indexOf("First step");
      const step2Idx = taskArgs.indexOf("Second step");
      expect(step1Idx).toBeLessThan(step2Idx);
    });
  });

  // -------------------------------------------------------------------------
  // 5.3.3 — Persistence: save before and after each step
  // -------------------------------------------------------------------------

  describe("persistence at step boundaries", () => {
    it("saves the plan with step in_progress before invoking the agent loop", async () => {
      let savedBeforeAgentLoop: TaskPlan | null = null;
      let agentLoopCallCount = 0;

      const agentLoop: IAgentLoop = {
        async run(): Promise<AgentLoopResult> {
          // Capture the most recent saved plan at the moment of agent loop invocation
          savedBeforeAgentLoop = JSON.parse(
            JSON.stringify(snapshots[snapshots.length - 1]),
          ) as TaskPlan;
          agentLoopCallCount++;
          return {
            terminationCondition: "TASK_COMPLETED",
            finalState: {} as AgentState,
            totalIterations: 1,
            taskCompleted: true,
          };
        },
        stop() {},
        getState() {
          return null;
        },
      };

      const snapshots: TaskPlan[] = [];
      const store: ITaskPlanStore = {
        async save(plan) {
          snapshots.push(JSON.parse(JSON.stringify(plan)) as TaskPlan);
        },
        async load() {
          return null;
        },
        async listResumable() {
          return [];
        },
      };

      const llm = makeLlm(makePlanBody([{ id: "step-1" }]));
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal");

      expect(agentLoopCallCount).toBe(1);
      // The snapshot saved before agent loop must show step-1 as in_progress
      const step = savedBeforeAgentLoop?.tasks[0]?.steps[0];
      expect(step?.status).toBe("in_progress");
    });

    it("saves the plan with step completed after successful agent loop", async () => {
      const { agentLoop } = makeControllableAgentLoop();
      const { store, snapshots } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal");

      // Last snapshot should show step-1 as completed
      const lastSnapshot = snapshots[snapshots.length - 1];
      const step = lastSnapshot?.tasks[0]?.steps[0];
      expect(step?.status).toBe("completed");
    });

    it("saves after each step (2 extra saves for 2 steps: in_progress + completed each)", async () => {
      const { agentLoop } = makeControllableAgentLoop();
      const { store, snapshots } = makeTrackingStore();
      const llm = makeLlm(
        makePlanBody([
          { id: "step-1" },
          { id: "step-2", dependsOn: ["step-1"] },
        ]),
      );

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal");

      // 1 initial save + 2 saves per step × 2 steps = 5 saves total
      expect(snapshots.length).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // 5.3.4 — Step failure
  // -------------------------------------------------------------------------

  describe("step failure handling", () => {
    it("returns escalated outcome when a step fails (agent loop returns taskCompleted: false)", async () => {
      // Step 1 fails; maxStepRetries:0 disables retry/revision so failure is immediate
      const failures = new Map([[0, false]]);
      const { agentLoop } = makeControllableAgentLoop(failures);
      const { store } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { maxStepRetries: 0 });

      expect(result.outcome).toBe("escalated");
    });

    it("includes the failed step ID in the escalated result", async () => {
      const failures = new Map([[0, false]]);
      const { agentLoop } = makeControllableAgentLoop(failures);
      const { store } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { maxStepRetries: 0 });

      expect(result.failedStepId).toBe("step-1");
    });

    it("marks the failed step as 'failed' in the returned plan", async () => {
      const failures = new Map([[0, false]]);
      const { agentLoop } = makeControllableAgentLoop(failures);
      const { store } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { maxStepRetries: 0 });

      const step = result.plan.tasks[0]?.steps[0];
      expect(step?.status).toBe("failed");
    });

    it("marks the task as 'failed' when a step fails", async () => {
      const failures = new Map([[0, false]]);
      const { agentLoop } = makeControllableAgentLoop(failures);
      const { store } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { maxStepRetries: 0 });

      expect(result.plan.tasks[0]?.status).toBe("failed");
    });

    it("persists the plan with the step in failed status after failure", async () => {
      const failures = new Map([[0, false]]);
      const { agentLoop } = makeControllableAgentLoop(failures);
      const { store, snapshots } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal", { maxStepRetries: 0 });

      const lastSnapshot = snapshots[snapshots.length - 1];
      const step = lastSnapshot?.tasks[0]?.steps[0];
      expect(step?.status).toBe("failed");
    });
  });

  // -------------------------------------------------------------------------
  // 5.3.5 — Cascade fail when dependency is failed
  // -------------------------------------------------------------------------

  describe("cascade fail on dependency failure", () => {
    it("cascade-fails a dependent step when its dependency fails", async () => {
      // step-1 fails, step-2 depends on step-1; maxStepRetries:0 prevents retries
      const failures = new Map([[0, false]]); // first AL call (step-1) fails
      const { agentLoop, taskArgs: _taskArgs } = makeControllableAgentLoop(failures);
      const { store } = makeTrackingStore();
      const llm = makeLlm(
        makePlanBody([
          { id: "step-1", description: "step-1" },
          { id: "step-2", description: "step-2", dependsOn: ["step-1"] },
        ]),
      );

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { maxStepRetries: 0 });

      // step-2 should be failed
      const step2 = result.plan.tasks[0]?.steps.find((s) => s.id === "step-2");
      expect(step2?.status).toBe("failed");
    });

    it("does NOT invoke the agent loop for cascade-failed steps", async () => {
      // step-1 fails, step-2 depends on step-1; maxStepRetries:0 prevents retries
      const failures = new Map([[0, false]]);
      const { agentLoop, taskArgs } = makeControllableAgentLoop(failures);
      const { store } = makeTrackingStore();
      const llm = makeLlm(
        makePlanBody([
          { id: "step-1", description: "step-1" },
          { id: "step-2", description: "step-2", dependsOn: ["step-1"] },
        ]),
      );

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal", { maxStepRetries: 0 });

      // Agent loop called only once (for step-1), not for step-2
      expect(taskArgs.length).toBe(1);
      expect(taskArgs[0]).toBe("step-1");
    });

    it("returns escalated with the first failed step ID when cascading", async () => {
      const failures = new Map([[0, false]]);
      const { agentLoop } = makeControllableAgentLoop(failures);
      const { store } = makeTrackingStore();
      const llm = makeLlm(
        makePlanBody([
          { id: "step-1" },
          { id: "step-2", dependsOn: ["step-1"] },
        ]),
      );

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { maxStepRetries: 0 });

      expect(result.outcome).toBe("escalated");
      expect(result.failedStepId).toBe("step-1");
    });

    it("cascade-fail propagates transitively (A fails → B fails → C fails)", async () => {
      // A → B → C (A fails); maxStepRetries:0 prevents retries
      const failures = new Map([[0, false]]);
      const { agentLoop } = makeControllableAgentLoop(failures);
      const { store } = makeTrackingStore();
      const llm = makeLlm(
        makePlanBody([
          { id: "step-a", description: "step-a" },
          { id: "step-b", description: "step-b", dependsOn: ["step-a"] },
          { id: "step-c", description: "step-c", dependsOn: ["step-b"] },
        ]),
      );

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal", { maxStepRetries: 0 });

      const steps = result.plan.tasks[0]?.steps ?? [];
      expect(steps.find((s) => s.id === "step-a")?.status).toBe("failed");
      expect(steps.find((s) => s.id === "step-b")?.status).toBe("failed");
      expect(steps.find((s) => s.id === "step-c")?.status).toBe("failed");
    });

    it("completes independent steps even after another step fails (no dependency)", async () => {
      // step-1 fails, step-2 has no dependency on step-1
      const failures = new Map([[0, false]]);
      const { agentLoop } = makeControllableAgentLoop(failures);
      const { store } = makeTrackingStore();
      const llm = makeLlm(
        makePlanBody([
          { id: "step-1", description: "failing step" },
          { id: "step-2", description: "independent step" }, // no dependsOn
        ]),
      );

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      const result = await service.run("goal");

      const step2 = result.plan.tasks[0]?.steps.find((s) => s.id === "step-2");
      expect(step2?.status).toBe("completed");
    });
  });

  // -------------------------------------------------------------------------
  // 5.3.6 — Stop signal
  // -------------------------------------------------------------------------

  describe("stop signal", () => {
    it("halts execution after current step when stop() is called", async () => {
      let serviceRef: TaskPlanningService | undefined;
      const taskArgs: string[] = [];

      const agentLoop: IAgentLoop = {
        async run(task: string): Promise<AgentLoopResult> {
          taskArgs.push(task);
          if (task === "step-1") {
            // Signal stop during step-1 execution
            serviceRef?.stop();
          }
          return {
            terminationCondition: "TASK_COMPLETED",
            finalState: {} as AgentState,
            totalIterations: 1,
            taskCompleted: true,
          };
        },
        stop() {},
        getState() {
          return null;
        },
      };

      const { store } = makeTrackingStore();
      const llm = makeLlm(
        makePlanBody([
          { id: "step-1", description: "step-1" },
          { id: "step-2", description: "step-2", dependsOn: ["step-1"] },
        ]),
      );

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      serviceRef = service;

      await service.run("goal");

      // Only step-1 should have been executed
      expect(taskArgs).toContain("step-1");
      expect(taskArgs).not.toContain("step-2");
    });

    it("returns a result (not hanging) even after stop", async () => {
      let serviceRef: TaskPlanningService | undefined;

      const agentLoop: IAgentLoop = {
        async run(): Promise<AgentLoopResult> {
          serviceRef?.stop();
          return {
            terminationCondition: "TASK_COMPLETED",
            finalState: {} as AgentState,
            totalIterations: 1,
            taskCompleted: true,
          };
        },
        stop() {},
        getState() {
          return null;
        },
      };

      const { store } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1" }, { id: "step-2" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      serviceRef = service;

      await expect(service.run("goal")).resolves.toBeDefined();
    });

    it("stop() does not affect the next run() call", async () => {
      const { agentLoop } = makeControllableAgentLoop();
      const { store } = makeTrackingStore();
      const llm1 = makeLlm(makePlanBody([{ id: "step-1" }]));

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(
          makePlanBody([{ id: "step-1" }]),
        ),
        store,
      );

      // First run: stop before
      service.stop();
      void llm1; // suppress unused warning

      // Second run should proceed normally
      const result = await service.run("goal");
      expect(result.outcome).toBe("completed");
    });
  });

  // -------------------------------------------------------------------------
  // 5.3.7 — At most one step in_progress at a time
  // -------------------------------------------------------------------------

  describe("at most one step in_progress at a time", () => {
    it("never has two steps in_progress simultaneously in persisted snapshots", async () => {
      const { agentLoop } = makeControllableAgentLoop();
      const { store, snapshots } = makeTrackingStore();
      const llm = makeLlm(
        makePlanBody([
          { id: "step-1" },
          { id: "step-2", dependsOn: ["step-1"] },
        ]),
      );

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal");

      // For every snapshot, at most one step should be in_progress
      for (const snapshot of snapshots) {
        const inProgressCount = snapshot.tasks
          .flatMap((t) => t.steps)
          .filter((s) => s.status === "in_progress").length;
        expect(inProgressCount).toBeLessThanOrEqual(1);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5.3.8 — agentLoopOptions forwarding
  // -------------------------------------------------------------------------

  describe("agentLoopOptions forwarding", () => {
    it("passes agentLoopOptions to each agentLoop.run() call", async () => {
      let capturedOptions: Partial<AgentLoopOptions> | undefined;

      const agentLoop: IAgentLoop = {
        async run(_task, options): Promise<AgentLoopResult> {
          capturedOptions = options;
          return {
            terminationCondition: "TASK_COMPLETED",
            finalState: {} as AgentState,
            totalIterations: 1,
            taskCompleted: true,
          };
        },
        stop() {},
        getState() {
          return null;
        },
      };

      const { store } = makeTrackingStore();
      const llm = makeLlm(makePlanBody([{ id: "step-1" }]));

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);
      await service.run("goal", { agentLoopOptions: { maxIterations: 25 } });

      expect(capturedOptions?.maxIterations).toBe(25);
    });
  });
});
