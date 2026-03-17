import type { IConfigWizard, WizardInput } from "@/adapters/cli/config-wizard";
import { ConfigureCommand } from "@/adapters/cli/configure-command";
import type {
  FrameworkCheckResult,
  IConfigWriter,
  IFrameworkChecker,
  WritableConfig,
} from "@/application/ports/config";
import { describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const HAPPY_WIZARD_RESULT: WizardInput = {
  provider: "claude",
  modelName: "claude-opus-4-6",
  sddFramework: "cc-sdd",
  specDir: ".kiro/specs",
  logLevel: "info",
};

function makeWizard(result: WizardInput | "cancelled" = "cancelled"): IConfigWizard {
  return { run: mock(async () => result) };
}

function makeConfigWriter(): IConfigWriter {
  return { write: mock(async () => {}) };
}

function makeFrameworkChecker(result: FrameworkCheckResult = { installed: true }): IFrameworkChecker {
  return { check: mock(async () => result) };
}

function makeReadFileMissing() {
  return mock(async (_path: string) => {
    const err = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    throw err;
  });
}

// ---------------------------------------------------------------------------
// 4.1: Non-TTY guard
// ---------------------------------------------------------------------------

describe("ConfigureCommand — non-TTY guard", () => {
  it("writes an error to stderr when not running in a TTY", async () => {
    const stderrMock = mock((_msg: string) => {});
    const exitMock = mock((_code: number) => {});

    const cmd = new ConfigureCommand({
      isTTY: false,
      stderr: stderrMock,
      exit: exitMock,
      wizard: makeWizard(),
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
    });

    await cmd.run();

    expect(stderrMock).toHaveBeenCalled();
    const message = (stderrMock.mock.calls as Array<[string]>)[0]?.[0] ?? "";
    expect(message).toMatch(/non-TTY|interactive.*not supported|terminal/i);
  });

  it("exits with code 1 when not running in a TTY", async () => {
    const exitMock = mock((_code: number) => {});

    const cmd = new ConfigureCommand({
      isTTY: false,
      exit: exitMock,
      wizard: makeWizard(),
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
    });

    await cmd.run();

    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("does not call the wizard when not running in a TTY", async () => {
    const wizardRunMock = mock(async () => "cancelled" as const);
    const wizard: IConfigWizard = { run: wizardRunMock };

    const cmd = new ConfigureCommand({
      isTTY: false,
      exit: mock(() => {}),
      wizard,
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
    });

    await cmd.run();

    expect(wizardRunMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4.1: Wizard launch with defaults from existing config
// ---------------------------------------------------------------------------

describe("ConfigureCommand — wizard launch with defaults", () => {
  it("calls wizard.run() when running in a TTY", async () => {
    const wizardRunMock = mock(async () => "cancelled" as const);
    const wizard: IConfigWizard = { run: wizardRunMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard,
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
      readFile: makeReadFileMissing(),
    });

    await cmd.run();

    expect(wizardRunMock).toHaveBeenCalled();
  });

  it("passes undefined defaults to wizard when config file is missing", async () => {
    const wizardRunMock = mock(async () => "cancelled" as const);
    const wizard: IConfigWizard = { run: wizardRunMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard,
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
      readFile: makeReadFileMissing(),
    });

    await cmd.run();

    const callArgs = (wizardRunMock.mock.calls as unknown as Array<[unknown]>)[0];
    expect(callArgs?.[0]).toBeUndefined();
  });

  it("passes undefined defaults to wizard when config file contains malformed JSON", async () => {
    const wizardRunMock = mock(async () => "cancelled" as const);
    const wizard: IConfigWizard = { run: wizardRunMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard,
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
      readFile: mock(async () => "this is not { valid json"),
    });

    await cmd.run();

    const callArgs = (wizardRunMock.mock.calls as unknown as Array<[unknown]>)[0];
    expect(callArgs?.[0]).toBeUndefined();
  });

  it("passes pre-populated defaults to wizard from existing valid config", async () => {
    const existingConfig = {
      llm: { provider: "claude", modelName: "claude-sonnet-4-6" },
      sddFramework: "cc-sdd",
      specDir: "custom/specs",
    };

    const wizardRunMock = mock(async () => "cancelled" as const);
    const wizard: IConfigWizard = { run: wizardRunMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard,
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
      readFile: mock(async () => JSON.stringify(existingConfig)),
    });

    await cmd.run();

    const callArgs = (wizardRunMock.mock.calls as unknown as Array<[unknown]>)[0];
    const defaults = callArgs?.[0] as
      | { provider?: string; modelName?: string; sddFramework?: string; specDir?: string }
      | undefined;

    expect(defaults?.provider).toBe("claude");
    expect(defaults?.modelName).toBe("claude-sonnet-4-6");
    expect(defaults?.sddFramework).toBe("cc-sdd");
    expect(defaults?.specDir).toBe("custom/specs");
  });

  it("extracts only valid fields from a partially valid config", async () => {
    const partialConfig = {
      llm: { provider: "claude" },
      specDir: "my/specs",
      // modelName and sddFramework are missing
    };

    const wizardRunMock = mock(async () => "cancelled" as const);
    const wizard: IConfigWizard = { run: wizardRunMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard,
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
      readFile: mock(async () => JSON.stringify(partialConfig)),
    });

    await cmd.run();

    const callArgs = (wizardRunMock.mock.calls as unknown as Array<[unknown]>)[0];
    const defaults = callArgs?.[0] as
      | { provider?: string; modelName?: string; sddFramework?: string; specDir?: string }
      | undefined;

    expect(defaults?.provider).toBe("claude");
    expect(defaults?.modelName).toBeUndefined();
    expect(defaults?.specDir).toBe("my/specs");
    expect(defaults?.sddFramework).toBeUndefined();
  });

  it("ignores invalid sddFramework values from config", async () => {
    const configWithBadFramework = {
      llm: { provider: "claude", modelName: "claude-opus-4-6" },
      sddFramework: "unknown-framework",
      specDir: ".kiro/specs",
    };

    const wizardRunMock = mock(async () => "cancelled" as const);
    const wizard: IConfigWizard = { run: wizardRunMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard,
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
      readFile: mock(async () => JSON.stringify(configWithBadFramework)),
    });

    await cmd.run();

    const callArgs = (wizardRunMock.mock.calls as unknown as Array<[unknown]>)[0];
    const defaults = callArgs?.[0] as
      | { provider?: string; modelName?: string; sddFramework?: string; specDir?: string }
      | undefined;

    expect(defaults?.sddFramework).toBeUndefined();
    expect(defaults?.provider).toBe("claude");
  });

  it("pre-populates logLevel default from existing config", async () => {
    const existingConfig = {
      llm: { provider: "claude", modelName: "claude-opus-4-6" },
      sddFramework: "cc-sdd",
      specDir: ".kiro/specs",
      logLevel: "warn",
    };

    const wizardRunMock = mock(async () => "cancelled" as const);
    const wizard: IConfigWizard = { run: wizardRunMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard,
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
      readFile: mock(async () => JSON.stringify(existingConfig)),
    });

    await cmd.run();

    const callArgs = (wizardRunMock.mock.calls as unknown as Array<[unknown]>)[0];
    const defaults = callArgs?.[0] as { logLevel?: string } | undefined;
    expect(defaults?.logLevel).toBe("warn");
  });

  it("ignores invalid logLevel values from existing config", async () => {
    const existingConfig = {
      llm: { provider: "claude", modelName: "claude-opus-4-6" },
      sddFramework: "cc-sdd",
      specDir: ".kiro/specs",
      logLevel: "verbose", // invalid
    };

    const wizardRunMock = mock(async () => "cancelled" as const);
    const wizard: IConfigWizard = { run: wizardRunMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard,
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
      readFile: mock(async () => JSON.stringify(existingConfig)),
    });

    await cmd.run();

    const callArgs = (wizardRunMock.mock.calls as unknown as Array<[unknown]>)[0];
    const defaults = callArgs?.[0] as { logLevel?: string } | undefined;
    expect(defaults?.logLevel).toBeUndefined();
  });

  it("awaits and returns the wizard result", async () => {
    const wizardRunMock = mock(async () => HAPPY_WIZARD_RESULT);
    const wizard: IConfigWizard = { run: wizardRunMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard,
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
      readFile: makeReadFileMissing(),
    });

    // Should complete without error
    await expect(cmd.run()).resolves.toBeUndefined();
    expect(wizardRunMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4.2: Cancellation handling (Req 2.4)
// ---------------------------------------------------------------------------

describe("ConfigureCommand — cancellation handling", () => {
  it("displays a cancellation message when wizard returns 'cancelled'", async () => {
    const stdoutMock = mock((_msg: string) => {});

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard: makeWizard("cancelled"),
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
      readFile: makeReadFileMissing(),
      stdout: stdoutMock,
    });

    await cmd.run();

    expect(stdoutMock).toHaveBeenCalled();
    const allOutput = (stdoutMock.mock.calls as Array<[string]>).map(([m]) => m).join("");
    expect(allOutput).toMatch(/cancel/i);
  });

  it("does not call the framework checker when wizard is cancelled", async () => {
    const checkerMock = mock(async () => ({ installed: true as const }));
    const frameworkChecker: IFrameworkChecker = { check: checkerMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard: makeWizard("cancelled"),
      configWriter: makeConfigWriter(),
      frameworkChecker,
      readFile: makeReadFileMissing(),
      stdout: mock(() => {}),
    });

    await cmd.run();

    expect(checkerMock).not.toHaveBeenCalled();
  });

  it("does not call the config writer when wizard is cancelled", async () => {
    const writerMock = mock(async () => {});
    const configWriter: IConfigWriter = { write: writerMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard: makeWizard("cancelled"),
      configWriter,
      frameworkChecker: makeFrameworkChecker(),
      readFile: makeReadFileMissing(),
      stdout: mock(() => {}),
    });

    await cmd.run();

    expect(writerMock).not.toHaveBeenCalled();
  });

  it("exits cleanly (no exit call with code 1) when wizard is cancelled", async () => {
    const exitMock = mock((_code: number) => {});

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard: makeWizard("cancelled"),
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(),
      readFile: makeReadFileMissing(),
      exit: exitMock,
      stdout: mock(() => {}),
    });

    await cmd.run();

    // exit(1) should NOT be called; exit(0) is acceptable but not required
    const exitCalls = (exitMock.mock.calls as Array<[number]>).map(([code]) => code);
    expect(exitCalls).not.toContain(1);
  });
});

