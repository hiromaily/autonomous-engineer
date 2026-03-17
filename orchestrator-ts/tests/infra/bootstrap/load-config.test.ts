import { ConfigLoader } from "@/infra/config/config-loader";
import { describe, expect, it } from "bun:test";

describe("ConfigLoader", () => {
  it("has a load method", () => {
    const loader = new ConfigLoader();
    expect(typeof loader.load).toBe("function");
  });
});
