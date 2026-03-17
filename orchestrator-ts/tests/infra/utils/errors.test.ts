import { getErrorMessage, isNodeError } from "@/infra/utils/errors";
import { describe, expect, it } from "bun:test";

describe("isNodeError", () => {
  it("returns true for an Error with a code property (errno exception)", () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    expect(isNodeError(err)).toBe(true);
  });

  it("returns false for a plain Error without a code property", () => {
    const err = new Error("plain error");
    expect(isNodeError(err)).toBe(false);
  });

  it("returns false for a non-Error value", () => {
    expect(isNodeError("string error")).toBe(false);
    expect(isNodeError(42)).toBe(false);
    expect(isNodeError(null)).toBe(false);
    expect(isNodeError(undefined)).toBe(false);
    expect(isNodeError({ code: "ENOENT" })).toBe(false);
  });

  it("narrows type correctly — code is accessible after guard", () => {
    const err: unknown = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    if (isNodeError(err)) {
      expect(err.code).toBe("ENOENT");
    } else {
      throw new Error("Expected isNodeError to return true");
    }
  });
});

describe("getErrorMessage", () => {
  it("returns err.message for Error instances", () => {
    const err = new Error("something went wrong");
    expect(getErrorMessage(err)).toBe("something went wrong");
  });

  it("returns String(err) for non-Error values", () => {
    expect(getErrorMessage("raw string")).toBe("raw string");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
    expect(getErrorMessage({ foo: "bar" })).toBe("[object Object]");
  });

  it("returns empty string for Error with empty message", () => {
    const err = new Error("");
    expect(getErrorMessage(err)).toBe("");
  });
});
