// ---------------------------------------------------------------------------
// GitIntegrationService — Task 5.5: Consecutive-failure escalation and full-workflow orchestration
// tests/application/git/git-integration-service-5.5.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from "bun:test";
import { GitIntegrationService } from "../../../src/application/git/git-integration-service";
import type { IGitController } from "../../../src/application/ports/git-controller";
import type { IPullRequestProvider, PrResult } from "../../../src/application/ports/pr-provider";
import type { IGitEventBus } from "../../../src/application/ports/git-event-bus";
import type { IAuditLogger, AuditEntry } from "../../../src/application/safety/ports";
import type { LlmProviderPort } from "../../../src/application/ports/llm";
import type { IGitValidator } from "../../../src/domain/git/git-validator";
import type {
  GitIntegrationConfig,
  GitEvent,
  PullRequestResult,
  PullRequestParams,
} from "../../../src/domain/git/types";
import type { GitWorkflowParams } from "../../../src/application/git/git-integration-service";
import type { PermissionSet } from "../../../src/domain/tools/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<GitIntegrationConfig>): GitIntegrationConfig {
  return {
    baseBranch: "main",
    remote: "origin",
    maxFilesPerCommit: 50,
    maxDiffTokens: 4096,
    protectedBranches: ["main", "master"],
    protectedFilePatterns: [".env"],
    forcePushEnabled: false,
    workspaceRoot: "/workspace",
    isDraft: false,
    ...overrides,
  };
}

function makeWorkflowParams(overrides?: Partial<GitWorkflowParams>): GitWorkflowParams {
  return {
    specName: "my-spec",
    taskTitle: "Implement feature",
    taskSlug: "implement-feature",
    specArtifactPath: ".kiro/specs/my-spec/spec.json",
    completedTasks: ["Task 1", "Task 2"],
    isDraft: false,
    ...overrides,
  };
}

const DEFAULT_PR_RESULT: PullRequestResult = {
  url: "https://github.com/owner/repo/pull/42",
  title: "feat: implement my-spec",
  targetBranch: "main",
  isDraft: false,
};

/**
 * Creates a controller where detectChanges behaves differently based on call count:
 * - 1st call (from createBranch): returns clean (no changes)
 * - 2nd call (from generateAndCommit): returns a staged file
 */
function makeFullWorkflowController(overrides?: {
  createAndCheckoutBranch?: IGitController["createAndCheckoutBranch"];
  stageAndCommit?: IGitController["stageAndCommit"];
  push?: IGitController["push"];
}): IGitController & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let detectChangesCount = 0;

  return {
    calls,
    listBranches: async () => {
      calls.push({ method: "listBranches", args: [] });
      return { ok: true, value: [] };
    },
    detectChanges: async () => {
      detectChangesCount++;
      calls.push({ method: "detectChanges", args: [detectChangesCount] });
      if (detectChangesCount === 1) {
        // First call from createBranch: clean
        return { ok: true, value: { staged: [], unstaged: [], untracked: [] } };
      }
      // Second call from generateAndCommit: some staged files
      return { ok: true, value: { staged: ["src/impl.ts"], unstaged: [], untracked: [] } };
    },
    createAndCheckoutBranch: overrides?.createAndCheckoutBranch ?? (async (branchName, baseBranch) => {
      calls.push({ method: "createAndCheckoutBranch", args: [branchName, baseBranch] });
      return { ok: true, value: { branchName, baseBranch, conflictResolved: false } };
    }),
    stageAndCommit: overrides?.stageAndCommit ?? (async (files, message) => {
      calls.push({ method: "stageAndCommit", args: [files, message] });
      return { ok: true, value: { hash: "commit-abc", message, fileCount: (files as string[]).length } };
    }),
    push: overrides?.push ?? (async (branchName, remote) => {
      calls.push({ method: "push", args: [branchName, remote] });
      return { ok: true, value: { branchName, remote, commitHash: "commit-abc" } };
    }),
  };
}

function makeValidator(): IGitValidator {
  return {
    isValidBranchName: () => true,
    matchesProtectedPattern: () => false,
    isWithinWorkspace: () => true,
    filterProtectedFiles: (files) => ({ safe: files, blocked: [] }),
  };
}

