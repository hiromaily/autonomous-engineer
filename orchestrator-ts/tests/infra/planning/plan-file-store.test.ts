import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskPlan } from "../../../src/domain/planning/types";
import { PlanFileStore } from "../../../src/infra/planning/plan-file-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: "plan-abc-123",
    goal: "Implement feature X",
    tasks: [
      {
        id: "task-1",
        title: "Task One",
        status: "pending",
        steps: [
          {
            id: "step-1",
            description: "Do the first thing",
            status: "pending",
            dependsOn: [],
            statusHistory: [],
          },
        ],
      },
    ],
    createdAt: "2026-03-13T10:00:00.000Z",
    updatedAt: "2026-03-13T10:00:00.000Z",
    ...overrides,
  };
}

function makeCompletedPlan(): TaskPlan {
  return makePlan({
    id: "plan-completed",
    tasks: [
      {
        id: "task-1",
        title: "Done Task",
        status: "completed",
        steps: [
          {
            id: "step-1",
            description: "Already done",
            status: "completed",
            dependsOn: [],
            statusHistory: [{ status: "completed", at: "2026-03-13T11:00:00.000Z" }],
          },
        ],
      },
    ],
  });
}

function makeFailedPlan(): TaskPlan {
  return makePlan({
    id: "plan-failed",
    tasks: [
      {
        id: "task-1",
        title: "Failed Task",
        status: "failed",
        steps: [
          {
            id: "step-1",
            description: "Failed step",
            status: "failed",
            dependsOn: [],
            statusHistory: [{ status: "failed", at: "2026-03-13T11:00:00.000Z" }],
          },
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Task 4.1 — PlanFileStore
// ---------------------------------------------------------------------------

describe("PlanFileStore", () => {
  let tmpDir: string;
  let store: PlanFileStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aes-plan-store-test-"));
    store = new PlanFileStore({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Constructor / resolvePlanPath
  // -------------------------------------------------------------------------

  it("can be constructed with a custom baseDir", () => {
    expect(store).toBeInstanceOf(PlanFileStore);
  });

  it("can be constructed without options (defaults to process.cwd())", () => {
    const defaultStore = new PlanFileStore();
    expect(defaultStore).toBeInstanceOf(PlanFileStore);
  });

  it("resolvePlanPath returns the expected path", () => {
    const path = store.resolvePlanPath("plan-abc-123");
    expect(path).toBe(join(tmpDir, ".memory", "tasks", "task_plan-abc-123.json"));
  });

  // -------------------------------------------------------------------------
  // save() / load() round-trip (Req 8.1, 8.2)
  // -------------------------------------------------------------------------

  it("saves and loads a plan with full round-trip fidelity (Req 8.1, 8.2)", async () => {
    const plan = makePlan();
    await store.save(plan);
    const loaded = await store.load(plan.id);
    expect(loaded).toEqual(plan);
  });

  it("creates the parent directory on first write (Req 8.1)", async () => {
    const plan = makePlan();
    await store.save(plan);
    // If directory doesn't exist, stat() throws — test fails naturally
    const { stat } = await import("node:fs/promises");
    const stats = await stat(join(tmpDir, ".memory", "tasks"));
    expect(stats.isDirectory()).toBe(true);
  });

  it("overwrites an existing plan file on subsequent saves (Req 8.1)", async () => {
    const plan = makePlan();
    await store.save(plan);

    const updated: TaskPlan = {
      ...plan,
      updatedAt: "2026-03-13T12:00:00.000Z",
      tasks: [
        {
          id: "task-1",
          title: "Task One",
          status: "in_progress",
          steps: [
            {
              id: "step-1",
              description: "Do the first thing",
              status: "in_progress",
              dependsOn: [],
              statusHistory: [{ status: "in_progress", at: "2026-03-13T11:00:00.000Z" }],
            },
          ],
        },
      ],
    };
    await store.save(updated);

    const loaded = await store.load(plan.id);
    expect(loaded?.tasks[0]?.status).toBe("in_progress");
    expect(loaded?.updatedAt).toBe("2026-03-13T12:00:00.000Z");
  });

  // -------------------------------------------------------------------------
  // load() — not found returns null (Req 8.2)
  // -------------------------------------------------------------------------

  it("returns null when the plan file does not exist (Req 8.2)", async () => {
    const result = await store.load("non-existent-plan");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // load() — validation on load (Req 8.4)
  // -------------------------------------------------------------------------

  it("throws a structured PlanStoreError when loading a plan with circular dependencies (Req 8.4)", async () => {
    // Write an invalid plan directly (bypassing save) — two steps with circular deps
    const dir = join(tmpDir, ".memory", "tasks");
    await mkdir(dir, { recursive: true });
    const invalidPlan: TaskPlan = {
      id: "plan-corrupt",
      goal: "Corrupt plan",
      tasks: [
        {
          id: "task-1",
          title: "Task",
          status: "pending",
          steps: [
            {
              id: "step-a",
              description: "Step A",
              status: "pending",
              dependsOn: ["step-b"],
              statusHistory: [],
            },
            {
              id: "step-b",
              description: "Step B",
              status: "pending",
              dependsOn: ["step-a"],
              statusHistory: [],
            },
          ],
        },
      ],
      createdAt: "2026-03-13T10:00:00.000Z",
      updatedAt: "2026-03-13T10:00:00.000Z",
    };
    const filePath = join(dir, "task_plan-corrupt.json");
    await writeFile(filePath, JSON.stringify(invalidPlan, null, 2), "utf-8");

    await expect(store.load("plan-corrupt")).rejects.toMatchObject({
      code: "invalid-plan",
    });
  });

  it("throws a PlanStoreError when loading a file with duplicate step IDs (Req 8.4)", async () => {
    const dir = join(tmpDir, ".memory", "tasks");
    await mkdir(dir, { recursive: true });
    const invalidPlan: TaskPlan = {
      id: "plan-dup",
      goal: "Duplicate steps plan",
      tasks: [
        {
          id: "task-1",
          title: "Task",
          status: "pending",
          steps: [
            {
              id: "step-a",
              description: "Step A",
              status: "pending",
              dependsOn: [],
              statusHistory: [],
            },
            {
              id: "step-a",
              description: "Step A duplicate",
              status: "pending",
              dependsOn: [],
              statusHistory: [],
            },
          ],
        },
      ],
      createdAt: "2026-03-13T10:00:00.000Z",
      updatedAt: "2026-03-13T10:00:00.000Z",
    };
    const filePath = join(dir, "task_plan-dup.json");
    await writeFile(filePath, JSON.stringify(invalidPlan, null, 2), "utf-8");

    await expect(store.load("plan-dup")).rejects.toMatchObject({
      code: "invalid-plan",
    });
  });

  it("throws when loading a file that contains invalid JSON", async () => {
    const dir = join(tmpDir, ".memory", "tasks");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "task_plan-bad-json.json");
    await writeFile(filePath, "{ not valid json", "utf-8");

    await expect(store.load("plan-bad-json")).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // listResumable() — (Req 8.3, 8.5)
  // -------------------------------------------------------------------------

  it("returns empty array when no plans are saved (Req 8.3)", async () => {
    const result = await store.listResumable();
    expect(result).toEqual([]);
  });

  it("returns IDs of plans with at least one non-terminal task (Req 8.3)", async () => {
    const pendingPlan = makePlan();
    await store.save(pendingPlan);

    const ids = await store.listResumable();
    expect(ids).toContain(pendingPlan.id);
  });

  it("excludes fully completed plans from listResumable (Req 8.5)", async () => {
    const completedPlan = makeCompletedPlan();
    await store.save(completedPlan);

    const ids = await store.listResumable();
    expect(ids).not.toContain(completedPlan.id);
  });

  it("excludes fully failed plans from listResumable (Req 8.5)", async () => {
    const failedPlan = makeFailedPlan();
    await store.save(failedPlan);

    const ids = await store.listResumable();
    expect(ids).not.toContain(failedPlan.id);
  });

  it("returns only resumable plans when mixed completed and pending exist (Req 8.3, 8.5)", async () => {
    const pendingPlan = makePlan({ id: "plan-pending" });
    const completedPlan = makeCompletedPlan();
    const failedPlan = makeFailedPlan();

    await store.save(pendingPlan);
    await store.save(completedPlan);
    await store.save(failedPlan);

    const ids = await store.listResumable();
    expect(ids).toContain("plan-pending");
    expect(ids).not.toContain("plan-completed");
    expect(ids).not.toContain("plan-failed");
  });

  it("returns empty array after all plans are completed", async () => {
    const plan = makePlan();
    await store.save(plan);

    const completedVersion: TaskPlan = {
      ...plan,
      tasks: [
        {
          id: "task-1",
          title: "Task One",
          status: "completed",
          steps: [
            {
              id: "step-1",
              description: "Do the first thing",
              status: "completed",
              dependsOn: [],
              statusHistory: [{ status: "completed", at: "2026-03-13T12:00:00.000Z" }],
            },
          ],
        },
      ],
    };
    await store.save(completedVersion);

    const ids = await store.listResumable();
    expect(ids).not.toContain(plan.id);
  });

  // -------------------------------------------------------------------------
  // save() — write error halts execution (Req 8.1, from task 4.2)
  // -------------------------------------------------------------------------

  it("save() throws when the destination directory is not writable (Req 8.1)", async () => {
    // Create the tasks dir as a regular file so mkdir/write inside it will fail
    const memDir = join(tmpDir, ".memory");
    await mkdir(memDir, { recursive: true });
    // Place a file at where the tasks dir would be to make directory creation fail
    const tasksPath = join(memDir, "tasks");
    await writeFile(tasksPath, "not a directory", "utf-8");

    const blockedStore = new PlanFileStore({ baseDir: tmpDir });
    const plan = makePlan({ id: "plan-write-fail" });

    await expect(blockedStore.save(plan)).rejects.toThrow();
  });

  it("skips unparseable JSON files in listResumable without throwing", async () => {
    const dir = join(tmpDir, ".memory", "tasks");
    await mkdir(dir, { recursive: true });
    // Write a bad JSON file
    await writeFile(join(dir, "task_bad.json"), "bad json", "utf-8");
    // Write a valid plan
    const plan = makePlan();
    await store.save(plan);

    const ids = await store.listResumable();
    expect(ids).toContain(plan.id);
    // Bad file is skipped, no error thrown
  });
});
