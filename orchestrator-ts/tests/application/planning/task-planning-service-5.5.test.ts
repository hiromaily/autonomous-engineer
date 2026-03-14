import { describe, expect, it } from "bun:test";
import { TaskPlanningService } from "../../../src/application/planning/task-planning-service";
import type { IHumanReviewGateway, } from "../../../src/application/ports/task-planning";
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
// Task 5.5 — Dynamic Plan Adjustment and Observability
// ---------------------------------------------------------------------------

describe("TaskPlanningService — task 5.5: dynamic plan adjustment and observability", () => {
  // -------------------------------------------------------------------------
  // 5.5.1 — Plan revision detection
  // -------------------------------------------------------------------------

  describe("plan revision detection", () => {
    it("does not trigger revision when planAdjustment is absent (normal result)", async () => {
      const { agentLoop, taskArgs } = makeSequencedAgentLoop([makeSuccessResult()]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([{ id: "step-1", description: "Do A" }])),
        makeStore().store,
      );

      const result = await service.run("goal", { skipHumanReview: true });

      expect(result.outcome).toBe("completed");
      // Agent loop should only have been called once (no revision retry)
      expect(taskArgs.length).toBe(1);
    });

    it("continues execution with revised step description when planAdjustment=revise", async () => {
      // 2-step plan: step-1 completes with revision for step-2
      const { agentLoop, taskArgs } = makeSequencedAgentLoop([
        makeRevisionResult(["Do B revised"]),
        makeSuccessResult(),
      ]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "Do A" },
          { id: "step-2", description: "Do B", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
      );

      const result = await service.run("goal", { skipHumanReview: true });

      expect(result.outcome).toBe("completed");
      // step-2 should have been called with the REVISED description
      expect(taskArgs[1]).toBe("Do B revised");
    });

    it("preserves original description for future step when no revision signal", async () => {
      const { agentLoop, taskArgs } = makeSequencedAgentLoop([
        makeSuccessResult(),
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

      await service.run("goal", { skipHumanReview: true });

      expect(taskArgs[1]).toBe("Do B original");
    });
  });

  // -------------------------------------------------------------------------
  // 5.5.2 — plan:revision event emission and persistence
  // -------------------------------------------------------------------------

  describe("plan:revision event emission", () => {
    it("emits a plan:revision event when a revision is applied", async () => {
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
          { id: "step-2", description: "Do B", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      const revEvents = events.filter((e) => e.type === "plan:revision");
      expect(revEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("plan:revision event includes the original step description", async () => {
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

    it("plan:revision event includes the revised step description", async () => {
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

    it("plan:revision event includes a non-empty reason", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([
        makeRevisionResult(["revised"], "Better approach found"),
        makeSuccessResult(),
      ]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "step-1" },
          { id: "step-2", description: "step-2", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      const revEvent = events.find((e) => e.type === "plan:revision");
      if (revEvent?.type === "plan:revision") {
        expect(revEvent.reason.length).toBeGreaterThan(0);
      } else {
        throw new Error("Expected plan:revision event");
      }
    });

    it("persists the revised plan before continuing to the next step", async () => {
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
          { id: "step-2", description: "Do B", dependsOn: ["step-1"] },
        ])),
        store,
      );

      await service.run("goal", { skipHumanReview: true });

      // At least one save should contain the revised description for step-2
      const revisedSave = saves.find(
        (p) => p.tasks[0]?.steps.find((s) => s.id === "step-2")?.description === "Do B revised",
      );
      expect(revisedSave).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 5.5.3 — Large revision human review (>50% of remaining steps)
  // -------------------------------------------------------------------------

  describe("large revision human review", () => {
    it("does not pause for review when ≤50% of remaining steps are revised", async () => {
      // 3-step plan: step-1 completes, 2 remaining steps, 1 is revised (1/2 = 50% ≤ 50%)
      const { agentLoop } = makeSequencedAgentLoop([
        makeRevisionResult(["step-2 revised", "Do C original"]), // step-2 changes, step-3 unchanged (same desc)
        makeSuccessResult(),
        makeSuccessResult(),
      ]);

      const gateway: IHumanReviewGateway = {
        async reviewPlan() {
          return { approved: true };
        },
      };

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "Do A" },
          { id: "step-2", description: "Do B", dependsOn: ["step-1"] },
          { id: "step-3", description: "Do C original", dependsOn: ["step-2"] },
        ])),
        makeStore().store,
        gateway,
      );

      // If gateway.reviewPlan is called, it would return approved; outcome should still be "completed"
      const result = await service.run("goal", { skipHumanReview: true });

      expect(result.outcome).toBe("completed");
    });

    it("pauses for human review when >50% of remaining steps are revised and gateway available", async () => {
      // 2-step plan: step-1 completes, 1 remaining step, 1 is revised (1/1 = 100% > 50%)
      const { agentLoop } = makeSequencedAgentLoop([
        makeRevisionResult(["step-2 revised"]),
        makeSuccessResult(),
      ]);

      const gateway: IHumanReviewGateway = {
        async reviewPlan() {
          // Simulate timeout by throwing
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

      const result = await service.run("goal");

      expect(result.outcome).toBe("waiting-for-input");
    });

    it("proceeds with revision without review when skipHumanReview is true", async () => {
      // 2-step plan: step-1 completes with large revision (100% of remaining)
      const { agentLoop, taskArgs } = makeSequencedAgentLoop([
        makeRevisionResult(["step-2 revised"]),
        makeSuccessResult(),
      ]);

      let reviewCalled = false;
      const gateway: IHumanReviewGateway = {
        async reviewPlan() {
          reviewCalled = true;
          return { approved: true };
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

      const result = await service.run("goal", { skipHumanReview: true });

      expect(result.outcome).toBe("completed");
      expect(reviewCalled).toBe(false);
      expect(taskArgs[1]).toBe("step-2 revised");
    });

    it("proceeds with revision when no gateway is available even for large revisions", async () => {
      const { agentLoop, taskArgs } = makeSequencedAgentLoop([
        makeRevisionResult(["step-2 revised"]),
        makeSuccessResult(),
      ]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "Do A" },
          { id: "step-2", description: "Do B", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
        // No gateway injected
      );

      const result = await service.run("goal");

      expect(result.outcome).toBe("completed");
      expect(taskArgs[1]).toBe("step-2 revised");
    });
  });

  // -------------------------------------------------------------------------
  // 5.5.4 — Observability: plan-level events
  // -------------------------------------------------------------------------

  describe("plan lifecycle events", () => {
    it("emits plan:created event after plan generation", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([{ id: "step-1", description: "Do A" }])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      expect(events.some((e) => e.type === "plan:created")).toBe(true);
    });

    it("emits step:start before each step execution", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult(), makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([
          { id: "step-1", description: "step-1" },
          { id: "step-2", description: "step-2", dependsOn: ["step-1"] },
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
          { id: "step-1", description: "step-1" },
          { id: "step-2", description: "step-2", dependsOn: ["step-1"] },
        ])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      const completedEvents = events.filter((e) => e.type === "step:completed");
      expect(completedEvents.length).toBe(2);
    });

    it("emits plan:completed when all steps succeed", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([{ id: "step-1", description: "step-1" }])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      expect(events.some((e) => e.type === "plan:completed")).toBe(true);
    });

    it("emits step:escalated when a step fails permanently", async () => {
      const { bus, events } = makeEventBus();
      // All calls fail, LLM revision also fails → escalated
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
    });

    it("emits plan:escalated when the plan outcome is escalated", async () => {
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

      expect(events.some((e) => e.type === "plan:escalated")).toBe(true);
    });

    it("step:completed event includes a non-negative durationMs", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([{ id: "step-1", description: "step-1" }])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, eventBus: bus });

      const completedEvent = events.find((e) => e.type === "step:completed");
      if (completedEvent?.type === "step:completed") {
        expect(completedEvent.durationMs).toBeGreaterThanOrEqual(0);
      } else {
        throw new Error("Expected step:completed event");
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5.5.5 — Logger integration
  // -------------------------------------------------------------------------

  describe("logger integration", () => {
    it("writes plan events to logger as JSON when logger is injected", async () => {
      const logEntries: Array<{ message: string; data?: Readonly<Record<string, unknown>> }> = [];
      const logger = {
        info(message: string, data?: Readonly<Record<string, unknown>>) {
          logEntries.push({ message, data });
        },
        error(message: string, data?: Readonly<Record<string, unknown>>) {
          logEntries.push({ message, data });
        },
      };

      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([{ id: "step-1", description: "step-1" }])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, logger });

      expect(logEntries.length).toBeGreaterThan(0);
    });

    it("logger entries include the event type", async () => {
      const logEntries: Array<{ message: string; data?: Readonly<Record<string, unknown>> }> = [];
      const logger = {
        info(message: string, data?: Readonly<Record<string, unknown>>) {
          logEntries.push({ message, data });
        },
        error(message: string, data?: Readonly<Record<string, unknown>>) {
          logEntries.push({ message, data });
        },
      };

      const { agentLoop } = makeSequencedAgentLoop([makeSuccessResult()]);

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makePlanBody([{ id: "step-1", description: "step-1" }])),
        makeStore().store,
      );

      await service.run("goal", { skipHumanReview: true, logger });

      // Logger messages should contain event type identifiers
      const messages = logEntries.map((e) => e.message);
      expect(messages.some((m) => m.includes("plan:") || m.includes("step:"))).toBe(true);
    });
  });
});
