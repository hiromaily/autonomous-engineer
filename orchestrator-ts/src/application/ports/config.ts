// Config shape written to aes.config.json — API key intentionally excluded
export interface WritableConfig {
  readonly llm: {
    readonly provider: string;
    readonly modelName: string;
  };
  readonly specDir: string;
  readonly sddFramework: "cc-sdd" | "openspec" | "speckit";
}

export type FrameworkCheckResult =
  | { readonly installed: true }
  | { readonly installed: false; readonly hint: string };

export interface IConfigWriter {
  write(config: WritableConfig, cwd?: string): Promise<void>;
}

export interface IFrameworkChecker {
  check(
    framework: "cc-sdd" | "openspec" | "speckit",
    cwd?: string,
  ): Promise<FrameworkCheckResult>;
}

export interface AesConfig {
  readonly llm: {
    readonly provider: string;
    readonly modelName: string;
    readonly apiKey: string;
  };
  readonly specDir: string;
  readonly sddFramework: "cc-sdd" | "openspec" | "speckit";
}

export interface IConfigLoader {
  load(): Promise<AesConfig>;
}

export class ConfigValidationError extends Error {
  readonly missingFields: readonly string[];

  constructor(missingFields: readonly string[]) {
    super(`Missing required configuration fields: ${missingFields.join(", ")}`);
    this.name = "ConfigValidationError";
    this.missingFields = missingFields;
  }
}
