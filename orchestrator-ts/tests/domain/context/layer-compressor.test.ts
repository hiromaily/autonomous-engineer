import { describe, expect, it } from "bun:test";
import type { CompressionResult } from "../../../src/application/ports/context";
import { LayerCompressor } from "../../../src/domain/context/layer-compressor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const compressor = new LayerCompressor();

/** Simple token counter: 1 token per 4 chars (matches fallback approximation). */
const charCounter = (text: string): number => Math.ceil(text.length / 4);

// ---------------------------------------------------------------------------
// Guard: systemInstructions and taskDescription
// ---------------------------------------------------------------------------

describe("LayerCompressor — guard layers", () => {
  it("returns original content unchanged for systemInstructions", () => {
    const content = "You are an AI assistant.\n".repeat(200);
    const result: CompressionResult = compressor.compress(
      "systemInstructions",
      content,
      10,
      charCounter,
    );
    expect(result.compressed).toBe(content);
    expect(result.originalTokenCount).toBe(charCounter(content));
    expect(result.tokenCount).toBe(charCounter(content));
  });

  it("returns original content unchanged for taskDescription", () => {
    const content = "Implement the feature described below.\n".repeat(200);
    const result: CompressionResult = compressor.compress(
      "taskDescription",
      content,
      10,
      charCounter,
    );
    expect(result.compressed).toBe(content);
    expect(result.originalTokenCount).toBe(charCounter(content));
    expect(result.tokenCount).toBe(charCounter(content));
  });
});

// ---------------------------------------------------------------------------
// Spec extraction (activeSpecification)
// ---------------------------------------------------------------------------

describe("LayerCompressor — spec_extraction (activeSpecification)", () => {
  const specContent = [
    "# Overview",
    "",
    "This section contains prose that should be removed.",
    "More prose that should be removed.",
    "",
    "## Requirements",
    "",
    "Here is more prose to remove.",
    "",
    "- [ ] Acceptance criterion 1",
    "- [x] Acceptance criterion 2 (done)",
    "- Another list item",
    "",
    "### Sub-section",
    "",
    "Paragraph prose to remove.",
    "",
    "#### Deep heading",
    "",
    "- Deep list item",
  ].join("\n");

  it("retains heading lines (# through ####)", () => {
    const result = compressor.compress("activeSpecification", specContent, 10000, charCounter);
    expect(result.compressed).toContain("# Overview");
    expect(result.compressed).toContain("## Requirements");
    expect(result.compressed).toContain("### Sub-section");
    expect(result.compressed).toContain("#### Deep heading");
  });

  it("retains list items (acceptance criteria)", () => {
    const result = compressor.compress("activeSpecification", specContent, 10000, charCounter);
    expect(result.compressed).toContain("- [ ] Acceptance criterion 1");
    expect(result.compressed).toContain("- [x] Acceptance criterion 2 (done)");
    expect(result.compressed).toContain("- Another list item");
    expect(result.compressed).toContain("- Deep list item");
  });

  it("removes prose paragraphs", () => {
    const result = compressor.compress("activeSpecification", specContent, 10000, charCounter);
    expect(result.compressed).not.toContain("This section contains prose that should be removed.");
    expect(result.compressed).not.toContain("Paragraph prose to remove.");
  });

  it("uses spec_extraction technique", () => {
    const result = compressor.compress("activeSpecification", specContent, 10000, charCounter);
    expect(result.technique).toBe("spec_extraction");
  });

  it("records originalTokenCount correctly", () => {
    const result = compressor.compress("activeSpecification", specContent, 10000, charCounter);
    expect(result.originalTokenCount).toBe(charCounter(specContent));
  });

  it("records final tokenCount matching the compressed content", () => {
    const result = compressor.compress("activeSpecification", specContent, 10000, charCounter);
    expect(result.tokenCount).toBe(charCounter(result.compressed));
  });
});

// ---------------------------------------------------------------------------
// Code skeleton extraction (codeContext)
// ---------------------------------------------------------------------------

describe("LayerCompressor — code_skeleton (codeContext)", () => {
  const codeContent = [
    "import { foo } from \"./foo\";",
    "",
    "export function greet(name: string): string {",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — simulating real code content string
    "  return `Hello, ${name}!`;",
    "}",
    "",
    "export class MyService {",
    "  private value: number;",
    "  constructor(v: number) { this.value = v; }",
    "  getValue(): number { return this.value; }",
    "}",
    "",
    "export interface IRepository {",
    "  findById(id: string): Promise<Entity>;",
    "}",
    "",
    "export type Result<T> = { ok: true; data: T } | { ok: false; error: string };",
    "",
    "export const MAX_RETRIES = 3;",
    "",
    "export abstract class BaseHandler {",
    "  abstract handle(): void;",
    "}",
    "",
    "function internalHelper() {",
    "  return \"not exported\";",
    "}",
  ].join("\n");

  it("retains export declaration lines", () => {
    const result = compressor.compress("codeContext", codeContent, 10000, charCounter);
    expect(result.compressed).toContain("export function greet(name: string): string {");
    expect(result.compressed).toContain("export class MyService {");
    expect(result.compressed).toContain("export interface IRepository {");
    expect(result.compressed).toContain(
      "export type Result<T> = { ok: true; data: T } | { ok: false; error: string };",
    );
    expect(result.compressed).toContain("export const MAX_RETRIES = 3;");
    expect(result.compressed).toContain("export abstract class BaseHandler {");
  });

  it("drops function bodies and non-exported declarations", () => {
    const result = compressor.compress("codeContext", codeContent, 10000, charCounter);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — asserting code bodies are stripped
    expect(result.compressed).not.toContain("return `Hello, ${name}!`;");
    expect(result.compressed).not.toContain("this.value = v;");
    expect(result.compressed).not.toContain("function internalHelper");
    expect(result.compressed).not.toContain("import { foo }");
  });

  it("uses code_skeleton technique", () => {
    const result = compressor.compress("codeContext", codeContent, 10000, charCounter);
    expect(result.technique).toBe("code_skeleton");
  });

  it("records originalTokenCount correctly", () => {
    const result = compressor.compress("codeContext", codeContent, 10000, charCounter);
    expect(result.originalTokenCount).toBe(charCounter(codeContent));
  });
});

