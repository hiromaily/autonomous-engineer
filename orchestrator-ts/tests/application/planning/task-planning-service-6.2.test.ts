import { describe, expect, it } from "bun:test";
import { TaskPlanningService } from "../../../application/planning/task-planning-service";
import type { IHumanReviewGateway, PlanReviewDecision } from "../../../application/ports/task-planning";
import {
  makeAgentLoop,
  makeContextBuilder,
  makeEventBus,
  makeLargePlanBody,
  makeLlmFromResults,
  makePlanBody,
  makeStore,
  makeSuccessLlmResult,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Task 6.2 — Human Review Gate Behavior
// Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
// ---------------------------------------------------------------------------

describe("TaskPlanningService — task 6.2: human review gate behavior", () => {
  // -------------------------------------------------------------------------
  // 6.2.1 — Gate activates when step count exceeds the configured threshold
  // -------------------------------------------------------------------------

  describe("gate activation on large plans", () => {
    it("activates the gate when step count exceeds maxAutoApproveSteps", async () => {
      let gateInvoked = false;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          gateInvoked = true;
          return { approved: true };
        },
      };

      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(11))]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store, reviewGateway);

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(gateInvoked).toBe(true);
    });

    it("does not activate the gate when step count is at or below the threshold", async () => {
      let gateInvoked = false;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          gateInvoked = true;
          return { approved: true };
        },
      };

      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      // Exactly 10 steps = at threshold → gate should NOT activate
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(10))]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store, reviewGateway);

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(gateInvoked).toBe(false);
    });

    it("activates the gate for high-risk keywords even when plan is small", async () => {
      let gateInvoked = false;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          gateInvoked = true;
          return { approved: true };
        },
      };

      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const highRiskBody = makePlanBody([
        { id: "step-1", description: "Delete all old records from the production database" },
      ]);
      const llm = makeLlmFromResults([makeSuccessLlmResult(highRiskBody)]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store, reviewGateway);

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(gateInvoked).toBe(true);
    });

    it("passes the plan to the gateway with the correct planId", async () => {
      let capturedPlanId: string | undefined;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(plan): Promise<PlanReviewDecision> {
          capturedPlanId = plan.id;
          return { approved: true };
        },
      };

      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(11))]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store, reviewGateway);

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(capturedPlanId).toBe(result.plan.id);
    });
  });

  // -------------------------------------------------------------------------
  // 6.2.2 — Gate is bypassed when skip-review flag is true
  // -------------------------------------------------------------------------

  describe("skip-review flag bypasses the gate", () => {
    it("bypasses the gate when skipHumanReview is true, even for large plans", async () => {
      let gateInvoked = false;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          gateInvoked = true;
          return { approved: true };
        },
      };

      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(20))]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store, reviewGateway);

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: true });

      expect(gateInvoked).toBe(false);
      expect(result.outcome).toBe("completed");
    });

    it("returns completed outcome when skipHumanReview is true and plan is large", async () => {
      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);

      // No gateway injected: always bypasses review
      const result = await service.run("goal", { maxAutoApproveSteps: 10 });

      expect(result.outcome).toBe("completed");
    });
  });

  // -------------------------------------------------------------------------
  // 6.2.3 — Rejection with feedback triggers one plan revision and re-presentation
  // -------------------------------------------------------------------------

  describe("rejection with feedback — one revision pass", () => {
    it("calls the gateway a second time after rejection with feedback", async () => {
      let reviewCallCount = 0;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          reviewCallCount++;
          if (reviewCallCount === 1) return { approved: false, feedback: "needs more steps" };
          return { approved: true };
        },
      };

      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(makeLargePlanBody(15)),
        makeSuccessLlmResult(makeLargePlanBody(15)),
      ]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store, reviewGateway);

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(reviewCallCount).toBe(2);
      expect(result.outcome).toBe("completed");
    });

    it("incorporates feedback in the LLM revision prompt", async () => {
      let capturedGoal: string | undefined;
      const captureContextBuilder = {
        async buildPlanContext(goal: string) {
          capturedGoal = goal;
          return "context";
        },
        async buildRevisionContext() {
          return "revision context";
        },
      };

      let reviewCallCount = 0;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          reviewCallCount++;
          if (reviewCallCount === 1) return { approved: false, feedback: "include error handling steps" };
          return { approved: true };
        },
      };

      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(makeLargePlanBody(15)),
        makeSuccessLlmResult(makeLargePlanBody(15)),
      ]);
      const service = new TaskPlanningService(
        agentLoop, captureContextBuilder, llm, store, reviewGateway,
      );

      await service.run("my goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      // The second buildPlanContext call should include the feedback
      expect(capturedGoal).toContain("include error handling steps");
    });

    it("calls the gateway exactly twice (initial + one revision pass)", async () => {
      let reviewCallCount = 0;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          reviewCallCount++;
          return { approved: false, feedback: "not good" };
        },
      };

      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(makeLargePlanBody(15)),
        makeSuccessLlmResult(makeLargePlanBody(15)),
      ]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store, reviewGateway);

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(reviewCallCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 6.2.4 — Double rejection returns human-rejected outcome
  // -------------------------------------------------------------------------

  describe("double rejection returns human-rejected", () => {
    it("returns human-rejected when both the original and revised plans are rejected", async () => {
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          return { approved: false, feedback: "still not acceptable" };
        },
      };

      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(makeLargePlanBody(15)),
        makeSuccessLlmResult(makeLargePlanBody(15)),
      ]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store, reviewGateway);

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(result.outcome).toBe("human-rejected");
    });

    it("human-rejected result includes the plan", async () => {
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          return { approved: false, feedback: "rejected" };
        },
      };

      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(makeLargePlanBody(15)),
        makeSuccessLlmResult(makeLargePlanBody(15)),
      ]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store, reviewGateway);

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(result.outcome).toBe("human-rejected");
      expect(result.plan).toBeDefined();
      expect(result.plan.id).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 6.2.5 — Review timeout returns waiting-for-input with plan persisted and resumable
  // -------------------------------------------------------------------------

  describe("review timeout — waiting-for-input, plan persisted and resumable", () => {
    it("returns waiting-for-input when gateway throws (timeout)", async () => {
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          throw new Error("review timed out");
        },
      };

      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store, reviewGateway);

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(result.outcome).toBe("waiting-for-input");
    });

    it("plan is persisted to the store before waiting-for-input is returned", async () => {
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          throw new Error("timeout");
        },
      };

      const agentLoop = makeAgentLoop();
      const { store, saves } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store, reviewGateway);

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(result.outcome).toBe("waiting-for-input");
      // Plan must have been saved exactly once (initial persist before the gate) so it is resumable
      expect(saves.length).toBe(1);
      expect(saves[0]?.id).toBe(result.plan.id);
    });

    it("plan is resumable via listResumable() after a timeout", async () => {
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          throw new Error("timeout");
        },
      };

      const agentLoop = makeAgentLoop();

      // Use a store that dynamically tracks saves for listResumable
      const savedPlans: Array<import("../../../domain/planning/types").TaskPlan> = [];
      const trackingStore: import("../../../application/ports/task-planning").ITaskPlanStore = {
        async save(plan) { savedPlans.push(JSON.parse(JSON.stringify(plan)) as typeof plan); },
        async load(planId) { return savedPlans.find((p) => p.id === planId) ?? null; },
        async listResumable() {
          return savedPlans
            .filter((p) => p.tasks.some((t) => !["completed", "failed"].includes(t.status)))
            .map((p) => p.id);
        },
      };

      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(11))]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, trackingStore, reviewGateway);

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(result.outcome).toBe("waiting-for-input");

      // listResumable should surface the plan ID since it has pending tasks
      const resumable = await service.listResumable();
      expect(resumable).toContain(result.plan.id);
    });

    it("emits plan:awaiting-review event on timeout", async () => {
      const { bus, events } = makeEventBus();
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          throw new Error("timeout");
        },
      };

      const agentLoop = makeAgentLoop();
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store, reviewGateway);

      await service.run("goal", {
        maxAutoApproveSteps: 10,
        skipHumanReview: false,
        eventBus: bus,
      });

      const awaitingEvent = events.find((e) => e.type === "plan:awaiting-review");
      expect(awaitingEvent).toBeDefined();
    });
  });
});
