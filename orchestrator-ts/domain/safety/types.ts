// ---------------------------------------------------------------------------
// Safety Rate Limit Configuration
// ---------------------------------------------------------------------------

export interface SafetyRateLimitConfig {
  readonly toolInvocationsPerMinute: number; // default: 60
  readonly repoWritesPerSession: number; // default: 20
  readonly apiRequestsPerMinute: number; // default: 30
}

// ---------------------------------------------------------------------------
// Safety Configuration (immutable value object)
// ---------------------------------------------------------------------------

export interface SafetyConfig {
  readonly workspaceRoot: string;
  readonly protectedFilePatterns: ReadonlyArray<string>;
  readonly protectedBranches: ReadonlyArray<string>;
  readonly branchNamePattern: string;
  readonly maxFilesPerCommit: number;
  readonly shellBlocklist: ReadonlyArray<string>;
  readonly shellAllowlist: ReadonlyArray<string> | null;
  readonly maxIterations: number;
  readonly maxRuntimeMs: number;
  readonly maxFileDeletes: number;
  readonly rateLimits: SafetyRateLimitConfig;
  readonly approvalTimeoutMs: number;
  readonly sandboxMethod: "container" | "restricted-shell" | "temp-directory";
  readonly containerImage?: string;
}

export const DEFAULT_SAFETY_CONFIG = {
  protectedFilePatterns: Object.freeze([".env", ".env.local", ".env.production", "secrets.json", ".git/config"]),
  protectedBranches: Object.freeze(["main", "production"]),
  branchNamePattern: "^agent\\/.+",
  maxFilesPerCommit: 50,
  shellBlocklist: Object.freeze(["rm -rf /", "shutdown", "reboot"]),
  shellAllowlist: null,
  maxIterations: 50,
  maxRuntimeMs: 600_000,
  maxFileDeletes: 10,
  rateLimits: Object.freeze({
    toolInvocationsPerMinute: 60,
    repoWritesPerSession: 20,
    apiRequestsPerMinute: 30,
  }),
  approvalTimeoutMs: 300_000,
  sandboxMethod: "temp-directory" as const,
} as const;

export type SafetyConfigOverrides = Partial<Omit<SafetyConfig, "workspaceRoot">> & {
  workspaceRoot: string;
};

/**
 * Create a validated, frozen SafetyConfig by merging operator overrides over defaults.
 * Throws if any invariant is violated.
 */
export function createSafetyConfig(overrides: SafetyConfigOverrides): SafetyConfig {
  const merged: SafetyConfig = {
    workspaceRoot: overrides.workspaceRoot,
    protectedFilePatterns: Object.freeze([
      ...(overrides.protectedFilePatterns ?? DEFAULT_SAFETY_CONFIG.protectedFilePatterns),
    ]),
    protectedBranches: Object.freeze([...(overrides.protectedBranches ?? DEFAULT_SAFETY_CONFIG.protectedBranches)]),
    branchNamePattern: overrides.branchNamePattern ?? DEFAULT_SAFETY_CONFIG.branchNamePattern,
    maxFilesPerCommit: overrides.maxFilesPerCommit ?? DEFAULT_SAFETY_CONFIG.maxFilesPerCommit,
    shellBlocklist: Object.freeze([...(overrides.shellBlocklist ?? DEFAULT_SAFETY_CONFIG.shellBlocklist)]),
    shellAllowlist: overrides.shellAllowlist !== undefined
      ? (overrides.shellAllowlist !== null ? Object.freeze([...overrides.shellAllowlist]) : null)
      : DEFAULT_SAFETY_CONFIG.shellAllowlist,
    maxIterations: overrides.maxIterations ?? DEFAULT_SAFETY_CONFIG.maxIterations,
    maxRuntimeMs: overrides.maxRuntimeMs ?? DEFAULT_SAFETY_CONFIG.maxRuntimeMs,
    maxFileDeletes: overrides.maxFileDeletes ?? DEFAULT_SAFETY_CONFIG.maxFileDeletes,
    rateLimits: Object.freeze({
      ...(DEFAULT_SAFETY_CONFIG.rateLimits),
      ...(overrides.rateLimits ?? {}),
    }),
    approvalTimeoutMs: overrides.approvalTimeoutMs ?? DEFAULT_SAFETY_CONFIG.approvalTimeoutMs,
    sandboxMethod: overrides.sandboxMethod ?? DEFAULT_SAFETY_CONFIG.sandboxMethod,
    ...(overrides.containerImage !== undefined ? { containerImage: overrides.containerImage } : {}),
  };

  // Validate
  if (!merged.workspaceRoot) {
    throw new Error("workspaceRoot must be a non-empty string");
  }
  if (merged.maxIterations <= 0) {
    throw new Error("maxIterations must be a positive integer");
  }
  if (merged.maxRuntimeMs <= 0) {
    throw new Error("maxRuntimeMs must be positive");
  }
  if (merged.maxFilesPerCommit <= 0) {
    throw new Error("maxFilesPerCommit must be a positive integer");
  }
  if (merged.maxFileDeletes <= 0) {
    throw new Error("maxFileDeletes must be a positive integer");
  }
  if (merged.approvalTimeoutMs <= 0) {
    throw new Error("approvalTimeoutMs must be positive");
  }

  return Object.freeze(merged);
}

// ---------------------------------------------------------------------------
// Emergency Stop Source (discriminated union)
// ---------------------------------------------------------------------------

export type EmergencyStopSource =
  | { readonly kind: "signal"; readonly signal: "SIGINT" | "SIGTERM" }
  | { readonly kind: "safety-violation"; readonly description: string }
  | { readonly kind: "resource-exhaustion"; readonly resource: string };

// ---------------------------------------------------------------------------
// Safety Session (mutable per-session aggregate)
// ---------------------------------------------------------------------------

export interface SafetySession {
  readonly sessionId: string;
  readonly startedAtMs: number;
  iterationCount: number;
  repoWriteCount: number;
  toolInvocationTimestamps: number[];
  apiRequestTimestamps: number[];
  consecutiveFailures: Map<string, number>;
  paused: boolean;
  pauseReason: string | undefined;
  emergencyStopRequested: boolean;
  emergencyStopSource: EmergencyStopSource | undefined;
}

/**
 * Create a fresh SafetySession with a new UUID and current timestamp.
 * The readonly fields (sessionId, startedAtMs) are non-writable.
 */
export function createSafetySession(): SafetySession {
  const sessionId = crypto.randomUUID();
  const startedAtMs = Date.now();

  const session = {
    iterationCount: 0,
    repoWriteCount: 0,
    toolInvocationTimestamps: [] as number[],
    apiRequestTimestamps: [] as number[],
    consecutiveFailures: new Map<string, number>(),
    paused: false,
    pauseReason: undefined as string | undefined,
    emergencyStopRequested: false,
    emergencyStopSource: undefined as EmergencyStopSource | undefined,
  };

  Object.defineProperties(session, {
    sessionId: { value: sessionId, writable: false, enumerable: true, configurable: false },
    startedAtMs: { value: startedAtMs, writable: false, enumerable: true, configurable: false },
  });

  return session as SafetySession;
}
