// ---------------------------------------------------------------------------
// GitIntegrationService — Task 5.1: Feature branch creation with collision resolution
// tests/application/git/git-integration-service-5.1.test.ts
// ---------------------------------------------------------------------------

import { GitIntegrationService } from "@/application/git/git-integration-service";
import type { IGitController } from "@/application/ports/git-controller";
import type { IGitEventBus } from "@/application/ports/git-event-bus";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { IPullRequestProvider } from "@/application/ports/pr-provider";
import type { AuditEntry, IAuditLogger } from "@/application/safety/ports";
import type { IGitValidator } from "@/domain/git/git-validator";
import type { GitChangesResult, GitEvent, GitIntegrationConfig } from "@/domain/git/types";
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
    protectedBranches: ["main", "master", "production"],
    protectedFilePatterns: [".env", "*.key", "*.pem"],
    forcePushEnabled: false,
    workspaceRoot: "/workspace",
    isDraft: false,
    ...overrides,
  };
}

function makeCleanChanges(): GitChangesResult {
  return { staged: [], unstaged: [], untracked: [] };
}

function makeDirtyChanges(type: "staged" | "unstaged" | "untracked"): GitChangesResult {
  const base = { staged: [], unstaged: [], untracked: [] };
  return { ...base, [type]: ["src/file.ts"] };
}

function makeGitController(overrides?: Partial<IGitController>): IGitController & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    listBranches: async (...args) => {
      calls.push({ method: "listBranches", args });
      return { ok: true, value: [] };
    },
    detectChanges: async (...args) => {
      calls.push({ method: "detectChanges", args });
      return { ok: true, value: makeCleanChanges() };
    },
    createAndCheckoutBranch: async (branchName, baseBranch, ...rest) => {
      calls.push({ method: "createAndCheckoutBranch", args: [branchName, baseBranch, ...rest] });
      return {
        ok: true,
        value: { branchName, baseBranch, conflictResolved: false },
      };
    },
    stageAndCommit: async (...args) => {
      calls.push({ method: "stageAndCommit", args });
      return { ok: false, error: { type: "runtime", message: "not implemented" } };
    },
    push: async (...args) => {
      calls.push({ method: "push", args });
      return { ok: false, error: { type: "runtime", message: "not implemented" } };
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
  return {
    emitted,
    emit: (event) => emitted.push(event),
    on: () => {},
    off: () => {},
  };
}

function makeAuditLogger(): IAuditLogger & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    write: async (entry) => {
      entries.push(entry);
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
  return {
    createOrUpdate: async () => ({ ok: false, error: { category: "api", message: "not used" } }),
  };
}

