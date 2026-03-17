/**
 * Integration tests for SafetyGuardedToolExecutor — end-to-end pipeline.
 *
 * Uses the real AuditLogger writing NDJSON to a temp directory so that audit
 * entries can be verified by reading back the log file.  The inner executor,
 * approval gateway, and sandbox executor are test stubs.
 *
 * Task 9.1 — Requirements: 1.3, 5.1, 6.1, 6.3, 6.4, 7.2, 8.2, 8.3, 8.4,
 *             10.2, 10.3, 10.4, 11.2, 11.3, 11.4, 11.5
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry, IApprovalGateway, ISandboxExecutor } from "@/application/ports/safety";
import { SafetyGuardedToolExecutor } from "@/application/services/safety/guarded-executor";
import type { IToolExecutor } from "@/application/services/tools/executor";
import { createSafetyConfig, createSafetySession } from "@/domain/safety/types";
import type { SafetyConfig, SafetySession } from "@/domain/safety/types";
import type { PermissionSet, ToolContext, ToolInvocationLog } from "@/domain/tools/types";
import { AuditLogger } from "@/infra/logger/audit-logger";

// ---------------------------------------------------------------------------
// Helpers
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

function makeContext(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    workingDirectory: workspaceRoot,
    permissions: makePermissions(),
    memory: { search: async () => [] },
    logger: {
      info: mock((_entry: ToolInvocationLog) => {}),
      error: mock((_entry: ToolInvocationLog) => {}),
    },
  };
}

function makeInnerExecutor(
  result: { ok: true; value: unknown } | {
    ok: false;
    error: { type: "validation" | "runtime" | "permission"; message: string };
  } = { ok: true, value: { result: "ok" } },
): IToolExecutor {
  return { invoke: mock(async () => result) };
}

function makeApprovalGateway(decision: "approved" | "denied" | "timeout" = "approved"): IApprovalGateway {
  return { requestApproval: mock(async () => decision) };
}

function makeSandboxExecutor(): ISandboxExecutor & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    execute: mock(async () => {
      callCount++;
      return { stdout: "tests passed", stderr: "", exitCode: 0, durationMs: 42 };
    }),
  };
}

/** Parse all NDJSON lines from the audit log file. */
async function readAuditLog(logPath: string): Promise<AuditEntry[]> {
  const text = await readFile(logPath, "utf-8");
  return text
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as AuditEntry);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SafetyGuardedToolExecutor — end-to-end integration", () => {
  let tmpDir: string;
  let logPath: string;
  let auditLogger: AuditLogger;
  let session: SafetySession;
  let config: SafetyConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "safety-integration-"));
    logPath = join(tmpDir, "audit.ndjson");
    auditLogger = new AuditLogger(logPath);
    session = createSafetySession();
    config = createSafetyConfig({ workspaceRoot: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Full guard pipeline pass — all required audit entry fields
  // -------------------------------------------------------------------------

  describe("full guard pipeline pass", () => {
    it("invokes the wrapped executor and writes a success audit entry with all required fields", async () => {
      const inner = makeInnerExecutor({ ok: true, value: { result: "success" } });
      const executor = new SafetyGuardedToolExecutor(
        inner,
        session,
        config,
        auditLogger,
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );

      const result = await executor.invoke(
        "read_file",
        { path: join(tmpDir, "foo.txt") },
        makeContext(tmpDir),
      );

      expect(result.ok).toBe(true);
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(1);

      await auditLogger.flush();
      const entries = await readAuditLog(logPath);
      expect(entries.length).toBe(1);

      const entry = entries[0]!;
      // All required fields must be present
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO 8601
      expect(typeof entry.sessionId).toBe("string");
      expect(entry.sessionId).toBe(session.sessionId);
      expect(typeof entry.iterationNumber).toBe("number");
      expect(entry.toolName).toBe("read_file");
      expect(typeof entry.inputSummary).toBe("string");
      expect(entry.inputSummary.length).toBeGreaterThan(0);
      expect(entry.outcome).toBe("success");
    });

    it("increments iterationCount and toolInvocationTimestamps after successful execution", async () => {
      const executor = new SafetyGuardedToolExecutor(
        makeInnerExecutor(),
        session,
        config,
        auditLogger,
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );

      expect(session.iterationCount).toBe(0);
      await executor.invoke("read_file", { path: join(tmpDir, "foo.txt") }, makeContext(tmpDir));
      expect(session.iterationCount).toBe(1);
      expect(session.toolInvocationTimestamps.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Blocked invocation — workspace guard fails
  // -------------------------------------------------------------------------

  describe("blocked invocation (workspace guard)", () => {
    it("does not call the inner executor", async () => {
      const inner = makeInnerExecutor();
      const executor = new SafetyGuardedToolExecutor(
        inner,
        session,
        config,
        auditLogger,
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );

      const result = await executor.invoke("read_file", { path: "/etc/passwd" }, makeContext(tmpDir));
      expect(result.ok).toBe(false);
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });

    it("writes a blocked audit entry with blockReason before returning the error", async () => {
      const executor = new SafetyGuardedToolExecutor(
        makeInnerExecutor(),
        session,
        config,
        auditLogger,
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );

      const result = await executor.invoke("read_file", { path: "/etc/passwd" }, makeContext(tmpDir));

      // Audit must already be flushed when invoke() resolves
      await auditLogger.flush();
      const entries = await readAuditLog(logPath);
      expect(entries.length).toBe(1);
      expect(entries[0]!.outcome).toBe("blocked");
      expect(typeof entries[0]!.blockReason).toBe("string");
      expect(entries[0]!.blockReason?.length).toBeGreaterThan(0);

      // The error is returned after the audit entry is written
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Approval flow — approved
  // -------------------------------------------------------------------------

  describe("approval flow: approved", () => {
    it("executes the tool and records approvalDecision=approved in the audit log", async () => {
      const inner = makeInnerExecutor({ ok: true, value: { pushed: true } });
      const approvalGateway = makeApprovalGateway("approved");
      const executor = new SafetyGuardedToolExecutor(
        inner,
        session,
        config,
        auditLogger,
        approvalGateway,
        makeSandboxExecutor(),
      );

      // force:true triggers DestructiveActionGuard → requiresApproval
      const result = await executor.invoke(
        "git_push",
        { remote: "origin", branch: "main", force: true },
        makeContext(tmpDir),
      );

      expect(result.ok).toBe(true);

      await auditLogger.flush();
      const entries = await readAuditLog(logPath);
      expect(entries.length).toBe(1);
      expect(entries[0]!.outcome).toBe("success");
      expect(entries[0]!.approvalDecision).toBe("approved");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Approval flow — denied
  // -------------------------------------------------------------------------

  describe("approval flow: denied", () => {
    it("does not execute the tool and records blocked audit entry with denied decision", async () => {
      const inner = makeInnerExecutor();
      const approvalGateway = makeApprovalGateway("denied");
      const executor = new SafetyGuardedToolExecutor(
        inner,
        session,
        config,
        auditLogger,
        approvalGateway,
        makeSandboxExecutor(),
      );

      const result = await executor.invoke(
        "git_push",
        { remote: "origin", branch: "main", force: true },
        makeContext(tmpDir),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe("permission");
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);

      await auditLogger.flush();
      const entries = await readAuditLog(logPath);
      expect(entries.length).toBe(1);
      expect(entries[0]!.outcome).toBe("blocked");
      expect(entries[0]!.approvalDecision).toBe("denied");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Approval flow — timeout
  // -------------------------------------------------------------------------

  describe("approval flow: timeout", () => {
    it("follows the same denial path as denied and records timeout in audit", async () => {
      const inner = makeInnerExecutor();
      const approvalGateway = makeApprovalGateway("timeout");
      const executor = new SafetyGuardedToolExecutor(
        inner,
        session,
        config,
        auditLogger,
        approvalGateway,
        makeSandboxExecutor(),
      );

      const result = await executor.invoke(
        "git_push",
        { remote: "origin", branch: "main", force: true },
        makeContext(tmpDir),
      );

      expect(result.ok).toBe(false);
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);

      await auditLogger.flush();
      const entries = await readAuditLog(logPath);
      expect(entries.length).toBe(1);
      expect(entries[0]!.outcome).toBe("blocked");
      expect(entries[0]!.approvalDecision).toBe("timeout");
    });
  });

  // -------------------------------------------------------------------------
  // 6. Sandbox delegation — run_test_suite
  // -------------------------------------------------------------------------

  describe("sandbox delegation", () => {
    it("routes run_test_suite to sandbox executor instead of inner executor, writes audit entry", async () => {
      const inner = makeInnerExecutor();
      const sandbox = makeSandboxExecutor();
      const executor = new SafetyGuardedToolExecutor(
        inner,
        session,
        config,
        auditLogger,
        makeApprovalGateway(),
        sandbox,
      );

      const result = await executor.invoke(
        "run_test_suite",
        { framework: "bun", pattern: "*.test.ts" },
        makeContext(tmpDir),
      );

      expect(result.ok).toBe(true);
      expect(sandbox.callCount).toBe(1);
      expect((inner.invoke as ReturnType<typeof mock>).mock.calls.length).toBe(0);

      await auditLogger.flush();
      const entries = await readAuditLog(logPath);
      expect(entries.length).toBe(1);
      expect(entries[0]!.toolName).toBe("run_test_suite");
      expect(entries[0]!.outcome).toBe("success");
    });
  });

  // -------------------------------------------------------------------------
  // 7. Iteration limit boundary
  // -------------------------------------------------------------------------

  describe("iteration limit boundary", () => {
    it("accepts exactly maxIterations invocations, then rejects with graceful stop error carrying progress summary", async () => {
      const maxIterations = 3;
      const limitedConfig = createSafetyConfig({ workspaceRoot: tmpDir, maxIterations });
      const executor = new SafetyGuardedToolExecutor(
        makeInnerExecutor(),
        session,
        limitedConfig,
        auditLogger,
        makeApprovalGateway(),
        makeSandboxExecutor(),
      );
      const ctx = makeContext(tmpDir);

      // Execute exactly maxIterations times — all should succeed
      for (let i = 0; i < maxIterations; i++) {
        const r = await executor.invoke("read_file", { path: join(tmpDir, "foo.txt") }, ctx);
        expect(r.ok).toBe(true);
      }
      expect(session.iterationCount).toBe(maxIterations);

      // The next invocation must be rejected
      const result = await executor.invoke("read_file", { path: join(tmpDir, "foo.txt") }, ctx);
      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.error.type).toBe("runtime");
        // Error message must describe the graceful stop
        expect(result.error.message).toContain("iterations");
        // Progress summary must be present in details
        expect(result.error.details).toBeDefined();
        expect(typeof result.error.details?.progressSummary).toBe("string");
        expect((result.error.details?.progressSummary as string).length).toBeGreaterThan(0);
      }

      // Blocked audit entry must be written for the rejected invocation
      await auditLogger.flush();
      const entries = await readAuditLog(logPath);
      // maxIterations success entries + 1 blocked entry
      expect(entries.length).toBe(maxIterations + 1);
      const lastEntry = entries[entries.length - 1]!;
      expect(lastEntry.outcome).toBe("blocked");
      expect(typeof lastEntry.blockReason).toBe("string");
      expect(lastEntry.blockReason as string).toContain("iterations");
    });
  });
});
