import { API_REQUEST_TOOLS, REPO_WRITE_TOOLS } from "../../domain/safety/constants";
import type { ISafetyGuard, SafetyContext } from "../../domain/safety/guards";
import {
  DestructiveActionGuard,
  FailureDetectionGuard,
  IterationLimitGuard,
  RateLimitGuard,
} from "../../domain/safety/stateful-guards";
import {
  FilesystemGuard,
  GitSafetyGuard,
  ShellRestrictionGuard,
  WorkspaceIsolationGuard,
} from "../../domain/safety/stateless-guards";
import type { SafetyConfig, SafetySession } from "../../domain/safety/types";
import type { ToolContext, ToolResult } from "../../domain/tools/types";
import type { IToolExecutor } from "../tools/executor";
import type { AuditEntry, IApprovalGateway, IAuditLogger, ISandboxExecutor } from "./ports";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool names delegated to the sandbox executor instead of the inner tool executor. */
const SANDBOX_TOOL_NAMES = new Set(["run_test_suite", "install_dependencies"]);

// ---------------------------------------------------------------------------
// SafetyGuardedToolExecutor
// ---------------------------------------------------------------------------

/**
 * Decorator implementing IToolExecutor.
 *
 * Applies an ordered guard pipeline before every tool invocation and writes an
 * AuditEntry for every call (blocked or executed). Never throws; all error paths
 * return ToolResult { ok: false }.
 *
 * Pipeline order:
 *   1. Emergency stop check
 *   2. IterationLimitGuard
 *   3. FailureDetectionGuard (pre-check: paused?)
 *   4. WorkspaceIsolationGuard
 *   5. FilesystemGuard
 *   6. GitSafetyGuard
 *   7. ShellRestrictionGuard
 *   8. DestructiveActionGuard  (may trigger approval gateway)
 *   9. RateLimitGuard
 *  10. Execute (sandbox or inner executor)
 *  11. Post-execution: write audit, update session counters, record failure
 */
export class SafetyGuardedToolExecutor implements IToolExecutor {
  readonly #inner: IToolExecutor;
  readonly #session: SafetySession;
  readonly #config: SafetyConfig;
  readonly #auditLogger: IAuditLogger;
  readonly #approvalGateway: IApprovalGateway;
  readonly #sandboxExecutor: ISandboxExecutor;

  // Stateless guards (constructed once)
  readonly #workspaceGuard: WorkspaceIsolationGuard;
  readonly #filesystemGuard: FilesystemGuard;
  readonly #gitGuard: GitSafetyGuard;
  readonly #shellGuard: ShellRestrictionGuard;

  // Stateful guards (constructed once; destructive guard is stateless but grouped here)
  readonly #iterationGuard: IterationLimitGuard;
  readonly #failureGuard: FailureDetectionGuard;
  readonly #rateLimitGuard: RateLimitGuard;
  readonly #destructiveGuard: DestructiveActionGuard;

  constructor(
    inner: IToolExecutor,
    session: SafetySession,
    config: SafetyConfig,
    auditLogger: IAuditLogger,
    approvalGateway: IApprovalGateway,
    sandboxExecutor: ISandboxExecutor,
  ) {
    this.#inner = inner;
    this.#session = session;
    this.#config = config;
    this.#auditLogger = auditLogger;
    this.#approvalGateway = approvalGateway;
    this.#sandboxExecutor = sandboxExecutor;

    this.#iterationGuard = new IterationLimitGuard();
    this.#failureGuard = new FailureDetectionGuard();
    this.#workspaceGuard = new WorkspaceIsolationGuard();
    this.#filesystemGuard = new FilesystemGuard();
    this.#gitGuard = new GitSafetyGuard();
    this.#shellGuard = new ShellRestrictionGuard(config);
    this.#destructiveGuard = new DestructiveActionGuard();
    this.#rateLimitGuard = new RateLimitGuard();
  }

  async invoke(
    name: string,
    rawInput: unknown,
    context: ToolContext,
  ): Promise<ToolResult<unknown>> {
    const iterationNumber = this.#session.iterationCount;
    const safetyCtx: SafetyContext = { ...context, session: this.#session, config: this.#config };

    // -----------------------------------------------------------------------
    // 1. Emergency stop — immediate rejection
    // -----------------------------------------------------------------------
    if (this.#session.emergencyStopRequested) {
      await this.#writeAudit(name, rawInput, iterationNumber, "emergency-stop", {
        blockReason: "Emergency stop requested",
      });
      return {
        ok: false,
        error: {
          type: "runtime",
          message: "Invocation rejected: emergency stop is active",
        },
      };
    }

