import { SddFrameworkChecker } from "@/infra/config/sdd-framework-checker";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SddFrameworkChecker", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-framework-checker-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("check() — cc-sdd", () => {
    it("returns installed:true when .kiro/ directory exists", async () => {
      await mkdir(join(tmpDir, ".kiro"));

      const checker = new SddFrameworkChecker();
      const result = await checker.check("cc-sdd", tmpDir);

      expect(result.installed).toBe(true);
    });

    it("returns installed:false with a hint when .kiro/ does not exist", async () => {
      const checker = new SddFrameworkChecker();
      const result = await checker.check("cc-sdd", tmpDir);

      expect(result.installed).toBe(false);
      if (!result.installed) {
        expect(typeof result.hint).toBe("string");
        expect(result.hint.length).toBeGreaterThan(0);
      }
    });

    it("hint for cc-sdd mentions cc-sdd installation", async () => {
      const checker = new SddFrameworkChecker();
      const result = await checker.check("cc-sdd", tmpDir);

      expect(result.installed).toBe(false);
      if (!result.installed) {
        expect(result.hint).toMatch(/cc-sdd/i);
      }
    });
  });

  describe("check() — openspec", () => {
    it("returns installed:true regardless of filesystem state", async () => {
      const checker = new SddFrameworkChecker();
      const result = await checker.check("openspec", tmpDir);

      expect(result.installed).toBe(true);
    });
  });

  describe("check() — speckit", () => {
    it("returns installed:true regardless of filesystem state", async () => {
      const checker = new SddFrameworkChecker();
      const result = await checker.check("speckit", tmpDir);

      expect(result.installed).toBe(true);
    });
  });

  describe("check() — default cwd", () => {
    it("accepts calls without explicit cwd argument", async () => {
      // This verifies the method signature accepts optional cwd
      // We don't assert the result since it depends on actual cwd
      const checker = new SddFrameworkChecker();
      const result = await checker.check("openspec");
      // openspec always returns installed:true, safe to assert
      expect(result.installed).toBe(true);
    });
  });
});
