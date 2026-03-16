import { ConfigLoader } from "@/infra/bootstrap/load-config";
import { describe, expect, it } from "bun:test";

describe("bootstrap load-config re-export", () => {
  it("exports ConfigLoader with a load method", () => {
    const loader = new ConfigLoader();
    expect(typeof loader.load).toBe("function");
  });
});
