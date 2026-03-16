import { JsonLogWriter } from "@/adapters/cli/json-log-writer";
import type { WorkflowEvent } from "@/application/ports/workflow";
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("JsonLogWriter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "json-log-test-"));
  });

  it("writes event as newline-delimited JSON", async () => {
    const logPath = join(tmpDir, "events.jsonl");
    const writer = new JsonLogWriter(logPath);

    const event: WorkflowEvent = {
      type: "phase:start",
      phase: "SPEC_REQUIREMENTS",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    await writer.write(event);
    await writer.close();

    const content = await readFile(logPath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed).toEqual(event);
  });

  it("writes multiple events, one per line", async () => {
    const logPath = join(tmpDir, "events.jsonl");
    const writer = new JsonLogWriter(logPath);

    const events: WorkflowEvent[] = [
      { type: "phase:start", phase: "SPEC_INIT", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "phase:complete", phase: "SPEC_INIT", durationMs: 100, artifacts: [] },
      { type: "workflow:complete", completedPhases: ["SPEC_INIT"] },
    ];

    for (const event of events) {
      await writer.write(event);
    }
    await writer.close();

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual(events[0]);
    expect(JSON.parse(lines[1] ?? "{}")).toEqual(events[1]);
    expect(JSON.parse(lines[2] ?? "{}")).toEqual(events[2]);
  });

  it("each line is valid JSON terminated by newline", async () => {
    const logPath = join(tmpDir, "events.jsonl");
    const writer = new JsonLogWriter(logPath);

    await writer.write({ type: "workflow:failed", phase: "SPEC_DESIGN", error: "test error" });
    await writer.close();

    const content = await readFile(logPath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(content.trim())).not.toThrow();
  });

  it("creates the file even when no events are written", async () => {
    const logPath = join(tmpDir, "empty.jsonl");
    const writer = new JsonLogWriter(logPath);
    await writer.close();

    const content = await readFile(logPath, "utf-8");
    expect(content).toBe("");
  });
});
