import { basename } from "node:path";
import type { ToolResult } from "../tools/types";
import { API_REQUEST_TOOLS, REPO_WRITE_TOOLS } from "./constants";
import type { ApprovalRequest, ISafetyGuard, SafetyCheckResult, SafetyContext } from "./guards";
import { allowedResult, blockedResult, requiresApprovalResult } from "./guards";
import type { SafetySession } from "./types";

// ---------------------------------------------------------------------------
// 3.1 IterationLimitGuard
// ---------------------------------------------------------------------------

export class IterationLimitGuard implements ISafetyGuard {
  readonly name = "iteration-limit";
  private readonly nowMs: () => number;

  constructor(nowMs: () => number = Date.now) {
    this.nowMs = nowMs;
  }

  async check(_toolName: string, _rawInput: unknown, context: SafetyContext): Promise<SafetyCheckResult> {
    const { session, config } = context;

    if (session.iterationCount >= config.maxIterations) {
      return blockedResult({
        type: "runtime",
        message:
          `Graceful stop: iterations limit reached (${session.iterationCount}/${config.maxIterations} iterations used)`,
        details: {
          limitType: "iterations",
          current: session.iterationCount,
          limit: config.maxIterations,
          progressSummary: `Session ${session.sessionId} halted after ${session.iterationCount} iterations`,
        },
      });
    }

    const elapsedMs = this.nowMs() - session.startedAtMs;
    if (elapsedMs >= config.maxRuntimeMs) {
      return blockedResult({
        type: "runtime",
        message: `Graceful stop: runtime limit reached (${elapsedMs}ms elapsed, limit ${config.maxRuntimeMs}ms)`,
        details: {
          limitType: "runtime",
          current: elapsedMs,
          limit: config.maxRuntimeMs,
          progressSummary: `Session ${session.sessionId} halted after ${elapsedMs}ms runtime`,
        },
      });
    }

    return allowedResult();
  }
}

// ---------------------------------------------------------------------------
// 3.2 FailureDetectionGuard
// ---------------------------------------------------------------------------

export interface PauseNotification {
  readonly signature: string;
  readonly occurrences: number;
}

/** Compute a stable failure fingerprint from tool name, error type, and message prefix. */
function computeSignature(toolName: string, errorType: string, message: string): string {
  return `${toolName}:${errorType}:${message.slice(0, 120)}`;
}

export class FailureDetectionGuard implements ISafetyGuard {
  readonly name = "failure-detection";

  async check(_toolName: string, _rawInput: unknown, context: SafetyContext): Promise<SafetyCheckResult> {
    if (context.session.paused) {
      return blockedResult({
        type: "runtime",
        message: `Agent execution is paused — human review required. Reason: ${
          context.session.pauseReason ?? "repeated failures detected"
        }`,
      });
    }
    return allowedResult();
  }