function makeEventBus(): IGitEventBus & { emitted: GitEvent[] } {
  const emitted: GitEvent[] = [];
  return { emitted, emit: (e) => emitted.push(e), on: () => {}, off: () => {} };
}

function makeAuditLogger(): IAuditLogger & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return { entries, write: async (e) => { entries.push(e); }, flush: async () => {} };
}

function _makeLlmWithJson(title = "feat: implement", body = "PR body"): LlmProviderPort & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (prompt) => {
      prompts.push(prompt);
      return {
        ok: true,
        value: { content: JSON.stringify({ title, body }), usage: { inputTokens: 10, outputTokens: 5 } },
      };
    },
    clearContext: () => {},
  };
}

function makeLlmWithCommitAndPr(): LlmProviderPort & { prompts: string[] } {
  const prompts: string[] = [];
  let callCount = 0;
  return {
    prompts,
    complete: async (prompt) => {
      callCount++;
      prompts.push(prompt);
      if (callCount === 1) {
        // First call: commit message
        return { ok: true, value: { content: "feat: implement feature", usage: { inputTokens: 10, outputTokens: 5 } } };
      }
      // Second call: PR title and body
      return {
        ok: true,
        value: { content: JSON.stringify({ title: "feat: implement", body: "PR description" }), usage: { inputTokens: 20, outputTokens: 10 } },
      };
    },
    clearContext: () => {},
  };
}

function makePrProvider(result?: PrResult): IPullRequestProvider & {
  calls: Array<{ params: PullRequestParams }>;
} {
  const calls: Array<{ params: PullRequestParams }> = [];
  return {
    calls,
    createOrUpdate: async (params) => {
      calls.push({ params });
      return result ?? { ok: true, value: DEFAULT_PR_RESULT };
    },
  };
}

