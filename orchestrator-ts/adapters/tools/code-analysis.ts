import { readdir } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import * as ts from 'typescript';
import type { Tool, ToolContext } from '../../domain/tools/types';
import { resolveWorkspacePath } from './filesystem';

// ---------------------------------------------------------------------------
// I/O types
// ---------------------------------------------------------------------------

export interface ParseTsAstInput  { readonly filePath: string }
export interface TsDeclaration    { readonly kind: string; readonly name: string; readonly line: number }
export interface ParseTsAstOutput {
  readonly declarations: ReadonlyArray<TsDeclaration>;
  readonly imports:      ReadonlyArray<string>;
  readonly exports:      ReadonlyArray<string>;
}

export interface FindSymbolInput  { readonly symbolName: string; readonly scope?: string }
export interface SymbolDefinition { readonly filePath: string; readonly line: number; readonly signature: string }
export interface FindSymbolOutput { readonly definition: SymbolDefinition | null }

export interface FindReferencesInput  { readonly symbolName: string; readonly scope?: string }
export interface SymbolReference      { readonly filePath: string; readonly line: number }
export interface FindReferencesOutput { readonly references: ReadonlyArray<SymbolReference> }

export interface DependencyGraphInput  { readonly entryPoint: string }
export interface DependencyNode        { readonly module: string; readonly dependencies: ReadonlyArray<string> }
export interface DependencyGraphOutput { readonly nodes: ReadonlyArray<DependencyNode> }

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Thrown when a requested file does not exist or cannot be parsed.
 * Signals ToolError { type: 'runtime' }.
 */
class ToolRuntimeError extends Error {
  readonly toolErrorType = 'runtime' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ToolRuntimeError';
  }
}

/**
 * Map a TypeScript SyntaxKind to a human-readable string.
 */
function kindToString(kind: ts.SyntaxKind): string {
  switch (kind) {
    case ts.SyntaxKind.FunctionDeclaration:      return 'function';
    case ts.SyntaxKind.ClassDeclaration:         return 'class';
    case ts.SyntaxKind.InterfaceDeclaration:     return 'interface';
    case ts.SyntaxKind.TypeAliasDeclaration:     return 'type';
    case ts.SyntaxKind.EnumDeclaration:          return 'enum';
    case ts.SyntaxKind.VariableStatement:        return 'variable';
    case ts.SyntaxKind.ModuleDeclaration:        return 'namespace';
    default:                                      return ts.SyntaxKind[kind] ?? 'unknown';
  }
}

/**
 * Get the 1-based line number for a node in a SourceFile.
 */
function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return line + 1;
}

/**
 * Collect all .ts / .tsx files under a directory (recursive).
 */
async function collectTsFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    const subdirWalks: Promise<void>[] = [];
    for (const entry of entries) {
      // Skip node_modules and hidden directories
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        subdirWalks.push(walk(full));
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        results.push(full);
      }
    }
    await Promise.all(subdirWalks);
  }
  await walk(dir);
  return results;
}

/**
 * Create a TypeScript Program for the given root files.
 * Uses a minimal compiler host with default lib to avoid requiring tsconfig.
 */
function createProgram(rootNames: string[]): ts.Program {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: false,        // lenient to allow analysis of arbitrary source
    skipLibCheck: true,
    noEmit: true,
  };
  return ts.createProgram(rootNames, compilerOptions);
}

/**
 * Get a node's text representation as a concise signature string.
 */
function nodeSignature(node: ts.Node, sourceFile: ts.SourceFile): string {
  // Return at most the first line of the node text as the signature
  const text = node.getText(sourceFile);
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.slice(0, 200);
}

// ---------------------------------------------------------------------------
// parse_typescript_ast  (Task 8.1)
// ---------------------------------------------------------------------------

