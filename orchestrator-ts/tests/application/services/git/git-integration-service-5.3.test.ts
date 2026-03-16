// ---------------------------------------------------------------------------
// GitIntegrationService — Task 5.3: Push with protected-branch and force-push enforcement
// tests/application/git/git-integration-service-5.3.test.ts
// ---------------------------------------------------------------------------

import type { IGitController } from "@/application/ports/git-controller";
import type { IGitEventBus } from "@/application/ports/git-event-bus";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { IPullRequestProvider } from "@/application/ports/pr-provider";
import type { AuditEntry, IAuditLogger } from "@/application/ports/safety";
import { GitIntegrationService } from "@/application/services/git/git-integration-service";
import type { IGitValidator } from "@/domain/git/git-validator";
import type { GitEvent, GitIntegrationConfig } from "@/domain/git/types";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<GitIntegrationConfig>): GitIntegrationConfig {
  return {
    baseBranch: "main",
    remote: "origin",
    maxFilesPerCommit: 50,
    maxDiffTokens: 4096,
    protectedBranches: ["main", "master", "production", "release/*"],
    protectedFilePatterns: [".env", "*.key"],
    forcePushEnabled: false,
    workspaceRoot: "/workspace",
    isDraft: false,
    ...overrides,
  };
}

function makeGitController(overrides?: Partial<IGitController>): IGitController & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    listBranches: async () => ({ ok: true, value: [] }),
    detectChanges: async () => ({ ok: true, value: { staged: [], unstaged: [], untracked: [] } }),
    createAndCheckoutBranch: async (branchName, baseBranch) => ({
      ok: true,
      value: { branchName, baseBranch, conflictResolved: false },
    }),
    stageAndCommit: async () => ({ ok: false, error: { type: "runtime", message: "not implemented" } }),
    push: async (branchName, remote, ...rest) => {
      calls.push({ method: "push", args: [branchName, remote, ...rest] });
      return {
        ok: true,
        value: { remote, branchName, commitHash: "abc123" },
      };
    },
    ...overrides,
  };
}

function makeValidator(overrides?: Partial<IGitValidator>): IGitValidator {
  return {
    isValidBranchName: () => true,
    matchesProtectedPattern: () => false,
    isWithinWorkspace: () => true,
    filterProtectedFiles: (files) => ({ safe: files, blocked: [] }),
    ...overrides,
  };
}

function makeEventBus(): IGitEventBus & { emitted: GitEvent[] } {
  const emitted: GitEvent[] = [];
  return { emitted, emit: (e) => emitted.push(e), on: () => {}, off: () => {} };
}

function makeAuditLogger(): IAuditLogger & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    write: async (e) => {
      entries.push(e);
    },
    flush: async () => {},
  };
}

function makeLlm(): LlmProviderPort {
  return {
    complete: async () => ({ ok: false, error: { category: "api_error", message: "not used", originalError: null } }),
    clearContext: () => {},
  };
}

function makePrProvider(): IPullRequestProvider {
  return { createOrUpdate: async () => ({ ok: false, error: { category: "api", message: "not used" } }) };
}

