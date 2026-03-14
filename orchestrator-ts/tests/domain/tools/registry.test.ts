import { describe, expect, it } from "bun:test";
import { ToolRegistry } from "../../../src/domain/tools/registry";
import type { MemoryEntry, Tool, ToolContext } from "../../../src/domain/tools/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockTool(name: string, description = "A mock tool"): Tool<unknown, unknown> {
  return {
    name,
    description,
    requiredPermissions: ["filesystemRead"],
    schema: {
      input: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
      output: {
        type: "object",
        properties: { output: { type: "string" } },
        required: ["output"],
      },
    },
    async execute(inp: unknown, _ctx: ToolContext): Promise<unknown> {
      return { output: (inp as { input: string }).input };
    },
  };
}

const mockCtx: ToolContext = {
  workspaceRoot: "/workspace",
  workingDirectory: "/workspace",
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

// ---------------------------------------------------------------------------
// ToolRegistry — register
// ---------------------------------------------------------------------------

describe("ToolRegistry.register", () => {
  it("successfully registers a valid tool and returns ok: true", () => {
    const registry = new ToolRegistry();
    const tool = makeMockTool("read_file");

    const result = registry.register(tool);

    expect(result.ok).toBe(true);
  });

  it("rejects a duplicate tool name with a conflict error", () => {
    const registry = new ToolRegistry();
    const tool = makeMockTool("read_file");

    registry.register(tool);
    const result = registry.register(tool);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("duplicate_name");
      expect(result.error.name).toBe("read_file");
    }
  });

  it("does not silently overwrite an existing tool on duplicate registration", () => {
    const registry = new ToolRegistry();
    const tool1 = makeMockTool("my_tool", "First version");
    const tool2 = makeMockTool("my_tool", "Second version");

    registry.register(tool1);
    registry.register(tool2);

    const result = registry.get("my_tool");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.description).toBe("First version");
    }
  });

  it("allows registering tools with different names", () => {
    const registry = new ToolRegistry();

    const r1 = registry.register(makeMockTool("tool_a"));
    const r2 = registry.register(makeMockTool("tool_b"));
    const r3 = registry.register(makeMockTool("tool_c"));

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry — get
// ---------------------------------------------------------------------------

describe("ToolRegistry.get", () => {
  it("retrieves a registered tool by name", () => {
    const registry = new ToolRegistry();
    const tool = makeMockTool("write_file");

    registry.register(tool);
    const result = registry.get("write_file");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("write_file");
    }
  });

  it("returns a typed not_found error for an unregistered name", () => {
    const registry = new ToolRegistry();

    const result = registry.get("nonexistent_tool");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
      expect(result.error.name).toBe("nonexistent_tool");
    }
  });

  it("never throws — always returns a result", () => {
    const registry = new ToolRegistry();

    expect(() => registry.get("")).not.toThrow();
    expect(() => registry.get("unknown")).not.toThrow();
  });

  it("retrieved tool can be executed", async () => {
    const registry = new ToolRegistry();
    const tool = makeMockTool("echo_tool");

    registry.register(tool);
    const result = registry.get("echo_tool");

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = await result.value.execute({ input: "hello" }, mockCtx);
      expect((output as { output: string }).output).toBe("hello");
    }
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry — list
// ---------------------------------------------------------------------------

describe("ToolRegistry.list", () => {
  it("returns an empty array when no tools are registered", () => {
    const registry = new ToolRegistry();

    expect(registry.list()).toEqual([]);
  });

  it("returns all registered tools with name, description, and schema", () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("tool_a", "Tool A"));
    registry.register(makeMockTool("tool_b", "Tool B"));

    const entries = registry.list();

    expect(entries).toHaveLength(2);

    const names = entries.map((e) => e.name);
    expect(names).toContain("tool_a");
    expect(names).toContain("tool_b");

    for (const entry of entries) {
      expect(typeof entry.description).toBe("string");
      expect(entry.schema).toHaveProperty("input");
      expect(entry.schema).toHaveProperty("output");
    }
  });

  it("reflects correct descriptions for each tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("alpha", "Alpha description"));
    registry.register(makeMockTool("beta", "Beta description"));

    const entries = registry.list();
    const alpha = entries.find((e) => e.name === "alpha");
    const beta = entries.find((e) => e.name === "beta");

    expect(alpha?.description).toBe("Alpha description");
    expect(beta?.description).toBe("Beta description");
  });

  it("does not include duplicate-rejected tools in list", () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("my_tool", "Original"));
    registry.register(makeMockTool("my_tool", "Duplicate")); // rejected

    const entries = registry.list();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.description).toBe("Original");
  });

  it("includes correct schema shapes for all tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeMockTool("file_tool"));

    const entries = registry.list();
    const entry = entries[0];

    expect(entry?.schema.input.type).toBe("object");
    expect(entry?.schema.output.type).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// IToolRegistry port interface compliance
// ---------------------------------------------------------------------------

describe("ToolRegistry port interface compliance", () => {
  it("satisfies the IToolRegistry contract", () => {
    const registry = new ToolRegistry();

    // Structural check: all methods exist and have the right shape
    expect(typeof registry.register).toBe("function");
    expect(typeof registry.get).toBe("function");
    expect(typeof registry.list).toBe("function");
  });
});
