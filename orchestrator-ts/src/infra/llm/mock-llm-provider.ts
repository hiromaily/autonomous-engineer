import type { IDebugEventSink } from "@/application/ports/debug";
import type { LlmCompleteOptions, LlmProviderPort, LlmResult } from "@/application/ports/llm";
import type { ILogger } from "@/application/ports/logger";
import type { IWorkflowEventBus } from "@/application/ports/workflow";

export interface MockLlmProviderConfig {
  readonly sink: IDebugEventSink;
  /** WorkflowEventBus to subscribe for `phase:start` events; used to track current phase. */
  readonly workflowEventBus: IWorkflowEventBus;
  /** Optional operational logger for LLM interaction entries. */
  readonly logger?: ILogger;
}

/**
 * Minimal valid ActionPlan JSON for the PLAN step.
 * Uses `list_directory` on "." — a safe read-only tool present in the registry.
 */
const MOCK_PLAN_RESPONSE = JSON.stringify({
  category: "Exploration",
  toolName: "list_directory",
  toolInput: { path: "." },
  rationale: "[mock] exploring workspace",
});

/**
 * Minimal valid ReflectionOutput JSON for the REFLECT step.
 * Sets `taskComplete: true` so the agent loop terminates with TASK_COMPLETED.
 */
const MOCK_REFLECT_RESPONSE = JSON.stringify({
  assessment: "expected",
  learnings: ["[mock] task completed successfully"],
  planAdjustment: "stop",
  summary: "[mock] task completed",
  taskComplete: true,
});

/**
 * Minimal valid review response for LlmReviewEngineService prompts.
 * Sets `passed: true` with no feedback so the review passes immediately.
 */
const MOCK_REVIEW_RESPONSE = JSON.stringify({
  passed: true,
  feedback: [],
});

/**
 * Implements LlmProviderPort for --debug-flow mode.
 *
 * - Never makes real network calls.
 * - Returns step-appropriate mock JSON:
 *   - REFLECT prompts (detected by the "taskComplete" hint) → ReflectionOutput with taskComplete:true
 *   - All other prompts (PLAN, error-recovery) → a minimal ActionPlan
 * - Emits an llm:call event to IDebugEventSink on each call.
 * - Subscribes to workflowEventBus for phase:start events to track the current phase.
 * - callIndex is monotonically increasing; clearContext() does not reset it.
 */
export class MockLlmProvider implements LlmProviderPort {
  readonly #sink: IDebugEventSink;
  readonly #logger: ILogger | undefined;
  #callIndex = 0;
  #currentPhase = "UNKNOWN";

  constructor(config: MockLlmProviderConfig) {
    this.#sink = config.sink;
    this.#logger = config.logger;
    config.workflowEventBus.on((event) => {
      if (event.type === "phase:start") {
        this.#currentPhase = event.phase;
      }
    });
  }

  async complete(prompt: string, options?: LlmCompleteOptions): Promise<LlmResult> {
    const startMs = Date.now();
    this.#callIndex++;
    const callIndex = this.#callIndex;
    const phase = this.#currentPhase;
    const timestamp = new Date().toISOString();

    // Route to the correct mock response based on unique structural markers in each prompt type.
    // "planAdjustment" only appears in REFLECT step prompts (agent-loop-service.ts).
    // "You are a code reviewer evaluating" only appears in LlmReviewEngineService prompts.
    const response = prompt.includes("\"planAdjustment\"")
      ? MOCK_REFLECT_RESPONSE
      : prompt.includes("You are a code reviewer evaluating")
      ? MOCK_REVIEW_RESPONSE
      : MOCK_PLAN_RESPONSE;
    const durationMs = Date.now() - startMs;

    this.#sink.emit({
      type: "llm:call",
      callIndex,
      phase,
      iterationNumber: options?.iterationNumber ?? null,
      prompt,
      response,
      durationMs,
      timestamp,
    });

    return {
      ok: true,
      value: {
        content: response,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    };
  }

  clearContext(): void {
    // Resets conversation history only; callIndex and currentPhase are preserved.
  }
}