// ---------------------------------------------------------------------------
// Memory score filter (memoryRetrieval)
// ---------------------------------------------------------------------------

describe("LayerCompressor — memory_score_filter (memoryRetrieval)", () => {
  const highScore = JSON.stringify({ relevanceScore: 0.9, content: "Highly relevant memory" });
  const borderScore = JSON.stringify({ relevanceScore: 0.3, content: "Exactly at threshold" });
  const lowScore = JSON.stringify({ relevanceScore: 0.29, content: "Low relevance memory" });
  const zeroScore = JSON.stringify({ relevanceScore: 0.0, content: "Zero relevance" });

  const memoryContent = [highScore, borderScore, lowScore, zeroScore].join("\n");

  it("retains entries with relevanceScore >= 0.3", () => {
    const result = compressor.compress("memoryRetrieval", memoryContent, 10000, charCounter);
    expect(result.compressed).toContain("Highly relevant memory");
    expect(result.compressed).toContain("Exactly at threshold");
  });

  it("drops entries with relevanceScore < 0.3", () => {
    const result = compressor.compress("memoryRetrieval", memoryContent, 10000, charCounter);
    expect(result.compressed).not.toContain("Low relevance memory");
    expect(result.compressed).not.toContain("Zero relevance");
  });

  it("uses memory_score_filter technique", () => {
    const result = compressor.compress("memoryRetrieval", memoryContent, 10000, charCounter);
    expect(result.technique).toBe("memory_score_filter");
  });

  it("handles malformed JSON lines gracefully by dropping them", () => {
    const withBad = ["not json", highScore].join("\n");
    const result = compressor.compress("memoryRetrieval", withBad, 10000, charCounter);
    expect(result.compressed).toContain("Highly relevant memory");
  });

  it("returns empty string when all entries are below threshold", () => {
    const allLow = [lowScore, zeroScore].join("\n");
    const result = compressor.compress("memoryRetrieval", allLow, 10000, charCounter);
    expect(result.compressed).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Truncation fallback
// ---------------------------------------------------------------------------

describe("LayerCompressor — truncation fallback", () => {
  it("applies truncation when extraction leaves content over budget (activeSpecification)", () => {
    // Build a spec with only headings so extraction keeps most content,
    // then set a tiny budget to force truncation.
    const manyHeadings = Array.from({ length: 100 }, (_, i) => `## Heading ${i}`).join("\n");
    const budget = 5; // very small → truncation kicks in
    const result = compressor.compress("activeSpecification", manyHeadings, budget, charCounter);
    // After truncation, content should be at most budget * 4 chars
    expect(result.compressed.length).toBeLessThanOrEqual(budget * 4);
    expect(result.technique).toBe("truncation");
  });

  it("applies truncation when extraction leaves content over budget (codeContext)", () => {
    const manyExports = Array.from(
      { length: 50 },
      (_, i) => `export const VAR_${i} = ${i};`,
    ).join("\n");
    const budget = 5;
    const result = compressor.compress("codeContext", manyExports, budget, charCounter);
    expect(result.compressed.length).toBeLessThanOrEqual(budget * 4);
    expect(result.technique).toBe("truncation");
  });

  it("does not truncate when extraction fits within budget", () => {
    const smallSpec = "## Title\n\n- List item\n";
    const budget = 10000;
    const result = compressor.compress("activeSpecification", smallSpec, budget, charCounter);
    expect(result.technique).toBe("spec_extraction");
  });
});

// ---------------------------------------------------------------------------
// repositoryState — uses truncation directly
// ---------------------------------------------------------------------------

describe("LayerCompressor — repositoryState (truncation)", () => {
  it("applies truncation when content exceeds budget", () => {
    const content = "Branch: main\n".repeat(200);
    const budget = 5;
    const result = compressor.compress("repositoryState", content, budget, charCounter);
    expect(result.compressed.length).toBeLessThanOrEqual(budget * 4);
    expect(result.technique).toBe("truncation");
  });

  it("returns content as-is when within budget", () => {
    const content = "Branch: main\nClean working tree\n";
    const budget = 10000;
    const result = compressor.compress("repositoryState", content, budget, charCounter);
    expect(result.compressed).toBe(content);
    expect(result.tokenCount).toBe(charCounter(content));
  });

  it("records originalTokenCount correctly", () => {
    const content = "Branch: main\nClean working tree\n";
    const budget = 10000;
    const result = compressor.compress("repositoryState", content, budget, charCounter);
    expect(result.originalTokenCount).toBe(charCounter(content));
  });
});
