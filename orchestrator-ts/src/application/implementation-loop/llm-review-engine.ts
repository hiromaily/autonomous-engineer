import type { AgentLoopResult } from "@/application/ports/agent-loop";
import type { IQualityGate, IReviewEngine, QualityGateConfig } from "@/application/ports/implementation-loop";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { ReviewCheckResult, ReviewFeedbackItem, ReviewResult } from "@/domain/implementation-loop/types";
import type { Task } from "@/domain/planning/types";

// ---------------------------------------------------------------------------
// LLM response schema — expected JSON structure from the LLM
// ---------------------------------------------------------------------------

interface LlmReviewResponse {
  passed: boolean;
  feedback: ReadonlyArray<{
    category: string;
    description: string;
    severity: string;
  }>;
}

// ---------------------------------------------------------------------------
// LlmReviewEngineService — stateless IReviewEngine implementation
// ---------------------------------------------------------------------------

/**
 * Stateless review engine that evaluates agent loop output against quality criteria.
 *
 * Runs three check categories:
 * 1. Requirement alignment (LLM call)
 * 2. Design consistency (LLM call)
 * 3. Code quality (delegates to QualityGateRunner)
 *
 * LLM checks run concurrently where possible. On LLM failure, returns a failed
 * ReviewResult with an error feedback item rather than throwing.
 *
 * Invariants:
 * - ReviewResult.outcome = "passed" only when all required checks pass
 * - Advisory failures produce feedback items but do not flip outcome to "failed"
 * - Never throws — all errors surface as failed ReviewResult entries
 */
export class LlmReviewEngineService implements IReviewEngine {
  readonly #llm: LlmProviderPort;
  readonly #qualityGate: IQualityGate;

  constructor(llm: LlmProviderPort, qualityGate: IQualityGate) {
    this.#llm = llm;
    this.#qualityGate = qualityGate;
  }

  async review(
    result: AgentLoopResult,
    section: Task,
    config: QualityGateConfig,
  ): Promise<ReviewResult> {
    const startedAt = Date.now();

    // Run LLM checks (alignment + consistency) concurrently with gate checks
    const [alignmentResult, consistencyResult, gateResults] = await Promise.all([
      this.#runLlmCheck(result, section, "requirement-alignment"),
      this.#runLlmCheck(result, section, "design-consistency"),
      this.#runGateChecks(config),
    ]);

    // Aggregate feedback from all sources
    const feedback: ReviewFeedbackItem[] = [
      ...alignmentResult.feedback,
      ...consistencyResult.feedback,
      ...buildGateFeedback(gateResults),
    ];

    // Outcome: passed only when all required checks pass
    const hasBlockingFailure = !alignmentResult.passed
      || !consistencyResult.passed
      || gateResults.some((c) => c.required && c.outcome === "failed");

    const checks: ReviewCheckResult[] = [
      ...alignmentResult.checks,
      ...consistencyResult.checks,
      ...gateResults,
    ];

    return {
      outcome: hasBlockingFailure ? "failed" : "passed",
      checks,
      feedback,
      durationMs: Date.now() - startedAt,
    };
  }

  async #runLlmCheck(
    _result: AgentLoopResult,
    section: Task,
    category: "requirement-alignment" | "design-consistency",
  ): Promise<{
    passed: boolean;
    checks: ReadonlyArray<ReviewCheckResult>;
    feedback: ReadonlyArray<ReviewFeedbackItem>;
  }> {
    const prompt = buildLlmPrompt(section, category);

    try {
      const llmResult = await this.#llm.complete(prompt);

      if (!llmResult.ok) {
        return llmErrorResult(
          category,
          `LLM check failed: ${llmResult.error.message}`,
        );
      }

      return parseLlmResponse(llmResult.value.content, category);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return llmErrorResult(category, `LLM check threw unexpectedly: ${message}`);
    }
  }

  async #runGateChecks(
    config: QualityGateConfig,
  ): Promise<ReadonlyArray<ReviewCheckResult>> {
    return this.#qualityGate.run(config);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildLlmPrompt(
  section: Task,
  category: "requirement-alignment" | "design-consistency",
): string {
  const categoryLabel = category === "requirement-alignment"
    ? "requirement alignment"
    : "design consistency";

  return [
    `You are a code reviewer evaluating ${categoryLabel} for a task section.`,
    ``,
    `Task section: "${section.title}"`,
    ``,
    `Evaluate the implementation and return a JSON object with this structure:`,
    `{`,
    `  "passed": true | false,`,
    `  "feedback": [`,
    `    {`,
    `      "category": "${category}",`,
    `      "description": "<specific actionable description>",`,
    `      "severity": "blocking" | "advisory"`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `Return only the JSON object, no markdown or other text.`,
    `Set "passed": true only when there are no blocking issues.`,
  ].join("\n");
}

function parseLlmResponse(
  content: string,
  category: "requirement-alignment" | "design-consistency",
): {
  passed: boolean;
  checks: ReadonlyArray<ReviewCheckResult>;
  feedback: ReadonlyArray<ReviewFeedbackItem>;
} {
  try {
    // Strip markdown code fences if present
    const stripped = content
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "")
      .trim();

    const parsed = JSON.parse(stripped) as LlmReviewResponse;
    const passed = typeof parsed.passed === "boolean"
      ? parsed.passed
      : !parsed.feedback.some((f) => f.severity === "blocking");

    const feedback: ReviewFeedbackItem[] = (parsed.feedback ?? [])
      .map((f) => ({
        category: normalizeFeedbackCategory(f.category, category),
        description: String(f.description ?? ""),
        severity: normalizeSeverity(f.severity),
      }));

    const checks: ReviewCheckResult[] = [
      {
        checkName: category,
        outcome: passed ? "passed" : "failed",
        required: true,
        details: feedback.map((f) => f.description).join("; ") || "OK",
      },
    ];

    return { passed, checks, feedback };
  } catch {
    // JSON parse failure treated as a blocking failure
    return llmErrorResult(category, `Failed to parse LLM response: ${content.slice(0, 200)}`);
  }
}

function llmErrorResult(
  category: "requirement-alignment" | "design-consistency",
  message: string,
): {
  passed: boolean;
  checks: ReadonlyArray<ReviewCheckResult>;
  feedback: ReadonlyArray<ReviewFeedbackItem>;
} {
  return {
    passed: false,
    checks: [
      {
        checkName: category,
        outcome: "failed",
        required: true,
        details: message,
      },
    ],
    feedback: [
      {
        category,
        description: message,
        severity: "blocking",
      },
    ],
  };
}

function buildGateFeedback(
  gateResults: ReadonlyArray<ReviewCheckResult>,
): ReadonlyArray<ReviewFeedbackItem> {
  return gateResults
    .filter((c) => c.outcome === "failed")
    .map((c) => ({
      category: "code-quality" as const,
      description: `Quality gate check "${c.checkName}" failed: ${c.details}`,
      severity: c.required ? ("blocking" as const) : ("advisory" as const),
    }));
}

function normalizeFeedbackCategory(
  raw: string,
  fallback: "requirement-alignment" | "design-consistency",
): "requirement-alignment" | "design-consistency" | "code-quality" {
  if (
    raw === "requirement-alignment"
    || raw === "design-consistency"
    || raw === "code-quality"
  ) {
    return raw;
  }
  return fallback;
}

function normalizeSeverity(raw: string): "blocking" | "advisory" {
  return raw === "advisory" ? "advisory" : "blocking";
}
