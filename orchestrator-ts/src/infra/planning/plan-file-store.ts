import type { ITaskPlanStore } from "@/application/ports/task-planning";
import { PlanValidator } from "@/domain/planning/plan-validator";
import type { TaskPlan, TaskStatus } from "@/domain/planning/types";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// PlanStoreError — structured error thrown on invalid plan load
// ---------------------------------------------------------------------------

export class PlanStoreError extends Error {
  readonly code: "invalid-plan";
  readonly planId: string;
  readonly validationErrors?: ReadonlyArray<string>;

  constructor(
    code: "invalid-plan",
    planId: string,
    message: string,
    validationErrors?: ReadonlyArray<string>,
  ) {
    super(message);
    this.name = "PlanStoreError";
    this.code = code;
    this.planId = planId;
    if (validationErrors !== undefined) {
      this.validationErrors = validationErrors;
    }
  }
}

// ---------------------------------------------------------------------------
// PlanFileStore options
// ---------------------------------------------------------------------------

export interface PlanFileStoreOptions {
  readonly baseDir?: string;
}

// ---------------------------------------------------------------------------
// Terminal task status set
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed"]);

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

// ---------------------------------------------------------------------------
// PlanFileStore — implements ITaskPlanStore with atomic JSON persistence
// ---------------------------------------------------------------------------

/**
 * File-based implementation of ITaskPlanStore.
 *
 * Plans are persisted at `{baseDir}/.memory/tasks/task_{id}.json`.
 *
 * All writes use the atomic temp-file + datasync + rename pattern,
 * identical to FileMemoryStore.atomicWrite. PlanValidator is run on
 * every load to detect corrupted or manually edited plans.
 */
export class PlanFileStore implements ITaskPlanStore {
  private readonly baseDir: string;
  private readonly validator: PlanValidator;

  constructor(options?: PlanFileStoreOptions) {
    this.baseDir = options?.baseDir ?? process.cwd();
    this.validator = new PlanValidator();
  }

  // -------------------------------------------------------------------------
  // Path resolution
  // -------------------------------------------------------------------------

  private resolveTasksDir(): string {
    return join(this.baseDir, ".memory", "tasks");
  }

  /** Resolves the full file path for a given planId. Exposed for testing. */
  resolvePlanPath(planId: string): string {
    return join(this.resolveTasksDir(), `task_${planId}.json`);
  }

  // -------------------------------------------------------------------------
  // Atomic write helper (mirrors FileMemoryStore.atomicWrite)
  // -------------------------------------------------------------------------

  private async atomicWrite(destPath: string, content: string): Promise<void> {
    await mkdir(dirname(destPath), { recursive: true });

    const tmpPath = `${destPath}.tmp`;
    const fd = await open(tmpPath, "w");
    try {
      await fd.write(content);
      await fd.datasync();
    } finally {
      await fd.close();
    }
    await rename(tmpPath, destPath);
  }

  // -------------------------------------------------------------------------
  // save() — atomic JSON write (Req 8.1)
  // -------------------------------------------------------------------------

  async save(plan: TaskPlan): Promise<void> {
    const destPath = this.resolvePlanPath(plan.id);
    const content = JSON.stringify(plan, null, 2);
    await this.atomicWrite(destPath, content);
  }

  // -------------------------------------------------------------------------
  // load() — read + validate (Req 8.2, 8.4)
  // -------------------------------------------------------------------------

  async load(planId: string): Promise<TaskPlan | null> {
    const filePath = this.resolvePlanPath(planId);

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      throw err;
    }

    // Parse JSON — let parse errors propagate as-is
    const plan = JSON.parse(raw) as TaskPlan;

    // Validate on every load to catch corruption or external edits
    const result = this.validator.validate(plan);
    if (!result.valid) {
      throw new PlanStoreError(
        "invalid-plan",
        planId,
        `Plan "${planId}" failed validation: ${result.errors.map(e => e.message).join("; ")}`,
        result.errors.map(e => e.message),
      );
    }

    return plan;
  }

  // -------------------------------------------------------------------------
  // listResumable() — scan directory for non-terminal plans (Req 8.3, 8.5)
  // -------------------------------------------------------------------------

  async listResumable(): Promise<ReadonlyArray<string>> {
    const tasksDir = this.resolveTasksDir();

    let filenames: string[];
    try {
      filenames = await readdir(tasksDir);
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") return [];
      throw err;
    }

    const resumableIds: string[] = [];

    for (const filename of filenames) {
      if (!filename.endsWith(".json")) continue;

      try {
        const raw = await readFile(join(tasksDir, filename), "utf-8");
        const plan = JSON.parse(raw) as TaskPlan;

        // A plan is resumable if at least one task is not in a terminal status
        const hasIncompleteTask = plan.tasks.some(task => !TERMINAL_STATUSES.has(task.status));
        if (hasIncompleteTask) {
          resumableIds.push(plan.id);
        }
      } catch {
        // Skip unparseable or unreadable files silently
      }
    }

    return resumableIds;
  }
}
