import { describe, it, expect } from 'bun:test';
import {
  PERMISSION_FLAGS,
  EXECUTION_MODES,
  type PermissionFlag,
  type PermissionSet,
  type ExecutionMode,
  type JSONSchema,
  type MemoryEntry,
  type MemoryClient,
  type Logger,
  type ToolInvocationLog,
  type ToolContext,
  type ToolErrorType,
  type ToolError,
  type ToolResult,
  type Tool,
} from '../../../domain/tools/types';

// ---------------------------------------------------------------------------
// PermissionFlag
// ---------------------------------------------------------------------------
describe('PERMISSION_FLAGS', () => {
  it('contains exactly five flags', () => {
    expect(PERMISSION_FLAGS).toHaveLength(5);
  });

  it('contains all required permission flag values', () => {
    const expected: PermissionFlag[] = [
      'filesystemRead',
      'filesystemWrite',
      'shellExecution',
      'gitWrite',
      'networkAccess',
    ];
    for (const flag of expected) {
      expect(PERMISSION_FLAGS).toContain(flag);
    }
  });

  it('is frozen (runtime immutable)', () => {
    expect(Object.isFrozen(PERMISSION_FLAGS)).toBe(true);
    expect(() => (PERMISSION_FLAGS as unknown as string[]).push('extra')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// EXECUTION_MODES
// ---------------------------------------------------------------------------
describe('EXECUTION_MODES', () => {
  it('contains exactly four modes', () => {
    expect(EXECUTION_MODES).toHaveLength(4);
  });

  it('contains all required execution mode values', () => {
    const expected: ExecutionMode[] = ['ReadOnly', 'Dev', 'CI', 'Full'];
    for (const mode of expected) {
      expect(EXECUTION_MODES).toContain(mode);
    }
  });

  it('is frozen (runtime immutable)', () => {
    expect(Object.isFrozen(EXECUTION_MODES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PermissionSet shape
// ---------------------------------------------------------------------------
describe('PermissionSet shape', () => {
  it('accepts a valid PermissionSet with all flags', () => {
    const ps: PermissionSet = {
      filesystemRead: true,
      filesystemWrite: false,
      shellExecution: false,
      gitWrite: false,
      networkAccess: false,
    };

    expect(ps.filesystemRead).toBe(true);
    expect(ps.filesystemWrite).toBe(false);
    expect(ps.shellExecution).toBe(false);
    expect(ps.gitWrite).toBe(false);
    expect(ps.networkAccess).toBe(false);
  });

  it('a frozen PermissionSet cannot be modified at runtime', () => {
    const ps = Object.freeze({
      filesystemRead: true,
      filesystemWrite: false,
      shellExecution: false,
      gitWrite: false,
      networkAccess: false,
    } satisfies PermissionSet);

    expect(Object.isFrozen(ps)).toBe(true);
    expect(() => {
      (ps as Record<string, boolean>)['filesystemRead'] = false;
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// JSONSchema type alias
// ---------------------------------------------------------------------------
describe('JSONSchema type alias', () => {
  it('accepts a typical JSON Schema object', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    };

    expect(schema['type']).toBe('object');
    expect(schema['required']).toEqual(['path']);
  });
});

// ---------------------------------------------------------------------------
// MemoryEntry shape
// ---------------------------------------------------------------------------
describe('MemoryEntry shape', () => {
  it('accepts a valid MemoryEntry', () => {
    const entry: MemoryEntry = {
      id: 'entry-1',
      content: 'Some memory content',
      score: 0.95,
    };

    expect(entry.id).toBe('entry-1');
    expect(entry.content).toBe('Some memory content');
    expect(entry.score).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// MemoryClient contract (mock implementation)
// ---------------------------------------------------------------------------
describe('MemoryClient contract', () => {
  it('can be implemented by a mock and used against the interface', async () => {
    const mockEntries: MemoryEntry[] = [
      { id: 'a', content: 'result one', score: 0.9 },
      { id: 'b', content: 'result two', score: 0.7 },
    ];

    const client: MemoryClient = {
      async search(query: string): Promise<ReadonlyArray<MemoryEntry>> {
        return query ? mockEntries : [];
      },
    };

    const results = await client.search('test query');
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('a');

    const empty = await client.search('');
    expect(empty).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ToolInvocationLog shape
// ---------------------------------------------------------------------------
describe('ToolInvocationLog shape', () => {
  it('accepts a success log entry', () => {
    const log: ToolInvocationLog = {
      toolName: 'read_file',
      inputSummary: '{"path":"/workspace/foo.ts"}',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 42,
      resultStatus: 'success',
      outputSize: 1024,
    };

    expect(log.toolName).toBe('read_file');
    expect(log.resultStatus).toBe('success');
    expect(log.outputSize).toBe(1024);
    expect(log.errorMessage).toBeUndefined();
  });

  it('accepts an error log entry with errorMessage', () => {
    const log: ToolInvocationLog = {
      toolName: 'write_file',
      inputSummary: '{"path":"/workspace/out.ts","content":"..."}',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 5,
      resultStatus: 'permission',
      errorMessage: 'filesystemWrite permission not granted',
    };

    expect(log.resultStatus).toBe('permission');
    expect(log.errorMessage).toBe('filesystemWrite permission not granted');
    expect(log.outputSize).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Logger contract (mock implementation)
// ---------------------------------------------------------------------------
describe('Logger contract', () => {
  it('can be implemented by a mock and used against the interface', () => {
    const infoLogs: ToolInvocationLog[] = [];
    const errorLogs: ToolInvocationLog[] = [];

    const logger: Logger = {
      info(entry: ToolInvocationLog): void {
        infoLogs.push(entry);
      },
      error(entry: ToolInvocationLog): void {
        errorLogs.push(entry);
      },
    };

    const successLog: ToolInvocationLog = {
      toolName: 'read_file',
      inputSummary: '{"path":"/foo"}',
      startedAt: '2026-01-01T00:00:00Z',
      durationMs: 10,
      resultStatus: 'success',
    };

    const errorLog: ToolInvocationLog = {
      toolName: 'write_file',
      inputSummary: '{"path":"/bar"}',
      startedAt: '2026-01-01T00:00:01Z',
      durationMs: 3,
      resultStatus: 'runtime',
      errorMessage: 'ENOENT',
    };

    logger.info(successLog);
    logger.error(errorLog);

    expect(infoLogs).toHaveLength(1);
    expect(infoLogs[0]?.toolName).toBe('read_file');
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.resultStatus).toBe('runtime');
  });
});

// ---------------------------------------------------------------------------
// ToolContext shape
// ---------------------------------------------------------------------------
describe('ToolContext shape', () => {
  it('accepts a valid ToolContext object', () => {
    const ctx: ToolContext = {
      workspaceRoot: '/workspace',
      workingDirectory: '/workspace/src',
      permissions: {
        filesystemRead: true,
        filesystemWrite: false,
        shellExecution: false,
        gitWrite: false,
        networkAccess: false,
      },
      memory: {
        async search(): Promise<ReadonlyArray<MemoryEntry>> {
          return [];
        },
      },
      logger: {
        info(): void {},
        error(): void {},
      },
    };

    expect(ctx.workspaceRoot).toBe('/workspace');
    expect(ctx.workingDirectory).toBe('/workspace/src');
    expect(ctx.permissions.filesystemRead).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ToolError shape
// ---------------------------------------------------------------------------
describe('ToolError shape', () => {
  it('accepts a validation error without details', () => {
    const err: ToolError = {
      type: 'validation',
      message: 'Input field "path" is required',
    };

    expect(err.type).toBe('validation');
    expect(err.message).toBeDefined();
    expect(err.details).toBeUndefined();
  });

  it('accepts a runtime error with details', () => {
    const err: ToolError = {
      type: 'runtime',
      message: 'ENOENT: no such file or directory',
      details: { stderr: '', exitCode: 1 },
    };

    expect(err.type).toBe('runtime');
    expect(err.details?.['exitCode']).toBe(1);
  });

  it('accepts a permission error', () => {
    const err: ToolError = {
      type: 'permission',
      message: 'filesystemWrite not granted in ReadOnly mode',
      details: { requiredFlag: 'filesystemWrite', currentMode: 'ReadOnly' },
    };

    expect(err.type).toBe('permission');
  });
});

// ---------------------------------------------------------------------------
// ToolResult discriminated union
// ---------------------------------------------------------------------------
describe('ToolResult discriminated union', () => {
  it('narrows to value on ok: true', () => {
    const result: ToolResult<string> = { ok: true, value: 'hello' };

    if (result.ok) {
      expect(result.value).toBe('hello');
    } else {
      throw new Error('Expected ok: true');
    }
  });

  it('narrows to error on ok: false', () => {
    const result: ToolResult<string> = {
      ok: false,
      error: { type: 'runtime', message: 'something failed' },
    };

    if (!result.ok) {
      expect(result.error.type).toBe('runtime');
      expect(result.error.message).toBe('something failed');
    } else {
      throw new Error('Expected ok: false');
    }
  });
});

// ---------------------------------------------------------------------------
// Tool interface (mock implementation)
// ---------------------------------------------------------------------------
describe('Tool interface', () => {
  it('can be implemented by a mock tool with all required fields', async () => {
    const readFileTool: Tool<{ readonly path: string }, { readonly content: string }> = {
      name: 'read_file',
      description: 'Read the content of a file at the given path',
      requiredPermissions: ['filesystemRead'],
      schema: {
        input: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        output: {
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
        },
      },
      async execute(
        input: { readonly path: string },
        _context: ToolContext,
      ): Promise<{ readonly content: string }> {
        return { content: `contents of ${input.path}` };
      },
    };

    expect(readFileTool.name).toBe('read_file');
    expect(readFileTool.requiredPermissions).toContain('filesystemRead');
    expect(readFileTool.timeoutMs).toBeUndefined();

    const mockCtx: ToolContext = {
      workspaceRoot: '/workspace',
      workingDirectory: '/workspace',
      permissions: {
        filesystemRead: true,
        filesystemWrite: false,
        shellExecution: false,
        gitWrite: false,
        networkAccess: false,
      },
      memory: { async search(): Promise<ReadonlyArray<MemoryEntry>> { return []; } },
      logger: { info(): void {}, error(): void {} },
    };

    const output = await readFileTool.execute({ path: '/workspace/foo.ts' }, mockCtx);
    expect(output.content).toBe('contents of /workspace/foo.ts');
  });

  it('accepts optional timeoutMs field when provided', () => {
    const tool: Tool<Record<string, never>, { readonly ok: boolean }> = {
      name: 'slow_tool',
      description: 'A tool with a custom timeout',
      requiredPermissions: [],
      timeoutMs: 30000,
      schema: {
        input: { type: 'object' },
        output: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
      async execute(
        _input: Record<string, never>,
        _context: ToolContext,
      ): Promise<{ readonly ok: boolean }> {
        return { ok: true };
      },
    };

    expect(tool.timeoutMs).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// Compile-time exhaustive checks
// ---------------------------------------------------------------------------
const _exhaustiveErrorType = (t: ToolErrorType): string => {
  switch (t) {
    case 'validation': return 'validation';
    case 'runtime':    return 'runtime';
    case 'permission': return 'permission';
  }
};

const _exhaustiveMode = (m: ExecutionMode): string => {
  switch (m) {
    case 'ReadOnly': return 'read-only';
    case 'Dev':      return 'dev';
    case 'CI':       return 'ci';
    case 'Full':     return 'full';
  }
};
