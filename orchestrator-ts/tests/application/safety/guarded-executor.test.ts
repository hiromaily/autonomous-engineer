import { SafetyGuardedToolExecutor } from "@/application/safety/guarded-executor";
import type { AuditEntry, IApprovalGateway, IAuditLogger, ISandboxExecutor } from "@/application/safety/ports";
import type { IToolExecutor } from "@/application/tools/executor";
import { createSafetyConfig, createSafetySession } from "@/domain/safety/types";
import type { SafetyConfig, SafetySession } from "@/domain/safety/types";
import type { PermissionSet, ToolContext, ToolInvocationLog, ToolResult } from "@/domain/tools/types";
import { describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePermissions(): PermissionSet {
  return Object.freeze({
    filesystemRead: true,
    filesystemWrite: true,
    shellExecution: true,
    gitWrite: true,
    networkAccess: true,
  });
}

function makeLogger() {
  return {
    info: mock((_entry: ToolInvocationLog) => {}),
    error: mock((_entry: ToolInvocationLog) => {}),
  };
}

function makeContext(): ToolContext {
  return {
    workspaceRoot: "/workspace",
    workingDirectory: "/workspace",
    permissions: makePermissions(),
    memory: { search: async () => [] },
    logger: makeLogger(),
  };
}

function makeConfig(overrides: Partial<Parameters<typeof createSafetyConfig>[0]> = {}): SafetyConfig {
  return createSafetyConfig({ workspaceRoot: "/workspace", ...overrides });
}

function makeInnerExecutor(result: ToolResult<unknown> = { ok: true, value: { result: "ok" } }): IToolExecutor {
  return {
    invoke: mock(async () => result),
  };
}

function makeAuditLogger(): IAuditLogger & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    write: mock(async (entry: AuditEntry) => {
      entries.push(entry);
    }),
    flush: mock(async () => {}),
  };
}

function makeApprovalGateway(decision: "approved" | "denied" | "timeout" = "approved"): IApprovalGateway {
  return {
    requestApproval: mock(async () => decision),
  };
}

function makeSandboxExecutor(): ISandboxExecutor & { called: boolean } {
  let called = false;
  return {
    get called() {
      return called;
    },
    execute: mock(async () => {
      called = true;
      return { stdout: "ok", stderr: "", exitCode: 0, durationMs: 10 };
    }),
  };
}