export const parseTsAstTool: Tool<ParseTsAstInput, ParseTsAstOutput> = {
  name: 'parse_typescript_ast',
  description:
    'Parse a TypeScript source file and extract top-level declarations, import module specifiers, and export names using the TypeScript compiler API.',
  requiredPermissions: ['filesystemRead'],
  schema: {
    input: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        declarations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              name: { type: 'string' },
              line: { type: 'number' },
            },
            required: ['kind', 'name', 'line'],
            additionalProperties: false,
          },
        },
        imports: { type: 'array', items: { type: 'string' } },
        exports: { type: 'array', items: { type: 'string' } },
      },
      required: ['declarations', 'imports', 'exports'],
      additionalProperties: false,
    },
  },
  async execute(input: ParseTsAstInput, context: ToolContext): Promise<ParseTsAstOutput> {
    const resolved = resolveWorkspacePath(context.workspaceRoot, input.filePath);
    const absPath = resolvePath(resolved);

    const program = createProgram([absPath]);
    const sourceFile = program.getSourceFile(absPath);

    if (!sourceFile) {
      throw new ToolRuntimeError(
        `Cannot parse TypeScript file: '${input.filePath}'. File not found or cannot be loaded.`,
      );
    }

    const declarations: TsDeclaration[] = [];
    const imports: string[] = [];
    const exports: string[] = [];

    ts.forEachChild(sourceFile, (node) => {
      // ---- Imports ----
      if (ts.isImportDeclaration(node)) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          imports.push(node.moduleSpecifier.text);
        }
        return;
      }

      // ---- Top-level named declarations ----
      let name: string | undefined;
      const kind: ts.SyntaxKind = node.kind;
      let isExported = false;

      if (ts.isFunctionDeclaration(node) && node.name) {
        name = node.name.text;
        isExported = hasExportModifier(node);
      } else if (ts.isClassDeclaration(node) && node.name) {
        name = node.name.text;
        isExported = hasExportModifier(node);
      } else if (ts.isInterfaceDeclaration(node)) {
        name = node.name.text;
        isExported = hasExportModifier(node);
      } else if (ts.isTypeAliasDeclaration(node)) {
        name = node.name.text;
        isExported = hasExportModifier(node);
      } else if (ts.isEnumDeclaration(node)) {
        name = node.name.text;
        isExported = hasExportModifier(node);
      } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
        name = node.name.text;
        isExported = hasExportModifier(node);
      } else if (ts.isVariableStatement(node)) {
        // VariableStatement holds multiple declarators — report the first name
        const decl = node.declarationList.declarations[0];
        if (decl && ts.isIdentifier(decl.name)) {
          name = decl.name.text;
          isExported = hasExportModifier(node);
        }
      }

      if (name) {
        declarations.push({ kind: kindToString(kind), name, line: lineOf(node, sourceFile) });
        if (isExported) exports.push(name);
      }
    });

    return { declarations, imports, exports };
  },
};

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = (node as ts.HasModifiers).modifiers;
  if (!modifiers) return false;
  return modifiers.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
}

// ---------------------------------------------------------------------------
// find_symbol_definition  (Task 8.2)
// ---------------------------------------------------------------------------

export const findSymbolDefinitionTool: Tool<FindSymbolInput, FindSymbolOutput> = {
  name: 'find_symbol_definition',
  description:
    'Search workspace TypeScript files for a function, class, interface, or type declaration by name. Returns file path, line number, and signature, or null when not found.',
  requiredPermissions: ['filesystemRead'],
  schema: {
    input: {
      type: 'object',
      properties: {
        symbolName: { type: 'string' },
        scope:      { type: 'string' },
      },
      required: ['symbolName'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        definition: {
          oneOf: [
            {
              type: 'object',
              properties: {
                filePath:  { type: 'string' },
                line:      { type: 'number' },
                signature: { type: 'string' },
              },
              required: ['filePath', 'line', 'signature'],
              additionalProperties: false,
            },
            { type: 'null' },
          ],
        },
      },
      required: ['definition'],
      additionalProperties: false,
    },
  },
  async execute(input: FindSymbolInput, context: ToolContext): Promise<FindSymbolOutput> {
    const scopeDir = input.scope !== undefined
      ? resolveWorkspacePath(context.workspaceRoot, input.scope)
      : context.workspaceRoot;

    const tsFiles = await collectTsFiles(scopeDir);
    if (tsFiles.length === 0) return { definition: null };

    const program = createProgram(tsFiles);

    for (const filePath of tsFiles) {
      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile) continue;

      const found = findDeclarationInFile(sourceFile, input.symbolName);
      if (found) {
        return {
          definition: {
            filePath,
            line:      found.line,
            signature: found.signature,
          },
        };
      }
    }

    return { definition: null };
  },
};

interface DeclFound { line: number; signature: string }

