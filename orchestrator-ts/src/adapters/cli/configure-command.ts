import type { IConfigWizard, WizardDefaults, WizardInput } from "@/adapters/cli/config-wizard";
import type { IConfigWriter, IFrameworkChecker, WritableConfig } from "@/application/ports/config";
import { type ILogger, LOG_LEVEL_ORDER, type LogLevel } from "@/application/ports/logger";
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";

export interface ConfigureCommandOptions {
  readonly wizard: IConfigWizard;
  readonly configWriter: IConfigWriter;
  readonly frameworkChecker: IFrameworkChecker;
  readonly logger?: ILogger;
  readonly cwd?: string;
  /** Override the TTY check; defaults to `process.stdin.isTTY`. */
  readonly isTTY?: boolean;
  /** Override stdout output; defaults to `process.stdout.write`. */
  readonly stdout?: (msg: string) => void;
  /** Override stderr output; defaults to `process.stderr.write`. */
  readonly stderr?: (msg: string) => void;
  /** Override process exit; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /** Override file reader; defaults to `node:fs/promises` readFile. */
  readonly readFile?: (path: string, encoding: string) => Promise<string>;
}

export class ConfigureCommand {
  private readonly wizard: IConfigWizard;
  private readonly configWriter: IConfigWriter;
  private readonly frameworkChecker: IFrameworkChecker;
  private readonly cwd: string;
  private readonly isTTY: boolean;
  private readonly stdoutFn: (msg: string) => void;
  private readonly stderrFn: (msg: string) => void;
  private readonly exitFn: (code: number) => void;
  private readonly readFileFn: (path: string, encoding: string) => Promise<string>;

  constructor(opts: ConfigureCommandOptions) {
    this.wizard = opts.wizard;
    this.configWriter = opts.configWriter;
    this.frameworkChecker = opts.frameworkChecker;
    this.cwd = opts.cwd ?? process.cwd();
    this.isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
    this.stdoutFn = opts.stdout ?? ((msg) => process.stdout.write(msg));
    this.stderrFn = opts.stderr ?? ((msg) => process.stderr.write(msg));
    this.exitFn = opts.exit ?? ((code) => process.exit(code));
    this.readFileFn = opts.readFile ?? ((path, encoding) => fsReadFile(path, encoding as BufferEncoding));
  }

  async run(): Promise<void> {
    // Non-TTY guard (Req 2.5)
    if (!this.isTTY) {
      this.stderrFn(
        "Error: interactive configuration is not supported in non-TTY environments.\n"
          + "Run 'aes configure' from an interactive terminal.\n",
      );
      this.exitFn(1);
      return; // unreachable in production; guards mocked exit in tests
    }

    // Load existing config partially for pre-population (Req 2.2)
    const defaults = await this.loadPartialConfig();

    // Run the wizard (Req 2.1, 2.3)
    const result = await this.wizard.run(defaults);

    // Handle cancellation (Req 2.4)
    if (result === "cancelled") {
      this.stdoutFn("Configuration cancelled. No changes saved.\n");
      return;
    }

    // Check SDD framework installation (Req 4.1, 4.3, 4.4, 4.5)
    const checkResult = await this.frameworkChecker.check(result.sddFramework, this.cwd);
    if (!checkResult.installed) {
      this.stderrFn(
        `Error: ${result.sddFramework} is not set up in this project.\n${checkResult.hint}\n`,
      );
      this.exitFn(1);
      return; // unreachable in production; guards mocked exit in tests
    }

    // Write configuration file (Req 5.1, 5.2, 5.3, 5.4)
    const writableConfig = toWritableConfig(result);
    try {
      await this.configWriter.write(writableConfig, this.cwd);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.stderrFn(`Error: failed to write aes.config.json: ${reason}\n`);
      this.exitFn(1);
      return; // unreachable in production; guards mocked exit in tests
    }

    // Confirmation message (Req 5.2)
    const configPath = join(this.cwd, "aes.config.json");
    this.stdoutFn(`Configuration saved to ${configPath}\n`);
  }

  private async loadPartialConfig(): Promise<WizardDefaults | undefined> {
    const configPath = join(this.cwd, "aes.config.json");
    try {
      const content = await this.readFileFn(configPath, "utf-8");
      const raw = JSON.parse(content) as Record<string, unknown>;
      const llm = raw.llm as Record<string, unknown> | undefined;

      return {
        ...(typeof llm?.provider === "string" ? { provider: llm.provider } : {}),
        ...(typeof llm?.modelName === "string" ? { modelName: llm.modelName } : {}),
        ...(isValidSddFramework(raw.sddFramework) ? { sddFramework: raw.sddFramework } : {}),
        ...(typeof raw.specDir === "string" ? { specDir: raw.specDir } : {}),
        ...(isValidLogLevel(raw.logLevel) ? { logLevel: raw.logLevel } : {}),
      };
    } catch {
      // Missing or malformed config file: treat as no defaults (Req 2.2)
      return undefined;
    }
  }
}

function isValidSddFramework(value: unknown): value is "cc-sdd" | "openspec" | "speckit" {
  return value === "cc-sdd" || value === "openspec" || value === "speckit";
}

function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVEL_ORDER as readonly string[]).includes(value);
}

function toWritableConfig(input: WizardInput): WritableConfig {
  return {
    llm: {
      provider: input.provider,
      modelName: input.modelName,
    },
    specDir: input.specDir,
    sddFramework: input.sddFramework,
    logLevel: input.logLevel,
  };
}
