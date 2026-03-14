import { describe, expect, it } from "bun:test";
import { GitValidator } from "../../../src/domain/git/git-validator";

const validator = new GitValidator();

// ---------------------------------------------------------------------------
// isValidBranchName
// ---------------------------------------------------------------------------

describe("GitValidator.isValidBranchName", () => {
  // Valid names
  it("accepts a simple feature branch name", () => {
    expect(validator.isValidBranchName("feature/my-feature")).toBe(true);
  });

  it("accepts an agent-prefixed branch name", () => {
    expect(validator.isValidBranchName("agent/cache-implementation")).toBe(true);
  });

  it("accepts a name with hyphens and numbers", () => {
    expect(validator.isValidBranchName("agent/cache-implementation-2")).toBe(true);
  });

  it("accepts a simple single-word name", () => {
    expect(validator.isValidBranchName("main")).toBe(true);
  });

  it("accepts release branch names", () => {
    expect(validator.isValidBranchName("release/1.2.3")).toBe(true);
  });

  // Invalid: tilde ~
  it("rejects names containing ~", () => {
    expect(validator.isValidBranchName("feature~1")).toBe(false);
    expect(validator.isValidBranchName("my~branch")).toBe(false);
  });

  // Invalid: caret ^
  it("rejects names containing ^", () => {
    expect(validator.isValidBranchName("feature^1")).toBe(false);
    expect(validator.isValidBranchName("my^branch")).toBe(false);
  });

  // Invalid: colon :
  it("rejects names containing :", () => {
    expect(validator.isValidBranchName("feature:name")).toBe(false);
    expect(validator.isValidBranchName("my:branch")).toBe(false);
  });

  // Invalid: question mark ?
  it("rejects names containing ?", () => {
    expect(validator.isValidBranchName("feature?")).toBe(false);
    expect(validator.isValidBranchName("my?branch")).toBe(false);
  });

  // Invalid: asterisk *
  it("rejects names containing *", () => {
    expect(validator.isValidBranchName("feature*")).toBe(false);
    expect(validator.isValidBranchName("my*branch")).toBe(false);
  });

  // Invalid: open bracket [
  it("rejects names containing [", () => {
    expect(validator.isValidBranchName("feature[1]")).toBe(false);
    expect(validator.isValidBranchName("my[branch")).toBe(false);
  });

  // Invalid: backslash \
  it("rejects names containing \\", () => {
    expect(validator.isValidBranchName("feature\\name")).toBe(false);
    expect(validator.isValidBranchName("my\\branch")).toBe(false);
  });

  // Invalid: double dot ..
  it("rejects names containing ..", () => {
    expect(validator.isValidBranchName("feature..name")).toBe(false);
    expect(validator.isValidBranchName("my..branch")).toBe(false);
    expect(validator.isValidBranchName("..leading")).toBe(false);
    expect(validator.isValidBranchName("trailing..")).toBe(false);
  });

  // Invalid: @{
  it("rejects names containing @{", () => {
    expect(validator.isValidBranchName("feature@{1}")).toBe(false);
    expect(validator.isValidBranchName("my@{branch")).toBe(false);
  });

  // Invalid: control characters
  it("rejects names containing control characters (\\x00-\\x1f, \\x7f)", () => {
    expect(validator.isValidBranchName("feature\x00name")).toBe(false);
    expect(validator.isValidBranchName("my\x01branch")).toBe(false);
    expect(validator.isValidBranchName("branch\x1f")).toBe(false);
    expect(validator.isValidBranchName("branch\x7f")).toBe(false);
  });

  // Invalid: space
  it("rejects names containing space", () => {
    expect(validator.isValidBranchName("feature name")).toBe(false);
    expect(validator.isValidBranchName("my branch")).toBe(false);
  });

  // Invalid: starting with dot
  it("rejects names starting with .", () => {
    expect(validator.isValidBranchName(".hidden")).toBe(false);
    expect(validator.isValidBranchName(".feature")).toBe(false);
  });

  // Invalid: ending with dot
  it("rejects names ending with .", () => {
    expect(validator.isValidBranchName("feature.")).toBe(false);
    expect(validator.isValidBranchName("my-branch.")).toBe(false);
  });

  // Invalid: starting with /
  it("rejects names starting with /", () => {
    expect(validator.isValidBranchName("/feature")).toBe(false);
    expect(validator.isValidBranchName("/branch")).toBe(false);
  });

  // Invalid: ending with /
  it("rejects names ending with /", () => {
    expect(validator.isValidBranchName("feature/")).toBe(false);
    expect(validator.isValidBranchName("my-branch/")).toBe(false);
  });

  // Invalid: ending with .lock
  it("rejects names ending with .lock", () => {
    expect(validator.isValidBranchName("feature.lock")).toBe(false);
    expect(validator.isValidBranchName("my-branch.lock")).toBe(false);
  });

  // Invalid: empty string
  it("rejects empty string", () => {
    expect(validator.isValidBranchName("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchesProtectedPattern
// ---------------------------------------------------------------------------

describe("GitValidator.matchesProtectedPattern", () => {
  it("returns false for empty pattern list", () => {
    expect(validator.matchesProtectedPattern("main", [])).toBe(false);
  });

  it("exact match returns true", () => {
    expect(validator.matchesProtectedPattern("main", ["main"])).toBe(true);
    expect(validator.matchesProtectedPattern("master", ["main", "master", "production"])).toBe(true);
    expect(validator.matchesProtectedPattern("production", ["main", "master", "production"])).toBe(true);
  });

  it("non-matching exact pattern returns false", () => {
    expect(validator.matchesProtectedPattern("feature/my-work", ["main", "master"])).toBe(false);
  });

  it("glob pattern release/* matches release/1.0", () => {
    expect(validator.matchesProtectedPattern("release/1.0", ["release/*"])).toBe(true);
    expect(validator.matchesProtectedPattern("release/2.0.0", ["release/*"])).toBe(true);
  });

  it("glob pattern release/* does not match release/1.0/patch (nested segment)", () => {
    // Single * should not cross directory separators
    expect(validator.matchesProtectedPattern("release/1.0/patch", ["release/*"])).toBe(false);
  });

  it("glob pattern release/** matches release/1.0/patch (nested segment)", () => {
    expect(validator.matchesProtectedPattern("release/1.0/patch", ["release/**"])).toBe(true);
    expect(validator.matchesProtectedPattern("release/1.0", ["release/**"])).toBe(true);
  });

  it("glob pattern does not match unrelated branches", () => {
    expect(validator.matchesProtectedPattern("feature/something", ["release/*"])).toBe(false);
    expect(validator.matchesProtectedPattern("agent/my-feature", ["main", "release/*"])).toBe(false);
  });

  it("checks all patterns in the list", () => {
    const patterns = ["main", "master", "production", "release/*"];
    expect(validator.matchesProtectedPattern("main", patterns)).toBe(true);
    expect(validator.matchesProtectedPattern("release/3.0", patterns)).toBe(true);
    expect(validator.matchesProtectedPattern("agent/my-feature", patterns)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isWithinWorkspace
// ---------------------------------------------------------------------------

describe("GitValidator.isWithinWorkspace", () => {
  const workspace = "/workspace/my-project";

  it("returns true for a file directly in the workspace", () => {
    expect(validator.isWithinWorkspace("/workspace/my-project/file.ts", workspace)).toBe(true);
  });

  it("returns true for a file in a subdirectory of the workspace", () => {
    expect(validator.isWithinWorkspace("/workspace/my-project/src/index.ts", workspace)).toBe(true);
    expect(validator.isWithinWorkspace("/workspace/my-project/deep/nested/file.ts", workspace)).toBe(true);
  });

  it("returns true for the workspace root itself", () => {
    expect(validator.isWithinWorkspace("/workspace/my-project", workspace)).toBe(true);
  });

  it("returns false for a path outside the workspace", () => {
    expect(validator.isWithinWorkspace("/etc/passwd", workspace)).toBe(false);
    expect(validator.isWithinWorkspace("/workspace/other-project/file.ts", workspace)).toBe(false);
  });

  it("rejects path traversal via ../", () => {
    expect(validator.isWithinWorkspace("/workspace/my-project/../../../etc/passwd", workspace)).toBe(false);
    expect(validator.isWithinWorkspace("/workspace/my-project/../../outside", workspace)).toBe(false);
  });

  it("rejects sibling directories that share the workspace prefix", () => {
    // /workspace/my-project-evil starts with /workspace/my-project but is not inside it
    expect(validator.isWithinWorkspace("/workspace/my-project-evil/file.ts", workspace)).toBe(false);
  });

  it("returns false for a path that is a parent of the workspace", () => {
    expect(validator.isWithinWorkspace("/workspace", workspace)).toBe(false);
    expect(validator.isWithinWorkspace("/", workspace)).toBe(false);
  });

  it("handles relative-style path traversal segments resolved against absolute workspace", () => {
    // Path: /workspace/my-project/src/../../../outside
    // Resolves to: /workspace/outside — outside workspace
    expect(
      validator.isWithinWorkspace("/workspace/my-project/src/../../../outside", workspace),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterProtectedFiles
// ---------------------------------------------------------------------------

describe("GitValidator.filterProtectedFiles", () => {
  const patterns = [".env", "secrets.json", "*.key", "*.pem"];

  it("returns all files as safe when none match protected patterns", () => {
    const files = ["src/index.ts", "README.md", "package.json"];
    const result = validator.filterProtectedFiles(files, patterns);
    expect(result.safe).toHaveLength(3);
    expect(result.blocked).toHaveLength(0);
    expect(result.safe).toContain("src/index.ts");
    expect(result.safe).toContain("README.md");
  });

  it("blocks .env file", () => {
    const result = validator.filterProtectedFiles([".env", "src/index.ts"], patterns);
    expect(result.blocked).toContain(".env");
    expect(result.safe).toContain("src/index.ts");
    expect(result.safe).not.toContain(".env");
  });

  it("blocks secrets.json file", () => {
    const result = validator.filterProtectedFiles(["secrets.json", "src/app.ts"], patterns);
    expect(result.blocked).toContain("secrets.json");
    expect(result.safe).toContain("src/app.ts");
  });

  it("blocks *.key files via glob pattern", () => {
    const result = validator.filterProtectedFiles(
      ["my-private.key", "src/index.ts", "public.cert"],
      patterns,
    );
    expect(result.blocked).toContain("my-private.key");
    expect(result.safe).toContain("src/index.ts");
    expect(result.safe).toContain("public.cert");
  });

  it("blocks *.pem files via glob pattern", () => {
    const result = validator.filterProtectedFiles(
      ["certificate.pem", "private.pem", "src/index.ts"],
      patterns,
    );
    expect(result.blocked).toContain("certificate.pem");
    expect(result.blocked).toContain("private.pem");
    expect(result.safe).toContain("src/index.ts");
  });

  it("partitions a mixed file list correctly", () => {
    const files = [
      "src/index.ts",
      ".env",
      "secrets.json",
      "server.key",
      "cert.pem",
      "README.md",
      "package.json",
    ];
    const result = validator.filterProtectedFiles(files, patterns);

    expect(result.safe).toHaveLength(3);
    expect(result.blocked).toHaveLength(4);

    expect(result.safe).toContain("src/index.ts");
    expect(result.safe).toContain("README.md");
    expect(result.safe).toContain("package.json");

    expect(result.blocked).toContain(".env");
    expect(result.blocked).toContain("secrets.json");
    expect(result.blocked).toContain("server.key");
    expect(result.blocked).toContain("cert.pem");
  });

  it("returns empty arrays when input is empty", () => {
    const result = validator.filterProtectedFiles([], patterns);
    expect(result.safe).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
  });

  it("blocks files in subdirectories matching exact pattern", () => {
    // .env in a subdir path should still be caught if the filename matches
    const result = validator.filterProtectedFiles(["config/.env", "src/app.ts"], patterns);
    expect(result.blocked).toContain("config/.env");
    expect(result.safe).toContain("src/app.ts");
  });

  it("does not block files that only partially match a pattern", () => {
    const result = validator.filterProtectedFiles(
      ["not-secrets.json", "my.key.backup", "src/index.ts"],
      patterns,
    );
    // "not-secrets.json" does NOT match "secrets.json" (exact match)
    expect(result.safe).toContain("not-secrets.json");
    // "my.key.backup" does NOT match "*.key" because it ends with .backup
    expect(result.safe).toContain("my.key.backup");
  });
});