// ---------------------------------------------------------------------------
// 4.2: Framework check (Req 4.1, 4.3, 4.4, 4.5)
// ---------------------------------------------------------------------------

describe("ConfigureCommand — framework check", () => {
  it("calls frameworkChecker.check() with the selected sddFramework after wizard completes", async () => {
    const wizardResult: WizardInput = { ...HAPPY_WIZARD_RESULT, sddFramework: "openspec" };
    const checkerMock = mock(async () => ({ installed: true as const }));
    const frameworkChecker: IFrameworkChecker = { check: checkerMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard: makeWizard(wizardResult),
      configWriter: makeConfigWriter(),
      frameworkChecker,
      readFile: makeReadFileMissing(),
      stdout: mock(() => {}),
    });

    await cmd.run();

    expect(checkerMock).toHaveBeenCalledWith("openspec", expect.anything());
  });

  it("passes the cwd to the framework checker", async () => {
    const checkerMock = mock(async () => ({ installed: true as const }));
    const frameworkChecker: IFrameworkChecker = { check: checkerMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      cwd: "/test/project",
      wizard: makeWizard(HAPPY_WIZARD_RESULT),
      configWriter: makeConfigWriter(),
      frameworkChecker,
      readFile: makeReadFileMissing(),
      stdout: mock(() => {}),
    });

    await cmd.run();

    const callArgs = (checkerMock.mock.calls as unknown as Array<[string, string]>)[0];
    expect(callArgs?.[1]).toBe("/test/project");
  });

  it("does not call the config writer when framework is not installed", async () => {
    const writerMock = mock(async () => {});
    const configWriter: IConfigWriter = { write: writerMock };
    const notInstalledResult: FrameworkCheckResult = { installed: false, hint: "Run cc-sdd init first." };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard: makeWizard(HAPPY_WIZARD_RESULT),
      configWriter,
      frameworkChecker: makeFrameworkChecker(notInstalledResult),
      readFile: makeReadFileMissing(),
      stdout: mock(() => {}),
      stderr: mock(() => {}),
      exit: mock(() => {}),
    });

    await cmd.run();

    expect(writerMock).not.toHaveBeenCalled();
  });

  it("displays the hint message when framework is not installed", async () => {
    const stderrMock = mock((_msg: string) => {});
    const notInstalledResult: FrameworkCheckResult = { installed: false, hint: "Run cc-sdd init to set up." };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard: makeWizard(HAPPY_WIZARD_RESULT),
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(notInstalledResult),
      readFile: makeReadFileMissing(),
      stdout: mock(() => {}),
      stderr: stderrMock,
      exit: mock(() => {}),
    });

    await cmd.run();

    expect(stderrMock).toHaveBeenCalled();
    const allOutput = (stderrMock.mock.calls as Array<[string]>).map(([m]) => m).join("");
    expect(allOutput).toContain("Run cc-sdd init to set up.");
  });

  it("exits with code 1 when framework is not installed", async () => {
    const exitMock = mock((_code: number) => {});
    const notInstalledResult: FrameworkCheckResult = { installed: false, hint: "Install hint." };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard: makeWizard(HAPPY_WIZARD_RESULT),
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker(notInstalledResult),
      readFile: makeReadFileMissing(),
      stdout: mock(() => {}),
      stderr: mock(() => {}),
      exit: exitMock,
    });

    await cmd.run();

    expect(exitMock).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// 4.2: Config write — happy path and error handling (Req 5.2, 5.3, 5.4)