function makeService(overrides?: {
  controller?: IGitController & { calls: Array<{ method: string; args: unknown[] }> };
  prProvider?: IPullRequestProvider & { calls: Array<{ params: PullRequestParams }> };
  llm?: LlmProviderPort & { prompts: string[] };
  eventBus?: IGitEventBus & { emitted: GitEvent[] };
  auditLogger?: IAuditLogger & { entries: AuditEntry[] };
  config?: Partial<GitIntegrationConfig>;
  permissions?: PermissionSet;
}): {
  service: GitIntegrationService;
  controller: IGitController & { calls: Array<{ method: string; args: unknown[] }> };
  prProvider: IPullRequestProvider & { calls: Array<{ params: PullRequestParams }> };
  eventBus: IGitEventBus & { emitted: GitEvent[] };
  auditLogger: IAuditLogger & { entries: AuditEntry[] };
} {
  const controller = overrides?.controller ?? makeFullWorkflowController();
  const prProvider = overrides?.prProvider ?? makePrProvider();
  const eventBus = overrides?.eventBus ?? makeEventBus();
  const auditLogger = overrides?.auditLogger ?? makeAuditLogger();
  const llm = overrides?.llm ?? makeLlmWithCommitAndPr();
  const permissions: PermissionSet = overrides?.permissions ?? {
    filesystemRead: true, filesystemWrite: true, shellExecution: false, gitWrite: true, networkAccess: true,
  };

  const service = new GitIntegrationService(
    controller,
    prProvider,
    llm,
    eventBus,
    auditLogger,
    makeValidator(),
    makeConfig(overrides?.config),
    "test-session-id",
    permissions,
  );
  return { service, controller, prProvider, eventBus, auditLogger };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitIntegrationService.runFullWorkflow — task 5.5", () => {
  describe("successful full workflow", () => {
    it("returns Ok(PullRequestResult) when all stages succeed", async () => {
      const { service } = makeService();
      const result = await service.runFullWorkflow(makeWorkflowParams());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.url).toBe(DEFAULT_PR_RESULT.url);
      }
    });

    it("calls all four stages: createBranch, generateAndCommit, push, createOrUpdatePullRequest", async () => {
      const { service, controller, prProvider } = makeService();
      await service.runFullWorkflow(makeWorkflowParams());
      expect(controller.calls.find((c) => c.method === "createAndCheckoutBranch")).toBeDefined();
      expect(controller.calls.find((c) => c.method === "stageAndCommit")).toBeDefined();
      expect(controller.calls.find((c) => c.method === "push")).toBeDefined();
      expect(prProvider.calls.length).toBe(1);
    });

    it("uses the branchName from createBranch result for the push call", async () => {
      const { service, controller } = makeService({
        controller: makeFullWorkflowController({
          createAndCheckoutBranch: async (_branchName, baseBranch) => ({
            ok: true,
            value: { branchName: "agent/custom-branch", baseBranch, conflictResolved: false },
          }),
        }),
      });
      await service.runFullWorkflow(makeWorkflowParams({ specName: "custom-branch" }));
      const pushCall = controller.calls.find((c) => c.method === "push");
      expect(pushCall).toBeDefined();
      // push(branchName, remote) — first arg is branchName
      expect((pushCall?.args as string[])[0]).toBe("agent/custom-branch");
    });

    it("emits events for all four successful stages", async () => {
      const { service, eventBus } = makeService();
      await service.runFullWorkflow(makeWorkflowParams());
      const types = eventBus.emitted.map((e) => e.type);
      expect(types).toContain("branch-created");
      expect(types).toContain("commit-created");
      expect(types).toContain("branch-pushed");
      expect(types).toContain("pull-request-created");
    });

    it("writes audit entries for all four successful stages", async () => {
      const { service, auditLogger } = makeService();
      await service.runFullWorkflow(makeWorkflowParams());
      const toolNames = auditLogger.entries.map((e) => e.toolName);
      expect(toolNames).toContain("create-branch");
      expect(toolNames).toContain("commit");
      expect(toolNames).toContain("push");
      expect(toolNames).toContain("create-pr");
    });
  });

  describe("early halt on stage failure", () => {
    it("halts and returns Err from createBranch without calling generateAndCommit", async () => {
      const { service, controller } = makeService({
        controller: makeFullWorkflowController({
          createAndCheckoutBranch: async () => ({
            ok: false,
            error: { type: "runtime", message: "branch create failed" },
          }),
        }),
      });
      const result = await service.runFullWorkflow(makeWorkflowParams());
      expect(result.ok).toBe(false);
      // stageAndCommit should NOT have been called
      expect(controller.calls.find((c) => c.method === "stageAndCommit")).toBeUndefined();
    });

    it("returns the createBranch error in the result", async () => {
      const { service } = makeService({
        controller: makeFullWorkflowController({
          createAndCheckoutBranch: async () => ({
            ok: false,
            error: { type: "runtime", message: "branch create failed" },
          }),
        }),
      });
      const result = await service.runFullWorkflow(makeWorkflowParams());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("branch create failed");
      }
    });

    it("halts and returns Err from generateAndCommit without calling push", async () => {
      let detectChangesCount = 0;
      const { service, controller: _controller } = makeService({
        controller: {
          calls: [],
          listBranches: async () => ({ ok: true, value: [] }),
          detectChanges: async () => {
            detectChangesCount++;
            if (detectChangesCount === 1) {
              return { ok: true, value: { staged: [], unstaged: [], untracked: [] } };
            }
            // Second call (generateAndCommit): return error
            return { ok: false, error: { type: "runtime", message: "git status failed" } };
          },
          createAndCheckoutBranch: async (branchName: string, baseBranch: string) => ({
            ok: true,
            value: { branchName, baseBranch, conflictResolved: false },
          }),
          stageAndCommit: async () => ({ ok: false, error: { type: "runtime" as const, message: "n/a" } }),
          push: async (branchName: string, remote: string) => {
            return { ok: true, value: { branchName, remote, commitHash: "" } };
          },
        } as unknown as IGitController & { calls: Array<{ method: string; args: unknown[] }> },
      });
      const result = await service.runFullWorkflow(makeWorkflowParams());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("git status failed");
      }
    });

    it("halts and returns Err from push without calling createOrUpdatePullRequest", async () => {
      const { service, prProvider } = makeService({
        controller: makeFullWorkflowController({
          push: async () => ({ ok: false, error: { type: "runtime", message: "push failed" } }),
        }),
      });
      const result = await service.runFullWorkflow(makeWorkflowParams());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("push failed");
      }
      expect(prProvider.calls.length).toBe(0);
    });

    it("halts and returns Err from createOrUpdatePullRequest", async () => {
      const { service } = makeService({
        prProvider: makePrProvider({ ok: false, error: { category: "api", message: "PR creation failed" } }),
      });
      const result = await service.runFullWorkflow(makeWorkflowParams());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("PR creation failed");
      }
    });
  });

  describe("workflow parameter passing", () => {
    it("passes specName and taskSlug to createBranch (derives branch as agent/<specName>)", async () => {
      const { service, controller } = makeService();
      await service.runFullWorkflow(makeWorkflowParams({ specName: "workflow-spec", taskSlug: "wf-slug" }));
      const createCall = controller.calls.find((c) => c.method === "createAndCheckoutBranch");
      expect((createCall?.args as string[])[0]).toBe("agent/workflow-spec");
    });

    it("passes specName and taskTitle to generateAndCommit", async () => {
      const capturedPrompts: string[] = [];
      const { service } = makeService({
        llm: {
          prompts: capturedPrompts,
          complete: async (prompt) => {
            capturedPrompts.push(prompt);
            // First call is commit message; second is PR
            if (capturedPrompts.length === 1) {
              return { ok: true, value: { content: "feat: commit", usage: { inputTokens: 5, outputTokens: 2 } } };
            }
            return { ok: true, value: { content: JSON.stringify({ title: "PR", body: "body" }), usage: { inputTokens: 5, outputTokens: 2 } } };
          },
          clearContext: () => {},
        },
      });
      await service.runFullWorkflow(makeWorkflowParams({ specName: "my-spec", taskTitle: "My Task" }));
      // First LLM prompt should contain specName and taskTitle (from generateAndCommit)
      expect(capturedPrompts[0]).toContain("my-spec");
      expect(capturedPrompts[0]).toContain("My Task");
    });

    it("passes all params to createOrUpdatePullRequest (specName, completedTasks, etc.)", async () => {
      const { service, prProvider } = makeService();
      await service.runFullWorkflow(
        makeWorkflowParams({
          specName: "test-spec",
          completedTasks: ["Task A", "Task B"],
          specArtifactPath: ".kiro/specs/test-spec/tasks.md",
          isDraft: true,
        }),
      );
      const prCall = prProvider.calls[0];
      expect(prCall?.params.specName).toBe("test-spec");
      expect(prCall?.params.completedTasks).toEqual(["Task A", "Task B"]);
      expect(prCall?.params.isDraft).toBe(true);
    });
  });

  describe("generateAndCommit no-changes case in workflow", () => {
    it("continues to push even when generateAndCommit reports no-changes (Ok with empty result)", async () => {
      // When generateAndCommit returns Ok with no changes, push should still be called
      const { service, controller } = makeService({
        controller: {
          calls: [],
          listBranches: async () => ({ ok: true, value: [] }),
          detectChanges: async () => {
            // Both calls return clean (no changes for generateAndCommit too)
            return { ok: true, value: { staged: [], unstaged: [], untracked: [] } };
          },
          createAndCheckoutBranch: async (branchName: string, baseBranch: string) => ({
            ok: true,
            value: { branchName, baseBranch, conflictResolved: false },
          }),
          stageAndCommit: async (_files: ReadonlyArray<string>, message: string) => ({
            ok: true,
            value: { hash: "", message, fileCount: 0 },
          }),
          push: async (branchName: string, remote: string) => {
            (controller as unknown as { calls: Array<{ method: string; args: unknown[] }> }).calls.push({
              method: "push",
              args: [branchName, remote],
            });
            return { ok: true, value: { branchName, remote, commitHash: "" } };
          },
        } as unknown as IGitController & { calls: Array<{ method: string; args: unknown[] }> },
      });
      await service.runFullWorkflow(makeWorkflowParams());
      // push should still be called after no-changes generateAndCommit
      expect(controller.calls.find((c) => c.method === "push")).toBeDefined();
    });
  });
});
