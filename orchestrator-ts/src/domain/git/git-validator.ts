import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// GitValidator — pure branch name and file path validation logic
// domain/git/git-validator.ts
//
// All methods are pure functions with no I/O or side effects.
// ---------------------------------------------------------------------------

export interface IGitValidator {
  isValidBranchName(name: string): boolean;
  matchesProtectedPattern(branchName: string, patterns: ReadonlyArray<string>): boolean;
  isWithinWorkspace(filePath: string, workspaceRoot: string): boolean;
  filterProtectedFiles(
    files: ReadonlyArray<string>,
    patterns: ReadonlyArray<string>,
  ): { readonly safe: ReadonlyArray<string>; readonly blocked: ReadonlyArray<string> };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `name` matches the glob `pattern`.
 * Supports:
 *   - Exact match (no glob metacharacters)
 *   - `*`  — matches any sequence of characters that does NOT include `/`
 *   - `**` — matches any sequence of characters including `/`
 *
 * No external libraries are used.
 */
function matchesGlob(name: string, pattern: string): boolean {
  // Convert glob pattern to a regex, segment by segment.
  // We escape regex special chars in non-glob parts and then handle * and **.
  const regexSource = globToRegexSource(pattern);
  const regex = new RegExp(`^${regexSource}$`);
  return regex.test(name);
}

function globToRegexSource(pattern: string): string {
  // Split pattern into tokens: "**", "*", or literal characters.
  // We process character-by-character.
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      // ** — match anything including /
      result += ".*";
      i += 2;
      // skip trailing slash after ** if present
      if (pattern[i] === "/") {
        result += "(?:/|$)";
        i++;
      }
    } else if (pattern[i] === "*") {
      // * — match anything except /
      result += "[^/]*";
      i++;
    } else {
      // Escape regex special chars for the literal character
      result += escapeRegexChar(pattern[i] ?? "");
      i++;
    }
  }
  return result;
}

function escapeRegexChar(ch: string): string {
  // Characters that are special in regex and need escaping
  return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns true if the base filename (last path component) matches the glob pattern,
 * or if the full path matches the pattern.
 * This allows patterns like "*.key" to match "server.key" and "path/server.key".
 */
function fileMatchesPattern(filePath: string, pattern: string): boolean {
  // Check if the pattern contains a path separator
  if (pattern.includes("/")) {
    // Match against the full path
    return matchesGlob(filePath, pattern);
  }

  // For patterns without /, match against the basename
  const basename = filePath.includes("/") ? (filePath.split("/").pop() ?? filePath) : filePath;
  return matchesGlob(basename, pattern) || matchesGlob(filePath, pattern);
}

// ---------------------------------------------------------------------------
// GitValidator implementation
// ---------------------------------------------------------------------------

export class GitValidator implements IGitValidator {
  /**
   * Validates a git branch name against git ref-name rules.
   *
   * Rejects names that:
   * - Are empty
   * - Contain: ~ ^ : ? * [ \ space
   * - Contain the sequence: .. or @{
   * - Contain control characters (\x00-\x1f, \x7f)
   * - Start with . or /
   * - End with . or / or .lock
   */
  isValidBranchName(name: string): boolean {
    if (name.length === 0) {
      return false;
    }

    // Reject control characters (0x00-0x1f and 0x7f)
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(name)) {
      return false;
    }

    // Reject invalid characters
    if (/[~^:?*[\\ ]/.test(name)) {
      return false;
    }

    // Reject sequences
    if (name.includes("..") || name.includes("@{")) {
      return false;
    }

    // Reject names starting with . or /
    if (name.startsWith(".") || name.startsWith("/")) {
      return false;
    }

    // Reject names ending with . or / or .lock
    if (name.endsWith(".") || name.endsWith("/") || name.endsWith(".lock")) {
      return false;
    }

    return true;
  }

  /**
   * Returns true if `branchName` matches any pattern in `patterns`.
   * Supports exact matches and glob-style patterns using * and **.
   *
   * Precondition: none (empty patterns list returns false).
   */
  matchesProtectedPattern(branchName: string, patterns: ReadonlyArray<string>): boolean {
    for (const pattern of patterns) {
      if (matchesGlob(branchName, pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if `filePath` is within `workspaceRoot`.
   * Uses `path.resolve` normalization to prevent path traversal bypasses.
   *
   * Preconditions:
   * - `workspaceRoot` must be an absolute path.
   * - `filePath` should be an absolute path; relative paths are resolved against
   *   the process CWD, which may not equal `workspaceRoot`.
   */
  isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
    const resolvedFile = resolve(filePath);
    const resolvedRoot = resolve(workspaceRoot);

    // Ensure we add a trailing separator to avoid matching sibling directories
    // that share the same prefix (e.g., /workspace/my-project-evil vs /workspace/my-project)
    const rootWithSep = resolvedRoot.endsWith("/") ? resolvedRoot : `${resolvedRoot}/`;

    // The file must either equal the workspace root or start with root + "/"
    return resolvedFile === resolvedRoot || resolvedFile.startsWith(rootWithSep);
  }

  /**
   * Partitions `files` into `safe` (no pattern match) and `blocked` (at least one pattern matches).
   * Pattern matching uses glob semantics via `matchesGlob`.
   */
  filterProtectedFiles(
    files: ReadonlyArray<string>,
    patterns: ReadonlyArray<string>,
  ): { readonly safe: ReadonlyArray<string>; readonly blocked: ReadonlyArray<string> } {
    const safe: string[] = [];
    const blocked: string[] = [];

    for (const file of files) {
      let isBlocked = false;
      for (const pattern of patterns) {
        if (fileMatchesPattern(file, pattern)) {
          isBlocked = true;
          break;
        }
      }
      if (isBlocked) {
        blocked.push(file);
      } else {
        safe.push(file);
      }
    }

    return { safe, blocked };
  }
}
