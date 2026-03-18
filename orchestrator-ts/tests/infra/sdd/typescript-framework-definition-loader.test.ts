import { TypeScriptFrameworkDefinitionLoader } from "@/infra/sdd/typescript-framework-definition-loader";
import { describe, expect, it } from "bun:test";

describe("TypeScriptFrameworkDefinitionLoader", () => {
  const loader = new TypeScriptFrameworkDefinitionLoader();

  describe("load() — cc-sdd", () => {
    it("returns a validated FrameworkDefinition with exactly 14 phases", async () => {
      const def = await loader.load("cc-sdd");

      expect(def.id).toBe("cc-sdd");
      expect(def.phases).toHaveLength(14);
    });

    it("returns phases in the correct execution order", async () => {
      const def = await loader.load("cc-sdd");
      const phaseNames = def.phases.map((p) => p.phase);

      expect(phaseNames[0]).toBe("SPEC_INIT");
      expect(phaseNames[phaseNames.length - 1]).toBe("PULL_REQUEST");
    });
  });

  describe("load() — unknown framework", () => {
    it("throws with a message containing 'cc-sdd' in available frameworks list", async () => {
      await expect(loader.load("unknown-fw")).rejects.toThrow("cc-sdd");
    });

    it("throws with a descriptive error message", async () => {
      await expect(loader.load("unknown-fw")).rejects.toThrow("unknown-fw");
    });
  });
});
