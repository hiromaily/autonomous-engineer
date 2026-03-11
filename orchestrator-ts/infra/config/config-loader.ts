import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AesConfig, type IConfigLoader, ConfigValidationError } from '../../application/ports/config';

const VALID_SDD_FRAMEWORKS = ['cc-sdd', 'openspec', 'speckit'] as const;

export class ConfigLoader implements IConfigLoader {
  constructor(
    private readonly cwd: string = process.cwd(),
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async load(): Promise<AesConfig> {
    const fileConfig = await this.readConfigFile();
    const merged = this.mergeWithEnv(fileConfig);
    return this.validate(merged);
  }

  private async readConfigFile(): Promise<Partial<RawConfig>> {
    const configPath = join(this.cwd, 'aes.config.json');
    try {
      const content = await readFile(configPath, 'utf-8');
      return JSON.parse(content) as Partial<RawConfig>;
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return {};
      }
      throw err;
    }
  }

  private mergeWithEnv(file: Partial<RawConfig>): MergedConfig {
    return {
      provider: this.env['AES_LLM_PROVIDER'] ?? file.llm?.provider,
      modelName: this.env['AES_LLM_MODEL_NAME'] ?? file.llm?.modelName,
      apiKey: this.env['AES_LLM_API_KEY'] ?? file.llm?.apiKey,
      specDir: this.env['AES_SPEC_DIR'] ?? file.specDir,
      sddFramework: this.env['AES_SDD_FRAMEWORK'] ?? file.sddFramework,
    };
  }

  private validate(merged: MergedConfig): AesConfig {
    const missing: string[] = [];

    if (!merged.provider) missing.push('llm.provider');
    if (!merged.modelName) missing.push('llm.modelName');
    if (!merged.apiKey) missing.push('llm.apiKey');

    if (missing.length > 0) {
      throw new ConfigValidationError(missing);
    }

    return {
      llm: {
        provider: merged.provider!,
        modelName: merged.modelName!,
        apiKey: merged.apiKey!,
      },
      specDir: merged.specDir ?? '.kiro/specs',
      sddFramework: this.parseSddFramework(merged.sddFramework),
    };
  }

  private parseSddFramework(value: string | undefined): 'cc-sdd' | 'openspec' | 'speckit' {
    if (isValidSddFramework(value)) return value;
    return 'cc-sdd';
  }
}

interface RawConfig {
  llm?: {
    provider?: string;
    modelName?: string;
    apiKey?: string;
  };
  specDir?: string;
  sddFramework?: string;
}

interface MergedConfig {
  provider: string | undefined;
  modelName: string | undefined;
  apiKey: string | undefined;
  specDir: string | undefined;
  sddFramework: string | undefined;
}

function isValidSddFramework(value: string | undefined): value is 'cc-sdd' | 'openspec' | 'speckit' {
  return value !== undefined && (VALID_SDD_FRAMEWORKS as readonly string[]).includes(value);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
