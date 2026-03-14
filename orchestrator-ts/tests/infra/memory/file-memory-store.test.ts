import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry, MemoryTarget } from "../../../src/application/ports/memory";
import { FileMemoryStore } from "../../../src/infra/memory/file-memory-store";

// ---------------------------------------------------------------------------
// Task 3.1: Build path resolution, directory initialization, and Markdown
//           entry formatting
// ---------------------------------------------------------------------------

describe("FileMemoryStore - Task 3.1: Foundation", () => {
  let tmpDir: string;
  let store: FileMemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-memory-test-"));
    store = new FileMemoryStore({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  it("can be constructed with a custom baseDir", () => {
    expect(store).toBeInstanceOf(FileMemoryStore);
  });

  it("can be constructed without options (uses process.cwd())", () => {
    const defaultStore = new FileMemoryStore();
    expect(defaultStore).toBeInstanceOf(FileMemoryStore);
  });

  // -------------------------------------------------------------------------
  // shortTerm property
  // -------------------------------------------------------------------------

  it("exposes a shortTerm property with read/write/clear methods", () => {
    const st = store.shortTerm;
    expect(typeof st.read).toBe("function");
    expect(typeof st.write).toBe("function");
    expect(typeof st.clear).toBe("function");
  });

  it("shortTerm.read() returns the empty initial state", () => {
    const state = store.shortTerm.read();
    expect(state.recentFiles).toEqual([]);
    expect(state.currentSpec).toBeUndefined();
    expect(state.currentPhase).toBeUndefined();
    expect(state.taskProgress).toBeUndefined();
  });

  it("two FileMemoryStore instances have isolated shortTerm stores", () => {
    const storeA = new FileMemoryStore({ baseDir: tmpDir });
    const storeB = new FileMemoryStore({ baseDir: tmpDir });
    storeA.shortTerm.write({ currentSpec: "spec-a" });
    expect(storeB.shortTerm.read().currentSpec).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // query() returns empty when no files exist
  // -------------------------------------------------------------------------

  it("query() returns empty entries when no memory files exist", async () => {
    const result = await store.query({ text: "anything" });
    expect(result.entries).toHaveLength(0);
  });

  it("query() returns empty entries for project memory type when no files exist", async () => {
    const result = await store.query({ text: "test", memoryTypes: ["project"] });
    expect(result.entries).toHaveLength(0);
  });

  it("query() returns empty entries for knowledge memory type when no files exist", async () => {
    const result = await store.query({ text: "test", memoryTypes: ["knowledge"] });
    expect(result.entries).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Markdown parsing: parse pre-created project memory files
  // -------------------------------------------------------------------------

  it("query() parses entries from a pre-created project memory file", async () => {
    await mkdir(join(tmpDir, ".memory"), { recursive: true });
    const entryMd = [
      "## Test Entry",
      "",
      "- **Date**: 2026-03-11T00:00:00Z",
      "- **Context**: unit test",
      "",
      "This is the description.",
      "",
    ].join("\n");
    await writeFile(join(tmpDir, ".memory", "project_rules.md"), entryMd, "utf-8");

    const result = await store.query({ text: "test", memoryTypes: ["project"] });
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    const found = result.entries.find(e => e.entry.title === "Test Entry");
    expect(found).toBeDefined();
    expect(found?.entry.context).toBe("unit test");
    expect(found?.entry.date).toBe("2026-03-11T00:00:00Z");
    expect(found?.entry.description).toContain("This is the description.");
    expect(found?.sourceFile).toBe("project_rules");
  });

  // -------------------------------------------------------------------------
  // Markdown parsing: parse pre-created knowledge memory files
  // -------------------------------------------------------------------------

  it("query() parses entries from a pre-created knowledge memory file", async () => {
    await mkdir(join(tmpDir, "rules"), { recursive: true });
    const entryMd = [
      "## Coding Rule",
      "",
      "- **Date**: 2026-03-11T00:00:00Z",
      "- **Context**: tdd",
      "",
      "Always write tests first.",
      "",
    ].join("\n");
    await writeFile(join(tmpDir, "rules", "coding_rules.md"), entryMd, "utf-8");

    const result = await store.query({ text: "coding", memoryTypes: ["knowledge"] });
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    const found = result.entries.find(e => e.entry.title === "Coding Rule");
    expect(found).toBeDefined();
    expect(found?.sourceFile).toBe("coding_rules");
  });

  // -------------------------------------------------------------------------
  // Markdown parsing: multiple entries separated by ---
  // -------------------------------------------------------------------------

  it("query() handles files with multiple entries separated by ---", async () => {
    await mkdir(join(tmpDir, ".memory"), { recursive: true });
    const multiEntryMd = [
      "## Entry One",
      "",
      "- **Date**: 2026-03-11T00:00:00Z",
      "- **Context**: context-a",
      "",
      "Description one.",
      "",
      "---",
      "",
      "## Entry Two",
      "",
      "- **Date**: 2026-03-11T01:00:00Z",
      "- **Context**: context-b",
      "",
      "Description two.",
      "",
    ].join("\n");
    await writeFile(join(tmpDir, ".memory", "coding_patterns.md"), multiEntryMd, "utf-8");

    const result = await store.query({ text: "entry", memoryTypes: ["project"] });
    expect(result.entries.length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Markdown parsing: empty or missing file
  // -------------------------------------------------------------------------

  it("query() returns empty list (not error) when file contains no parseable entries", async () => {
    await mkdir(join(tmpDir, ".memory"), { recursive: true });
    await writeFile(join(tmpDir, ".memory", "project_rules.md"), "", "utf-8");
    const result = await store.query({ text: "anything" });
    expect(result.entries).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // sourceFile metadata
  // -------------------------------------------------------------------------

  it("query() sourceFile matches the memory file name without extension", async () => {
    await mkdir(join(tmpDir, ".memory"), { recursive: true });
    const entryMd = [
      "## My Entry",
      "",
      "- **Date**: 2026-01-01T00:00:00Z",
      "- **Context**: ctx",
      "",
      "Body text.",
      "",
    ].join("\n");
    await writeFile(join(tmpDir, ".memory", "review_feedback.md"), entryMd, "utf-8");

    const result = await store.query({ text: "my", memoryTypes: ["project"] });
    const found = result.entries.find(e => e.entry.title === "My Entry");
    expect(found?.sourceFile).toBe("review_feedback");
  });

  // -------------------------------------------------------------------------
  // relevanceScore is within [0, 1]
  // -------------------------------------------------------------------------

  it("query() returns relevanceScore values in [0, 1] range", async () => {
    await mkdir(join(tmpDir, ".memory"), { recursive: true });
    const entryMd = [
      "## Pattern Match",
      "",
      "- **Date**: 2026-01-01T00:00:00Z",
      "- **Context**: pattern matching context",
      "",
      "Description with pattern keyword.",
      "",
    ].join("\n");
    await writeFile(join(tmpDir, ".memory", "coding_patterns.md"), entryMd, "utf-8");

    const result = await store.query({ text: "pattern", memoryTypes: ["project"] });
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    for (const ranked of result.entries) {
      expect(ranked.relevanceScore).toBeGreaterThanOrEqual(0);
      expect(ranked.relevanceScore).toBeLessThanOrEqual(1);
    }
  });

  // -------------------------------------------------------------------------
  // memoryTypes filter restricts scanned files
  // -------------------------------------------------------------------------

  it("query() with memoryTypes=project does not scan knowledge files", async () => {
    // Put an entry only in a knowledge file
    await mkdir(join(tmpDir, "rules"), { recursive: true });
    const knowledgeEntry = [
      "## Knowledge Only",
      "",
      "- **Date**: 2026-01-01T00:00:00Z",
      "- **Context**: knowledge",
      "",
      "Knowledge description.",
      "",
    ].join("\n");
    await writeFile(join(tmpDir, "rules", "coding_rules.md"), knowledgeEntry, "utf-8");

    // Query only project files — should not find the knowledge entry
    const result = await store.query({ text: "knowledge", memoryTypes: ["project"] });
    expect(result.entries.find(e => e.entry.title === "Knowledge Only")).toBeUndefined();
  });

  it("query() with memoryTypes=knowledge does not scan project files", async () => {
    await mkdir(join(tmpDir, ".memory"), { recursive: true });
    const projectEntry = [
      "## Project Only",
      "",
      "- **Date**: 2026-01-01T00:00:00Z",
      "- **Context**: project",
      "",
      "Project description.",
      "",
    ].join("\n");
    await writeFile(join(tmpDir, ".memory", "project_rules.md"), projectEntry, "utf-8");

    // Query only knowledge files — should not find the project entry
    const result = await store.query({ text: "project", memoryTypes: ["knowledge"] });
    expect(result.entries.find(e => e.entry.title === "Project Only")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // topN limit
  // -------------------------------------------------------------------------

  it("query() respects topN limit", async () => {
    await mkdir(join(tmpDir, ".memory"), { recursive: true });
    const entries = Array.from({ length: 5 }, (_, i) =>
      [
        `## Entry ${i}`,
        "",
        `- **Date**: 2026-01-0${i + 1}T00:00:00Z`,
        "- **Context**: context",
        "",
        `Description for entry ${i} with keyword.`,
        "",
        "---",
        "",
      ].join("\n")).join("");
    await writeFile(join(tmpDir, ".memory", "project_rules.md"), entries, "utf-8");

    const result = await store.query({ text: "keyword", memoryTypes: ["project"], topN: 2 });
    expect(result.entries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Task 3.2: Implement append with entry validation, deduplication, and atomic
//           write
// ---------------------------------------------------------------------------

describe("FileMemoryStore - Task 3.2: append()", () => {
  let tmpDir: string;
  let store: FileMemoryStore;

  const projectTarget: MemoryTarget = { type: "project", file: "project_rules" };
  const knowledgeTarget: MemoryTarget = { type: "knowledge", file: "coding_rules" };

  const makeEntry = (title: string, override?: Partial<MemoryEntry>): MemoryEntry => ({
    title,
    context: "test context",
    description: "Test description.",
    date: "2026-03-11T00:00:00Z",
    ...override,
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-memory-append-"));
    store = new FileMemoryStore({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Validation: blank title
  // -------------------------------------------------------------------------

  it("returns invalid_entry error when title is blank", async () => {
    const result = await store.append(projectTarget, makeEntry(""), "implementation_pattern");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("invalid_entry");
    }
  });

  it("returns invalid_entry error when title is only whitespace", async () => {
    const result = await store.append(projectTarget, makeEntry("   "), "implementation_pattern");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("invalid_entry");
    }
  });

  it("does not create any files when title is blank", async () => {
    await store.append(projectTarget, makeEntry(""), "implementation_pattern");
    await expect(access(join(tmpDir, ".memory"))).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Happy path: new entry written to project memory
  // -------------------------------------------------------------------------

  it("returns appended on success", async () => {
    const result = await store.append(projectTarget, makeEntry("My Rule"), "implementation_pattern");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("appended");
    }
  });

  it("creates the .memory/ directory if it does not exist", async () => {
    await store.append(projectTarget, makeEntry("My Rule"), "implementation_pattern");
    // access() throws ENOENT if path doesn't exist; awaiting without throw confirms creation
    await access(join(tmpDir, ".memory"));
  });

  it("writes the formatted entry to the target file", async () => {
    await store.append(projectTarget, makeEntry("My Rule"), "implementation_pattern");
    const content = await readFile(join(tmpDir, ".memory", "project_rules.md"), "utf-8");
    expect(content).toContain("## My Rule");
    expect(content).toContain("2026-03-11T00:00:00Z");
    expect(content).toContain("test context");
    expect(content).toContain("Test description.");
  });

  // -------------------------------------------------------------------------
  // Happy path: new entry written to knowledge memory
  // -------------------------------------------------------------------------

  it("creates the rules/ directory for knowledge memory targets", async () => {
    await store.append(knowledgeTarget, makeEntry("Coding Rule"), "implementation_pattern");
    await access(join(tmpDir, "rules"));
  });

  it("writes entry to the correct knowledge memory file path", async () => {
    await store.append(knowledgeTarget, makeEntry("Coding Rule"), "implementation_pattern");
    const content = await readFile(join(tmpDir, "rules", "coding_rules.md"), "utf-8");
    expect(content).toContain("## Coding Rule");
  });

  // -------------------------------------------------------------------------
  // Deduplication: case-insensitive title match
  // -------------------------------------------------------------------------

  it("returns skipped_duplicate when entry with same title already exists", async () => {
    await store.append(projectTarget, makeEntry("Duplicate"), "implementation_pattern");
    const result = await store.append(projectTarget, makeEntry("Duplicate"), "implementation_pattern");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("skipped_duplicate");
    }
  });

  it("deduplication is case-insensitive", async () => {
    await store.append(projectTarget, makeEntry("My Rule"), "implementation_pattern");
    const result = await store.append(projectTarget, makeEntry("MY RULE"), "implementation_pattern");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("skipped_duplicate");
    }
  });

  it("does not modify the file when skipping a duplicate", async () => {
    await store.append(projectTarget, makeEntry("Stable Entry"), "implementation_pattern");
    const before = await readFile(join(tmpDir, ".memory", "project_rules.md"), "utf-8");
    await store.append(projectTarget, makeEntry("stable entry"), "implementation_pattern");
    const after = await readFile(join(tmpDir, ".memory", "project_rules.md"), "utf-8");
    expect(before).toBe(after);
  });

  // -------------------------------------------------------------------------
  // Multiple appends: entries accumulated correctly
  // -------------------------------------------------------------------------

  it("appends multiple entries to the same file", async () => {
    await store.append(projectTarget, makeEntry("Entry A"), "implementation_pattern");
    await store.append(projectTarget, makeEntry("Entry B"), "implementation_pattern");
    const content = await readFile(join(tmpDir, ".memory", "project_rules.md"), "utf-8");
    expect(content).toContain("## Entry A");
    expect(content).toContain("## Entry B");
  });

  it("existing entries are preserved when a new entry is appended", async () => {
    await store.append(projectTarget, makeEntry("First"), "implementation_pattern");
    await store.append(projectTarget, makeEntry("Second"), "implementation_pattern");
    const result = await store.query({ text: "first second", memoryTypes: ["project"] });
    const titles = result.entries.map(e => e.entry.title);
    expect(titles).toContain("First");
    expect(titles).toContain("Second");
  });

  it("separates entries with --- in the file", async () => {
    await store.append(projectTarget, makeEntry("Entry A"), "implementation_pattern");
    await store.append(projectTarget, makeEntry("Entry B"), "implementation_pattern");
    const content = await readFile(join(tmpDir, ".memory", "project_rules.md"), "utf-8");
    expect(content).toContain("---");
  });

  // -------------------------------------------------------------------------
  // Atomic write: no .tmp file left behind after success
  // -------------------------------------------------------------------------

  it("does not leave a .tmp file after successful append", async () => {
    await store.append(projectTarget, makeEntry("Atomic Entry"), "implementation_pattern");
    await expect(
      access(join(tmpDir, ".memory", "project_rules.md.tmp")),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 3.3: Implement in-place entry update for the self-healing rule path
// ---------------------------------------------------------------------------

describe("FileMemoryStore - Task 3.3: update()", () => {
  let tmpDir: string;
  let store: FileMemoryStore;

  const target: MemoryTarget = { type: "knowledge", file: "coding_rules" };

  const makeEntry = (title: string, override?: Partial<MemoryEntry>): MemoryEntry => ({
    title,
    context: "original context",
    description: "Original description.",
    date: "2026-03-11T00:00:00Z",
    ...override,
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-memory-update-"));
    store = new FileMemoryStore({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // not_found: entry title absent
  // -------------------------------------------------------------------------

  it("returns not_found error when entry title does not exist in file", async () => {
    // Append one entry first
    await store.append(target, makeEntry("Existing Entry"), "self_healing");
    const result = await store.update(target, "NonExistent Title", makeEntry("NonExistent Title"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("not_found");
    }
  });

  it("returns not_found error when file does not exist at all", async () => {
    const result = await store.update(target, "Any Title", makeEntry("Any Title"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("not_found");
    }
  });

  // -------------------------------------------------------------------------
  // Happy path: entry replaced in-place
  // -------------------------------------------------------------------------

  it("returns updated action on success", async () => {
    await store.append(target, makeEntry("Target Entry"), "self_healing");
    const updated = makeEntry("Target Entry", {
      description: "Updated description.",
      context: "updated context",
    });
    const result = await store.update(target, "Target Entry", updated);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("updated");
    }
  });

  it("replaces the matched entry content in the file", async () => {
    await store.append(target, makeEntry("Target Entry"), "self_healing");
    const updated = makeEntry("Target Entry", { description: "Brand new description." });
    await store.update(target, "Target Entry", updated);
    const content = await readFile(join(tmpDir, "rules", "coding_rules.md"), "utf-8");
    expect(content).toContain("Brand new description.");
    expect(content).not.toContain("Original description.");
  });

  // -------------------------------------------------------------------------
  // Case-insensitive title match
  // -------------------------------------------------------------------------

  it("matches the entry title case-insensitively", async () => {
    await store.append(target, makeEntry("My Rule"), "self_healing");
    const result = await store.update(
      target,
      "MY RULE",
      makeEntry("MY RULE", {
        description: "Updated via case-insensitive match.",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("updated");
    }
  });

  // -------------------------------------------------------------------------
  // Other entries preserved
  // -------------------------------------------------------------------------

  it("preserves other entries when updating one", async () => {
    await store.append(target, makeEntry("Entry A"), "self_healing");
    await store.append(target, makeEntry("Entry B"), "self_healing");
    await store.append(target, makeEntry("Entry C"), "self_healing");

    await store.update(
      target,
      "Entry B",
      makeEntry("Entry B", {
        description: "B was updated.",
      }),
    );

    // All three headings present; only Entry B has the updated description
    const entries = store.parseEntries(
      await readFile(join(tmpDir, "rules", "coding_rules.md"), "utf-8"),
    );
    expect(entries).toHaveLength(3);
    expect(entries.find(e => e.title === "Entry A")?.description).toBe("Original description.");
    expect(entries.find(e => e.title === "Entry B")?.description).toBe("B was updated.");
    expect(entries.find(e => e.title === "Entry C")?.description).toBe("Original description.");
  });

  it("preserves entry order after update", async () => {
    await store.append(target, makeEntry("Alpha"), "self_healing");
    await store.append(target, makeEntry("Beta"), "self_healing");

    await store.update(target, "Alpha", makeEntry("Alpha", { description: "Alpha updated." }));

    const entries = store.parseEntries(
      await readFile(join(tmpDir, "rules", "coding_rules.md"), "utf-8"),
    );
    expect(entries[0]?.title).toBe("Alpha");
    expect(entries[1]?.title).toBe("Beta");
  });

  it("updated entry is parseable and has correct field values", async () => {
    await store.append(target, makeEntry("Rule X"), "self_healing");
    const updatedEntry: MemoryEntry = {
      title: "Rule X",
      context: "new context",
      description: "New description for X.",
      date: "2026-04-01T00:00:00Z",
    };
    await store.update(target, "Rule X", updatedEntry);

    const entries = store.parseEntries(
      await readFile(join(tmpDir, "rules", "coding_rules.md"), "utf-8"),
    );
    const found = entries.find(e => e.title === "Rule X");
    expect(found?.context).toBe("new context");
    expect(found?.description).toBe("New description for X.");
    expect(found?.date).toBe("2026-04-01T00:00:00Z");
  });

  // -------------------------------------------------------------------------
  // Atomic write: no .tmp file left behind
  // -------------------------------------------------------------------------

  it("does not leave a .tmp file after successful update", async () => {
    await store.append(target, makeEntry("Clean Entry"), "self_healing");
    await store.update(
      target,
      "Clean Entry",
      makeEntry("Clean Entry", {
        description: "Updated.",
      }),
    );
    await expect(
      access(join(tmpDir, "rules", "coding_rules.md.tmp")),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Single-entry file: update works correctly
  // -------------------------------------------------------------------------

  it("handles update when file contains only one entry", async () => {
    await store.append(target, makeEntry("Solo Entry"), "self_healing");
    const result = await store.update(
      target,
      "Solo Entry",
      makeEntry("Solo Entry", {
        description: "Solo updated.",
      }),
    );
    expect(result.ok).toBe(true);
    const content = await readFile(join(tmpDir, "rules", "coding_rules.md"), "utf-8");
    expect(content).toContain("Solo updated.");
    expect(content).not.toContain("Original description.");
  });
});

// ---------------------------------------------------------------------------
// Task 3.4: Implement failure record persistence and filtered retrieval
// ---------------------------------------------------------------------------

describe("FileMemoryStore - Task 3.4: writeFailure() and getFailures()", () => {
  let tmpDir: string;
  let store: FileMemoryStore;

  const makeRecord = (
    override?: Partial<import("../../../src/application/ports/memory").FailureRecord>,
  ): import("../../../src/application/ports/memory").FailureRecord => ({
    taskId: "task-1",
    specName: "memory-system",
    phase: "IMPLEMENTATION",
    attempted: "Write file A",
    errors: ["ENOENT: file not found"],
    rootCause: "Directory did not exist",
    timestamp: new Date().toISOString(),
    ...override,
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-memory-failure-"));
    store = new FileMemoryStore({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // writeFailure(): happy path
  // -------------------------------------------------------------------------

  it("returns appended on successful writeFailure", async () => {
    const result = await store.writeFailure(makeRecord());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("appended");
    }
  });

  it("creates the .memory/failures/ directory if absent", async () => {
    await store.writeFailure(makeRecord());
    await access(join(tmpDir, ".memory", "failures"));
  });

  it("writes a JSON file into .memory/failures/", async () => {
    const record = makeRecord({ taskId: "task-x", specName: "my-spec" });
    await store.writeFailure(record);
    const files = await readdir(join(tmpDir, ".memory", "failures"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const jsonFile = files.find(f => f.endsWith(".json"));
    expect(jsonFile).toBeDefined();
  });

  it("filename includes the task ID", async () => {
    const record = makeRecord({ taskId: "my-task" });
    await store.writeFailure(record);
    const files = await readdir(join(tmpDir, ".memory", "failures"));
    const match = files.find(f => f.includes("my-task"));
    expect(match).toBeDefined();
  });

  it("written JSON is parseable and contains correct fields", async () => {
    const record = makeRecord({ taskId: "parse-test", specName: "spec-x" });
    await store.writeFailure(record);
    const files = await readdir(join(tmpDir, ".memory", "failures"));
    const jsonFile = files.find(f => f.endsWith(".json")) ?? "";
    const raw = await readFile(join(tmpDir, ".memory", "failures", jsonFile), "utf-8");
    const parsed = JSON.parse(raw) as typeof record;
    expect(parsed.taskId).toBe("parse-test");
    expect(parsed.specName).toBe("spec-x");
    expect(parsed.phase).toBe("IMPLEMENTATION");
    expect(parsed.errors).toEqual(["ENOENT: file not found"]);
  });

  it("does not leave a .tmp file after successful writeFailure", async () => {
    const record = makeRecord({ taskId: "atomic-task" });
    await store.writeFailure(record);
    const files = await readdir(join(tmpDir, ".memory", "failures"));
    const tmpFiles = files.filter(f => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // writeFailure(): IO error returns failure result without throwing
  // -------------------------------------------------------------------------

  it("returns failure result without throwing when IO error occurs during write", async () => {
    // Place a FILE at the failures path so mkdir fails with ENOTDIR
    await mkdir(join(tmpDir, ".memory"), { recursive: true });
    await writeFile(join(tmpDir, ".memory", "failures"), "not a directory", "utf-8");

    const record = makeRecord({ taskId: "io-error-task" });
    // Must not throw — should return ok:false with io_error category
    const result = await store.writeFailure(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("io_error");
    }
  });

  // -------------------------------------------------------------------------
  // writeFailure(): multiple records accumulate independently
  // -------------------------------------------------------------------------

  it("multiple writeFailure calls create separate files", async () => {
    await store.writeFailure(makeRecord({ taskId: "task-a" }));
    // Small delay to ensure distinct timestamps in filenames
    await new Promise(r => setTimeout(r, 5));
    await store.writeFailure(makeRecord({ taskId: "task-b" }));
    const files = await readdir(join(tmpDir, ".memory", "failures"));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // getFailures(): missing directory → empty list
  // -------------------------------------------------------------------------

  it("getFailures() returns empty list when .memory/failures/ does not exist", async () => {
    const result = await store.getFailures();
    expect(result).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // getFailures(): retrieves written records
  // -------------------------------------------------------------------------

  it("getFailures() returns all written records when no filter is applied", async () => {
    await store.writeFailure(makeRecord({ taskId: "task-1", specName: "spec-a" }));
    await new Promise(r => setTimeout(r, 5));
    await store.writeFailure(makeRecord({ taskId: "task-2", specName: "spec-b" }));
    const records = await store.getFailures();
    expect(records.length).toBeGreaterThanOrEqual(2);
  });

  it("getFailures() returns records with correct field values", async () => {
    const record = makeRecord({ taskId: "verify-task", rootCause: "test root cause" });
    await store.writeFailure(record);
    const records = await store.getFailures();
    const found = records.find(r => r.taskId === "verify-task");
    expect(found).toBeDefined();
    expect(found?.rootCause).toBe("test root cause");
    expect(found?.specName).toBe("memory-system");
  });

  // -------------------------------------------------------------------------
  // getFailures(): filter by specName
  // -------------------------------------------------------------------------

  it("getFailures() filters by specName", async () => {
    await store.writeFailure(makeRecord({ specName: "spec-a", taskId: "t1" }));
    await new Promise(r => setTimeout(r, 5));
    await store.writeFailure(makeRecord({ specName: "spec-b", taskId: "t2" }));
    const records = await store.getFailures({ specName: "spec-a" });
    expect(records.every(r => r.specName === "spec-a")).toBe(true);
    expect(records.find(r => r.specName === "spec-b")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // getFailures(): filter by taskId
  // -------------------------------------------------------------------------

  it("getFailures() filters by taskId", async () => {
    await store.writeFailure(makeRecord({ taskId: "target-task", specName: "spec-a" }));
    await new Promise(r => setTimeout(r, 5));
    await store.writeFailure(makeRecord({ taskId: "other-task", specName: "spec-a" }));
    const records = await store.getFailures({ taskId: "target-task" });
    expect(records.every(r => r.taskId === "target-task")).toBe(true);
    expect(records.find(r => r.taskId === "other-task")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // getFailures(): filter by both specName and taskId
  // -------------------------------------------------------------------------

  it("getFailures() filters by both specName and taskId", async () => {
    await store.writeFailure(makeRecord({ specName: "spec-a", taskId: "task-1" }));
    await new Promise(r => setTimeout(r, 5));
    await store.writeFailure(makeRecord({ specName: "spec-a", taskId: "task-2" }));
    await new Promise(r => setTimeout(r, 5));
    await store.writeFailure(makeRecord({ specName: "spec-b", taskId: "task-1" }));
    const records = await store.getFailures({ specName: "spec-a", taskId: "task-1" });
    expect(records).toHaveLength(1);
    expect(records[0]?.specName).toBe("spec-a");
    expect(records[0]?.taskId).toBe("task-1");
  });
});

// ---------------------------------------------------------------------------
// Task 3.5: Keyword-based query with relevance scoring and type filtering
// (query() foundation built in 3.1; this suite validates scoring & ranking)
// ---------------------------------------------------------------------------

describe("FileMemoryStore - Task 3.5: query() scoring and ranking", () => {
  let tmpDir: string;
  let store: FileMemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-memory-query-"));
    store = new FileMemoryStore({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const writeProjectFile = async (
    filename: string,
    content: string,
  ): Promise<void> => {
    await mkdir(join(tmpDir, ".memory"), { recursive: true });
    await writeFile(join(tmpDir, ".memory", filename), content, "utf-8");
  };

  const buildEntry = (title: string, description: string, context = "ctx"): string =>
    [`## ${title}`, "", `- **Date**: 2026-01-01T00:00:00Z`, `- **Context**: ${context}`, "", description, ""].join(
      "\n",
    );

  // -------------------------------------------------------------------------
  // Scoring: more occurrences → higher rank
  // -------------------------------------------------------------------------

  it("entry with more keyword occurrences ranks higher", async () => {
    const content = [
      buildEntry("Low Match", "One occurrence of pattern here."),
      "---",
      buildEntry("High Match", "Pattern appears again: pattern and pattern makes three."),
    ].join("\n");
    await writeProjectFile("project_rules.md", content);

    const result = await store.query({ text: "pattern", memoryTypes: ["project"] });
    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    const [first, second] = result.entries;
    expect(first?.entry.title).toBe("High Match");
    expect(first?.relevanceScore ?? 0).toBeGreaterThan(second?.relevanceScore ?? 0);
  });

  // -------------------------------------------------------------------------
  // Normalization: top-ranked entry has relevanceScore = 1.0
  // -------------------------------------------------------------------------

  it("top-ranked entry has relevanceScore of 1.0", async () => {
    const content = [
      buildEntry("Frequent", "keyword keyword keyword"),
      "---",
      buildEntry("Infrequent", "keyword"),
    ].join("\n");
    await writeProjectFile("coding_patterns.md", content);

    const result = await store.query({ text: "keyword", memoryTypes: ["project"] });
    expect(result.entries[0]?.relevanceScore).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Multi-token queries: each token scored independently
  // -------------------------------------------------------------------------

  it("multi-token query scores each token independently", async () => {
    const content = [
      buildEntry("Both Words", "contains alpha and also beta"),
      "---",
      buildEntry("One Word Only", "contains only alpha here"),
    ].join("\n");
    await writeProjectFile("project_rules.md", content);

    const result = await store.query({ text: "alpha beta", memoryTypes: ["project"] });
    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    const both = result.entries.find(e => e.entry.title === "Both Words");
    const one = result.entries.find(e => e.entry.title === "One Word Only");
    expect(both?.relevanceScore ?? 0).toBeGreaterThan(one?.relevanceScore ?? 0);
  });

  // -------------------------------------------------------------------------
  // Zero-match entries excluded
  // -------------------------------------------------------------------------

  it("entries with zero keyword matches are excluded", async () => {
    const content = [
      buildEntry("Matching Entry", "contains the searchword"),
      "---",
      buildEntry("No Match Entry", "completely unrelated content here"),
    ].join("\n");
    await writeProjectFile("project_rules.md", content);

    const result = await store.query({ text: "searchword", memoryTypes: ["project"] });
    expect(result.entries.every(e => e.entry.title !== "No Match Entry")).toBe(true);
    expect(result.entries.find(e => e.entry.title === "Matching Entry")).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Default topN is 5
  // -------------------------------------------------------------------------

  it("default topN is 5 when not specified", async () => {
    const entries = Array.from(
      { length: 8 },
      (_, i) => buildEntry(`Entry ${i}`, `keyword appears ${i + 1} times: ${"keyword ".repeat(i + 1).trim()}`),
    ).join("\n---\n");
    await writeProjectFile("project_rules.md", entries);

    const result = await store.query({ text: "keyword", memoryTypes: ["project"] });
    expect(result.entries.length).toBeLessThanOrEqual(5);
  });

  // -------------------------------------------------------------------------
  // Scores are within [0, 1] range
  // -------------------------------------------------------------------------

  it("all returned relevanceScores are in [0, 1] range", async () => {
    const content = [
      buildEntry("A", "alpha beta gamma"),
      "---",
      buildEntry("B", "alpha delta"),
      "---",
      buildEntry("C", "alpha alpha alpha"),
    ].join("\n");
    await writeProjectFile("project_rules.md", content);

    const result = await store.query({ text: "alpha", memoryTypes: ["project"] });
    for (const ranked of result.entries) {
      expect(ranked.relevanceScore).toBeGreaterThanOrEqual(0);
      expect(ranked.relevanceScore).toBeLessThanOrEqual(1);
    }
  });

  // -------------------------------------------------------------------------
  // Source file annotation
  // -------------------------------------------------------------------------

  it("each result is annotated with the correct sourceFile name", async () => {
    await writeProjectFile(
      "review_feedback.md",
      buildEntry("Feedback Entry", "relevant feedback content"),
    );

    const result = await store.query({ text: "relevant", memoryTypes: ["project"] });
    const found = result.entries.find(e => e.entry.title === "Feedback Entry");
    expect(found?.sourceFile).toBe("review_feedback");
  });

  // -------------------------------------------------------------------------
  // Empty result (not error) when nothing matches
  // -------------------------------------------------------------------------

  it("returns empty list (not error) when no entries match the query", async () => {
    await writeProjectFile(
      "project_rules.md",
      buildEntry("Unrelated Entry", "completely different content"),
    );

    const result = await store.query({ text: "xyzzy-nonexistent", memoryTypes: ["project"] });
    expect(result.entries).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Both project and knowledge files scanned when memoryTypes omitted
  // -------------------------------------------------------------------------

  it("scans both project and knowledge files when memoryTypes is omitted", async () => {
    await writeProjectFile("project_rules.md", buildEntry("Project Entry", "unique project content"));
    await mkdir(join(tmpDir, "rules"), { recursive: true });
    await writeFile(
      join(tmpDir, "rules", "coding_rules.md"),
      buildEntry("Knowledge Entry", "unique knowledge content"),
      "utf-8",
    );

    const result = await store.query({ text: "unique" });
    const titles = result.entries.map(e => e.entry.title);
    expect(titles).toContain("Project Entry");
    expect(titles).toContain("Knowledge Entry");
  });
});
