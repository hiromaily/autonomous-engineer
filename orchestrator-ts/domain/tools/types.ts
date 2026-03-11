// ---------------------------------------------------------------------------
// Permission model
// ---------------------------------------------------------------------------

export type PermissionFlag =
  | 'filesystemRead'
  | 'filesystemWrite'
  | 'shellExecution'
  | 'gitWrite'
  | 'networkAccess';

/** Frozen tuple of all valid PermissionFlag values — useful for iteration and validation. */
export const PERMISSION_FLAGS = Object.freeze([
  'filesystemRead',
  'filesystemWrite',
  'shellExecution',
  'gitWrite',
  'networkAccess',
] as const satisfies ReadonlyArray<PermissionFlag>);

export type PermissionSet = Readonly<Record<PermissionFlag, boolean>>;

export type ExecutionMode = 'ReadOnly' | 'Dev' | 'CI' | 'Full';

/** Frozen tuple of all valid ExecutionMode values. */
export const EXECUTION_MODES = Object.freeze([
  'ReadOnly',
  'Dev',
  'CI',
  'Full',
] as const satisfies ReadonlyArray<ExecutionMode>);

// ---------------------------------------------------------------------------
// JSON Schema (minimal, compatible with JSON Schema Draft-07)
// ---------------------------------------------------------------------------

export type JSONSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export type ToolErrorType = 'validation' | 'runtime' | 'permission';

export interface ToolError {
  readonly type: ToolErrorType;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Forward-reference ports (fulfilled by spec5 and infrastructure logger)
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  readonly id: string;
  readonly content: string;
  readonly score: number;
}

export interface MemoryClient {
  search(query: string): Promise<ReadonlyArray<MemoryEntry>>;
}

export interface ToolInvocationLog {
  readonly toolName: string;
  readonly inputSummary: string;    // sanitized, max logMaxInputBytes chars
  readonly startedAt: string;       // ISO 8601
  readonly durationMs: number;
  readonly resultStatus: 'success' | ToolErrorType;
  readonly outputSize?: number;     // byte count or entry count
  readonly errorMessage?: string;
}

export interface Logger {
  info(entry: ToolInvocationLog): void;
  error(entry: ToolInvocationLog): void;
}

// ---------------------------------------------------------------------------
// Tool context
// ---------------------------------------------------------------------------

export interface ToolContext {
  readonly workspaceRoot: string;
  readonly workingDirectory: string;
  readonly permissions: PermissionSet;
  readonly memory: MemoryClient;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// Result type (mirrors LlmResult pattern)
// ---------------------------------------------------------------------------

export type ToolResult<T> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: ToolError };

// ---------------------------------------------------------------------------
// Tool interface
// ---------------------------------------------------------------------------

export interface Tool<Input, Output> {
  readonly name: string;
  readonly description: string;
  readonly requiredPermissions: ReadonlyArray<PermissionFlag>;
  readonly timeoutMs?: number;
  readonly schema: {
    readonly input: JSONSchema;
    readonly output: JSONSchema;
  };
  execute(input: Input, context: ToolContext): Promise<Output>;
}
