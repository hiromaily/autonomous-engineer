import type { ToolContext, ToolError } from "@/domain/tools/types";
import type { SafetyConfig, SafetySession } from "./types";

// ---------------------------------------------------------------------------
// ApprovalRequest value object
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  readonly description: string;
  readonly riskClassification: "high" | "critical";
  readonly expectedImpact: string;
  readonly proposedAction: string;
}

// ---------------------------------------------------------------------------
// SafetyCheckResult — discriminated value object
// Three outcomes: allowed, blocked, requires-approval
// ---------------------------------------------------------------------------

export interface SafetyCheckResult {
  /** True when the operation may proceed (either unconditionally or pending approval). */
  readonly allowed: boolean;
  /** Populated when allowed is false. */
  readonly error?: ToolError;
  /** True when the executor must route the operation through the approval gateway. */
  readonly requiresApproval?: boolean;
  /** Populated when requiresApproval is true. */
  readonly approvalRequest?: ApprovalRequest;
}

// ---------------------------------------------------------------------------
// SafetyCheckResult factory helpers
// ---------------------------------------------------------------------------

/** Operation may proceed unconditionally. */
export function allowedResult(): SafetyCheckResult {
  return { allowed: true };
}

/** Operation is rejected with a ToolError. */
export function blockedResult(error: ToolError): SafetyCheckResult {
  return { allowed: false, error };
}

/** Operation requires human approval before proceeding. */
export function requiresApprovalResult(request: ApprovalRequest): SafetyCheckResult {
  return { allowed: true, requiresApproval: true, approvalRequest: request };
}

// ---------------------------------------------------------------------------
// SafetyContext — extends ToolContext with session and config references
// ---------------------------------------------------------------------------

export interface SafetyContext extends ToolContext {
  readonly session: SafetySession;
  readonly config: SafetyConfig;
}

// ---------------------------------------------------------------------------
// ISafetyGuard — port interface implemented by each guard
// ---------------------------------------------------------------------------

export interface ISafetyGuard {
  /** Unique name for this guard (used in audit entries and error messages). */
  readonly name: string;

  /**
   * Evaluate the tool invocation against this guard's policy.
   *
   * Preconditions:
   *   - context.session is non-null
   *   - rawInput has passed schema validation in ToolExecutor
   *
   * Postconditions:
   *   - Resolves to a SafetyCheckResult; never rejects
   *   - Guards are pure-read: they never mutate context.session
   */
  check(
    toolName: string,
    rawInput: unknown,
    context: SafetyContext,
  ): Promise<SafetyCheckResult>;
}
