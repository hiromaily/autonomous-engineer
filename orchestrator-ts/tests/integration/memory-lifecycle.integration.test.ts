/**
 * Integration tests for the memory system lifecycle.
 *
 * Task 6.1: End-to-end memory operations with a real temp directory.
 * Task 6.2: RunSpecUseCase with FileMemoryStore injected.
 *
 * Uses real FileMemoryStore (file I/O) against a temp directory.
 * No mocks for memory — exercises the full persistent memory path.
 */
import type { AesConfig } from "@/application/ports/config";
import type { LlmProviderPort } from "@/application/ports/llm";
import type { MemoryEntry, MemoryTarget, ShortTermMemoryPort } from "@/application/ports/memory";
import type { SddFrameworkPort } from "@/application/ports/sdd";
import type { IWorkflowEventBus, IWorkflowStateStore } from "@/application/ports/workflow";
import { RunSpecUseCase } from "@/application/usecases/run-spec";
import type { WorkflowState } from "@/domain/workflow/types";
import { FileMemoryStore } from "@/infra/memory/file-memory-store";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function makeStateStore(overrides?: Partial<IWorkflowStateStore>): IWorkflowStateStore {
  const defaultState: WorkflowState = {
    specName: "test-spec",
    currentPhase: "SPEC_INIT",
    completedPhases: [],
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    init: mock(() => defaultState),
    persist: mock(() => Promise.resolve()),
    restore: mock(() => Promise.resolve(null)),
    ...overrides,
  };
}

function makeEventBus(): IWorkflowEventBus {
  return {
    emit: mock(() => {}),
    on: mock(() => {}),
    off: mock(() => {}),
  };
}

function makeSdd(): SddFrameworkPort {
  return {
    validatePrerequisites: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    generateRequirements: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    validateRequirements: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    reflectBeforeDesign: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    reflectBeforeTasks: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    validateGap: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    generateDesign: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    validateDesign: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    generateTasks: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
    validateTasks: mock(() => Promise.resolve({ ok: true as const, artifactPath: "" })),
  };
}

function makeLlm(): LlmProviderPort {
  return {
    complete: mock(() =>
      Promise.resolve({ ok: true as const, value: { content: "", usage: { inputTokens: 0, outputTokens: 0 } } })
    ),
    clearContext: mock(() => {}),
  };
}

const baseConfig: AesConfig = {
  llm: { provider: "claude", modelName: "claude-sonnet-4-6", apiKey: "test-key" },
  specDir: "/tmp/specs",
  sddFramework: "cc-sdd",
};

const projectTarget: MemoryTarget = { type: "project", file: "project_rules" };
const knowledgeTarget: MemoryTarget = { type: "knowledge", file: "coding_rules" };

const makeEntry = (title: string, override?: Partial<MemoryEntry>): MemoryEntry => ({
  title,
  context: "integration-test",
  description: `Description for ${title}.`,
  date: "2026-03-11T00:00:00Z",
  ...override,
});

// ---------------------------------------------------------------------------
// Task 6.1: End-to-end memory operations with a real temp directory
// ---------------------------------------------------------------------------

