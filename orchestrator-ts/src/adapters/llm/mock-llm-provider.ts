import type { IDebugEventSink } from "@/application/ports/debug";
import type { LlmCompleteOptions, LlmProviderPort, LlmResult } from "@/application/ports/llm";
import type { IWorkflowEventBus } from "@/application/ports/workflow";

export interface MockLlmProviderConfig {
  readonly defaultResponse: string;
  readonly sink: IDebugEventSink;
  /** WorkflowEventBus to subscribe for `phase:start` events; used to track current phase. */
  readonly workflowEventBus: IWorkflowEventBus;
}

/**
 * Implements LlmProviderPort for --debug-flow mode.
 *
 * - Never makes real network calls.
 * - Returns a deterministic mock response for every complete() call.
 * - Emits an llm:call or llm:error event to IDebugEventSink on each call.
 * - Subscribes to workflowEventBus for phase:start events to track the current phase.
 * - callIndex is monotonically increasing; clearContext() does not reset it.
 */
export class MockLlmProvider implements LlmProviderPort {
  readonly #defaultResponse: string;
  readonly #sink: IDebugEventSink;
  #callIndex = 0;
  #currentPhase = "UNKNOWN";

  constructor(config: MockLlmProviderConfig) {
    this.#defaultResponse = config.defaultResponse;
    this.#sink = config.sink;
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

    const response = this.#defaultResponse;
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
