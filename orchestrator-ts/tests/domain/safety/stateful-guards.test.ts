import { describe, expect, it } from "bun:test";
import type { SafetyContext } from "../../../domain/safety/guards";
import {
  DestructiveActionGuard,
  FailureDetectionGuard,
  IterationLimitGuard,
  RateLimitGuard,
} from "../../../domain/safety/stateful-guards";
import { createSafetyConfig, createSafetySession } from "../../../domain/safety/types";
import type { MemoryEntry } from "../../../domain/tools/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSafetyContext(
  overrides: Parameters<typeof createSafetyConfig>[0],
  sessionOverrides?: Partial<ReturnType<typeof createSafetySession>>,
): SafetyContext {
  const config = createSafetyConfig(overrides);
  const session = createSafetySession();
  if (sessionOverrides) {
    Object.assign(session, sessionOverrides);
  }
  return {
    workspaceRoot: config.workspaceRoot,
    workingDirectory: config.workspaceRoot,
    permissions: {
      filesystemRead: true,
      filesystemWrite: true,
      shellExecution: true,
      gitWrite: true,
      networkAccess: false,
    },
    memory: {
      async search(_q: string): Promise<ReadonlyArray<MemoryEntry>> {
        return [];
      },
    },
    logger: { info: () => {}, error: () => {} },
    session,
    config,
  };
}

// ---------------------------------------------------------------------------
// 3.1 IterationLimitGuard
// ---------------------------------------------------------------------------

describe("IterationLimitGuard", () => {
  describe("iteration count limit", () => {
    it("allows invocation when iteration count is below the limit", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxIterations: 5 });
      ctx.session.iterationCount = 4; // one below limit
      const guard = new IterationLimitGuard();
      const result = await guard.check("read_file", {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it("allows invocation when iteration count equals limit minus one", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxIterations: 10 });
      ctx.session.iterationCount = 9;
      const guard = new IterationLimitGuard();
      const result = await guard.check("read_file", {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects invocation when iteration count reaches the limit", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxIterations: 5 });
      ctx.session.iterationCount = 5; // at limit
      const guard = new IterationLimitGuard();
      const result = await guard.check("read_file", {}, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("runtime");
    });

    it("error message includes limit type \"iterations\" and current count", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxIterations: 3 });
      ctx.session.iterationCount = 3;
      const guard = new IterationLimitGuard();
      const result = await guard.check("read_file", {}, ctx);
      expect(result.error?.message).toMatch(/iterations/i);
      expect(result.error?.message).toMatch(/3/);
    });

    it("error details carry a progress summary string", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxIterations: 2 });
      ctx.session.iterationCount = 2;
      const guard = new IterationLimitGuard();
      const result = await guard.check("read_file", {}, ctx);
      expect(result.error?.details).toBeDefined();
      expect(typeof (result.error?.details as Record<string, unknown>)?.progressSummary).toBe("string");
    });
  });

  describe("runtime limit", () => {
    it("allows invocation when elapsed time is below the runtime limit", async () => {
      const now = Date.now();
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxRuntimeMs: 60_000 });
      // session.startedAtMs is set at creation — elapsed = ~0ms, well within 60s
      const guard = new IterationLimitGuard(() => now + 1_000); // 1 second elapsed
      const result = await guard.check("read_file", {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects invocation when elapsed time reaches the runtime limit", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxRuntimeMs: 60_000 });
      const futureNow = ctx.session.startedAtMs + 60_000; // exactly at limit
      const guard = new IterationLimitGuard(() => futureNow);
      const result = await guard.check("read_file", {}, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("runtime");
    });

    it("error message includes limit type \"runtime\" and elapsed value", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxRuntimeMs: 30_000 });
      const futureNow = ctx.session.startedAtMs + 35_000;
      const guard = new IterationLimitGuard(() => futureNow);
      const result = await guard.check("read_file", {}, ctx);
      expect(result.error?.message).toMatch(/runtime/i);
    });
  });
});

// ---------------------------------------------------------------------------
// 3.2 FailureDetectionGuard
// ---------------------------------------------------------------------------

