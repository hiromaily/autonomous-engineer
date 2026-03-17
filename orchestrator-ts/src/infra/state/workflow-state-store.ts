import type { IWorkflowStateStore } from "@/application/ports/workflow";
import type { WorkflowState } from "@/domain/workflow/types";
import { isNodeError } from "@/infra/utils/errors";
import { atomicWrite } from "@/infra/utils/fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
    const content = JSON.stringify(state, null, 2);
    await atomicWrite(destPath, content);
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
