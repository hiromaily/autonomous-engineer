import type { IDebugEventSink } from "@/application/ports/debug";
import type { DebugEvent } from "@/domain/debug/types";
import { type FileHandle, open } from "node:fs/promises";

/**
 * Writes debug events to stderr (default) or as NDJSON to a file.
 *
 * - No file path: each event is written as `[DEBUG] <JSON>\n` to `process.stderr`.
 * - With file path: each event is written as `<JSON>\n` (NDJSON) to the file.
 * - File-open failure: warning emitted to stderr; all subsequent events fall back to stderr.
 * - `emit()` is synchronous — file writes are queued and resolved by `close()`.
 * - Calls to `emit()` after `close()` are silently dropped.
 */
export class DebugLogWriter implements IDebugEventSink {
  private readonly fileHandlePromise: Promise<FileHandle | null> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(filePath?: string) {
    if (filePath !== undefined) {
      this.fileHandlePromise = open(filePath, "w").then(
        (fh) => fh,
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `Warning: failed to open debug log file '${filePath}': ${msg}\n`,
          );
          return null;
        },
      );
    }
  }

  emit(event: DebugEvent): void {
    if (this.closed) return;

    const json = JSON.stringify(event);

    if (this.fileHandlePromise) {
      // Queue async write; order is preserved by chaining on the queue.
      const fhPromise = this.fileHandlePromise;
      this.writeQueue = this.writeQueue.then(async () => {
        const fh = await fhPromise;
        if (fh !== null && fh !== undefined) {
          await fh.write(`${json}\n`);
        } else {
          process.stderr.write(`[DEBUG] ${json}\n`);
        }
      });
    } else {
      process.stderr.write(`[DEBUG] ${json}\n`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    // Wait for all queued writes to complete.
    await this.writeQueue;
    if (this.fileHandlePromise) {
      const fh = await this.fileHandlePromise;
      if (fh !== null) {
        await fh.close();
      }
    }
  }
}
