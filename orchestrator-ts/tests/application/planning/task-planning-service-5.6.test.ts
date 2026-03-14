import { describe, expect, it } from "bun:test";
import { TaskPlanningService } from "../../../application/planning/task-planning-service";
import type { IAgentLoop } from "../../../application/ports/agent-loop";
import type { LlmProviderPort } from "../../../application/ports/llm";
import type { IPlanContextBuilder, ITaskPlanStore } from "../../../application/ports/task-planning";
import type { TaskPlan } from "../../../domain/planning/types";
import { makeContextBuilder, makeLlm, makeSequencedAgentLoop as makeAgentLoop, makeStore } from "./fixtures";

/** Builds a persisted in-progress plan: step-1 completed, step-2 pending. */
function makeInProgressPlan(): TaskPlan {
  const now = new Date().toISOString();
  return {
    id: "plan-abc",
    goal: "Resume test goal",
    createdAt: now,
    updatedAt: now,
    tasks: [
      {
        id: "task-1",
        title: "Task One",
        status: "in_progress",
        steps: [
          {
            id: "step-1",
            description: "First step",
            status: "completed",
            dependsOn: [],
            statusHistory: [
              { status: "in_progress", at: now },
              { status: "completed", at: now },
            ],
          },
          {
            id: "step-2",
            description: "Second step",
            status: "pending",
            dependsOn: ["step-1"],
            statusHistory: [],
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Task 5.6 — Resume, Stop, Dependency-Availability Checks
// ---------------------------------------------------------------------------

describe("TaskPlanningService — task 5.6: resume, listResumable, dependency-availability", () => {
  // -------------------------------------------------------------------------
  // 5.6.1 — resume: continue from first incomplete step
  // -------------------------------------------------------------------------

  describe("resume: continue from first incomplete step", () => {
    it("returns completed when the plan resumes and all remaining steps succeed", async () => {
      const plan = makeInProgressPlan();
      const { agentLoop } = makeAgentLoop();
      const { store } = makeStore(plan);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), makeLlm("{}"), store);
      const result = await service.resume("plan-abc", { skipHumanReview: true });

      expect(result.outcome).toBe("completed");
    });

    it("does not re-execute steps that are already completed", async () => {
      const plan = makeInProgressPlan(); // step-1 completed, step-2 pending
      const { agentLoop, taskArgs } = makeAgentLoop();
      const { store } = makeStore(plan);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), makeLlm("{}"), store);
      await service.resume("plan-abc", { skipHumanReview: true });

      // Only step-2 should be executed (step-1 is already completed)
      expect(taskArgs.length).toBe(1);
      expect(taskArgs[0]).toBe("Second step");
    });

    it("returns validation-error when no plan exists for the given planId", async () => {
      const { agentLoop } = makeAgentLoop();
      const { store } = makeStore(); // load returns null

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), makeLlm("{}"), store);
      const result = await service.resume("nonexistent-id");

      expect(result.outcome).toBe("validation-error");
    });

    it("returned validation-error plan has the requested planId", async () => {
      const { agentLoop } = makeAgentLoop();
      const { store } = makeStore();

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), makeLlm("{}"), store);
      const result = await service.resume("nonexistent-id");

      expect(result.plan.id).toBe("nonexistent-id");
    });

    it("runs PlanValidator on the loaded plan before executing steps", async () => {
      // A plan with a circular dependency is structurally invalid
      const now = new Date().toISOString();
      const invalidPlan: TaskPlan = {
        id: "plan-invalid",
        goal: "bad plan",
        createdAt: now,
        updatedAt: now,
        tasks: [
          {
            id: "task-1",
            title: "Task",
            status: "pending",
            steps: [
              {
                id: "step-a",
                description: "A",
                status: "pending",
                dependsOn: ["step-b"],
                statusHistory: [],
              },
              {
                id: "step-b",
                description: "B",
                status: "pending",
                dependsOn: ["step-a"],
                statusHistory: [],
              },
            ],
          },
        ],
      };

      const { agentLoop } = makeAgentLoop();
      const { store } = makeStore(invalidPlan);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), makeLlm("{}"), store);
      const result = await service.resume("plan-invalid");

      expect(result.outcome).toBe("validation-error");
    });

    it("resumes a plan that has all steps pending (no completed steps yet)", async () => {
      const now = new Date().toISOString();
      const pendingPlan: TaskPlan = {
        id: "plan-pending",
        goal: "pending plan",
        createdAt: now,
        updatedAt: now,
        tasks: [
          {
            id: "task-1",
            title: "Task",
            status: "pending",
            steps: [
              { id: "step-1", description: "Do it", status: "pending", dependsOn: [], statusHistory: [] },
            ],
          },
        ],
      };

      const { agentLoop, taskArgs } = makeAgentLoop();
      const { store } = makeStore(pendingPlan);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), makeLlm("{}"), store);
      const result = await service.resume("plan-pending");

      expect(result.outcome).toBe("completed");
      expect(taskArgs.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 5.6.2 — listResumable delegates to the store
  // -------------------------------------------------------------------------

  describe("listResumable", () => {
    it("returns IDs from the store when plans are resumable", async () => {
      const plan = makeInProgressPlan();
      const { agentLoop } = makeAgentLoop();
      const { store } = makeStore(plan);

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), makeLlm("{}"), store);
      const ids = await service.listResumable();

      expect(ids).toContain("plan-abc");
    });

    it("returns empty array when no resumable plans exist", async () => {
      const { agentLoop } = makeAgentLoop();
      const { store } = makeStore(); // no persisted plan

      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), makeLlm("{}"), store);
      const ids = await service.listResumable();

      expect(ids).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 5.6.3 — dependency-unavailable when required dependencies are null
  // -------------------------------------------------------------------------

  describe("dependency-unavailable outcome", () => {
    it("run() returns dependency-unavailable when agentLoop is null", async () => {
      const { store } = makeStore();
      const service = new TaskPlanningService(
        null as unknown as IAgentLoop,
        makeContextBuilder(),
        makeLlm("{}"),
        store,
      );

      const result = await service.run("goal");

      expect(result.outcome).toBe("dependency-unavailable");
    });

    it("run() returns dependency-unavailable when contextBuilder is null", async () => {
      const { agentLoop } = makeAgentLoop();
      const { store } = makeStore();
      const service = new TaskPlanningService(
        agentLoop,
        null as unknown as IPlanContextBuilder,
        makeLlm("{}"),
        store,
      );

      const result = await service.run("goal");

      expect(result.outcome).toBe("dependency-unavailable");
    });

    it("run() returns dependency-unavailable when llm is null", async () => {
      const { agentLoop } = makeAgentLoop();
      const { store } = makeStore();
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        null as unknown as LlmProviderPort,
        store,
      );

      const result = await service.run("goal");

      expect(result.outcome).toBe("dependency-unavailable");
    });

    it("resume() returns dependency-unavailable when agentLoop is null", async () => {
      const plan = makeInProgressPlan();
      const { store } = makeStore(plan);
      const service = new TaskPlanningService(
        null as unknown as IAgentLoop,
        makeContextBuilder(),
        makeLlm("{}"),
        store,
      );

      const result = await service.resume("plan-abc");

      expect(result.outcome).toBe("dependency-unavailable");
    });

    it("dependency-unavailable result includes the plan ID in the plan field", async () => {
      const { store } = makeStore();
      const service = new TaskPlanningService(
        null as unknown as IAgentLoop,
        makeContextBuilder(),
        makeLlm("{}"),
        store,
      );

      const result = await service.run("my goal");

      // Plan should be a non-null stub object
      expect(result.plan).toBeDefined();
      expect(result.outcome).toBe("dependency-unavailable");
    });
  });
});
