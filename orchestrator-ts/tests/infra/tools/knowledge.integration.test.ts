/**
 * Integration tests for knowledge tools — exercises search_memory,
 * retrieve_spec, and retrieve_design_doc through the full ToolExecutor pipeline.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor } from "@/application/services/tools/executor";
import { PermissionSystem } from "@/domain/tools/permissions";
import { ToolRegistry } from "@/domain/tools/registry";
import type { MemoryClient, MemoryEntry, PermissionSet, ToolContext, ToolInvocationLog } from "@/domain/tools/types";
import { retrieveDesignDocTool, retrieveSpecTool, searchMemoryTool } from "@/infra/tools/knowledge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePermissions(overrides: Partial<PermissionSet> = {}): PermissionSet {
  return Object.freeze({
    filesystemRead: true,
    filesystemWrite: false,
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

function makeMemoryClient(entries: ReadonlyArray<MemoryEntry> = []): MemoryClient {
  return {
    search: async (_query: string) => entries,
  };
}

function makeContext(
  workspaceRoot: string,
  permissions: PermissionSet = makePermissions(),
  memory: MemoryClient = makeMemoryClient(),
): ToolContext {
  return {
    workspaceRoot,
    workingDirectory: workspaceRoot,
    permissions,
    memory,
    logger: makeLogger(),
  };
}

function makeExecutor() {
  const registry = new ToolRegistry();
  const permSystem = new PermissionSystem();

  for (const tool of [searchMemoryTool, retrieveSpecTool, retrieveDesignDocTool]) {
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
  tmpDir = await mkdtemp(join(tmpdir(), "aes-knowledge-"));
  executor = makeExecutor();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// search_memory
// ---------------------------------------------------------------------------

describe("search_memory", () => {
  it("calls MemoryClient.search with the query and returns its result", async () => {
    const mockEntries: ReadonlyArray<MemoryEntry> = [
      { id: "e1", content: "Some relevant content", score: 0.95 },
      { id: "e2", content: "Another result", score: 0.80 },
    ];

    let capturedQuery: string | undefined;
    const memory: MemoryClient = {
      search: async (query: string) => {
        capturedQuery = query;
        return mockEntries;
      },
    };

    const context = makeContext(tmpDir, makePermissions(), memory);
    const result = await executor.invoke("search_memory", { query: "test query" }, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(capturedQuery).toBe("test query");
    expect(result.value).toEqual({ entries: mockEntries });
  });

  it("returns an empty entry list when memory has no matches", async () => {
    const context = makeContext(tmpDir, makePermissions(), makeMemoryClient([]));
    const result = await executor.invoke("search_memory", { query: "nothing" }, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ entries: [] });
  });

  it("does not require any file system permissions", async () => {
    const noPermissions = makePermissions({
      filesystemRead: false,
      filesystemWrite: false,
    });
    const context = makeContext(tmpDir, noPermissions);
    const result = await executor.invoke("search_memory", { query: "anything" }, context);

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// retrieve_spec
// ---------------------------------------------------------------------------

describe("retrieve_spec", () => {
  it("returns requirements, design, and tasks for a fully populated spec", async () => {
    const specDir = join(tmpDir, ".kiro", "specs", "my-feature");
    await mkdir(specDir, { recursive: true });
    await fsWriteFile(join(specDir, "requirements.md"), "# Requirements\nReq content");
    await fsWriteFile(join(specDir, "design.md"), "# Design\nDesign content");
    await fsWriteFile(join(specDir, "tasks.md"), "# Tasks\nTask content");

    const context = makeContext(tmpDir);
    const result = await executor.invoke("retrieve_spec", { specName: "my-feature" }, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as {
      requirements: string;
      design: string | null;
      tasks: string | null;
    };
    expect(value.requirements).toContain("Req content");
    expect(value.design).toContain("Design content");
    expect(value.tasks).toContain("Task content");
  });

  it("returns null for design and tasks when those files are absent", async () => {
    const specDir = join(tmpDir, ".kiro", "specs", "minimal-feature");
    await mkdir(specDir, { recursive: true });
    await fsWriteFile(join(specDir, "requirements.md"), "# Requirements");

    const context = makeContext(tmpDir);
    const result = await executor.invoke("retrieve_spec", { specName: "minimal-feature" }, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as {
      requirements: string;
      design: string | null;
      tasks: string | null;
    };
    expect(value.requirements).toContain("# Requirements");
    expect(value.design).toBeNull();
    expect(value.tasks).toBeNull();
  });

  it("returns runtime error when requirements.md is missing", async () => {
    const specDir = join(tmpDir, ".kiro", "specs", "empty-feature");
    await mkdir(specDir, { recursive: true });

    const context = makeContext(tmpDir);
    const result = await executor.invoke("retrieve_spec", { specName: "empty-feature" }, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("runtime");
  });

  it("rejects path traversal in specName", async () => {
    const context = makeContext(tmpDir);
    const result = await executor.invoke("retrieve_spec", { specName: "../../../etc/passwd" }, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("permission");
  });

  it("requires filesystemRead permission", async () => {
    const noRead = makePermissions({ filesystemRead: false });
    const context = makeContext(tmpDir, noRead);
    const result = await executor.invoke("retrieve_spec", { specName: "any" }, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("permission");
  });
});

// ---------------------------------------------------------------------------
// retrieve_design_doc
// ---------------------------------------------------------------------------

describe("retrieve_design_doc", () => {
  it("returns correct content for a known architecture doc", async () => {
    const docsDir = join(tmpDir, "docs", "architecture");
    await mkdir(docsDir, { recursive: true });
    await fsWriteFile(join(docsDir, "overview.md"), "# Architecture Overview\nContent here");

    const context = makeContext(tmpDir);
    const result = await executor.invoke(
      "retrieve_design_doc",
      { docPath: "docs/architecture/overview.md" },
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as { content: string }).content).toContain("Architecture Overview");
  });

  it("returns runtime error when the document does not exist", async () => {
    const context = makeContext(tmpDir);
    const result = await executor.invoke(
      "retrieve_design_doc",
      { docPath: "docs/nonexistent.md" },
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("runtime");
  });

  it("rejects path traversal in docPath", async () => {
    const context = makeContext(tmpDir);
    const result = await executor.invoke(
      "retrieve_design_doc",
      { docPath: "../../../etc/passwd" },
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("permission");
  });

  it("requires filesystemRead permission", async () => {
    const noRead = makePermissions({ filesystemRead: false });
    const context = makeContext(tmpDir, noRead);
    const result = await executor.invoke(
      "retrieve_design_doc",
      { docPath: "docs/anything.md" },
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("permission");
  });
});
