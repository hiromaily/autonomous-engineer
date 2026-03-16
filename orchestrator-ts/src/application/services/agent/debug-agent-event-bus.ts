import type { IAgentEventBus } from "@/application/ports/agent-loop";
import type { IDebugEventSink } from "@/application/ports/debug";
import type { IWorkflowEventBus } from "@/application/ports/workflow";
import type { AgentLoopEvent } from "@/domain/agent/types";

export interface DebugAgentEventBusConfig {
  readonly sink: IDebugEventSink;
  readonly workflowEventBus: IWorkflowEventBus;
}

/**
 * Implements IAgentEventBus for --debug-flow mode.
 *
 * - Translates `iteration:complete` AgentLoopEvents to `agent:iteration` DebugEvents.
 * - All event types are forwarded to registered on() subscribers.
 * - Other event types do not emit to the debug sink.
 * - Subscribes to workflowEventBus for phase:start events to track the current phase.
 */
export class DebugAgentEventBus implements IAgentEventBus {
  readonly #sink: IDebugEventSink;
  readonly #handlers: Set<(event: AgentLoopEvent) => void> = new Set();
  #currentPhase = "UNKNOWN";

  constructor(config: DebugAgentEventBusConfig) {
    this.#sink = config.sink;
    config.workflowEventBus.on((event) => {
      if (event.type === "phase:start") {
        this.#currentPhase = event.phase;
      }
    });
  }

  emit(event: AgentLoopEvent): void {
    // Translate iteration:complete to agent:iteration debug event
    if (event.type === "iteration:complete") {
      this.#sink.emit({
        type: "agent:iteration",
        iterationNumber: event.iteration,
        phase: this.#currentPhase,
        actionCategory: event.category,
        toolName: event.toolName,
        durationMs: event.durationMs,
        timestamp: new Date().toISOString(),
      });
    }

    // Forward all events to on() subscribers
    for (const handler of this.#handlers) {
      handler(event);
    }
  }

  on(handler: (event: AgentLoopEvent) => void): void {
    this.#handlers.add(handler);
  }

  off(handler: (event: AgentLoopEvent) => void): void {
    this.#handlers.delete(handler);
  }
}
