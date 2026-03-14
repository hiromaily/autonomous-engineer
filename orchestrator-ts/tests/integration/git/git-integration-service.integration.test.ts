/**
 * Integration tests for GitIntegrationService full workflow with stubs
 *
 * Task 10.2: Full workflow orchestration, event emission, and audit logging verification
 *
 * Integration scope:
 * - Real GitIntegrationService
 * - Stub IGitController (configured per test — success or failure)
 * - Stub IPullRequestProvider (configured per test)
 * - Stub LlmProviderPort
 * - Real GitEventBus (captures events in registration order)
 * - Real GitValidator
 * - Stub IAuditLogger (captures writes for assertion)
 *
 * Requirements: 1.6, 2.8, 3.5, 4.6, 6.2, 6.5
 */

import { describe, expect, it } from "bun:test";

import { GitIntegrationService } from "../../../application/git/git-integration-service";
import type { GitWorkflowParams } from "../../../application/git/git-integration-service";
import type { IGitController } from "../../../application/ports/git-controller";
import type { IPullRequestProvider } from "../../../application/ports/pr-provider";
import type { IAuditLogger, AuditEntry } from "../../../application/safety/ports";
import type { LlmProviderPort } from "../../../application/ports/llm";
import { GitValidator } from "../../../domain/git/git-validator";
import type { GitEvent, GitIntegrationConfig, PullRequestResult } from "../../../domain/git/types";
import { GitEventBus } from "../../../infra/events/git-event-bus";

// ---------------------------------------------------------------------------
// Shared helpers
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
 * Creates a stub IGitController that succeeds for all operations.
 * detectChanges alternates between clean (1st call, for createBranch) and
 * dirty with staged files (2nd call, for generateAndCommit).
 */
function makeSuccessController(): IGitController {
  let detectChangesCount = 0;
  return {
    listBranches: async () => ({ ok: true, value: [] }),
    detectChanges: async () => {
      detectChangesCount++;
      if (detectChangesCount === 1) {
        // First call from createBranch: clean working directory
        return { ok: true, value: { staged: [], unstaged: [], untracked: [] } };
      }
      // Subsequent calls from generateAndCommit: staged files present
      return { ok: true, value: { staged: ["src/impl.ts"], unstaged: [], untracked: [] } };
    },
    createAndCheckoutBranch: async (branchName, baseBranch) => ({
      ok: true,
      value: { branchName, baseBranch, conflictResolved: false },
    }),
    stageAndCommit: async (files, message) => ({
      ok: true,
      value: { hash: "abc123def456", message, fileCount: files.length },
    }),
    push: async (branchName, remote) => ({
      ok: true,
      value: { branchName, remote, commitHash: "abc123def456" },
    }),
  };
}

function makeSuccessPrProvider(): IPullRequestProvider {
  return {
    createOrUpdate: async () => ({ ok: true, value: DEFAULT_PR_RESULT }),
  };
}

/** LLM stub that returns plain text for commit messages and JSON for PR content. */
function makeSuccessLlm(): LlmProviderPort {
  let callCount = 0;
  return {
    complete: async () => {
      callCount++;
      // First LLM call is from generateAndCommit (commit message), second from createOrUpdatePullRequest (PR content)
      const content =
        callCount === 1
          ? "feat: implement my-spec feature"
          : JSON.stringify({ title: "feat: implement my-spec", body: "## Summary\nPR body content." });
      return {
        ok: true as const,
        value: { content, usage: { inputTokens: 10, outputTokens: 5 } },
      };
    },
    clearContext: () => {},
  };
}

function makeAuditLogger(): IAuditLogger & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    write: async (entry: AuditEntry) => {
      entries.push(entry);
    },
    flush: async () => {},
  };
}

interface ServiceFixture {
  service: GitIntegrationService;
  eventBus: GitEventBus;
  auditLogger: IAuditLogger & { entries: AuditEntry[] };
}

function makeService(overrides?: {
  controller?: IGitController;
  prProvider?: IPullRequestProvider;
  llm?: LlmProviderPort;
  eventBus?: GitEventBus;
  auditLogger?: IAuditLogger & { entries: AuditEntry[] };
}): ServiceFixture {
  const eventBus = overrides?.eventBus ?? new GitEventBus();
  const auditLogger = overrides?.auditLogger ?? makeAuditLogger();
  const service = new GitIntegrationService(
    overrides?.controller ?? makeSuccessController(),
    overrides?.prProvider ?? makeSuccessPrProvider(),
    overrides?.llm ?? makeSuccessLlm(),
    eventBus,
    auditLogger,
    new GitValidator(),
    makeConfig(),
    "test-session",
  );
  return { service, eventBus, auditLogger };
}