function makeService(
  overrides?: {
    controller?: Partial<IGitController>;
    validator?: Partial<IGitValidator>;
    eventBus?: IGitEventBus & { emitted: GitEvent[] };
    auditLogger?: IAuditLogger & { entries: AuditEntry[] };
    config?: Partial<GitIntegrationConfig>;
  },
): {
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

describe("GitIntegrationService.createBranch — task 5.1", () => {
  describe("branch name derivation", () => {
    it("derives branch name as agent/<specName> when specName is provided", async () => {
      const { service, controller } = makeService();
      await service.createBranch("my-spec", "my-task-slug");
      const createCall = controller.calls.find((c) => c.method === "createAndCheckoutBranch");
      expect(createCall).toBeDefined();
      expect((createCall?.args as string[])[0]).toBe("agent/my-spec");
    });

    it("derives branch name as agent/<taskSlug> when specName is empty", async () => {
      const { service, controller } = makeService();
      await service.createBranch("", "my-task-slug");
      const createCall = controller.calls.find((c) => c.method === "createAndCheckoutBranch");
      expect(createCall).toBeDefined();
      expect((createCall?.args as string[])[0]).toBe("agent/my-task-slug");
    });

    it("passes config.baseBranch to createAndCheckoutBranch", async () => {
      const { service, controller } = makeService({ config: { baseBranch: "develop" } });
      await service.createBranch("my-spec", "slug");
      const createCall = controller.calls.find((c) => c.method === "createAndCheckoutBranch");
      expect((createCall?.args as string[])[1]).toBe("develop");
    });
  });

  describe("branch name validation", () => {
    it("returns validation error when derived branch name is invalid", async () => {
      const { service } = makeService({
        validator: { isValidBranchName: () => false },
      });
      const result = await service.createBranch("my-spec", "slug");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe("validation");
        expect(result.error.message).toContain("Invalid branch name");
      }
    });

    it("does not call detectChanges when branch name is invalid", async () => {
      const { service, controller } = makeService({
        validator: { isValidBranchName: () => false },
      });
      await service.createBranch("my-spec", "slug");
      expect(controller.calls.find((c) => c.method === "detectChanges")).toBeUndefined();
    });
  });

  describe("dirty working directory check", () => {
    it("returns error when staged files exist", async () => {
      const { service } = makeService({
        controller: {
          detectChanges: async () => ({ ok: true, value: makeDirtyChanges("staged") }),
        },
      });
      const result = await service.createBranch("my-spec", "slug");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("dirty-working-directory");
      }
    });

    it("returns error when unstaged files exist", async () => {
      const { service } = makeService({
        controller: {
          detectChanges: async () => ({ ok: true, value: makeDirtyChanges("unstaged") }),
        },
      });
      const result = await service.createBranch("my-spec", "slug");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("dirty-working-directory");
      }
    });

    it("returns error when untracked files exist", async () => {
      const { service } = makeService({
        controller: {
          detectChanges: async () => ({ ok: true, value: makeDirtyChanges("untracked") }),
        },
      });
      const result = await service.createBranch("my-spec", "slug");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("dirty-working-directory");
      }
    });

    it("propagates detectChanges error when detectChanges fails", async () => {
      const { service } = makeService({
        controller: {
          detectChanges: async () => ({
            ok: false,
            error: { type: "runtime", message: "git status failed" },
          }),
        },
      });
      const result = await service.createBranch("my-spec", "slug");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("git status failed");
      }
    });

    it("does not call listBranches when working directory is dirty", async () => {
      const { service, controller } = makeService({
        controller: {
          detectChanges: async () => ({ ok: true, value: makeDirtyChanges("staged") }),
        },
      });
      await service.createBranch("my-spec", "slug");
      expect(controller.calls.find((c) => c.method === "listBranches")).toBeUndefined();
    });
  });

  describe("branch name collision resolution", () => {
    it("uses original name when no collision exists", async () => {
      const { service, controller } = makeService({
        controller: {
          listBranches: async () => ({ ok: true, value: ["main", "other-branch"] }),
        },
      });
      await service.createBranch("my-spec", "slug");
      const createCall = controller.calls.find((c) => c.method === "createAndCheckoutBranch");
      expect((createCall?.args as string[])[0]).toBe("agent/my-spec");
    });

    it("appends -2 suffix when original name already exists", async () => {
      const { service, controller: _controller } = makeService({
        controller: {
          listBranches: async () => ({ ok: true, value: ["agent/my-spec"] }),
        },
      });
      const result = await service.createBranch("my-spec", "slug");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.branchName).toBe("agent/my-spec-2");
        expect(result.value.conflictResolved).toBe(true);
      }
    });

    it("appends -3 suffix when -2 also exists", async () => {
      const { service, controller: _controller } = makeService({
        controller: {
          listBranches: async () => ({ ok: true, value: ["agent/my-spec", "agent/my-spec-2"] }),
        },
      });
      const result = await service.createBranch("my-spec", "slug");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.branchName).toBe("agent/my-spec-3");
      }
    });

    it("calls createAndCheckoutBranch with resolved name", async () => {
      const { service, controller } = makeService({
        controller: {
          listBranches: async () => ({ ok: true, value: ["agent/my-spec"] }),
        },
      });
      await service.createBranch("my-spec", "slug");
      const createCall = controller.calls.find((c) => c.method === "createAndCheckoutBranch");
      expect((createCall?.args as string[])[0]).toBe("agent/my-spec-2");
    });

    it("propagates listBranches error when listBranches fails", async () => {
      const { service } = makeService({
        controller: {
          listBranches: async () => ({
            ok: false,
            error: { type: "runtime", message: "branch list failed" },
          }),
        },
      });
      const result = await service.createBranch("my-spec", "slug");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("branch list failed");
      }
    });

    it("sets conflictResolved to false when no collision occurred", async () => {
      const { service } = makeService();
      const result = await service.createBranch("my-spec", "slug");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.conflictResolved).toBe(false);
      }
    });
  });

  describe("success path — event and audit", () => {
    it("emits branch-created event on successful branch creation", async () => {
      const { service, eventBus } = makeService();
      await service.createBranch("my-spec", "slug");
      const event = eventBus.emitted.find((e) => e.type === "branch-created");
      expect(event).toBeDefined();
      if (event?.type === "branch-created") {
        expect(event.branchName).toBe("agent/my-spec");
        expect(event.baseBranch).toBe("main");
        expect(typeof event.timestamp).toBe("string");
      }
    });

    it("emits branch-created event with resolved name when collision occurred", async () => {
      const { service, eventBus } = makeService({
        controller: {
          listBranches: async () => ({ ok: true, value: ["agent/my-spec"] }),
        },
      });
      await service.createBranch("my-spec", "slug");
      const event = eventBus.emitted.find((e) => e.type === "branch-created");
      if (event?.type === "branch-created") {
        expect(event.branchName).toBe("agent/my-spec-2");
      }
    });

    it("writes audit entry with toolName=create-branch on success", async () => {
      const { service, auditLogger } = makeService();
      await service.createBranch("my-spec", "slug");
      expect(auditLogger.entries.length).toBe(1);
      expect(auditLogger.entries[0]?.toolName).toBe("create-branch");
      expect(auditLogger.entries[0]?.outcome).toBe("success");
      expect(auditLogger.entries[0]?.sessionId).toBe("test-session-id");
    });

    it("returns Ok(BranchCreationResult) on success", async () => {
      const { service } = makeService();
      const result = await service.createBranch("my-spec", "slug");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.branchName).toBe("agent/my-spec");
        expect(result.value.baseBranch).toBe("main");
      }
    });
  });

  describe("failure path — consecutive failure tracking", () => {
    it("propagates createAndCheckoutBranch error when it fails", async () => {
      const { service } = makeService({
        controller: {
          createAndCheckoutBranch: async () => ({
            ok: false,
            error: { type: "runtime", message: "branch create failed" },
          }),
        },
      });
      const result = await service.createBranch("my-spec", "slug");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("branch create failed");
      }
    });

    it("does not emit branch-created event when createAndCheckoutBranch fails", async () => {
      const { service, eventBus } = makeService({
        controller: {
          createAndCheckoutBranch: async () => ({
            ok: false,
            error: { type: "runtime", message: "failed" },
          }),
        },
      });
      await service.createBranch("my-spec", "slug");
      expect(eventBus.emitted.find((e) => e.type === "branch-created")).toBeUndefined();
    });

    it("does not write audit entry when createAndCheckoutBranch fails", async () => {
      const { service, auditLogger } = makeService({
        controller: {
          createAndCheckoutBranch: async () => ({
            ok: false,
            error: { type: "runtime", message: "failed" },
          }),
        },
      });
      await service.createBranch("my-spec", "slug");
      expect(auditLogger.entries.length).toBe(0);
    });

    it("emits repeated-git-failure after 3 consecutive createAndCheckoutBranch failures", async () => {
      const eventBus = makeEventBus();
      const { service } = makeService({
        controller: {
          createAndCheckoutBranch: async () => ({
            ok: false,
            error: { type: "runtime", message: "branch create failed" },
          }),
        },
        eventBus,
      });
      await service.createBranch("my-spec", "slug");
      await service.createBranch("my-spec", "slug");
      await service.createBranch("my-spec", "slug");
      const failureEvent = eventBus.emitted.find((e) => e.type === "repeated-git-failure");
      expect(failureEvent).toBeDefined();
      if (failureEvent?.type === "repeated-git-failure") {
        expect(failureEvent.operation).toBe("create-branch");
        expect(failureEvent.attemptCount).toBe(3);
      }
    });

    it("does not emit repeated-git-failure on the second failure (only at 3)", async () => {
      const eventBus = makeEventBus();
      const { service } = makeService({
        controller: {
          createAndCheckoutBranch: async () => ({
            ok: false,
            error: { type: "runtime", message: "failed" },
          }),
        },
        eventBus,
      });
      await service.createBranch("my-spec", "slug");
      await service.createBranch("my-spec", "slug");
      const failureEvent = eventBus.emitted.find((e) => e.type === "repeated-git-failure");
      expect(failureEvent).toBeUndefined();
    });

    it("resets consecutive failure count to 0 on successful branch creation", async () => {
      const eventBus = makeEventBus();
      let callNumber = 0;
      const { service } = makeService({
        controller: {
          // Calls 1 & 2: fail (count rises to 2)
          // Call 3: success (resets count to 0)
          // Calls 4, 5, 6: fail (count rises to 3 → triggers repeated-git-failure)
          createAndCheckoutBranch: async (...args) => {
            callNumber++;
            if (callNumber === 3) {
              const [branchName, baseBranch] = args as [string, string];
              return { ok: true, value: { branchName, baseBranch, conflictResolved: false } };
            }
            return { ok: false, error: { type: "runtime", message: "failed" } };
          },
        },
        eventBus,
      });
      // Two failures followed by success
      await service.createBranch("my-spec", "slug");
      await service.createBranch("my-spec", "slug");
      await service.createBranch("my-spec", "slug"); // success - should reset count

      // After reset, 3 more failures should trigger repeated-git-failure event starting from 1
      await service.createBranch("my-spec", "slug");
      await service.createBranch("my-spec", "slug");
      await service.createBranch("my-spec", "slug"); // 3rd failure after reset

      // Should have emitted repeated-git-failure exactly once (after the 3 post-reset failures)
      const failureEvents = eventBus.emitted.filter((e) => e.type === "repeated-git-failure");
      expect(failureEvents.length).toBe(1);
    });
  });
});
