import type {
  ApprovalDecision,
  AuditEntry,
  IApprovalGateway,
  IAuditLogger,
  IEmergencyStopHandler,
  ISandboxExecutor,
  SandboxExecutionRequest,
  SandboxExecutionResult,
} from "@/application/ports/safety";
import { APPROVAL_DECISIONS, AUDIT_OUTCOMES } from "@/application/ports/safety";
import type { ApprovalRequest } from "@/domain/safety/guards";
import type { EmergencyStopSource, SafetySession } from "@/domain/safety/types";
import { createSafetySession } from "@/domain/safety/types";
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// AuditEntry value object shape
// ---------------------------------------------------------------------------

describe("AuditEntry", () => {
  it("accepts all required fields with success outcome", () => {
    const entry: AuditEntry = {
      timestamp: "2026-03-11T12:00:00.000Z",
      sessionId: "abc-123",
      iterationNumber: 1,
      toolName: "read_file",
      inputSummary: "{\"path\":\"/workspace/src/index.ts\"}",
      outcome: "success",
    };
    expect(entry.outcome).toBe("success");
    expect(entry.blockReason).toBeUndefined();
    expect(entry.approvalDecision).toBeUndefined();
    expect(entry.errorDetails).toBeUndefined();
  });

  it("accepts blocked outcome with blockReason", () => {
    const entry: AuditEntry = {
      timestamp: "2026-03-11T12:00:00.000Z",
      sessionId: "abc-123",
      iterationNumber: 2,
      toolName: "write_file",
      inputSummary: "{\"path\":\"/etc/passwd\"}",
      outcome: "blocked",
      blockReason: "path outside workspace boundary",
    };
    expect(entry.outcome).toBe("blocked");
    expect(entry.blockReason).toBe("path outside workspace boundary");
  });

  it("accepts error outcome with errorDetails", () => {
    const entry: AuditEntry = {
      timestamp: "2026-03-11T12:00:00.000Z",
      sessionId: "abc-123",
      iterationNumber: 3,
      toolName: "git_commit",
      inputSummary: "{\"message\":\"fix: bug\"}",
      outcome: "error",
      errorDetails: "subprocess exited with code 1",
    };
    expect(entry.outcome).toBe("error");
    expect(entry.errorDetails).toBe("subprocess exited with code 1");
  });

  it("accepts emergency-stop outcome", () => {
    const entry: AuditEntry = {
      timestamp: "2026-03-11T12:00:01.000Z",
      sessionId: "abc-123",
      iterationNumber: 4,
      toolName: "N/A",
      inputSummary: "",
      outcome: "emergency-stop",
    };
    expect(entry.outcome).toBe("emergency-stop");
  });

  it("accepts approvalDecision field", () => {
    const entry: AuditEntry = {
      timestamp: "2026-03-11T12:00:00.000Z",
      sessionId: "abc-123",
      iterationNumber: 5,
      toolName: "delete_files",
      inputSummary: "{\"paths\":[\"a\",\"b\"]}",
      outcome: "blocked",
      blockReason: "denied by operator",
      approvalDecision: "denied",
    };
    expect(entry.approvalDecision).toBe("denied");
  });

  it("inputSummary is bounded to 512 bytes by convention", () => {
    // This test documents the contract — enforcement is in the adapter
    const longInput = "x".repeat(600);
    const entry: AuditEntry = {
      timestamp: "2026-03-11T12:00:00.000Z",
      sessionId: "s1",
      iterationNumber: 1,
      toolName: "tool",
      inputSummary: longInput.slice(0, 512),
      outcome: "success",
    };
    expect(entry.inputSummary.length).toBeLessThanOrEqual(512);
  });
});

// ---------------------------------------------------------------------------
// IAuditLogger structural compliance
// ---------------------------------------------------------------------------

describe("IAuditLogger structural compliance", () => {
  it("a conforming logger writes and flushes without throwing", async () => {
    const written: AuditEntry[] = [];

    const logger: IAuditLogger = {
      async write(entry: AuditEntry): Promise<void> {
        written.push(entry);
      },
      async flush(): Promise<void> {
        // no-op
      },
    };

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId: "s1",
      iterationNumber: 1,
      toolName: "read_file",
      inputSummary: "{}",
      outcome: "success",
    };

    await logger.write(entry);
    await logger.flush();
    expect(written).toHaveLength(1);
    expect(written.at(0)?.toolName).toBe("read_file");
  });
});

// ---------------------------------------------------------------------------
// ApprovalDecision constants
// ---------------------------------------------------------------------------

describe("APPROVAL_DECISIONS", () => {
  it("contains all three decision values", () => {
    expect(APPROVAL_DECISIONS).toContain("approved");
    expect(APPROVAL_DECISIONS).toContain("denied");
    expect(APPROVAL_DECISIONS).toContain("timeout");
    expect(APPROVAL_DECISIONS).toHaveLength(3);
  });
});

