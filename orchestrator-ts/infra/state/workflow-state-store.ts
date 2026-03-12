import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { IWorkflowStateStore } from "../../application/ports/workflow";
import type { WorkflowState } from "../../domain/workflow/types";

export class WorkflowStateStore implements IWorkflowStateStore {
  constructor(private readonly cwd: string = process.cwd()) {}

  init(specName: string): WorkflowState {
    const now = new Date().toISOString();
    return {
      specName,
      currentPhase: "SPEC_INIT",
      completedPhases: [],
      status: "running",
      startedAt: now,
      updatedAt: now,
    };
  }

  async persist(state: WorkflowState): Promise<void> {
    const destPath = this.statePath(state.specName);
    const tmpPath = `${destPath}.tmp`;

    await mkdir(join(this.cwd, ".aes", "state"), { recursive: true });

    const content = JSON.stringify(state, null, 2);
    const fd = await open(tmpPath, "w");
    try {
      await fd.write(content);
      await fd.datasync();
    } finally {
      await fd.close();
    }

    await rename(tmpPath, destPath);
  }

  async restore(specName: string): Promise<WorkflowState | null> {
    try {
      const raw = await readFile(this.statePath(specName), "utf-8");
      return JSON.parse(raw) as WorkflowState;
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      throw err;
    }
  }

  private statePath(specName: string): string {
    return join(this.cwd, ".aes", "state", `${specName}.json`);
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
