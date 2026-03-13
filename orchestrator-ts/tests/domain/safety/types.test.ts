import { describe, expect, it } from "bun:test";
import { createSafetyConfig, createSafetySession, DEFAULT_SAFETY_CONFIG } from "../../../domain/safety/types";

// ---------------------------------------------------------------------------
// SafetyConfig tests
// ---------------------------------------------------------------------------

describe("createSafetyConfig", () => {
  it("returns defaults when no overrides are provided", () => {
    const config = createSafetyConfig({ workspaceRoot: "/workspace" });
    expect(config.workspaceRoot).toBe("/workspace");
    expect(config.protectedFilePatterns).toEqual(DEFAULT_SAFETY_CONFIG.protectedFilePatterns);
    expect(config.protectedBranches).toEqual(DEFAULT_SAFETY_CONFIG.protectedBranches);
    expect(config.branchNamePattern).toBe(DEFAULT_SAFETY_CONFIG.branchNamePattern);
    expect(config.maxFilesPerCommit).toBe(DEFAULT_SAFETY_CONFIG.maxFilesPerCommit);
    expect(config.maxIterations).toBe(DEFAULT_SAFETY_CONFIG.maxIterations);
    expect(config.maxRuntimeMs).toBe(DEFAULT_SAFETY_CONFIG.maxRuntimeMs);
    expect(config.maxFileDeletes).toBe(DEFAULT_SAFETY_CONFIG.maxFileDeletes);
    expect(config.shellAllowlist).toBeNull();
    expect(config.approvalTimeoutMs).toBe(DEFAULT_SAFETY_CONFIG.approvalTimeoutMs);
    expect(config.sandboxMethod).toBe("temp-directory");
  });

  it("merges operator overrides over defaults", () => {
    const config = createSafetyConfig({
      workspaceRoot: "/my-project",
      maxIterations: 100,
      maxFileDeletes: 5,
    });
    expect(config.workspaceRoot).toBe("/my-project");
    expect(config.maxIterations).toBe(100);
    expect(config.maxFileDeletes).toBe(5);
    // unspecified fields remain default
    expect(config.maxFilesPerCommit).toBe(DEFAULT_SAFETY_CONFIG.maxFilesPerCommit);
  });

  it("includes default protected file patterns", () => {
    const config = createSafetyConfig({ workspaceRoot: "/w" });
    expect(config.protectedFilePatterns).toContain(".env");
    expect(config.protectedFilePatterns).toContain("secrets.json");
    expect(config.protectedFilePatterns).toContain(".git/config");
  });

  it("includes default protected branches", () => {
    const config = createSafetyConfig({ workspaceRoot: "/w" });
    expect(config.protectedBranches).toContain("main");
    expect(config.protectedBranches).toContain("production");
  });

  it("exposes array fields as ReadonlyArray (frozen)", () => {
    const config = createSafetyConfig({ workspaceRoot: "/w" });
    expect(() => {
      (config.protectedFilePatterns as string[]).push("hacked");
    }).toThrow();
    expect(() => {
      (config.protectedBranches as string[]).push("hacked");
    }).toThrow();
    expect(() => {
      (config.shellBlocklist as string[]).push("hacked");
    }).toThrow();
  });

  it("throws when workspaceRoot is empty", () => {
    expect(() => createSafetyConfig({ workspaceRoot: "" })).toThrow(/workspaceRoot/);
  });

  it("throws when maxIterations is not positive", () => {
    expect(() => createSafetyConfig({ workspaceRoot: "/w", maxIterations: 0 })).toThrow();
    expect(() => createSafetyConfig({ workspaceRoot: "/w", maxIterations: -1 })).toThrow();
  });

  it("throws when maxRuntimeMs is not positive", () => {
    expect(() => createSafetyConfig({ workspaceRoot: "/w", maxRuntimeMs: 0 })).toThrow();
  });

  it("throws when maxFilesPerCommit is not positive", () => {
    expect(() => createSafetyConfig({ workspaceRoot: "/w", maxFilesPerCommit: 0 })).toThrow();
  });

  it("throws when maxFileDeletes is not positive", () => {
    expect(() => createSafetyConfig({ workspaceRoot: "/w", maxFileDeletes: 0 })).toThrow();
  });

  it("throws when approvalTimeoutMs is not positive", () => {
    expect(() => createSafetyConfig({ workspaceRoot: "/w", approvalTimeoutMs: 0 })).toThrow();
  });

  it("accepts custom shellAllowlist", () => {
    const config = createSafetyConfig({
      workspaceRoot: "/w",
      shellAllowlist: ["npm test", "bun test"],
    });
    expect(config.shellAllowlist).toEqual(["npm test", "bun test"]);
  });

  it("accepts custom rateLimits", () => {
    const config = createSafetyConfig({
      workspaceRoot: "/w",
      rateLimits: { toolInvocationsPerMinute: 120, repoWritesPerSession: 10, apiRequestsPerMinute: 60 },
    });
    expect(config.rateLimits.toolInvocationsPerMinute).toBe(120);
    expect(config.rateLimits.repoWritesPerSession).toBe(10);
    expect(config.rateLimits.apiRequestsPerMinute).toBe(60);
  });

  it("accepts containerImage when sandboxMethod is container", () => {
    const config = createSafetyConfig({
      workspaceRoot: "/w",
      sandboxMethod: "container",
      containerImage: "node:20-alpine",
    });
    expect(config.sandboxMethod).toBe("container");
    expect(config.containerImage).toBe("node:20-alpine");
  });
});