// ---------------------------------------------------------------------------

describe("ConfigureCommand — config write", () => {
  it("calls configWriter.write() with a WritableConfig matching the wizard result", async () => {
    const writerMock = mock(async () => {});
    const configWriter: IConfigWriter = { write: writerMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard: makeWizard(HAPPY_WIZARD_RESULT),
      configWriter,
      frameworkChecker: makeFrameworkChecker({ installed: true }),
      readFile: makeReadFileMissing(),
      stdout: mock(() => {}),
    });

    await cmd.run();

    expect(writerMock).toHaveBeenCalledTimes(1);
    const callArgs = (writerMock.mock.calls as unknown as Array<[WritableConfig, string?]>)[0];
    const written = callArgs?.[0];

    expect(written?.llm.provider).toBe("claude");
    expect(written?.llm.modelName).toBe("claude-opus-4-6");
    expect(written?.sddFramework).toBe("cc-sdd");
    expect(written?.specDir).toBe(".kiro/specs");
    expect(written?.logLevel).toBe("info");
    // API key must not be present
    expect((written as unknown as Record<string, unknown>)?.apiKey).toBeUndefined();
    expect((written?.llm as unknown as Record<string, unknown>)?.apiKey).toBeUndefined();
  });

  it("passes the cwd to the config writer", async () => {
    const writerMock = mock(async () => {});
    const configWriter: IConfigWriter = { write: writerMock };

    const cmd = new ConfigureCommand({
      isTTY: true,
      cwd: "/my/project",
      wizard: makeWizard(HAPPY_WIZARD_RESULT),
      configWriter,
      frameworkChecker: makeFrameworkChecker({ installed: true }),
      readFile: makeReadFileMissing(),
      stdout: mock(() => {}),
    });

    await cmd.run();

    const callArgs = (writerMock.mock.calls as unknown as Array<[WritableConfig, string?]>)[0];
    expect(callArgs?.[1]).toBe("/my/project");
  });

  it("displays a confirmation message after successful write", async () => {
    const stdoutMock = mock((_msg: string) => {});

    const cmd = new ConfigureCommand({
      isTTY: true,
      cwd: "/my/project",
      wizard: makeWizard(HAPPY_WIZARD_RESULT),
      configWriter: makeConfigWriter(),
      frameworkChecker: makeFrameworkChecker({ installed: true }),
      readFile: makeReadFileMissing(),
      stdout: stdoutMock,
    });

    await cmd.run();

    const allOutput = (stdoutMock.mock.calls as Array<[string]>).map(([m]) => m).join("");
    expect(allOutput).toMatch(/aes\.config\.json/);
  });

  it("displays an error and exits with code 1 when the config writer fails", async () => {
    const stderrMock = mock((_msg: string) => {});
    const exitMock = mock((_code: number) => {});
    const writerMock = mock(async () => {
      throw new Error("EACCES: permission denied");
    });

    const cmd = new ConfigureCommand({
      isTTY: true,
      wizard: makeWizard(HAPPY_WIZARD_RESULT),
      configWriter: { write: writerMock },
      frameworkChecker: makeFrameworkChecker({ installed: true }),
      readFile: makeReadFileMissing(),
      stdout: mock(() => {}),
      stderr: stderrMock,
      exit: exitMock,
    });

    await cmd.run();

    expect(exitMock).toHaveBeenCalledWith(1);
    const allOutput = (stderrMock.mock.calls as Array<[string]>).map(([m]) => m).join("");
    expect(allOutput).toMatch(/EACCES|permission denied|Error/i);
  });
});
