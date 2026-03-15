import type { ISelfHealingLoop } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { FailureRecord, MemoryEntry, MemoryPort, MemoryTarget } from "@/application/ports/memory";
import type { ISelfHealingLoopLogger } from "@/application/ports/self-healing-loop-logger";
import type { SectionEscalation, SelfHealingResult } from "@/domain/implementation-loop/types";
import type {
  AnalysisCompleteLogEntry,
  EscalationIntakeLogEntry,
  GapIdentifiedLogEntry,
  GapReport,
  KnowledgeMemoryFile,
  MemoryWriteAction,
  RootCauseAnalysis,
  RuleUpdatedLogEntry,
} from "@/domain/self-healing/types";
import { join as joinPath, resolve as resolvePath, sep as pathSep } from "node:path";

// ---------------------------------------------------------------------------
// SelfHealingLoopConfig — tunable parameters (requirement 1.5)
// ---------------------------------------------------------------------------

/**
 * Configuration value object for SelfHealingLoopService.
 * All timeouts are in milliseconds. Retry and size values are counts/bytes.
 */
export interface SelfHealingLoopConfig {
  /** Absolute path to the workspace root. Used for boundary validation of rule file paths. */
  readonly workspaceRoot: string;
  /** Maximum milliseconds for the entire escalate() call. Default: 120_000. */
  readonly selfHealingTimeoutMs: number;
  /** Maximum milliseconds for a single LLM analysis or gap-identification call. Default: 60_000. */
  readonly analysisTimeoutMs: number;
  /** Maximum LLM retry attempts for analysis or gap identification. Default: 2. */
  readonly maxAnalysisRetries: number;
  /** Maximum bytes per failure record before agentObservations truncation. Default: 65_536. */
  readonly maxRecordSizeBytes: number;
}

/** Default configuration values for SelfHealingLoopConfig. */
export const DEFAULT_SELF_HEALING_CONFIG: Omit<SelfHealingLoopConfig, "workspaceRoot"> = {
  selfHealingTimeoutMs: 120_000,
  analysisTimeoutMs: 60_000,
  maxAnalysisRetries: 2,
  maxRecordSizeBytes: 65_536,
};

// ---------------------------------------------------------------------------
// SelfHealingLoopService — implements ISelfHealingLoop (requirements 1.1–8.5)
// ---------------------------------------------------------------------------

/**
 * Implements the ISelfHealingLoop port. Activated when the implementation loop
 * exhausts its per-section retry budget. Performs LLM-driven root-cause analysis,
 * targeted rule updates, and structured failure persistence.
 *
 * Key invariants:
 * - `escalate()` never throws on any code path (requirement 1.1).
 * - `#inFlightSections` is always consistent — every entry is removed in the finally block (requirement 1.4).
 * - `MemoryPort.writeFailure()` is called for every escalate() invocation regardless of outcome (requirement 5.1).
 * - No credentials or workspace-external paths are included in log entries (requirement 8.5).
 */
export class SelfHealingLoopService implements ISelfHealingLoop {
  readonly #llm: LlmProviderPort;
  readonly #memory: MemoryPort;
  readonly #config: SelfHealingLoopConfig;
  readonly #logger: ISelfHealingLoopLogger | undefined;

  /**
   * Concurrency guard: tracks sectionIds currently being processed.
   * `readonly` prevents reassignment of the reference; Set contents are still mutable via .add()/.delete().
   */
  readonly #inFlightSections: Set<string> = new Set();

  constructor(
    llm: LlmProviderPort,
    memory: MemoryPort,
    config: SelfHealingLoopConfig,
    logger?: ISelfHealingLoopLogger,
  ) {
    this.#llm = llm;
    this.#memory = memory;
    this.#config = config;
    this.#logger = logger;
  }

