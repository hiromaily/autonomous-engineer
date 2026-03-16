import { createConfigureDependencies } from "@/infra/bootstrap/create-configure-dependencies";
import { describe, expect, it } from "bun:test";

describe("createConfigureDependencies", () => {
  it("returns a configWriter with a write method", () => {
    const { configWriter } = createConfigureDependencies();
    expect(typeof configWriter.write).toBe("function");
  });

  it("returns a frameworkChecker with a check method", () => {
    const { frameworkChecker } = createConfigureDependencies();
    expect(typeof frameworkChecker.check).toBe("function");
  });
});
