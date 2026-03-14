import { describe, expect, it } from "bun:test";
import { TaskPlanningService } from "../../../src/application/planning/task-planning-service";
import type { IPlanContextBuilder } from "../../../src/application/ports/task-planning";
import {
  makeBooleanAgentLoop,
  makeContextBuilder,
  makeFailureLlmResult,
  makeLlm,
  makePlanBody,
  makeStore,
  makeSuccessLlmResult,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSingleStepBody(description = "Execute the step"): string {
  return makePlanBody([{ id: "step-1", description }]);
}

// ---------------------------------------------------------------------------
// Task 6.3 — Failure Recovery Scenarios
// Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
// ---------------------------------------------------------------------------

describe("TaskPlanningService — task 6.3: failure recovery scenarios", () => {
  // -------------------------------------------------------------------------
  // 6.3.1 — First retry passes (step succeeds on second attempt)
  // -------------------------------------------------------------------------

  describe("first retry succeeds", () => {
    it("returns completed when step fails on attempt 1 and succeeds on attempt 2", async () => {
      // attempt 0 = fail, attempt 1 = success
      const { agentLoop } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepBody()),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.outcome).toBe("completed");
    });

    it("invokes the agent loop exactly twice when step succeeds on first retry", async () => {
      const { agentLoop, taskArgs } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepBody()),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(taskArgs.length).toBe(2);
    });

    it("all steps end with completed status when retry succeeds", async () => {
      const { agentLoop } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepBody()),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      const step = result.plan.tasks[0]?.steps[0];
      expect(step?.status).toBe("completed");
    });
  });

  // -------------------------------------------------------------------------
  // 6.3.2 — Failure context included in the second attempt
  // -------------------------------------------------------------------------

  describe("failure context in the second attempt", () => {
    it("second agent loop call receives a different task string containing failure context", async () => {
      const { agentLoop, taskArgs } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepBody("Implement the feature")),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      // First call: original description
      expect(taskArgs[0]).toBe("Implement the feature");
      // Second call: must differ (contains failure/retry context)
      expect(taskArgs[1]).not.toBe("Implement the feature");
      expect(taskArgs[1]).toBeDefined();
    });

    it("retry task string contains the original step description", async () => {
      const { agentLoop, taskArgs } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepBody("Install the dependency")),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      // Retry call must embed the original description
      expect(taskArgs[1]).toContain("Install the dependency");
    });

    it("failure context describes the prior attempt error (not just empty string)", async () => {
      const { agentLoop, taskArgs } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepBody("Deploy the app")),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      // The retry string must contain "retry" or "attempt" or "failed" — i.e. some failure context
      const retryTask = taskArgs[1] ?? "";
      const hasContext = retryTask.toLowerCase().includes("retry")
        || retryTask.toLowerCase().includes("attempt")
        || retryTask.toLowerCase().includes("fail");
      expect(hasContext).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 6.3.3 — All retries exhausted triggers LLM-driven plan revision
  // -------------------------------------------------------------------------

  describe("retries exhausted → LLM-driven plan revision", () => {
    it("calls buildRevisionContext after all retries are exhausted", async () => {
      let revisionContextCalled = false;
      const contextBuilder: IPlanContextBuilder = {
        async buildPlanContext() {
          return "context";
        },
        async buildRevisionContext() {
          revisionContextCalled = true;
          return "revision context";
        },
      };

      // maxStepRetries=1 → 2 failures trigger revision; 3rd attempt succeeds
      const { agentLoop } = makeBooleanAgentLoop([false, false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        contextBuilder,
        makeLlm(makeSingleStepBody(), [makeSuccessLlmResult("revised step description")]),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(revisionContextCalled).toBe(true);
    });

    it("uses the revised description from the LLM in the post-revision agent loop call", async () => {
      const { agentLoop, taskArgs } = makeBooleanAgentLoop([false, false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepBody(), [makeSuccessLlmResult("REVISED: try a different approach")]),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      const lastCall = taskArgs[taskArgs.length - 1];
      expect(lastCall).toBe("REVISED: try a different approach");
    });

    it("returns completed when the revised step attempt succeeds", async () => {
      const { agentLoop } = makeBooleanAgentLoop([false, false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepBody(), [makeSuccessLlmResult("revised step")]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.outcome).toBe("completed");
    });

    it("passes the plan and failed step ID to buildRevisionContext", async () => {
      let capturedStepId: string | undefined;
      const contextBuilder: IPlanContextBuilder = {
        async buildPlanContext() {
          return "context";
        },
        async buildRevisionContext(_plan, stepId) {
          capturedStepId = stepId;
          return "revision context";
        },
      };

      const { agentLoop } = makeBooleanAgentLoop([false, false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        contextBuilder,
        makeLlm(makeSingleStepBody(), [makeSuccessLlmResult("revised")]),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(capturedStepId).toBe("step-1");
    });
  });

  // -------------------------------------------------------------------------
  // 6.3.4 — Failed revised step returns escalated outcome with failed step ID
  // -------------------------------------------------------------------------

  describe("failed revised step → escalated outcome with failed step ID", () => {
    it("returns escalated when the revised step also fails", async () => {
      // 2 original failures, revision attempt also fails
      const { agentLoop } = makeBooleanAgentLoop([false, false, false]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepBody(), [makeSuccessLlmResult("revised step")]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.outcome).toBe("escalated");
    });

    it("escalated result includes the failed step ID", async () => {
      const { agentLoop } = makeBooleanAgentLoop([false, false, false]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepBody(), [makeSuccessLlmResult("revised step")]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.failedStepId).toBe("step-1");
    });

    it("returns escalated when LLM revision generation fails", async () => {
      // 2 original failures, LLM can't generate revision
      const { agentLoop } = makeBooleanAgentLoop([false, false]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepBody(), [makeFailureLlmResult()]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.outcome).toBe("escalated");
      expect(result.failedStepId).toBe("step-1");
    });

    it("cascade-fails dependent steps when the primary step exhausts all recovery", async () => {
      const planBody = JSON.stringify({
        goal: "goal",
        tasks: [{
          id: "task-1",
          title: "Task",
          status: "pending",
          steps: [
            { id: "step-1", description: "step-1", status: "pending", dependsOn: [], statusHistory: [] },
            { id: "step-2", description: "step-2", status: "pending", dependsOn: ["step-1"], statusHistory: [] },
          ],
        }],
      });

      // All agent loop calls fail
      const { agentLoop } = makeBooleanAgentLoop([false, false, false]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(planBody, [makeSuccessLlmResult("revised")]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.outcome).toBe("escalated");
      const steps = result.plan.tasks[0]?.steps ?? [];
      expect(steps.find((s) => s.id === "step-1")?.status).toBe("failed");
      expect(steps.find((s) => s.id === "step-2")?.status).toBe("failed");
    });

    it("escalated result step in final plan has failed status", async () => {
      const { agentLoop } = makeBooleanAgentLoop([false, false, false]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepBody(), [makeSuccessLlmResult("revised step")]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      const step = result.plan.tasks[0]?.steps.find((s) => s.id === result.failedStepId);
      expect(step?.status).toBe("failed");
    });
  });
});