// ---------------------------------------------------------------------------
// Test group 1: Full workflow event emission sequence
// ---------------------------------------------------------------------------

describe("GitIntegrationService.runFullWorkflow — event emission sequence", () => {
  it("emits branch-created → commit-created → branch-pushed → pull-request-created in order", async () => {
    const capturedEvents: GitEvent[] = [];
    const { service, eventBus } = makeService();
    eventBus.on((event) => capturedEvents.push(event));

    const result = await service.runFullWorkflow(makeWorkflowParams());

    expect(result.ok).toBe(true);

    const eventTypes = capturedEvents.map((e) => e.type);
    expect(eventTypes).toContain("branch-created");
    expect(eventTypes).toContain("commit-created");
    expect(eventTypes).toContain("branch-pushed");
    expect(eventTypes).toContain("pull-request-created");

    // Verify strict ordering
    const idx = (t: string) => eventTypes.indexOf(t);
    expect(idx("branch-created")).toBeLessThan(idx("commit-created"));
    expect(idx("commit-created")).toBeLessThan(idx("branch-pushed"));
    expect(idx("branch-pushed")).toBeLessThan(idx("pull-request-created"));
  });

  it("returns the PullRequestResult value on full success", async () => {
    const { service } = makeService();

    const result = await service.runFullWorkflow(makeWorkflowParams());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.url).toBe(DEFAULT_PR_RESULT.url);
      expect(result.value.targetBranch).toBe(DEFAULT_PR_RESULT.targetBranch);
    }
  });

  it("emits branch-created event with the correct branch name and base branch", async () => {
    const capturedEvents: GitEvent[] = [];
    const { service, eventBus } = makeService();
    eventBus.on((event) => capturedEvents.push(event));

    await service.runFullWorkflow(makeWorkflowParams({ specName: "test-spec" }));

    const branchCreatedEvent = capturedEvents.find((e) => e.type === "branch-created");
    expect(branchCreatedEvent).toBeDefined();
    if (branchCreatedEvent?.type === "branch-created") {
      expect(branchCreatedEvent.branchName).toBe("agent/test-spec");
      expect(branchCreatedEvent.baseBranch).toBe("main");
    }
  });

  it("emits pull-request-created event with the PR URL from the provider", async () => {
    const capturedEvents: GitEvent[] = [];
    const { service, eventBus } = makeService();
    eventBus.on((event) => capturedEvents.push(event));

    await service.runFullWorkflow(makeWorkflowParams());

    const prCreatedEvent = capturedEvents.find((e) => e.type === "pull-request-created");
    expect(prCreatedEvent).toBeDefined();
    if (prCreatedEvent?.type === "pull-request-created") {
      expect(prCreatedEvent.url).toBe(DEFAULT_PR_RESULT.url);
    }
  });
});

// ---------------------------------------------------------------------------
// Test group 2: Consecutive failure escalation
// ---------------------------------------------------------------------------

