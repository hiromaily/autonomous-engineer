import { CcSddAdapter, type SpawnFn } from "@/adapters/sdd/cc-sdd-adapter";
import type { SpecContext } from "@/application/ports/sdd";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ctx: SpecContext = { specName: "my-spec", specDir: ".kiro/specs", language: "en" };

function makeStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function makeSpawn(exitCode: number, stderr = ""): { fn: SpawnFn; argv: string[][] } {
  const calls: string[][] = [];
  const fn: SpawnFn = (argv) => {
    calls.push([...argv]);
    return {
      exited: Promise.resolve(exitCode),
      stderr: makeStream(stderr),
    };
  };
  return { fn, argv: calls };
}

// ---------------------------------------------------------------------------
// Argument structure (command injection prevention)
// ---------------------------------------------------------------------------

describe("CcSddAdapter — argument structure", () => {
  it("passes arguments as separate array entries (not interpolated into a single string)", async () => {
    const { fn, argv } = makeSpawn(0);
    const adapter = new CcSddAdapter(fn);

    await adapter.generateRequirements(ctx);

    const args = argv[0];
    // Must be an array with at least: binary, subcommand, specName, specDir, language
    expect(Array.isArray(args)).toBe(true);
    expect(args?.length).toBeGreaterThanOrEqual(5);

    // specName must NOT appear merged with other tokens
    const specNameArg = args?.find(a => a === "my-spec");
    expect(specNameArg).toBe("my-spec");

    // No single arg should contain spaces (which would indicate shell interpolation)
    for (const arg of args ?? []) {
      expect(arg.includes(" ")).toBe(false);
    }
  });

  it("always uses cc-sdd as the binary", async () => {
    const { fn, argv } = makeSpawn(0);
    const adapter = new CcSddAdapter(fn);
    await adapter.generateRequirements(ctx);
    expect(argv[0]?.[0]).toBe("cc-sdd");
  });

  it("includes specName, specDir, and language as separate args", async () => {
    const { fn, argv } = makeSpawn(0);
    const adapter = new CcSddAdapter(fn);
    await adapter.generateRequirements({ specName: "test-spec", specDir: "/custom/path", language: "ja" });

    const args = argv[0] ?? [];
    expect(args).toContain("test-spec");
    expect(args).toContain("/custom/path");
    expect(args).toContain("ja");
  });
});

// ---------------------------------------------------------------------------
// Operation subcommands
// ---------------------------------------------------------------------------

describe("CcSddAdapter — operation subcommands", () => {
  it.each([
    ["generateRequirements", "requirements"] as const,
    ["generateDesign", "design"] as const,
    ["validateDesign", "validate-design"] as const,
    ["generateTasks", "tasks"] as const,
  ])("%s uses subcommand %s", async (method, subcommand) => {
    const { fn, argv } = makeSpawn(0);
    const adapter = new CcSddAdapter(fn);
    await adapter[method](ctx);
    expect(argv[0]).toContain(subcommand);
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("CcSddAdapter — success (exit code 0)", () => {
  it("generateRequirements returns ok: true with requirements.md artifact", async () => {
    const { fn } = makeSpawn(0);
    const adapter = new CcSddAdapter(fn);

    const result = await adapter.generateRequirements(ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifactPath).toContain("requirements.md");
      expect(result.artifactPath).toContain("my-spec");
    }
  });

  it("generateDesign returns ok: true with design.md artifact", async () => {
    const { fn } = makeSpawn(0);
    const adapter = new CcSddAdapter(fn);
    const result = await adapter.generateDesign(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.artifactPath).toContain("design.md");
  });

  it("validateDesign returns ok: true with design.md artifact", async () => {
    const { fn } = makeSpawn(0);
    const adapter = new CcSddAdapter(fn);
    const result = await adapter.validateDesign(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.artifactPath).toContain("design.md");
  });

  it("generateTasks returns ok: true with tasks.md artifact", async () => {
    const { fn } = makeSpawn(0);
    const adapter = new CcSddAdapter(fn);
    const result = await adapter.generateTasks(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.artifactPath).toContain("tasks.md");
  });

  it("artifactPath is rooted under specDir/specName", async () => {
    const { fn } = makeSpawn(0);
    const adapter = new CcSddAdapter(fn);
    const result = await adapter.generateRequirements(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = join(ctx.specDir, ctx.specName);
      expect(result.artifactPath.startsWith(expected)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure path
// ---------------------------------------------------------------------------

describe("CcSddAdapter — failure (non-zero exit code)", () => {
  it("returns ok: false with exitCode and stderr on non-zero exit", async () => {
    const { fn } = makeSpawn(1, "cc-sdd: command not found");
    const adapter = new CcSddAdapter(fn);

    const result = await adapter.generateRequirements(ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.exitCode).toBe(1);
      expect(result.error.stderr).toBe("cc-sdd: command not found");
    }
  });

  it("exit code 127 (binary missing) maps to failure", async () => {
    const { fn } = makeSpawn(127, "bun: command not found: cc-sdd");
    const adapter = new CcSddAdapter(fn);
    const result = await adapter.generateDesign(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.exitCode).toBe(127);
  });

  it("all four operations propagate failure correctly", async () => {
    const ops = ["generateRequirements", "generateDesign", "validateDesign", "generateTasks"] as const;
    for (const op of ops) {
      const { fn } = makeSpawn(2, `${op} failed`);
      const adapter = new CcSddAdapter(fn);
      const result = await adapter[op](ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.exitCode).toBe(2);
        expect(result.error.stderr).toBe(`${op} failed`);
      }
    }
  });
});
