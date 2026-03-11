export interface AesConfig {
  readonly llm: {
    readonly provider: string;
    readonly modelName: string;
    readonly apiKey: string;
  };
  readonly specDir: string;
  readonly sddFramework: 'cc-sdd' | 'openspec' | 'speckit';
}

export interface IConfigLoader {
  load(): Promise<AesConfig>;
}

export class ConfigValidationError extends Error {
  readonly missingFields: readonly string[];

  constructor(missingFields: readonly string[]) {
    super(`Missing required configuration fields: ${missingFields.join(', ')}`);
    this.name = 'ConfigValidationError';
    this.missingFields = missingFields;
  }
}