function findDeclarationInFile(
  sourceFile: ts.SourceFile,
  symbolName: string,
): DeclFound | null {
  let result: DeclFound | null = null;

  function visit(node: ts.Node): void {
    if (result) return; // already found

    if (
      (ts.isFunctionDeclaration(node) ||
       ts.isClassDeclaration(node) ||
       ts.isInterfaceDeclaration(node) ||
       ts.isTypeAliasDeclaration(node) ||
       ts.isEnumDeclaration(node)) &&
      node.name?.text === symbolName
    ) {
      result = {
        line:      lineOf(node, sourceFile),
        signature: nodeSignature(node, sourceFile),
      };
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === symbolName) {
          result = {
            line:      lineOf(node, sourceFile),
            signature: nodeSignature(node, sourceFile),
          };
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return result;
}

// ---------------------------------------------------------------------------
// find_references  (Task 8.2)
// ---------------------------------------------------------------------------

export const findReferencesTool: Tool<FindReferencesInput, FindReferencesOutput> = {
  name: 'find_references',
  description:
    'Return all usage sites of a named symbol across workspace TypeScript files, with file path and line number per reference.',
  requiredPermissions: ['filesystemRead'],
  schema: {
    input: {
      type: 'object',
      properties: {
        symbolName: { type: 'string' },
        scope:      { type: 'string' },
      },
      required: ['symbolName'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        references: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              line:     { type: 'number' },
            },
            required: ['filePath', 'line'],
            additionalProperties: false,
          },
        },
      },
      required: ['references'],
      additionalProperties: false,
    },
  },
  async execute(input: FindReferencesInput, context: ToolContext): Promise<FindReferencesOutput> {
    const scopeDir = input.scope !== undefined
      ? resolveWorkspacePath(context.workspaceRoot, input.scope)
      : context.workspaceRoot;

    const tsFiles = await collectTsFiles(scopeDir);
    if (tsFiles.length === 0) return { references: [] };

    const program = createProgram(tsFiles);
    const references: SymbolReference[] = [];

    for (const filePath of tsFiles) {
      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile) continue;

      const sf = sourceFile; // capture for closure — avoids non-null assertion
      function visit(node: ts.Node): void {
        if (ts.isIdentifier(node) && node.text === input.symbolName) {
          references.push({ filePath, line: lineOf(node, sf) });
        }
        ts.forEachChild(node, visit);
      }

      ts.forEachChild(sf, visit);
    }

    return { references };
  },
};

// ---------------------------------------------------------------------------
// dependency_graph  (Task 8.3)
// ---------------------------------------------------------------------------

/**
 * Collect the import specifiers declared at the top level of a source file.
 */
function collectImportSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}

export const dependencyGraphTool: Tool<DependencyGraphInput, DependencyGraphOutput> = {
  name: 'dependency_graph',
  description:
    'Traverse imports from a TypeScript entry point and build a dependency graph. Returns a list of nodes each with its module path and direct dependency module specifiers, including transitive dependencies.',
  requiredPermissions: ['filesystemRead'],
  schema: {
    input: {
      type: 'object',
      properties: { entryPoint: { type: 'string' } },
      required: ['entryPoint'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              module:       { type: 'string' },
              dependencies: { type: 'array', items: { type: 'string' } },
            },
            required: ['module', 'dependencies'],
            additionalProperties: false,
          },
        },
      },
      required: ['nodes'],
      additionalProperties: false,
    },
  },
  async execute(input: DependencyGraphInput, context: ToolContext): Promise<DependencyGraphOutput> {
    const resolved = resolveWorkspacePath(context.workspaceRoot, input.entryPoint);
    const absEntry = resolvePath(resolved);

    // Single program creation — TypeScript resolves imports transitively via the default host.
    // If the entry file does not exist, getSourceFile() returns undefined (no TOCTOU stat needed).
    const program = createProgram([absEntry]);
    const compilerOptions = program.getCompilerOptions();

    if (!program.getSourceFile(absEntry)) {
      throw new ToolRuntimeError(
        `Cannot build dependency graph: entry point '${input.entryPoint}' does not exist.`,
      );
    }

    const nodes: DependencyNode[] = [];
    const visited = new Set<string>();

    function traverse(filePath: string): void {
      if (visited.has(filePath)) return;
      visited.add(filePath);

      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile) return;

      const specifiers = collectImportSpecifiers(sourceFile);
      const resolvedDeps: string[] = [];

      for (const spec of specifiers) {
        // Use TypeScript's own module resolver — no manual stat() needed.
        const result = ts.resolveModuleName(spec, filePath, compilerOptions, ts.sys);
        const rm = result.resolvedModule;
        if (rm && !rm.isExternalLibraryImport) {
          resolvedDeps.push(rm.resolvedFileName);
          traverse(rm.resolvedFileName);
        } else {
          // External / built-in specifier kept as-is (e.g. 'node:path', 'zod')
          resolvedDeps.push(spec);
        }
      }

      nodes.push({ module: filePath, dependencies: resolvedDeps });
    }

    traverse(absEntry);

    return { nodes };
  },
};