describe("FailureDetectionGuard", () => {
  const TOOL = "read_file";
  const ERROR_SIG = { ok: false as const, error: { type: "runtime" as const, message: "timeout" } };
  const SUCCESS = { ok: true as const, value: { content: "hello" } };

  describe("pre-check: paused state", () => {
    it("allows invocation when session is not paused", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new FailureDetectionGuard();
      const result = await guard.check(TOOL, {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects all invocations when session is paused", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      ctx.session.paused = true;
      ctx.session.pauseReason = "repeated failures";
      const guard = new FailureDetectionGuard();
      const result = await guard.check(TOOL, {}, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.message).toMatch(/human review/i);
    });
  });

  describe("recordResult: failure tracking", () => {
    it("first consecutive identical failure does not pause the session", () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new FailureDetectionGuard();
      const notification = guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      expect(ctx.session.paused).toBe(false);
      expect(notification).toBeUndefined();
    });

    it("second consecutive identical failure does not pause the session", () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new FailureDetectionGuard();
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      const notification = guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      expect(ctx.session.paused).toBe(false);
      expect(notification).toBeUndefined();
    });

    it("third consecutive identical failure pauses the session", () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new FailureDetectionGuard();
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      const notification = guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      expect(ctx.session.paused).toBe(true);
      expect(ctx.session.pauseReason).toBeDefined();
      expect(notification).toBeDefined();
      expect(notification?.occurrences).toBe(3);
    });

    it("notification includes the failure signature", () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new FailureDetectionGuard();
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      const notification = guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      expect(notification?.signature).toContain(TOOL);
      expect(notification?.signature).toContain("runtime");
      expect(notification?.signature).toContain("timeout");
    });

    it("counter resets on success — subsequent failures restart from 1", () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new FailureDetectionGuard();
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      guard.recordResult(TOOL, SUCCESS, ctx.session); // reset
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      const notification = guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      // Should pause on the 3rd after reset
      expect(ctx.session.paused).toBe(true);
      expect(notification?.occurrences).toBe(3);
    });

    it("counter resets on a different error signature", () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new FailureDetectionGuard();
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      // Different error — resets counter for previous signature
      guard.recordResult(TOOL, { ok: false, error: { type: "permission", message: "denied" } }, ctx.session);
      // Now 2 more of the original error — still no pause (counter was reset)
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      expect(ctx.session.paused).toBe(false);
    });

    it("subsequent invocations on paused session are rejected", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new FailureDetectionGuard();
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      guard.recordResult(TOOL, ERROR_SIG, ctx.session);
      guard.recordResult(TOOL, ERROR_SIG, ctx.session); // pauses
      // Now pre-check should reject
      const result = await guard.check(TOOL, {}, ctx);
      expect(result.allowed).toBe(false);
    });
  });

  describe("failure signature computation", () => {
    it("signature includes tool name, error type, and first 120 chars of message", () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new FailureDetectionGuard();
      const longMessage = "x".repeat(200);
      guard.recordResult(TOOL, { ok: false, error: { type: "runtime", message: longMessage } }, ctx.session);
      guard.recordResult(TOOL, { ok: false, error: { type: "runtime", message: longMessage } }, ctx.session);
      const notification = guard.recordResult(
        TOOL,
        { ok: false, error: { type: "runtime", message: longMessage } },
        ctx.session,
      );
      expect(notification?.signature).toContain(longMessage.slice(0, 120));
      expect(notification?.signature.length).toBeLessThanOrEqual(
        TOOL.length + 1 + "runtime".length + 1 + 120,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 3.3 RateLimitGuard
// ---------------------------------------------------------------------------

describe("RateLimitGuard", () => {
  const SIXTY_SECONDS = 60_000;

  describe("tool invocation rolling window", () => {
    it("allows when count is below the per-minute limit", async () => {
      const ctx = makeSafetyContext({
        workspaceRoot: "/workspace",
        rateLimits: { toolInvocationsPerMinute: 5, repoWritesPerSession: 20, apiRequestsPerMinute: 30 },
      });
      const now = Date.now();
      // 4 recent timestamps — one below limit
      ctx.session.toolInvocationTimestamps = [now - 1000, now - 2000, now - 3000, now - 4000];
      const guard = new RateLimitGuard(() => now);
      const result = await guard.check("read_file", {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects when count equals the per-minute limit (would exceed on this call)", async () => {
      const ctx = makeSafetyContext({
        workspaceRoot: "/workspace",
        rateLimits: { toolInvocationsPerMinute: 5, repoWritesPerSession: 20, apiRequestsPerMinute: 30 },
      });
      const now = Date.now();
      // 5 recent timestamps — at the limit
      ctx.session.toolInvocationTimestamps = [now - 1000, now - 2000, now - 3000, now - 4000, now - 5000];
      const guard = new RateLimitGuard(() => now);
      const result = await guard.check("read_file", {}, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("runtime");
      expect(result.error?.message).toMatch(/tool invocation/i);
    });

    it("error message includes category name and current count", async () => {
      const ctx = makeSafetyContext({
        workspaceRoot: "/workspace",
        rateLimits: { toolInvocationsPerMinute: 3, repoWritesPerSession: 20, apiRequestsPerMinute: 30 },
      });
      const now = Date.now();
      ctx.session.toolInvocationTimestamps = [now - 100, now - 200, now - 300];
      const guard = new RateLimitGuard(() => now);
      const result = await guard.check("read_file", {}, ctx);
      expect(result.error?.message).toMatch(/3/); // current count
    });

    it("prunes timestamps older than 60 seconds from the rolling window", async () => {
      const ctx = makeSafetyContext({
        workspaceRoot: "/workspace",
        rateLimits: { toolInvocationsPerMinute: 3, repoWritesPerSession: 20, apiRequestsPerMinute: 30 },
      });
      const now = Date.now();
      // 3 timestamps: 2 old (>60s) and 1 recent — effective count = 1 after pruning
      ctx.session.toolInvocationTimestamps = [
        now - SIXTY_SECONDS - 1000, // old
        now - SIXTY_SECONDS - 500, // old
        now - 1000, // recent
      ];
      const guard = new RateLimitGuard(() => now);
      const result = await guard.check("read_file", {}, ctx);
      expect(result.allowed).toBe(true); // only 1 after pruning, limit is 3
    });
  });

  describe("repo write per-session counter", () => {
    it("allows when repo write count is below the session limit", async () => {
      const ctx = makeSafetyContext({
        workspaceRoot: "/workspace",
        rateLimits: { toolInvocationsPerMinute: 60, repoWritesPerSession: 5, apiRequestsPerMinute: 30 },
      });
      ctx.session.repoWriteCount = 4; // one below limit
      const guard = new RateLimitGuard();
      const result = await guard.check("git_commit", {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects when repo write count reaches the session limit", async () => {
      const ctx = makeSafetyContext({
        workspaceRoot: "/workspace",
        rateLimits: { toolInvocationsPerMinute: 60, repoWritesPerSession: 5, apiRequestsPerMinute: 30 },
      });
      ctx.session.repoWriteCount = 5; // at limit
      const guard = new RateLimitGuard();
      const result = await guard.check("git_commit", {}, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.type).toBe("runtime");
      expect(result.error?.message).toMatch(/repo write/i);
    });

    it("applies repo write limit to git_branch_create as well", async () => {
      const ctx = makeSafetyContext({
        workspaceRoot: "/workspace",
        rateLimits: { toolInvocationsPerMinute: 60, repoWritesPerSession: 2, apiRequestsPerMinute: 30 },
      });
      ctx.session.repoWriteCount = 2;
      const guard = new RateLimitGuard();
      const result = await guard.check("git_branch_create", { name: "agent/test" }, ctx);
      expect(result.allowed).toBe(false);
    });
  });

  describe("API request rolling window", () => {
    it("allows when API request count is below the per-minute limit", async () => {
      const ctx = makeSafetyContext({
        workspaceRoot: "/workspace",
        rateLimits: { toolInvocationsPerMinute: 60, repoWritesPerSession: 20, apiRequestsPerMinute: 3 },
      });
      const now = Date.now();
      ctx.session.apiRequestTimestamps = [now - 1000, now - 2000];
      const guard = new RateLimitGuard(() => now);
      const result = await guard.check("llm_chat", {}, ctx);
      expect(result.allowed).toBe(true);
    });

    it("rejects when API request count reaches the per-minute limit", async () => {
      const ctx = makeSafetyContext({
        workspaceRoot: "/workspace",
        rateLimits: { toolInvocationsPerMinute: 60, repoWritesPerSession: 20, apiRequestsPerMinute: 3 },
      });
      const now = Date.now();
      ctx.session.apiRequestTimestamps = [now - 1000, now - 2000, now - 3000];
      const guard = new RateLimitGuard(() => now);
      const result = await guard.check("llm_chat", {}, ctx);
      expect(result.allowed).toBe(false);
      expect(result.error?.message).toMatch(/api request/i);
    });

    it("prunes old API request timestamps from the rolling window", async () => {
      const ctx = makeSafetyContext({
        workspaceRoot: "/workspace",
        rateLimits: { toolInvocationsPerMinute: 60, repoWritesPerSession: 20, apiRequestsPerMinute: 2 },
      });
      const now = Date.now();
      ctx.session.apiRequestTimestamps = [
        now - SIXTY_SECONDS - 1000, // old
        now - SIXTY_SECONDS - 500, // old
        now - 500, // recent — count = 1 after pruning
      ];
      const guard = new RateLimitGuard(() => now);
      const result = await guard.check("llm_chat", {}, ctx);
      expect(result.allowed).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 3.4 DestructiveActionGuard
// ---------------------------------------------------------------------------

describe("DestructiveActionGuard", () => {
  describe("bulk delete detection", () => {
    it("requires approval when delete paths exceed maxFileDeletes", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxFileDeletes: 3 });
      const guard = new DestructiveActionGuard();
      // delete_files tool with 4 paths (above limit of 3)
      const result = await guard.check("delete_files", { paths: ["a", "b", "c", "d"] }, ctx);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.approvalRequest).toBeDefined();
      expect(result.approvalRequest?.description).toBeTruthy();
      expect(result.approvalRequest?.riskClassification).toMatch(/high|critical/);
    });

    it("allows when delete paths count is at or below maxFileDeletes", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxFileDeletes: 3 });
      const guard = new DestructiveActionGuard();
      const result = await guard.check("delete_files", { paths: ["a", "b", "c"] }, ctx);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBeUndefined();
    });

    it("allows when no paths field present (non-delete tool)", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxFileDeletes: 3 });
      const guard = new DestructiveActionGuard();
      const result = await guard.check("read_file", { path: "/workspace/foo.ts" }, ctx);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBeUndefined();
    });
  });

  describe("force-push detection", () => {
    it("requires approval when force flag is true on git_push", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new DestructiveActionGuard();
      const result = await guard.check("git_push", { remote: "origin", branch: "main", force: true }, ctx);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.approvalRequest?.riskClassification).toBe("critical");
    });

    it("allows git_push without force flag", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new DestructiveActionGuard();
      const result = await guard.check("git_push", { remote: "origin", branch: "agent/foo", force: false }, ctx);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBeUndefined();
    });

    it("allows git_push with absent force flag", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new DestructiveActionGuard();
      const result = await guard.check("git_push", { remote: "origin", branch: "agent/foo" }, ctx);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBeUndefined();
    });
  });

  describe("protected file write detection", () => {
    it("requires approval when write_file targets a protected pattern", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new DestructiveActionGuard();
      const result = await guard.check("write_file", { path: "/workspace/.env", content: "SECRET=x" }, ctx);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
      expect(result.approvalRequest?.description).toBeTruthy();
    });

    it("allows write_file to non-protected files", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace" });
      const guard = new DestructiveActionGuard();
      const result = await guard.check("write_file", { path: "/workspace/src/app.ts", content: "code" }, ctx);
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBeUndefined();
    });
  });

  describe("approval request fields", () => {
    it("approval request carries all required fields", async () => {
      const ctx = makeSafetyContext({ workspaceRoot: "/workspace", maxFileDeletes: 2 });
      const guard = new DestructiveActionGuard();
      const result = await guard.check("delete_files", { paths: ["a", "b", "c"] }, ctx);
      expect(result.approvalRequest?.description).toBeTruthy();
      expect(result.approvalRequest?.riskClassification).toMatch(/high|critical/);
      expect(result.approvalRequest?.expectedImpact).toBeTruthy();
      expect(result.approvalRequest?.proposedAction).toBeTruthy();
    });
  });
});
