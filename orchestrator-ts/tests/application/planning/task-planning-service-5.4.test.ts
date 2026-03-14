import { describe, expect, it } from "bun:test";
import { TaskPlanningService } from "../../../src/application/planning/task-planning-service";
import type { LlmResult } from "../../../src/application/ports/llm";
import type { IPlanContextBuilder } from "../../../src/application/ports/task-planning";
import {
  makeBooleanAgentLoop,
  makeContextBuilder,
  makeEventBus,
  makeLlm,
  makePlanBody,
  makeStore,
  makeSuccessLlmResult,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Test helpers (5.4-specific)
// ---------------------------------------------------------------------------

/** Single-step plan body convenience builder. */
function makeSingleStepPlanBody(description = "Execute the step"): string {
  return makePlanBody([{ id: "step-1", description }]);
}

function makeRevisionSuccess(revisedDesc: string): LlmResult {
  return makeSuccessLlmResult(revisedDesc);
}

function makeRevisionFailure(): LlmResult {
  return { ok: false, error: { category: "api_error", message: "revision LLM error", originalError: null } };
}

// ---------------------------------------------------------------------------
// Task 5.4 — Failure Recovery Chain
// ---------------------------------------------------------------------------

describe("TaskPlanningService — task 5.4: failure recovery chain", () => {
  // -------------------------------------------------------------------------
  // 5.4.1 — First retry (step succeeds on second attempt)
  // -------------------------------------------------------------------------

  describe("retry on first failure", () => {
    it("returns completed when step succeeds on the first retry", async () => {
      // Attempt 0: fail, Attempt 1: success
      const { agentLoop } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody()),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.outcome).toBe("completed");
    });

    it("invokes the agent loop twice when the step succeeds on retry", async () => {
      const { agentLoop, taskArgs } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody()),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(taskArgs.length).toBe(2);
    });

    it("retries up to maxStepRetries times before escalating", async () => {
      // 3 retries configured, all fail, then LLM revision fails → escalated
      // Total = 1 initial + 3 retries = 4 failures, then revision attempt
      const { agentLoop, taskArgs } = makeBooleanAgentLoop([false, false, false, false, false]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody(), [makeRevisionFailure()]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 3, skipHumanReview: true });

      // 4 attempts in retry loop; LLM revision fails so no final AL call = 4 total
      expect(taskArgs.length).toBe(4);
      expect(result.outcome).toBe("escalated");
    });
  });

  // -------------------------------------------------------------------------
  // 5.4.2 — Failure context included in retry attempts
  // -------------------------------------------------------------------------

  describe("failure context in retry", () => {
    it("the second attempt task string differs from the first (includes failure context)", async () => {
      const { agentLoop, taskArgs } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody("Do the thing")),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(taskArgs[0]).toBe("Do the thing");
      // Retry task must be different and contain additional failure context
      expect(taskArgs[1]).not.toBe("Do the thing");
      expect(taskArgs[1]).toBeDefined();
    });

    it("the retry task contains the original step description", async () => {
      const { agentLoop, taskArgs } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody("Install the dependency")),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      // The retry call should still contain the original description
      expect(taskArgs[1]).toContain("Install the dependency");
    });

    it("all retry attempts (not just the first) include failure context", async () => {
      const { agentLoop, taskArgs } = makeBooleanAgentLoop([false, false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody("Run migrations")),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 2, skipHumanReview: true });

      // First attempt: original description
      expect(taskArgs[0]).toBe("Run migrations");
      // Second attempt: with failure context
      expect(taskArgs[1]).not.toBe("Run migrations");
      // Third attempt: also with failure context
      expect(taskArgs[2]).not.toBe("Run migrations");
    });
  });

  // -------------------------------------------------------------------------
  // 5.4.3 — LLM-driven revision after retries exhausted
  // -------------------------------------------------------------------------

  describe("LLM-driven revision after exhausted retries", () => {
    it("calls the LLM for revision after all retries are exhausted", async () => {
      let buildRevisionContextCalled = false;
      const contextBuilder: IPlanContextBuilder = {
        async buildPlanContext() {
          return "context";
        },
        async buildRevisionContext(_plan, _stepId, _summary) {
          buildRevisionContextCalled = true;
          return "revision context";
        },
      };

      // maxStepRetries=1 → 2 attempts fail, then LLM revision
      const { agentLoop } = makeBooleanAgentLoop([false, false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        contextBuilder,
        makeLlm(makeSingleStepPlanBody(), [makeRevisionSuccess("revised step description")]),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(buildRevisionContextCalled).toBe(true);
    });

    it("passes the plan and step ID to buildRevisionContext", async () => {
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
        makeLlm(makeSingleStepPlanBody(), [makeRevisionSuccess("revised")]),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(capturedStepId).toBe("step-1");
    });

    it("returns completed when the revised step succeeds", async () => {
      // 2 failures (maxStepRetries=1), then LLM revision, then success on revision attempt
      const { agentLoop } = makeBooleanAgentLoop([false, false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody(), [makeRevisionSuccess("revised step")]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.outcome).toBe("completed");
    });

    it("uses the LLM-provided revised description in the final attempt", async () => {
      const { agentLoop, taskArgs } = makeBooleanAgentLoop([false, false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody(), [makeRevisionSuccess("REVISED: use a different approach")]),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      // The last task arg should be the revised description
      const lastCall = taskArgs[taskArgs.length - 1];
      expect(lastCall).toBe("REVISED: use a different approach");
    });
  });

  // -------------------------------------------------------------------------
  // 5.4.4 — Escalation when revision also fails
  // -------------------------------------------------------------------------

  describe("escalation when all recovery fails", () => {
    it("returns escalated when the revised step also fails", async () => {
      // 2 failures + revision attempt also fails
      const { agentLoop } = makeBooleanAgentLoop([false, false, false]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody(), [makeRevisionSuccess("revised step")]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.outcome).toBe("escalated");
    });

    it("includes the failed step ID in the escalated result", async () => {
      const { agentLoop } = makeBooleanAgentLoop([false, false, false]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody(), [makeRevisionSuccess("revised")]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.failedStepId).toBe("step-1");
    });

    it("returns escalated when LLM revision generation fails", async () => {
      // 2 failures + LLM can't generate revision
      const { agentLoop } = makeBooleanAgentLoop([false, false]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody(), [makeRevisionFailure()]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.outcome).toBe("escalated");
      expect(result.failedStepId).toBe("step-1");
    });

    it("returns escalated when contextBuilder.buildRevisionContext throws", async () => {
      const failingContextBuilder: IPlanContextBuilder = {
        async buildPlanContext() {
          return "context";
        },
        async buildRevisionContext(): Promise<string> {
          throw new Error("context engine unavailable");
        },
      };

      const { agentLoop } = makeBooleanAgentLoop([false, false]);
      const service = new TaskPlanningService(
        agentLoop,
        failingContextBuilder,
        makeLlm(makeSingleStepPlanBody(), [makeRevisionSuccess("revised")]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.outcome).toBe("escalated");
    });

    it("cascade-fails dependent steps after primary step failure", async () => {
      // Plan with step-1 → step-2, step-1 fails all recovery
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
        makeLlm(planBody, [makeRevisionSuccess("revised")]),
        makeStore().store,
      );

      const result = await service.run("goal", { maxStepRetries: 1, skipHumanReview: true });

      expect(result.outcome).toBe("escalated");
      const steps = result.plan.tasks[0]?.steps ?? [];
      expect(steps.find((s) => s.id === "step-1")?.status).toBe("failed");
      expect(steps.find((s) => s.id === "step-2")?.status).toBe("failed");
    });
  });

  // -------------------------------------------------------------------------
  // 5.4.5 — step:failed event recording
  // -------------------------------------------------------------------------

  describe("step:failed event recording", () => {
    it("emits a step:failed event after each failed attempt", async () => {
      const { bus, events } = makeEventBus();
      // 2 failures before success on revision
      const { agentLoop } = makeBooleanAgentLoop([false, false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody(), [makeRevisionSuccess("revised")]),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true, eventBus: bus });

      const failedEvents = events.filter((e) => e.type === "step:failed");
      // 2 retries = 2 step:failed events
      expect(failedEvents.length).toBeGreaterThanOrEqual(2);
    });

    it("step:failed event includes the step ID", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody()),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true, eventBus: bus });

      const failedEvent = events.find((e) => e.type === "step:failed");
      if (failedEvent?.type === "step:failed") {
        expect(failedEvent.stepId).toBe("step-1");
      } else {
        throw new Error("Expected step:failed event");
      }
    });

    it("step:failed event includes a non-empty errorSummary", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody()),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true, eventBus: bus });

      const failedEvent = events.find((e) => e.type === "step:failed");
      if (failedEvent?.type === "step:failed") {
        expect(failedEvent.errorSummary.length).toBeGreaterThan(0);
      } else {
        throw new Error("Expected step:failed event");
      }
    });

    it("step:failed event includes a non-empty recoveryAction", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeBooleanAgentLoop([false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody()),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true, eventBus: bus });

      const failedEvent = events.find((e) => e.type === "step:failed");
      if (failedEvent?.type === "step:failed") {
        expect(failedEvent.recoveryAction.length).toBeGreaterThan(0);
      } else {
        throw new Error("Expected step:failed event");
      }
    });

    it("step:failed events record the attempt number", async () => {
      const { bus, events } = makeEventBus();
      // 2 failures → 2 step:failed events with attempt 1 and 2
      const { agentLoop } = makeBooleanAgentLoop([false, false, true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody(), [makeRevisionSuccess("revised")]),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true, eventBus: bus });

      const failedEvents = events
        .filter((e) => e.type === "step:failed")
        .map((e) => (e.type === "step:failed" ? e.attempt : 0));

      expect(failedEvents).toContain(1);
      expect(failedEvents).toContain(2);
    });

    it("does not emit step:failed events when step succeeds on first attempt", async () => {
      const { bus, events } = makeEventBus();
      const { agentLoop } = makeBooleanAgentLoop([true]);
      const service = new TaskPlanningService(
        agentLoop,
        makeContextBuilder(),
        makeLlm(makeSingleStepPlanBody()),
        makeStore().store,
      );

      await service.run("goal", { maxStepRetries: 1, skipHumanReview: true, eventBus: bus });

      const failedEvents = events.filter((e) => e.type === "step:failed");
      expect(failedEvents.length).toBe(0);
    });
  });
});