    // -----------------------------------------------------------------------
    // 2–3. Session-level guards: iteration limit and failure detection
    // -----------------------------------------------------------------------
    const sessionGuards: ISafetyGuard[] = [this.#iterationGuard, this.#failureGuard];
    for (const guard of sessionGuards) {
      const result = await guard.check(name, rawInput, safetyCtx);
      if (!result.allowed) {
        await this.#writeAudit(name, rawInput, iterationNumber, "blocked", {
          blockReason: result.error?.message,
        });
        return { ok: false, error: result.error ?? { type: "permission", message: "blocked by guard" } };
      }
    }

    // -----------------------------------------------------------------------
    // 4–7. Per-tool guards (workspace, filesystem, git, shell)
    // -----------------------------------------------------------------------
    const toolGuards: ISafetyGuard[] = [
      this.#workspaceGuard,
      this.#filesystemGuard,
      this.#gitGuard,
      this.#shellGuard,
    ];
    for (const guard of toolGuards) {
      const result = await guard.check(name, rawInput, safetyCtx);
      if (!result.allowed) {
        await this.#writeAudit(name, rawInput, iterationNumber, "blocked", {
          blockReason: result.error?.message,
        });
        return { ok: false, error: result.error ?? { type: "permission", message: "blocked by guard" } };
      }
    }

    // -----------------------------------------------------------------------
    // 8. Destructive action guard — may require approval
    // -----------------------------------------------------------------------
    let approvalDecision: "approved" | "denied" | "timeout" | undefined;
    const destructiveResult = await this.#destructiveGuard.check(name, rawInput, safetyCtx);

    if (destructiveResult.requiresApproval && destructiveResult.approvalRequest) {
      approvalDecision = await this.#approvalGateway.requestApproval(
        destructiveResult.approvalRequest,
        this.#config.approvalTimeoutMs,
      );

      if (approvalDecision !== "approved") {
        await this.#writeAudit(name, rawInput, iterationNumber, "blocked", {
          blockReason: `Destructive action ${approvalDecision === "denied" ? "denied" : "timed out"} by human operator`,
          approvalDecision,
        });
        return {
          ok: false,
          error: {
            type: "permission",
            message: `Destructive action was ${approvalDecision} by the human operator`,
          },
        };
      }
    } else if (!destructiveResult.allowed) {
      await this.#writeAudit(name, rawInput, iterationNumber, "blocked", {
        blockReason: destructiveResult.error?.message,
      });
      return { ok: false, error: destructiveResult.error ?? { type: "permission", message: "blocked by guard" } };
    }

    // -----------------------------------------------------------------------
    // 9. Rate limit guard
    // -----------------------------------------------------------------------
    const rateLimitResult = await this.#rateLimitGuard.check(name, rawInput, safetyCtx);
    if (!rateLimitResult.allowed) {
      await this.#writeAudit(name, rawInput, iterationNumber, "blocked", {
        blockReason: rateLimitResult.error?.message,
      });
      return { ok: false, error: rateLimitResult.error ?? { type: "permission", message: "blocked by guard" } };
    }

    // -----------------------------------------------------------------------
    // 10. Execute
    // -----------------------------------------------------------------------
    let toolResult: ToolResult<unknown>;
    try {
      if (SANDBOX_TOOL_NAMES.has(name)) {
        const { command, args } = buildSandboxCommand(name, rawInput);
        const sandboxResult = await this.#sandboxExecutor.execute(
          {
            command,
            args,
            workingDirectory: context.workingDirectory,
            method: this.#config.sandboxMethod,
            ...(this.#config.containerImage !== undefined ? { containerImage: this.#config.containerImage } : {}),
          },
          this.#config.approvalTimeoutMs,
        );
        toolResult = { ok: true, value: sandboxResult };
      } else {
        toolResult = await this.#inner.invoke(name, rawInput, context);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolResult = { ok: false, error: { type: "runtime", message } };
    }

    // -----------------------------------------------------------------------
    // 11. Post-execution: write audit, update session state
    // -----------------------------------------------------------------------
    const outcome = toolResult.ok ? "success" : "error";
    await this.#writeAudit(name, rawInput, iterationNumber, outcome, {
      approvalDecision,
      errorDetails: !toolResult.ok ? toolResult.error.message : undefined,
    });

    // Update session counters
    this.#session.iterationCount += 1;
    this.#session.toolInvocationTimestamps.push(Date.now());
    if (REPO_WRITE_TOOLS.has(name)) {
      this.#session.repoWriteCount += 1;
    }
    if (API_REQUEST_TOOLS.has(name)) {
      this.#session.apiRequestTimestamps.push(Date.now());
    }

    // Update failure detection guard
    this.#failureGuard.recordResult(name, toolResult, this.#session);

    return toolResult;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  async #writeAudit(
    toolName: string,
    rawInput: unknown,
    iterationNumber: number,
    outcome: AuditEntry["outcome"],
    extras: {
      blockReason?: string;
      approvalDecision?: AuditEntry["approvalDecision"];
      errorDetails?: string;
    } = {},
  ): Promise<void> {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId: this.#session.sessionId,
      iterationNumber,
      toolName,
      inputSummary: this.#sanitizeInput(rawInput),
      outcome,
      ...(extras.blockReason !== undefined ? { blockReason: extras.blockReason } : {}),
      ...(extras.approvalDecision !== undefined ? { approvalDecision: extras.approvalDecision } : {}),
      ...(extras.errorDetails !== undefined ? { errorDetails: extras.errorDetails } : {}),
    };
    await this.#auditLogger.write(entry);
  }

  #sanitizeInput(rawInput: unknown): string {
    try {
      return JSON.stringify(rawInput) ?? "null";
    } catch {
      return "[unserializable]";
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a sandboxed tool name and its raw input to the actual executable command
 * and arguments that the sandbox executor should spawn.
 */
function buildSandboxCommand(toolName: string, rawInput: unknown): { command: string; args: string[] } {
  const input = rawInput as Record<string, unknown>;
  switch (toolName) {
    case "run_test_suite": {
      const command = typeof input.framework === "string" ? input.framework : "bun";
      const args = ["test"];
      if (typeof input.pattern === "string") args.push(input.pattern);
      return { command, args };
    }
    case "install_dependencies": {
      const command = typeof input.packageManager === "string" ? input.packageManager : "bun";
      return { command, args: ["install"] };
    }
    default:
      return { command: toolName, args: [] };
  }
}