function makeSession(overrides: Partial<SafetySession> = {}): SafetySession {
  const session = createSafetySession();
  Object.assign(session, overrides);
  return session;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SafetyGuardedToolExecutor", () => {
  // -------------------------------------------------------------------------
  // Guard pipeline pass-through
  // -------------------------------------------------------------------------

  describe("when all guards pass", () => {
    it("delegates to inner executor and returns its result", async () => {
      const inner = makeInnerExecutor({ ok: true, value: { result: "success" } });
      const auditLogger = makeAuditLogger();
      const executor = new SafetyGuardedToolExecutor(
        inner,
        makeSession(),
        makeConfig(),
        auditLogger,
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      const result = await executor.invoke("read_file", { path: "/workspace/foo.txt" }, makeContext());
      expect(result.ok).toBe(true);
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    });

    it("writes a success audit entry", async () => {
      const auditLogger = makeAuditLogger();
      const executor = new SafetyGuardedToolExecutor(
        makeInnerExecutor(),
        makeSession(),
        makeConfig(),
        auditLogger,
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      await executor.invoke("read_file", { path: "/workspace/foo.txt" }, makeContext());
      expect(auditLogger.entries.length).toBe(1);
      expect(auditLogger.entries[0]!.outcome).toBe("success");
      expect(auditLogger.entries[0]!.toolName).toBe("read_file");
    });

    it("increments session.iterationCount after execution", async () => {
      const session = makeSession();
      const executor = new SafetyGuardedToolExecutor(
        makeInnerExecutor(),
        session,
        makeConfig(),
        makeAuditLogger(),
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      expect(session.iterationCount).toBe(0);
      await executor.invoke("read_file", { path: "/workspace/foo.txt" }, makeContext());
      expect(session.iterationCount).toBe(1);
    });

    it("appends to toolInvocationTimestamps after execution", async () => {
      const session = makeSession();
      const executor = new SafetyGuardedToolExecutor(
        makeInnerExecutor(),
        session,
        makeConfig(),
        makeAuditLogger(),
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      await executor.invoke("read_file", { path: "/workspace/foo.txt" }, makeContext());
      expect(session.toolInvocationTimestamps.length).toBe(1);
    });

    it("increments repoWriteCount for git_branch_create", async () => {
      const session = makeSession();
      const executor = new SafetyGuardedToolExecutor(
        makeInnerExecutor(),
        session,
        makeConfig({ maxFilesPerCommit: 50 }),
        makeAuditLogger(),
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      // Use a non-git tool for simplicity (git_commit would run git subprocess checks)
      // Use git_branch_create with a valid name for a simpler repo-write counter test
      await executor.invoke("git_branch_create", { name: "agent/test-branch" }, makeContext());
      expect(session.repoWriteCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Emergency stop
  // -------------------------------------------------------------------------

  describe("when emergency stop is requested", () => {
    it("immediately rejects new invocations", async () => {
      const session = makeSession();
      session.emergencyStopRequested = true;
      const inner = makeInnerExecutor();
      const executor = new SafetyGuardedToolExecutor(
        inner,
        session,
        makeConfig(),
        makeAuditLogger(),
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      const result = await executor.invoke("read_file", { path: "/workspace/foo.txt" }, makeContext());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe("runtime");
        expect(result.error.message).toContain("emergency stop");
      }
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });

    it("writes an emergency-stop audit entry", async () => {
      const session = makeSession();
      session.emergencyStopRequested = true;
      const auditLogger = makeAuditLogger();
      const executor = new SafetyGuardedToolExecutor(
        makeInnerExecutor(),
        session,
        makeConfig(),
        auditLogger,
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      await executor.invoke("read_file", { path: "/workspace/foo.txt" }, makeContext());
      expect(auditLogger.entries.length).toBe(1);
      expect(auditLogger.entries[0]!.outcome).toBe("emergency-stop");
    });
  });

  // -------------------------------------------------------------------------
  // Guard blocks
  // -------------------------------------------------------------------------

  describe("when a guard blocks the invocation", () => {
    it("does not call the inner executor", async () => {
      const inner = makeInnerExecutor();
      // Path outside workspace will be blocked by WorkspaceIsolationGuard
      const executor = new SafetyGuardedToolExecutor(
        inner,
        makeSession(),
        makeConfig(),
        makeAuditLogger(),
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      const result = await executor.invoke("read_file", { path: "/etc/passwd" }, makeContext());
      expect(result.ok).toBe(false);
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });

    it("writes a blocked audit entry", async () => {
      const auditLogger = makeAuditLogger();
      const executor = new SafetyGuardedToolExecutor(
        makeInnerExecutor(),
        makeSession(),
        makeConfig(),
        auditLogger,
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      await executor.invoke("read_file", { path: "/etc/passwd" }, makeContext());
      expect(auditLogger.entries.length).toBe(1);
      expect(auditLogger.entries[0]!.outcome).toBe("blocked");
      expect(auditLogger.entries[0]!.blockReason).toBeDefined();
    });

    it("blocks when iteration limit is reached", async () => {
      const session = makeSession();
      const config = makeConfig({ maxIterations: 2 });
      session.iterationCount = 2; // at limit
      const inner = makeInnerExecutor();
      const executor = new SafetyGuardedToolExecutor(
        inner,
        session,
        config,
        makeAuditLogger(),
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      const result = await executor.invoke("read_file", { path: "/workspace/foo.txt" }, makeContext());
      expect(result.ok).toBe(false);
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });

    it("blocks when session is paused", async () => {
      const session = makeSession();
      session.paused = true;
      session.pauseReason = "test pause";
      const inner = makeInnerExecutor();
      const executor = new SafetyGuardedToolExecutor(
        inner,
        session,
        makeConfig(),
        makeAuditLogger(),
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      const result = await executor.invoke("read_file", { path: "/workspace/foo.txt" }, makeContext());
      expect(result.ok).toBe(false);
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Approval flow
  // -------------------------------------------------------------------------

  describe("approval flow", () => {
    // force-push triggers DestructiveActionGuard → requiresApproval
    const forcePushInput = { remote: "origin", branch: "main", force: true };

    it("approved: executes the tool and writes success audit entry", async () => {
      const inner = makeInnerExecutor({ ok: true, value: {} });
      const auditLogger = makeAuditLogger();
      const approvalGateway = makeApprovalGateway("approved");
      const executor = new SafetyGuardedToolExecutor(
        inner,
        makeSession(),
        makeConfig(),
        auditLogger,
        approvalGateway,
        makeSandboxExecutor(),
      );
      const result = await executor.invoke("git_push", forcePushInput, makeContext());
      expect(result.ok).toBe(true);
      expect(auditLogger.entries[0]!.approvalDecision).toBe("approved");
      expect(auditLogger.entries[0]!.outcome).toBe("success");
    });

    it("denied: does not execute the tool and writes blocked audit entry", async () => {
      const inner = makeInnerExecutor();
      const auditLogger = makeAuditLogger();
      const approvalGateway = makeApprovalGateway("denied");
      const executor = new SafetyGuardedToolExecutor(
        inner,
        makeSession(),
        makeConfig(),
        auditLogger,
        approvalGateway,
        makeSandboxExecutor(),
      );
      const result = await executor.invoke("git_push", forcePushInput, makeContext());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe("permission");
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);
      expect(auditLogger.entries[0]!.outcome).toBe("blocked");
      expect(auditLogger.entries[0]!.approvalDecision).toBe("denied");
    });

    it("timeout: does not execute the tool and writes blocked audit entry", async () => {
      const inner = makeInnerExecutor();
      const auditLogger = makeAuditLogger();
      const approvalGateway = makeApprovalGateway("timeout");
      const executor = new SafetyGuardedToolExecutor(
        inner,
        makeSession(),
        makeConfig(),
        auditLogger,
        approvalGateway,
        makeSandboxExecutor(),
      );
      const result = await executor.invoke("git_push", forcePushInput, makeContext());
      expect(result.ok).toBe(false);
      expect(auditLogger.entries[0]!.approvalDecision).toBe("timeout");
    });
  });

  // -------------------------------------------------------------------------
  // Sandbox delegation
  // -------------------------------------------------------------------------

  describe("sandbox delegation", () => {
    it("delegates run_test_suite to sandbox executor instead of inner executor", async () => {
      const inner = makeInnerExecutor();
      const sandbox = makeSandboxExecutor();
      const auditLogger = makeAuditLogger();
      const executor = new SafetyGuardedToolExecutor(
        inner,
        makeSession(),
        makeConfig(),
        auditLogger,
        makeApprovalGateway(),
        sandbox,
      );
      const result = await executor.invoke(
        "run_test_suite",
        { framework: "bun", pattern: "*.test.ts" },
        makeContext(),
      );
      expect(result.ok).toBe(true);
      expect(sandbox.called).toBe(true);
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);
      expect(auditLogger.entries[0]!.outcome).toBe("success");
    });

    it("delegates install_dependencies to sandbox executor", async () => {
      const inner = makeInnerExecutor();
      const sandbox = makeSandboxExecutor();
      const executor = new SafetyGuardedToolExecutor(
        inner,
        makeSession(),
        makeConfig(),
        makeAuditLogger(),
        makeApprovalGateway(),
        sandbox,
      );
      const result = await executor.invoke(
        "install_dependencies",
        { packageManager: "bun" },
        makeContext(),
      );
      expect(result.ok).toBe(true);
      expect(sandbox.called).toBe(true);
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Audit entry fields
  // -------------------------------------------------------------------------

  describe("audit entry fields", () => {
    it("includes sessionId, iterationNumber, and toolName in every entry", async () => {
      const session = makeSession();
      const auditLogger = makeAuditLogger();
      const executor = new SafetyGuardedToolExecutor(
        makeInnerExecutor(),
        session,
        makeConfig(),
        auditLogger,
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      await executor.invoke("read_file", { path: "/workspace/foo.txt" }, makeContext());
      const entry = auditLogger.entries[0]!;
      expect(entry.sessionId).toBe(session.sessionId);
      expect(typeof entry.iterationNumber).toBe("number");
      expect(entry.toolName).toBe("read_file");
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    });

    it("passes full serialized inputSummary to the audit logger (truncation is the adapter's responsibility)", async () => {
      const auditLogger = makeAuditLogger();
      const executor = new SafetyGuardedToolExecutor(
        makeInnerExecutor(),
        makeSession(),
        makeConfig(),
        auditLogger,
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      const largeInput = { path: "/workspace/foo.txt", extra: "x".repeat(1000) };
      await executor.invoke("read_file", largeInput, makeContext());
      // The executor serializes input to JSON and passes it to the logger unchanged.
      // Byte-safe truncation to 512 bytes is the AuditLogger adapter's responsibility.
      expect(typeof auditLogger.entries[0]!.inputSummary).toBe("string");
      expect(auditLogger.entries[0]!.inputSummary).toContain("/workspace/foo.txt");
    });
  });

  // -------------------------------------------------------------------------
  // Never throws
  // -------------------------------------------------------------------------

  describe("error resilience", () => {
    it("never throws — returns ToolResult even when inner executor throws", async () => {
      const throwingInner: IToolExecutor = {
        invoke: mock(async () => {
          throw new Error("unexpected crash");
        }),
      };
      const executor = new SafetyGuardedToolExecutor(
        throwingInner,
        makeSession(),
        makeConfig(),
        makeAuditLogger(),
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      const result = await executor.invoke("read_file", { path: "/workspace/foo.txt" }, makeContext());
      expect(result.ok).toBe(false);
    });
  });
});
