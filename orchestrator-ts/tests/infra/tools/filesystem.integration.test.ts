/**
 * Integration tests for filesystem tools — exercises the full ToolExecutor
 * pipeline (registry → permission check → schema validation → execute → log).
 *
 * These tests use real filesystem I/O via a temporary directory.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile as fsReadFile, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor } from "@/application/services/tools/executor";
import { PermissionSystem } from "@/domain/tools/permissions";
import { ToolRegistry } from "@/domain/tools/registry";
import type { PermissionSet, ToolContext, ToolInvocationLog } from "@/domain/tools/types";
import { listDirectoryTool, readFileTool, searchFilesTool, writeFileTool } from "@/infra/tools/filesystem";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePermissions(overrides: Partial<PermissionSet> = {}): PermissionSet {
  return Object.freeze({
    filesystemRead: true,
    filesystemWrite: true,
    shellExecution: false,
    gitWrite: false,
    networkAccess: false,
    ...overrides,
  });
}

function makeLogger() {
  const logs: ToolInvocationLog[] = [];
  return {
    info: (e: ToolInvocationLog) => logs.push(e),
    error: (e: ToolInvocationLog) => logs.push(e),
    getLogs: () => logs,
  };
}

function makeContext(workspaceRoot: string, permissions: PermissionSet = makePermissions()): ToolContext {
  return {
    workspaceRoot,
    workingDirectory: workspaceRoot,
    permissions,
    memory: { search: async () => [] },
    logger: makeLogger(),
  };
}

function makeExecutor() {
  const registry = new ToolRegistry();
  const permSystem = new PermissionSystem();

  for (const tool of [readFileTool, writeFileTool, listDirectoryTool, searchFilesTool]) {
    registry.register(tool as Parameters<typeof registry.register>[0]);
  }

  return new ToolExecutor(registry, permSystem, {
    defaultTimeoutMs: 5000,
    logMaxInputBytes: 256,
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let executor: ToolExecutor;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "aes-integ-"));
  executor = makeExecutor();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe("read_file integration", () => {
  it("returns correct content for a known file", async () => {
    await fsWriteFile(join(tmpDir, "hello.txt"), "integration content", "utf-8");

    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("read_file", { path: join(tmpDir, "hello.txt") }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { content: string }).content).toBe("integration content");
    }
  });

  it("returns a runtime error for a missing file", async () => {
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke(
      "read_file",
      { path: join(tmpDir, "nonexistent.txt") },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("runtime");
    }
  });

  it("emits a log entry on success", async () => {
    await fsWriteFile(join(tmpDir, "log.txt"), "x", "utf-8");
    const logger = makeLogger();
    const ctx = { ...makeContext(tmpDir), logger };
    await executor.invoke("read_file", { path: join(tmpDir, "log.txt") }, ctx);

    expect(logger.getLogs().length).toBe(1);
    expect(logger.getLogs()[0]?.resultStatus).toBe("success");
  });

  it("rejects path traversal with a permission error", async () => {
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("read_file", { path: "../etc/passwd" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
  });
});

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

describe("write_file integration", () => {
  it("creates the file and can be read back", async () => {
    const filePath = join(tmpDir, "written.txt");
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke(
      "write_file",
      { path: filePath, content: "round-trip" },
      ctx,
    );

    expect(result.ok).toBe(true);

    const onDisk = await fsReadFile(filePath, "utf-8");
    expect(onDisk).toBe("round-trip");
  });

  it("creates parent directories when they are absent", async () => {
    const filePath = join(tmpDir, "a", "b", "c", "deep.txt");
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke(
      "write_file",
      { path: filePath, content: "deep" },
      ctx,
    );

    expect(result.ok).toBe(true);
    const onDisk = await fsReadFile(filePath, "utf-8");
    expect(onDisk).toBe("deep");
  });

  it("returns permission error when filesystemWrite is absent", async () => {
    const ctx = makeContext(tmpDir, makePermissions({ filesystemWrite: false }));
    const result = await executor.invoke(
      "write_file",
      { path: join(tmpDir, "denied.txt"), content: "x" },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
  });

  it("rejects path traversal with a permission error", async () => {
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("write_file", { path: "../evil.txt", content: "bad" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
  });
});

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

describe("list_directory integration", () => {
  it("returns the correct entry list for a known directory", async () => {
    await fsWriteFile(join(tmpDir, "alpha.ts"), "", "utf-8");
    await mkdir(join(tmpDir, "subdir"));

    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("list_directory", { path: tmpDir }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.value as { entries: Array<{ name: string; type: string }> };
      const names = output.entries.map((e) => e.name);
      expect(names).toContain("alpha.ts");
      expect(names).toContain("subdir");

      const fileEntry = output.entries.find((e) => e.name === "alpha.ts");
      const dirEntry = output.entries.find((e) => e.name === "subdir");
      expect(fileEntry?.type).toBe("file");
      expect(dirEntry?.type).toBe("directory");
    }
  });

  it("rejects path traversal with a permission error", async () => {
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke("list_directory", { path: "../" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
  });
});

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

describe("search_files integration", () => {
  beforeEach(async () => {
    await mkdir(join(tmpDir, "src"));
    await fsWriteFile(join(tmpDir, "src", "a.ts"), "", "utf-8");
    await fsWriteFile(join(tmpDir, "src", "b.ts"), "", "utf-8");
    await fsWriteFile(join(tmpDir, "src", "c.js"), "", "utf-8");
    await fsWriteFile(join(tmpDir, "README.md"), "", "utf-8");
  });

  it("returns only paths that match the pattern", async () => {
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke(
      "search_files",
      { pattern: "**/*.ts", directory: tmpDir },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.value as { paths: string[] };
      expect(output.paths.length).toBe(2);
      expect(output.paths.every((p) => p.endsWith(".ts"))).toBe(true);
    }
  });

  it("returns an empty array when no files match", async () => {
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke(
      "search_files",
      { pattern: "**/*.py", directory: tmpDir },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { paths: string[] }).paths).toHaveLength(0);
    }
  });

  it("rejects path traversal with a permission error", async () => {
    const ctx = makeContext(tmpDir);
    const result = await executor.invoke(
      "search_files",
      { pattern: "**/*.ts", directory: "../" },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
  });
});