describe("GitIntegrationService — consecutive failure escalation", () => {
  it("emits repeated-git-failure with attemptCount ≥ 3 after 3 identical createBranch failures", async () => {
    const capturedEvents: GitEvent[] = [];

    // Controller that always fails createAndCheckoutBranch
    const failController: IGitController = {
      listBranches: async () => ({ ok: true, value: [] }),
      detectChanges: async () => ({ ok: true, value: { staged: [], unstaged: [], untracked: [] } }),
      createAndCheckoutBranch: async () => ({
        ok: false,
        error: { type: "runtime" as const, message: "git command failed" },
      }),
      stageAndCommit: async () => ({
        ok: false,
        error: { type: "runtime" as const, message: "should not be reached" },
      }),
      push: async () => ({
        ok: false,
        error: { type: "runtime" as const, message: "should not be reached" },
      }),
    };

    const eventBus = new GitEventBus();
    eventBus.on((event) => capturedEvents.push(event));

    const service = new GitIntegrationService(
      failController,
      makeSuccessPrProvider(),
      makeSuccessLlm(),
      eventBus,
      makeAuditLogger(),
      new GitValidator(),
      makeConfig(),
      "test-session",
    );

    // Three consecutive failures should trigger the repeated-git-failure event
    await service.createBranch("my-spec", "my-task");
    await service.createBranch("my-spec", "my-task");
    await service.createBranch("my-spec", "my-task");

    const repeatedFailureEvents = capturedEvents.filter((e) => e.type === "repeated-git-failure");
    expect(repeatedFailureEvents.length).toBeGreaterThanOrEqual(1);

    const thirdAttemptEvent = repeatedFailureEvents.find(
      (e) => e.type === "repeated-git-failure" && e.attemptCount >= 3,
    );
    expect(thirdAttemptEvent).toBeDefined();
    if (thirdAttemptEvent?.type === "repeated-git-failure") {
      expect(thirdAttemptEvent.operation).toBe("create-branch");
      expect(thirdAttemptEvent.attemptCount).toBe(3);
    }
  });

  it("emits repeated-git-failure for push after 3 full-workflow runs that each fail at push", async () => {
    const capturedEvents: GitEvent[] = [];

    // Controller: createBranch and commit succeed; push always fails
    let detectCount = 0;
    const failPushController: IGitController = {
      listBranches: async () => ({ ok: true, value: [] }),
      detectChanges: async () => {
        detectCount++;
        // Odd calls from createBranch: clean; even calls from generateAndCommit: dirty
        if (detectCount % 2 === 1) {
          return { ok: true, value: { staged: [], unstaged: [], untracked: [] } };
        }
        return { ok: true, value: { staged: ["src/impl.ts"], unstaged: [], untracked: [] } };
      },
      createAndCheckoutBranch: async (branchName, baseBranch) => ({
        ok: true,
        value: { branchName, baseBranch, conflictResolved: false },
      }),
      stageAndCommit: async (files, message) => ({
        ok: true,
        value: { hash: "abc123", message, fileCount: files.length },
      }),
      push: async () => ({
        ok: false,
        error: {
          type: "runtime" as const,
          message: "To origin\n ! [rejected] HEAD -> main (non-fast-forward)",
          details: { reason: "non-fast-forward" },
        },
      }),
    };

    const eventBus = new GitEventBus();
    eventBus.on((event) => capturedEvents.push(event));

    // Reset LLM call count for each run by using separate instances
    const service = new GitIntegrationService(
      failPushController,
      makeSuccessPrProvider(),
      makeSuccessLlm(),
      eventBus,
      makeAuditLogger(),
      new GitValidator(),
      makeConfig(),
      "test-session",
    );

    // Three workflow runs — each fails at push
    await service.runFullWorkflow(makeWorkflowParams());
    await service.runFullWorkflow(makeWorkflowParams());
    await service.runFullWorkflow(makeWorkflowParams());

    // repeated-git-failure must have been emitted at least once for push
    const repeatedFailureEvents = capturedEvents.filter((e) => e.type === "repeated-git-failure");
    expect(repeatedFailureEvents.length).toBeGreaterThanOrEqual(1);

    const pushFailureEvent = repeatedFailureEvents.find(
      (e) => e.type === "repeated-git-failure" && e.operation === "push" && e.attemptCount >= 3,
    );
    expect(pushFailureEvent).toBeDefined();
    if (pushFailureEvent?.type === "repeated-git-failure") {
      expect(pushFailureEvent.operation).toBe("push");
      expect(pushFailureEvent.attemptCount).toBe(3);
    }
  });

  it("resets consecutive failure count on next success", async () => {
    const capturedEvents: GitEvent[] = [];

    let callCount = 0;
    // Controller: fail twice, then succeed on third
    const intermittentController: IGitController = {
      listBranches: async () => ({ ok: true, value: [] }),
      detectChanges: async () => ({ ok: true, value: { staged: [], unstaged: [], untracked: [] } }),
      createAndCheckoutBranch: async (branchName, baseBranch) => {
        callCount++;
        if (callCount <= 2) {
          return { ok: false, error: { type: "runtime" as const, message: "transient failure" } };
        }
        return { ok: true, value: { branchName, baseBranch, conflictResolved: false } };
      },
      stageAndCommit: async () => ({
        ok: false,
        error: { type: "runtime" as const, message: "should not be reached" },
      }),
      push: async () => ({
        ok: false,
        error: { type: "runtime" as const, message: "should not be reached" },
      }),
    };

    const eventBus = new GitEventBus();
    eventBus.on((event) => capturedEvents.push(event));

    const service = new GitIntegrationService(
      intermittentController,
      makeSuccessPrProvider(),
      makeSuccessLlm(),
      eventBus,
      makeAuditLogger(),
      new GitValidator(),
      makeConfig(),
      "test-session",
    );

    await service.createBranch("my-spec", "my-task"); // fails (consecutive count = 1)
    await service.createBranch("my-spec", "my-task"); // fails (consecutive count = 2)
    const successResult = await service.createBranch("my-spec", "my-task"); // succeeds → resets count to 0

    expect(successResult.ok).toBe(true);

    // Only 2 consecutive failures occurred before the reset — never reached the threshold of 3,
    // so no repeated-git-failure event should have been emitted at all.
    const repeatedEvents = capturedEvents.filter(
      (e) => e.type === "repeated-git-failure" && e.attemptCount >= 3,
    );
    expect(repeatedEvents.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test group 3: IAuditLogger.write called once per successful operation
// ---------------------------------------------------------------------------

describe("GitIntegrationService.runFullWorkflow — audit logging", () => {
  it("calls IAuditLogger.write once per successful stage with correct toolName and outcome", async () => {
    const auditLogger = makeAuditLogger();
    const { service } = makeService({ auditLogger });

    await service.runFullWorkflow(makeWorkflowParams());

    // Expect exactly 4 audit entries: create-branch, commit, push, create-pr
    expect(auditLogger.entries.length).toBe(4);

    const toolNames = auditLogger.entries.map((e) => e.toolName);
    expect(toolNames).toContain("create-branch");
    expect(toolNames).toContain("commit");
    expect(toolNames).toContain("push");
    expect(toolNames).toContain("create-pr");

    // All entries must carry the success outcome
    for (const entry of auditLogger.entries) {
      expect(entry.outcome).toBe("success");
    }

    // All entries must carry the correct session ID
    for (const entry of auditLogger.entries) {
      expect(entry.sessionId).toBe("test-session");
    }
  });

  it("does not write audit entries for failed operations", async () => {
    const auditLogger = makeAuditLogger();

    let detectCount = 0;
    // Controller fails at push; create-branch and commit succeed
    const failAtPushController: IGitController = {
      listBranches: async () => ({ ok: true, value: [] }),
      detectChanges: async () => {
        detectCount++;
        if (detectCount === 1) {
          // First call: clean for createBranch
          return { ok: true, value: { staged: [], unstaged: [], untracked: [] } };
        }
        return { ok: true, value: { staged: ["src/impl.ts"], unstaged: [], untracked: [] } };
      },
      createAndCheckoutBranch: async (branchName, baseBranch) => ({
        ok: true,
        value: { branchName, baseBranch, conflictResolved: false },
      }),
      stageAndCommit: async (files, message) => ({
        ok: true,
        value: { hash: "abc123", message, fileCount: files.length },
      }),
      push: async () => ({
        ok: false,
        error: { type: "runtime" as const, message: "push failed" },
      }),
    };

    const service = new GitIntegrationService(
      failAtPushController,
      makeSuccessPrProvider(),
      makeSuccessLlm(),
      new GitEventBus(),
      auditLogger,
      new GitValidator(),
      makeConfig(),
      "test-session",
    );

    const result = await service.runFullWorkflow(makeWorkflowParams());
    expect(result.ok).toBe(false);

    // create-branch and commit should be logged; push and create-pr should not
    const toolNames = auditLogger.entries.map((e) => e.toolName);
    expect(toolNames).toContain("create-branch");
    expect(toolNames).toContain("commit");
    expect(toolNames).not.toContain("push");
    expect(toolNames).not.toContain("create-pr");
  });

  it("writes audit entries in chronological order matching the workflow stages", async () => {
    const auditLogger = makeAuditLogger();
    const { service } = makeService({ auditLogger });

    await service.runFullWorkflow(makeWorkflowParams());

    const toolNames = auditLogger.entries.map((e) => e.toolName);
    expect(toolNames[0]).toBe("create-branch");
    expect(toolNames[1]).toBe("commit");
    expect(toolNames[2]).toBe("push");
    expect(toolNames[3]).toBe("create-pr");
  });
});
