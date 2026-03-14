// ---------------------------------------------------------------------------
// GitIntegrationService — Task 5.4: PR creation/update with LLM content generation
// tests/application/git/git-integration-service-5.4.test.ts
// ---------------------------------------------------------------------------

import { GitIntegrationService } from "@/application/git/git-integration-service";
import type { GitWorkflowParams } from "@/application/git/git-integration-service";
import type { IGitController } from "@/application/ports/git-controller";
import type { IGitEventBus } from "@/application/ports/git-event-bus";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { IPullRequestProvider, PrResult } from "@/application/ports/pr-provider";
import type { AuditEntry, IAuditLogger } from "@/application/safety/ports";
import type { IGitValidator } from "@/domain/git/git-validator";
import type { GitEvent, GitIntegrationConfig, PullRequestParams, PullRequestResult } from "@/domain/git/types";
import type { PermissionSet } from "@/domain/tools/types";
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
    completedTasks: ["Task 1: Setup", "Task 2: Implement"],
    isDraft: false,
    ...overrides,
  };
}

function makePermissions(overrides?: Partial<PermissionSet>): PermissionSet {
  return {
    filesystemRead: true,
    filesystemWrite: true,
    shellExecution: false,
    gitWrite: true,
    networkAccess: true,
    ...overrides,
  };
}

const DEFAULT_PR_RESULT: PullRequestResult = {
  url: "https://github.com/owner/repo/pull/42",
  title: "feat: implement my-spec",
  targetBranch: "main",
  isDraft: false,
};

function makePrProvider(result?: PrResult): IPullRequestProvider & {
  calls: Array<{ method: string; params: PullRequestParams }>;
} {
  const calls: Array<{ method: string; params: PullRequestParams }> = [];
  return {
    calls,
    createOrUpdate: async (params) => {
      calls.push({ method: "createOrUpdate", params });
      return result ?? { ok: true, value: DEFAULT_PR_RESULT };
    },
  };
}

function makeLlmWithJson(title = "feat: implement my-spec", body = "PR description"): LlmProviderPort & {
  prompts: string[];
} {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (prompt) => {
      prompts.push(prompt);
      return {
        ok: true,
        value: {
          content: JSON.stringify({ title, body }),
          usage: { inputTokens: 20, outputTokens: 10 },
        },
      };
    },
    clearContext: () => {},
  };
}

