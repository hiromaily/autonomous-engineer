import { describe, expect, it } from "bun:test";
import { getEncoding, Tiktoken } from "js-tiktoken";

describe("js-tiktoken smoke test", () => {
  it("imports Tiktoken class from js-tiktoken", () => {
    expect(Tiktoken).toBeDefined();
  });

  it("initializes cl100k_base encoder synchronously via getEncoding", () => {
    const encoder = getEncoding("cl100k_base");
    expect(encoder).toBeDefined();
    expect(encoder).toBeInstanceOf(Tiktoken);
  });

  it("encodes a known string and returns correct token count", () => {
    const encoder = getEncoding("cl100k_base");
    const tokens = encoder.encode("hello world");
    // "hello world" encodes to 2 tokens in cl100k_base
    expect(tokens.length).toBe(2);
  });

  it("encodes empty string to zero tokens", () => {
    const encoder = getEncoding("cl100k_base");
    const tokens = encoder.encode("");
    expect(tokens.length).toBe(0);
  });
});
