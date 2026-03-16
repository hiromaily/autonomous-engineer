import type { WorkflowEvent } from "@/application/ports/workflow";
import { open } from "node:fs/promises";

/**
 * Writes workflow events as newline-delimited JSON (NDJSON) to a file.
 */
export class JsonLogWriter {
  private readonly openPromise: Promise<import("node:fs/promises").FileHandle>;

  constructor(filePath: string) {
    this.openPromise = open(filePath, "w");
  }

  async write(event: WorkflowEvent): Promise<void> {
    const fh = await this.openPromise;
    await fh.write(`${JSON.stringify(event)}\n`);
  }

  async close(): Promise<void> {
    const fh = await this.openPromise;
    await fh.close();
  }
}