describe("Memory lifecycle - Task 6.1: End-to-end operations", () => {
  let tmpDir: string;
  let store: FileMemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-mem-lifecycle-"));
    store = new FileMemoryStore({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // append → query → retrieve cycle
  // -------------------------------------------------------------------------

  it("append → query cycle returns the appended entry with non-zero relevance score", async () => {
    const entry = makeEntry("TDD Pattern", {
      description: "Always write the failing test before implementation code.",
    });

    const appendResult = await store.append(projectTarget, entry, "implementation_pattern");
    expect(appendResult.ok).toBe(true);

    const queryResult = await store.query({ text: "TDD", memoryTypes: ["project"] });
    expect(queryResult.entries.length).toBeGreaterThanOrEqual(1);

    const found = queryResult.entries.find(e => e.entry.title === "TDD Pattern");
    expect(found).toBeDefined();
    expect(found?.relevanceScore).toBeGreaterThan(0);
    expect(found?.sourceFile).toBe("project_rules");
  });

  it("query returns correct entry fields after append", async () => {
    const entry = makeEntry("Clean Code Rule", {
      context: "code-quality",
      description: "Keep functions small and focused on a single responsibility.",
    });

    await store.append(projectTarget, entry, "implementation_pattern");

    const queryResult = await store.query({ text: "Clean Code Rule", memoryTypes: ["project"] });
    const found = queryResult.entries.find(e => e.entry.title === "Clean Code Rule");
    expect(found).toBeDefined();
    expect(found?.entry.context).toBe("code-quality");
    expect(found?.entry.description).toBe("Keep functions small and focused on a single responsibility.");
    expect(found?.entry.date).toBe("2026-03-11T00:00:00Z");
  });

  // -------------------------------------------------------------------------
  // Simulate restart: new store instance on same dir, entries still retrievable
  // -------------------------------------------------------------------------

  it("entries persisted by first store instance are retrievable by a second instance on same dir", async () => {
    await store.append(projectTarget, makeEntry("Persisted Entry"), "implementation_pattern");

    const store2 = new FileMemoryStore({ baseDir: tmpDir });
    const result = await store2.query({ text: "Persisted", memoryTypes: ["project"] });
    const found = result.entries.find(e => e.entry.title === "Persisted Entry");
    expect(found).toBeDefined();
  });

  it("failure records persisted by first store instance are retrievable by a second instance", async () => {
    const record = {
      taskId: "task-persist",
      specName: "memory-system",
      phase: "IMPLEMENTATION" as const,
      attempted: "Write to file",
      errors: ["EACCES: permission denied"],
      rootCause: "Missing write permissions",
      timestamp: new Date().toISOString(),
    };

    await store.writeFailure(record);

    const store2 = new FileMemoryStore({ baseDir: tmpDir });
    const records = await store2.getFailures();
    const found = records.find(r => r.taskId === "task-persist");
    expect(found).toBeDefined();
    expect(found?.specName).toBe("memory-system");
  });

  // -------------------------------------------------------------------------
  // update → query cycle: updated content returned, no duplicate
  // -------------------------------------------------------------------------

  it("update → query returns updated content and no duplicate entry", async () => {
    await store.append(
      knowledgeTarget,
      makeEntry("Coding Style", {
        description: "Use 2-space indentation.",
      }),
      "self_healing",
    );

    const updateResult = await store.update(
      knowledgeTarget,
      "Coding Style",
      makeEntry("Coding Style", {
        description: "Use 4-space indentation per team convention.",
      }),
    );
    expect(updateResult.ok).toBe(true);

    const queryResult = await store.query({ text: "indentation", memoryTypes: ["knowledge"] });
    const matches = queryResult.entries.filter(e => e.entry.title === "Coding Style");

    // No duplicate — exactly one entry with the updated description
    expect(matches).toHaveLength(1);
    expect(matches[0]?.entry.description).toBe("Use 4-space indentation per team convention.");
  });

  it("query returns updated content after update; old unique token no longer matches", async () => {
    await store.append(
      knowledgeTarget,
      makeEntry("Rule X", {
        description: "xuniqoldword before update.",
      }),
      "self_healing",
    );

    await store.update(
      knowledgeTarget,
      "Rule X",
      makeEntry("Rule X", {
        description: "xuniqnewword after update.",
      }),
    );

    // Old unique token should no longer appear in results
    const resultOld = await store.query({ text: "xuniqoldword", memoryTypes: ["knowledge"] });
    expect(resultOld.entries.find(e => e.entry.title === "Rule X")).toBeUndefined();

    // New unique token should be found
    const resultNew = await store.query({ text: "xuniqnewword", memoryTypes: ["knowledge"] });
    expect(resultNew.entries.find(e => e.entry.title === "Rule X")).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // writeFailure → getFailures with specName filter
  // -------------------------------------------------------------------------

  it("getFailures after writeFailure returns the written record with correct fields", async () => {
    const record = {
      taskId: "impl-3-2",
      specName: "memory-system",
      phase: "IMPLEMENTATION" as const,
      attempted: "Write atomic temp file",
      errors: ["ENOENT: no such file or directory"],
      rootCause: "Parent directory not created before write",
      timestamp: new Date().toISOString(),
    };

    const writeResult = await store.writeFailure(record);
    expect(writeResult.ok).toBe(true);

    const records = await store.getFailures();
    const found = records.find(r => r.taskId === "impl-3-2");
    expect(found).toBeDefined();
    expect(found?.specName).toBe("memory-system");
    expect(found?.phase).toBe("IMPLEMENTATION");
    expect(found?.rootCause).toBe("Parent directory not created before write");
  });

  it("getFailures with specName filter returns only matching records", async () => {
    await store.writeFailure({
      taskId: "task-a",
      specName: "spec-alpha",
      phase: "IMPLEMENTATION",
      attempted: "Op A",
      errors: [],
      rootCause: "root A",
      timestamp: new Date().toISOString(),
    });
    await new Promise(r => setTimeout(r, 5));
    await store.writeFailure({
      taskId: "task-b",
      specName: "spec-beta",
      phase: "IMPLEMENTATION",
      attempted: "Op B",
      errors: [],
      rootCause: "root B",
      timestamp: new Date().toISOString(),
    });

    const filtered = await store.getFailures({ specName: "spec-alpha" });
    expect(filtered.every(r => r.specName === "spec-alpha")).toBe(true);
    expect(filtered.find(r => r.specName === "spec-beta")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Multiple entries across different target files
  // -------------------------------------------------------------------------

  it("appending to different target files keeps them separate", async () => {
    await store.append(projectTarget, makeEntry("Project Rule A"), "implementation_pattern");
    await store.append(knowledgeTarget, makeEntry("Knowledge Rule B"), "self_healing");

    const projectResult = await store.query({ text: "Project Rule", memoryTypes: ["project"] });
    const knowledgeResult = await store.query({ text: "Knowledge Rule", memoryTypes: ["knowledge"] });

    expect(projectResult.entries.find(e => e.entry.title === "Project Rule A")).toBeDefined();
    expect(knowledgeResult.entries.find(e => e.entry.title === "Knowledge Rule B")).toBeDefined();

    // Cross-contamination check
    expect(projectResult.entries.find(e => e.entry.title === "Knowledge Rule B")).toBeUndefined();
    expect(knowledgeResult.entries.find(e => e.entry.title === "Project Rule A")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task 6.2: Integration test for RunSpecUseCase with MemoryPort injected
// ---------------------------------------------------------------------------

describe("Memory lifecycle - Task 6.2: RunSpecUseCase with real FileMemoryStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-run-spec-mem-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Internal helpers (close over tmpDir set by beforeEach)
  // -------------------------------------------------------------------------

  /** Run a dry-run use case against the current tmpDir. */
  async function runDryRun(): Promise<void> {
    const specParent = join(tmpDir, "..");
    const specName = tmpDir.split("/").at(-1) ?? "test-spec";
    const memoryStore = new FileMemoryStore({ baseDir: tmpDir });
    const useCase = new RunSpecUseCase({
      stateStore: makeStateStore(),
      eventBus: makeEventBus(),
      sdd: makeSdd(),
      createLlmProvider: () => makeLlm(),
      memory: memoryStore,
    });
    await useCase.run(specName, { ...baseConfig, specDir: specParent }, {
      resume: false,
      dryRun: true,
    });
  }

  /**
   * Wrap shortTerm.clear() with a counter spy that still delegates to the
   * original implementation. Returns a getter for the call count.
   */
  function createShortTermSpy(store: FileMemoryStore): { getClearCallCount: () => number } {
    let clearCallCount = 0;
    const orig = store.shortTerm;
    const spied: ShortTermMemoryPort = {
      read: () => orig.read(),
      write: (partial) => orig.write(partial),
      clear: () => {
        clearCallCount++;
        orig.clear();
      },
    };
    (store as unknown as { shortTerm: ShortTermMemoryPort }).shortTerm = spied;
    return { getClearCallCount: () => clearCallCount };
  }

  // -------------------------------------------------------------------------
  // dry-run: no files written to the temp directory
  // -------------------------------------------------------------------------

  it("dry-run does not create any memory files in the temp directory", async () => {
    await runDryRun();
    await expect(access(join(tmpDir, ".memory"))).rejects.toThrow();
  });

  it("dry-run does not create any rules files in the temp directory", async () => {
    await runDryRun();
    await expect(access(join(tmpDir, "rules"))).rejects.toThrow();
  });

  it("dry-run leaves the temp directory empty (no subdirectories created)", async () => {
    await runDryRun();
    const entries = await readdir(tmpDir);
    expect(entries).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // short-term memory cleared between runs
  // -------------------------------------------------------------------------

  it("stale short-term state is cleared at the start of each non-dry-run", async () => {
    const memoryStore = new FileMemoryStore({ baseDir: tmpDir });
    const { getClearCallCount } = createShortTermSpy(memoryStore);

    // Simulate stale state left by a previous run
    memoryStore.shortTerm.write({ currentSpec: "stale-spec" });
    expect(memoryStore.shortTerm.read().currentSpec).toBe("stale-spec");

    const useCase = new RunSpecUseCase({
      stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
      eventBus: makeEventBus(),
      sdd: makeSdd(),
      createLlmProvider: () => makeLlm(),
      memory: memoryStore,
    });

    await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, {
      resume: false,
      dryRun: false,
    });

    // clear() was called once and the stale state is gone
    expect(getClearCallCount()).toBe(1);
    expect(memoryStore.shortTerm.read().currentSpec).toBeUndefined();
  });

  it("subsequent non-dry runs each call shortTerm.clear() once per run", async () => {
    const memoryStore = new FileMemoryStore({ baseDir: tmpDir });
    const { getClearCallCount } = createShortTermSpy(memoryStore);

    const useCase = new RunSpecUseCase({
      stateStore: makeStateStore({ persist: mock(() => Promise.resolve()) }),
      eventBus: makeEventBus(),
      sdd: makeSdd(),
      createLlmProvider: () => makeLlm(),
      memory: memoryStore,
    });

    await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { resume: false, dryRun: false });
    await useCase.run("test-spec", { ...baseConfig, specDir: tmpDir }, { resume: false, dryRun: false });

    expect(getClearCallCount()).toBe(2);
  });

  it("dry-run does NOT call shortTerm.clear()", async () => {
    const specParent = join(tmpDir, "..");
    const specName = tmpDir.split("/").at(-1) ?? "test-spec";

    const memoryStore = new FileMemoryStore({ baseDir: tmpDir });
    const { getClearCallCount } = createShortTermSpy(memoryStore);

    const useCase = new RunSpecUseCase({
      stateStore: makeStateStore(),
      eventBus: makeEventBus(),
      sdd: makeSdd(),
      createLlmProvider: () => makeLlm(),
      memory: memoryStore,
    });

    await useCase.run(specName, { ...baseConfig, specDir: specParent }, { resume: false, dryRun: true });

    expect(getClearCallCount()).toBe(0);
  });
});
