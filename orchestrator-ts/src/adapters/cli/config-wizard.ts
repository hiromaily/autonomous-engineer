import { LOG_LEVEL_ORDER, type LogLevel } from "@/application/ports/logger";
import * as p from "@clack/prompts";

const LOG_LEVEL_OPTIONS = LOG_LEVEL_ORDER.map((level) => ({ value: level, label: level }));

export interface WizardDefaults {
  readonly provider?: string;
  readonly modelName?: string;
  readonly sddFramework?: "cc-sdd" | "openspec" | "speckit";
  readonly specDir?: string;
  readonly logLevel?: LogLevel;
}

export interface WizardInput {
  readonly provider: string;
  readonly modelName: string;
  readonly sddFramework: "cc-sdd" | "openspec" | "speckit";
  readonly specDir: string;
  readonly logLevel: LogLevel;
}

export interface IConfigWizard {
  run(defaults?: WizardDefaults): Promise<WizardInput | "cancelled">;
}

// Minimal interface for the prompts functions needed by the wizard.
// Default implementation delegates to @clack/prompts; injectable for testing.
export interface WizardPrompts {
  intro(title: string): void;
  select<T extends string>(opts: {
    message: string;
    options: ReadonlyArray<{ value: T; label: string }>;
    initialValue?: T;
  }): Promise<T | symbol>;
  text(opts: {
    message: string;
    defaultValue?: string;
    placeholder?: string;
  }): Promise<string | symbol>;
  isCancel(value: unknown): boolean;
  note(message: string, title?: string): void;
}

const clackPrompts: WizardPrompts = {
  intro: p.intro,
  select: p.select as WizardPrompts["select"],
  text: p.text as WizardPrompts["text"],
  isCancel: p.isCancel,
  note: p.note,
};

const BUILTIN_DEFAULTS = {
  provider: "claude" as const,
  modelName: "claude-opus-4-6",
  sddFramework: "cc-sdd" as const,
  specDir: ".kiro/specs",
  logLevel: "info" as LogLevel,
};

export class ConfigWizard implements IConfigWizard {
  private readonly prompts: WizardPrompts;

  constructor(prompts: WizardPrompts = clackPrompts) {
    this.prompts = prompts;
  }

  private async promptForRequiredText(opts: {
    message: string;
    defaultValue?: string;
    placeholder?: string;
  }): Promise<string | "cancelled"> {
    while (true) {
      const result = await this.prompts.text(opts);
      if (this.prompts.isCancel(result)) return "cancelled";
      const value = (result as string).trim();
      if (value) return value;
    }
  }

  async run(defaults?: WizardDefaults): Promise<WizardInput | "cancelled"> {
    this.prompts.intro("Configure aes");

    // Step 1: LLM provider
    const provider = await this.prompts.select({
      message: "LLM provider",
      options: [{ value: "claude", label: "claude" }] as const,
      initialValue: (defaults?.provider ?? BUILTIN_DEFAULTS.provider) as "claude",
    });
    if (this.prompts.isCancel(provider)) return "cancelled";

    // Step 2: Model name (re-prompt until non-empty)
    const modelNameDefault = defaults?.modelName ?? BUILTIN_DEFAULTS.modelName;
    const modelName = await this.promptForRequiredText({
      message: "Model name",
      defaultValue: modelNameDefault,
      placeholder: modelNameDefault,
    });
    if (modelName === "cancelled") return "cancelled";

    // Step 3: SDD framework
    const sddFramework = await this.prompts.select({
      message: "SDD framework",
      options: [
        { value: "cc-sdd", label: "cc-sdd" },
        { value: "openspec", label: "openspec" },
        { value: "speckit", label: "speckit" },
      ] as const,
      initialValue: defaults?.sddFramework ?? BUILTIN_DEFAULTS.sddFramework,
    });
    if (this.prompts.isCancel(sddFramework)) return "cancelled";

    // Step 4: Spec directory (re-prompt until non-empty)
    const specDirDefault = defaults?.specDir ?? BUILTIN_DEFAULTS.specDir;
    const specDir = await this.promptForRequiredText({
      message: "Spec directory",
      defaultValue: specDirDefault,
      placeholder: specDirDefault,
    });
    if (specDir === "cancelled") return "cancelled";

    // Step 5: Log level
    const logLevel = await this.prompts.select<LogLevel>({
      message: "Log level",
      options: LOG_LEVEL_OPTIONS,
      initialValue: defaults?.logLevel ?? BUILTIN_DEFAULTS.logLevel,
    });
    if (this.prompts.isCancel(logLevel)) return "cancelled";

    // Req 3.6: Instruct user to set API key via environment variable
    this.prompts.note(
      "Set AES_LLM_API_KEY as an environment variable to provide your LLM API key.\n"
        + "The API key is never written to aes.config.json.",
      "API Key Setup",
    );

    return {
      provider: provider as string,
      modelName,
      sddFramework: sddFramework as "cc-sdd" | "openspec" | "speckit",
      specDir,
      logLevel: logLevel as LogLevel,
    };
  }
}
