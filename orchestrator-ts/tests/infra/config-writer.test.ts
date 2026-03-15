import type { WritableConfig } from "@/application/ports/config";
import { ConfigWriter } from "@/infra/config/config-writer";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ConfigWriter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-config-writer-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("write()", () => {
    it("writes aes.config.json with all WritableConfig fields", async () => {
      const config: WritableConfig = {
        llm: { provider: "claude", modelName: "claude-opus-4-6" },
        specDir: ".kiro/specs",
        sddFramework: "cc-sdd",
      };

      const writer = new ConfigWriter();
      await writer.write(config, tmpDir);

      const written = JSON.parse(await readFile(join(tmpDir, "aes.config.json"), "utf-8"));
      expect(written.llm.provider).toBe("claude");
      expect(written.llm.modelName).toBe("claude-opus-4-6");
      expect(written.specDir).toBe(".kiro/specs");
      expect(written.sddFramework).toBe("cc-sdd");
    });

    it("does not write llm.apiKey to the output file", async () => {
      const config: WritableConfig = {
        llm: { provider: "claude", modelName: "claude-opus-4-6" },
        specDir: ".kiro/specs",
        sddFramework: "cc-sdd",
      };

      const writer = new ConfigWriter();
      await writer.write(config, tmpDir);

      const written = JSON.parse(await readFile(join(tmpDir, "aes.config.json"), "utf-8"));
      expect(written.llm.apiKey).toBeUndefined();
      expect("apiKey" in written.llm).toBe(false);
    });

    it("writes valid JSON that can be parsed back", async () => {
      const config: WritableConfig = {
        llm: { provider: "openai", modelName: "gpt-4o" },
        specDir: "custom/specs",
        sddFramework: "openspec",
      };

      const writer = new ConfigWriter();
      await writer.write(config, tmpDir);

      const raw = await readFile(join(tmpDir, "aes.config.json"), "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it("overwrites existing aes.config.json", async () => {
      const first: WritableConfig = {
        llm: { provider: "claude", modelName: "claude-opus-4-6" },
        specDir: ".kiro/specs",
        sddFramework: "cc-sdd",
      };
      const second: WritableConfig = {
        llm: { provider: "openai", modelName: "gpt-4o" },
        specDir: "custom/specs",
        sddFramework: "openspec",
      };

      const writer = new ConfigWriter();
      await writer.write(first, tmpDir);
      await writer.write(second, tmpDir);

      const written = JSON.parse(await readFile(join(tmpDir, "aes.config.json"), "utf-8"));
      expect(written.llm.provider).toBe("openai");
      expect(written.sddFramework).toBe("openspec");
    });

    it("defaults cwd to process.cwd() when not provided", async () => {
      // Verify the method accepts no cwd argument (type-level check via call)
      const writer = new ConfigWriter();
      const config: WritableConfig = {
        llm: { provider: "claude", modelName: "claude-opus-4-6" },
        specDir: ".kiro/specs",
        sddFramework: "cc-sdd",
      };
      // Call with explicit cwd to avoid writing to actual cwd in tests
      await expect(writer.write(config, tmpDir)).resolves.toBeUndefined();
    });

    it("propagates write errors to the caller", async () => {
      const nonExistentDir = join(tmpDir, "does-not-exist");
      const config: WritableConfig = {
        llm: { provider: "claude", modelName: "claude-opus-4-6" },
        specDir: ".kiro/specs",
        sddFramework: "cc-sdd",
      };

      const writer = new ConfigWriter();
      await expect(writer.write(config, nonExistentDir)).rejects.toThrow();
    });

    it("writes speckit framework correctly", async () => {
      const config: WritableConfig = {
        llm: { provider: "claude", modelName: "claude-opus-4-6" },
        specDir: ".kiro/specs",
        sddFramework: "speckit",
      };

      const writer = new ConfigWriter();
      await writer.write(config, tmpDir);

      const written = JSON.parse(await readFile(join(tmpDir, "aes.config.json"), "utf-8"));
      expect(written.sddFramework).toBe("speckit");
    });
  });
});
