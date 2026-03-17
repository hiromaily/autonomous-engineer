import { atomicWrite, readFileSafe } from "@/infra/utils/fs";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("atomicWrite", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-fs-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes content to the destination path", async () => {
    const destPath = join(tmpDir, "output.json");
    await atomicWrite(destPath, "{\"hello\":\"world\"}");

    const content = await readFile(destPath, "utf-8");
    expect(content).toBe("{\"hello\":\"world\"}");
  });

  it("removes the temp file after successful write", async () => {
    const destPath = join(tmpDir, "output.txt");
    await atomicWrite(destPath, "content");

    const tmpPath = `${destPath}.tmp`;
    await expect(access(tmpPath)).rejects.toThrow();
  });

  it("creates parent directories automatically when they do not exist", async () => {
    const destPath = join(tmpDir, "nested", "deep", "output.json");
    await atomicWrite(destPath, "data");

    const content = await readFile(destPath, "utf-8");
    expect(content).toBe("data");
  });

  it("overwrites existing file with new content", async () => {
    const destPath = join(tmpDir, "file.txt");
    await writeFile(destPath, "old content");
    await atomicWrite(destPath, "new content");

    const content = await readFile(destPath, "utf-8");
    expect(content).toBe("new content");
  });

  it("preserves exact content including newlines and special chars", async () => {
    const destPath = join(tmpDir, "data.txt");
    const content = "{\"key\":\"val\"}\n{\"key2\":\"val2\"}\n";
    await atomicWrite(destPath, content);

    const read = await readFile(destPath, "utf-8");
    expect(read).toBe(content);
  });
});

describe("readFileSafe", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-fs-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist (ENOENT)", async () => {
    const result = await readFileSafe(join(tmpDir, "nonexistent.txt"));
    expect(result).toBeNull();
  });

  it("returns the file content as a string when the file exists", async () => {
    const filePath = join(tmpDir, "existing.txt");
    await writeFile(filePath, "hello content");

    const result = await readFileSafe(filePath);
    expect(result).toBe("hello content");
  });

  it("re-throws non-ENOENT errors", async () => {
    // Reading a directory path triggers EISDIR, which is not ENOENT and must be re-thrown
    await expect(readFileSafe(tmpDir)).rejects.toThrow();
  });
});
