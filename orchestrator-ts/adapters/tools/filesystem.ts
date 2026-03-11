import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import type { Tool, ToolContext } from '../../domain/tools/types';

// ---------------------------------------------------------------------------
// I/O types
// ---------------------------------------------------------------------------

export interface ReadFileInput  { readonly path: string }
export interface ReadFileOutput { readonly content: string }

export interface WriteFileInput  { readonly path: string; readonly content: string }
export interface WriteFileOutput { readonly bytesWritten: number }

export interface ListDirectoryInput  { readonly path: string }
export interface ListDirectoryEntry  {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size: number;
}
export interface ListDirectoryOutput { readonly entries: ReadonlyArray<ListDirectoryEntry> }

export interface SearchFilesInput  { readonly pattern: string; readonly directory: string }
export interface SearchFilesOutput { readonly paths: ReadonlyArray<string> }

// ---------------------------------------------------------------------------
// Shared utility
// ---------------------------------------------------------------------------

/**
 * Resolves `requestedPath` relative to `workspaceRoot` and verifies that the
 * result is contained within the workspace. Throws a permission error if a
 * path-traversal attack is detected.
 */
export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  const resolved = resolve(workspaceRoot, requestedPath);
  // Normalise root with trailing separator to avoid false matches on prefixes
  const rootWithSep = workspaceRoot.endsWith('/') ? workspaceRoot : workspaceRoot + '/';
  if (resolved !== workspaceRoot && !resolved.startsWith(rootWithSep)) {
    throw new PathTraversalError(
      `Path traversal rejected: '${requestedPath}' resolves outside workspace root '${workspaceRoot}'`,
    );
  }
  return resolved;
}

class PathTraversalError extends Error {
  readonly toolErrorType = 'permission' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export const readFileTool: Tool<ReadFileInput, ReadFileOutput> = {
  name: 'read_file',
  description: 'Read the UTF-8 content of a file within the workspace.',
  requiredPermissions: ['filesystemRead'],
  schema: {
    input: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false,
    },
  },
  async execute(input: ReadFileInput, context: ToolContext): Promise<ReadFileOutput> {
    const resolved = resolveWorkspacePath(context.workspaceRoot, input.path);
    const content = await readFile(resolved, 'utf-8');
    return { content };
  },
};

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export const writeFileTool: Tool<WriteFileInput, WriteFileOutput> = {
  name: 'write_file',
  description: 'Write UTF-8 content to a file within the workspace, creating parent directories as needed.',
  requiredPermissions: ['filesystemWrite'],
  schema: {
    input: {
      type: 'object',
      properties: {
        path:    { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { bytesWritten: { type: 'number' } },
      required: ['bytesWritten'],
      additionalProperties: false,
    },
  },
  async execute(input: WriteFileInput, context: ToolContext): Promise<WriteFileOutput> {
    const resolved = resolveWorkspacePath(context.workspaceRoot, input.path);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, input.content, 'utf-8');
    const bytesWritten = Buffer.byteLength(input.content, 'utf-8');
    return { bytesWritten };
  },
};

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

export const listDirectoryTool: Tool<ListDirectoryInput, ListDirectoryOutput> = {
  name: 'list_directory',
  description: 'List the entries (files and directories) in a workspace directory.',
  requiredPermissions: ['filesystemRead'],
  schema: {
    input: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['file', 'directory'] },
              size: { type: 'number' },
            },
            required: ['name', 'type', 'size'],
            additionalProperties: false,
          },
        },
      },
      required: ['entries'],
      additionalProperties: false,
    },
  },
  async execute(input: ListDirectoryInput, context: ToolContext): Promise<ListDirectoryOutput> {
    const resolved = resolveWorkspacePath(context.workspaceRoot, input.path);
    const names = await readdir(resolved);

    const entries: ListDirectoryEntry[] = await Promise.all(
      names.map(async (name) => {
        const entryPath = join(resolved, name);
        const info = await stat(entryPath);
        return {
          name,
          type: info.isDirectory() ? ('directory' as const) : ('file' as const),
          size: info.size,
        };
      }),
    );

    return { entries };
  },
};

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

export const searchFilesTool: Tool<SearchFilesInput, SearchFilesOutput> = {
  name: 'search_files',
  description: 'Search for files matching a glob pattern within a workspace directory.',
  requiredPermissions: ['filesystemRead'],
  schema: {
    input: {
      type: 'object',
      properties: {
        pattern:   { type: 'string' },
        directory: { type: 'string' },
      },
      required: ['pattern', 'directory'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  async execute(input: SearchFilesInput, context: ToolContext): Promise<SearchFilesOutput> {
    const resolvedDir = resolveWorkspacePath(context.workspaceRoot, input.directory);

    const glob = new Bun.Glob(input.pattern);
    const paths: string[] = [];
    for await (const match of glob.scan({ cwd: resolvedDir, absolute: true })) {
      paths.push(match);
    }

    return { paths };
  },
};
