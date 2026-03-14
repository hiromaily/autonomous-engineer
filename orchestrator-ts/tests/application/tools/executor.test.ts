import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ToolExecutor } from "../../../application/tools/executor";
import { PermissionSystem } from "../../../domain/tools/permissions";
import { ToolRegistry } from "../../../domain/tools/registry";
import type { PermissionSet, Tool, ToolContext, ToolInvocationLog } from "../../../domain/tools/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFullPermissions(): PermissionSet {
  return Object.freeze({
    filesystemRead: true,
    filesystemWrite: true,
    shellExecution: true,
    gitWrite: true,
    networkAccess: true,
  });
}

function makeReadOnlyPermissions(): PermissionSet {
  return Object.freeze({
    filesystemRead: true,
    filesystemWrite: false,
    shellExecution: false,
    gitWrite: false,
    networkAccess: false,
  });
}

function makeLogger() {
  const logs: ToolInvocationLog[] = [];
  return {
    info: mock((entry: ToolInvocationLog) => {
      logs.push(entry);
    }),
    error: mock((entry: ToolInvocationLog) => {
      logs.push(entry);
    }),
    getLogs: () => logs,
  };
}

function makeContext(permissions: PermissionSet, logger: ReturnType<typeof makeLogger>): ToolContext {
  return {
    workspaceRoot: "/workspace",
    workingDirectory: "/workspace",
    permissions,
    memory: { search: async () => [] },
    logger,
  };
}

function makeTool(overrides: Partial<Tool<unknown, unknown>> = {}): Tool<{ value: number }, { doubled: number }> {
  return {
    name: "test_tool",
    description: "A test tool",
    requiredPermissions: ["filesystemRead"],
    schema: {
      input: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { doubled: { type: "number" } },
        required: ["doubled"],
        additionalProperties: false,
      },
    },
    execute: async (input) => ({ doubled: (input as { value: number }).value * 2 }),
    ...overrides,
  } as unknown as Tool<{ value: number }, { doubled: number }>;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let registry: ToolRegistry;
let permSystem: PermissionSystem;
let executor: ToolExecutor;
const config = { defaultTimeoutMs: 5000, logMaxInputBytes: 256 };

