import type { WorkflowEvent } from "@/application/ports/workflow";

/**
 * Port interface for writing workflow events as NDJSON to a log file.
 * Implemented by `adapters/cli/json-log-writer.ts`.
 */
export interface IJsonLogWriter {
  write(event: WorkflowEvent): Promise<void>;
  close(): Promise<void>;
}
