import { appendNdjsonLine } from "@/infra/utils/ndjson";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("appendNdjsonLine", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-ndjson-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("appends a JSON-serialized line followed by a newline", async () => {
    const logPath = join(tmpDir, "test.ndjson");
    const entry = { type: "test", value: 42 };

    await appendNdjsonLine(logPath, entry);

    const content = await readFile(logPath, "utf-8");
    expect(content).toBe(`${JSON.stringify(entry)}\n`);
  });

  it("creates the parent directory when it does not exist", async () => {
    const logPath = join(tmpDir, "logs", "subdir", "test.ndjson");
    const entry = { type: "log", message: "hello" };

    await appendNdjsonLine(logPath, entry);

    const content = await readFile(logPath, "utf-8");
    expect(content).toBe(`${JSON.stringify(entry)}\n`);
  });

  it("appends multiple lines sequentially", async () => {
    const logPath = join(tmpDir, "multi.ndjson");
    const entry1 = { seq: 1, msg: "first" };
    const entry2 = { seq: 2, msg: "second" };

    await appendNdjsonLine(logPath, entry1);
    await appendNdjsonLine(logPath, entry2);

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(entry1);
    expect(JSON.parse(lines[1]!)).toEqual(entry2);
  });

  it("uses dirname(logPath) internally — does not require a separate logDir param", async () => {
    // This test validates the function signature: only logPath and entry
    const logPath = join(tmpDir, "nested", "app.ndjson");
    const entry = { event: "startup" };

    // Should succeed without any extra directory parameter
    await appendNdjsonLine(logPath, entry);

    const content = await readFile(logPath, "utf-8");
    expect(JSON.parse(content.trim())).toEqual(entry);
  });

  it("rejects on simulated write failure (propagates filesystem errors)", async () => {
    // Attempt to write to a path where the parent cannot be created:
    // use a file as if it were a directory
    const blockingFile = join(tmpDir, "blocker");
    await appendNdjsonLine(blockingFile, { setup: true });

    // Now try to use the file as if it were a directory
    const logPath = join(blockingFile, "child.ndjson");
    await expect(appendNdjsonLine(logPath, { fail: true })).rejects.toThrow();
  });
});
