/**
 * Integration tests for CcSddAdapter using a real subprocess.
 *
 * These tests spawn a fake cc-sdd binary (a Bun script) to verify that:
 * - The adapter correctly spawns subprocesses with the right arguments
 * - Successful runs create the expected artifact files on disk
 * - Non-zero exit codes produce structured error results
 *
 * Task 9.1 — Requirements: 3.1, 3.2, 3.3, 3.6, 6.1, 6.4
 */
import type { SpecContext } from "@/application/ports/sdd";
import { CcSddAdapter, type SpawnFn } from "@/infra/sdd/cc-sdd-adapter";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Fake cc-sdd binary setup
// ---------------------------------------------------------------------------

/** Bun script content that mimics cc-sdd artifact generation. */
const FAKE_CC_SDD_CONTENT = `#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const subcmd = args[0] ?? '';
const specName = args[1] ?? '';
let specDir = '';
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--spec-dir' && args[i + 1]) {
    specDir = args[i + 1];
    i++;
  }
}

if (!specDir) {
  process.stderr.write('fake-cc-sdd: missing --spec-dir\\n');
  process.exit(1);
}

const specPath = join(specDir, specName);
await mkdir(specPath, { recursive: true });

switch (subcmd) {
  case 'requirements':
    await writeFile(join(specPath, 'requirements.md'), '# Requirements\\n');
    break;
  case 'design':
    await writeFile(join(specPath, 'design.md'), '# Design\\n');
    break;
  case 'validate-design':
    await writeFile(join(specPath, 'design.md'), '# Design (validated)\\n');
    break;
  case 'tasks':
    await writeFile(join(specPath, 'tasks.md'), '# Tasks\\n');
    break;
  default:
    process.stderr.write('fake-cc-sdd: unknown subcommand: ' + subcmd + '\\n');
    process.exit(1);
}
`;

/** Bun script that always exits non-zero with an error message on stderr. */
const FAKE_CC_SDD_FAILING_CONTENT = `#!/usr/bin/env bun
process.stderr.write('fake-cc-sdd: simulated failure\\n');
process.exit(2);
`;

let tmpDir: string;
let fakeBinaryPath: string;
let failingBinaryPath: string;

function makeRealSpawnWithBinary(binaryPath: string): SpawnFn {
  return (argv) => {
    const [_ccSdd, ...rest] = argv;
    return Bun.spawn(["bun", binaryPath, ...rest] as string[], { stderr: "pipe" });
  };
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "aes-cc-sdd-integration-"));

  fakeBinaryPath = join(tmpDir, "fake-cc-sdd.ts");
  await writeFile(fakeBinaryPath, FAKE_CC_SDD_CONTENT);
  await chmod(fakeBinaryPath, 0o755);

  failingBinaryPath = join(tmpDir, "fake-cc-sdd-failing.ts");
  await writeFile(failingBinaryPath, FAKE_CC_SDD_FAILING_CONTENT);
  await chmod(failingBinaryPath, 0o755);
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper to build a spec directory and context for each test
// ---------------------------------------------------------------------------

async function makeSpecDir(specName: string): Promise<{ specDir: string; ctx: SpecContext }> {
  const specDir = join(tmpDir, `specs-${Math.random().toString(36).slice(2)}`);
  await mkdir(specDir, { recursive: true });
  return { specDir, ctx: { specName, specDir, language: "en" } };
}

// ---------------------------------------------------------------------------
// Artifact creation tests
// ---------------------------------------------------------------------------

describe("CcSddAdapter — integration: kiro:spec-requirements", () => {
  it("creates requirements.md on disk and returns ok: true", async () => {
    const { ctx } = await makeSpecDir("my-spec");
    const adapter = new CcSddAdapter(makeRealSpawnWithBinary(fakeBinaryPath));

    const result = await adapter.executeCommand("kiro:spec-requirements", ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifactPath).toContain("requirements.md");
      const content = await readFile(result.artifactPath, "utf-8");
      expect(content).toContain("Requirements");
    }
  });
});

