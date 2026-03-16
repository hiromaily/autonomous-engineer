import type { IAgentLoop } from "@/application/ports/agent-loop";
import type { LlmProviderPort, LlmResult } from "@/application/ports/llm";
import type { IHumanReviewGateway, IPlanContextBuilder, PlanReviewDecision } from "@/application/ports/task-planning";
import { TaskPlanningService } from "@/application/services/planning/task-planning-service";
import type { PlanReviewReason } from "@/domain/planning/types";
import { beforeEach, describe, expect, it } from "bun:test";
import {
  makeAgentLoop,
  makeContextBuilder,
  makeEventBus,
  makeHighRiskPlanBody,
  makeLargePlanBody,
  makeLlmFromResults,
  makePlanBody,
  makeStore,
  makeSuccessLlmResult,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Task 5.2 — Human Review Gate
// ---------------------------------------------------------------------------

describe("TaskPlanningService — task 5.2: human review gate", () => {
  let agentLoop: IAgentLoop;

  beforeEach(() => {
    agentLoop = makeAgentLoop();
  });

  // -------------------------------------------------------------------------
  // 5.2.1 — Gate skip conditions
  // -------------------------------------------------------------------------

  describe("gate skip conditions", () => {
    it("skips the gate when skipHumanReview: true even for a large plan", async () => {
      let gateInvoked = false;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          gateInvoked = true;
          return { approved: true };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: true });

      expect(gateInvoked).toBe(false);
    });

    it("skips the gate when no reviewGateway is injected (auto-approve)", async () => {
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(agentLoop, makeContextBuilder(), llm, store);

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(result.outcome).toBe("completed");
    });

    it("skips the gate when step count is exactly at the threshold", async () => {
      let gateInvoked = false;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          gateInvoked = true;
          return { approved: true };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(10))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(gateInvoked).toBe(false);
    });

    it("skips the gate when plan has no high-risk steps and step count is within limit", async () => {
      let gateInvoked = false;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          gateInvoked = true;
          return { approved: true };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody())]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(gateInvoked).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 5.2.2 — Gate activation triggers
  // -------------------------------------------------------------------------

  describe("gate activation triggers", () => {
    it("activates the gate when step count exceeds maxAutoApproveSteps", async () => {
      let gateInvoked = false;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          gateInvoked = true;
          return { approved: true };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(11))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(gateInvoked).toBe(true);
    });

    it("uses reason 'large-plan' when step count exceeds threshold", async () => {
      let capturedReason: PlanReviewReason | undefined;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(_plan, reason): Promise<PlanReviewDecision> {
          capturedReason = reason;
          return { approved: true };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(11))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(capturedReason).toBe("large-plan");
    });

    it("activates the gate when a step description contains a high-risk keyword", async () => {
      let gateInvoked = false;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          gateInvoked = true;
          return { approved: true };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeHighRiskPlanBody())]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(gateInvoked).toBe(true);
    });

    it("uses reason 'high-risk-operations' for high-risk step descriptions", async () => {
      let capturedReason: PlanReviewReason | undefined;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(_plan, reason): Promise<PlanReviewDecision> {
          capturedReason = reason;
          return { approved: true };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeHighRiskPlanBody())]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(capturedReason).toBe("high-risk-operations");
    });

    it("uses reason 'large-plan' when plan is both large and high-risk", async () => {
      let capturedReason: PlanReviewReason | undefined;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(_plan, reason): Promise<PlanReviewDecision> {
          capturedReason = reason;
          return { approved: true };
        },
      };

      const { store } = makeStore();
      // 11 steps where one is high-risk → large-plan takes priority
      const steps = Array.from({ length: 11 }, (_, i) => ({
        id: `step-${i + 1}`,
        description: i === 0 ? "Delete old records" : `Step ${i + 1}`,
      }));
      const llm = makeLlmFromResults([makeSuccessLlmResult(makePlanBody(steps))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(capturedReason).toBe("large-plan");
    });

    it("gate uses default maxAutoApproveSteps of 10 when not specified", async () => {
      let gateInvoked = false;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          gateInvoked = true;
          return { approved: true };
        },
      };

      const { store } = makeStore();
      // 11 steps → should trigger default threshold of 10
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(11))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      // No options → uses defaults
      await service.run("goal");

      expect(gateInvoked).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5.2.3 — Approval path
  // -------------------------------------------------------------------------

  describe("approval path", () => {
    it("returns completed outcome when reviewer approves the plan", async () => {
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          return { approved: true };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(result.outcome).toBe("completed");
    });

    it("passes the full plan to the gateway for review", async () => {
      let capturedPlanId: string | undefined;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(plan): Promise<PlanReviewDecision> {
          capturedPlanId = plan.id;
          return { approved: true };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(capturedPlanId).toBe(result.plan.id);
    });
  });

  // -------------------------------------------------------------------------
  // 5.2.4 — Timeout path
  // -------------------------------------------------------------------------

  describe("timeout path", () => {
    it("returns waiting-for-input when gateway throws (timeout)", async () => {
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          throw new Error("review timed out");
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(result.outcome).toBe("waiting-for-input");
    });

    it("includes the plan in the waiting-for-input result", async () => {
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          throw new Error("timeout");
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(result.plan).toBeDefined();
      expect(result.plan.id).toBeDefined();
    });

    it("emits plan:awaiting-review event on timeout", async () => {
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          throw new Error("timeout");
        },
      };

      const { bus, events } = makeEventBus();
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      await service.run("goal", {
        maxAutoApproveSteps: 10,
        skipHumanReview: false,
        eventBus: bus,
      });

      const awaitingEvent = events.find((e) => e.type === "plan:awaiting-review");
      expect(awaitingEvent).toBeDefined();
      expect(awaitingEvent?.type).toBe("plan:awaiting-review");
    });

    it("awaiting-review event carries the correct planId and reason", async () => {
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          throw new Error("timeout");
        },
      };

      const { bus, events } = makeEventBus();
      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      const result = await service.run("goal", {
        maxAutoApproveSteps: 10,
        skipHumanReview: false,
        eventBus: bus,
      });

      const awaitingEvent = events.find((e) => e.type === "plan:awaiting-review");
      if (awaitingEvent?.type === "plan:awaiting-review") {
        expect(awaitingEvent.planId).toBe(result.plan.id);
        expect(awaitingEvent.reason).toBe("large-plan");
      } else {
        throw new Error("Expected plan:awaiting-review event was not emitted");
      }
    });

    it("does not emit awaiting-review event when no eventBus is provided", async () => {
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          throw new Error("timeout");
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([makeSuccessLlmResult(makeLargePlanBody(15))]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      // Must not throw even without eventBus
      await expect(
        service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false }),
      ).resolves.toMatchObject({ outcome: "waiting-for-input" });
    });
  });

  // -------------------------------------------------------------------------
  // 5.2.5 — Rejection with feedback (one revision pass)
  // -------------------------------------------------------------------------

  describe("rejection with feedback and plan revision", () => {
    it("calls LLM again with feedback to regenerate the plan on rejection", async () => {
      let llmCallCount = 0;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          // Reject on first call, approve on second
          if (llmCallCount < 2) return { approved: false, feedback: "add more detail" };
          return { approved: true };
        },
      };

      const { store } = makeStore();
      const llm: LlmProviderPort = {
        async complete(): Promise<LlmResult> {
          llmCallCount++;
          return makeSuccessLlmResult(makeLargePlanBody(15));
        },
        clearContext() {},
      };

      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      // LLM called once for initial generation + once for revision
      expect(llmCallCount).toBeGreaterThanOrEqual(2);
    });

    it("returns completed when reviewer approves the revised plan", async () => {
      let reviewCallCount = 0;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          reviewCallCount++;
          if (reviewCallCount === 1) return { approved: false, feedback: "needs more steps" };
          return { approved: true };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(makeLargePlanBody(15)),
        makeSuccessLlmResult(makeLargePlanBody(15)),
      ]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(result.outcome).toBe("completed");
      expect(reviewCallCount).toBe(2);
    });

    it("returns human-rejected when reviewer rejects both the original and revised plan", async () => {
      let reviewCallCount = 0;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          reviewCallCount++;
          return { approved: false, feedback: "still not acceptable" };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(makeLargePlanBody(15)),
        makeSuccessLlmResult(makeLargePlanBody(15)),
      ]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(result.outcome).toBe("human-rejected");
      expect(reviewCallCount).toBe(2);
    });

    it("calls gateway exactly twice (initial + one revision pass)", async () => {
      let reviewCallCount = 0;
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          reviewCallCount++;
          return { approved: false, feedback: "not good" };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(makeLargePlanBody(15)),
        makeSuccessLlmResult(makeLargePlanBody(15)),
      ]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(reviewCallCount).toBe(2);
    });

    it("incorporates feedback in the revision context (passed to contextBuilder)", async () => {
      let capturedGoal: string | undefined;
      const contextBuilder: IPlanContextBuilder = {
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
          if (reviewCallCount === 1) return { approved: false, feedback: "needs error handling" };
          return { approved: true };
        },
      };

      const { store } = makeStore();
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(makeLargePlanBody(15)),
        makeSuccessLlmResult(makeLargePlanBody(15)),
      ]);
      const service = new TaskPlanningService(
        agentLoop,
        contextBuilder,
        llm,
        store,
        reviewGateway,
      );

      await service.run("my goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      // The second buildPlanContext call should include the feedback
      expect(capturedGoal).toContain("needs error handling");
    });

    it("returns human-rejected (not escalated) when revision plan generation fails", async () => {
      const reviewGateway: IHumanReviewGateway = {
        async reviewPlan(): Promise<PlanReviewDecision> {
          return { approved: false, feedback: "bad plan" };
        },
      };

      const { store } = makeStore();
      // First response valid, second response invalid JSON
      const llm = makeLlmFromResults([
        makeSuccessLlmResult(makeLargePlanBody(15)),
        makeSuccessLlmResult("not valid json"),
      ]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        llm,
        store,
        reviewGateway,
      );

      const result = await service.run("goal", { maxAutoApproveSteps: 10, skipHumanReview: false });

      expect(result.outcome).toBe("human-rejected");
    });
  });
});
