/**
 * Integration tests for the `aes configure` command (Task 7.1).
 *
 * Uses real ConfigWriter and SddFrameworkChecker adapters with a real temp
 * directory. The wizard is stubbed to simulate piped stdin inputs without
 * requiring a TTY. Covers:
 * - Req 2.1: config wizard completes and writes aes.config.json
 * - Req 5.1: file is written to the correct path
 * - Req 5.4: llm.apiKey is absent from the written file
 */
import type { IConfigWizard, WizardInput } from "@/adapters/cli/config-wizard";
import { ConfigureCommand } from "@/adapters/cli/configure-command";
import { ConfigWriter } from "@/infra/config/config-writer";
import { SddFrameworkChecker } from "@/infra/config/sdd-framework-checker";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStdinWizard(result: WizardInput | "cancelled"): IConfigWizard {
  return { run: mock(async () => result) };
}

interface TestEnv {
  tmpDir: string;
  cleanup: () => Promise<void>;
}

async function setupTestEnv(): Promise<TestEnv> {
  const tmpDir = await mkdtemp(join(tmpdir(), "aes-configure-integration-"));
  // Create .kiro/ so cc-sdd framework check passes
  await mkdir(join(tmpDir, ".kiro"), { recursive: true });
  return {
    tmpDir,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Req 2.1 + 5.1: aes.config.json is written with the correct schema
// ---------------------------------------------------------------------------

describe("aes configure integration: writes aes.config.json", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupTestEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("writes aes.config.json to the project directory after wizard completes", async () => {
    const wizardResult: WizardInput = {
      provider: "claude",
      modelName: "claude-opus-4-6",
      sddFramework: "cc-sdd",
      specDir: ".kiro/specs",
      logLevel: "info",
    };

    const cmd = new ConfigureCommand({
      isTTY: true,
      cwd: env.tmpDir,
      wizard: makeStdinWizard(wizardResult),
      configWriter: new ConfigWriter(),
      frameworkChecker: new SddFrameworkChecker(),
      stdout: mock(() => {}),
    });

    await cmd.run();

    const configPath = join(env.tmpDir, "aes.config.json");
    const raw = await readFile(configPath, "utf-8");
    expect(raw).toBeTruthy();
  });

  it("written JSON parses to a valid object with expected fields", async () => {
    const wizardResult: WizardInput = {
      provider: "claude",
      modelName: "claude-opus-4-6",
      sddFramework: "cc-sdd",
      specDir: ".kiro/specs",
      logLevel: "info",
    };

    const cmd = new ConfigureCommand({
      isTTY: true,
      cwd: env.tmpDir,
      wizard: makeStdinWizard(wizardResult),
      configWriter: new ConfigWriter(),
      frameworkChecker: new SddFrameworkChecker(),
      stdout: mock(() => {}),
    });

    await cmd.run();

    const configPath = join(env.tmpDir, "aes.config.json");
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const llm = parsed.llm as Record<string, unknown> | undefined;
    expect(llm?.provider).toBe("claude");
    expect(llm?.modelName).toBe("claude-opus-4-6");
    expect(parsed.sddFramework).toBe("cc-sdd");
    expect(parsed.specDir).toBe(".kiro/specs");
  });

  it("uses the exact specDir provided by the wizard", async () => {
    const wizardResult: WizardInput = {
      provider: "claude",
      modelName: "claude-sonnet-4-6",
      sddFramework: "cc-sdd",
      specDir: "custom/spec/dir",
      logLevel: "info",
    };

    const cmd = new ConfigureCommand({
      isTTY: true,
      cwd: env.tmpDir,
      wizard: makeStdinWizard(wizardResult),
      configWriter: new ConfigWriter(),
      frameworkChecker: new SddFrameworkChecker(),
      stdout: mock(() => {}),
    });

    await cmd.run();

    const configPath = join(env.tmpDir, "aes.config.json");
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.specDir).toBe("custom/spec/dir");
  });
});

// ---------------------------------------------------------------------------
// Req 5.4: llm.apiKey is absent from the written file
// ---------------------------------------------------------------------------

describe("aes configure integration: apiKey is absent from written file", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupTestEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("does not write llm.apiKey to aes.config.json", async () => {
    const wizardResult: WizardInput = {
      provider: "claude",
      modelName: "claude-opus-4-6",
      sddFramework: "cc-sdd",
      specDir: ".kiro/specs",
      logLevel: "info",
    };

    const cmd = new ConfigureCommand({
      isTTY: true,
      cwd: env.tmpDir,
      wizard: makeStdinWizard(wizardResult),
      configWriter: new ConfigWriter(),
      frameworkChecker: new SddFrameworkChecker(),
      stdout: mock(() => {}),
    });

    await cmd.run();

    const configPath = join(env.tmpDir, "aes.config.json");
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // llm.apiKey must be absent at every nesting level
    const llm = parsed.llm as Record<string, unknown> | undefined;
    expect(llm?.apiKey).toBeUndefined();
    expect(parsed.apiKey).toBeUndefined();
  });

  it("written JSON string does not contain the literal text 'apiKey'", async () => {
    const wizardResult: WizardInput = {
      provider: "claude",
      modelName: "claude-opus-4-6",
      sddFramework: "cc-sdd",
      specDir: ".kiro/specs",
      logLevel: "info",
    };

    const cmd = new ConfigureCommand({
      isTTY: true,
      cwd: env.tmpDir,
      wizard: makeStdinWizard(wizardResult),
      configWriter: new ConfigWriter(),
      frameworkChecker: new SddFrameworkChecker(),
      stdout: mock(() => {}),
    });

    await cmd.run();

    const configPath = join(env.tmpDir, "aes.config.json");
    const raw = await readFile(configPath, "utf-8");
    expect(raw).not.toContain("apiKey");
  });
});

// ---------------------------------------------------------------------------
// Integration: no file written on cancellation
// ---------------------------------------------------------------------------

describe("aes configure integration: no file written on cancellation", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupTestEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("does not write aes.config.json when the wizard is cancelled", async () => {
    const cmd = new ConfigureCommand({
      isTTY: true,
      cwd: env.tmpDir,
      wizard: makeStdinWizard("cancelled"),
      configWriter: new ConfigWriter(),
      frameworkChecker: new SddFrameworkChecker(),
      stdout: mock(() => {}),
    });

    await cmd.run();

    const configPath = join(env.tmpDir, "aes.config.json");
    let existed = false;
    try {
      await readFile(configPath, "utf-8");
      existed = true;
    } catch {
      // File should not exist
    }
    expect(existed).toBe(false);
  });
});