  /**
   * Escalate an exhausted section to the self-healing workflow.
   *
   * The entire workflow is wrapped with `Promise.race` using `selfHealingTimeoutMs`.
   * If the timeout fires, the failure record is written before returning.
   *
   * Never throws — all errors surface as `SelfHealingResult { outcome: "unresolved" }`.
   *
   * Requirements: 1.1, 1.5
   */
  async escalate(escalation: SectionEscalation): Promise<SelfHealingResult> {
    const startTime = Date.now();
    try {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const timeoutPromise = new Promise<SelfHealingResult>((resolve) => {
        timeoutId = setTimeout(async () => {
          // Write the failure record before resolving the timeout (requirement 1.5)
          await this.#persistFailureRecord(escalation, null, null, "unresolved").catch(() => {
            // Failure record write errors on timeout path are silently ignored
          });
          resolve({
            outcome: "unresolved",
            summary: `Self-healing timed out after ${this.#config.selfHealingTimeoutMs}ms`,
          });
        }, this.#config.selfHealingTimeoutMs);
      });

      const workflowPromise = this.#runHealingWorkflow(escalation, startTime).finally(() => {
        clearTimeout(timeoutId);
      });

      return await Promise.race([workflowPromise, timeoutPromise]);
    } catch (e) {
      // Catch-all safety net — no code path should reach here normally
      return {
        outcome: "unresolved",
        summary: `Unexpected error in self-healing escalation: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Internal workflow — tasks 3.2–8.2 will fill in this method
  // ---------------------------------------------------------------------------

  /**
   * Orchestrates the self-healing workflow steps:
   * intake validation → root-cause analysis → gap identification → rule update → result assembly.
   *
   * Intake validation (task 3.2):
   * - Emits `escalation-intake` log entry with retryHistoryCount.
   * - Returns unresolved immediately if retryHistory is empty (requirement 1.2).
   * - Returns unresolved if sectionId is already in-flight (requirement 1.4).
   * - Adds sectionId to #inFlightSections; removes it in a finally block (requirement 1.4).
   *
   * The failure record is written in a finally block regardless of outcome (task 7.2).
   */
  async #runHealingWorkflow(escalation: SectionEscalation, startTime: number): Promise<SelfHealingResult> {
    // --- Intake: always log first (requirement 8.1) ---
    const intakeEntry: EscalationIntakeLogEntry = {
      type: "escalation-intake",
      sectionId: escalation.sectionId,
      planId: escalation.planId,
      timestamp: new Date().toISOString(),
      retryHistoryCount: escalation.retryHistory.length,
    };
    this.#logger?.log(intakeEntry);

    // --- Guard 1: empty retryHistory (requirement 1.2) ---
    if (escalation.retryHistory.length === 0) {
      return {
        outcome: "unresolved",
        summary: "No retry history available: root-cause analysis requires at least one prior attempt.",
      };
    }

    // --- Guard 2: concurrent escalation for same sectionId (requirement 1.4) ---
    if (this.#inFlightSections.has(escalation.sectionId)) {
      return {
        outcome: "unresolved",
        summary: `Concurrent escalation in progress for section "${escalation.sectionId}": skipping duplicate.`,
      };
    }

    // --- Register section as in-flight; always deregister in finally (requirement 1.4) ---
    this.#inFlightSections.add(escalation.sectionId);
    try {
      // Task 4.1: Root-cause analysis with LLM retry loop
      const analysisResult = await this.#analyzeRootCause(escalation, startTime);
      if (!analysisResult.ok) {
        return { outcome: "unresolved", summary: analysisResult.summary };
      }

      // Task 4.2: Emit analysis-complete log entry (requirement 2.4)
      const analysis = analysisResult.value;
      const analysisCompleteEntry: AnalysisCompleteLogEntry = {
        type: "analysis-complete",
        sectionId: escalation.sectionId,
        planId: escalation.planId,
        timestamp: new Date().toISOString(),
        recurringPattern: analysis.recurringPattern,
      };
      this.#logger?.log(analysisCompleteEntry);

      // Task 4.2: Hand off to gap identification
      return await this.#identifyGap(escalation, analysis, startTime);
    } finally {
      this.#inFlightSections.delete(escalation.sectionId);
    }
  }

  // ---------------------------------------------------------------------------
  // LLM retry helper — shared by root-cause analysis and gap identification
  // ---------------------------------------------------------------------------

  /**
   * Execute an LLM call with retry loop, per-call timeout, and elapsed-time guard.
   *
   * Centralises the duplicated retry pattern used by both `#analyzeRootCause` and
   * `#identifyGap`: elapsed-guard → Promise.race timeout → parse → retry on failure.
   *
   * @param prompt    Full prompt passed to the LLM provider.
   * @param startTime Timestamp when escalate() was called (for outer timeout guard).
   * @param parser    Converts raw LLM content to a typed result:
   *                  - `{ ok: true, value }` — success, stop retrying.
   *                  - `{ ok: false, noRetry: true, summary }` — terminal semantic failure (e.g. no gap found), stop immediately.
   *                  - `{ ok: false, noRetry: false }` — parse error, trigger a retry.
   * @param stepName  Human-readable step label used in error messages.
   */
  async #runLlmWithRetry<T>(
    prompt: string,
    startTime: number,
    parser: (content: string) =>
      | { ok: true; value: T }
      | { ok: false; noRetry: true; summary: string }
      | { ok: false; noRetry: false },
    stepName: string,
  ): Promise<{ ok: true; value: T } | { ok: false; summary: string }> {
    let lastError = `${stepName} did not start`;

    for (let attempt = 0; attempt <= this.#config.maxAnalysisRetries; attempt++) {
      // Elapsed-time guard: skip if outer timeout is already consumed (requirements 2.5, 3.1)
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.#config.selfHealingTimeoutMs) {
        return {
          ok: false,
          summary:
            `${stepName} skipped: outer timeout already consumed (elapsed ${elapsed}ms, limit ${this.#config.selfHealingTimeoutMs}ms)`,
        };
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const llmResult = await Promise.race([
          this.#llm.complete(prompt),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error(`LLM call timed out after ${this.#config.analysisTimeoutMs}ms`)),
              this.#config.analysisTimeoutMs,
            );
          }),
        ]);
        clearTimeout(timeoutId);

        if (!llmResult.ok) {
          lastError = `LLM call failed: ${llmResult.error.message}`;
          continue;
        }

        const parsed = parser(llmResult.value.content);

        if (!parsed.ok) {
          if (parsed.noRetry) {
            // Terminal semantic failure — propagate summary immediately, do not retry
            return { ok: false, summary: parsed.summary };
          }
          lastError = `Failed to parse LLM response for ${stepName}`;
          continue;
        }

        return { ok: true, value: parsed.value };
      } catch (e) {
        clearTimeout(timeoutId);
        lastError = e instanceof Error ? e.message : String(e);
        // timeout or unexpected error — continue to next retry
      }
    }

    return {
      ok: false,
      summary: `${stepName} failed after ${this.#config.maxAnalysisRetries + 1} attempt(s): ${lastError}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Root-cause analysis — task 4.1
  // ---------------------------------------------------------------------------

  static readonly #ROOT_CAUSE_SYSTEM_PROMPT =
    `You are a root-cause analysis assistant for an autonomous software engineering agent.
Your task: analyze the retry history and identify why the implementation agent failed repeatedly.

Return ONLY a valid JSON object with this exact structure:
{
  "attemptsNarrative": "Description of what was attempted in each retry",
  "failureNarrative": "Description of what failed each time and why",
  "recurringPattern": "The concise cross-attempt theme or root cause"
}

Rules:
- Return only the JSON object, no markdown, no extra text
- All fields must be non-empty strings
- Do not include API keys, credentials, or workspace-external paths`;

  /**
   * Build the LLM prompt for root-cause analysis.
   * Serializes retryHistory, reviewFeedback, and agentObservations from the escalation.
   *
   * Requirements: 2.1
   */
  #buildRootCausePrompt(escalation: SectionEscalation): string {
    const userMessage = [
      `Section ID: ${escalation.sectionId}`,
      `Plan ID: ${escalation.planId}`,
      "",
      "=== Retry History ===",
      JSON.stringify(escalation.retryHistory, null, 2),
      "",
      "=== Review Feedback ===",
      JSON.stringify(escalation.reviewFeedback, null, 2),
      "",
      "=== Agent Observations ===",
      JSON.stringify(escalation.agentObservations, null, 2),
    ].join("\n");
    return `${SelfHealingLoopService.#ROOT_CAUSE_SYSTEM_PROMPT}\n\n${userMessage}`;
  }

  /**
   * Attempt to parse a string as RootCauseAnalysis. Returns null on any parse error
   * or if required fields are missing or have wrong types.
   */
  #tryParseRootCauseAnalysis(content: string): RootCauseAnalysis | null {
    try {
      const obj = JSON.parse(content) as unknown;
      if (
        obj !== null
        && typeof obj === "object"
        && "attemptsNarrative" in obj
        && "failureNarrative" in obj
        && "recurringPattern" in obj
        && typeof (obj as Record<string, unknown>).attemptsNarrative === "string"
        && typeof (obj as Record<string, unknown>).failureNarrative === "string"
        && typeof (obj as Record<string, unknown>).recurringPattern === "string"
      ) {
        const record = obj as Record<string, unknown>;
        return {
          attemptsNarrative: record.attemptsNarrative as string,
          failureNarrative: record.failureNarrative as string,
          recurringPattern: record.recurringPattern as string,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Perform LLM-driven root-cause analysis with retry loop and per-call timeout.
   * Delegates retry/timeout/elapsed-guard logic to `#runLlmWithRetry`.
   *
   * Requirements: 2.1, 2.3, 2.5
   */
  async #analyzeRootCause(
    escalation: SectionEscalation,
    startTime: number,
  ): Promise<{ ok: true; value: RootCauseAnalysis } | { ok: false; summary: string }> {
    const prompt = this.#buildRootCausePrompt(escalation);
    return this.#runLlmWithRetry(
      prompt,
      startTime,
      (content) => {
        const parsed = this.#tryParseRootCauseAnalysis(content);
        return parsed ? { ok: true, value: parsed } : { ok: false, noRetry: false as const };
      },
      "Root-cause analysis",
    );
  }

  // ---------------------------------------------------------------------------
  // Gap identification — task 5.1–5.2
  // ---------------------------------------------------------------------------

  /** Supported knowledge rule files that the self-healing loop may update. */
  static readonly #SUPPORTED_KNOWLEDGE_FILES = new Set<string>([
    "coding_rules",
    "review_rules",
    "implementation_patterns",
    "debugging_patterns",
  ]);

  static readonly #GAP_IDENTIFICATION_SYSTEM_PROMPT =
    `You are a knowledge gap analyst for an autonomous software engineering agent.
Your task: given a root-cause analysis, identify which rule file needs updating to prevent this class of failure.

Return ONLY a valid JSON object with this exact structure:
{
  "targetFile": "coding_rules" | "review_rules" | "implementation_patterns" | "debugging_patterns" | null,
  "proposedChange": "Specific addition or correction text (empty string when targetFile is null)",
  "rationale": "Explanation linking the gap to the observed failure pattern"
}

Valid targetFile values: coding_rules, review_rules, implementation_patterns, debugging_patterns
Set targetFile to null if no actionable knowledge gap can be identified from the failure pattern.

Rules:
- Return only the JSON object, no markdown, no extra text
- proposedChange and rationale must be non-empty strings when targetFile is non-null
- Do not include API keys, credentials, or workspace-external paths`;

  /**
   * Build the LLM prompt for gap identification.
   * Includes the root-cause analysis and current rule file contents.
   *
   * Requirements: 3.1
   */
  #buildGapPrompt(analysis: RootCauseAnalysis, ruleFileContents: string): string {
    const userMessage = [
      "=== Root-Cause Analysis ===",
      JSON.stringify(analysis, null, 2),
      "",
      "=== Current Rule File Contents ===",
      ruleFileContents || "(no entries found)",
    ].join("\n");
    return `${SelfHealingLoopService.#GAP_IDENTIFICATION_SYSTEM_PROMPT}\n\n${userMessage}`;
  }

  /**
   * Parse LLM response into a GapReport parse result.
   *
   * Returns:
   * - `{ ok: true, value: GapReport }` — valid gap identified
   * - `{ ok: false, noRetry: true, ... }` — terminal semantic failure (no gap / unsupported file)
   * - `{ ok: false, noRetry: false }` — parse error, should retry
   *
   * The three-way return type matches the `parser` parameter of `#runLlmWithRetry`.
   */
  #tryParseGapReport(content: string):
    | { ok: true; value: GapReport }
    | { ok: false; noRetry: true; summary: string }
    | { ok: false; noRetry: false }
  {
    try {
      const obj = JSON.parse(content) as unknown;
      if (obj === null || typeof obj !== "object") return { ok: false, noRetry: false };

      const record = obj as Record<string, unknown>;

      // No actionable gap: LLM explicitly returned null targetFile
      if (record.targetFile === null) {
        return {
          ok: false,
          noRetry: true,
          summary: `No actionable gap identified: ${String(record.rationale ?? "LLM found no missing rule")}`,
        };
      }

      // Validate required string fields
      if (
        typeof record.targetFile !== "string"
        || typeof record.proposedChange !== "string"
        || typeof record.rationale !== "string"
      ) {
        return { ok: false, noRetry: false };
      }

      // Validate targetFile is in the supported set
      if (!SelfHealingLoopService.#SUPPORTED_KNOWLEDGE_FILES.has(record.targetFile)) {
        const supported = [...SelfHealingLoopService.#SUPPORTED_KNOWLEDGE_FILES].join(", ");
        return {
          ok: false,
          noRetry: true,
          summary: `Gap identification returned unsupported rule file: "${record.targetFile}". Supported: ${supported}`,
        };
      }

      return {
        ok: true,
        value: {
          targetFile: record.targetFile as KnowledgeMemoryFile,
          proposedChange: record.proposedChange,
          rationale: record.rationale,
        },
      };
    } catch {
      return { ok: false, noRetry: false };
    }
  }

  /**
   * Identify the knowledge gap from the root-cause analysis.
   *
   * - Reads current rule file contents via MemoryPort.query() before the LLM call (requirement 3.1).
   * - Delegates retry/timeout/elapsed-guard to `#runLlmWithRetry` with `#tryParseGapReport` as parser.
   * - Returns unresolved if the LLM reports no actionable gap or targetFile is unsupported (requirement 3.3).
   * - Emits a gap-identified log entry with targetFile after successful parse (requirement 3.5).
   * - Checks for duplicate gaps via `#checkDuplicateGap` before proceeding (requirement 3.4).
   *
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
   */
  async #identifyGap(
    escalation: SectionEscalation,
    analysis: RootCauseAnalysis,
    startTime: number,
  ): Promise<SelfHealingResult> {
    // Read current rule file contents (requirement 3.1)
    let ruleFileContents: string;
    try {
      const queryResult = await this.#memory.query({
        text: "rules patterns guidelines coding review implementation debugging",
        memoryTypes: ["knowledge"],
        topN: 50,
      });
      ruleFileContents = queryResult.entries
        .map((e) => `[${e.sourceFile}] ${e.entry.title}: ${e.entry.description}`)
        .join("\n");
    } catch {
      ruleFileContents = "(rule file query failed)";
    }

    const prompt = this.#buildGapPrompt(analysis, ruleFileContents);

    const gapResult = await this.#runLlmWithRetry(
      prompt,
      startTime,
      (content) => this.#tryParseGapReport(content),
      "Gap identification",
    );

    if (!gapResult.ok) {
      return { outcome: "unresolved", summary: gapResult.summary };
    }

    const gap = gapResult.value;

    // Emit gap-identified log entry (requirement 3.5)
    const gapEntry: GapIdentifiedLogEntry = {
      type: "gap-identified",
      sectionId: escalation.sectionId,
      planId: escalation.planId,
      timestamp: new Date().toISOString(),
      targetFile: gap.targetFile,
    };
    this.#logger?.log(gapEntry);

    // Detect duplicate gaps via failure memory (requirement 3.4)
    const isDuplicate = await this.#checkDuplicateGap(escalation.sectionId, gap);
    if (isDuplicate) {
      return {
        outcome: "unresolved",
        summary:
          "Duplicate gap detected: this targetFile + proposedChange combination was already recorded for this section.",
      };
    }

    // Task 6.1: Validate resolved rule file path against workspace boundary (requirements 4.5, 8.5)
    const pathValidation = this.#validateRulePath(gap.targetFile);
    if (!pathValidation.ok) {
      return { outcome: "unresolved", summary: pathValidation.summary };
    }

    // Task 6.2: Write the proposed change to the target rule file (requirements 4.1–4.4)
    const writeResult = await this.#updateRuleFile(escalation, gap);
    if (!writeResult.ok) {
      return { outcome: "unresolved", summary: writeResult.summary };
    }

    // Tasks 7–8 will add failure record persistence and result assembly.
    // Stub: return unresolved with updatedRules collected, pending those tasks.
    return {
      outcome: "unresolved",
      summary:
        `Failure record persistence and result assembly not yet implemented (tasks 7–8 pending): rule updated in ${writeResult.relativePath}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Workspace boundary validation — task 6.1 (requirements 4.5, 8.5)
  // ---------------------------------------------------------------------------

  /**
   * Map a KnowledgeMemoryFile identifier to its workspace-relative file path.
   * Rule files live under `.kiro/steering/` as Markdown documents.
   *
   * Exposed as a public static to allow direct unit-testing of the path mapping.
   *
   * Requirements: 4.5
   */
  static ruleFileRelativePath(targetFile: KnowledgeMemoryFile): string {
    return joinPath(".kiro", "steering", `${targetFile}.md`);
  }

  /**
   * Return true iff `absolutePath` is the same as `workspaceRoot` or a descendant of it.
   * Uses `path.resolve` for normalisation (removes `..`, trailing separators, etc.) and
   * appends `path.sep` before the `startsWith` check so that a sibling directory that shares
   * a common prefix (e.g. `/workspace-other`) is NOT incorrectly accepted.
   *
   * Exposed as a public static so tests can verify the boundary logic directly.
   *
   * Requirements: 4.5, 8.5
   */
  static isPathWithinWorkspace(workspaceRoot: string, absolutePath: string): boolean {
    const normalizedRoot = resolvePath(workspaceRoot);
    const normalizedPath = resolvePath(absolutePath);
    return (
      normalizedPath === normalizedRoot
      || normalizedPath.startsWith(normalizedRoot + pathSep)
    );
  }

  /**
   * Resolve and validate the rule file path for `targetFile`.
   *
   * Returns `{ ok: true, resolvedPath }` when the path is inside `workspaceRoot`.
   * Returns `{ ok: false, summary }` with "workspace safety violation" when it is not.
   * The resolved path is never exposed in log entries on the failure path (requirement 8.5).
   *
   * Requirements: 4.5
   */
  #validateRulePath(
    targetFile: KnowledgeMemoryFile,
  ): { ok: true; resolvedPath: string } | { ok: false; summary: string } {
    const relPath = SelfHealingLoopService.ruleFileRelativePath(targetFile);
    const resolvedPath = resolvePath(this.#config.workspaceRoot, relPath);

    if (!SelfHealingLoopService.isPathWithinWorkspace(this.#config.workspaceRoot, resolvedPath)) {
      return {
        ok: false,
        summary:
          `Workspace safety violation: the resolved rule file path for "${targetFile}" falls outside the workspace boundary.`,
      };
    }

    return { ok: true, resolvedPath };
  }

  // ---------------------------------------------------------------------------
  // Rule file write — task 6.2 (requirements 4.1–4.4)
  // ---------------------------------------------------------------------------

  /**
   * Build a `MemoryEntry` from `GapReport` fields and escalation context.
   *
   * Mapping (requirement 4.2):
   * - `title`       : `proposedChange` prefix (first 80 chars) + " [sectionId]" — ensures uniqueness
   * - `context`     : "planId/sectionId" — full traceability reference
   * - `description` : `proposedChange` + machine-readable marker "<!-- self-healing: <sectionId> <timestamp> -->"
   * - `date`        : current ISO 8601 timestamp
   *
   * Never includes LLM API keys, credentials, or workspace-external paths (requirement 8.5).
   */
  #buildMemoryEntry(escalation: SectionEscalation, gap: GapReport, timestamp: string): MemoryEntry {
    const titlePrefix = gap.proposedChange.length > 80
      ? `${gap.proposedChange.slice(0, 80)}…`
      : gap.proposedChange;
    return {
      title: `${titlePrefix} [${escalation.sectionId}]`,
      context: `${escalation.planId}/${escalation.sectionId}`,
      description: `${gap.proposedChange}\n<!-- self-healing: ${escalation.sectionId} ${timestamp} -->`,
      date: timestamp,
    };
  }

  /**
   * Write the proposed change from `gap` to the target rule file via `MemoryPort.append()`.
   *
   * Steps:
   * 1. Build the `MemoryEntry` with the machine-readable marker (requirement 4.2).
   * 2. Call `MemoryPort.append()` with trigger `"self_healing"`.
   * 3. On failure, return `{ ok: false, summary }` with the error message (requirement 4.3).
   * 4. On success, emit a `rule-updated` log entry and return the workspace-relative path (requirement 4.4).
   *
   * Requirements: 4.1, 4.2, 4.3, 4.4
   */
  async #updateRuleFile(
    escalation: SectionEscalation,
    gap: GapReport,
  ): Promise<{ ok: true; relativePath: string; action: MemoryWriteAction } | { ok: false; summary: string }> {
    const timestamp = new Date().toISOString();
    const entry = this.#buildMemoryEntry(escalation, gap, timestamp);
    const target: MemoryTarget = { type: "knowledge", file: gap.targetFile };

    const writeResult = await this.#memory.append(target, entry, "self_healing");

    if (!writeResult.ok) {
      return {
        ok: false,
        summary: `Rule file write failed for "${gap.targetFile}": ${writeResult.error.message}`,
      };
    }

    // Emit rule-updated log entry (requirement 4.4)
    const ruleUpdatedEntry: RuleUpdatedLogEntry = {
      type: "rule-updated",
      sectionId: escalation.sectionId,
      planId: escalation.planId,
      timestamp: new Date().toISOString(),
      targetFile: gap.targetFile,
      memoryWriteAction: writeResult.action,
    };
    this.#logger?.log(ruleUpdatedEntry);

    const relativePath = SelfHealingLoopService.ruleFileRelativePath(gap.targetFile);
    return { ok: true, relativePath, action: writeResult.action };
  }

  // ---------------------------------------------------------------------------
  // Duplicate gap detection — task 5.2
  // ---------------------------------------------------------------------------

  /**
   * Encode targetFile + proposedChange into the ruleUpdate field format for FailureRecord.
   * Public so that task 7.1 (failure record persistence) can use the same encoding when writing,
   * ensuring the reader (task 5.2) and the writer always use a consistent format.
   *
   * Format: JSON.stringify({ targetFile, proposedChange })
   *
   * Requirements: 3.4
   */
  static encodeRuleUpdate(targetFile: KnowledgeMemoryFile, proposedChange: string): string {
    return JSON.stringify({ targetFile, proposedChange });
  }

  /**
   * Return true when a ruleUpdate field value encodes the same targetFile + proposedChange.
   */
  static #matchesRuleUpdate(
    ruleUpdate: string,
    targetFile: KnowledgeMemoryFile,
    proposedChange: string,
  ): boolean {
    try {
      const parsed = JSON.parse(ruleUpdate) as unknown;
      if (parsed === null || typeof parsed !== "object") return false;
      const record = parsed as Record<string, unknown>;
      return record.targetFile === targetFile && record.proposedChange === proposedChange;
    } catch {
      return false;
    }
  }

  /**
   * Return true when a prior failure record for the same sectionId already contains
   * an identical targetFile + proposedChange combination.
   *
   * Falls back to false when getFailures throws, to avoid blocking the workflow.
   *
   * Requirements: 3.4
   */
  async #checkDuplicateGap(sectionId: string, gap: GapReport): Promise<boolean> {
    try {
      const priorRecords = await this.#memory.getFailures({ taskId: sectionId });
      return priorRecords.some(
        (record) =>
          record.ruleUpdate !== undefined
          && SelfHealingLoopService.#matchesRuleUpdate(record.ruleUpdate, gap.targetFile, gap.proposedChange),
      );
    } catch {
      // getFailures is documented as "never throws" but guard defensively;
      // treat a thrown error as no prior records to avoid blocking the workflow.
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Failure record persistence — task 7.1–7.2 will complete this method
  // ---------------------------------------------------------------------------

  /**
   * Build and persist a FailureRecord via MemoryPort.writeFailure().
   * Stub for task 3.1 — task 7.1 will add full field mapping and truncation.
   *
   * Requirements: 5.1–5.4
   */
  async #persistFailureRecord(
    escalation: SectionEscalation,
    rootCause: string | null,
    _gapReport: GapReport | null,
    _outcome: "resolved" | "unresolved",
  ): Promise<void> {
    // Task 7.1 will map _outcome and _gapReport into the full SelfHealingFailureRecord shape.
    // FailureRecord (MemoryPort) does not carry an outcome field yet.
    const record: FailureRecord = {
      taskId: escalation.sectionId,
      specName: escalation.planId,
      phase: "IMPLEMENTATION",
      attempted: JSON.stringify(escalation.retryHistory),
      errors: rootCause ? [rootCause] : [],
      rootCause: rootCause ?? "unknown",
      ruleUpdate: undefined,
      timestamp: new Date().toISOString(),
    };
    await this.#memory.writeFailure(record);
  }
}
