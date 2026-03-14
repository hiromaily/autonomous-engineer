import type { MemoryEntry, Tool, ToolContext } from "@/domain/tools/types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspacePath } from "./filesystem";

// ---------------------------------------------------------------------------
// I/O types
// ---------------------------------------------------------------------------

export interface SearchMemoryInput {
  readonly query: string;
}
export interface SearchMemoryOutput {
  readonly entries: ReadonlyArray<MemoryEntry>;
}

export interface RetrieveSpecInput {
  readonly specName: string;
}
export interface RetrieveSpecOutput {
  readonly requirements: string;
  readonly design: string | null;
  readonly tasks: string | null;
}

export interface RetrieveDesignDocInput {
  readonly docPath: string;
}
export interface RetrieveDesignDocOutput {
  readonly content: string;
}

// ---------------------------------------------------------------------------
// search_memory
// ---------------------------------------------------------------------------

export const searchMemoryTool: Tool<SearchMemoryInput, SearchMemoryOutput> = {
  name: "search_memory",
  description: "Search the agent memory store and return ranked entries matching the query.",
  requiredPermissions: [],
  schema: {
    input: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              score: { type: "number" },
            },
            required: ["id", "content", "score"],
            additionalProperties: false,
          },
        },
      },
      required: ["entries"],
      additionalProperties: false,
    },
  },
  async execute(input: SearchMemoryInput, context: ToolContext): Promise<SearchMemoryOutput> {
    const entries = await context.memory.search(input.query);
    return { entries };
  },
};

// ---------------------------------------------------------------------------
// retrieve_spec
// ---------------------------------------------------------------------------

/** Reads a file and returns its content, or null when the file does not exist (ENOENT). */
async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export const retrieveSpecTool: Tool<RetrieveSpecInput, RetrieveSpecOutput> = {
  name: "retrieve_spec",
  description: "Read the requirements, design, and tasks documents for a named spec from .kiro/specs/<specName>/.",
  requiredPermissions: ["filesystemRead"],
  schema: {
    input: {
      type: "object",
      properties: { specName: { type: "string" } },
      required: ["specName"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        requirements: { type: "string" },
        design: { type: ["string", "null"] },
        tasks: { type: ["string", "null"] },
      },
      required: ["requirements", "design", "tasks"],
      additionalProperties: false,
    },
  },
  async execute(input: RetrieveSpecInput, context: ToolContext): Promise<RetrieveSpecOutput> {
    // Validate that the spec directory is inside the workspace
    const specDir = resolveWorkspacePath(
      context.workspaceRoot,
      join(".kiro", "specs", input.specName),
    );

    const [requirements, design, tasks] = await Promise.all([
      readFile(join(specDir, "requirements.md"), "utf-8"),
      readOptional(join(specDir, "design.md")),
      readOptional(join(specDir, "tasks.md")),
    ]);

    return { requirements, design, tasks };
  },
};

// ---------------------------------------------------------------------------
// retrieve_design_doc
// ---------------------------------------------------------------------------

export const retrieveDesignDocTool: Tool<RetrieveDesignDocInput, RetrieveDesignDocOutput> = {
  name: "retrieve_design_doc",
  description: "Read a named architecture document from the docs/ directory.",
  requiredPermissions: ["filesystemRead"],
  schema: {
    input: {
      type: "object",
      properties: { docPath: { type: "string" } },
      required: ["docPath"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    },
  },
  async execute(
    input: RetrieveDesignDocInput,
    context: ToolContext,
  ): Promise<RetrieveDesignDocOutput> {
    const resolved = resolveWorkspacePath(context.workspaceRoot, input.docPath);
    const content = await readFile(resolved, "utf-8");
    return { content };
  },
};