beforeEach(() => {
  registry = new ToolRegistry();
  permSystem = new PermissionSystem();
  executor = new ToolExecutor(registry, permSystem, config);
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("ToolExecutor success path", () => {
  it("returns the correct output when all pipeline steps pass", async () => {
    const tool = makeTool();
    registry.register(tool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    const result = await executor.invoke("test_tool", { value: 21 }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { doubled: number }).doubled).toBe(42);
    }
  });

  it("emits a log entry with success status on success", async () => {
    const tool = makeTool();
    registry.register(tool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    await executor.invoke("test_tool", { value: 5 }, ctx);

    expect(logger.info.mock.calls.length).toBe(1);
    const log = logger.getLogs()[0];
    if (!log) throw new Error("expected log entry");
    expect(log.resultStatus).toBe("success");
    expect(log.toolName).toBe("test_tool");
    expect(typeof log.durationMs).toBe("number");
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
    expect(log.outputSize).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tool not found
// ---------------------------------------------------------------------------

describe("ToolExecutor tool not found", () => {
  it("returns a permission error when tool is not registered", async () => {
    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    const result = await executor.invoke("nonexistent_tool", {}, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
    }
  });

  it("emits a log entry even when tool is not found", async () => {
    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    await executor.invoke("nonexistent_tool", {}, ctx);

    const totalLogs = logger.getLogs().length;
    expect(totalLogs).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Permission denied
// ---------------------------------------------------------------------------

describe("ToolExecutor permission denied", () => {
  it("returns a permission error when required flags are missing", async () => {
    const tool = makeTool({ requiredPermissions: ["filesystemWrite"] });
    registry.register(tool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeReadOnlyPermissions(), logger);

    const result = await executor.invoke("test_tool", { value: 1 }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("permission");
      expect(result.error.details?.missingFlags).toBeDefined();
    }
  });

  it("emits a log entry with permission error status on permission denial", async () => {
    const tool = makeTool({ requiredPermissions: ["shellExecution"] });
    registry.register(tool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeReadOnlyPermissions(), logger);

    await executor.invoke("test_tool", { value: 1 }, ctx);

    expect(logger.getLogs().length).toBe(1);
    const log = logger.getLogs()[0];
    if (!log) throw new Error("expected log entry");
    expect(log.resultStatus).toBe("permission");
  });
});

// ---------------------------------------------------------------------------
// Input validation failure
// ---------------------------------------------------------------------------

describe("ToolExecutor input validation", () => {
  it("returns a validation error when input fails schema", async () => {
    const tool = makeTool();
    registry.register(tool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    // Pass a string instead of a number for 'value'
    const result = await executor.invoke("test_tool", { value: "not-a-number" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("validation");
    }
  });

  it("returns a validation error when required input field is missing", async () => {
    const tool = makeTool();
    registry.register(tool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    const result = await executor.invoke("test_tool", {}, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("validation");
    }
  });

  it("emits a log entry with validation error status on input failure", async () => {
    const tool = makeTool();
    registry.register(tool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    await executor.invoke("test_tool", { value: "bad" }, ctx);

    expect(logger.getLogs().length).toBe(1);
    const log = logger.getLogs()[0];
    if (!log) throw new Error("expected log entry");
    expect(log.resultStatus).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// Output validation failure
// ---------------------------------------------------------------------------

describe("ToolExecutor output validation", () => {
  it("returns a validation error when output fails schema", async () => {
    const tool = makeTool({
      execute: async () => ({ wrong_field: "oops" }),
    });
    registry.register(tool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    const result = await executor.invoke("test_tool", { value: 1 }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("validation");
    }
  });

  it("emits a log entry with validation status when output is invalid", async () => {
    const tool = makeTool({ execute: async () => ({ bad: true }) });
    registry.register(tool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    await executor.invoke("test_tool", { value: 1 }, ctx);

    const log = logger.getLogs()[0];
    if (!log) throw new Error("expected log entry");
    expect(log.resultStatus).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("ToolExecutor timeout", () => {
  it("returns a runtime error when execution exceeds timeoutMs", async () => {
    const slowTool = makeTool({
      timeoutMs: 50,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { doubled: 0 };
      },
    });
    registry.register(slowTool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    const result = await executor.invoke("test_tool", { value: 1 }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("runtime");
    }
  }, 1000);

  it("uses defaultTimeoutMs when tool has no timeoutMs", async () => {
    const shortTimeoutExecutor = new ToolExecutor(registry, permSystem, {
      defaultTimeoutMs: 50,
      logMaxInputBytes: 256,
    });

    const slowTool = makeTool({
      // no timeoutMs — should fall back to defaultTimeoutMs: 50
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { doubled: 0 };
      },
    });
    registry.register(slowTool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    const result = await shortTimeoutExecutor.invoke("test_tool", { value: 1 }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("runtime");
    }
  }, 1000);

  it("emits a log entry with runtime status on timeout", async () => {
    const slowTool = makeTool({
      timeoutMs: 50,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { doubled: 0 };
      },
    });
    registry.register(slowTool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    await executor.invoke("test_tool", { value: 1 }, ctx);

    const log = logger.getLogs()[0];
    if (!log) throw new Error("expected log entry");
    expect(log.resultStatus).toBe("runtime");
  }, 1000);
});

// ---------------------------------------------------------------------------
// Unhandled exception
// ---------------------------------------------------------------------------

describe("ToolExecutor unhandled exception", () => {
  it("wraps unhandled exceptions as runtime errors", async () => {
    const throwingTool = makeTool({
      execute: async () => {
        throw new Error("unexpected failure");
      },
    });
    registry.register(throwingTool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    const result = await executor.invoke("test_tool", { value: 1 }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("runtime");
      expect(result.error.details?.originalMessage).toBe("unexpected failure");
    }
  });

  it("emits a log entry with runtime status on unhandled exception", async () => {
    const throwingTool = makeTool({
      execute: async () => {
        throw new Error("boom");
      },
    });
    registry.register(throwingTool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    await executor.invoke("test_tool", { value: 1 }, ctx);

    const log = logger.getLogs()[0];
    if (!log) throw new Error("expected log entry");
    expect(log.resultStatus).toBe("runtime");
  });
});

// ---------------------------------------------------------------------------
// Log sanitization
// ---------------------------------------------------------------------------

describe("ToolExecutor log sanitization", () => {
  it("truncates inputSummary to logMaxInputBytes characters", async () => {
    const smallMaxExecutor = new ToolExecutor(registry, permSystem, {
      defaultTimeoutMs: 5000,
      logMaxInputBytes: 20,
    });

    const tool = makeTool();
    registry.register(tool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    // Input JSON will be longer than 20 chars
    await smallMaxExecutor.invoke("test_tool", { value: 123456789 }, ctx);

    const log = logger.getLogs()[0];
    if (!log) throw new Error("expected log entry");
    expect(log.inputSummary.length).toBeLessThanOrEqual(20);
  });

  it("does not truncate inputSummary when within limit", async () => {
    const tool = makeTool();
    registry.register(tool as unknown as Tool<unknown, unknown>);

    const logger = makeLogger();
    const ctx = makeContext(makeFullPermissions(), logger);

    await executor.invoke("test_tool", { value: 1 }, ctx);

    const log = logger.getLogs()[0];
    if (!log) throw new Error("expected log entry");
    expect(log.inputSummary.length).toBeLessThanOrEqual(256);
  });
});

// ---------------------------------------------------------------------------
// Schema compilation caching
// ---------------------------------------------------------------------------

describe("ToolExecutor schema caching", () => {
  it("compiles the schema only once across multiple invocations", async () => {
    const tool = makeTool();
    registry.register(tool as unknown as Tool<unknown, unknown>);

    const logger1 = makeLogger();
    const logger2 = makeLogger();
    const logger3 = makeLogger();

    const ctx1 = makeContext(makeFullPermissions(), logger1);
    const ctx2 = makeContext(makeFullPermissions(), logger2);
    const ctx3 = makeContext(makeFullPermissions(), logger3);

    await executor.invoke("test_tool", { value: 1 }, ctx1);
    await executor.invoke("test_tool", { value: 2 }, ctx2);
    await executor.invoke("test_tool", { value: 3 }, ctx3);

    // All three invocations should succeed, demonstrating caching works
    expect(logger1.getLogs()[0]?.resultStatus).toBe("success");
    expect(logger2.getLogs()[0]?.resultStatus).toBe("success");
    expect(logger3.getLogs()[0]?.resultStatus).toBe("success");

    // Verify the compilation count via the executor's cache:
    // 2 validators per tool (one for input schema, one for output schema),
    // and both are compiled only once regardless of how many times the tool is invoked.
    expect(executor.compiledValidatorCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// IToolExecutor interface compliance
// ---------------------------------------------------------------------------

describe("IToolExecutor interface", () => {
  it("satisfies the IToolExecutor interface contract", () => {
    expect(typeof executor.invoke).toBe("function");
  });
});
