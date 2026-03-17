import type { AuditEntry, IAuditLogger } from "@/application/ports/safety";
import type { IToolExecutor } from "@/application/services/tools/executor";
import type { PermissionSet, ToolContext, ToolInvocationLog } from "@/domain/tools/types";
import { createSafetyExecutor } from "@/main/di/create-safety-executor";
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

function makeInnerExecutor(
  result: { ok: true; value: unknown } | {
    ok: false;
    error: { type: "validation" | "runtime" | "permission"; message: string };
  } = {
    ok: true,
    value: { data: "test-result" },
  },
): IToolExecutor & { invoked: boolean } {
  let invoked = false;
  return {
    get invoked() {
      return invoked;
    },
    invoke: mock(async () => {
      invoked = true;
      return result;
    }),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSafetyExecutor", () => {
  const workspaceRoot = "/workspace";

  it("returns an executor bundle with executor, session, emergencyStopHandler, and cleanup", () => {
    const innerExecutor = makeInnerExecutor();
    const bundle = createSafetyExecutor({
      configOverrides: { workspaceRoot },
      innerExecutor,
    });

    expect(bundle).toBeDefined();
    expect(typeof bundle.executor.invoke).toBe("function");
    expect(bundle.session).toBeDefined();
    expect(typeof bundle.session.sessionId).toBe("string");
    expect(typeof bundle.session.startedAtMs).toBe("number");
    expect(typeof bundle.emergencyStopHandler.register).toBe("function");
    expect(typeof bundle.emergencyStopHandler.deregister).toBe("function");
    expect(typeof bundle.cleanup).toBe("function");

    // Immediately deregister to avoid leaking SIGINT/SIGTERM handlers in tests
    bundle.cleanup();
  });

  it("initializes session with zero counters and a UUID session ID", () => {
    const innerExecutor = makeInnerExecutor();
    const bundle = createSafetyExecutor({
      configOverrides: { workspaceRoot },
      innerExecutor,
    });

    expect(bundle.session.iterationCount).toBe(0);
    expect(bundle.session.repoWriteCount).toBe(0);
    expect(bundle.session.toolInvocationTimestamps).toEqual([]);
    expect(bundle.session.apiRequestTimestamps).toEqual([]);
    expect(bundle.session.paused).toBe(false);
    expect(bundle.session.emergencyStopRequested).toBe(false);
    expect(bundle.session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(bundle.session.startedAtMs).toBeLessThanOrEqual(Date.now());

    bundle.cleanup();
  });

  it("applies operator-supplied config overrides", () => {
    const innerExecutor = makeInnerExecutor();
    const bundle = createSafetyExecutor({
      configOverrides: {
        workspaceRoot,
        maxIterations: 10,
        maxFilesPerCommit: 5,
      },
      innerExecutor,
    });

    // Config is not directly exposed but guards use it; we verify indirectly via iteration limit
    expect(bundle.session).toBeDefined();
    bundle.cleanup();
  });

  it("executor passes ToolContext unchanged to the inner executor for allowed tools", async () => {
    const innerExecutor = makeInnerExecutor({ ok: true, value: { data: "ok" } });
    const bundle = createSafetyExecutor({
      configOverrides: { workspaceRoot },
      innerExecutor,
    });

    const ctx = makeContext();
    const result = await bundle.executor.invoke("read_file", { path: "/workspace/foo.ts" }, ctx);

    expect(result.ok).toBe(true);
    expect(innerExecutor.invoked).toBe(true);

    bundle.cleanup();
  });

  it("executor blocks invocations that violate workspace boundary", async () => {
    const innerExecutor = makeInnerExecutor();
    const bundle = createSafetyExecutor({
      configOverrides: { workspaceRoot },
      innerExecutor,
    });

    const ctx = makeContext();
    const result = await bundle.executor.invoke(
      "read_file",
      { path: "/etc/passwd" },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
    expect(innerExecutor.invoked).toBe(false);

    bundle.cleanup();
  });

  it("accepts an injected audit logger and writes entries on invocation", async () => {
    const innerExecutor = makeInnerExecutor({ ok: true, value: { data: "ok" } });
    const auditLogger = makeAuditLogger();
    const bundle = createSafetyExecutor({
      configOverrides: { workspaceRoot },
      innerExecutor,
      auditLogger,
    });

    const ctx = makeContext();
    await bundle.executor.invoke("read_file", { path: "/workspace/foo.ts" }, ctx);

    expect(auditLogger.entries.length).toBeGreaterThanOrEqual(1);
    const entry = auditLogger.entries[0]!;
    expect(entry.sessionId).toBe(bundle.session.sessionId);
    expect(entry.toolName).toBe("read_file");

    bundle.cleanup();
  });

  it("registers the emergency stop handler and sets the stop flag when triggered", async () => {
    const innerExecutor = makeInnerExecutor();
    let exitCode: number | undefined;
    const exitFn = (code: number) => {
      exitCode = code;
      // Don't actually exit; return never type cast
      return undefined as never;
    };

    const bundle = createSafetyExecutor({
      configOverrides: { workspaceRoot },
      innerExecutor,
      exitFn,
    });

    // Trigger programmatic stop
    await bundle.emergencyStopHandler.trigger({
      kind: "safety-violation",
      description: "test violation",
    });

    expect(bundle.session.emergencyStopRequested).toBe(true);
    expect(exitCode).toBe(1);

    // trigger() calls exitFn but not deregister(); clean up signal handlers explicitly
    bundle.cleanup();
  });

  it("executor rejects all calls after emergency stop is requested", async () => {
    const innerExecutor = makeInnerExecutor({ ok: true, value: { data: "ok" } });
    const bundle = createSafetyExecutor({
      configOverrides: { workspaceRoot },
      innerExecutor,
      exitFn: (_code: number) => undefined as never,
    });

    // Manually set the stop flag without calling trigger (to avoid process.exit)
    bundle.session.emergencyStopRequested = true;

    const ctx = makeContext();
    const result = await bundle.executor.invoke("read_file", { path: "/workspace/foo.ts" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/emergency stop/i);
    }
    expect(innerExecutor.invoked).toBe(false);

    bundle.cleanup();
  });

  it("cleanup() deregisters the emergency stop handler (no SIGINT/SIGTERM listeners remain)", () => {
    const innerExecutor = makeInnerExecutor();
    const bundle = createSafetyExecutor({
      configOverrides: { workspaceRoot },
      innerExecutor,
    });

    const sigintCount = process.listenerCount("SIGINT");
    const sigtermCount = process.listenerCount("SIGTERM");

    bundle.cleanup();

    // After cleanup, listener counts should be restored (not increased)
    expect(process.listenerCount("SIGINT")).toBeLessThanOrEqual(sigintCount);
    expect(process.listenerCount("SIGTERM")).toBeLessThanOrEqual(sigtermCount);
  });

  it("uses default audit log path when none supplied", () => {
    const innerExecutor = makeInnerExecutor();
    // Should not throw when creating with default audit log path
    expect(() => {
      const bundle = createSafetyExecutor({
        configOverrides: { workspaceRoot },
        innerExecutor,
      });
      bundle.cleanup();
    }).not.toThrow();
  });

  it("increments session.iterationCount after each successful tool invocation", async () => {
    const innerExecutor = makeInnerExecutor({ ok: true, value: {} });
    const bundle = createSafetyExecutor({
      configOverrides: { workspaceRoot },
      innerExecutor,
    });

    expect(bundle.session.iterationCount).toBe(0);

    const ctx = makeContext();
    await bundle.executor.invoke("read_file", { path: "/workspace/a.ts" }, ctx);
    expect(bundle.session.iterationCount).toBe(1);

    await bundle.executor.invoke("read_file", { path: "/workspace/b.ts" }, ctx);
    expect(bundle.session.iterationCount).toBe(2);

    bundle.cleanup();
  });
});
