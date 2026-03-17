import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Appends a JSON-serialized line for `entry` to `logPath`.
 * Creates the parent directory recursively if it does not exist.
 * May throw on filesystem errors; callers are responsible for error handling.
 */
export async function appendNdjsonLine(logPath: string, entry: object): Promise<void> {
  const logDir = dirname(logPath);
  await mkdir(logDir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}
