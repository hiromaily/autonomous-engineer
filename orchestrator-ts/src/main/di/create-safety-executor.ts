import type { IEmergencyStopHandler } from "@/application/ports/safety";
import type { IApprovalGateway, IAuditLogger, ISandboxExecutor } from "@/application/ports/safety";
import type { IToolExecutor } from "@/application/ports/tool-executor";
import { EmergencyStopHandler } from "@/application/services/safety/emergency-stop-handler";
import { SafetyGuardedToolExecutor } from "@/application/services/safety/guarded-executor";
import { createSafetyConfig, createSafetySession } from "@/domain/safety/types";
import type { SafetyConfigOverrides, SafetySession } from "@/domain/safety/types";
import { AuditLogger } from "@/infra/logger/audit-logger";
import { CliApprovalGateway } from "@/infra/safety/approval-gateway";
import { defaultGitRunner } from "@/infra/safety/git-runner";
import { TempDirSandboxExecutor } from "@/infra/safety/sandbox-executor";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SafetyExecutorOptions {
  /** Config overrides; workspaceRoot is required. All other fields fall back to validated defaults. */
  readonly configOverrides: SafetyConfigOverrides;

  /** The inner ToolExecutor to wrap. */
  readonly innerExecutor: IToolExecutor;

  /**
   * Optional pre-constructed audit logger.
   * When omitted, an AuditLogger writing to <workspaceRoot>/.aes/audit.ndjson is created.
   */
  readonly auditLogger?: IAuditLogger;

  /**
   * Optional pre-constructed approval gateway.
   * When omitted, a CliApprovalGateway is created.
   */
  readonly approvalGateway?: IApprovalGateway;

  /**
   * Optional pre-constructed sandbox executor.
   * When omitted, a TempDirSandboxExecutor is created.
   */
  readonly sandboxExecutor?: ISandboxExecutor;

  /**
   * Optional process exit function.
   * Defaults to process.exit. Override in tests to prevent real exits.
   */
  readonly exitFn?: (code: number) => never;
}

export interface SafetyExecutorBundle {
  /** The safety-wrapped IToolExecutor. Pass this wherever ToolExecutor was used. */
  readonly executor: IToolExecutor;

  /** The per-session safety state. Exposed for observability and testing. */
  readonly session: SafetySession;

  /** The registered emergency stop handler. */
  readonly emergencyStopHandler: IEmergencyStopHandler;

  /**
   * Call on clean agent session end (no emergency stop) to deregister OS signal
   * listeners and release resources.
   */
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Composition root for the agent-safety system.
 *
 * 1. Creates SafetyConfig and SafetySession.
 * 2. Instantiates adapters (AuditLogger, CliApprovalGateway, TempDirSandboxExecutor).
 * 3. Constructs SafetyGuardedToolExecutor wrapping the inner ToolExecutor.
 * 4. Registers EmergencyStopHandler with the session and audit logger.
 * 5. Returns a bundle with the executor, session, handler, and a cleanup callback.
 *
 * Callers replace `new ToolExecutor(...)` with `createSafetyExecutor(...).executor`.
 * Existing ToolContext call sites require no changes.
 */
export function createSafetyExecutor(options: SafetyExecutorOptions): SafetyExecutorBundle {
  const { configOverrides, innerExecutor, exitFn } = options;

  // 1. Safety config — validated, frozen
  const config = createSafetyConfig(configOverrides);

  // 2. Safety session — fresh UUID + current timestamp
  const session = createSafetySession();

  // 3. Adapters
  const auditLogger = options.auditLogger ?? new AuditLogger(join(config.workspaceRoot, ".aes", "audit.ndjson"));
  const approvalGateway = options.approvalGateway ?? new CliApprovalGateway();
  const sandboxExecutor = options.sandboxExecutor ?? new TempDirSandboxExecutor();

  // 4. SafetyGuardedToolExecutor — replaces bare ToolExecutor at the composition root
  const executor = new SafetyGuardedToolExecutor(
    innerExecutor,
    session,
    config,
    auditLogger,
    approvalGateway,
    sandboxExecutor,
    defaultGitRunner,
  );

  // 5. EmergencyStopHandler — registered immediately after construction
  const emergencyStopHandler = new EmergencyStopHandler(exitFn ?? process.exit);
  emergencyStopHandler.register(session, auditLogger);

  // 6. Cleanup callback — call on clean session end (no emergency stop)
  const cleanup = (): void => emergencyStopHandler.deregister();

  return { executor, session, emergencyStopHandler, cleanup };
}