  /**
   * Called by SafetyGuardedToolExecutor after each tool invocation.
   * Updates session.consecutiveFailures and sets session.paused when the
   * threshold is reached. Returns a PauseNotification when the session is
   * paused, undefined otherwise.
   */
  recordResult(
    toolName: string,
    result: ToolResult<unknown>,
    session: SafetySession,
  ): PauseNotification | undefined {
    if (!result.ok) {
      const signature = computeSignature(toolName, result.error.type, result.error.message);

      // Clear all other signatures for this tool (different error observed).
      // Snapshot keys first to avoid mutating the Map during iteration.
      for (const key of [...session.consecutiveFailures.keys()]) {
        if (key.startsWith(`${toolName}:`) && key !== signature) {
          session.consecutiveFailures.delete(key);
        }
      }

      const count = (session.consecutiveFailures.get(signature) ?? 0) + 1;
      session.consecutiveFailures.set(signature, count);

      if (count >= 3) {
        session.paused = true;
        session.pauseReason = `Repeated failure '${signature}' detected ${count} times consecutively`;
        return { signature, occurrences: count };
      }
    } else {
      // Success — clear all failure signatures for this tool.
      // Snapshot keys first to avoid mutating the Map during iteration.
      for (const key of [...session.consecutiveFailures.keys()]) {
        if (key.startsWith(`${toolName}:`)) {
          session.consecutiveFailures.delete(key);
        }
      }
    }

    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 3.3 RateLimitGuard
// ---------------------------------------------------------------------------

/** Explicit set of tool names that perform file deletion and require bulk-delete checks. */
const DELETE_TOOLS = new Set(["delete_files", "remove_files", "bulk_delete"]);

const SIXTY_SECONDS_MS = 60_000;

function pruneOldTimestamps(timestamps: number[], nowMs: number): number[] {
  return timestamps.filter(t => nowMs - t < SIXTY_SECONDS_MS);
}

export class RateLimitGuard implements ISafetyGuard {
  readonly name = "rate-limit";
  private readonly nowMs: () => number;

  constructor(nowMs: () => number = Date.now) {
    this.nowMs = nowMs;
  }

  async check(toolName: string, _rawInput: unknown, context: SafetyContext): Promise<SafetyCheckResult> {
    const { session, config } = context;
    const now = this.nowMs();
    const { rateLimits } = config;

    // 1. Per-minute tool invocation rolling window
    const recentInvocations = pruneOldTimestamps(session.toolInvocationTimestamps, now);
    if (recentInvocations.length >= rateLimits.toolInvocationsPerMinute) {
      return blockedResult({
        type: "runtime",
        message:
          `Rate limit exceeded: tool invocation (${recentInvocations.length}/${rateLimits.toolInvocationsPerMinute} per minute)`,
      });
    }

    // 2. Per-session repo write counter
    if (REPO_WRITE_TOOLS.has(toolName)) {
      if (session.repoWriteCount >= rateLimits.repoWritesPerSession) {
        return blockedResult({
          type: "runtime",
          message:
            `Rate limit exceeded: repo write (${session.repoWriteCount}/${rateLimits.repoWritesPerSession} per session)`,
        });
      }
    }

    // 3. Per-minute API request rolling window
    if (API_REQUEST_TOOLS.has(toolName)) {
      const recentApiRequests = pruneOldTimestamps(session.apiRequestTimestamps, now);
      if (recentApiRequests.length >= rateLimits.apiRequestsPerMinute) {
        return blockedResult({
          type: "runtime",
          message:
            `Rate limit exceeded: api request (${recentApiRequests.length}/${rateLimits.apiRequestsPerMinute} per minute)`,
        });
      }
    }

    return allowedResult();
  }
}

// ---------------------------------------------------------------------------
// 3.4 DestructiveActionGuard
// ---------------------------------------------------------------------------

/**
 * Returns true when the normalized path matches a protected pattern.
 * Mirrors the logic in FilesystemGuard for consistency.
 */
function matchesAnyProtectedPattern(filePath: string, patterns: ReadonlyArray<string>): boolean {
  const base = basename(filePath);
  return patterns.some(pattern => pattern.includes("/") ? filePath.includes(pattern) : base === pattern);
}

export class DestructiveActionGuard implements ISafetyGuard {
  readonly name = "destructive-action";

  async check(toolName: string, rawInput: unknown, context: SafetyContext): Promise<SafetyCheckResult> {
    const { config } = context;
    const input = rawInput as Record<string, unknown>;

    // Check 1: Bulk file deletion above threshold
    if (DELETE_TOOLS.has(toolName)) {
      const paths = input.paths;
      if (Array.isArray(paths) && paths.length > config.maxFileDeletes) {
        return requiresApprovalResult(buildApprovalRequest(
          `Bulk deletion of ${paths.length} files (limit: ${config.maxFileDeletes})`,
          "high",
          `Permanently deletes ${paths.length} files from the workspace`,
          `delete_files with ${paths.length} paths`,
        ));
      }
    }

    // Check 2: Force-push flag on git push operations
    if (toolName === "git_push") {
      const force = input.force;
      if (force === true) {
        return requiresApprovalResult(buildApprovalRequest(
          "Force-push to remote repository",
          "critical",
          "Overwrites remote branch history — may cause data loss for other contributors",
          `git_push with force=true`,
        ));
      }
    }

    // Check 3: Write to protected file pattern
    if (toolName === "write_file") {
      const path = input.path;
      if (typeof path === "string" && matchesAnyProtectedPattern(path, config.protectedFilePatterns)) {
        return requiresApprovalResult(buildApprovalRequest(
          `Write to protected file: ${path}`,
          "high",
          `Modifies a protected file (${path}) which may contain secrets or critical configuration`,
          `write_file to ${path}`,
        ));
      }
    }

    return allowedResult();
  }
}

function buildApprovalRequest(
  description: string,
  riskClassification: ApprovalRequest["riskClassification"],
  expectedImpact: string,
  proposedAction: string,
): ApprovalRequest {
  return { description, riskClassification, expectedImpact, proposedAction };
}
