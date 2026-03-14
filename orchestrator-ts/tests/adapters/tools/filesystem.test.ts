import {
  listDirectoryTool,
  readFileTool,
  resolveWorkspacePath,
  searchFilesTool,
  writeFileTool,
} from "@/adapters/tools/filesystem";
import type { PermissionSet, ToolContext } from "@/domain/tools/types";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeContext(workspaceRoot: string): ToolContext {
  const permissions: PermissionSet = Object.freeze({
    filesystemRead: true,
    filesystemWrite: true,
    shellExecution: false,
    gitWrite: false,
    networkAccess: false,
  });
  return {
    workspaceRoot,
    workingDirectory: workspaceRoot,
    permissions,
    memory: { search: async () => [] },
    logger: { info: () => {}, error: () => {} },
  };
}

// ---------------------------------------------------------------------------
// resolveWorkspacePath
// ---------------------------------------------------------------------------

describe("resolveWorkspacePath", () => {
  it("resolves a relative path within the workspace", () => {
    const root = "/workspace";
    const resolved = resolveWorkspacePath(root, "src/main.ts");
    expect(resolved).toBe("/workspace/src/main.ts");
  });

  it("resolves an absolute path within the workspace", () => {
    const root = "/workspace";
    const resolved = resolveWorkspacePath(root, "/workspace/src/main.ts");
    expect(resolved).toBe("/workspace/src/main.ts");
  });

  it("resolves the workspace root itself", () => {
    const root = "/workspace";
    const resolved = resolveWorkspacePath(root, ".");
    expect(resolved).toBe("/workspace");
  });

  it("throws a permission error for path traversal", () => {
    const root = "/workspace";
    expect(() => resolveWorkspacePath(root, "../etc/passwd")).toThrow();
  });

  it("throws a permission error for absolute path outside workspace", () => {
    const root = "/workspace";
    expect(() => resolveWorkspacePath(root, "/etc/passwd")).toThrow();
  });

  it("throws a permission error for deep traversal", () => {
    const root = "/workspace";
    expect(() => resolveWorkspacePath(root, "src/../../etc/passwd")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// read_file tool
// ---------------------------------------------------------------------------

describe("read_file tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("has the correct name", () => {
    expect(readFileTool.name).toBe("read_file");
  });

  it("requires filesystemRead permission", () => {
    expect(readFileTool.requiredPermissions).toContain("filesystemRead");
  });

  it("has valid input and output schemas", () => {
    expect(readFileTool.schema.input).toBeDefined();
    expect(readFileTool.schema.output).toBeDefined();
  });

  it("reads the content of an existing file", async () => {
    const filePath = join(tmpDir, "hello.txt");
    await fsWriteFile(filePath, "Hello, World!", "utf-8");

    const ctx = makeContext(tmpDir);
    const result = await readFileTool.execute({ path: filePath }, ctx);

    expect((result as { content: string }).content).toBe("Hello, World!");
  });

  it("reads file using a path relative to workspaceRoot", async () => {
    await fsWriteFile(join(tmpDir, "relative.txt"), "relative content", "utf-8");

    const ctx = makeContext(tmpDir);
    const result = await readFileTool.execute({ path: "relative.txt" }, ctx);

    expect((result as { content: string }).content).toBe("relative content");
  });

  it("throws a runtime error when the file does not exist", async () => {
    const ctx = makeContext(tmpDir);
    await expect(
      readFileTool.execute({ path: join(tmpDir, "nonexistent.txt") }, ctx),
    ).rejects.toBeDefined();
  });

  it("throws when path traversal is attempted", async () => {
    const ctx = makeContext(tmpDir);
    await expect(
      readFileTool.execute({ path: "../etc/passwd" }, ctx),
    ).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// write_file tool
// ---------------------------------------------------------------------------

describe("write_file tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("has the correct name", () => {
    expect(writeFileTool.name).toBe("write_file");
  });

  it("requires filesystemWrite permission", () => {
    expect(writeFileTool.requiredPermissions).toContain("filesystemWrite");
  });

  it("has valid input and output schemas", () => {
    expect(writeFileTool.schema.input).toBeDefined();
    expect(writeFileTool.schema.output).toBeDefined();
  });

  it("writes content to a file and returns bytesWritten", async () => {
    const filePath = join(tmpDir, "output.txt");
    const ctx = makeContext(tmpDir);
    const result = await writeFileTool.execute({ path: filePath, content: "test content" }, ctx);

    expect((result as { bytesWritten: number }).bytesWritten).toBeGreaterThan(0);
  });

  it("creates the file on disk with the correct content", async () => {
    const filePath = join(tmpDir, "output.txt");
    const ctx = makeContext(tmpDir);
    await writeFileTool.execute({ path: filePath, content: "written by tool" }, ctx);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("written by tool");
  });

  it("creates parent directories when they do not exist", async () => {
    const filePath = join(tmpDir, "deep", "nested", "dir", "file.txt");
    const ctx = makeContext(tmpDir);
    const result = await writeFileTool.execute({ path: filePath, content: "nested" }, ctx);

    expect((result as { bytesWritten: number }).bytesWritten).toBeGreaterThan(0);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("nested");
  });

  it("returns bytesWritten equal to the byte length of the content", async () => {
    const content = "hello"; // 5 bytes
    const filePath = join(tmpDir, "sized.txt");
    const ctx = makeContext(tmpDir);
    const result = await writeFileTool.execute({ path: filePath, content }, ctx);

    expect((result as { bytesWritten: number }).bytesWritten).toBe(
      Buffer.byteLength(content, "utf-8"),
    );
  });

  it("throws when path traversal is attempted", async () => {
    const ctx = makeContext(tmpDir);
    await expect(
      writeFileTool.execute({ path: "../evil.txt", content: "bad" }, ctx),
    ).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// list_directory tool
// ---------------------------------------------------------------------------

describe("list_directory tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("has the correct name", () => {
    expect(listDirectoryTool.name).toBe("list_directory");
  });

  it("requires filesystemRead permission", () => {
    expect(listDirectoryTool.requiredPermissions).toContain("filesystemRead");
  });

  it("has valid input and output schemas", () => {
    expect(listDirectoryTool.schema.input).toBeDefined();
    expect(listDirectoryTool.schema.output).toBeDefined();
  });

  it("lists files in a directory", async () => {
    await fsWriteFile(join(tmpDir, "a.txt"), "aaa", "utf-8");
    await fsWriteFile(join(tmpDir, "b.txt"), "bbbbb", "utf-8");

    const ctx = makeContext(tmpDir);
    const result = await listDirectoryTool.execute({ path: tmpDir }, ctx);
    const output = result as { entries: Array<{ name: string; type: string; size: number }> };

    const names = output.entries.map((e) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("marks files with type \"file\" and directories with type \"directory\"", async () => {
    await fsWriteFile(join(tmpDir, "file.txt"), "content", "utf-8");
    await mkdir(join(tmpDir, "subdir"));

    const ctx = makeContext(tmpDir);
    const result = await listDirectoryTool.execute({ path: tmpDir }, ctx);
    const output = result as { entries: Array<{ name: string; type: string; size: number }> };

    const fileEntry = output.entries.find((e) => e.name === "file.txt");
    const dirEntry = output.entries.find((e) => e.name === "subdir");

    expect(fileEntry?.type).toBe("file");
    expect(dirEntry?.type).toBe("directory");
  });

  it("includes a numeric size for each entry", async () => {
    await fsWriteFile(join(tmpDir, "sized.txt"), "hello", "utf-8");

    const ctx = makeContext(tmpDir);
    const result = await listDirectoryTool.execute({ path: tmpDir }, ctx);
    const output = result as { entries: Array<{ name: string; type: string; size: number }> };

    const entry = output.entries.find((e) => e.name === "sized.txt");
    expect(typeof entry?.size).toBe("number");
    expect(entry?.size).toBeGreaterThanOrEqual(0);
  });

  it("throws when path traversal is attempted", async () => {
    const ctx = makeContext(tmpDir);
    await expect(
      listDirectoryTool.execute({ path: "../" }, ctx),
    ).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// search_files tool
// ---------------------------------------------------------------------------

describe("search_files tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-test-"));
    // Create a test directory structure
    await mkdir(join(tmpDir, "src"));
    await mkdir(join(tmpDir, "src", "utils"));
    await fsWriteFile(join(tmpDir, "src", "index.ts"), "", "utf-8");
    await fsWriteFile(join(tmpDir, "src", "utils", "helper.ts"), "", "utf-8");
    await fsWriteFile(join(tmpDir, "src", "utils", "other.js"), "", "utf-8");
    await fsWriteFile(join(tmpDir, "README.md"), "", "utf-8");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("has the correct name", () => {
    expect(searchFilesTool.name).toBe("search_files");
  });

  it("requires filesystemRead permission", () => {
    expect(searchFilesTool.requiredPermissions).toContain("filesystemRead");
  });

  it("has valid input and output schemas", () => {
    expect(searchFilesTool.schema.input).toBeDefined();
    expect(searchFilesTool.schema.output).toBeDefined();
  });

  it("returns paths matching a glob pattern", async () => {
    const ctx = makeContext(tmpDir);
    const result = await searchFilesTool.execute(
      { pattern: "**/*.ts", directory: tmpDir },
      ctx,
    );
    const output = result as { paths: string[] };

    expect(output.paths.length).toBe(2);
    expect(output.paths.some((p) => p.endsWith("index.ts"))).toBe(true);
    expect(output.paths.some((p) => p.endsWith("helper.ts"))).toBe(true);
  });

  it("returns an empty array when no files match the pattern", async () => {
    const ctx = makeContext(tmpDir);
    const result = await searchFilesTool.execute(
      { pattern: "**/*.py", directory: tmpDir },
      ctx,
    );
    const output = result as { paths: string[] };

    expect(output.paths).toHaveLength(0);
  });

  it("searches within the specified subdirectory", async () => {
    const ctx = makeContext(tmpDir);
    const result = await searchFilesTool.execute(
      { pattern: "**/*.ts", directory: join(tmpDir, "src", "utils") },
      ctx,
    );
    const output = result as { paths: string[] };

    expect(output.paths.length).toBe(1);
    expect(output.paths[0]).toContain("helper.ts");
  });

  it("throws when path traversal is attempted on directory", async () => {
    const ctx = makeContext(tmpDir);
    await expect(
      searchFilesTool.execute({ pattern: "**/*.ts", directory: "../" }, ctx),
    ).rejects.toBeDefined();
  });
});
