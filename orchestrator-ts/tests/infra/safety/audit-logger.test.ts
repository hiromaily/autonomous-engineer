import type { AuditEntry } from "@/application/ports/safety";
import { AuditLogger } from "@/infra/logger/audit-logger";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: "2026-03-12T00:00:00.000Z",
    sessionId: "sess-001",
    iterationNumber: 1,
    toolName: "read_file",
    inputSummary: "{\"path\":\"/workspace/src/index.ts\"}",
    outcome: "success",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AuditLogger tests
// ---------------------------------------------------------------------------

describe("AuditLogger", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-audit-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("write()", () => {
    it("writes a valid JSON line followed by newline", async () => {
      const logPath = join(tmpDir, "audit.ndjson");
      const logger = new AuditLogger(logPath);

      await logger.write(makeEntry());

      const content = await readFile(logPath, "utf-8");
      expect(content.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(content.trim());
      expect(parsed.toolName).toBe("read_file");
    });

    it("includes all required fields in the written entry", async () => {
      const logPath = join(tmpDir, "audit.ndjson");
      const logger = new AuditLogger(logPath);
      const entry = makeEntry({
        sessionId: "my-session",
        iterationNumber: 5,
        toolName: "write_file",
        outcome: "blocked",
        blockReason: "path outside workspace",
      });

      await logger.write(entry);

      const parsed = JSON.parse((await readFile(logPath, "utf-8")).trim());
      expect(parsed.sessionId).toBe("my-session");
      expect(parsed.iterationNumber).toBe(5);
      expect(parsed.toolName).toBe("write_file");
      expect(parsed.outcome).toBe("blocked");
      expect(parsed.blockReason).toBe("path outside workspace");
      expect(parsed.timestamp).toBe("2026-03-12T00:00:00.000Z");
    });

    it("creates the log directory on first write if it does not exist", async () => {
      const logPath = join(tmpDir, "nested/sub/audit.ndjson");
      const logger = new AuditLogger(logPath);

      await logger.write(makeEntry());

      // access() resolves to void (null in Bun) — just verify no rejection (file exists)
      await access(logPath);
    });

    it("appends entries without overwriting existing content", async () => {
      const logPath = join(tmpDir, "audit.ndjson");
      const logger = new AuditLogger(logPath);

      await logger.write(makeEntry({ toolName: "read_file", iterationNumber: 1 }));
      await logger.write(makeEntry({ toolName: "write_file", iterationNumber: 2 }));
      await logger.write(makeEntry({ toolName: "git_commit", iterationNumber: 3 }));

      const content = await readFile(logPath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l.trim() !== "");
      expect(lines).toHaveLength(3);

      const names = lines.map(l => JSON.parse(l).toolName);
      expect(names).toEqual(["read_file", "write_file", "git_commit"]);
    });

    it("sanitizes inputSummary to at most 512 bytes", async () => {
      const logPath = join(tmpDir, "audit.ndjson");
      const logger = new AuditLogger(logPath);
      const longInput = "x".repeat(1000);

      await logger.write(makeEntry({ inputSummary: longInput }));

      const parsed = JSON.parse((await readFile(logPath, "utf-8")).trim());
      expect(Buffer.byteLength(parsed.inputSummary, "utf-8")).toBeLessThanOrEqual(512);
    });

    it("writes multiple entries from a fresh logger instance to same path (persistence)", async () => {
      const logPath = join(tmpDir, "audit.ndjson");

      // First logger instance writes 2 entries
      const logger1 = new AuditLogger(logPath);
      await logger1.write(makeEntry({ iterationNumber: 1 }));
      await logger1.write(makeEntry({ iterationNumber: 2 }));
      await logger1.flush();

      // Second logger instance appends 1 more entry (simulates process restart)
      const logger2 = new AuditLogger(logPath);
      await logger2.write(makeEntry({ iterationNumber: 3 }));
      await logger2.flush();

      const content = await readFile(logPath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l !== "");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines.at(0) ?? "{}").iterationNumber).toBe(1);
      expect(JSON.parse(lines.at(2) ?? "{}").iterationNumber).toBe(3);
    });

    it("concurrent writes produce valid NDJSON with no interleaved partial lines", async () => {
      const logPath = join(tmpDir, "audit.ndjson");
      const logger = new AuditLogger(logPath);

      // Issue 10 concurrent writes
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => logger.write(makeEntry({ iterationNumber: i }))),
      );
      await logger.flush();

      const content = await readFile(logPath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l !== "");
      expect(lines).toHaveLength(10);

      // Every line must be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it("does not propagate disk errors to callers (swallows and console.errors)", async () => {
      // Write to a path where the parent is a file (guarantees mkdir will fail)
      const blockingFile = join(tmpDir, "block");
      await Bun.write(blockingFile, "i-am-a-file");
      const logPath = join(blockingFile, "audit.ndjson"); // parent is a file
      const logger = new AuditLogger(logPath);

      // Should resolve without throwing
      await logger.write(makeEntry());
    });
  });

  describe("flush()", () => {
    it("resolves after all pending writes complete", async () => {
      const logPath = join(tmpDir, "audit.ndjson");
      const logger = new AuditLogger(logPath);

      // Fire several writes without awaiting
      logger.write(makeEntry({ iterationNumber: 1 }));
      logger.write(makeEntry({ iterationNumber: 2 }));
      logger.write(makeEntry({ iterationNumber: 3 }));

      await logger.flush();

      const content = await readFile(logPath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l !== "");
      expect(lines).toHaveLength(3);
    });
  });
});
