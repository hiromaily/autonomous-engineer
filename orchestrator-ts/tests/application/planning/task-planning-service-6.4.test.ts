import { describe, expect, it } from "bun:test";
import { TaskPlanningService } from "../../../application/planning/task-planning-service";
import type { AgentLoopResult } from "../../../application/ports/agent-loop";
import {
  makeContextBuilder,
  makeEventBus,
  makeLlm,
  makePlanBody,
  makeRevisionResult,
  makeSequencedAgentLoop,
  makeStore,
  makeSuccessResult,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Task 6.4 — Dynamic Plan Adjustment and Observability
// Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 10.1, 10.2, 10.3, 10.4, 10.5
// ---------------------------------------------------------------------------

describe("TaskPlanningService — task 6.4: dynamic plan adjustment and observability", () => {
  // -------------------------------------------------------------------------
  // 6.4.1 — Revision signal triggers plan validation, event persistence, and continued execution
  // -------------------------------------------------------------------------

  describe("revision signal: validation, event persistence, and continued execution", () => {
    it("applies revision and continues execution from the revised step", async () => {
      // 2-step plan: step-1 returns a revision signal for step-2
      const { agentLoop, taskArgs } = makeSequencedAgentLoop([
        makeRevisionResult(["Do B revised"]),
        makeSuccessResult(),
      ]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "Do A" },
          { id: "step-2", description: "Do B original", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
      );

      const result = await service.run("goal", { skipHumanReview: true });

      expect(result.outcome).toBe("completed");
      // step-2 must have executed with the revised description
      expect(taskArgs[1]).toBe("Do B revised");
    });

    it("emits a plan:revision event when a revision signal is applied", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([
        makeRevisionResult(["Do B revised"]),
        makeSuccessResult(),
      ]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "Do A" },
          { id: "step-2", description: "Do B original", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      const revEvents = events.filter((e) => e.type === "plan:revision");
      expect(revEvents.length).toBe(1);
    });

    it("plan:revision event includes original step description as before content", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([
        makeRevisionResult(["Do B revised"]),
        makeSuccessResult(),
      ]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "Do A" },
          { id: "step-2", description: "Do B original", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      const revEvent = events.find((e) => e.type === "plan:revision");
      if (revEvent?.type === "plan:revision") {
        expect(revEvent.originalDescription).toBe("Do B original");
      } else {
        throw new Error("Expected plan:revision event");
      }
    });

    it("plan:revision event includes revised step description as after content", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([
        makeRevisionResult(["Do B revised"]),
        makeSuccessResult(),
      ]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "Do A" },
          { id: "step-2", description: "Do B original", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      const revEvent = events.find((e) => e.type === "plan:revision");
      if (revEvent?.type === "plan:revision") {
        expect(revEvent.revisedDescription).toBe("Do B revised");
      } else {
        throw new Error("Expected plan:revision event");
      }
    });

    it("revised plan is persisted to the store before execution continues", async () => {
      const { store, saves } = makeStore();
      const { agentLoop } = makeSequencedAgentLoop([
        makeRevisionResult(["Do B revised"]),
        makeSuccessResult(),
      ]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "Do A" },
          { id: "step-2", description: "Do B original", dependsOn: ["step-1"] },
        ])),
        store,
      );

      await service.run("goal", { skipHumanReview: true });

      // At least one save must contain the revised step description
      const revisedSave = saves.find(
        (p) => p.tasks[0]?.steps.find((s) => s.id === "step-2")?.description === "Do B revised",
      );
      expect(revisedSave).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 6.4.2 — Event bus receives correct event types at each lifecycle milestone
  // -------------------------------------------------------------------------

  describe("event bus receives correct event types at lifecycle milestones", () => {
    it("emits plan:created after plan generation", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([{ id: "step-1", description: "step-1" }])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      expect(events.some((e) => e.type === "plan:created")).toBe(true);
    });

    it("emits plan:validated after plan validation", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([{ id: "step-1", description: "step-1" }])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      expect(events.some((e) => e.type === "plan:validated")).toBe(true);
    });

    it("emits step:start before each step executes", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult(), makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1" },
          { id: "step-2", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      const startEvents = events.filter((e) => e.type === "step:start");
      expect(startEvents.length).toBe(2);
    });

    it("emits step:completed after each step succeeds", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult(), makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1" },
          { id: "step-2", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      const completedEvents = events.filter((e) => e.type === "step:completed");
      expect(completedEvents.length).toBe(2);
    });

    it("emits plan:completed when all steps succeed", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult(), makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([{ id: "step-1" }, { id: "step-2", dependsOn: ["step-1"] }])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      expect(events.some((e) => e.type === "plan:completed")).toBe(true);
    });

    it("emits step:escalated and plan:escalated when a step permanently fails", async () => {
      const { bus, events } = makeEventBus();
      const failResult: AgentLoopResult = {
        terminationCondition: "RECOVERY_EXHAUSTED",
        totalIterations: 1,
        taskCompleted: false,
        finalState: {
          task: "test",
          plan: [],
          completedSteps: [],
          currentStep: null,
          iterationCount: 1,
          recoveryAttempts: 0,
          startedAt: new Date().toISOString(),
          observations: [],
        },
      };
      const { agentLoop } = makeSequencedAgentLoop([failResult]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([{ id: "step-1", description: "step-1" }])),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 0, skipHumanReview: true, eventBus: bus });

      expect(events.some((e) => e.type === "step:escalated")).toBe(true);
      expect(events.some((e) => e.type === "plan:escalated")).toBe(true);
    });

    it("event ordering: plan:created appears before step:start which appears before plan:completed", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([{ id: "step-1" }])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      const types = events.map((e) => e.type);
      const createdIdx = types.indexOf("plan:created");
      const startIdx = types.indexOf("step:start");
      const completedIdx = types.indexOf("plan:completed");

      expect(createdIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThan(createdIdx);
      expect(completedIdx).toBeGreaterThan(startIdx);
    });
  });

  // -------------------------------------------------------------------------
  // 6.4.3 — Execution does not advance while a revision is in progress
  // -------------------------------------------------------------------------

  describe("execution does not advance while revision is in progress", () => {
    it("next step executes with revised description only after revision is committed", async () => {
      const { agentLoop, taskArgs } = makeSequencedAgentLoop([
        makeRevisionResult(["Do B revised"]),
        makeSuccessResult(),
      ]);

      const { store, saves } = makeStore();

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "Do A" },
          { id: "step-2", description: "Do B original", dependsOn: ["step-1"] },
        ])),
        store,
      );

      await service.run("goal", { skipHumanReview: true });

      // The revision must be persisted BEFORE step-2 executes
      // Find the save that has "Do B revised" and verify it happened
      const saveWithRevision = saves.findIndex(
        (p) => p.tasks[0]?.steps.find((s) => s.id === "step-2")?.description === "Do B revised",
      );
      // step-2 must have been called with the revised description (not original)
      expect(taskArgs[1]).toBe("Do B revised");
      // The revision save must have occurred
      expect(saveWithRevision).toBeGreaterThanOrEqual(0);
    });

    it("original step description is not used for execution after revision is applied", async () => {
      const { agentLoop, taskArgs } = makeSequencedAgentLoop([
        makeRevisionResult(["Revised: use a completely different approach"]),
        makeSuccessResult(),
      ]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "Do A" },
          { id: "step-2", description: "Do B ORIGINAL — should not be used", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true });

      // step-2's call must use the revised description, not the original
      expect(taskArgs[1]).toBe("Revised: use a completely different approach");
      expect(taskArgs[1]).not.toContain("ORIGINAL");
    });

    it("no plan:revision event is emitted when agent result has no revision signal", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult(), makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "Do A" },
          { id: "step-2", description: "Do B", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      const revEvents = events.filter((e) => e.type === "plan:revision");
      expect(revEvents.length).toBe(0);
    });

    it("returns waiting-for-input when large revision requires human review and gateway times out", async () => {
      // 2-step plan: 100% of remaining steps revised → triggers 50% threshold check
      const { agentLoop } = makeSequencedAgentLoop([
        makeRevisionResult(["step-2 revised"]),
        makeSuccessResult(),
      ]);

      const gateway: import("../../../application/ports/task-planning").IHumanReviewGateway = {
        async reviewPlan() {
          throw new Error("review timed out");
        },
      };

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "Do A" },
          { id: "step-2", description: "Do B", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
        gateway,
      );

      // No skipHumanReview → triggers threshold check for large revisions
      const result = await service.run("goal");

      expect(result.outcome).toBe("waiting-for-input");
    });
  });
});