function makeGitController(): IGitController {
  return {
    listBranches: async () => ({ ok: true, value: [] }),
    detectChanges: async () => ({ ok: true, value: { staged: [], unstaged: [], untracked: [] } }),
    createAndCheckoutBranch: async (b, base) => ({
      ok: true,
      value: { branchName: b, baseBranch: base, conflictResolved: false },
    }),
    stageAndCommit: async () => ({ ok: false, error: { type: "runtime", message: "n/a" } }),
    push: async () => ({ ok: false, error: { type: "runtime", message: "n/a" } }),
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
  return {
    entries,
    write: async (e) => {
      entries.push(e);
    },
    flush: async () => {},
  };
}

function makeService(overrides?: {
  prProvider?: IPullRequestProvider & { calls: Array<{ method: string; params: PullRequestParams }> };
  llm?: LlmProviderPort & { prompts: string[] };
  eventBus?: IGitEventBus & { emitted: GitEvent[] };
  auditLogger?: IAuditLogger & { entries: AuditEntry[] };
  config?: Partial<GitIntegrationConfig>;
  permissions?: PermissionSet;
}): {
  service: GitIntegrationService;
  prProvider: IPullRequestProvider & { calls: Array<{ method: string; params: PullRequestParams }> };
  llm: LlmProviderPort & { prompts: string[] };
  eventBus: IGitEventBus & { emitted: GitEvent[] };
  auditLogger: IAuditLogger & { entries: AuditEntry[] };
} {
  const prProvider = overrides?.prProvider ?? makePrProvider();
  const llm = overrides?.llm ?? makeLlmWithJson();
  const eventBus = overrides?.eventBus ?? makeEventBus();
  const auditLogger = overrides?.auditLogger ?? makeAuditLogger();
  const permissions = overrides?.permissions ?? makePermissions();

  const service = new GitIntegrationService(
    makeGitController(),
    prProvider,
    llm,
    eventBus,
    auditLogger,
    makeValidator(),
    makeConfig(overrides?.config),
    "test-session-id",
    permissions,
  );
  return { service, prProvider, llm, eventBus, auditLogger };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitIntegrationService.createOrUpdatePullRequest — task 5.4", () => {
  describe("permission check", () => {
    it("returns permission error when networkAccess is false", async () => {
      const { service } = makeService({
        permissions: makePermissions({ networkAccess: false }),
      });
      const result = await service.createOrUpdatePullRequest(makeWorkflowParams());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe("permission");
        expect(result.error.message).toContain("networkAccess");
      }
    });

    it("does not call LLM when networkAccess is false", async () => {
      const { service, llm } = makeService({
        permissions: makePermissions({ networkAccess: false }),
      });
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      expect(llm.prompts.length).toBe(0);
    });

    it("does not call IPullRequestProvider when networkAccess is false", async () => {
      const { service, prProvider } = makeService({
        permissions: makePermissions({ networkAccess: false }),
      });
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      expect(prProvider.calls.length).toBe(0);
    });

    it("proceeds when networkAccess is true", async () => {
      const { service } = makeService({
        permissions: makePermissions({ networkAccess: true }),
      });
      const result = await service.createOrUpdatePullRequest(makeWorkflowParams());
      expect(result.ok).toBe(true);
    });
  });

  describe("LLM prompt construction for PR", () => {
    it("includes specName in the PR body prompt", async () => {
      const { service, llm } = makeService();
      await service.createOrUpdatePullRequest(makeWorkflowParams({ specName: "awesome-spec" }));
      expect(llm.prompts[0]).toContain("awesome-spec");
    });

    it("includes completedTasks in the PR body prompt", async () => {
      const { service, llm } = makeService();
      await service.createOrUpdatePullRequest(
        makeWorkflowParams({ completedTasks: ["Task A: Setup", "Task B: Implement"] }),
      );
      expect(llm.prompts[0]).toContain("Task A: Setup");
      expect(llm.prompts[0]).toContain("Task B: Implement");
    });

    it("includes specArtifactPath in the PR body prompt", async () => {
      const { service, llm } = makeService();
      await service.createOrUpdatePullRequest(
        makeWorkflowParams({ specArtifactPath: ".kiro/specs/my-spec/tasks.md" }),
      );
      expect(llm.prompts[0]).toContain(".kiro/specs/my-spec/tasks.md");
    });

    it("asks LLM to return JSON with title and body fields", async () => {
      const { service, llm } = makeService();
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      expect(llm.prompts[0]).toContain("title");
      expect(llm.prompts[0]).toContain("body");
    });
  });

  describe("LLM response parsing", () => {
    it("parses JSON title and body from LLM response", async () => {
      const { service, prProvider } = makeService({
        llm: makeLlmWithJson("My PR Title", "My PR body text"),
      });
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      const call = prProvider.calls[0];
      expect(call?.params.title).toBe("My PR Title");
      expect(call?.params.body).toBe("My PR body text");
    });

    it("caps title at 72 characters", async () => {
      const longTitle = "a".repeat(100);
      const { service, prProvider } = makeService({
        llm: makeLlmWithJson(longTitle, "body"),
      });
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      const call = prProvider.calls[0];
      expect(call?.params.title.length).toBeLessThanOrEqual(72);
    });

    it("returns error when LLM call fails", async () => {
      const { service } = makeService({
        llm: {
          prompts: [],
          complete: async () => ({
            ok: false,
            error: { category: "api_error" as const, message: "LLM API error", originalError: null },
          }),
          clearContext: () => {},
        },
      });
      const result = await service.createOrUpdatePullRequest(makeWorkflowParams());
      expect(result.ok).toBe(false);
    });

    it("returns error when LLM response is not valid JSON", async () => {
      const { service } = makeService({
        llm: {
          prompts: [],
          complete: async () => ({
            ok: true,
            value: { content: "not valid json at all {broken", usage: { inputTokens: 5, outputTokens: 3 } },
          }),
          clearContext: () => {},
        },
      });
      const result = await service.createOrUpdatePullRequest(makeWorkflowParams());
      expect(result.ok).toBe(false);
    });
  });

  describe("PullRequestParams population", () => {
    it("sets specName from GitWorkflowParams", async () => {
      const { service, prProvider } = makeService();
      await service.createOrUpdatePullRequest(makeWorkflowParams({ specName: "test-spec" }));
      expect(prProvider.calls[0]?.params.specName).toBe("test-spec");
    });

    it("derives branchName from specName as agent/<specName>", async () => {
      const { service, prProvider } = makeService();
      await service.createOrUpdatePullRequest(makeWorkflowParams({ specName: "my-feature" }));
      expect(prProvider.calls[0]?.params.branchName).toBe("agent/my-feature");
    });

    it("uses taskSlug when specName is empty for branchName derivation", async () => {
      const { service, prProvider } = makeService();
      await service.createOrUpdatePullRequest(makeWorkflowParams({ specName: "", taskSlug: "my-slug" }));
      expect(prProvider.calls[0]?.params.branchName).toBe("agent/my-slug");
    });

    it("sets targetBranch to config.baseBranch", async () => {
      const { service, prProvider } = makeService({ config: { baseBranch: "develop" } });
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      expect(prProvider.calls[0]?.params.targetBranch).toBe("develop");
    });

    it("sets isDraft from GitWorkflowParams.isDraft when true", async () => {
      const { service, prProvider } = makeService();
      await service.createOrUpdatePullRequest(makeWorkflowParams({ isDraft: true }));
      expect(prProvider.calls[0]?.params.isDraft).toBe(true);
    });

    it("sets isDraft from GitWorkflowParams.isDraft when false", async () => {
      const { service, prProvider } = makeService();
      await service.createOrUpdatePullRequest(makeWorkflowParams({ isDraft: false }));
      expect(prProvider.calls[0]?.params.isDraft).toBe(false);
    });

    it("sets specArtifactPath from GitWorkflowParams", async () => {
      const { service, prProvider } = makeService();
      await service.createOrUpdatePullRequest(
        makeWorkflowParams({ specArtifactPath: ".kiro/specs/test/tasks.md" }),
      );
      expect(prProvider.calls[0]?.params.specArtifactPath).toBe(".kiro/specs/test/tasks.md");
    });

    it("sets completedTasks from GitWorkflowParams", async () => {
      const tasks = ["Task 1", "Task 2", "Task 3"];
      const { service, prProvider } = makeService();
      await service.createOrUpdatePullRequest(makeWorkflowParams({ completedTasks: tasks }));
      expect(prProvider.calls[0]?.params.completedTasks).toEqual(tasks);
    });
  });

  describe("auth failure handling", () => {
    it("emits pr-creation-auth-failed when PrProvider returns auth error", async () => {
      const { service, eventBus } = makeService({
        prProvider: makePrProvider({
          ok: false,
          error: { category: "auth", message: "401 Unauthorized", statusCode: 401 },
        }),
      });
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      const event = eventBus.emitted.find((e) => e.type === "pr-creation-auth-failed");
      expect(event).toBeDefined();
      if (event?.type === "pr-creation-auth-failed") {
        expect(event.provider).toBeDefined();
        expect(event.guidance).toBeDefined();
        expect(typeof event.timestamp).toBe("string");
      }
    });

    it("returns Err on auth failure", async () => {
      const { service } = makeService({
        prProvider: makePrProvider({ ok: false, error: { category: "auth", message: "unauthorized" } }),
      });
      const result = await service.createOrUpdatePullRequest(makeWorkflowParams());
      expect(result.ok).toBe(false);
    });

    it("propagates non-auth PR provider errors without emitting pr-creation-auth-failed", async () => {
      const { service, eventBus } = makeService({
        prProvider: makePrProvider({ ok: false, error: { category: "network", message: "connection refused" } }),
      });
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      expect(eventBus.emitted.find((e) => e.type === "pr-creation-auth-failed")).toBeUndefined();
    });
  });

  describe("success path — event and audit", () => {
    it("emits pull-request-created event on success", async () => {
      const { service, eventBus } = makeService();
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      const event = eventBus.emitted.find((e) => e.type === "pull-request-created");
      expect(event).toBeDefined();
      if (event?.type === "pull-request-created") {
        expect(event.url).toBe(DEFAULT_PR_RESULT.url);
        expect(event.title).toBe(DEFAULT_PR_RESULT.title);
        expect(event.targetBranch).toBe(DEFAULT_PR_RESULT.targetBranch);
        expect(typeof event.timestamp).toBe("string");
      }
    });

    it("writes audit entry with toolName=create-pr on success", async () => {
      const { service, auditLogger } = makeService();
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      expect(auditLogger.entries.length).toBe(1);
      expect(auditLogger.entries[0]?.toolName).toBe("create-pr");
      expect(auditLogger.entries[0]?.outcome).toBe("success");
      expect(auditLogger.entries[0]?.sessionId).toBe("test-session-id");
    });

    it("returns Ok(PullRequestResult) on success", async () => {
      const { service } = makeService();
      const result = await service.createOrUpdatePullRequest(makeWorkflowParams());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.url).toBe(DEFAULT_PR_RESULT.url);
        expect(result.value.title).toBe(DEFAULT_PR_RESULT.title);
      }
    });
  });

  describe("consecutive failure tracking for create-pr", () => {
    it("emits repeated-git-failure after 3 consecutive failures", async () => {
      const eventBus = makeEventBus();
      const { service } = makeService({
        prProvider: makePrProvider({ ok: false, error: { category: "api", message: "server error" } }),
        eventBus,
      });
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      const event = eventBus.emitted.find((e) => e.type === "repeated-git-failure");
      expect(event).toBeDefined();
      if (event?.type === "repeated-git-failure") {
        expect(event.operation).toBe("create-pr");
        expect(event.attemptCount).toBe(3);
      }
    });

    it("resets failure count after success", async () => {
      const eventBus = makeEventBus();
      let callNumber = 0;
      const _prProvider = makePrProvider();
      // Override createOrUpdate to fail for first 2, succeed for 3rd, then fail 3 more
      const _failThenSucceed = false;
      const customPr: IPullRequestProvider & { calls: Array<{ method: string; params: PullRequestParams }> } = {
        calls: [],
        createOrUpdate: async (params) => {
          customPr.calls.push({ method: "createOrUpdate", params });
          callNumber++;
          if (callNumber === 3) {
            return { ok: true, value: DEFAULT_PR_RESULT };
          }
          return { ok: false, error: { category: "api", message: "error" } };
        },
      };
      const { service } = makeService({ prProvider: customPr, eventBus });
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      await service.createOrUpdatePullRequest(makeWorkflowParams()); // success
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      await service.createOrUpdatePullRequest(makeWorkflowParams());
      await service.createOrUpdatePullRequest(makeWorkflowParams()); // 3rd fail after reset
      const failureEvents = eventBus.emitted.filter((e) => e.type === "repeated-git-failure");
      expect(failureEvents.length).toBe(1);
    });
  });
});
