import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEntry, IAuditLogger } from "../../application/safety/ports";

const MAX_INPUT_SUMMARY_BYTES = 512;

function sanitizeInputSummary(input: string): string {
  const buf = Buffer.from(input, "utf-8");
  if (buf.byteLength <= MAX_INPUT_SUMMARY_BYTES) return input;
  return buf.subarray(0, MAX_INPUT_SUMMARY_BYTES).toString("utf-8").replace(/\uFFFD$/, "");
}

/**
 * Append-only NDJSON audit logger adapter.
 *
 * Writes are serialized via a promise chain (pendingChain) to guarantee that
 * concurrent calls produce one complete JSON line each — no interleaving.
 * All I/O errors are swallowed and surfaced via console.error.
 */
export class AuditLogger implements IAuditLogger {
  private readonly logPath: string;
  private pendingChain: Promise<void> = Promise.resolve();

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  write(entry: AuditEntry): Promise<void> {
    const sanitized: AuditEntry = {
      ...entry,
      inputSummary: sanitizeInputSummary(entry.inputSummary),
    };

    const work = this.pendingChain.then(() => this.appendLine(sanitized));
    // Swallow errors on the chain so future writes are not blocked
    this.pendingChain = work.catch(() => undefined);
    return this.pendingChain;
  }

  flush(): Promise<void> {
    return this.pendingChain;
  }

  private async appendLine(entry: AuditEntry): Promise<void> {
    try {
      await mkdir(dirname(this.logPath), { recursive: true });
      const line = `${JSON.stringify(entry)}\n`;
      const fh = await open(this.logPath, "a");
      try {
        await fh.write(line);
        await fh.datasync();
      } finally {
        await fh.close();
      }
    } catch (err) {
      console.error("[AuditLogger] Failed to write audit entry:", err);
    }
  }
}
