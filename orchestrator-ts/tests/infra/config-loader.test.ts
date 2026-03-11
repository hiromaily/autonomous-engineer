import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigLoader } from '../../infra/config/config-loader';
import { ConfigValidationError } from '../../application/ports/config';

describe('ConfigLoader', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aes-config-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('load()', () => {
    it('loads full config from aes.config.json', async () => {
      const raw = {
        llm: { provider: 'anthropic', modelName: 'claude-sonnet-4-6', apiKey: 'sk-test' },
        specDir: 'custom/specs',
        sddFramework: 'cc-sdd',
      };
      await writeFile(join(tmpDir, 'aes.config.json'), JSON.stringify(raw));

      const loader = new ConfigLoader(tmpDir, {});
      const config = await loader.load();

      expect(config.llm.provider).toBe('anthropic');
      expect(config.llm.modelName).toBe('claude-sonnet-4-6');
      expect(config.llm.apiKey).toBe('sk-test');
      expect(config.specDir).toBe('custom/specs');
      expect(config.sddFramework).toBe('cc-sdd');
    });

    it('defaults specDir to .kiro/specs when not present in file or env', async () => {
      const raw = { llm: { provider: 'anthropic', modelName: 'claude-sonnet-4-6', apiKey: 'sk-test' } };
      await writeFile(join(tmpDir, 'aes.config.json'), JSON.stringify(raw));

      const loader = new ConfigLoader(tmpDir, {});
      const config = await loader.load();

      expect(config.specDir).toBe('.kiro/specs');
    });

    it('defaults sddFramework to cc-sdd when not present in file or env', async () => {
      const raw = { llm: { provider: 'anthropic', modelName: 'claude-sonnet-4-6', apiKey: 'sk-test' } };
      await writeFile(join(tmpDir, 'aes.config.json'), JSON.stringify(raw));

      const loader = new ConfigLoader(tmpDir, {});
      const config = await loader.load();

      expect(config.sddFramework).toBe('cc-sdd');
    });

    it('environment variables override file values', async () => {
      const raw = {
        llm: { provider: 'anthropic', modelName: 'claude-opus', apiKey: 'file-key' },
        specDir: 'file/specs',
        sddFramework: 'cc-sdd',
      };
      await writeFile(join(tmpDir, 'aes.config.json'), JSON.stringify(raw));

      const loader = new ConfigLoader(tmpDir, {
        AES_LLM_API_KEY: 'env-key',
        AES_LLM_MODEL_NAME: 'claude-sonnet-4-6',
        AES_SPEC_DIR: 'env/specs',
      });
      const config = await loader.load();

      expect(config.llm.apiKey).toBe('env-key');
      expect(config.llm.modelName).toBe('claude-sonnet-4-6');
      expect(config.llm.provider).toBe('anthropic'); // still from file
      expect(config.specDir).toBe('env/specs');
    });

    it('loads config from environment variables alone when no config file exists', async () => {
      const loader = new ConfigLoader(tmpDir, {
        AES_LLM_PROVIDER: 'anthropic',
        AES_LLM_MODEL_NAME: 'claude-sonnet-4-6',
        AES_LLM_API_KEY: 'env-only-key',
      });
      const config = await loader.load();

      expect(config.llm.provider).toBe('anthropic');
      expect(config.llm.apiKey).toBe('env-only-key');
    });

    it('accepts openspec as sddFramework', async () => {
      const raw = {
        llm: { provider: 'anthropic', modelName: 'claude-sonnet-4-6', apiKey: 'sk-test' },
        sddFramework: 'openspec',
      };
      await writeFile(join(tmpDir, 'aes.config.json'), JSON.stringify(raw));

      const loader = new ConfigLoader(tmpDir, {});
      const config = await loader.load();

      expect(config.sddFramework).toBe('openspec');
    });

    it('overrides sddFramework via environment variable', async () => {
      const raw = {
        llm: { provider: 'anthropic', modelName: 'claude-sonnet-4-6', apiKey: 'sk-test' },
        sddFramework: 'cc-sdd',
      };
      await writeFile(join(tmpDir, 'aes.config.json'), JSON.stringify(raw));

      const loader = new ConfigLoader(tmpDir, { AES_SDD_FRAMEWORK: 'openspec' });
      const config = await loader.load();

      expect(config.sddFramework).toBe('openspec');
    });

    it('throws ConfigValidationError when llm.apiKey is missing', async () => {
      const raw = { llm: { provider: 'anthropic', modelName: 'claude-sonnet-4-6' } };
      await writeFile(join(tmpDir, 'aes.config.json'), JSON.stringify(raw));

      const loader = new ConfigLoader(tmpDir, {});

      await expect(loader.load()).rejects.toBeInstanceOf(ConfigValidationError);
    });

    it('reports all missing required fields', async () => {
      const loader = new ConfigLoader(tmpDir, {});

      let caught: unknown;
      try {
        await loader.load();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConfigValidationError);
      const err = caught as ConfigValidationError;
      expect(err.missingFields).toContain('llm.provider');
      expect(err.missingFields).toContain('llm.modelName');
      expect(err.missingFields).toContain('llm.apiKey');
    });

    it('throws on malformed JSON in aes.config.json', async () => {
      await writeFile(join(tmpDir, 'aes.config.json'), '{ not valid json }');

      const loader = new ConfigLoader(tmpDir, {});

      await expect(loader.load()).rejects.toThrow();
    });

    it('returned config is readonly (sddFramework type is narrowed)', async () => {
      const raw = {
        llm: { provider: 'anthropic', modelName: 'claude-sonnet-4-6', apiKey: 'sk-test' },
      };
      await writeFile(join(tmpDir, 'aes.config.json'), JSON.stringify(raw));

      const loader = new ConfigLoader(tmpDir, {});
      const config = await loader.load();

      // sddFramework should be the literal union type, not arbitrary string
      const frameworks: Array<'cc-sdd' | 'openspec' | 'speckit'> = ['cc-sdd', 'openspec', 'speckit'];
      expect(frameworks).toContain(config.sddFramework);
    });
  });
});
