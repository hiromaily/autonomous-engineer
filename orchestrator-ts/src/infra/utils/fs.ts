import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { isNodeError } from "./errors";

/**
 * Writes `content` to `destPath` atomically using a temp file.
 * Creates parent directories if they do not exist.
 * May throw on filesystem errors.
 */
export async function atomicWrite(destPath: string, content: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });

  const tmpPath = `${destPath}.tmp`;
  const fd = await open(tmpPath, "w");
  try {
    await fd.write(content);
    await fd.datasync();
  } finally {
    await fd.close();
  }
  await rename(tmpPath, destPath);
}

/**
 * Reads `filePath` as UTF-8. Returns null if the file does not exist (ENOENT).
 * Re-throws all other errors.
 */
export async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  }
}