function makeService(overrides?: {
  controller?: Partial<IGitController>;
  validator?: Partial<IGitValidator>;
  eventBus?: IGitEventBus & { emitted: GitEvent[] };
  auditLogger?: IAuditLogger & { entries: AuditEntry[] };
  config?: Partial<GitIntegrationConfig>;
}): {
  service: GitIntegrationService;
  controller: IGitController & { calls: Array<{ method: string; args: unknown[] }> };
  eventBus: IGitEventBus & { emitted: GitEvent[] };
  auditLogger: IAuditLogger & { entries: AuditEntry[] };
} {
  const controller = makeGitController(overrides?.controller);
  const eventBus = overrides?.eventBus ?? makeEventBus();
  const auditLogger = overrides?.auditLogger ?? makeAuditLogger();
  const service = new GitIntegrationService(
    controller,
    makePrProvider(),
    makeLlm(),
    eventBus,
    auditLogger,
    makeValidator(overrides?.validator),
    makeConfig(overrides?.config),
    "test-session-id",
  );
  return { service, controller, eventBus, auditLogger };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitIntegrationService.push — task 5.3", () => {
  describe("protected branch enforcement", () => {
    it("emits protected-branch-push-rejected and returns Err for protected branch", async () => {
      const { service, eventBus } = makeService({
        validator: { matchesProtectedPattern: () => true },
      });
      const result = await service.push("main");
      expect(result.ok).toBe(false);
      const event = eventBus.emitted.find((e) => e.type === "protected-branch-push-rejected");
      expect(event).toBeDefined();
      if (event?.type === "protected-branch-push-rejected") {
        expect(event.branchName).toBe("main");
        expect(typeof event.timestamp).toBe("string");
      }
    });

    it("does not call IGitController.push when branch is protected", async () => {
      const { service, controller } = makeService({
        validator: { matchesProtectedPattern: () => true },
      });
      await service.push("main");
      expect(controller.calls.find((c) => c.method === "push")).toBeUndefined();
    });

    it("passes branchName and config.protectedBranches to validator.matchesProtectedPattern", async () => {
      const capturedArgs: Array<[string, ReadonlyArray<string>]> = [];
      const { service } = makeService({
        validator: {
          matchesProtectedPattern: (branchName, patterns) => {
            capturedArgs.push([branchName, patterns]);
            return false;
          },
        },
        config: { protectedBranches: ["main", "release/*"] },
      });
      await service.push("agent/my-feature");
      expect(capturedArgs[0]?.[0]).toBe("agent/my-feature");
      expect(capturedArgs[0]?.[1]).toEqual(["main", "release/*"]);
    });

    it("allows push to non-protected branch", async () => {
      const { service } = makeService({
        validator: { matchesProtectedPattern: () => false },
      });
      const result = await service.push("agent/my-feature");
      expect(result.ok).toBe(true);
    });

    it("returns validation error with branchName in message when protected", async () => {
      const { service } = makeService({
        validator: { matchesProtectedPattern: () => true },
      });
      const result = await service.push("release/v1.0");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe("validation");
        expect(result.error.message).toContain("release/v1.0");
      }
    });
  });

  describe("adapter push invocation", () => {
    it("calls IGitController.push with branchName and config.remote", async () => {
      const { service, controller } = makeService({
        config: { remote: "upstream" },
      });
      await service.push("agent/my-feature");
      const pushCall = controller.calls.find((c) => c.method === "push");
      expect(pushCall).toBeDefined();
      expect((pushCall?.args as string[])[0]).toBe("agent/my-feature");
      expect((pushCall?.args as string[])[1]).toBe("upstream");
    });

    it("uses default remote 'origin' from config", async () => {
      const { service, controller } = makeService({
        config: { remote: "origin" },
      });
      await service.push("agent/my-feature");
      const pushCall = controller.calls.find((c) => c.method === "push");
      expect((pushCall?.args as string[])[1]).toBe("origin");
    });
  });

  describe("non-fast-forward rejection", () => {
    it("emits push-rejected-non-fast-forward when adapter returns non-fast-forward error", async () => {
      const { service, eventBus } = makeService({
        controller: {
          push: async (_branchName) => ({
            ok: false,
            error: {
              type: "runtime",
              message: "remote: error\n! [rejected] main -> main (non-fast-forward)",
              details: { reason: "non-fast-forward" },
            },
          }),
        },
      });
      const result = await service.push("agent/my-feature");
      expect(result.ok).toBe(false);
      const event = eventBus.emitted.find((e) => e.type === "push-rejected-non-fast-forward");
      expect(event).toBeDefined();
      if (event?.type === "push-rejected-non-fast-forward") {
        expect(event.branchName).toBe("agent/my-feature");
        expect(event.remote).toBe("origin");
        expect(typeof event.timestamp).toBe("string");
      }
    });

    it("returns Err when push is rejected as non-fast-forward", async () => {
      const { service } = makeService({
        controller: {
          push: async () => ({
            ok: false,
            error: { type: "runtime", message: "rejected", details: { reason: "non-fast-forward" } },
          }),
        },
      });
      const result = await service.push("agent/my-feature");
      expect(result.ok).toBe(false);
    });

    it("does not emit push-rejected-non-fast-forward for other errors", async () => {
      const { service, eventBus } = makeService({
        controller: {
          push: async () => ({
            ok: false,
            error: { type: "runtime", message: "network error" },
          }),
        },
      });
      await service.push("agent/my-feature");
      expect(eventBus.emitted.find((e) => e.type === "push-rejected-non-fast-forward")).toBeUndefined();
    });

    it("propagates non-non-fast-forward errors as-is", async () => {
      const { service } = makeService({
        controller: {
          push: async () => ({
            ok: false,
            error: { type: "permission", message: "permission denied" },
          }),
        },
      });
      const result = await service.push("agent/my-feature");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("permission denied");
      }
    });
  });

  describe("success path — event and audit", () => {
    it("emits branch-pushed event on success", async () => {
      const { service, eventBus } = makeService();
      await service.push("agent/my-feature");
      const event = eventBus.emitted.find((e) => e.type === "branch-pushed");
      expect(event).toBeDefined();
      if (event?.type === "branch-pushed") {
        expect(event.branchName).toBe("agent/my-feature");
        expect(event.remote).toBe("origin");
        expect(typeof event.timestamp).toBe("string");
      }
    });

    it("emits branch-pushed with commitHash from PushResult", async () => {
      const { service, eventBus } = makeService({
        controller: {
          push: async (branchName, remote) => ({
            ok: true,
            value: { remote, branchName, commitHash: "deadbeef" },
          }),
        },
      });
      await service.push("agent/my-feature");
      const event = eventBus.emitted.find((e) => e.type === "branch-pushed");
      if (event?.type === "branch-pushed") {
        expect(event.commitHash).toBe("deadbeef");
      }
    });

    it("writes audit entry with toolName=push on success", async () => {
      const { service, auditLogger } = makeService();
      await service.push("agent/my-feature");
      expect(auditLogger.entries.length).toBe(1);
      expect(auditLogger.entries[0]?.toolName).toBe("push");
      expect(auditLogger.entries[0]?.outcome).toBe("success");
      expect(auditLogger.entries[0]?.sessionId).toBe("test-session-id");
    });

    it("returns Ok(PushResult) on success", async () => {
      const { service } = makeService();
      const result = await service.push("agent/my-feature");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.branchName).toBe("agent/my-feature");
        expect(result.value.remote).toBe("origin");
      }
    });

    it("does not emit protected-branch-push-rejected when push succeeds", async () => {
      const { service, eventBus } = makeService();
      await service.push("agent/my-feature");
      expect(eventBus.emitted.find((e) => e.type === "protected-branch-push-rejected")).toBeUndefined();
    });
  });

  describe("consecutive failure tracking for push", () => {
    it("emits repeated-git-failure after 3 consecutive push failures", async () => {
      const eventBus = makeEventBus();
      const { service } = makeService({
        controller: {
          push: async () => ({ ok: false, error: { type: "runtime", message: "push failed" } }),
        },
        eventBus,
      });
      await service.push("agent/my-feature");
      await service.push("agent/my-feature");
      await service.push("agent/my-feature");
      const event = eventBus.emitted.find((e) => e.type === "repeated-git-failure");
      expect(event).toBeDefined();
      if (event?.type === "repeated-git-failure") {
        expect(event.operation).toBe("push");
        expect(event.attemptCount).toBe(3);
      }
    });

    it("does not emit repeated-git-failure after only 2 push failures", async () => {
      const eventBus = makeEventBus();
      const { service } = makeService({
        controller: {
          push: async () => ({ ok: false, error: { type: "runtime", message: "failed" } }),
        },
        eventBus,
      });
      await service.push("agent/my-feature");
      await service.push("agent/my-feature");
      expect(eventBus.emitted.find((e) => e.type === "repeated-git-failure")).toBeUndefined();
    });

    it("resets consecutive failure count to 0 on successful push", async () => {
      const eventBus = makeEventBus();
      let callNumber = 0;
      const { service } = makeService({
        controller: {
          push: async (branchName, remote) => {
            callNumber++;
            if (callNumber === 3) {
              return { ok: true, value: { branchName, remote, commitHash: "ok" } };
            }
            return { ok: false, error: { type: "runtime", message: "failed" } };
          },
        },
        eventBus,
      });
      await service.push("agent/my-feature");
      await service.push("agent/my-feature");
      await service.push("agent/my-feature"); // success — resets count
      await service.push("agent/my-feature");
      await service.push("agent/my-feature");
      await service.push("agent/my-feature"); // 3rd failure after reset
      const failureEvents = eventBus.emitted.filter((e) => e.type === "repeated-git-failure");
      expect(failureEvents.length).toBe(1);
    });

    it("counts protected-branch rejections as failures for the push operation", async () => {
      const eventBus = makeEventBus();
      const { service } = makeService({
        validator: { matchesProtectedPattern: () => true },
        eventBus,
      });
      await service.push("main");
      await service.push("main");
      await service.push("main");
      const event = eventBus.emitted.find((e) => e.type === "repeated-git-failure");
      expect(event).toBeDefined();
      if (event?.type === "repeated-git-failure") {
        expect(event.operation).toBe("push");
      }
    });
  });
});
