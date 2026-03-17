import { type AesConfig, ConfigValidationError, type IConfigLoader } from "@/application/ports/config";
import type { GitIntegrationConfig } from "@/domain/git/types";
import { isNodeError } from "@/infra/utils/errors";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const VALID_SDD_FRAMEWORKS = ["cc-sdd", "openspec", "speckit"] as const;

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
    const configPath = join(this.cwd, "aes.config.json");
    try {
      const content = await readFile(configPath, "utf-8");
      return JSON.parse(content) as Partial<RawConfig>;
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return {};
      }
      throw err;
    }
  }

  private mergeWithEnv(file: Partial<RawConfig>): MergedConfig {
    return {
      provider: this.env.AES_LLM_PROVIDER ?? file.llm?.provider,
      modelName: this.env.AES_LLM_MODEL_NAME ?? file.llm?.modelName,
      apiKey: this.env.AES_LLM_API_KEY ?? file.llm?.apiKey,
      specDir: this.env.AES_SPEC_DIR ?? file.specDir,
      sddFramework: this.env.AES_SDD_FRAMEWORK ?? file.sddFramework,
    };
  }

  private validate(merged: MergedConfig): AesConfig {
    const missing: string[] = [];

    if (!merged.provider) missing.push("llm.provider");
    if (!merged.modelName) missing.push("llm.modelName");
    if (!merged.apiKey) missing.push("llm.apiKey");

    if (missing.length > 0) {
      throw new ConfigValidationError(missing);
    }

    return {
      llm: {
        provider: merged.provider as string,
        modelName: merged.modelName as string,
        apiKey: merged.apiKey as string,
      },
      specDir: merged.specDir ?? ".kiro/specs",
      sddFramework: this.parseSddFramework(merged.sddFramework),
    };
  }

  private parseSddFramework(value: string | undefined): "cc-sdd" | "openspec" | "speckit" {
    if (isValidSddFramework(value)) return value;
    return "cc-sdd";
  }

  /**
   * Load GitIntegrationConfig from environment variables with sensible defaults.
   * No file read required — git config is env-only.
   */
  loadGitIntegrationConfig(): GitIntegrationConfig {
    const env = this.env;

    const baseBranch = env.AES_GIT_BASE_BRANCH ?? "main";
    const remote = env.AES_GIT_REMOTE ?? "origin";
    const maxFilesPerCommit = env.AES_GIT_MAX_FILES_PER_COMMIT
      ? parseInt(env.AES_GIT_MAX_FILES_PER_COMMIT, 10)
      : 50;
    const maxDiffTokens = env.AES_GIT_MAX_DIFF_TOKENS
      ? parseInt(env.AES_GIT_MAX_DIFF_TOKENS, 10)
      : 2000;
    const forcePushEnabled = env.AES_GIT_FORCE_PUSH_ENABLED === "true";
    const isDraft = env.AES_GIT_IS_DRAFT === "true";
    const workspaceRoot = this.cwd;

    const protectedBranches: ReadonlyArray<string> = env.AES_GIT_PROTECTED_BRANCHES
      ? env.AES_GIT_PROTECTED_BRANCHES.split(",").map((b) => b.trim())
      : ["main", "master", "production", "release/*"];

    const protectedFilePatterns: ReadonlyArray<string> = env.AES_GIT_PROTECTED_FILE_PATTERNS
      ? env.AES_GIT_PROTECTED_FILE_PATTERNS.split(",").map((p) => p.trim())
      : [".env", "*.key", "*.pem", "secrets.json"];

    return Object.freeze({
      baseBranch,
      remote,
      maxFilesPerCommit,
      maxDiffTokens,
      protectedBranches,
      protectedFilePatterns,
      forcePushEnabled,
      workspaceRoot,
      isDraft,
    });
  }

  /** Returns the GitHub token from AES_GITHUB_TOKEN env var, or undefined if not set. */
  loadGithubToken(): string | undefined {
    return this.env.AES_GITHUB_TOKEN;
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

function isValidSddFramework(value: string | undefined): value is "cc-sdd" | "openspec" | "speckit" {
  return value !== undefined && (VALID_SDD_FRAMEWORKS as readonly string[]).includes(value);
}