// ---------------------------------------------------------------------------
// SafetySession tests
// ---------------------------------------------------------------------------

describe("createSafetySession", () => {
  it("initializes with a unique session ID and current timestamp", () => {
    const before = Date.now();
    const session = createSafetySession();
    const after = Date.now();
    expect(typeof session.sessionId).toBe("string");
    expect(session.sessionId.length).toBeGreaterThan(0);
    expect(session.startedAtMs).toBeGreaterThanOrEqual(before);
    expect(session.startedAtMs).toBeLessThanOrEqual(after);
  });

  it("initializes all counters and flags at zero/false", () => {
    const session = createSafetySession();
    expect(session.iterationCount).toBe(0);
    expect(session.repoWriteCount).toBe(0);
    expect(session.toolInvocationTimestamps).toEqual([]);
    expect(session.apiRequestTimestamps).toEqual([]);
    expect(session.consecutiveFailures.size).toBe(0);
    expect(session.paused).toBe(false);
    expect(session.pauseReason).toBeUndefined();
    expect(session.emergencyStopRequested).toBe(false);
    expect(session.emergencyStopSource).toBeUndefined();
  });

  it("sessionId is read-only", () => {
    const session = createSafetySession();
    expect(() => {
      (session as { sessionId: string }).sessionId = "tampered";
    }).toThrow();
  });

  it("startedAtMs is read-only", () => {
    const session = createSafetySession();
    expect(() => {
      (session as { startedAtMs: number }).startedAtMs = 0;
    }).toThrow();
  });

  it("mutable fields can be updated", () => {
    const session = createSafetySession();
    session.iterationCount = 5;
    expect(session.iterationCount).toBe(5);
    session.paused = true;
    session.pauseReason = "too many failures";
    expect(session.paused).toBe(true);
    expect(session.pauseReason).toBe("too many failures");
  });

  it("consecutiveFailures map is mutable", () => {
    const session = createSafetySession();
    session.consecutiveFailures.set("read_file:validation:err", 2);
    expect(session.consecutiveFailures.get("read_file:validation:err")).toBe(2);
  });

  it("two sessions have different IDs", () => {
    const a = createSafetySession();
    const b = createSafetySession();
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

// ---------------------------------------------------------------------------
// EmergencyStopSource discriminated union type check (runtime shape)
// ---------------------------------------------------------------------------

describe("EmergencyStopSource shapes", () => {
  it("signal variant has kind and signal fields", () => {
    const source = { kind: "signal" as const, signal: "SIGINT" as const };
    expect(source.kind).toBe("signal");
    expect(source.signal).toBe("SIGINT");
  });

  it("safety-violation variant has kind and description fields", () => {
    const source = { kind: "safety-violation" as const, description: "path traversal attempt" };
    expect(source.kind).toBe("safety-violation");
    expect(source.description).toBe("path traversal attempt");
  });

  it("resource-exhaustion variant has kind and resource fields", () => {
    const source = { kind: "resource-exhaustion" as const, resource: "disk" };
    expect(source.kind).toBe("resource-exhaustion");
    expect(source.resource).toBe("disk");
  });
});
