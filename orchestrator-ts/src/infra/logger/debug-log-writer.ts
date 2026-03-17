import type { IDebugEventSink } from "@/application/ports/debug";
import type { DebugEvent } from "@/domain/debug/types";

const PROMPT_PREVIEW_LENGTH = 500;

function formatEventHuman(event: DebugEvent): string {
  switch (event.type) {
    case "llm:call": {
      const iterLabel = event.iterationNumber !== null ? ` iter=${event.iterationNumber}` : "";
      const promptPreview = event.prompt.length > PROMPT_PREVIEW_LENGTH
        ? `${event.prompt.slice(0, PROMPT_PREVIEW_LENGTH)}… (${event.prompt.length} chars total)`
        : event.prompt;
      return `[LLM #${event.callIndex}] phase=${event.phase}${iterLabel}\n  Prompt: ${promptPreview}`;
    }
    case "llm:error": {
      const promptPreview = event.prompt.length > PROMPT_PREVIEW_LENGTH
        ? `${event.prompt.slice(0, PROMPT_PREVIEW_LENGTH)}… (${event.prompt.length} chars total)`
        : event.prompt;
      return `[LLM #${event.callIndex}] phase=${event.phase} ERROR category=${event.errorCategory}: ${event.errorMessage}\n  Prompt: ${promptPreview}`;
    }
    case "sdd:operation": {
      const resultLabel = event.outcome === "ok"
        ? `→ ${event.artifactPath ?? "ok"}`
        : "→ error";
      return `[SDD] operation=${event.operation} spec=${event.specName} ${resultLabel}`;
    }
    default:
      return `[DEBUG] ${JSON.stringify(event)}`;
  }
}

/**
 * Writes debug events as human-readable text to `process.stderr`.
 *
 * - `llm:call`/`llm:error` events are formatted as human-readable text.
 * - All other events are written as `[DEBUG] <JSON>\n`.
 * - `emit()` is synchronous.
 * - Calls to `emit()` after `close()` are silently dropped.
 */
export class DebugLogWriter implements IDebugEventSink {
  private closed = false;

  emit(event: DebugEvent): void {
    if (this.closed) return;
    process.stderr.write(`${formatEventHuman(event)}\n`);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
