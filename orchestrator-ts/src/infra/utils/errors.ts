/**
 * Returns true when `err` is an Error instance with a `code` property,
 * narrowing the type to NodeJS.ErrnoException.
 */
export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Extracts a human-readable message from an unknown caught value.
 * Returns `err.message` for Error instances, `String(err)` otherwise.
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