describe("CcSddAdapter — integration: kiro:spec-design", () => {
  it("creates design.md on disk and returns ok: true", async () => {
    const { ctx } = await makeSpecDir("my-spec");
    const adapter = new CcSddAdapter(makeRealSpawnWithBinary(fakeBinaryPath));

    const result = await adapter.executeCommand("kiro:spec-design", ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifactPath).toContain("design.md");
      const content = await readFile(result.artifactPath, "utf-8");
      expect(content).toContain("Design");
    }
  });
});

describe("CcSddAdapter — integration: kiro:validate-design", () => {
  it("creates/updates design.md on disk and returns ok: true", async () => {
    const { ctx } = await makeSpecDir("my-spec");
    const adapter = new CcSddAdapter(makeRealSpawnWithBinary(fakeBinaryPath));

    const result = await adapter.executeCommand("kiro:validate-design", ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifactPath).toContain("design.md");
      const content = await readFile(result.artifactPath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });
});

describe("CcSddAdapter — integration: kiro:spec-tasks", () => {
  it("creates tasks.md on disk and returns ok: true", async () => {
    const { ctx } = await makeSpecDir("my-spec");
    const adapter = new CcSddAdapter(makeRealSpawnWithBinary(fakeBinaryPath));

    const result = await adapter.executeCommand("kiro:spec-tasks", ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifactPath).toContain("tasks.md");
      const content = await readFile(result.artifactPath, "utf-8");
      expect(content).toContain("Tasks");
    }
  });
});

// ---------------------------------------------------------------------------
// Failure path: non-zero exit code
// ---------------------------------------------------------------------------

describe("CcSddAdapter — integration: failure (non-zero exit)", () => {
  it("returns ok: false with exitCode and stderr when subprocess exits non-zero", async () => {
    const { ctx } = await makeSpecDir("my-spec");
    const adapter = new CcSddAdapter(makeRealSpawnWithBinary(failingBinaryPath));

    const result = await adapter.executeCommand("kiro:spec-requirements", ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.exitCode).toBe(2);
      expect(result.error.stderr).toContain("simulated failure");
    }
  });

  it("all four commands propagate failure result", async () => {
    const commands = [
      "kiro:spec-requirements",
      "kiro:spec-design",
      "kiro:validate-design",
      "kiro:spec-tasks",
    ] as const;
    const { ctx } = await makeSpecDir("my-spec");
    const adapter = new CcSddAdapter(makeRealSpawnWithBinary(failingBinaryPath));

    for (const cmd of commands) {
      const result = await adapter.executeCommand(cmd, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.exitCode).not.toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Artifact path isolation
// ---------------------------------------------------------------------------

describe("CcSddAdapter — integration: artifact isolation", () => {
  it("stores artifacts in specDir/specName directory, not in parent", async () => {
    const { specDir, ctx } = await makeSpecDir("isolated-spec");
    const adapter = new CcSddAdapter(makeRealSpawnWithBinary(fakeBinaryPath));

    const result = await adapter.executeCommand("kiro:spec-requirements", ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifactPath.startsWith(join(specDir, "isolated-spec"))).toBe(true);
    }
  });

  it("artifacts from different specs do not interfere", async () => {
    const { ctx: ctxA } = await makeSpecDir("spec-alpha");
    const { ctx: ctxB } = await makeSpecDir("spec-beta");
    const adapter = new CcSddAdapter(makeRealSpawnWithBinary(fakeBinaryPath));

    const resultA = await adapter.executeCommand("kiro:spec-requirements", ctxA);
    const resultB = await adapter.executeCommand("kiro:spec-requirements", ctxB);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (resultA.ok && resultB.ok) {
      expect(resultA.artifactPath).not.toBe(resultB.artifactPath);
    }
  });
});
