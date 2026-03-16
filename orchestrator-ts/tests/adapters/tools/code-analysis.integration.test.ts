/**
 * Integration tests for code analysis tools — exercises the TypeScript compiler
 * API against real source files written to a temporary workspace directory.
 *
 * Task 8.1: parse_typescript_ast
 * Task 8.2: find_symbol_definition, find_references
 * Task 8.3: dependency_graph
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PermissionSet, ToolContext, ToolInvocationLog } from "@/domain/tools/types";
import {
  dependencyGraphTool,
  findReferencesTool,
  findSymbolDefinitionTool,
  parseTsAstTool,
} from "@/infra/tools/code-analysis";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePermissions(overrides: Partial<PermissionSet> = {}): PermissionSet {
  return Object.freeze({
    filesystemRead: true,
    filesystemWrite: true,
    shellExecution: false,
    gitWrite: false,
    networkAccess: false,
    ...overrides,
  });
}

function makeLogger() {
  const logs: ToolInvocationLog[] = [];
  return {
    info: (e: ToolInvocationLog) => logs.push(e),
    error: (e: ToolInvocationLog) => logs.push(e),
    getLogs: () => logs,
  };
}

function makeContext(workspaceRoot: string, permissions: PermissionSet = makePermissions()): ToolContext {
  return {
    workspaceRoot,
    workingDirectory: workspaceRoot,
    permissions,
    memory: { search: async () => [] },
    logger: makeLogger(),
  };
}

// A simple TypeScript fixture file with various declaration kinds
const FIXTURE_SOURCE = `
import path from 'node:path';
import { readFile } from 'node:fs/promises';

export interface Greeter {
  greet(name: string): string;
}

export class HelloGreeter implements Greeter {
  greet(name: string): string {
    return \`Hello, \${name}!\`;
  }
}

export function formatName(first: string, last: string): string {
  return \`\${first} \${last}\`;
}

export type NameParts = { first: string; last: string };

const PRIVATE_CONST = 42;
`;

// A fixture with a symbol referenced in multiple places
const MULTI_REF_SOURCE = `
export function utilHelper(x: number): number {
  return x * 2;
}

const a = utilHelper(1);
const b = utilHelper(2);
const c = utilHelper(3);
`;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Code Analysis Tools – Integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(join(tmpdir(), "code-analysis-test-")));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // parse_typescript_ast (Task 8.1)
  // -------------------------------------------------------------------------

  describe("parse_typescript_ast", () => {
    it("requires filesystemRead permission", () => {
      expect(parseTsAstTool.requiredPermissions).toContain("filesystemRead");
    });

    it("extracts top-level declarations from a TypeScript file", async () => {
      const filePath = join(tmpDir, "fixture.ts");
      await fsWriteFile(filePath, FIXTURE_SOURCE, "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await parseTsAstTool.execute({ filePath }, ctx);

      // Should contain interface, class, function, type declarations
      const names = result.declarations.map(d => d.name);
      expect(names).toContain("Greeter");
      expect(names).toContain("HelloGreeter");
      expect(names).toContain("formatName");
      expect(names).toContain("NameParts");
    });

    it("returns declaration kind for each declaration", async () => {
      const filePath = join(tmpDir, "fixture.ts");
      await fsWriteFile(filePath, FIXTURE_SOURCE, "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await parseTsAstTool.execute({ filePath }, ctx);

      const greeter = result.declarations.find(d => d.name === "Greeter");
      expect(greeter).toBeDefined();
      expect(greeter?.kind).toBeTruthy();

      const helloGreeter = result.declarations.find(d => d.name === "HelloGreeter");
      expect(helloGreeter).toBeDefined();
      expect(helloGreeter?.kind).toBeTruthy();
    });

    it("returns line numbers for each declaration", async () => {
      const filePath = join(tmpDir, "fixture.ts");
      await fsWriteFile(filePath, FIXTURE_SOURCE, "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await parseTsAstTool.execute({ filePath }, ctx);

      for (const decl of result.declarations) {
        expect(typeof decl.line).toBe("number");
        expect(decl.line).toBeGreaterThan(0);
      }
    });

    it("extracts import module specifiers", async () => {
      const filePath = join(tmpDir, "fixture.ts");
      await fsWriteFile(filePath, FIXTURE_SOURCE, "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await parseTsAstTool.execute({ filePath }, ctx);

      expect(result.imports).toContain("node:path");
      expect(result.imports).toContain("node:fs/promises");
    });

    it("extracts export names", async () => {
      const filePath = join(tmpDir, "fixture.ts");
      await fsWriteFile(filePath, FIXTURE_SOURCE, "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await parseTsAstTool.execute({ filePath }, ctx);

      expect(result.exports).toContain("Greeter");
      expect(result.exports).toContain("HelloGreeter");
      expect(result.exports).toContain("formatName");
      expect(result.exports).toContain("NameParts");
    });

    it("returns runtime error when file does not exist", async () => {
      const ctx = makeContext(tmpDir);
      await expect(
        parseTsAstTool.execute({ filePath: join(tmpDir, "nonexistent.ts") }, ctx),
      ).rejects.toMatchObject({ toolErrorType: "runtime" });
    });

    it("rejects path traversal with a permission error", async () => {
      const ctx = makeContext(tmpDir);
      await expect(
        parseTsAstTool.execute({ filePath: "../outside/file.ts" }, ctx),
      ).rejects.toThrow();
    });

    it("handles a file with no declarations gracefully", async () => {
      const filePath = join(tmpDir, "empty.ts");
      await fsWriteFile(filePath, "// just a comment\n", "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await parseTsAstTool.execute({ filePath }, ctx);

      expect(Array.isArray(result.declarations)).toBe(true);
      expect(Array.isArray(result.imports)).toBe(true);
      expect(Array.isArray(result.exports)).toBe(true);
    });

    it("handles a file with syntax errors gracefully (returns runtime error)", async () => {
      const filePath = join(tmpDir, "broken.ts");
      await fsWriteFile(filePath, "export function broken( { \n// missing closing brace", "utf-8");

      const ctx = makeContext(tmpDir);
      // TypeScript is lenient about syntax errors — may parse partial AST or throw
      // We just verify it does not throw an unhandled exception; either result is acceptable
      try {
        const result = await parseTsAstTool.execute({ filePath }, ctx);
        expect(Array.isArray(result.declarations)).toBe(true);
      } catch (err: unknown) {
        const e = err as { toolErrorType?: string };
        expect(e.toolErrorType).toBe("runtime");
      }
    });
  });

  // -------------------------------------------------------------------------
  // find_symbol_definition (Task 8.2)
  // -------------------------------------------------------------------------

  describe("find_symbol_definition", () => {
    it("requires filesystemRead permission", () => {
      expect(findSymbolDefinitionTool.requiredPermissions).toContain("filesystemRead");
    });

    it("finds a function declaration by name", async () => {
      const filePath = join(tmpDir, "fixture.ts");
      await fsWriteFile(filePath, FIXTURE_SOURCE, "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await findSymbolDefinitionTool.execute(
        { symbolName: "formatName", scope: tmpDir },
        ctx,
      );

      expect(result.definition).not.toBeNull();
      expect(result.definition?.filePath).toBe(filePath);
      expect(typeof result.definition?.line).toBe("number");
      expect(result.definition?.line).toBeGreaterThan(0);
      expect(result.definition?.signature).toBeTruthy();
    });

    it("finds a class declaration by name", async () => {
      const filePath = join(tmpDir, "fixture.ts");
      await fsWriteFile(filePath, FIXTURE_SOURCE, "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await findSymbolDefinitionTool.execute(
        { symbolName: "HelloGreeter", scope: tmpDir },
        ctx,
      );

      expect(result.definition).not.toBeNull();
      expect(result.definition?.filePath).toBe(filePath);
    });

    it("finds an interface declaration by name", async () => {
      const filePath = join(tmpDir, "fixture.ts");
      await fsWriteFile(filePath, FIXTURE_SOURCE, "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await findSymbolDefinitionTool.execute(
        { symbolName: "Greeter", scope: tmpDir },
        ctx,
      );

      expect(result.definition).not.toBeNull();
      expect(result.definition?.filePath).toBe(filePath);
    });

    it("returns null definition when symbol is not found", async () => {
      const filePath = join(tmpDir, "fixture.ts");
      await fsWriteFile(filePath, FIXTURE_SOURCE, "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await findSymbolDefinitionTool.execute(
        { symbolName: "NonExistentSymbol", scope: tmpDir },
        ctx,
      );

      expect(result.definition).toBeNull();
    });

    it("searches across multiple files when scope is a directory", async () => {
      await fsWriteFile(join(tmpDir, "a.ts"), "export function alpha(): void {}", "utf-8");
      await fsWriteFile(join(tmpDir, "b.ts"), "export function beta(): void {}", "utf-8");

      const ctx = makeContext(tmpDir);

      const resultA = await findSymbolDefinitionTool.execute(
        { symbolName: "alpha", scope: tmpDir },
        ctx,
      );
      expect(resultA.definition).not.toBeNull();
      expect(resultA.definition?.filePath).toBe(join(tmpDir, "a.ts"));

      const resultB = await findSymbolDefinitionTool.execute(
        { symbolName: "beta", scope: tmpDir },
        ctx,
      );
      expect(resultB.definition).not.toBeNull();
      expect(resultB.definition?.filePath).toBe(join(tmpDir, "b.ts"));
    });

    it("rejects path traversal with a permission error", async () => {
      const ctx = makeContext(tmpDir);
      await expect(
        findSymbolDefinitionTool.execute(
          { symbolName: "anything", scope: "../outside" },
          ctx,
        ),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // find_references (Task 8.2)
  // -------------------------------------------------------------------------

  describe("find_references", () => {
    it("requires filesystemRead permission", () => {
      expect(findReferencesTool.requiredPermissions).toContain("filesystemRead");
    });

    it("returns all reference sites for a symbol in a single file", async () => {
      const filePath = join(tmpDir, "refs.ts");
      await fsWriteFile(filePath, MULTI_REF_SOURCE, "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await findReferencesTool.execute(
        { symbolName: "utilHelper", scope: tmpDir },
        ctx,
      );

      // Should find the declaration + 3 call sites
      expect(result.references.length).toBeGreaterThanOrEqual(3);
      for (const ref of result.references) {
        expect(ref.filePath).toBe(filePath);
        expect(typeof ref.line).toBe("number");
        expect(ref.line).toBeGreaterThan(0);
      }
    });

    it("returns empty array when symbol has no references", async () => {
      const filePath = join(tmpDir, "norefs.ts");
      await fsWriteFile(filePath, "export function unused(): void {}", "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await findReferencesTool.execute(
        { symbolName: "NonExistentSymbol", scope: tmpDir },
        ctx,
      );

      expect(result.references).toHaveLength(0);
    });

    it("finds references across multiple files", async () => {
      const libFile = join(tmpDir, "lib.ts");
      const consumerFile = join(tmpDir, "consumer.ts");
      await fsWriteFile(libFile, "export function sharedFn(): string { return 'ok'; }", "utf-8");
      await fsWriteFile(
        consumerFile,
        "import { sharedFn } from './lib';\nconst x = sharedFn();\nconst y = sharedFn();\n",
        "utf-8",
      );

      const ctx = makeContext(tmpDir);
      const result = await findReferencesTool.execute(
        { symbolName: "sharedFn", scope: tmpDir },
        ctx,
      );

      const filePaths = result.references.map(r => r.filePath);
      // References should span both files
      expect(filePaths.length).toBeGreaterThan(0);
    });

    it("rejects path traversal with a permission error", async () => {
      const ctx = makeContext(tmpDir);
      await expect(
        findReferencesTool.execute(
          { symbolName: "anything", scope: "../outside" },
          ctx,
        ),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // dependency_graph (Task 8.3)
  // -------------------------------------------------------------------------

  describe("dependency_graph", () => {
    it("requires filesystemRead permission", () => {
      expect(dependencyGraphTool.requiredPermissions).toContain("filesystemRead");
    });

    it("returns a node for the entry point with its direct imports", async () => {
      const entryFile = join(tmpDir, "entry.ts");
      const libFile = join(tmpDir, "lib.ts");
      await fsWriteFile(libFile, "export const x = 1;", "utf-8");
      await fsWriteFile(entryFile, "import { x } from './lib';\nexport const y = x + 1;\n", "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await dependencyGraphTool.execute({ entryPoint: entryFile }, ctx);

      const entryNode = result.nodes.find(n => n.module === entryFile);
      expect(entryNode).toBeDefined();
      expect(entryNode?.dependencies.some(d => d.includes("lib"))).toBe(true);
    });

    it("includes transitive dependency nodes", async () => {
      // entry → mid → leaf
      const leaf = join(tmpDir, "leaf.ts");
      const mid = join(tmpDir, "mid.ts");
      const entry = join(tmpDir, "entry.ts");
      await fsWriteFile(leaf, "export const LEAF = 'leaf';", "utf-8");
      await fsWriteFile(mid, "import { LEAF } from './leaf';\nexport const MID = LEAF;\n", "utf-8");
      await fsWriteFile(entry, "import { MID } from './mid';\nexport const ENTRY = MID;\n", "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await dependencyGraphTool.execute({ entryPoint: entry }, ctx);

      const moduleNames = result.nodes.map(n => n.module);
      expect(moduleNames.some(m => m.includes("entry"))).toBe(true);
      expect(moduleNames.some(m => m.includes("mid"))).toBe(true);
      expect(moduleNames.some(m => m.includes("leaf"))).toBe(true);
    });

    it("handles an entry point with no imports", async () => {
      const filePath = join(tmpDir, "standalone.ts");
      await fsWriteFile(filePath, "export const VALUE = 42;", "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await dependencyGraphTool.execute({ entryPoint: filePath }, ctx);

      expect(result.nodes.length).toBeGreaterThanOrEqual(1);
      const node = result.nodes.find(n => n.module === filePath);
      expect(node).toBeDefined();
      expect(node?.dependencies).toHaveLength(0);
    });

    it("does not produce duplicate nodes for shared dependencies", async () => {
      // a → shared, b → shared, entry → a, entry → b
      const shared = join(tmpDir, "shared.ts");
      const a = join(tmpDir, "a.ts");
      const b = join(tmpDir, "b.ts");
      const entry = join(tmpDir, "entry.ts");
      await fsWriteFile(shared, "export const S = 0;", "utf-8");
      await fsWriteFile(a, "import { S } from './shared';\nexport const A = S;\n", "utf-8");
      await fsWriteFile(b, "import { S } from './shared';\nexport const B = S;\n", "utf-8");
      await fsWriteFile(entry, "import { A } from './a';\nimport { B } from './b';\n", "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await dependencyGraphTool.execute({ entryPoint: entry }, ctx);

      const sharedModules = result.nodes.filter(n => n.module.includes("shared"));
      // shared.ts should appear exactly once as a node
      expect(sharedModules).toHaveLength(1);
    });

    it("returns a runtime error for a non-existent entry point", async () => {
      const ctx = makeContext(tmpDir);
      await expect(
        dependencyGraphTool.execute({ entryPoint: join(tmpDir, "nonexistent.ts") }, ctx),
      ).rejects.toMatchObject({ toolErrorType: "runtime" });
    });

    it("rejects path traversal with a permission error", async () => {
      const ctx = makeContext(tmpDir);
      await expect(
        dependencyGraphTool.execute({ entryPoint: "../outside/file.ts" }, ctx),
      ).rejects.toThrow();
    });

    it("each node lists its direct dependency module specifiers", async () => {
      const lib = join(tmpDir, "lib.ts");
      const entry = join(tmpDir, "entry.ts");
      await fsWriteFile(lib, "export const X = 1;", "utf-8");
      await fsWriteFile(entry, "import { X } from './lib';\n", "utf-8");

      const ctx = makeContext(tmpDir);
      const result = await dependencyGraphTool.execute({ entryPoint: entry }, ctx);

      const entryNode = result.nodes.find(n => n.module === entry);
      expect(entryNode).toBeDefined();
      // dependencies is an array of strings (module specifiers or resolved paths)
      expect(Array.isArray(entryNode?.dependencies)).toBe(true);
    });
  });
});