describe("AUDIT_OUTCOMES", () => {
  it("contains all four outcome values", () => {
    expect(AUDIT_OUTCOMES).toContain("success");
    expect(AUDIT_OUTCOMES).toContain("blocked");
    expect(AUDIT_OUTCOMES).toContain("error");
    expect(AUDIT_OUTCOMES).toContain("emergency-stop");
    expect(AUDIT_OUTCOMES).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// IApprovalGateway structural compliance
// ---------------------------------------------------------------------------

describe("IApprovalGateway structural compliance", () => {
  it("a conforming gateway resolves to approved without throwing", async () => {
    const gateway: IApprovalGateway = {
      async requestApproval(_request: ApprovalRequest, _timeoutMs: number): Promise<ApprovalDecision> {
        return "approved";
      },
    };

    const request: ApprovalRequest = {
      description: "Delete 12 files",
      riskClassification: "high",
      expectedImpact: "Removes build artifacts",
      proposedAction: "rm -rf dist/",
    };

    const decision = await gateway.requestApproval(request, 30_000);
    expect(decision).toBe("approved");
  });

  it("a conforming gateway resolves to denied", async () => {
    const gateway: IApprovalGateway = {
      async requestApproval(): Promise<ApprovalDecision> {
        return "denied";
      },
    };
    const decision = await gateway.requestApproval(
      { description: "x", riskClassification: "critical", expectedImpact: "y", proposedAction: "z" },
      5_000,
    );
    expect(decision).toBe("denied");
  });

  it("a conforming gateway resolves to timeout", async () => {
    const gateway: IApprovalGateway = {
      async requestApproval(): Promise<ApprovalDecision> {
        return "timeout";
      },
    };
    const decision = await gateway.requestApproval(
      { description: "x", riskClassification: "high", expectedImpact: "y", proposedAction: "z" },
      1,
    );
    expect(decision).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// SandboxExecutionRequest and SandboxExecutionResult value objects
// ---------------------------------------------------------------------------

describe("SandboxExecutionRequest", () => {
  it("carries command, args, workingDirectory, method", () => {
    const req: SandboxExecutionRequest = {
      command: "bun",
      args: ["test"],
      workingDirectory: "/workspace",
      method: "temp-directory",
    };
    expect(req.command).toBe("bun");
    expect(req.method).toBe("temp-directory");
    expect(req.containerImage).toBeUndefined();
  });

  it("accepts container method with containerImage", () => {
    const req: SandboxExecutionRequest = {
      command: "npm",
      args: ["install"],
      workingDirectory: "/workspace",
      method: "container",
      containerImage: "node:20-alpine",
    };
    expect(req.method).toBe("container");
    expect(req.containerImage).toBe("node:20-alpine");
  });

  it("accepts restricted-shell method", () => {
    const req: SandboxExecutionRequest = {
      command: "bun",
      args: ["test"],
      workingDirectory: "/workspace",
      method: "restricted-shell",
    };
    expect(req.method).toBe("restricted-shell");
  });
});

describe("SandboxExecutionResult", () => {
  it("carries stdout, stderr, exitCode, durationMs", () => {
    const result: SandboxExecutionResult = {
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      durationMs: 123,
    };
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBe(123);
  });
});

// ---------------------------------------------------------------------------
// ISandboxExecutor structural compliance
// ---------------------------------------------------------------------------

describe("ISandboxExecutor structural compliance", () => {
  it("a conforming executor resolves to a SandboxExecutionResult", async () => {
    const executor: ISandboxExecutor = {
      async execute(_request: SandboxExecutionRequest, _timeoutMs: number): Promise<SandboxExecutionResult> {
        return { stdout: "tests passed", stderr: "", exitCode: 0, durationMs: 50 };
      },
    };

    const result = await executor.execute(
      { command: "bun", args: ["test"], workingDirectory: "/workspace", method: "temp-directory" },
      30_000,
    );
    expect(result.stdout).toBe("tests passed");
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// IEmergencyStopHandler structural compliance
// ---------------------------------------------------------------------------

describe("IEmergencyStopHandler structural compliance", () => {
  it("a conforming handler registers, triggers, and deregisters without throwing", async () => {
    let stopped = false;
    let registeredSession: SafetySession | null = null;

    const handler: IEmergencyStopHandler = {
      register(session: SafetySession, _logger: IAuditLogger): void {
        registeredSession = session;
      },
      async trigger(source: EmergencyStopSource): Promise<void> {
        stopped = true;
        if (registeredSession) {
          registeredSession.emergencyStopRequested = true;
          registeredSession.emergencyStopSource = source;
        }
      },
      deregister(): void {
        registeredSession = null;
      },
    };

    const session = createSafetySession();
    const logger: IAuditLogger = {
      async write(): Promise<void> {},
      async flush(): Promise<void> {},
    };

    handler.register(session, logger);
    expect(registeredSession).not.toBe(null);
    expect(registeredSession === session).toBe(true);

    await handler.trigger({ kind: "signal", signal: "SIGINT" });
    expect(stopped).toBe(true);
    expect(session.emergencyStopRequested).toBe(true);
    expect(session.emergencyStopSource).toEqual({ kind: "signal", signal: "SIGINT" });

    handler.deregister();
    expect(registeredSession).toBe(null);
  });
});
