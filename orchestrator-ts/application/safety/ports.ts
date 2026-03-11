import type { ApprovalRequest } from '../../domain/safety/guards';
import type { EmergencyStopSource, SafetySession } from '../../domain/safety/types';

// ---------------------------------------------------------------------------
// Audit Logger port
// ---------------------------------------------------------------------------

export type AuditOutcome = 'success' | 'blocked' | 'error' | 'emergency-stop';

/** Frozen tuple of all valid audit outcome values. */
export const AUDIT_OUTCOMES = Object.freeze([
  'success',
  'blocked',
  'error',
  'emergency-stop',
] as const satisfies ReadonlyArray<AuditOutcome>);

export interface AuditEntry {
  readonly timestamp: string;            // ISO 8601 UTC
  readonly sessionId: string;
  readonly iterationNumber: number;
  readonly toolName: string;
  readonly inputSummary: string;         // sanitized, max 512 bytes
  readonly outcome: AuditOutcome;
  readonly blockReason?: string;
  readonly approvalDecision?: 'approved' | 'denied' | 'timeout';
  readonly errorDetails?: string;
}

export interface IAuditLogger {
  /**
   * Append exactly one NDJSON line for the entry and fsync before resolving.
   * Never throws; disk errors are surfaced as console.error warnings.
   */
  write(entry: AuditEntry): Promise<void>;

  /**
   * Wait for all pending writes to complete.
   * Called by EmergencyStopHandler before process termination.
   */
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Approval Gateway port
// ---------------------------------------------------------------------------

export type ApprovalDecision = 'approved' | 'denied' | 'timeout';

/** Frozen tuple of all valid approval decision values. */
export const APPROVAL_DECISIONS = Object.freeze([
  'approved',
  'denied',
  'timeout',
] as const satisfies ReadonlyArray<ApprovalDecision>);

export interface IApprovalGateway {
  /**
   * Present the request to the human operator and await a decision.
   *
   * Preconditions: timeoutMs > 0
   * Postconditions: Resolves to exactly one ApprovalDecision; never rejects.
   * On timeout, returns 'timeout' without waiting further.
   */
  requestApproval(request: ApprovalRequest, timeoutMs: number): Promise<ApprovalDecision>;
}

// ---------------------------------------------------------------------------
// Sandbox Executor port
// ---------------------------------------------------------------------------

export interface SandboxExecutionRequest {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly workingDirectory: string;
  readonly method: 'container' | 'restricted-shell' | 'temp-directory';
  readonly containerImage?: string;
}

export interface SandboxExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface ISandboxExecutor {
  /**
   * Execute the command in an isolated environment.
   *
   * Postconditions:
   *   - Temp directory is removed after execution completes or times out.
   *   - Setup failures are returned as a rejected promise with a ToolError-shaped message
   *     before any execution attempt.
   */
  execute(request: SandboxExecutionRequest, timeoutMs: number): Promise<SandboxExecutionResult>;
}

// ---------------------------------------------------------------------------
// Emergency Stop Handler port
// ---------------------------------------------------------------------------

export interface IEmergencyStopHandler {
  /**
   * Register OS signal handlers (SIGINT, SIGTERM) and bind to the session and audit logger.
   * Call once at agent session start.
   */
  register(session: SafetySession, auditLogger: IAuditLogger): void;

  /**
   * Programmatically trigger an emergency stop (e.g., from a safety violation or resource exhaustion).
   * Sets session.emergencyStopRequested, writes the final audit entry, flushes, then exits.
   */
  trigger(source: EmergencyStopSource): Promise<void>;

  /**
   * Remove OS signal listeners when the agent session ends cleanly.
   * Call once at clean agent session end.
   */
  deregister(): void;
}
